import { Schema } from 'mongoose';
import type { PlatformAdminPolicy } from '~/types/platformAdminPolicy';

/** Global control-plane lifecycle; never apply the tenant isolation plugin. */
const platformAdminPolicySchema: Schema<PlatformAdminPolicy> = new Schema<PlatformAdminPolicy>(
  {
    _id: { type: String, enum: ['configured-platform-administrators'], required: true },
    revision: { type: Number, required: true, min: 1 },
    digest: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    tenantId: { type: String, required: true },
    emails: { type: [String], required: true },
    writeSequence: { type: Number, required: true, min: 1 },
  },
  { versionKey: false },
);

export default platformAdminPolicySchema;
