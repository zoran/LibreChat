/** File owns this short-lived logical-read receipt, never a generic scheduler/event store. */
import type { Model } from 'mongoose';
import type { StoredFileReadReceipt } from '~/types/fileActivity';
import schema from '~/schema/fileReadReceipt';

export function createFileReadReceiptModel(
  mongoose: typeof import('mongoose'),
): Model<StoredFileReadReceipt> {
  return (
    mongoose.models.FileReadReceipt ||
    mongoose.model<StoredFileReadReceipt>('FileReadReceipt', schema)
  );
}
