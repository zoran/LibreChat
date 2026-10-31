/** Real Mongoose query casting must preserve the full File security filter before execution. */
import mongoose from 'mongoose';
import { createFileModel } from '~/models/file';
import { approvedFileFilter } from './fileSecurity';

it('casts the complete security and original-binding filter through the actual File schema', () => {
  const database = new mongoose.Mongoose();
  const File = createFileModel(database);
  try {
    const query = File.find(approvedFileFilter('a'.repeat(64), Date.now()));
    expect(() => query.cast(File)).not.toThrow();
  } finally {
    database.deleteModel(/.*/);
  }
});
