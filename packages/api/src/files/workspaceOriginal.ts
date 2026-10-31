/** Workspace original materialization; native File/Upload owners retain source and custody authority. */
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  buildManagedFileReadBinding,
  isUploadOriginalIntegrity,
  isUploadStorageReceipt,
  readHistoricalUploadSecurityApproval,
  matchesHistoricalUploadSecurityApproval,
  readUploadDerivedOrigin,
  sameUploadDerivedOrigin,
} from 'librechat-data-provider';
import type {
  UploadCleanupTask,
  UploadDerivedOrigin,
  UploadOperation,
  UploadPrincipal,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { DocumentWorkspaceMethods, WorkspaceFileSource } from '@librechat/data-schemas';
import type { EventEmitter } from 'node:events';
import type { ManagedSourceResolver } from './managedSource';
import type { StoragePort } from '~/uploads/contract';
import { resolveFileStorageAuthority } from './storageAuthority';
import { managedOriginalKey } from '../storage/s3/managed';

export type WorkspaceOriginalRequest = Parameters<ManagedSourceResolver['authorize']>[0] &
  Pick<EventEmitter, 'once' | 'off'> & { aborted?: boolean };

export type WorkspaceOriginalRuntime = {
  management: { get(principal: UploadPrincipal, id: string): Promise<UploadOperation> };
  repository: {
    cleanupForFile(principal: UploadPrincipal, id: string): Promise<UploadCleanupTask | null>;
  };
  storage: Pick<StoragePort, 'read'>;
};

export type WorkspaceOriginalDependencies = {
  getRuntime(): WorkspaceOriginalRuntime | null | undefined;
  authorize(request: WorkspaceOriginalRequest): Promise<UploadPrincipal>;
  getDocumentWorkspaceVersionFile: DocumentWorkspaceMethods['getDocumentWorkspaceVersionFile'];
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  policySha256(): string | undefined;
};

export type WorkspaceOriginalOptions = {
  now?: () => number;
  monotonic?: () => number;
  deadlineMs?: number;
};

type Result = { bytes: Buffer; mediaType: 'text/plain' | 'text/csv' };
type Access = {
  principal: UploadPrincipal;
  file: WorkspaceFileSource;
  receipt: UploadStorageReceipt;
  origin: UploadDerivedOrigin;
};

const MAX_BYTES = 65_536;
const snapshot = <T>(value: T): T => (value == null ? value : JSON.parse(JSON.stringify(value)));
const unavailable = (code = 'not_found') => Object.assign(new Error(code), { code });
const samePrincipal = (left: UploadPrincipal, right: UploadPrincipal): boolean =>
  left?.userId === right.userId &&
  left?.tenantId === right.tenantId &&
  left?.authentication === right.authentication;
const time = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return Date.parse(value);
  return NaN;
};
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** Ports are injected by CJS composition; no application singleton or database is acquired here. */
export function createWorkspaceOriginalReader(
  dependencies: WorkspaceOriginalDependencies,
  options: WorkspaceOriginalOptions = {},
): {
  read(request: WorkspaceOriginalRequest, workspaceId: string, revision: number): Promise<Result>;
} {
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? 30_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000)
    throw new Error('Invalid workspace original deadline');

  async function read(
    req: WorkspaceOriginalRequest,
    workspaceId: string,
    revision: number,
  ): Promise<Result> {
    if (
      typeof workspaceId !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(workspaceId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw unavailable('invalid_request');

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, deadlineMs);
    timer.unref();
    req.once('aborted', abort);
    const started = monotonic();
    let hardDeadline = now() + deadlineMs;
    let runtime: WorkspaceOriginalRuntime | null | undefined;
    function live(): void {
      if (
        req.aborted ||
        controller.signal.aborted ||
        monotonic() - started >= deadlineMs ||
        now() >= hardDeadline ||
        dependencies.getRuntime() !== runtime
      )
        throw unavailable('unavailable');
    }

    function validateFile(
      file: WorkspaceFileSource,
      principal: UploadPrincipal,
    ): UploadDerivedOrigin {
      const origin = readUploadDerivedOrigin(file?.derivedOrigin);
      const acceptedAt = time(file?.retentionAcceptedAt);
      const expiresAt = time(file?.expiredAt);
      if (
        !file ||
        typeof file.file_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(file.file_id) ||
        file.uploadOperationId !== file.file_id ||
        file.user !== principal.userId ||
        file.tenantId !== principal.tenantId ||
        file.status !== 'ready' ||
        !['s3', 'nas-s3'].includes(file.source) ||
        (file.type !== 'text/plain' && file.type !== 'text/csv') ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > MAX_BYTES ||
        file.filepath !== `/api/files/managed/${file.file_id}` ||
        !/^[a-f0-9]{64}$/.test(file.sourceBindingSha256) ||
        !origin ||
        origin.binding.purpose !== 'workspace-draft' ||
        origin.binding.sourceId !== workspaceId ||
        origin.binding.sourceRevision !== revision - 1 ||
        !Number.isSafeInteger(acceptedAt) ||
        acceptedAt < 0 ||
        acceptedAt > now() ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= now()
      )
        throw unavailable();
      return origin;
    }

    async function lookup(expected?: Access): Promise<Access> {
      live();
      const authenticated = await dependencies.authorize(req);
      if (expected && !samePrincipal(authenticated, expected.principal))
        throw unavailable('unauthorized');
      const principal: UploadPrincipal = { ...authenticated };
      const loadFile = async (): Promise<WorkspaceFileSource> =>
        snapshot(
          await dependencies.runAsSystem(() =>
            dependencies.getDocumentWorkspaceVersionFile(
              { userId: principal.userId, tenantId: principal.tenantId },
              workspaceId,
              revision,
            ),
          ),
        );
      let file = expected?.file ?? (await loadFile());
      validateFile(file, principal);
      if (!expected) hardDeadline = Math.min(hardDeadline, time(file.expiredAt));
      live();
      const operation = snapshot(await runtime!.management.get(principal, file.file_id));
      const task = snapshot(
        await dependencies.runAsSystem(() =>
          runtime!.repository.cleanupForFile(principal, file.file_id),
        ),
      );
      live();
      if (expected) {
        if (!samePrincipal(await dependencies.authorize(req), principal))
          throw unavailable('unauthorized');
        // The last awaited authority is the native User/Workspace/File/Upload transaction.
        file = await loadFile();
        live();
      }
      const origin = validateFile(file, principal);
      const receipt = task?.original;
      const approval = readHistoricalUploadSecurityApproval(file.securityApproval);
      if (
        operation?.id !== file.file_id ||
        operation.fileId !== file.file_id ||
        operation.scope?.kind !== 'personal' ||
        operation.state !== 'ready' ||
        operation.canUseInComposer !== false ||
        operation.cleanupPending !== false ||
        operation.mediaType !== file.type ||
        operation.actualBytes !== file.bytes ||
        time(operation.acceptedAt) !== time(file.retentionAcceptedAt) ||
        !Number.isSafeInteger(time(operation.expiresAt)) ||
        time(operation.expiresAt) <= now() ||
        task?.operationId !== file.file_id ||
        task.fileId !== file.file_id ||
        task.state !== 'ready' ||
        !samePrincipal(task.principal, principal) ||
        typeof task.attemptGeneration !== 'number' ||
        !Number.isSafeInteger(task.attemptGeneration) ||
        task.attemptGeneration < 1 ||
        !isUploadStorageReceipt(receipt) ||
        receipt.outcome !== 'durable' ||
        receipt.source !== file.source ||
        !approval ||
        (receipt.source === 'nas-s3' && approval.version !== 2) ||
        receipt.bytes !== file.bytes ||
        receipt.filepath !== file.filepath ||
        receipt.storageKey !== file.storageKey ||
        (receipt.source === 's3' &&
          receipt.storageKey !==
            managedOriginalKey({
              ...principal,
              operationId: file.file_id,
              generation: task.attemptGeneration,
            })) ||
        !resolveFileStorageAuthority(task, {
          operationId: file.file_id,
          source: file.source,
          storageKey: file.storageKey,
          bytes: file.bytes,
          mediaType: file.type,
        }) ||
        !isUploadOriginalIntegrity(receipt.integrity, file.bytes) ||
        !matchesHistoricalUploadSecurityApproval(
          approval,
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
            operationId: file.file_id,
            transferGeneration: task.attemptGeneration,
            mediaType: file.type,
            bytes: file.bytes,
            sha256: receipt.integrity.sha256,
          },
          dependencies.policySha256() ?? '',
          now(),
        )
      )
        throw unavailable();
      const binding = buildManagedFileReadBinding(
        {
          owner: principal,
          fileId: file.file_id,
          operationId: file.uploadOperationId,
          filename: file.filename,
          mediaType: file.type,
          source: file.source,
          bytes: file.bytes,
          storageKey: file.storageKey,
          transferGeneration: task.attemptGeneration,
          original: receipt,
          approval: file.securityApproval,
          representation: 'original',
        },
        sha256,
      );
      if (
        binding !== file.sourceBindingSha256 ||
        (expected &&
          (binding !== expected.file.sourceBindingSha256 ||
            time(file.retentionAcceptedAt) !== time(expected.file.retentionAcceptedAt) ||
            !sameUploadDerivedOrigin(origin, expected.origin)))
      )
        throw unavailable();
      live();
      return { principal, file, receipt, origin };
    }

    try {
      runtime = dependencies.getRuntime();
      if (!runtime) throw unavailable('unavailable');
      const access = await lookup();
      const chunks: Buffer[] = [];
      let length = 0;
      // Existing storage verifies block/full digests and EOF; no partial bytes escape this buffer.
      for await (const chunk of runtime.storage.read({
        principal: access.principal,
        operationId: access.file.uploadOperationId,
        original: access.receipt,
        signal: controller.signal,
      })) {
        live();
        if (!(chunk instanceof Uint8Array) || length + chunk.byteLength > access.file.bytes)
          throw unavailable('unavailable');
        length += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
      if (length !== access.file.bytes) throw unavailable('unavailable');
      await lookup(access);
      live();
      return { bytes: Buffer.concat(chunks, length), mediaType: access.file.type };
    } catch (error) {
      const supplied = (error as { code?: string } | null)?.code;
      const code =
        supplied && ['unauthorized', 'forbidden', 'not_found', 'invalid_request'].includes(supplied)
          ? supplied
          : 'unavailable';
      throw unavailable(code);
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      controller.abort();
    }
  }
  return { read };
}
