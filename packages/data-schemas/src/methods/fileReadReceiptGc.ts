/** Private File housekeeping: expired capabilities close before their evidence is reclaimed. */
import type { StoredFileReadReceipt } from '~/types/fileActivity';
import type { FileActivityStore } from './fileActivityStore';

export async function pruneExpiredFileReadReceipts(
  store: FileActivityStore,
  limit = 100,
): Promise<{
  removed: number;
  unknown: number;
}> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Invalid read receipt batch');
  const candidates = await store.Receipt.find({ notAfter: { $lte: new Date() } })
    .select('_id')
    .sort({ notAfter: 1, _id: 1 })
    .limit(limit)
    .readConcern('majority')
    .maxTimeMS(1000)
    .lean<{ _id: string }[]>();
  let removed = 0,
    unknown = 0;
  for (const candidate of candidates) {
    try {
      removed += await store.transaction(Date.now() + 1000, async (session) => {
        const row = await store.Receipt.findById(candidate._id)
          .session(session)
          .maxTimeMS(1000)
          .lean<StoredFileReadReceipt>();
        if (!row || row.notAfter.getTime() > Date.now()) return 0;
        // The same-row write conflicts with any still-unresolved completion transaction. The
        // snapshot's completed/incomplete outcome is therefore resolved before the delete commits.
        const result = await store.Receipt.updateOne(
          {
            _id: row._id,
            fence: row.fence,
            notAfter: row.notAfter,
            $expr: { $lte: ['$notAfter', '$$NOW'] },
          },
          { $inc: { fence: 1 }, $unset: { claim: '' } },
          { session },
        );
        if (result.matchedCount !== 1) throw new Error('Read receipt fence changed');
        const deleted = await store.Receipt.deleteOne(
          { _id: row._id, fence: row.fence + 1 },
          { session },
        );
        if (deleted.deletedCount !== 1) throw new Error('Read receipt settlement unknown');
        return 1;
      });
    } catch {
      unknown++;
    }
  }
  return { removed, unknown };
}
