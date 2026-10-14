import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { mkdir, open, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { UploadWorker, UploadLease, UploadParserExecution } from 'librechat-data-provider';
import type {
  DocumentPort,
  StoragePort,
  UploadAttemptPort,
  UploadAttemptRegistration,
} from '../contract';
import type { UploadManagement } from '../management';
import { attemptOriginalPath, uploadAttemptId } from './paths';
import { isUploadManagementError } from '../errors';
import { IsolatedDocumentError } from './client';

export type UploadProcessingDependencies = {
  management: Pick<
    UploadManagement,
    | 'claimProcessing'
    | 'getProcessingInput'
    | 'renew'
    | 'publish'
    | 'fail'
    | 'confirmCleanup'
    | 'bindProcessingExecution'
    | 'claimWorkBytes'
    | 'completeWorkBytes'
  >;
  storage: StoragePort;
  documents: DocumentPort;
  worker: UploadWorker;
  stagingRoot: string;
  attempts?: UploadAttemptPort;
  now?: () => number;
  observe?(observation: {
    stage: 'processing' | 'total';
    seconds: number;
    outcome: 'success' | 'failure' | 'cancelled';
  }): void | Promise<void>;
};

/** One claim, no local queue/timer daemon. The owning app chooses when to request work. */
export async function processNextManagedUpload(
  deps: UploadProcessingDependencies,
  externalSignal: AbortSignal,
): Promise<
  | { claimed: false }
  | {
      claimed: true;
      /** Undefined when persisting the failure did not return an acknowledged operation. */
      operation:
        | Awaited<ReturnType<UploadProcessingDependencies['management']['publish']>>
        | undefined;
    }
> {
  let lease: UploadLease | null = null;
  let registration: UploadAttemptRegistration | undefined;
  let claimStarted = false;
  let startedAt: number | undefined;
  let outcome: 'success' | 'failure' | 'cancelled' = 'failure';
  const observe = (
    observation: Parameters<NonNullable<UploadProcessingDependencies['observe']>>[0],
  ): void => {
    try {
      void Promise.resolve(deps.observe?.(observation)).catch(() => undefined);
    } catch {
      /* Diagnostics cannot affect publication or cleanup. */
    }
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  externalSignal.addEventListener('abort', abort, { once: true });
  if (externalSignal.aborted) abort();
  const timeout = setTimeout(abort, 120_000);
  timeout.unref();
  let timer: NodeJS.Timeout | undefined;
  let heartbeat: Promise<void> | undefined;
  let directory: string | undefined;
  let stagingAttempted = false;
  let renewStopped = false;
  let writerStopped = true;
  let execution: UploadParserExecution | undefined;
  const renew = () => {
    heartbeat = (async () => {
      try {
        lease = await deps.management.renew(lease!);
      } catch {
        abort();
      }
      if (!controller.signal.aborted && !renewStopped) timer = setTimeout(renew, 5_000);
    })();
  };
  try {
    registration = deps.attempts?.begin(abort);
    controller.signal.throwIfAborted();
    claimStarted = true;
    lease = await deps.management.claimProcessing(deps.worker);
    if (!lease) return { claimed: false } as const;
    startedAt = performance.now();
    registration?.bind(lease);
    controller.signal.throwIfAborted();
    timer = setTimeout(renew, 5_000);
    const input = await deps.management.getProcessingInput(lease);
    const attemptId = uploadAttemptId(lease);
    const original = attemptOriginalPath(deps.stagingRoot, attemptId);
    stagingAttempted = true;
    await mkdir(path.dirname(original), { mode: 0o700 });
    directory = path.dirname(original);
    const file = await open(original, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of deps.storage.read({
        original: input.original,
        signal: controller.signal,
      })) {
        controller.signal.throwIfAborted();
        bytes += chunk.byteLength;
        if (bytes > input.bytes || bytes > 30 * 1024 * 1024)
          throw new Error('Original size mismatch');
        let offset = 0;
        while (offset < chunk.byteLength) {
          controller.signal.throwIfAborted();
          const requested = Math.min(64 * 1024, chunk.byteLength - offset);
          const grant = await deps.management.claimWorkBytes(lease, requested);
          controller.signal.throwIfAborted();
          if (!grant) {
            await delay(50, undefined, { signal: controller.signal });
            continue;
          }
          if (
            !Number.isSafeInteger(grant.bytes) ||
            grant.bytes < 1 ||
            grant.bytes > requested ||
            !Number.isFinite(Date.parse(grant.expiresAt)) ||
            Date.parse(grant.expiresAt) <= Date.now()
          ) {
            throw new Error('Upload byte allowance expired');
          }
          try {
            let written = 0;
            while (written < grant.bytes) {
              controller.signal.throwIfAborted();
              const write = await file.write(chunk, offset + written, grant.bytes - written);
              if (!write.bytesWritten) throw new Error('Upload staging unavailable');
              written += write.bytesWritten;
            }
          } finally {
            await deps.management.completeWorkBytes(lease, grant.generation);
          }
          offset += grant.bytes;
        }
      }
      if (bytes !== input.bytes) throw new Error('Original size mismatch');
      await file.sync();
    } finally {
      await file.close();
    }
    controller.signal.throwIfAborted();
    execution = await deps.documents.prepare({
      attemptId,
      mediaType: input.mediaType,
      signal: controller.signal,
    });
    writerStopped = false;
    // Durable intent precedes dispatch. A lost API process leaves a reconcilable
    // instance/attempt receipt; prepare alone cannot launch the parser.
    await deps.management.bindProcessingExecution(lease, execution);
    controller.signal.throwIfAborted();
    const result = await deps.documents.extract({ execution, signal: controller.signal });
    writerStopped = result.writerStopped === true;
    if (!writerStopped) throw new Error('Parser exit unconfirmed');
    renewStopped = true;
    clearTimeout(timer);
    await heartbeat;
    controller.signal.throwIfAborted();
    const operation = await deps.management.publish(lease, result);
    outcome = 'success';
    // A successful body request only queued work. Total ends at acknowledged ready publication,
    // before local cleanup. Cross-replica elapsed time uses the existing durable creation time.
    try {
      const createdAt = Date.parse(operation.createdAt);
      const publishedAt = (deps.now ?? Date.now)();
      if (
        operation.state === 'ready' &&
        Number.isFinite(createdAt) &&
        createdAt >= 0 &&
        Number.isFinite(publishedAt) &&
        publishedAt >= createdAt
      ) {
        observe({ stage: 'total', seconds: (publishedAt - createdAt) / 1_000, outcome: 'success' });
      }
    } catch {
      /* Missing or invalid diagnostic time never changes the committed result. */
    }
    return { claimed: true, operation } as const;
  } catch (error) {
    outcome = controller.signal.aborted ? 'cancelled' : 'failure';
    if (!lease) {
      // Guard refusal or a pre-claim abort admitted no work. An unclassified lost
      // claim response remains uncertain instead of manufacturing a drain receipt.
      if (claimStarted && !isUploadManagementError(error)) {
        writerStopped = false;
        throw error;
      }
      return { claimed: false } as const;
    }
    if (error instanceof IsolatedDocumentError) writerStopped = error.writerStopped;
    const operation = await deps.management.fail(lease, 'processing_failed').catch(() => undefined);
    if (execution && !writerStopped) {
      const stop = await deps.documents
        .cancel({ execution, signal: AbortSignal.timeout(5_000) })
        .catch(() => ({ writerStopped: false }));
      writerStopped = stop.writerStopped;
    }
    return { claimed: true, operation } as const;
  } finally {
    abort();
    renewStopped = true;
    clearTimeout(timeout);
    clearTimeout(timer);
    await heartbeat;
    externalSignal.removeEventListener('abort', abort);
    if (stagingAttempted && !directory) writerStopped = false;
    let localCopiesAbsent = !stagingAttempted;
    // Do not unlink an input still potentially being consumed by a live child.
    if (directory && writerStopped) {
      try {
        await rm(directory, { recursive: true, force: true });
        localCopiesAbsent = true;
      } catch {
        /* durable cleanup owner retries */
      }
    }
    if (lease && writerStopped && localCopiesAbsent) {
      await deps.management
        .confirmCleanup({
          operationId: lease.operationId,
          generation: lease.generation,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
          textAndHistoryRemoved: false,
        })
        .catch(() => undefined);
    }
    registration?.settle({ writerStopped, localCopiesAbsent });
    if (startedAt !== undefined) {
      observe({
        stage: 'processing',
        seconds: Math.max(0, performance.now() - startedAt) / 1_000,
        outcome,
      });
    }
  }
}
