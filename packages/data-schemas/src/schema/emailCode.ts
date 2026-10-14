import { Schema } from 'mongoose';
import type { EmailCodeChallenge } from '~/types/emailCode';

export const emailCodeChallengeSchema = new Schema<EmailCodeChallenge>(
  {
    _id: { type: String, required: true },
    tenantId: { type: String, required: true },
    email: { type: String, required: true },
    mailboxKey: { type: String, required: true },
    nonceHash: { type: String, required: true },
    generation: { type: Number, required: true },
    verifier: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    resendAt: { type: Date, required: true },
    accepted: { type: Boolean, required: true, default: false },
    failures: { type: Number, required: true, default: 0 },
    consumedAt: { type: Date },
  },
  { versionKey: false },
);
emailCodeChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
emailCodeChallengeSchema.index({ tenantId: 1, mailboxKey: 1 });

/** Bounded rolling counters, owned only by auth admission; never a public tenant collection. */
export const emailCodeBudgetSchema = new Schema(
  {
    _id: { type: String, required: true },
    sends: { type: [Number], default: [] },
    failures: { type: [Number], default: [] },
    requests: { type: [Number], default: [] },
    active: { type: [{ _id: false, key: String, expiresAt: Number }], default: [] },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);
emailCodeBudgetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
