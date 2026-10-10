import type { Model } from 'mongoose';
import type { GenerationAdmissionRecord } from '~/types/generationAdmission';
import generationAdmissionSchema from '~/schema/generationAdmission';

/** Connection-injected registration; no ambient database or process-global admission owner. */
export function createGenerationAdmissionModel(
  mongoose: typeof import('mongoose'),
): Model<GenerationAdmissionRecord> {
  return (
    mongoose.models.GenerationAdmission ||
    mongoose.model<GenerationAdmissionRecord>('GenerationAdmission', generationAdmissionSchema)
  );
}
