/** File-owned repair walk and snapshot coverage; no quota mutation or completeness attestation. */
import { performance } from 'node:perf_hooks';
import type { ClientSession, Model, mongo } from 'mongoose';
import type {
  DiscoveryPage,
  HousekeepingCoverage,
  HousekeepingHandler,
} from '~/types/housekeeping';
import type { CounterRow, GlobalState } from './uploadManagementStore';
import type { IMongoFile } from '~/types/file';
import { readFileCoverageReceipt } from './fileHousekeepingCoverageContract';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { currentFileDeadline } from './fileSourceAuthority';
import { SYSTEM_TENANT_ID } from '~/config/tenantContext';

type FileHandler = Extract<HousekeepingHandler, 'file.warning' | 'file.cleanup'>;
export interface FileHousekeepingDiscoveryMethods {
  /** EOF concerns the repair walk only; it never certifies complete File/job coverage. */
  discover(handler: FileHandler, cursor: string | null): Promise<DiscoveryPage>;
  /** The caller owns and has already pinned this read-only snapshot session. */
  coverage(
    handler: FileHandler,
    signal: AbortSignal,
    session: ClientSession,
  ): Promise<HousekeepingCoverage>;
}

const PAGE = 32;
const QUERY_MS = 3000;
const SETTLEMENT_MS = 150;
const fields = [
  'user',
  'tenantId',
  'file_id',
  'expiredAt',
  'retentionRevision',
  'retentionActivity',
  'derivedRetention',
  'derivedOrigin',
  'retentionAcceptedAt',
  'retentionRevocationId',
  'deletionRequestedAt',
  'deletionCompletedAt',
] as const;
const projection = Object.fromEntries(fields.map((field) => [field, 1]));
const remaining = (end: number): number => Math.max(1, Math.floor(end - performance.now()));
const unknown = (): HousekeepingCoverage => ({
  expected: null,
  observed: 0,
  recoveryHistory: 'unknown',
});

function assertHandler(handler: FileHandler): void {
  if (handler !== 'file.warning' && handler !== 'file.cleanup')
    throw new Error('Invalid File housekeeping handler');
}

/** Do not initialize legacy identity, generation, history, revocation or retry authority here. */
function classifiable(file: IMongoFile): boolean {
  if (
    !Object.prototype.hasOwnProperty.call(file, 'tenantId') ||
    (file.tenantId !== null &&
      (typeof file.tenantId !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,128}$/.test(file.tenantId) ||
        file.tenantId === SYSTEM_TENANT_ID)) ||
    typeof file.file_id !== 'string' ||
    !/^[a-zA-Z0-9_.:-]{1,256}$/.test(file.file_id) ||
    !/^[a-f0-9]{24}$/.test(String(file.user)) ||
    !Number.isSafeInteger(file.retentionRevision) ||
    file.retentionRevision! < 0 ||
    file.retentionRevision! >= Number.MAX_SAFE_INTEGER ||
    ((file.deletionRequestedAt || file.deletionCompletedAt) && !file.retentionRevocationId)
  )
    return false;
  try {
    return currentFileDeadline(file).migrationEpoch === null;
  } catch {
    return false;
  }
}

