import type { ClientSession } from 'mongoose';

/** Immutable native checkpoint identity, acquired before the first provider dispatch. */
export interface GenerationCheckpointBinding {
  readonly version: 1;
  readonly runId: string;
  readonly threadId: string;
  readonly checkpointNamespace: string;
  readonly graphFingerprint: string;
  readonly policyFingerprint: string;
  readonly mode: 'checkpoint-only-v1';
}

/** Trusted server identity. Callers must never populate scope from unverified request-body fields. */
export interface GenerationAdmissionKey {
  tenantId: string;
  principalId: string;
  clientRequestId: string;
}

/** Immutable fence for exactly one provider segment; neither time nor Redis loss replaces it. */
export interface GenerationAdmissionInput extends GenerationAdmissionKey {
  conversationId: string;
  requestFingerprint: string;
  protocol: string;
  ownerInstanceId: string;
  processBootId: string;
  generationEpoch: number;
  segmentId: string;
  continuation?: GenerationCheckpointBinding;
}

export interface GenerationAdmissionTerminal {
  outcome: 'completed' | 'failed' | 'cancelled';
  evidenceSha256: string;
}

/** Immutable completed segment retained when a settled request explicitly resumes. */
export interface GenerationAdmissionPredecessor {
  ownerInstanceId: string;
  processBootId: string;
  segmentId: string;
  dispatchedAt: string;
  settledAt: string;
  terminal: GenerationAdmissionTerminal;
}

export interface GenerationAdmissionSuccessor {
  ownerInstanceId: string;
  processBootId: string;
  segmentId: string;
}

/** Server-owned proof references; neither timestamps nor an expired lease authorize recovery. */
export interface GenerationCheckpointRecoveryEvidence {
  checkpointWriteRevision: number;
  terminationEvidenceSha256: string;
  effectsEvidenceSha256: string;
}

/** Interrupted ownership is retained separately from genuinely settled HITL predecessors. */
export interface GenerationAdmissionRecovery extends GenerationAdmissionSuccessor {
  dispatchedAt: string;
  recoveredAt: string;
  evidence: GenerationCheckpointRecoveryEvidence;
}

/** Plain durable receipt, without database documents or provider/stream contents. */
export interface GenerationAdmissionRecord extends GenerationAdmissionInput {
  state: 'admitted' | 'dispatching' | 'settled';
  active: boolean;
  createdAt: string;
  dispatchedAt?: string;
  settledAt?: string;
  terminal?: GenerationAdmissionTerminal;
  predecessors?: GenerationAdmissionPredecessor[];
  checkpointWriteRevision: number;
  recoveries?: GenerationAdmissionRecovery[];
}

export type GenerationAdmissionFailureCode =
  | 'INVALID_INPUT'
  | 'REQUEST_CONFLICT'
  | 'CONVERSATION_ACTIVE'
  | 'HELD'
  | 'OUTCOME_UNKNOWN';

export type GenerationAdmissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: GenerationAdmissionFailureCode } };

export interface GenerationAdmissionMethods {
  ensureGenerationAdmissionIndexes(): Promise<void>;
  cancelUndispatchedGenerationAdmission(
    input: GenerationAdmissionInput,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
  findGenerationAdmissionByEpoch(input: {
    tenantId: string;
    principalId: string;
    conversationId: string;
    generationEpoch: number;
  }): Promise<GenerationAdmissionResult<GenerationAdmissionRecord | null>>;
  countUnsettledGenerationAdmissions(
    ownerInstanceId: string,
  ): Promise<GenerationAdmissionResult<number>>;
  acquireGenerationAdmission(
    input: GenerationAdmissionInput,
  ): Promise<GenerationAdmissionResult<{ acquired: boolean; record: GenerationAdmissionRecord }>>;
  getGenerationAdmission(
    key: GenerationAdmissionKey,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord | null>>;
  /** Only ok:true authorizes this invocation to dispatch; never infer authorization from a read. */
  dispatchGenerationAdmission(
    input: GenerationAdmissionInput,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
  /** Only the acknowledged CAS winner may subsequently authorize the successor's dispatch. */
  recoverGenerationAdmission(
    predecessor: GenerationAdmissionInput,
    evidence: GenerationCheckpointRecoveryEvidence,
    successor: GenerationAdmissionSuccessor,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
  /** Database-only callback, using this exact session/client; external effects are forbidden. */
  writeGenerationCheckpoint<T>(
    input: GenerationAdmissionInput,
    write: (session: ClientSession) => Promise<T>,
  ): Promise<GenerationAdmissionResult<T>>;
  /** Explicit HITL continuation only; exact settled predecessor evidence is mandatory. */
  acquireGenerationAdmissionSuccessor(
    predecessor: GenerationAdmissionInput,
    terminal: GenerationAdmissionTerminal,
    successor: GenerationAdmissionSuccessor,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
  /** Caller proves provider, title/history and trailing writes settled before calling this port. */
  settleGenerationAdmission(
    input: GenerationAdmissionInput,
    terminal: GenerationAdmissionTerminal,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecord>>;
}
