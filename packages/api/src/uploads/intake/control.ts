/** App-owned capability control and approved-only promotion; existing owners retain all state. */
import { createHash } from 'node:crypto';
import {
  UPLOAD_ERROR_CODES,
  UPLOAD_INTEGRITY_CHUNK_BYTES,
  UPLOAD_MAX_FILE_BYTES,
  readUploadIntakeGrant,
  readUploadIntakeRecovery,
  readUploadIntakeLocalSettlement,
  readUploadPromotionInput,
  readUploadPromotionRecord,
  readUploadPromotionSettlement,
  readUploadSecurityExecution,
  readUploadSecuritySettlement,
} from 'librechat-data-provider';
import type {
  UploadWorker,
  UploadLease,
  UploadCleanupProof,
  UploadErrorCode,
  UploadPromotionRecord,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { EmailCodeRepository, UploadManagementRepository } from '@librechat/data-schemas';
import type {
  ResourcePort,
  StoragePort,
  UploadAttemptPort,
  UploadAttemptRegistration,
} from '../contract';
import type { IntakeChannelContext, IntakeChannelHandlers } from './channel';
import type { UploadManagement } from '../management';
import { validateEmailCodeUploadGrant } from '../../auth/emailCode';
import { verifyOriginalIntegrity } from '../storage/integrity';
import { UploadManagementError } from '../errors';

export type IntakeControlOptions = {
  repository: Pick<
    UploadManagementRepository,
    | 'readIntake'
    | 'claim'
    | 'renew'
    | 'preparePromotion'
    | 'beginPromotion'
    | 'settlePromotion'
    | 'getPromotion'
    | 'sealIntakeRecovery'
    | 'confirmIntakeRecovery'
  >;
  identityRepository: Pick<EmailCodeRepository, 'readEmailCodeIdentity'>;
  management: Pick<
    UploadManagement,
    | 'get'
    | 'fail'
    | 'cancel'
    | 'bindSecurityExecution'
    | 'settleSecurityExecution'
    | 'claimWorkBytes'
    | 'completeWorkBytes'
    | 'accept'
    | 'confirmCleanup'
  >;
  resources: ResourcePort;
  storage: Pick<StoragePort, 'put'>;
  attempts: UploadAttemptPort;
  worker: UploadWorker;
  now?: () => number;
};

const IDENTIFIER = /^[a-zA-Z0-9_.-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function fail(code: UploadErrorCode = 'invalid_request'): never {
  throw new UploadManagementError(code);
}
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const sameWorker = (left: UploadWorker, right: UploadWorker) =>
  left.hostId === right.hostId && left.instanceId === right.instanceId;

/** Direct callers have the same bounded own-data boundary as the JSON channel, before any await. */
function snapshot(value: unknown): unknown {
  let nodes = 2048,
    bytes = 32 * 1024;
  function copy(input: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 10) fail();
    if (input === null || typeof input === 'boolean') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (typeof input === 'string' && input.length <= 4096) {
      bytes -= Buffer.byteLength(input);
      if (bytes < 0) fail();
      return input;
    }
    if (!input || typeof input !== 'object') fail();
    const keys = Reflect.ownKeys(input);
    if (Array.isArray(input)) {
      const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
      if (
        !Number.isSafeInteger(length) ||
        length > Math.ceil(UPLOAD_MAX_FILE_BYTES / UPLOAD_INTEGRITY_CHUNK_BYTES) ||
        keys.length !== length + 1
      )
        fail();
      return Array.from({ length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) fail();
        return copy(descriptor.value, depth + 1);
      });
    }
    if (![Object.prototype, null].includes(Object.getPrototypeOf(input)) || keys.length > 32)
      fail();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return result;
  }
  try {
    return copy(value, 0);
  } catch {
    return fail();
  }
}
function fields(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = value as Record<string, unknown>;
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(result, key)) ||
    Object.keys(result).some((key) => !required.includes(key) && !optional.includes(key))
  )
    fail();
  return result;
}
function worker(value: unknown): UploadWorker {
  const data = fields(value, ['hostId', 'instanceId']);
  if (
    typeof data.hostId !== 'string' ||
    !IDENTIFIER.test(data.hostId) ||
    typeof data.instanceId !== 'string' ||
    !IDENTIFIER.test(data.instanceId)
  )
    fail();
  return { hostId: data.hostId, instanceId: data.instanceId };
}
function lease(value: unknown): UploadLease {
  const data = fields(value, [
    'hostId',
    'instanceId',
    'operationId',
    'generation',
    'kind',
    'tenantId',
    'userId',
    'expiresAt',
  ]);
  if (
    data.kind !== 'transfer' ||
    !integer(data.generation) ||
    typeof data.operationId !== 'string' ||
    !IDENTIFIER.test(data.operationId) ||
    typeof data.tenantId !== 'string' ||
    !IDENTIFIER.test(data.tenantId) ||
    typeof data.userId !== 'string' ||
    !/^[a-f0-9]{24}$/.test(data.userId) ||
    typeof data.expiresAt !== 'string' ||
    data.expiresAt.length !== 24 ||
    !Number.isFinite(Date.parse(data.expiresAt)) ||
    new Date(data.expiresAt).toISOString() !== data.expiresAt
  )
    fail();
  return {
    ...worker({ hostId: data.hostId, instanceId: data.instanceId }),
    operationId: data.operationId,
    generation: data.generation,
    kind: 'transfer',
    tenantId: data.tenantId,
    userId: data.userId,
    expiresAt: data.expiresAt,
  };
}
function context(value: IntakeChannelContext): IntakeChannelContext {
  const data = fields(snapshot(value), ['operationId', 'capability', 'worker']);
  if (
    typeof data.operationId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(data.operationId) ||
    typeof data.capability !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.capability)
  )
    fail();
  return {
    operationId: data.operationId,
    capability: data.capability,
    worker: worker(data.worker),
  };
}

