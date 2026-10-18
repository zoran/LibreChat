import { createHash } from 'node:crypto';
import {
  SYSTEM_TENANT_ID,
  snapshotGenerationCheckpointAdmission,
  snapshotGenerationCheckpointBinding,
  snapshotCheckpointSourceBinding,
} from '@librechat/data-schemas';
import type {
  GenerationAdmissionInput,
  GenerationPreparationInput,
  GenerationAdmissionMethods,
  GenerationAdmissionTerminal,
  GenerationCheckpointBinding,
  GenerationAdmissionRecoveryReceipt,
  GenerationCheckpointSourceRecovery,
} from '@librechat/data-schemas';
import type { ExternalApplicationWorkCensus } from '~/app';

/** Only the issuing live coordinator may consume this acknowledged preparation once. */
export interface GenerationPreparationReceipt {
  readonly input: Readonly<GenerationPreparationInput>;
  readonly continuation: Readonly<GenerationCheckpointBinding>;
}
export interface GenerationRequestBinding {
  clientRequestId: string;
  requestFingerprint: string;
}
export interface GenerationAdmissionConfiguration {
  required: boolean;
  methods?: GenerationAdmissionMethods;
  ownerInstanceId: string;
  processBootId: string;
  externalCensus?: () => Promise<ExternalApplicationWorkCensus>;
}
/** Server-owned proof ports. Process termination alone never proves remote effects settled. */
export interface GenerationCheckpointRecoveryPorts {
  /** Host projection only, after acknowledged Mongo recovery; never releases source payloads. */
  adoptRecoveredGeneration(
    admission: Readonly<GenerationAdmissionInput>,
    sourceExpiresAt?: number,
  ): Promise<boolean>;
  /** Database-only, called inside the recovery CAS transaction; mandatory for source-bound rows. */
  recoverSources?: GenerationCheckpointSourceRecovery;
  authorize(predecessor: Readonly<GenerationAdmissionInput>): Promise<boolean>;
  confirmTerminatedOwner(predecessor: Readonly<GenerationAdmissionInput>): Promise<{
    predecessor: GenerationAdmissionInput;
    terminationEvidenceSha256: string;
  } | null>;
  reconcileEffects(predecessor: Readonly<GenerationAdmissionInput>): Promise<{
    predecessor: GenerationAdmissionInput;
    checkpointWriteRevision: number;
    effectsEvidenceSha256: string;
  } | null>;
}
export interface GenerationAdmissionCensus {
  admissionClosed: boolean;
  initializing: number;
  providerExecutions: number;
  queuedContinuations: number;
  pendingWrites: number;
  activeStreams: number;
  unresolved: number;
  complete: boolean;
}
export class GenerationAdmissionHeldError extends Error {
  readonly code = 'GENERATION_ADMISSION_HELD';
  readonly status = 409;
  constructor() {
    super('Generation work is held; a confirmed admission or settlement is required');
  }
}
/** A deadline requests cancellation; only the task's actual settlement releases its owner. */
export async function awaitGenerationAuxiliaryWork<T>(
  work: Promise<T>,
  abortController: AbortController,
  timeoutMs: number,
): Promise<T | undefined> {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort();
  }, timeoutMs);
  try {
    const result = await work;
    return timedOut ? undefined : result;
  } catch (error) {
    if (abortController.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new GenerationAdmissionHeldError();
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`)
    .join(',')}}`;
}
export function generationRequestBinding(
  clientRequestId: string | undefined,
  payload: unknown,
): GenerationRequestBinding | undefined {
  if (!clientRequestId) return undefined;
  try {
    return {
      clientRequestId,
      requestFingerprint: createHash('sha256')
        .update(canonical(JSON.parse(JSON.stringify(payload))))
        .digest('hex'),
    };
  } catch {
    throw new GenerationAdmissionHeldError();
  }
}
const tenant = (id?: string): string => (id && id !== SYSTEM_TENANT_ID ? id : '__single_tenant__');
const localKey = (stream: string, epoch: number, segment: string): string =>
  JSON.stringify([stream, epoch, segment]);
interface LocalAdmission {
  input: GenerationAdmissionInput;
  phase: 'admitted' | 'dispatching' | 'held';
  /** Confirmed recovery deadline remains binding through the final provider-start gate. */
  sourceExpiresAt?: number;
  pending?: Set<Promise<void>>;
}

/** The manager's sole durable admission adapter. Time and Redis state never grant takeover. */
export class GenerationAdmissionCoordinator {
  private config?: GenerationAdmissionConfiguration;
  private closedBy?: string;
  private initializing = 0;
  private writes = 0;
  private uncertain = 0;
  private readonly local = new Map<string, LocalAdmission>();
  private readonly prepared = new Map<
    GenerationPreparationReceipt,
    'ready' | 'creating' | 'spent'
  >();

  configure(config: GenerationAdmissionConfiguration): void {
    if (this.local.size || this.initializing || this.writes || this.prepared.size)
      throw new GenerationAdmissionHeldError();
    this.config = config;
  }

  get required(): boolean {
    return this.config?.required === true;
  }

  close(requestId: string): boolean {
    if (!requestId || (this.closedBy && this.closedBy !== requestId)) return false;
    this.closedBy = requestId;
    return true;
  }

  reopen(requestId: string): boolean {
    if (this.closedBy !== requestId) return false;
    this.closedBy = undefined;
    return true;
  }

  initialize(): () => void {
    if (this.closedBy || (this.required && !this.config?.methods))
      throw new GenerationAdmissionHeldError();
    this.initializing++;
    return () => {
      this.initializing--;
    };
  }

  /** A committed preparation is a durable hold, not permission to repeat its source operation. */
  async prepareCheckpoint(
    principalId: string,
    tenantId: string | undefined,
    conversationId: string,
    binding: GenerationRequestBinding,
    attemptId: string,
    prepare: () => Promise<GenerationCheckpointBinding>,
  ): Promise<GenerationPreparationReceipt> {
    const methods = this.config?.methods;
    if (
      !this.required ||
      !methods?.beginGenerationPreparation ||
      !methods.completeGenerationPreparation ||
      typeof prepare !== 'function'
    )
      throw new GenerationAdmissionHeldError();
    const input = Object.freeze({
      ...binding,
      principalId,
      tenantId: tenant(tenantId),
      conversationId,
      protocol: '2',
      preparationAttemptId: attemptId,
      ownerInstanceId: this.config!.ownerInstanceId,
      processBootId: this.config!.processBootId,
    });
    const done = this.initialize();
    try {
      const begun = await methods.beginGenerationPreparation(input);
      if (!begun.ok) throw new GenerationAdmissionHeldError();
      const continuation = snapshotGenerationCheckpointBinding(await prepare());
      const result = await methods.completeGenerationPreparation(input, continuation);
      if (!result.ok) throw new GenerationAdmissionHeldError();
      const receipt = Object.freeze({ input, continuation });
      this.prepared.set(receipt, 'ready');
      return receipt;
    } catch (error) {
      this.uncertain++;
      throw error;
    } finally {
      done();
    }
  }

  /** Read-only denial gate: a read can preserve a hold but cannot acknowledge preparation. */
  async assertClaimMayChange(
    principalId: string,
    tenantId: string | undefined,
    clientRequestId: string,
  ): Promise<void> {
    if (!this.required) return;
    if (!this.config?.methods) throw new GenerationAdmissionHeldError();
    const result = await this.config.methods.getGenerationAdmission({
      principalId,
      tenantId: tenant(tenantId),
      clientRequestId,
    });
    if (!result.ok) throw new GenerationAdmissionHeldError();
  }

  async verifyReplay(
    principalId: string,
    tenantId: string | undefined,
    binding?: GenerationRequestBinding,
    preparation?: GenerationPreparationReceipt,
    continuation?: GenerationCheckpointBinding,
  ): Promise<void> {
    if (preparation !== undefined) {
      if (
        !this.required ||
        this.prepared.get(preparation) !== 'ready' ||
        preparation.input.principalId !== principalId ||
        preparation.input.tenantId !== tenant(tenantId) ||
        preparation.input.clientRequestId !== binding?.clientRequestId ||
        preparation.input.requestFingerprint !== binding?.requestFingerprint ||
        JSON.stringify(preparation.continuation) !== JSON.stringify(continuation)
      )
        throw new GenerationAdmissionHeldError();
      this.prepared.set(preparation, 'creating');
      return;
    }
    if (!this.required) return;
    if (!binding || !this.config?.methods) throw new GenerationAdmissionHeldError();
    const result = await this.config.methods.getGenerationAdmission({
      tenantId: tenant(tenantId),
      principalId,
      clientRequestId: binding.clientRequestId,
    });
    if (
      !result.ok ||
      (result.value && result.value.requestFingerprint !== binding.requestFingerprint)
    ) {
      throw new GenerationAdmissionHeldError();
    }
  }

  async enroll(
    stream: string,
    epoch: number,
    segment: string,
    principalId: string,
    tenantId: string | undefined,
    conversationId: string,
    protocol: number,
    binding?: GenerationRequestBinding,
    continuation?: GenerationCheckpointBinding,
    preparation?: GenerationPreparationReceipt,
  ): Promise<void> {
    if (!this.required) return;
    if (!binding || !this.config?.methods) throw new GenerationAdmissionHeldError();
    let input: GenerationAdmissionInput = {
      ...binding,
      tenantId: tenant(tenantId),
      principalId,
      conversationId,
      protocol: String(protocol),
      ownerInstanceId: this.config.ownerInstanceId,
      processBootId: this.config.processBootId,
      generationEpoch: epoch,
      segmentId: segment,
      ...(continuation === undefined ? {} : { continuation }),
    };
    if (continuation !== undefined) {
      input = snapshotGenerationCheckpointAdmission(input);
      if (input.continuation!.threadId !== conversationId || stream !== conversationId)
        throw new GenerationAdmissionHeldError();
    }
    const key = localKey(stream, epoch, segment);
    this.local.set(key, { input, phase: 'held' });
    if (
      preparation &&
      (this.prepared.get(preparation) !== 'creating' ||
        preparation.input.conversationId !== conversationId ||
        preparation.input.protocol !== String(protocol))
    )
      throw new GenerationAdmissionHeldError();
    if (preparation) this.prepared.set(preparation, 'spent');
    const result = await this.config.methods.acquireGenerationAdmission(input, preparation?.input);
    if (!result.ok || !result.value.acquired) {
      if (result.ok || result.error.code !== 'OUTCOME_UNKNOWN') this.local.delete(key);
      throw new GenerationAdmissionHeldError();
    }
    this.local.set(key, { input, phase: 'admitted' });
    if (preparation) this.prepared.delete(preparation);
  }

  /**
   * Recover only a proven interrupted checkpoint owner. The acknowledged CAS winner
   * is admitted locally; the existing authorize path still owns provider dispatch.
   */
  async recoverCheckpoint(
    stream: string,
    predecessor: GenerationAdmissionInput,
    successorSegment: string,
    ports: GenerationCheckpointRecoveryPorts,
  ): Promise<GenerationAdmissionRecoveryReceipt | undefined> {
    const config = this.config;
    if (!config?.required || !config.methods || this.closedBy) return undefined;
    let prior: Readonly<GenerationAdmissionInput>;
    let next: Readonly<GenerationAdmissionInput>;
    let callbacks: GenerationCheckpointRecoveryPorts;
    try {
      prior = snapshotGenerationCheckpointAdmission(predecessor);
      next = snapshotGenerationCheckpointAdmission({
        ...prior,
        ownerInstanceId: config.ownerInstanceId,
        processBootId: config.processBootId,
        segmentId: successorSegment,
      });
      callbacks = Object.freeze({
        adoptRecoveredGeneration: ports.adoptRecoveredGeneration,
        authorize: ports.authorize,
        confirmTerminatedOwner: ports.confirmTerminatedOwner,
        reconcileEffects: ports.reconcileEffects,
        ...(ports.recoverSources === undefined ? {} : { recoverSources: ports.recoverSources }),
      });
      if (
        stream !== prior.conversationId ||
        prior.continuation!.threadId !== stream ||
        successorSegment === prior.segmentId ||
        (prior.ownerInstanceId === next.ownerInstanceId &&
          prior.processBootId === next.processBootId) ||
        Object.values(callbacks).some((callback) => typeof callback !== 'function') ||
        (prior.continuation!.sourceBindingSha256 !== undefined &&
          typeof callbacks.recoverSources !== 'function')
      )
        return undefined;
    } catch {
      return undefined;
    }
    const key = localKey(stream, next.generationEpoch, next.segmentId);
    if (this.local.has(key)) return undefined;
    const entry: LocalAdmission = { input: next, phase: 'held' };
    this.local.set(key, entry);
    this.initializing++;
    let retain = false;
    try {
      const terminated = await callbacks.confirmTerminatedOwner(prior);
      if (!terminated || this.closedBy) return undefined;
      const terminationEvidenceSha256 = terminated.terminationEvidenceSha256;
      if (
        JSON.stringify(snapshotGenerationCheckpointAdmission(terminated.predecessor)) !==
          JSON.stringify(prior) ||
        typeof terminationEvidenceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(terminationEvidenceSha256)
      )
        return undefined;
      const effects = await callbacks.reconcileEffects(prior);
      if (!effects || this.closedBy) return undefined;
      const evidence = Object.freeze({
        checkpointWriteRevision: effects.checkpointWriteRevision,
        terminationEvidenceSha256,
        effectsEvidenceSha256: effects.effectsEvidenceSha256,
      });
      if (
        JSON.stringify(snapshotGenerationCheckpointAdmission(effects.predecessor)) !==
          JSON.stringify(prior) ||
        !Number.isSafeInteger(evidence.checkpointWriteRevision) ||
        evidence.checkpointWriteRevision < 0 ||
        typeof evidence.effectsEvidenceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(evidence.effectsEvidenceSha256)
      )
        return undefined;
      // Revalidate access after potentially slow termination/effects reconciliation.
      if ((await callbacks.authorize(prior)) !== true || this.closedBy) return undefined;
      retain = true; // A thrown or unacknowledged CAS must remain an unresolved obligation.
      const result = await config.methods.recoverGenerationAdmission(
        prior,
        evidence,
        {
          ownerInstanceId: next.ownerInstanceId,
          processBootId: next.processBootId,
          segmentId: next.segmentId,
        },
        callbacks.recoverSources,
      );
      if (!result.ok) {
        retain = result.error.code === 'OUTCOME_UNKNOWN';
        return undefined;
      }
      if (
        result.value.admission.state !== 'admitted' ||
        result.value.admission.active !== true ||
        JSON.stringify(snapshotGenerationCheckpointAdmission(result.value.admission)) !==
          JSON.stringify(next)
      )
        return undefined;
      const source = result.value.source;
      if (prior.continuation!.sourceBindingSha256 !== undefined) {
        if (!source) return undefined;
        const binding = snapshotCheckpointSourceBinding(
          source.sourceBinding.owner,
          source.sourceBinding,
        );
        const bindingTenant =
          binding.owner.tenantId && binding.owner.tenantId !== SYSTEM_TENANT_ID
            ? binding.owner.tenantId
            : '__single_tenant__';
        if (
          binding.owner.userId !== next.principalId ||
          bindingTenant !== next.tenantId ||
          binding.bindingSha256 !== prior.continuation!.sourceBindingSha256 ||
          !Number.isSafeInteger(source.expiresAt) ||
          source.expiresAt <= Date.now() ||
          source.expiresAt > Date.parse(binding.expiresAt) ||
          source.checkpoint.threadId !== stream ||
          source.checkpoint.checkpointNs !== '' ||
          typeof source.checkpoint.checkpointId !== 'string' ||
          !source.checkpoint.checkpointId.length
        )
          return undefined;
      } else if (source !== undefined) return undefined;
      if (
        this.closedBy ||
        (await callbacks.adoptRecoveredGeneration(next, source?.expiresAt)) !== true ||
        this.closedBy ||
        (source && source.expiresAt <= Date.now())
      )
        return undefined;
      entry.sourceExpiresAt = source?.expiresAt;
      entry.phase = 'admitted';
      return Object.freeze({
        admission: Object.freeze({ ...result.value.admission, ...next }),
        ...(source ? { source } : {}),
      });
    } catch {
      return undefined;
    } finally {
      this.initializing--;
      if (!retain && this.local.get(key) === entry) this.local.delete(key);
    }
  }

  /** Prepare the existing lazy successor admission before any Redis provider-start mutation. */
  async prepareProviderExecution(
    stream: string,
    epoch: number,
    segment: string,
    principalId: string,
    tenantId: string | undefined,
    conversationId: string,
    successor: boolean,
  ): Promise<boolean> {
    if (!this.required) return !this.closedBy;
    if (this.closedBy || !this.config?.methods) return false;
    const key = localKey(stream, epoch, segment);
    let entry = this.local.get(key);
    if (!entry && successor) {
      this.initializing++;
      try {
        const prior = await this.config.methods.findGenerationAdmissionByEpoch({
          tenantId: tenant(tenantId),
          principalId,
          conversationId,
          generationEpoch: epoch,
        });
        if (!prior.ok || !prior.value?.terminal || prior.value.state !== 'settled') return false;
        this.uncertain++;
        const result = await this.config.methods.acquireGenerationAdmissionSuccessor(
          prior.value,
          prior.value.terminal,
          {
            ownerInstanceId: this.config.ownerInstanceId,
            processBootId: this.config.processBootId,
            segmentId: segment,
          },
        );
        if (!result.ok) {
          if (result.error.code !== 'OUTCOME_UNKNOWN') this.uncertain--;
          return false;
        }
        this.uncertain--;
        entry = { input: result.value, phase: 'admitted' };
        this.local.set(key, entry);
      } finally {
        this.initializing--;
      }
    }
    return (
      !this.closedBy &&
      !!entry &&
      entry.phase === 'admitted' &&
      (entry.sourceExpiresAt == null || entry.sourceExpiresAt > Date.now()) &&
      entry.input.principalId === principalId &&
      entry.input.tenantId === tenant(tenantId) &&
      entry.input.conversationId === conversationId
    );
  }

  canBeginProviderExecution(stream: string, epoch: number, segment: string): boolean {
    const entry = this.local.get(localKey(stream, epoch, segment));
    return (
      !this.closedBy &&
      (!this.required ||
        (!!entry &&
          entry.phase === 'admitted' &&
          (entry.sourceExpiresAt == null || entry.sourceExpiresAt > Date.now())))
    );
  }

  isProviderDispatchReady(stream: string, epoch: number, segment: string): boolean {
    const entry = this.local.get(localKey(stream, epoch, segment));
    return (
      !this.closedBy &&
      (!this.required ||
        (!!entry &&
          entry.phase === 'dispatching' &&
          (entry.sourceExpiresAt == null || entry.sourceExpiresAt > Date.now())))
    );
  }

  /** An uncertain native write/read never becomes a new start permission. */
  holdProviderExecution(stream: string, epoch: number, segment: string): void {
    const entry = this.local.get(localKey(stream, epoch, segment));
    if (entry) entry.phase = 'held';
  }

  async authorize(
    stream: string,
    epoch: number,
    segment: string,
    principalId: string,
    tenantId: string | undefined,
    conversationId: string,
    successor: boolean,
  ): Promise<boolean> {
    if (
      !(await this.prepareProviderExecution(
        stream,
        epoch,
        segment,
        principalId,
        tenantId,
        conversationId,
        successor,
      ))
    )
      return false;
    if (!this.required) return !this.closedBy;
    const entry = this.local.get(localKey(stream, epoch, segment));
    if (!entry || entry.phase !== 'admitted' || !this.config?.methods || this.closedBy)
      return false;
    entry.phase = 'held';
    this.writes++;
    try {
      const result = await this.config.methods.dispatchGenerationAdmission(entry.input);
      if (!result.ok) return false;
      entry.phase = 'dispatching';
      // Preserve acknowledged dispatch for the existing drain/settlement owner.
      return this.isProviderDispatchReady(stream, epoch, segment);
    } finally {
      this.writes--;
    }
  }

  observeWrite<T>(stream: string, epoch: number, segment: string, write: Promise<T>): Promise<T> {
    if (!this.required) return write;
    const entry = this.local.get(localKey(stream, epoch, segment));
    if (!entry) {
      this.uncertain++;
      void write.catch(() => undefined);
      throw new GenerationAdmissionHeldError();
    }
    entry.pending ??= new Set();
    this.writes++;
    const observed = write
      .then(
        () => undefined,
        () => {
          entry.phase = 'held';
        },
      )
      .finally(() => {
        this.writes--;
        entry.pending!.delete(observed);
      });
    entry.pending.add(observed);
    return write;
  }

  async writesSettled(stream: string, epoch: number, segment: string): Promise<boolean> {
    if (!this.required) return true;
    const entry = this.local.get(localKey(stream, epoch, segment));
    if (!entry) return false;
    while (entry.pending?.size) await Promise.all(entry.pending);
    return entry.phase !== 'held';
  }

  async settle(
    stream: string,
    epoch: number,
    segment: string,
    outcome: GenerationAdmissionTerminal['outcome'],
    evidence: string,
  ): Promise<boolean> {
    if (!this.required) return true;
    const key = localKey(stream, epoch, segment);
    const entry = this.local.get(key);
    if (!entry || entry.phase !== 'dispatching' || !this.config?.methods) return false;
    entry.phase = 'held';
    this.writes++;
    try {
      const result = await this.config.methods.settleGenerationAdmission(entry.input, {
        outcome,
        evidenceSha256: createHash('sha256').update(evidence).digest('hex'),
      });
      if (!result.ok) return false;
      this.local.delete(key);
      return true;
    } finally {
      this.writes--;
    }
  }

  async cancel(stream: string, epoch: number, segment: string): Promise<boolean> {
    if (!this.required) return true;
    const key = localKey(stream, epoch, segment);
    const entry = this.local.get(key);
    if (!entry || entry.phase !== 'admitted' || !this.config?.methods) return false;
    entry.phase = 'held';
    this.writes++;
    try {
      const result = await this.config.methods.cancelUndispatchedGenerationAdmission(entry.input);
      if (!result.ok) return false;
      this.local.delete(key);
      return true;
    } finally {
      this.writes--;
    }
  }

  async census(local: {
    providerExecutions: number;
    pendingWrites: number;
    activeStreams: number;
  }): Promise<GenerationAdmissionCensus> {
    const base = {
      admissionClosed: !!this.closedBy,
      initializing: this.initializing,
      ...local,
      queuedContinuations: 0,
      unresolved: this.local.size + this.uncertain,
      complete: false,
    };
    if (!this.required || !this.config?.methods || !this.config.externalCensus) return base;
    try {
      const [durable, external] = await Promise.all([
        this.config.methods.countUnsettledGenerationAdmissions(this.config.ownerInstanceId),
        this.config.externalCensus(),
      ]);
      if (
        !durable.ok ||
        !Number.isSafeInteger(external.queuedContinuations) ||
        external.queuedContinuations < 0 ||
        !Number.isSafeInteger(external.pendingWrites) ||
        external.pendingWrites < 0
      )
        return base;
      return {
        ...base,
        initializing: this.initializing,
        queuedContinuations: external.queuedContinuations,
        pendingWrites: local.pendingWrites + this.writes + external.pendingWrites,
        unresolved: Math.max(durable.value, this.local.size) + this.uncertain,
        complete: external.complete === true,
      };
    } catch {
      return base;
    }
  }
}
