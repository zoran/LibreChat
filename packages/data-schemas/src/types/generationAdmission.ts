import type { ClientSession } from 'mongoose';
import type { CheckpointSourceBinding } from './checkpointSource';

/** Immutable native checkpoint identity, acquired before the first provider dispatch. */
export interface GenerationCheckpointBinding {
  readonly version: 1;
  readonly runId: string;
  readonly threadId: string;
  readonly checkpointNamespace: string;
  readonly graphFingerprint: string;
  readonly policyFingerprint: string;
  readonly mode: 'checkpoint-only-v1';
  /** Identity binding only; does not authorize document access or enable source processing. */
  readonly sourceBindingSha256?: string;
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

/** Exact server attempt held before source mutation; no provider epoch exists yet. */
export interface GenerationPreparationInput extends GenerationAdmissionKey {
  conversationId: string;
  requestFingerprint: string;
  protocol: string;
  ownerInstanceId: string;
  processBootId: string;
  preparationAttemptId: string;
}

/** A held preparation is never an admission receipt, including after a lost completion reply. */
export interface GenerationPreparationRecord extends GenerationPreparationInput {
  state: 'preparing' | 'prepared';
  active: true;
  createdAt: string;
  continuation?: GenerationCheckpointBinding;
}

export type GenerationAdmissionStorageRecord =
  | GenerationAdmissionRecord
  | GenerationPreparationRecord;

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

/** Private metadata selection; neither this candidate nor its digest grants source access. */
export interface GenerationCheckpointRecoverySource {
  readonly sourceBinding: CheckpointSourceBinding;
  readonly checkpoint: {
    readonly threadId: string;
    readonly checkpointId: string;
    readonly checkpointNs: '';
  };
  readonly expiresAt: number;
}
export type GenerationCheckpointSourceRecovery = (
  predecessor: Readonly<GenerationAdmissionInput>,
  session: ClientSession,
) => Promise<GenerationCheckpointRecoverySource>;

/** Released only after the recovery transaction and session have completed. */
export interface GenerationAdmissionRecoveryReceipt {
  readonly admission: GenerationAdmissionRecord;
  readonly source?: GenerationCheckpointRecoverySource;
}

export interface GenerationAdmissionMethods {
  /** Optional on hosts that have not composed preparation; neither port grants dispatch. */
  beginGenerationPreparation?(
    input: GenerationPreparationInput,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>>;
  completeGenerationPreparation?(
    input: GenerationPreparationInput,
    continuation: GenerationCheckpointBinding,
  ): Promise<GenerationAdmissionResult<GenerationPreparationRecord>>;
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
    preparation?: GenerationPreparationInput,
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
    recoverSources?: GenerationCheckpointSourceRecovery,
  ): Promise<GenerationAdmissionResult<GenerationAdmissionRecoveryReceipt>>;
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
