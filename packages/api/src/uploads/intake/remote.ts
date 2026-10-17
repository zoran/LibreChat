/** Request-local adapters around the existing raw lifecycle; no application credentials or storage. */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  UPLOAD_ERROR_CODES,
  UPLOAD_MAX_FILE_BYTES,
  isUploadPrincipal,
  isUploadOriginalIntegrity,
  matchesUploadSecurityApproval,
  readUploadAcceptedMetadata,
  readUploadPromotionInput,
  readUploadPromotionRecord,
} from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadOperation,
  UploadLease,
  UploadByteLease,
  UploadPromotionRecord,
} from 'librechat-data-provider';
import type { Request, RequestHandler } from 'express';
import type { RawUploadBodyDependencies } from '../transport/body';
import type { IntakeChannel } from './channel';
import { createRawUploadBodyHandler } from '../transport/body';
import { UploadManagementError } from '../errors';

export type RemoteIntakeBodyOptions = Omit<
  RawUploadBodyDependencies,
  'management' | 'principal' | 'storage' | 'claimBytes' | 'completeBytes'
> & { channel: IntakeChannel };
export type RemoteIntakeBodyHandler = RequestHandler & {
  principal(request: Request): Promise<UploadPrincipal>;
};
const IDENTIFIER = /^[a-zA-Z0-9-]{1,128}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
function fail(
  code:
    | 'invalid_request'
    | 'unauthorized'
    | 'unavailable'
    | 'lease_lost'
    | 'storage_uncertain'
    | 'security_uninspectable' = 'unavailable',
): never {
  throw new UploadManagementError(code);
}
function data(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail();
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !keys.includes(key)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail();
    result[key] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
function iso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 24 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function operation(value: unknown, id: string): UploadOperation {
  const row = data(value, [
    'version',
    'id',
    'revision',
    'scope',
    'filename',
    'mediaType',
    'declaredBytes',
    'actualBytes',
    'state',
    'createdAt',
    'acceptedAt',
    'expiresAt',
    'fileId',
    'error',
    'cleanupPending',
    'canUseInComposer',
    'canRetryProcessing',
  ]);
  const scope = data(row.scope, ['kind']);
  const states: readonly UploadOperation['state'][] = [
    'waiting',
    'transferring',
    'queued_processing',
    'processing',
    'ready',
    'failed',
    'cancelled',
    'deleted',
    'expired',
  ];
  const state = states.find((state) => state === row.state);
  if (
    row.version !== 1 ||
    row.id !== id ||
    !integer(row.revision) ||
    scope.kind !== 'personal' ||
    typeof row.mediaType !== 'string' ||
    row.mediaType.length > 127 ||
    !integer(row.declaredBytes, 1, UPLOAD_MAX_FILE_BYTES) ||
    !state ||
    !iso(row.createdAt) ||
    typeof row.cleanupPending !== 'boolean' ||
    typeof row.canUseInComposer !== 'boolean' ||
    typeof row.canRetryProcessing !== 'boolean'
  )
    fail();
  const result: UploadOperation = {
    version: 1,
    id,
    revision: row.revision,
    scope: { kind: 'personal' },
    mediaType: row.mediaType,
    declaredBytes: row.declaredBytes,
    state,
    createdAt: row.createdAt,
    cleanupPending: row.cleanupPending,
    canUseInComposer: row.canUseInComposer,
    canRetryProcessing: row.canRetryProcessing,
  };
  for (const key of ['acceptedAt', 'expiresAt'] as const) {
    if (row[key] !== undefined) {
      if (!iso(row[key])) fail();
      result[key] = row[key];
    }
  }
  if (row.filename !== undefined) {
    const metadata = readUploadAcceptedMetadata({ filename: row.filename });
    if (!metadata || !result.acceptedAt) fail();
    result.filename = metadata.filename;
  }
  if (row.actualBytes !== undefined) {
    if (!integer(row.actualBytes, 1, UPLOAD_MAX_FILE_BYTES)) fail();
    result.actualBytes = row.actualBytes;
  }
  if (row.fileId !== undefined) {
    if (typeof row.fileId !== 'string' || row.fileId.length > 128) fail();
    result.fileId = row.fileId;
  }
  if (row.error !== undefined) {
    const code = UPLOAD_ERROR_CODES.find((code) => code === row.error);
    if (!code) fail();
    result.error = code;
  }
  return result;
}
function header(request: Request, name: string): string | undefined {
  if (
    (request.rawHeaders?.filter((key, index) => index % 2 === 0 && key.toLowerCase() === name)
      .length ?? 0) > 1
  )
    fail('invalid_request');
  const value = request.headers[name];
  if (Array.isArray(value)) fail('invalid_request');
  return value;
}
const sameLease = (left: UploadLease, right: UploadLease) =>
  ['tenantId', 'userId', 'operationId', 'generation', 'kind', 'hostId', 'instanceId'].every(
    (key) => left[key as keyof UploadLease] === right[key as keyof UploadLease],
  );

export function createRemoteIntakeBodyHandler(
  options: RemoteIntakeBodyOptions,
): RemoteIntakeBodyHandler {
  const worker = Object.freeze({ ...options.worker });
  const contexts = new WeakMap<Request, ReturnType<typeof createContext>>();
  function createContext(request: Request) {
    if (
      request.aborted ||
      request.destroyed ||
      request.res?.destroyed ||
      request.res?.writableEnded
    )
      fail('unavailable');
    const operationId = request.params.id;
    const capability = header(request, 'x-upload-capability');
    if (header(request, 'authorization') !== undefined || header(request, 'cookie') !== undefined)
      fail('invalid_request');
    if (
      typeof operationId !== 'string' ||
      operationId.length > 128 ||
      !IDENTIFIER.test(operationId) ||
      typeof capability !== 'string' ||
      capability.length !== 43 ||
      !CAPABILITY.test(capability)
    )
      fail('unauthorized');
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      clearTimeout(timer);
      contexts.delete(request);
      request.off('aborted', abort);
      request.res?.off('close', abort);
    };
    const timer = setTimeout(abort, options.deadlineMs ?? 120_000);
    timer.unref();
    request.once('aborted', abort);
    request.res?.once('close', abort);
    let admitted: UploadPrincipal | undefined;
    let bound: UploadLease | undefined;
    let prepared: UploadPromotionRecord | undefined;
    const call = (command: unknown, cleanup = false, signal?: AbortSignal) =>
      options.channel.control({
        operationId,
        capability,
        command,
        signal: signal ?? (cleanup ? AbortSignal.timeout(5000) : controller.signal),
      });
    const readLease = (value: unknown): UploadLease => {
      const row = data(value, [
        'tenantId',
        'userId',
        'operationId',
        'generation',
        'kind',
        'hostId',
        'instanceId',
        'expiresAt',
      ]);
      if (
        !admitted ||
        row.tenantId !== admitted.tenantId ||
        row.userId !== admitted.userId ||
        row.operationId !== operationId ||
        row.kind !== 'transfer' ||
        row.hostId !== worker.hostId ||
        row.instanceId !== worker.instanceId ||
        !integer(row.generation) ||
        !iso(row.expiresAt)
      )
        fail('lease_lost');
      const result: UploadLease = {
        ...worker,
        tenantId: admitted.tenantId,
        userId: admitted.userId,
        operationId,
        generation: row.generation,
        kind: 'transfer',
        expiresAt: row.expiresAt,
      };
      if (bound && !sameLease(bound, result)) fail('lease_lost');
      return result;
    };
    const readPromotion = (value: unknown): UploadPromotionRecord => {
      const result = readUploadPromotionRecord(value);
      if (!result || !bound || !sameLease(result.lease, bound)) fail('storage_uncertain');
      if (
        prepared &&
        (result.promotionId !== prepared.promotionId ||
          !isDeepStrictEqual(result.worker, prepared.worker) ||
          !isDeepStrictEqual(result.approval, prepared.approval) ||
          !isDeepStrictEqual(result.integrity, prepared.integrity) ||
          !isDeepStrictEqual(result.metadata, prepared.metadata))
      )
        fail('storage_uncertain');
      return result;
    };
    return {
      async principal(): Promise<UploadPrincipal> {
        controller.signal.throwIfAborted();
        const result = data(await call({ action: 'authorize' }), [
          'authentication',
          'tenantId',
          'userId',
        ]);
        controller.signal.throwIfAborted();
        if (!isUploadPrincipal(result) || result.authentication !== 'verified-email')
          fail('unauthorized');
        if (admitted && !isDeepStrictEqual(result, admitted)) fail('unauthorized');
        admitted = Object.freeze({
          authentication: result.authentication,
          tenantId: result.tenantId,
          userId: result.userId,
        });
        return admitted;
      },
      management: {
        get: async () => operation(await call({ action: 'get' }), operationId),
        claimTransfer: async () => {
          const value = await call({ action: 'claim' });
          if (value === null) return null;
          bound = readLease(value);
          return bound;
        },
        renew: async (lease: UploadLease) =>
          readLease(await call({ action: 'renew', lease: readLease(lease) })),
        fail: async (lease, code) =>
          operation(
            await call({ action: 'fail', lease: readLease(lease), code }, true),
            operationId,
          ),
        cancel: async () => operation(await call({ action: 'cancel' }, true), operationId),
        bindSecurityExecution: async (lease, execution) => {
          await call({ action: 'bind-security', lease: readLease(lease), execution });
        },
        settleSecurityExecution: async (lease, settlement) => {
          await call({ action: 'settle-security', lease: readLease(lease), settlement });
        },
        confirmCleanup: async (proof) =>
          operation(await call({ action: 'confirm-cleanup', proof }, true), operationId),
        accept: async (_principal, _id, lease) => {
          if (!prepared) fail('storage_uncertain');
          const current = readPromotion(await call({ action: 'get-promotion' }));
          if (
            current.state !== 'settled' ||
            !current.writerStopped ||
            current.receipt?.outcome !== 'durable'
          )
            fail('storage_uncertain');
          return operation(
            await call({
              action: 'accept',
              lease: readLease(lease),
              promotionId: current.promotionId,
            }),
            operationId,
          );
        },
      } satisfies RawUploadBodyDependencies['management'],
      storage: {
        async put(input) {
          const lease = readLease(input.lease);
          const subject = {
            tenantId: lease.tenantId,
            userId: lease.userId,
            operationId,
            transferGeneration: lease.generation,
            mediaType: input.mediaType,
            bytes: input.bytes,
            sha256: input.integrity?.sha256,
          };
          if (
            !isUploadOriginalIntegrity(input.integrity, input.bytes) ||
            !matchesUploadSecurityApproval(
              input.securityApproval,
              subject,
              options.security.policySha256,
              (options.now ?? Date.now)(),
            )
          )
            fail('security_uninspectable');
          const metadata = readUploadAcceptedMetadata({ filename: input.filename });
          if (!metadata) fail('invalid_request');
          const promotionId = randomUUID();
          const proposed = {
            version: 1 as const,
            promotionId,
            lease,
            approval: input.securityApproval,
            integrity: input.integrity,
            metadata,
          };
          const record = readPromotion(
            await call({ action: 'prepare-promotion', input: proposed }, false, input.signal),
          );
          const expected = readUploadPromotionInput({ ...proposed, worker: record.worker });
          const actual = readUploadPromotionInput({
            version: record.version,
            promotionId: record.promotionId,
            lease: record.lease,
            worker: record.worker,
            approval: record.approval,
            integrity: record.integrity,
            metadata: record.metadata,
          });
          if (!expected || !isDeepStrictEqual(expected, actual) || record.state !== 'prepared')
            fail('storage_uncertain');
          prepared = record;
          input.signal.throwIfAborted();
          const promoted = readPromotion(
            await options.channel.promote({
              operationId,
              capability,
              promotionId,
              bytes: input.bytes,
              integrity: expected.integrity,
              body: input.body,
              signal: input.signal,
            }),
          );
          if (promoted.state !== 'settled' || !promoted.writerStopped || !promoted.receipt)
            fail('storage_uncertain');
          return promoted.receipt;
        },
      } satisfies RawUploadBodyDependencies['storage'],
      async claimBytes(
        lease: UploadLease,
        requestedBytes: number,
      ): Promise<UploadByteLease | null> {
        const value = await call({
          action: 'claim-bytes',
          lease: readLease(lease),
          requestedBytes,
        });
        if (value === null) return null;
        const row = data(value, ['bytes', 'generation', 'expiresAt']);
        if (
          !integer(row.bytes, 1, requestedBytes) ||
          !integer(row.generation) ||
          !iso(row.expiresAt)
        )
          fail('lease_lost');
        return { bytes: row.bytes, generation: row.generation, expiresAt: row.expiresAt };
      },
      async completeBytes(lease: UploadLease, generation: number): Promise<void> {
        await call({ action: 'complete-bytes', lease: readLease(lease), generation }, true);
      },
      close() {
        clearTimeout(timer);
        controller.abort();
        request.off('aborted', abort);
        request.res?.off('close', abort);
        contexts.delete(request);
      },
    };
  }
  const context = (request: Request) => {
    let value = contexts.get(request);
    if (!value) {
      value = createContext(request);
      contexts.set(request, value);
    }
    return value;
  };
  const principal = async (request: Request) => {
    const current = context(request);
    try {
      return await current.principal();
    } catch (error) {
      current.close();
      throw error;
    }
  };
  const handler: RequestHandler = async (request, response, next) => {
    const current = context(request);
    try {
      const body = createRawUploadBodyHandler({
        ...options,
        worker,
        principal: () => current.principal(),
        management: current.management,
        storage: current.storage,
        claimBytes: current.claimBytes,
        completeBytes: current.completeBytes,
      });
      await body(request, response, next);
    } finally {
      current.close();
    }
  };
  return Object.assign(handler, { principal });
}
