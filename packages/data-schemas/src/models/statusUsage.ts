import type { Model } from 'mongoose';
import type { StatusUsageReceipt, StatusUsageBucket } from '../types/statusUsage';
import { statusUsageReceiptSchema, statusUsageBucketSchema } from '../schema/statusUsage';
import { applyTenantIsolation } from '~/models/plugins/tenantIsolation';

export function createStatusUsageModels(mongoose: typeof import('mongoose')) {
  applyTenantIsolation(statusUsageReceiptSchema);
  applyTenantIsolation(statusUsageBucketSchema);
  return {
    Receipt: (mongoose.models.StatusUsageReceipt ??
      mongoose.model('StatusUsageReceipt', statusUsageReceiptSchema)) as Model<StatusUsageReceipt>,
    Bucket: (mongoose.models.StatusUsageBucket ??
      mongoose.model('StatusUsageBucket', statusUsageBucketSchema)) as Model<StatusUsageBucket>,
  };
}