export function createIntakeControlHandlers(options: IntakeControlOptions): IntakeChannelHandlers {
  const appWorker = worker(snapshot(options.worker));
  const { repository, management } = options;
  const now = options.now ?? Date.now;
  async function authorize(ctx: IntakeChannelContext, signal: AbortSignal) {
    signal.throwIfAborted();
    const capabilitySha256 = createHash('sha256').update(ctx.capability).digest('hex');
    const stored = fields(
      snapshot(await repository.readIntake(ctx.operationId, capabilitySha256, now())),
      ['grant'],
      ['worker', 'generation'],
    );
    const grant = readUploadIntakeGrant(stored.grant);
    if (!grant || !(await validateEmailCodeUploadGrant(grant, options.identityRepository, now())))
      fail('unauthorized');
    signal.throwIfAborted();
    if (stored.worker !== undefined || stored.generation !== undefined) {
      if (!integer(stored.generation) || !sameWorker(worker(stored.worker), ctx.worker))
        fail('lease_lost');
    }
    return {
      principal: grant.principal,
      generation: stored.generation as number | undefined,
      capabilitySha256,
    };
  }
  type Authority = Awaited<ReturnType<typeof authorize>>;
  function bound(value: UploadLease, ctx: IntakeChannelContext, auth: Authority): void {
    if (
      value.operationId !== ctx.operationId ||
      value.generation !== auth.generation ||
      value.tenantId !== auth.principal.tenantId ||
      value.userId !== auth.principal.userId ||
      !sameWorker(value, ctx.worker)
    )
      fail('lease_lost');
  }
  async function active(
    ctx: IntakeChannelContext,
    auth: Authority,
    state?: 'waiting' | 'transferring',
  ) {
    const operation = await management.get(auth.principal, ctx.operationId);
    if (state ? operation.state !== state : !['waiting', 'transferring'].includes(operation.state))
      fail('not_ready');
    return operation;
  }
  async function promotion(ctx: IntakeChannelContext, auth: Authority) {
    const value = await repository.getPromotion(auth.principal, ctx.operationId, now());
    if (value === null) return null;
    const record = readUploadPromotionRecord(value);
    if (!record || !sameWorker(record.worker, appWorker)) fail('lease_lost');
    bound(lease(record.lease), ctx, auth);
    return record;
  }
  async function control(
    input: IntakeChannelContext,
    value: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const ctx = context(input);
    const command = snapshot(value) as Record<string, unknown>;
    if (!command || typeof command.action !== 'string') fail();
    const shapes: Record<string, string[]> = {
      authorize: [],
      get: [],
      claim: [],
      renew: ['lease'],
      fail: ['lease', 'code'],
      cancel: [],
      'bind-security': ['lease', 'execution'],
      'settle-security': ['lease', 'settlement'],
      'claim-bytes': ['lease', 'requestedBytes'],
      'complete-bytes': ['lease', 'generation'],
      'prepare-promotion': ['input'],
      'get-promotion': [],
      accept: ['lease', 'promotionId'],
      'confirm-cleanup': ['proof'],
      'seal-recovery': ['transferGeneration'],
      'confirm-recovery': ['settlement'],
    };
    if (!Object.prototype.hasOwnProperty.call(shapes, command.action)) fail();
    fields(command, ['action', ...shapes[command.action]]);
    if (command.action === 'seal-recovery' || command.action === 'confirm-recovery') {
      signal.throwIfAborted();
      const settlement =
        command.action === 'confirm-recovery'
          ? readUploadIntakeLocalSettlement(command.settlement)
          : undefined;
      if (settlement === null) fail();
      if (
        settlement &&
        (settlement.operationId !== ctx.operationId || !sameWorker(settlement.worker, ctx.worker))
      )
        fail('lease_lost');
      const generation = settlement?.transferGeneration ?? command.transferGeneration;
      if (!integer(generation)) fail();
      // Technical cleanup retains only the original capability/worker binding after grant loss.
      const binding = {
        version: 1 as const,
        operationId: ctx.operationId,
        transferGeneration: generation,
        worker: ctx.worker,
        capabilitySha256: createHash('sha256').update(ctx.capability).digest('hex'),
      };
      const recovered = readUploadIntakeRecovery(
        settlement
          ? await repository.confirmIntakeRecovery(binding, settlement, now())
          : await repository.sealIntakeRecovery(binding, now()),
      );
      signal.throwIfAborted();
      if (
        !recovered ||
        recovered.operationId !== ctx.operationId ||
        recovered.transferGeneration !== generation ||
        !sameWorker(recovered.worker, ctx.worker)
      )
        fail('lease_lost');
      return recovered;
    }
    const held = command.lease === undefined ? undefined : lease(command.lease);
    const auth = await authorize(ctx, signal);
    if (held) bound(held, ctx, auth);
    switch (command.action) {
      case 'authorize':
        return auth.principal;
      case 'get':
        return active(ctx, auth);
      case 'claim':
        if (auth.generation !== undefined) fail('lease_lost');
        await active(ctx, auth, 'waiting');
        await options.resources.assertSafe({ phase: 'admission', hostId: appWorker.hostId });
        signal.throwIfAborted();
        return repository.claim({
          kind: 'transfer',
          principal: auth.principal,
          operationId: ctx.operationId,
          worker: ctx.worker,
          intake: { capabilitySha256: auth.capabilitySha256 },
          now: now(),
        });
      case 'renew':
        // Intake owns its local reserve; App checks only its downstream admission.
        // The authenticated original worker/lease remains fenced by the native repository.
        await options.resources.assertSafe({ phase: 'admission', hostId: appWorker.hostId });
        signal.throwIfAborted();
        return repository.renew(held!, now());
      case 'fail':
        if (!UPLOAD_ERROR_CODES.includes(command.code as UploadErrorCode)) fail();
        return management.fail(held!, command.code as UploadErrorCode);
      case 'cancel':
        await active(ctx, auth);
        return management.cancel(auth.principal, ctx.operationId);
      case 'bind-security': {
        const execution = readUploadSecurityExecution(command.execution);
        if (!execution) fail();
        return management.bindSecurityExecution(held!, execution);
      }
      case 'settle-security': {
        const settlement = readUploadSecuritySettlement(command.settlement);
        if (!settlement) fail();
        return management.settleSecurityExecution(held!, settlement);
      }
      case 'claim-bytes':
        if (!integer(command.requestedBytes) || command.requestedBytes > UPLOAD_MAX_FILE_BYTES)
          fail();
        return management.claimWorkBytes(held!, command.requestedBytes);
      case 'complete-bytes':
        if (!integer(command.generation)) fail();
        return management.completeWorkBytes(held!, command.generation);
      case 'prepare-promotion': {
        const data = fields(command.input, [
          'version',
          'promotionId',
          'lease',
          'approval',
          'integrity',
          'metadata',
        ]);
        const prepared = readUploadPromotionInput({ ...data, worker: appWorker });
        if (!prepared) fail();
        bound(prepared.lease, ctx, auth);
        return repository.preparePromotion(prepared, now());
      }
      case 'get-promotion':
        return promotion(ctx, auth);
      case 'accept': {
        if (typeof command.promotionId !== 'string' || !UUID.test(command.promotionId)) fail();
        const record = await promotion(ctx, auth);
        if (
          !record ||
          record.promotionId !== command.promotionId ||
          record.state !== 'settled' ||
          !record.writerStopped ||
          record.receipt?.outcome !== 'durable'
        )
          fail('not_ready');
        return management.accept(
          auth.principal,
          ctx.operationId,
          held!,
          record.receipt,
          record.approval,
          record.metadata,
        );
      }
      case 'confirm-cleanup': {
        const proof = fields(
          command.proof,
          [
            'operationId',
            'generation',
            'writerStopped',
            'originalAbsent',
            'localCopiesAbsent',
            'textAndHistoryRemoved',
          ],
          ['securitySettlement'],
        );
        if (
          proof.operationId !== ctx.operationId ||
          proof.generation !== auth.generation ||
          !integer(proof.generation) ||
          proof.textAndHistoryRemoved !== false ||
          ['writerStopped', 'originalAbsent', 'localCopiesAbsent'].some(
            (key) => typeof proof[key] !== 'boolean',
          )
        )
          fail();
        if (
          proof.securitySettlement !== undefined &&
          !readUploadSecuritySettlement(proof.securitySettlement)
        )
          fail();
        const record = await promotion(ctx, auth);
        if (
          record &&
          (!record.writerStopped ||
            (proof.originalAbsent &&
              record.state !== 'prepared' &&
              record.receipt?.outcome !== 'absent'))
        )
          fail('not_ready');
        return management.confirmCleanup(proof as UploadCleanupProof);
      }
      default:
        return fail();
    }
  }
  async function promote(
    input: IntakeChannelContext,
    promotionId: string,
    bytes: number,
    signal: AbortSignal,
  ) {
    const ctx = context(input);
    if (
      typeof promotionId !== 'string' ||
      !UUID.test(promotionId) ||
      !integer(bytes) ||
      bytes > UPLOAD_MAX_FILE_BYTES
    )
      fail();
    const auth = await authorize(ctx, signal);
    const record = await promotion(ctx, auth);
    if (
      !record ||
      record.promotionId !== promotionId ||
      record.approval.subject.bytes !== bytes ||
      record.state !== 'prepared'
    )
      fail('not_ready');
    await options.resources.assertSafe({ phase: 'transfer', hostId: appWorker.hostId });
    signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let registration: UploadAttemptRegistration;
    try {
      registration = options.attempts.begin(() => controller.abort());
    } catch (error) {
      signal.removeEventListener('abort', abort);
      throw error;
    }
    let beginAttempted = false;
    let putStarted = false,
      consumed = false,
      closed = false;
    let receipt: UploadStorageReceipt | undefined;
    let outcome: 'not_started' | 'absent' | 'durable' | 'unknown' = 'not_started';
    let running: Promise<UploadPromotionRecord> | undefined;
    let finalizing: Promise<UploadPromotionRecord> | undefined;
    function finish(): Promise<UploadPromotionRecord> {
      finalizing ??= (async () => {
        const writerStopped = outcome !== 'unknown';
        try {
          const settled = await repository.settlePromotion(
            {
              operationId: ctx.operationId,
              transferGeneration: record!.lease.generation,
              promotionId,
              worker: appWorker,
              writerStopped,
              ...(receipt ? { receipt } : {}),
            },
            now(),
          );
          const captured = readUploadPromotionRecord(settled);
          if (!captured) fail('unavailable');
          return captured;
        } finally {
          registration.settle({ writerStopped, localCopiesAbsent: true, storageOutcome: outcome });
          signal.removeEventListener('abort', abort);
        }
      })();
      return finalizing;
    }
    try {
      registration.bind({
        ...appWorker,
        operationId: ctx.operationId,
        generation: record.lease.generation,
      });
      beginAttempted = true;
      const begun = readUploadPromotionRecord(
        await repository.beginPromotion(record.lease, promotionId, appWorker, now()),
      );
      if (
        !begun ||
        begun.state !== 'writing' ||
        begun.writerStopped ||
        begun.promotionId !== promotionId ||
        !sameWorker(begun.worker, appWorker) ||
        JSON.stringify(begun.lease) !== JSON.stringify(record.lease)
      )
        fail('unavailable');
      controller.signal.throwIfAborted();
    } catch (error) {
      if (beginAttempted) await finish().catch(() => undefined);
      else {
        registration.settle({
          writerStopped: true,
          localCopiesAbsent: true,
          storageOutcome: 'not_started',
        });
        signal.removeEventListener('abort', abort);
      }
      throw error;
    }
    return {
      consume(body: AsyncIterable<Uint8Array>): Promise<UploadPromotionRecord> {
        if (consumed || closed) return Promise.reject(new UploadManagementError('not_ready'));
        consumed = true;
        running = (async () => {
          try {
            const current = await authorize(ctx, controller.signal);
            bound(record.lease, ctx, current);
            await options.resources.assertSafe({
              phase: 'admission',
              hostId: appWorker.hostId,
            });
            controller.signal.throwIfAborted();
            const renewed = await repository.renew(record.lease, now());
            bound(lease(snapshot(renewed)), ctx, current);
            controller.signal.throwIfAborted();
            let complete = false;
            const checkedBody = (async function* () {
              yield* verifyOriginalIntegrity(body, bytes, record.integrity, controller.signal);
              complete = true;
            })();
            putStarted = true;
            outcome = 'unknown';
            const result = await options.storage.put({
              lease: renewed,
              filename: record.metadata.filename,
              mediaType: record.approval.subject.mediaType,
              bytes,
              integrity: record.integrity,
              securityApproval: record.approval,
              body: checkedBody,
              signal: controller.signal,
            });
            const captured = snapshot(result) as UploadStorageReceipt;
            const checked = readUploadPromotionSettlement({
              operationId: ctx.operationId,
              transferGeneration: record.lease.generation,
              promotionId,
              worker: appWorker,
              writerStopped: captured?.outcome !== 'unknown',
              receipt: captured,
            });
            if (!checked?.receipt || (checked.receipt.outcome === 'durable' && !complete))
              fail('storage_uncertain');
            receipt = checked.receipt;
            outcome = receipt.outcome;
            return await finish();
          } catch (error) {
            if (!putStarted) outcome = 'not_started';
            await finish().catch(() => undefined);
            throw error;
          }
        })();
        return running;
      },
      async close() {
        if (closed) {
          await (running ?? finalizing)?.catch(() => undefined);
          return;
        }
        closed = true;
        controller.abort();
        if (running) await running.catch(() => undefined);
        else await finish();
      },
    };
  }
  return { control, promote };
}
