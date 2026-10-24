/** Existing diagnostic inventory owner, independent of historical coverage authority. */
import { performance } from 'node:perf_hooks';
import { FILE_HOUSEKEEPING_INVENTORY_CONTRACT } from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileInventoryRequest,
  FileInventoryResult,
  FileInventoryCounts,
} from 'librechat-data-provider';
import type { ClientSession, Mongoose, mongo } from 'mongoose';
import {
  isFileInventoryRequest,
  isFileCoverageInteger as integer,
  fileCoverageDigest as digest,
} from './fileHousekeepingCoverageContract';
import { BUDGET, RESERVE, CoverageError, fail, censusValue } from './fileHousekeepingCoverageData';

/** Fixed raw snapshot observation, deliberately independent of UploadStore and its Counter.
 * Neither a zero count nor matching bracketing metadata establishes a held interval.
 * The caller retains the original client until this operation and session have settled.
 */
export async function inspectFileHousekeepingInventory(
  mongoose: Pick<Mongoose, 'connection'>,
  request: FileInventoryRequest,
  signal: AbortSignal,
): Promise<FileInventoryResult> {
  return observeFileHousekeepingInventory(mongoose, request, signal);
}

/** Shared raw observation; a preparation selector is supplied only by the guarded owner above. */
export async function observeFileHousekeepingInventory(
  mongoose: Pick<Mongoose, 'connection'>,
  request: FileInventoryRequest,
  signal: AbortSignal,
  selector?: Extract<FileCoverageAction, { action: 'prepare-ttl' }>,
): Promise<FileInventoryResult> {
  if (!isFileInventoryRequest(request)) return { outcome: 'refused', code: 'invalid_input' };
  const remainingDeadline = Date.parse(request.originalDeadline) - Date.now();
  if (remainingDeadline <= 0 || signal.aborted) return { outcome: 'refused', code: 'deadline' };
  // A preparation inherits A's original deadline; its local observation is still bounded by BUDGET.
  if (!selector && remainingDeadline > 300_000)
    return { outcome: 'refused', code: 'invalid_input' };
  const end = performance.now() + Math.min(BUDGET, remainingDeadline);
  let session: ClientSession | undefined;
  let result: FileInventoryResult = { outcome: 'refused', code: 'unavailable' };
  try {
    const db = mongoose.connection.db;
    if (!db || db.databaseName !== request.target.mongoDatabase) fail('unavailable');
    const options = () => {
      if (signal.aborted || performance.now() >= end - RESERVE) fail('deadline');
      const ms = Math.max(1, Math.floor(end - performance.now() - RESERVE));
      return { maxTimeMS: ms, timeoutMS: ms, signal, readPreference: 'primary' as const };
    };
    const metadataDigest = (value: unknown) =>
      digest(censusValue(JSON.parse(JSON.stringify(value))));
    async function server() {
      const hello = await db!.command({ hello: 1, maxTimeMS: options().maxTimeMS }, options());
      if (
        hello.isWritablePrimary !== true ||
        hello.setName !== request.target.mongoReplicaSet ||
        !(hello.localTime instanceof Date) ||
        !Number.isFinite(hello.localTime.getTime()) ||
        typeof hello.me !== 'string' ||
        !hello.electionId ||
        !hello.topologyVersion?.processId
      )
        fail('unavailable');
      return {
        time: hello.localTime as Date,
        identity: metadataDigest([
          hello.me,
          hello.setName,
          hello.electionId,
          hello.topologyVersion.processId,
        ]),
      };
    }
    async function catalog() {
      const cursor = db!.listCollections({ name: 'files' }, options());
      let collections: mongo.CollectionInfo[];
      try {
        collections = await cursor.toArray();
      } finally {
        try {
          await cursor.close();
        } catch {
          fail(selector ? 'unknown_commit' : 'unavailable');
        }
      }
      if (collections.length > 1 || (collections[0] && collections[0].type !== 'collection'))
        fail('unavailable');
      let indexes: mongo.Document[] = [];
      if (collections.length) {
        const cursor = db!.collection('files').listIndexes(options());
        try {
          indexes = await cursor.toArray();
        } finally {
          try {
            await cursor.close();
          } catch {
            fail(selector ? 'unknown_commit' : 'unavailable');
          }
        }
      }
      if (indexes.length > 64) fail('capacity');
      if (selector) {
        const info = collections[0];
        const uuid = info?.info?.uuid;
        if (
          collections.length !== 1 ||
          Object.keys(info.options ?? {}).length !== 0 ||
          uuid?._bsontype !== 'Binary' ||
          uuid.sub_type !== 4 ||
          uuid.buffer.byteLength !== 16 ||
          uuid.toUUID().toHexString() !== selector.collectionUuid
        )
          fail('unavailable');
        const ttl = indexes.filter((index) =>
          Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
        );
        if (
          ttl.length !== 1 ||
          ttl[0].name !== selector.indexName ||
          metadataDigest(ttl[0]) !== selector.indexSha256
        )
          fail('unavailable');
      }
      indexes.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return {
        present: collections.length === 1,
        collectionSha256: metadataDigest(collections),
        indexSha256: metadataDigest(indexes),
        indexes,
      };
    }
    const before = await server();
    const first = await catalog();
    const ttlIndexes = first.indexes.filter((index) =>
      Object.prototype.hasOwnProperty.call(index, 'expireAfterSeconds'),
    );
    if (ttlIndexes.length > 16) fail('capacity');
    const ttl = ttlIndexes.map((index) => {
      const seconds = index.expireAfterSeconds;
      const supported =
        Object.keys(index).every((key) =>
          ['v', 'key', 'name', 'expireAfterSeconds', 'background'].includes(key),
        ) &&
        index.v === 2 &&
        typeof index.name === 'string' &&
        (index.background === undefined || typeof index.background === 'boolean') &&
        index.key &&
        Object.keys(index.key).length === 1 &&
        index.key.expiresAt === 1 &&
        integer(seconds) &&
        seconds <= 2147483647;
      return {
        specSha256: metadataDigest(index),
        kind: supported ? ('expiresAt' as const) : ('unsupported' as const),
        expireAfterSeconds: supported ? (seconds as number) : null,
      };
    });
    const horizon = new Date(before.time.getTime() + request.lookAheadMs);
    const ttlSeconds =
      ttl.length === 1 && ttl[0].kind === 'expiresAt' ? ttl[0].expireAfterSeconds! : 0;
    const due = new Date(before.time.getTime() - ttlSeconds * 1000);
    const dueByHorizon = new Date(horizon.getTime() - ttlSeconds * 1000);
    const type = (field: string) => ({ $type: '$' + field });
    const absent = (field: string) => ({ $in: [type(field), ['missing', 'null']] });
    const present = (field: string) => ({ $not: [absent(field)] });
    const isType = (field: string, value: string) => ({ $eq: [type(field), value] });
    const managed = present('uploadOperationId');
    const standalone = { $and: [absent('uploadOperationId'), present('retentionAcceptedAt')] };
    const inherited = {
      $and: [
        absent('uploadOperationId'),
        absent('retentionAcceptedAt'),
        isType('expiredAt', 'date'),
      ],
    };
    const validString = (field: string, regex: string) => ({
      $cond: [isType(field, 'string'), { $regexMatch: { input: '$' + field, regex } }, false],
    });
    const identity = {
      $and: [
        validString('file_id', '^[A-Za-z0-9_.:-]{1,256}$'),
        { $or: [isType('user', 'objectId'), validString('user', '^[a-f0-9]{24}$')] },
        {
          $or: [
            isType('tenantId', 'null'),
            {
              $and: [
                validString('tenantId', '^[A-Za-z0-9_.-]{1,128}$'),
                { $ne: ['$tenantId', '__SYSTEM__'] },
              ],
            },
          ],
        },
      ],
    };
    const conditions: Record<keyof FileInventoryCounts, unknown> = {
      totalFiles: true,
      managedMarker: managed,
      standaloneMarker: standalone,
      inheritedDeadline: inherited,
      otherFiles: { $not: [{ $or: [managed, standalone, inherited] }] },
      pastDueInheritedDeadline: { $and: [inherited, { $lte: ['$expiredAt', before.time] }] },
      malformedExpiredAt: { $and: [present('expiredAt'), { $not: [isType('expiredAt', 'date')] }] },
      deletionOrRetryMarkers: {
        $or: [
          'deletionRequestedAt',
          'deletionCompletedAt',
          'deletionRetryAt',
          'deletionAttempts',
        ].map(present),
      },
      missingOrMalformedIdentity: { $not: [identity] },
      expiresAtAbsentOrNull: absent('expiresAt'),
      expiresAtScalarDate: isType('expiresAt', 'date'),
      expiresAtArray: isType('expiresAt', 'array'),
      expiresAtOther: {
        $not: [
          { $or: [absent('expiresAt'), isType('expiresAt', 'date'), isType('expiresAt', 'array')] },
        ],
      },
    };
    const privateConditions = {
      ttlDue: { $and: [isType('expiresAt', 'date'), { $lte: ['$expiresAt', due] }] },
      ttlBecomingDue: {
        $and: [
          isType('expiresAt', 'date'),
          { $gt: ['$expiresAt', due] },
          { $lte: ['$expiresAt', dueByHorizon] },
        ],
      },
      ttlAfter: { $and: [isType('expiresAt', 'date'), { $gt: ['$expiresAt', dueByHorizon] }] },
    };
    const keys = Object.keys(conditions) as (keyof FileInventoryCounts)[];
    const group = Object.fromEntries(
      Object.entries({ ...conditions, ...privateConditions }).map(([key, condition]) => [
        key,
        { $sum: { $cond: [condition, 1, 0] } },
      ]),
    );
    session = mongoose.connection
      .getClient()
      .startSession({ snapshot: true, causalConsistency: false });
    const cursor = db
      .collection('files')
      .aggregate([{ $group: { _id: null, ...group } }, { $project: { _id: 0 } }], {
        ...options(),
        session,
        allowDiskUse: false,
      });
    let rows: mongo.Document[];
    try {
      rows = await cursor.toArray();
    } finally {
      try {
        await cursor.close();
      } catch {
        fail(selector ? 'unknown_commit' : 'unavailable');
      }
    }
    if (rows.length > 1) fail('unavailable');
    const row = rows[0] ?? Object.fromEntries(Object.keys(group).map((key) => [key, 0]));
    if (!Object.keys(group).every((key) => integer(row[key]))) fail('capacity');
    const counts = Object.fromEntries(keys.map((key) => [key, row[key]])) as FileInventoryCounts;
    const snapshot = (session as ClientSession & { snapshotTime?: mongo.Timestamp }).snapshotTime;
    if (!snapshot) fail('unavailable');
    const last = await catalog();
    const after = await server();
    const catalogStable =
      first.collectionSha256 === last.collectionSha256 && first.indexSha256 === last.indexSha256;
    const primaryStable = before.identity === after.identity && after.time >= before.time;
    const supported =
      catalogStable &&
      primaryStable &&
      ttl.length === 1 &&
      ttl[0].kind === 'expiresAt' &&
      counts.expiresAtArray === 0 &&
      counts.expiresAtOther === 0;
    const absentTTL = catalogStable && primaryStable && ttl.length === 0;
    options();
    let semantics: 'absent' | 'supported-scalar' | 'unknown' = 'unknown';
    if (absentTTL) semantics = 'absent';
    else if (supported) semantics = 'supported-scalar';
    const unclassifiedCount = absentTTL ? 0 : null;
    result = {
      outcome: 'inventoried',
      version: 1,
      diagnosticOnly: true,
      contract: FILE_HOUSEKEEPING_INVENTORY_CONTRACT,
      requestSha256: digest(request),
      collectionPresent: first.present,
      collectionSha256: first.collectionSha256,
      indexSha256: first.indexSha256,
      catalogStable,
      primaryStable,
      intervalAssurance: 'unknown',
      serverTime: {
        from: before.time.toISOString(),
        through: after.time.toISOString(),
        horizon: horizon.toISOString(),
      },
      snapshot: {
        seconds: snapshot.getHighBitsUnsigned(),
        increment: snapshot.getLowBitsUnsigned(),
      },
      counts,
      ttl: {
        semantics,
        indexes: ttl,
        eligibleAtObservation: supported ? row.ttlDue : unclassifiedCount,
        becomingEligibleByHorizon: supported ? row.ttlBecomingDue : unclassifiedCount,
        afterHorizon: supported ? row.ttlAfter : unclassifiedCount,
      },
    };
  } catch (error) {
    if (selector && (!(error instanceof CoverageError) || error.code === 'unknown_commit'))
      fail('unknown_commit');
    const code =
      error instanceof CoverageError &&
      ['invalid_input', 'deadline', 'capacity'].includes(error.code)
        ? (error.code as 'invalid_input' | 'deadline' | 'capacity')
        : 'unavailable';
    result = { outcome: 'refused', code };
  } finally {
    // Never race or detach original session settlement, even after input/output loss.
    try {
      await session?.endSession();
    } catch {
      if (selector) fail('unknown_commit');
      result = { outcome: 'refused', code: 'unavailable' };
    }
  }
  if (signal.aborted || performance.now() >= end) return { outcome: 'refused', code: 'deadline' };
  return result;
}
