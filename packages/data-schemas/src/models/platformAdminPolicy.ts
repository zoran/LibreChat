import type { Model } from 'mongoose';
import type { PlatformAdminPolicy } from '~/types/platformAdminPolicy';
import platformAdminPolicySchema from '~/schema/platformAdminPolicy';

/** Global control-plane revision fence; intentionally has no tenant-isolation plugin. */
export function createPlatformAdminPolicyModel(
  mongoose: typeof import('mongoose'),
): Model<PlatformAdminPolicy> {
  return (
    mongoose.models.PlatformAdminPolicy ||
    mongoose.model<PlatformAdminPolicy>('PlatformAdminPolicy', platformAdminPolicySchema)
  );
}
