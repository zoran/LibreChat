/** Finite File read capability evidence; ordinary indexed GC must fence before deleting. */
import { Schema } from 'mongoose';
import type { StoredFileReadReceipt } from '~/types/fileActivity';

const digest = { type: String, required: true, match: /^[a-f0-9]{64}$/ };
const count = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
const identity = { type: String, required: true, maxlength: 128 };
const claim = new Schema(
  {
    claimId: identity,
    fence: count,
    worker: { hostId: identity, instanceId: identity },
    leaseUntil: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);
const completion = new Schema(
  {
    claimId: identity,
    fence: count,
    completedAt: { type: Date, required: true },
    contentSha256: digest,
    verifiedBytes: count,
    deadlineGeneration: count,
    deadlineAt: { type: Date, required: true },
  },
  { _id: false, strict: 'throw' },
);
const schema: Schema<StoredFileReadReceipt> = new Schema<StoredFileReadReceipt>(
  {
    _id: digest,
    version: { type: Number, required: true, enum: [1] },
    tenantId: { type: String, default: null, maxlength: 128 },
    userId: identity,
    fileId: identity,
    representation: { type: String, required: true, enum: ['original', 'preview'] },
    admittedAt: { type: Date, required: true },
    notAfter: { type: Date, required: true },
    sourceBindingSha256: digest,
    originalSha256: digest,
    originalBytes: count,
    fence: count,
    claim: { type: claim, default: undefined },
    completion: { type: completion, default: undefined },
  },
  { strict: 'throw', versionKey: false },
);
schema.index({ notAfter: 1 }); // No TTL: deleting a live/uncertain claim would erase its fence.
schema.index({ tenantId: 1, userId: 1, fileId: 1 });
export default schema;
