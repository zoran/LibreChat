import { randomUUID } from 'crypto';
import { UPLOAD_MAX_FILE_BYTES, isUploadPrincipal } from 'librechat-data-provider';
import type {
  UploadPrincipal,
  UploadRequest,
  UploadOperation,
  UploadWorker,
  UploadLease,
  UploadStorageReceipt,
  UploadCleanupProof,
  UploadErrorCode,
  UploadParserExecution,
} from 'librechat-data-provider';
import type { UploadRepository, IdentityPort, ResourcePort, TelemetryPort } from './contract';
import { UploadManagementError, isUploadManagementError } from './errors';

export type UploadManagementDependencies = {
  repository: UploadRepository;
  identity: IdentityPort;
  resources: ResourcePort;
  telemetry?: TelemetryPort;
  now?: () => number;
  newId?: () => string;
};

const MEDIA_TYPES = new Set([
  'text/plain',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export interface UploadManagement {
  reserve(principal: UploadPrincipal, request: UploadRequest): Promise<UploadOperation>;
  get(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  list(principal: UploadPrincipal): Promise<UploadOperation[]>;
  usage(principal: UploadPrincipal): ReturnType<UploadRepository['usage']>;
  claimTransfer(
    principal: UploadPrincipal,
    id: string,
    worker: UploadWorker,
  ): Promise<UploadLease | null>;
  accept(
    principal: UploadPrincipal,
    id: string,
    lease: UploadLease,
    receipt: UploadStorageReceipt,
  ): Promise<UploadOperation>;
  cancel(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  delete(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  retryProcessing(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  claimProcessing(worker: UploadWorker): Promise<UploadLease | null>;
  renew(lease: UploadLease): Promise<UploadLease>;
  claimWorkBytes(
    lease: UploadLease,
    requestedBytes: number,
  ): ReturnType<UploadRepository['claimWorkBytes']>;
  completeWorkBytes(lease: UploadLease, generation: number): Promise<void>;
  getProcessingInput(lease: UploadLease): ReturnType<UploadRepository['getProcessingInput']>;
  bindProcessingExecution(
    lease: UploadLease,
    execution: UploadParserExecution,
  ): ReturnType<UploadRepository['bindProcessingExecution']>;
  publish(
    lease: UploadLease,
    result: { text: string; writerStopped: true },
  ): Promise<UploadOperation>;
  fail(lease: UploadLease, code: UploadErrorCode): Promise<UploadOperation>;
  confirmCleanup(proof: UploadCleanupProof): Promise<UploadOperation>;
}

/** No worker, stream or cleanup timer is started by this factory. */
export function createUploadManagement(deps: UploadManagementDependencies): UploadManagement {
  const { repository, identity, resources } = deps;
  const now = deps.now ?? Date.now;
  async function authorize(
    principal: UploadPrincipal,
    scope = { kind: 'personal' } as UploadOperation['scope'],
  ) {
    if (!isUploadPrincipal(principal)) {
      throw new UploadManagementError('unauthorized');
    }
    if (!(await identity.authorize(principal, scope))) throw new UploadManagementError('forbidden');
  }
  async function get(principal: UploadPrincipal, id: string) {
    await authorize(principal);
    const operation = await repository.get(principal, id, now());
    await authorize(principal, operation.scope);
    return operation;
  }
  function observe(callback: (telemetry: TelemetryPort) => void | Promise<void>): void {
    if (!deps.telemetry) return;
    try {
      void Promise.resolve(callback(deps.telemetry)).catch(() => undefined);
    } catch {
      /* Telemetry cannot hide a committed result or replace its original failure. */
    }
  }
  async function emit(promise: Promise<UploadOperation>): Promise<UploadOperation> {
    let operation: UploadOperation;
    try {
      operation = await promise;
    } catch (error) {
      if (isUploadManagementError(error)) {
        let reason: Parameters<TelemetryPort['rejectQuota']>[0] | undefined;
        if (error.code === 'quota_exceeded') reason = 'window';
        else if (error.code === 'capacity_exceeded') reason = 'capacity';
        else if (error.code === 'queue_full') reason = 'queue';
        const quotaReason = reason;
        if (quotaReason) observe((telemetry) => telemetry.rejectQuota(quotaReason));
      }
      throw error;
    }
    observe((telemetry) => telemetry.transition(operation.state));
    return operation;
  }
  return {
    async reserve(principal: UploadPrincipal, request: UploadRequest) {
      const scope = request.scope ?? { kind: 'personal' };
      await authorize(principal, scope);
      if (scope.kind !== 'personal') throw new UploadManagementError('forbidden');
      if (
        !Number.isSafeInteger(request.declaredBytes) ||
        request.declaredBytes <= 0 ||
        request.declaredBytes > UPLOAD_MAX_FILE_BYTES ||
        !request.filename ||
        request.filename.length > 255 ||
        // eslint-disable-next-line no-control-regex -- Reject control characters in uploaded filenames.
        /[\x00-\x1f]/.test(request.filename) ||
        !request.idempotencyKey ||
        request.idempotencyKey.length > 128
      ) {
        throw new UploadManagementError('invalid_request');
      }
      if (!MEDIA_TYPES.has(request.mediaType)) throw new UploadManagementError('unsupported_type');
      const fingerprint = JSON.stringify([
        scope,
        request.filename,
        request.mediaType,
        request.declaredBytes,
      ]);
      const previous = await repository.findReservation(
        principal,
        request.idempotencyKey,
        fingerprint,
        now(),
      );
      if (previous) return previous;
      await resources.assertSafe({ phase: 'admission' });
      return emit(
        repository.reserve(
          principal,
          { ...request, scope, fingerprint, operationId: (deps.newId ?? randomUUID)() },
          now(),
        ),
      );
    },
    get,
    async list(principal: UploadPrincipal) {
      await authorize(principal);
      const rows = await repository.list(principal, now());
      const allowed: UploadOperation[] = [];
      for (const row of rows) if (await identity.authorize(principal, row.scope)) allowed.push(row);
      return allowed;
    },
    async usage(principal: UploadPrincipal) {
      await authorize(principal);
      return repository.usage(principal, now());
    },
    async claimTransfer(principal: UploadPrincipal, id: string, worker: UploadWorker) {
      await get(principal, id);
      await resources.assertSafe({ phase: 'transfer', hostId: worker.hostId });
      return repository.claim({ kind: 'transfer', principal, operationId: id, worker, now: now() });
    },
    async accept(
      principal: UploadPrincipal,
      id: string,
      lease: UploadLease,
      receipt: UploadStorageReceipt,
    ) {
      if (lease.operationId !== id) throw new UploadManagementError('lease_lost');
      await get(principal, id);
      return emit(repository.accept(principal, lease, receipt, now()));
    },
    async cancel(principal: UploadPrincipal, id: string) {
      await get(principal, id);
      return emit(repository.cancel(principal, id, now()));
    },
    async delete(principal: UploadPrincipal, id: string) {
      await get(principal, id);
      return emit(repository.delete(principal, id, now()));
    },
    async retryProcessing(principal: UploadPrincipal, id: string) {
      const previous = await get(principal, id);
      const operation = await emit(repository.retryProcessing(principal, id, now()));
      // Ordinary replays do not requeue. Concurrent callers can observe the same transition;
      // this diagnostic count is deliberately not a replacement for durable accounting.
      if (
        previous.state === 'failed' &&
        operation.state === 'queued_processing' &&
        operation.revision > previous.revision
      )
        observe((telemetry) => telemetry.retry('processing'));
      return operation;
    },
    async claimProcessing(worker: UploadWorker) {
      await resources.assertSafe({ phase: 'processing', hostId: worker.hostId });
      return repository.claim({ kind: 'processing', worker, now: now() });
    },
    async renew(lease: UploadLease) {
      await resources.assertSafe({ phase: lease.kind, hostId: lease.hostId, lease });
      return repository.renew(lease, now());
    },
    claimWorkBytes: (lease: UploadLease, requestedBytes: number) =>
      repository.claimWorkBytes({ lease, requestedBytes, now: now() }),
    completeWorkBytes: (lease: UploadLease, generation: number) =>
      repository.completeWorkBytes({ lease, generation, now: now() }),
    getProcessingInput: (lease: UploadLease) => repository.getProcessingInput(lease, now()),
    bindProcessingExecution: (lease: UploadLease, execution: UploadParserExecution) =>
      repository.bindProcessingExecution(lease, execution, now()),
    publish: (lease: UploadLease, result: { text: string; writerStopped: true }) =>
      emit(repository.publish(lease, result, now())),
    fail: (lease: UploadLease, code: UploadErrorCode) => emit(repository.fail(lease, code, now())),
    confirmCleanup: (proof: UploadCleanupProof) => emit(repository.confirmCleanup(proof, now())),
  };
}
