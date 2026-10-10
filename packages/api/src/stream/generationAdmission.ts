import { createHash } from 'node:crypto';
import { SYSTEM_TENANT_ID } from '@librechat/data-schemas';
import type { GenerationAdmissionInput, GenerationAdmissionMethods } from '@librechat/data-schemas';
import type { ExternalApplicationWorkCensus } from '~/app';

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
  configure(config: GenerationAdmissionConfiguration): void {
    if (this.local.size || this.initializing || this.writes)
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

  async verifyReplay(
    principalId: string,
    tenantId: string | undefined,
    binding?: GenerationRequestBinding,
  ): Promise<void> {
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
  ): Promise<void> {
    if (!this.required) return;
    if (!binding || !this.config?.methods) throw new GenerationAdmissionHeldError();
    const input: GenerationAdmissionInput = {
      ...binding,
      tenantId: tenant(tenantId),
      principalId,
      conversationId,
      protocol: String(protocol),
      ownerInstanceId: this.config.ownerInstanceId,
      processBootId: this.config.processBootId,
      generationEpoch: epoch,
      segmentId: segment,
    };
    const key = localKey(stream, epoch, segment);
    this.local.set(key, { input, phase: 'held' });
    const result = await this.config.methods.acquireGenerationAdmission(input);
    if (!result.ok || !result.value.acquired) {
      if (result.ok || result.error.code !== 'OUTCOME_UNKNOWN') this.local.delete(key);
      throw new GenerationAdmissionHeldError();
    }
    this.local.set(key, { input, phase: 'admitted' });
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
    if (!entry || entry.phase !== 'admitted') return false;
    entry.phase = 'held';
    this.writes++;
    try {
      const result = await this.config.methods.dispatchGenerationAdmission(entry.input);
      if (!result.ok) return false;
      entry.phase = 'dispatching';
      return true;
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

  async settle(stream: string, epoch: number, segment: string, evidence: string): Promise<boolean> {
    if (!this.required) return true;
    const key = localKey(stream, epoch, segment);
    const entry = this.local.get(key);
    if (!entry || entry.phase !== 'dispatching' || !this.config?.methods) return false;
    entry.phase = 'held';
    this.writes++;
    try {
      const result = await this.config.methods.settleGenerationAdmission(entry.input, {
        outcome: 'completed',
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
