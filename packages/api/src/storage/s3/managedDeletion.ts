import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { finished } from 'node:stream/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  canonicalStorageDeletionReceipt,
  isStorageDeletionConsumptionResult,
  isStorageDeletionBinding,
  isStorageDeletionRequest,
  isStorageDeletionResult,
  STORAGE_DELETION_MAX_RESPONSE_BYTES,
} from 'librechat-data-provider';
import type {
  StorageDeletionConsumption,
  StorageDeletionConsumptionResult,
  StorageDeletionRequest,
  StorageDeletionBinding,
  StorageDeletionResult,
} from 'librechat-data-provider';
import type { GetObjectCommandOutput, S3Client } from '@aws-sdk/client-s3';

type DeletionOutput = GetObjectCommandOutput & {
  deletion: StorageDeletionResult | StorageDeletionConsumptionResult;
};
export type ManagedDeletionInput = {
  binding: StorageDeletionBinding;
  key: string;
  request: StorageDeletionRequest;
  signal: AbortSignal;
  /** Original caller deadline; retries and status calls must retain it. */
  deadlineAtMs: number;
};

/** Uses the SDK's existing S3 endpoint serialization, retry, auth and signing owners. */
class ManagedDeletionCommand extends GetObjectCommand {
  constructor(
    bucket: string,
    key: string,
    request: StorageDeletionRequest,
    begin: boolean,
    signal: AbortSignal,
    expected: StorageDeletionBinding,
    consumption?: StorageDeletionConsumption & { receiptSHA256: string },
  ) {
    super({ Bucket: bucket, Key: key });
    this.middlewareStack.add(
      (next) => async (args) => {
        const http = args.request as {
          protocol: string;
          hostname: string;
          method: string;
          query: Record<string, string>;
          headers: Record<string, string>;
          body?: string;
        };
        if (
          http.protocol !== 'https:' &&
          !(http.protocol === 'http:' && ['127.0.0.1', '::1', '[::1]'].includes(http.hostname))
        ) {
          throw new Error('Managed deletion requires authenticated transport');
        }
        http.method = begin || consumption ? 'POST' : 'GET';
        http.query = { 'cortex-delete': '1' };
        if (begin || consumption) {
          if (consumption) http.query.action = 'consume';
          http.body = JSON.stringify(
            consumption
              ? {
                  ...request,
                  terminalReceipt: consumption.receipt,
                  receiptSHA256: consumption.receiptSHA256,
                  consumerCommitId: consumption.consumerCommitId,
                }
              : request,
          );
          http.headers['content-type'] = 'application/json';
          http.headers['content-length'] = String(Buffer.byteLength(http.body));
        } else {
          for (const [key, value] of Object.entries(request)) http.query[key] = String(value);
        }
        signal.throwIfAborted();
        return next(args);
      },
      { step: 'build', name: 'managedDeletionRequest', priority: 'high' },
    );
    this.middlewareStack.add(
      (_next) => async (args) => {
        const { response } = await _next(args);
        const http = response as {
          statusCode: number;
          headers: Record<string, string>;
          body: unknown;
        };
        const body = http.body;
        if (!(body instanceof Readable))
          throw new Error('Managed deletion response is not a stream');
        const abort = () => body.destroy(new Error('Managed deletion response aborted'));
        signal.addEventListener('abort', abort, { once: true });
        const settled = finished(body, { cleanup: true }).catch(() => undefined);
        try {
          if (signal.aborted) abort();
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of body) {
            signal.throwIfAborted();
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > STORAGE_DELETION_MAX_RESPONSE_BYTES)
              throw new Error('Managed deletion response too large');
            chunks.push(buffer);
          }
          if (http.statusCode !== 200) {
            const error = new Error('Managed deletion transport rejected request');
            Object.assign(error, { $metadata: { httpStatusCode: http.statusCode } });
            throw error;
          }
          if (!/^application\/json(?:\s*;|$)/i.test(http.headers['content-type'] ?? ''))
            throw new Error('Invalid managed deletion content type');
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (
            consumption
              ? !isStorageDeletionConsumptionResult(value, {
                  obligationId: consumption.receipt.obligationId,
                  receiptSHA256: consumption.receiptSHA256,
                  consumerCommitId: consumption.consumerCommitId,
                })
              : !isStorageDeletionResult(value, expected, request.obligationId)
          )
            throw new Error('Managed deletion receipt binding mismatch');
          return {
            response,
            output: { $metadata: { httpStatusCode: 200 }, deletion: value } as DeletionOutput,
          };
        } finally {
          signal.removeEventListener('abort', abort);
          body.destroy();
          await settled;
        }
      },
      { step: 'deserialize', name: 'deserializerMiddleware', override: true },
    );
  }
}

