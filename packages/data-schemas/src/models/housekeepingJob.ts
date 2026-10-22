/** Internal execution metadata only. Cross-tenant discovery is restricted to trusted composition. */
import { HOUSEKEEPING_HANDLERS } from 'librechat-data-provider';
import type { Model } from 'mongoose';
import type {
  HousekeepingWork,
  JobState,
  JobPhase,
  JobCode,
  WorkerIdentity,
} from '../types/housekeeping';

export interface HousekeepingJobRecord {
  _id: string;
  version: 1;
  identityHash: string;
  handler: HousekeepingWork['handler'];
  work: HousekeepingWork;
  subjectId: string;
  generation: number;
  dueAt: Date;
  nextAttemptAt: Date;
  /** Repository retry floor; undefined is unclassified legacy data, never an inferred null. */
  retryNotBefore?: Date | null;
  state: JobState;
  fence: number;
  progressRevision: number;
  attempts: number;
  recoveries: number;
  lastRecoveryAt: Date | null;
  claim: { worker: WorkerIdentity; claimId: string; leaseUntil: Date } | null;
  execution: { id: string; phase: JobPhase; receiptRef: string | null };
  lastCode: JobCode;
  createdAt: Date;
  updatedAt: Date;
  terminalAt: Date | null;
}

export const HOUSEKEEPING_INDEXES: Readonly<
  Record<'identity' | 'due' | 'expired' | 'owner' | 'terminal', string>
> = Object.freeze({
  identity: 'housekeeping_identity',
  due: 'housekeeping_due',
  expired: 'housekeeping_expired',
  owner: 'housekeeping_owner',
  terminal: 'housekeeping_terminal',
});

/** No TTL: unresolved or current-generation effects can never age out implicitly. */
export function createHousekeepingJobModel(
  mongoose: typeof import('mongoose'),
): Model<HousekeepingJobRecord> {
  if (mongoose.models.HousekeepingJob) return mongoose.models.HousekeepingJob;
  const counter = { type: Number, required: true, min: 0, max: Number.MAX_SAFE_INTEGER };
  const schema = new mongoose.Schema<HousekeepingJobRecord>(
    {
      _id: { type: String, required: true },
      version: { type: Number, required: true, enum: [1] },
      identityHash: { type: String, required: true, maxlength: 64 },
      handler: { type: String, required: true, enum: HOUSEKEEPING_HANDLERS },
      work: { type: mongoose.Schema.Types.Mixed, required: true },
      subjectId: { type: String, required: true, maxlength: 256 },
      generation: counter,
      dueAt: { type: Date, required: true },
      nextAttemptAt: { type: Date, required: true },
      // No default: reading a legacy row must not manufacture absence of backoff.
      retryNotBefore: { type: Date },
      state: {
        type: String,
        required: true,
        enum: ['queued', 'claimed', 'waiting', 'unknown', 'settled', 'superseded', 'missed'],
      },
      fence: counter,
      progressRevision: counter,
      attempts: counter,
      recoveries: counter,
      lastRecoveryAt: { type: Date, default: null },
      claim: { type: mongoose.Schema.Types.Mixed, default: null },
      execution: { type: mongoose.Schema.Types.Mixed, required: true },
      lastCode: { type: String, required: true, maxlength: 64 },
      createdAt: { type: Date, required: true },
      updatedAt: { type: Date, required: true },
      terminalAt: { type: Date, default: null },
    },
    { versionKey: false, strict: 'throw', collection: 'housekeeping_jobs' },
  );
  schema.index({ identityHash: 1 }, { unique: true, name: HOUSEKEEPING_INDEXES.identity });
  schema.index(
    { handler: 1, state: 1, nextAttemptAt: 1, _id: 1 },
    { name: HOUSEKEEPING_INDEXES.due },
  );
  schema.index(
    { handler: 1, state: 1, 'claim.leaseUntil': 1, _id: 1 },
    { name: HOUSEKEEPING_INDEXES.expired },
  );
  schema.index(
    {
      handler: 1,
      'work.subject.tenantId': 1,
      'work.subject.ownerUserId': 1,
      subjectId: 1,
      generation: 1,
    },
    { name: HOUSEKEEPING_INDEXES.owner },
  );
  schema.index({ state: 1, terminalAt: 1, _id: 1 }, { name: HOUSEKEEPING_INDEXES.terminal });
  return mongoose.model<HousekeepingJobRecord>('HousekeepingJob', schema);
}