export function createFileHousekeepingDiscoveryMethods(
  mongoose: typeof import('mongoose'),
): FileHousekeepingDiscoveryMethods {
  const File = mongoose.models.File as Model<IMongoFile> | undefined;
  if (!File) throw new Error('File housekeeping owner is unavailable');

  async function repair(id: IMongoFile['_id'], end: number): Promise<boolean> {
    const session = File!.db.getClient().startSession();
    try {
      return await session.withTransaction(
        async () => {
          try {
            // eslint-disable-next-line no-restricted-syntax -- Trusted cross-tenant repair rereads the selected _id; its explicit namespace and every private lifecycle field form the write fence below.
            const current = await File!.collection.findOne<IMongoFile>(
              { _id: id },
              { session, projection, maxTimeMS: remaining(end - SETTLEMENT_MS) },
            );
            if (!current || !classifiable(current)) {
              await session.abortTransaction({ timeoutMS: remaining(end) });
              return true;
            }
            // A real owner write fences concurrent activity, migration, revocation and identity.
            const fence = Object.fromEntries(
              fields.map((field) => [
                field,
                current[field] === undefined
                  ? { $exists: false }
                  : { $eq: current[field], $exists: true },
              ]),
            );
            // eslint-disable-next-line no-restricted-syntax -- File-owned CAS includes _id, explicit tenant, owner, revision and the complete selected deadline/revocation state; no tenant middleware inference is permitted.
            const touched = await File!.collection.updateOne(
              { _id: current._id, ...fence },
              { $inc: { retentionRevision: 1 } },
              { session, maxTimeMS: remaining(end - SETTLEMENT_MS) },
            );
            if (touched.matchedCount !== 1) {
              await session.abortTransaction({ timeoutMS: remaining(end) });
              return false;
            }
            await projectFileHousekeeping(mongoose, current, current, session);
            await session.commitTransaction();
            return true;
          } catch {
            // withTransaction's automatic abort refreshes its timeout. End the transaction here
            // using only the shared remainder; never retry an ambiguous commit as a new repair.
            if (session.inTransaction())
              await session.abortTransaction({ timeoutMS: remaining(end) });
            return false;
          }
        },
        {
          timeoutMS: remaining(end - SETTLEMENT_MS),
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        },
      );
    } finally {
      await session.endSession({ timeoutMS: remaining(end) });
    }
  }

  return {
    async discover(handler, cursor) {
      assertHandler(handler);
      if (cursor !== null && (typeof cursor !== 'string' || !/^[a-f0-9]{24}$/.test(cursor)))
        throw new Error('Invalid File housekeeping cursor');
      const end = performance.now() + QUERY_MS;
      let last = cursor;
      let scanned = 0;
      let unresolved = false;
      try {
        // eslint-disable-next-line no-restricted-syntax -- Trusted global File repair selects only bounded _id values; each write rechecks the complete private owner fence.
        const rows = await File.collection
          .find(cursor === null ? {} : { _id: { $gt: new mongoose.Types.ObjectId(cursor) } }, {
            projection: { _id: 1 },
            sort: { _id: 1 },
            hint: '_id_',
            limit: PAGE,
            batchSize: PAGE,
            timeoutMS: remaining(end - SETTLEMENT_MS),
            maxTimeMS: remaining(end - SETTLEMENT_MS),
            timeoutMode: 'cursorLifetime',
          })
          .toArray();
        for (const row of rows) {
          if (
            performance.now() >= end - SETTLEMENT_MS ||
            !(row._id instanceof mongoose.Types.ObjectId)
          )
            return { cursor: last, scanned, complete: false };
          if (!(await repair(row._id, end))) {
            if (performance.now() >= end - SETTLEMENT_MS)
              return { cursor: last, scanned, complete: false };
            // A retained incompatible obligation must not strand later Files. This cursor is only
            // a walk hint: preserve the failed row, report incomplete and revisit it after wrap.
            unresolved = true;
          }
          last = String(row._id);
          scanned++;
        }
        const complete = rows.length < PAGE && !unresolved;
        return { cursor: complete ? null : last, scanned, complete };
      } catch {
        return { cursor: last, scanned, complete: false };
      }
    },

    async coverage(handler, signal, session) {
      assertHandler(handler);
      if (signal.aborted || !session.snapshotEnabled || session.hasEnded) return unknown();
      const Counter = mongoose.models.UploadCounter as Model<CounterRow> | undefined;
      if (!Counter) return unknown();
      try {
        const collection = Counter.collection as unknown as mongo.Collection<CounterRow>;
        const row = await collection.findOne(
          { _id: 'global' },
          {
            session,
            signal,
            projection: {
              revision: 1,
              'value.storeId': 1,
              'value.fileHousekeepingCoverage': 1,
              'value.migration': 1,
              'value.migrationEpoch': 1,
            },
            maxTimeMS: QUERY_MS,
            timeoutMS: QUERY_MS,
          },
        );
        const value = row?.value as Partial<GlobalState> | undefined;
        if (
          signal.aborted ||
          !row ||
          !Number.isSafeInteger(row.revision) ||
          row.revision < 0 ||
          typeof value?.storeId !== 'string' ||
          !value.storeId ||
          value.storeId.length > 256
        )
          return unknown();
        const state = value.fileHousekeepingCoverage;
        const receipt =
          state?.phase === 'sealed' && !value.migration && !value.migrationEpoch
            ? readFileCoverageReceipt(state.receipt, value.storeId)
            : null;
        const complete =
          !!receipt &&
          receipt.generation === state?.generation &&
          state?.phase === 'sealed' &&
          receipt.runSha256 === state.runSha256;
        // Same pinned snapshot as counts. Shapes/hashes alone never authorize producing this seal;
        // the administrative mutation port remains unavailable without its actual native adapter.
        return { expected: complete ? 1 : null, observed: 1, recoveryHistory: 'unknown' };
      } catch {
        return unknown();
      }
    },
  };
}
