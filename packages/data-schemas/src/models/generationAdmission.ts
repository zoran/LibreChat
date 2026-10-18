import type { Model } from 'mongoose';
import type { GenerationAdmissionStorageRecord } from '~/types/generationAdmission';
import generationAdmissionSchema from '~/schema/generationAdmission';

/** Connection-injected registration; no ambient database or process-global admission owner. */
export function createGenerationAdmissionModel(
  mongoose: typeof import('mongoose'),
): Model<GenerationAdmissionStorageRecord> {
  return (
    mongoose.models.GenerationAdmission ||
    mongoose.model<GenerationAdmissionStorageRecord>(
      'GenerationAdmission',
      generationAdmissionSchema,
    )
  );
}
