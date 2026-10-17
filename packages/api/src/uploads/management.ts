import { randomUUID } from 'crypto';
import {
  UPLOAD_MAX_FILE_BYTES,
  isUploadPrincipal,
  readUploadAcceptedMetadata,
} from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  UploadPrincipal,
  UploadRequest,
  UploadOperation,
  UploadWorker,
  UploadLease,
  UploadStorageReceipt,
  UploadCleanupProof,
  UploadErrorCode,
  UploadParserExecution,
  UploadSecurityApproval,
  UploadSecurityExecution,
  UploadSecuritySettlement,
  UploadAcceptedMetadata,
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
  'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

/** Snapshot only technical own-data fields before authorization or other asynchronous work. */
function reservationData(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string' || !allowed.includes(key)) throw new Error();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error();
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    throw new UploadManagementError('invalid_request');
  }
}

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
    securityApproval: UploadSecurityApproval,
    metadata: UploadAcceptedMetadata,
  ): Promise<UploadOperation>;
  cancel(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  delete(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  retryProcessing(principal: UploadPrincipal, id: string): Promise<UploadOperation>;
  claimProcessing(worker: UploadWorker): Promise<UploadLease | null>;
  renew(lease: UploadLease): Promise<UploadLease>;
  bindSecurityExecution(lease: UploadLease, execution: UploadSecurityExecution): Promise<void>;
  settleSecurityExecution(lease: UploadLease, settlement: UploadSecuritySettlement): Promise<void>;
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
    result: ManagedDocumentResult & { writerStopped: true },
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
    async reserve(principal: UploadPrincipal, input: UploadRequest) {
      const data = reservationData(input, [
        'mediaType',
        'declaredBytes',
        'idempotencyKey',
        'scope',
      ]);
      const suppliedScope =
        data.scope === undefined
          ? { kind: 'personal' }
          : reservationData(data.scope, ['kind', 'workspaceId']);
      if (suppliedScope.kind === 'workspace') throw new UploadManagementError('forbidden');
      if (suppliedScope.kind !== 'personal' || Object.keys(suppliedScope).length !== 1)
        throw new UploadManagementError('invalid_request');
      const scope = { kind: 'personal' } as const;
      if (
        typeof data.declaredBytes !== 'number' ||
        !Number.isSafeInteger(data.declaredBytes) ||
        data.declaredBytes <= 0 ||
        data.declaredBytes > UPLOAD_MAX_FILE_BYTES ||
        typeof data.mediaType !== 'string' ||
        typeof data.idempotencyKey !== 'string' ||
        data.idempotencyKey.length !== 36 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          data.idempotencyKey,
        )
      ) {
        throw new UploadManagementError('invalid_request');
      }
      const request: UploadRequest = {
        mediaType: data.mediaType,
        declaredBytes: data.declaredBytes,
        idempotencyKey: data.idempotencyKey,
        scope,
      };
      await authorize(principal, scope);
      if (!MEDIA_TYPES.has(request.mediaType)) throw new UploadManagementError('unsupported_type');
      const fingerprint = JSON.stringify([scope, request.mediaType, request.declaredBytes]);
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
      securityApproval: UploadSecurityApproval,
      metadata: UploadAcceptedMetadata,
    ) {
      const acceptedMetadata = readUploadAcceptedMetadata(metadata);
      if (!acceptedMetadata) throw new UploadManagementError('invalid_request');
      if (lease.operationId !== id) throw new UploadManagementError('lease_lost');
      await get(principal, id);
      return emit(
        repository.accept(principal, lease, receipt, securityApproval, acceptedMetadata, now()),
      );
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
    bindSecurityExecution: (lease, execution) =>
      repository.bindSecurityExecution(lease, execution, now()),
    settleSecurityExecution: (lease, settlement) =>
      repository.settleSecurityExecution(lease, settlement, now()),
    completeWorkBytes: (lease: UploadLease, generation: number) =>
      repository.completeWorkBytes({ lease, generation, now: now() }),
    getProcessingInput: (lease: UploadLease) => repository.getProcessingInput(lease, now()),
    bindProcessingExecution: (lease: UploadLease, execution: UploadParserExecution) =>
      repository.bindProcessingExecution(lease, execution, now()),
    publish: (lease: UploadLease, result: ManagedDocumentResult & { writerStopped: true }) =>
      emit(repository.publish(lease, result, now())),
    fail: (lease: UploadLease, code: UploadErrorCode) => emit(repository.fail(lease, code, now())),
    confirmCleanup: (proof: UploadCleanupProof) => emit(repository.confirmCleanup(proof, now())),
  };
}
