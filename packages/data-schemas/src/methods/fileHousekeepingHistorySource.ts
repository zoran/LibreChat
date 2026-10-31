/** Actual Mongo catalog and bounded raw observation; never infer an empty source from missing metadata. */
import type { FileHistoryCursor } from 'librechat-data-provider';
import type { ClientSession, mongo } from 'mongoose';
import type { MongoHistoryLeaf } from './fileHousekeepingMongoHistory';
import type { HousekeepingJobRecord } from '../models/housekeepingJob';
import type { MongoHistoryScope } from './fileHousekeepingHistory';
import type { UploadStore } from './uploadManagementStore';
import type { IMongoFile } from '../types/file';
import { observeCompleteUpload, UploadHistoryObservationError } from './uploadManagementHistory';
import { prepareStandaloneFileCoverage } from './fileRetentionMigration';
import { mongoHistoryLeaf } from './fileHousekeepingMongoHistory';
import { createHousekeepingStore } from './housekeepingStore';
import { FileHistoryError } from './fileHousekeepingHistory';

type Options = (session: ClientSession, end: number, signal: AbortSignal) => mongo.AggregateOptions;
type FileHistorySource = {
  scopes(
    storeId: string,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<MongoHistoryScope[]>;
  observe(
    scope: MongoHistoryScope,
    cursor: FileHistoryCursor,
    repair: boolean,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
    fileKnown: (file: IMongoFile) => Promise<'retained' | 'excluded' | 'unknown'>,
    jobKnown: (job: HousekeepingJobRecord) => Promise<boolean>,
    repairClock: Date,
  ): Promise<MongoHistoryLeaf | null>;
};
export function createFileHistorySource(store: UploadStore, options: Options): FileHistorySource {
  const { mongoose, Operation } = store;
  const files = mongoose.models.File.collection as unknown as mongo.Collection<IMongoFile>;
  const jobs = createHousekeepingStore(mongoose).model
    .collection as unknown as mongo.Collection<HousekeepingJobRecord>;
  const names = {
    files: files.collectionName,
    'file-jobs': jobs.collectionName,
    // eslint-disable-next-line no-restricted-syntax -- Read actual Mongoose collection-name metadata for the held source identity.
    uploads: Operation.collection.name,
  };
  async function scopes(
    storeId: string,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<MongoHistoryScope[]> {
    const db = mongoose.connection.db;
    if (!db) throw new FileHistoryError('unavailable');
    const result: MongoHistoryScope[] = [];
    for (const collection of ['files', 'file-jobs', 'uploads'] as const) {
      const cursor = db.listCollections(
        { name: names[collection] },
        { ...options(session, end, signal), nameOnly: false },
      );
      try {
        const first = await cursor.next(),
          extra = await cursor.next(),
          uuid = first?.info?.uuid;
        if (
          !first ||
          extra ||
          first.type !== 'collection' ||
          uuid?._bsontype !== 'Binary' ||
          uuid.sub_type !== 4 ||
          uuid.buffer.byteLength !== 16
        )
          throw new FileHistoryError('source_changed');
        result.push({
          kind: 'mongo',
          storeId,
          collection,
          collectionUuid: uuid.toUUID().toHexString(),
        });
      } finally {
        await cursor.close();
      }
    }
    return result;
  }
  async function raw(
    scope: MongoHistoryScope,
    cursor: FileHistoryCursor,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    if (
      cursor !== null &&
      (cursor.kind !== 'mongo-id' ||
        cursor.idType !== (scope.collection === 'files' ? 'object-id' : 'string'))
    )
      throw new FileHistoryError('invalid_input');
    if (scope.collection === 'uploads') {
      try {
        const observed = await observeCompleteUpload(
          Operation,
          cursor?.value ?? null,
          session,
          end,
          signal,
        );
        return observed.outcome === 'eof' ? null : observed.completeUpload;
      } catch (error) {
        if (error instanceof UploadHistoryObservationError) throw new FileHistoryError(error.code);
        throw error;
      }
    }
    let value: mongo.ObjectId | string | null = null;
    if (cursor !== null) {
      if (cursor.idType === 'object-id') value = new mongoose.Types.ObjectId(cursor.value);
      else value = cursor.value;
    }
    const collection = (scope.collection === 'files' ? files : jobs) as unknown as mongo.Collection;
    const original = collection.aggregate<{ row: Record<string, unknown> | null }>(
      [
        ...(cursor === null ? [] : [{ $match: { $expr: { $gt: ['$_id', { $literal: value }] } } }]),
        { $sort: { _id: 1 } },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            row: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, 60 * 1024] }, '$$ROOT', null] },
          },
        },
      ],
      {
        ...options(session, end, signal),
        hint: '_id_',
        collation: { locale: 'simple' },
        batchSize: 1,
      },
    );
    try {
      const observed = await original.next();
      if (!observed) return null;
      if (!observed.row) throw new FileHistoryError('capacity');
      if (
        scope.collection === 'files'
          ? !(observed.row._id instanceof mongoose.Types.ObjectId)
          : typeof observed.row._id !== 'string'
      )
        throw new FileHistoryError('unclassified');
      return observed.row;
    } finally {
      await original.close();
    }
  }
  async function lookup(
    collection: mongo.Collection,
    match: mongo.Filter<mongo.Document>,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | null> {
    const cursor = collection.aggregate<{ row: Record<string, unknown> | null }>(
      [
        { $match: match },
        { $limit: 1 },
        {
          $project: {
            _id: 0,
            row: { $cond: [{ $lte: [{ $bsonSize: '$$ROOT' }, 60 * 1024] }, '$$ROOT', null] },
          },
        },
      ],
      { ...options(session, end, signal), batchSize: 1 },
    );
    try {
      const first = await cursor.next();
      if (!first) return null;
      if (!first.row) throw new FileHistoryError('capacity');
      return first.row;
    } finally {
      await cursor.close();
    }
  }
  async function observe(
    scope: MongoHistoryScope,
    cursor: FileHistoryCursor,
    repair: boolean,
    session: ClientSession,
    end: number,
    signal: AbortSignal,
    fileKnown: (file: IMongoFile) => Promise<'retained' | 'excluded' | 'unknown'>,
    jobKnown: (job: HousekeepingJobRecord) => Promise<boolean>,
    repairClock: Date,
  ): Promise<MongoHistoryLeaf | null> {
    let row = await raw(scope, cursor, session, end, signal);
    if (!row) return null;
    if (scope.collection === 'files') {
      if (repair) {
        await prepareStandaloneFileCoverage(
          mongoose,
          row as unknown as IMongoFile,
          repairClock,
          session,
        );
        // Hash the actual repaired document. Never certify its pre-migration projection.
        row = await raw(scope, cursor, session, end, signal);
        if (!row) throw new FileHistoryError('source_changed');
      }
      return mongoHistoryLeaf(scope, {
        row,
        classification: await fileKnown(row as unknown as IMongoFile),
        linkedFileKnown: false,
      });
    }
    if (scope.collection === 'file-jobs') {
      const job = row as unknown as HousekeepingJobRecord;
      let linkedUploadOwner;
      if (job.work?.handler === 'upload.cleanup') {
        const original = await lookup(
          Operation.collection as unknown as mongo.Collection,
          { _id: job.work.operationId } as unknown as mongo.Filter<mongo.Document>,
          session,
          end,
          signal,
        );
        if (
          original &&
          original.generation === job.work.cleanupGeneration &&
          original.tenantId === job.work.subject.tenantId &&
          original.userId === job.work.subject.ownerUserId
        ) {
          linkedUploadOwner = mongoHistoryLeaf(
            { ...scope, collection: 'uploads' },
            {
              row: original as unknown as Record<string, unknown>,
              classification: 'unknown',
              linkedFileKnown: false,
            },
          ).entry.owner;
        }
      }
      return mongoHistoryLeaf(scope, {
        row,
        classification: (await jobKnown(job)) ? 'retained' : 'unknown',
        linkedFileKnown: false,
        linkedUploadOwner,
      });
    }
    let linkedFileKnown = false;
    if (
      row.state === 'ready' &&
      typeof row.userId === 'string' &&
      mongoose.Types.ObjectId.isValid(row.userId) &&
      Object.prototype.hasOwnProperty.call(row, 'tenantId')
    ) {
      const linked = await lookup(
        files as unknown as mongo.Collection,
        {
          uploadOperationId: row._id,
          user: new mongoose.Types.ObjectId(row.userId),
          tenantId: { $eq: row.tenantId, $exists: true },
        },
        session,
        end,
        signal,
      );
      linkedFileKnown =
        !!linked && (await fileKnown(linked as unknown as IMongoFile)) === 'retained';
    }
    return mongoHistoryLeaf(scope, { row, classification: 'unknown', linkedFileKnown });
  }
  return { scopes, observe };
}
