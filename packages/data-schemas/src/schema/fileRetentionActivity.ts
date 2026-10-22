/** Private bounded File history, deliberately absent from ordinary File projections. */
import { Schema } from 'mongoose';
import type { StoredFileRetentionActivity } from '~/types/fileActivity';

const count = { type: Number, required: true, min: 0, validate: Number.isSafeInteger };
export const fileRetentionActivitySchema: Schema<StoredFileRetentionActivity> =
  new Schema<StoredFileRetentionActivity>(
    {
      version: { type: Number, required: true, enum: [1] },
      baselineDeadlineAt: { type: Date, required: true },
      trackedSince: { type: Date, required: true },
      historyConfidence: { type: String, required: true, enum: ['complete', 'since-tracking'] },
      readCount: count,
      processingCount: count,
      lastSuccessfulReadAt: Date,
      lastSuccessfulProcessingAt: Date,
      deadlineGeneration: count,
      migrationEpoch: { type: String, maxlength: 128 },
    },
    { _id: false, strict: 'throw' },
  );
