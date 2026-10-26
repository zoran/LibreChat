/** Same-transaction Upload projections owned by File activity and retention migration. */
import type { ClientSession } from 'mongoose';
import type { StoredUpload } from './uploadManagementState';
import { hasValidUploadPublicationTime, principalFilter } from './uploadManagementStore';
import { projectUploadHousekeeping } from './uploadHousekeepingProjection';
import { reject, storedUploadPrincipal } from './uploadManagementState';

/** Same-transaction projection only: lifecycle, immutable admission and all quota debits stay intact. */
export async function mirrorFileActivityDeadline(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  nextDeadline: number,
  session: ClientSession,
  intent: 'original-activity' | 'derived-projection' = 'original-activity',
): Promise<void> {
  if (
    !session.inTransaction() ||
    row.fileId !== row._id ||
    !Number.isSafeInteger(nextDeadline) ||
    !Number.isSafeInteger(row.expiresAt) ||
    nextDeadline <= Date.now() ||
    (intent === 'original-activity'
      ? row.state !== 'ready' ||
        row.derivedOrigin !== undefined ||
        !hasValidUploadPublicationTime(row) ||
        typeof row.publishedDigest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(row.publishedDigest) ||
        nextDeadline !== row.expiresAt! + 7 * 86400000
      : !['queued_processing', 'processing', 'ready', 'failed'].includes(row.state) ||
        row.derivedOrigin === undefined ||
        nextDeadline < row.expiresAt!)
  )
    reject('unavailable');
  const result = await mongoose.models.UploadOperation.updateOne(
    {
      _id: row._id,
      ...principalFilter(storedUploadPrincipal(row)),
      state: row.state,
      revision: row.revision,
      fileId: row.fileId,
      acceptedAt: row.acceptedAt,
      expiresAt: row.expiresAt,
      generation: row.generation,
      attemptGeneration: row.attemptGeneration,
      ...(intent === 'original-activity'
        ? { publishedDigest: row.publishedDigest, derivedOrigin: { $exists: false } }
        : { derivedOrigin: row.derivedOrigin }),
    },
    { $set: { expiresAt: nextDeadline }, $inc: { revision: 1 } },
    { session },
  );
  if (!result.acknowledged || result.matchedCount !== 1) reject('unavailable');
  await projectUploadHousekeeping(
    mongoose,
    row,
    { ...row, expiresAt: nextDeadline, revision: row.revision + 1 },
    session,
  );
}

/** Migration alone may upgrade frozen origin provenance or reduce an inconsistent legacy cap. */
export async function mirrorFileRetentionMigration(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  previousExpiry: number,
  previousOrigin: StoredUpload['derivedOrigin'],
  session: ClientSession,
): Promise<void> {
  if (
    !session.inTransaction() ||
    !Number.isSafeInteger(row.expiresAt) ||
    row.expiresAt! > previousExpiry
  )
    reject('migration_conflict');
  if (
    row.expiresAt === previousExpiry &&
    JSON.stringify(previousOrigin) === JSON.stringify(row.derivedOrigin)
  )
    return;
  const previous = { ...row, expiresAt: previousExpiry, derivedOrigin: previousOrigin };
  const changed = await mongoose.models.UploadOperation.updateOne(
    {
      _id: row._id,
      ...principalFilter(storedUploadPrincipal(row)),
      revision: row.revision,
      expiresAt: previousExpiry,
      ...(previousOrigin === undefined
        ? { derivedOrigin: { $exists: false } }
        : { derivedOrigin: previousOrigin }),
    },
    {
      $set: {
        expiresAt: row.expiresAt,
        ...(row.derivedOrigin === undefined ? {} : { derivedOrigin: row.derivedOrigin }),
      },
      $inc: { revision: 1 },
    },
    { session },
  );
  if (changed.matchedCount !== 1) reject('migration_conflict');
  row.revision++;
  await projectUploadHousekeeping(mongoose, previous, row, session);
}