export type ManagedDeletionAdapter = {
  describe(input: Pick<ManagedDeletionInput, 'key' | 'request'>): StorageDeletionBinding;
  acknowledgeDeletionConsumed(
    input: ManagedDeletionInput & StorageDeletionConsumption,
  ): Promise<StorageDeletionConsumptionResult>;
  begin(input: ManagedDeletionInput): Promise<StorageDeletionResult>;
  observe(input: ManagedDeletionInput): Promise<StorageDeletionResult>;
};

/** No DELETE/HEAD fallback: namespace absence does not settle physical deletion. */
export function createManagedDeletionAdapter(
  client: S3Client,
  bucket: string,
): ManagedDeletionAdapter {
  if (!bucket || bucket.length > 255) throw new Error('Invalid managed deletion bucket');
  function describe(input: Pick<ManagedDeletionInput, 'key' | 'request'>): StorageDeletionBinding {
    const request = { ...input.request };
    if (!isStorageDeletionRequest(request) || !input.key || Buffer.byteLength(input.key) > 4096)
      throw new Error('Invalid managed deletion binding');
    const { obligationId: _obligationId, ...binding } = request;
    return Object.freeze({ ...binding, bucket, key: input.key });
  }
  async function execute(
    input: ManagedDeletionInput,
    begin: boolean,
    consumption?: StorageDeletionConsumption & { receiptSHA256: string },
  ): Promise<StorageDeletionResult | StorageDeletionConsumptionResult> {
    const request = { ...input.request };
    if (
      !isStorageDeletionRequest(request) ||
      !input.key ||
      Buffer.byteLength(input.key) > 4096 ||
      !Number.isSafeInteger(input.deadlineAtMs)
    )
      throw new Error('Invalid managed deletion request');
    const { obligationId, ...binding } = request;
    const expected: StorageDeletionBinding = { ...binding, bucket, key: input.key };
    if (
      !isStorageDeletionBinding(input.binding) ||
      !Object.entries(expected).every(
        ([key, value]) => input.binding[key as keyof StorageDeletionBinding] === value,
      )
    )
      throw new Error('Persisted deletion binding mismatch');
    const unknown: StorageDeletionResult | StorageDeletionConsumptionResult = consumption
      ? { state: 'unknown' }
      : {
          ...expected,
          state: 'unknown',
          ...(obligationId ? { obligationId } : {}),
        };
    const remaining = Math.min(10000, input.deadlineAtMs - Date.now());
    if (input.signal.aborted || remaining <= 0) return unknown;
    const deadline = new AbortController();
    const signal = AbortSignal.any([input.signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(), remaining);
    timer.unref();
    try {
      const value = (await client.send(
        new ManagedDeletionCommand(
          bucket,
          input.key,
          request,
          begin,
          signal,
          expected,
          consumption,
        ),
        { abortSignal: signal },
      )) as DeletionOutput;
      if (signal.aborted) return unknown;
      return value.deletion;
    } catch {
      // Dispatch/response uncertainty retains the exact caller-persisted identity.
      return unknown;
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    describe,
    begin: (input) => execute(input, true) as Promise<StorageDeletionResult>,
    observe: (input) => execute(input, false) as Promise<StorageDeletionResult>,
    acknowledgeDeletionConsumed: (input) => {
      const expected = describe(input);
      if (
        !isStorageDeletionResult(input.receipt, expected, input.request.obligationId) ||
        input.receipt.state !== 'durable_delete_complete' ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.consumerCommitId)
      )
        throw new Error('Invalid deletion consumption');
      const receipt = JSON.parse(
        canonicalStorageDeletionReceipt(input.receipt),
      ) as StorageDeletionConsumption['receipt'];
      const receiptSHA256 = createHash('sha256')
        .update(canonicalStorageDeletionReceipt(receipt), 'utf8')
        .digest('hex');
      return execute(input, true, {
        receipt,
        receiptSHA256,
        consumerCommitId: input.consumerCommitId,
      }) as Promise<StorageDeletionConsumptionResult>;
    },
  };
}
