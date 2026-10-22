/** File-owned migration classification; reuses the existing deadline/lineage interpretation. */
import { randomUUID } from 'node:crypto';
import {
  UPLOAD_DERIVED_MAX_SOURCES,
  UPLOAD_RECORD_BYTES,
  readHistoricalUploadDerivedOrigin,
  readUploadDerivedOrigin,
} from 'librechat-data-provider';
import type { FileRetentionMigrationRecord, UploadDerivedSource } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { CurrentManagedFileSource } from './fileSourceAuthority';
import type { StoredUpload } from './uploadManagementStore';
import type { IMongoFile } from '~/types/file';
import {
  assembleManagedFileSource,
  currentFileDeadline,
  FileSourceCapacityError,
  FileSourceUnavailableError,
  loadFileSourceMetadata,
  managedFileScope,
  fileSourceSha256,
} from './fileSourceAuthority';
import {
  originOf,
  verifyLineage,
  derivedSourceOf,
  projectDerivedFileDeadline,
} from './fileDerivedRetention';
import { projectFileHousekeeping, fileHousekeepingObligations } from './fileHousekeepingProjection';
import { mirrorFileRetentionMigration, reject } from './uploadManagementStore';
import { validFileRetentionActivity } from './fileActivityTransition';
import { importFileRetryFloor } from './housekeepingProjection';
import { createHousekeepingStore } from './housekeepingStore';
function unavailable(): never {
  throw new FileSourceUnavailableError();
}

export async function prepareFileRetentionMigration(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  epoch: string,
  frozenAt: number,
  session: ClientSession,
  policy: string,
  initialize: boolean,
  visiting: Set<string> = new Set<string>(),
  prepared: Map<string, FileRetentionMigrationRecord> = new Map<
    string,
    FileRetentionMigrationRecord
  >(),
): Promise<FileRetentionMigrationRecord | null> {
  if (row.acceptedAt === undefined) return null;
  if (
    !session.inTransaction() ||
    !Number.isSafeInteger(frozenAt) ||
    frozenAt > Date.now() ||
    visiting.has(row._id)
  )
    unavailable();
  const key = JSON.stringify([row.tenantId, row.userId, row._id]);
  const cached = prepared.get(key);
  if (cached) return cached;
  if (visiting.size >= UPLOAD_DERIVED_MAX_SOURCES) throw new FileSourceCapacityError();
  visiting.add(row._id);
  try {
    const owner = { userId: row.userId, tenantId: row.tenantId };
    const file = await mongoose.models.File.findOne({
      ...managedFileScope(owner),
      file_id: row._id,
      uploadOperationId: row._id,
    })
      .select(
        '-text -documentStructure +securityApproval +retentionActivity +derivedRetention +derivedOrigin +retentionRevocationId',
      )
      .session(session)
      .maxTimeMS(1000)
      .lean<IMongoFile>();
    if (
      !file ||
      !file.expiredAt ||
      file.expiredAt.getTime() !== row.expiresAt ||
      file.retentionAcceptedAt?.getTime() !== row.acceptedAt
    )
      unavailable();
    const previous = { ...file };
    const previousOrigin = row.derivedOrigin;
    if (file.deletionRequestedAt && !file.retentionRevocationId)
      file.retentionRevocationId = randomUUID();
    const cleanup = !!(
      file.deletionRequestedAt ||
      file.deletionCompletedAt ||
      row.expiresAt! <= frozenAt ||
      ['deleted', 'expired'].includes(row.state)
    );
    const historical =
      row.derivedOrigin === undefined
        ? undefined
        : readHistoricalUploadDerivedOrigin(row.derivedOrigin);
    if (
      historical === null ||
      (file.derivedOrigin !== undefined &&
        JSON.stringify(readHistoricalUploadDerivedOrigin(file.derivedOrigin)) !==
          JSON.stringify(historical))
    )
      unavailable();
    if (historical) {
      if (file.retentionActivity !== undefined) unavailable();
      if (!file.derivedRetention) {
        if (!initialize) unavailable();
        file.derivedRetention = {
          version: 1,
          ownDeadlineAt: new Date(file.expiredAt),
          capBasis: 'legacy-baseline',
          trackedSince: new Date(frozenAt),
          deadlineGeneration: 0,
        };
      }
      if (!cleanup && initialize) {
        const sources: UploadDerivedSource[] = [];
        for (const expected of historical.ancestors) {
          const pair = await loadFileSourceMetadata(
            mongoose,
            owner,
            [expected.subject.operationId],
            session,
          );
          const parentRow = pair.operations[0];
          if (!parentRow) unavailable();
          await prepareFileRetentionMigration(
            mongoose,
            parentRow,
            epoch,
            frozenAt,
            session,
            policy,
            initialize,
            visiting,
            prepared,
          );
          const current = await loadFileSourceMetadata(
            mongoose,
            owner,
            [expected.subject.operationId],
            session,
          );
          const parent = current.files[0];
          if (!parent) unavailable();
          const source = assembleManagedFileSource(
            owner,
            parent,
            current.operations[0],
            'original',
            policy,
            'derived-parent',
            epoch,
            frozenAt,
          );
          const actual = derivedSourceOf(source);
          if (
            JSON.stringify(actual.subject) !== JSON.stringify(expected.subject) ||
            actual.policySha256 !== expected.policySha256 ||
            (historical.version === 2 &&
              actual.sourceBindingSha256 !== (expected as UploadDerivedSource).sourceBindingSha256)
          )
            unavailable();
          sources.push({ ...actual, expiresAt: expected.expiresAt });
        }
        const upgraded = readUploadDerivedOrigin({ ...historical, version: 2, ancestors: sources });
        if (
          !upgraded ||
          mongoose.mongo.BSON.calculateObjectSize({
            derivedOrigin: upgraded,
            fingerprint: row.fingerprint,
          }) >
            UPLOAD_RECORD_BYTES / 2
        )
          unavailable();
        file.derivedOrigin = upgraded;
        row.derivedOrigin = upgraded;
        const actualParents = [];
        for (const expected of upgraded.ancestors) {
          const current = await loadFileSourceMetadata(
            mongoose,
            owner,
            [expected.subject.operationId],
            session,
          );
          actualParents.push(current.files[0]?.expiredAt ?? unavailable());
        }
        const projected = projectDerivedFileDeadline(
          file.derivedRetention.ownDeadlineAt,
          actualParents,
        );
        if (projected.getTime() > file.expiredAt.getTime()) unavailable();
        if (projected.getTime() !== file.expiredAt.getTime()) {
          if (!initialize || projected.getTime() <= frozenAt) unavailable();
          file.expiredAt = projected;
          row.expiresAt = projected.getTime();
          file.derivedRetention = {
            ...file.derivedRetention,
            deadlineGeneration: file.derivedRetention.deadlineGeneration + 1,
          };
        }
      } else if (file.derivedOrigin === undefined && !file.deletionCompletedAt) unavailable();
      if (!cleanup && !initialize) {
        const origin = readUploadDerivedOrigin(file.derivedOrigin);
        if (
          !origin ||
          JSON.stringify(origin) !== JSON.stringify(readUploadDerivedOrigin(row.derivedOrigin))
        )
          unavailable();
        const parents = await loadFileSourceMetadata(
          mongoose,
          owner,
          origin.ancestors.map((item) => item.subject.operationId),
          session,
        );
        if (parents.files.length !== origin.ancestors.length) unavailable();
        for (const parent of parents.files) {
          const expected = origin.ancestors.find(
            (item) => item.subject.operationId === parent.file_id,
          )!;
          if (
            currentFileDeadline(parent).migrationEpoch !== epoch ||
            JSON.stringify(parent.securityApproval?.subject) !== JSON.stringify(expected.subject) ||
            parent.securityApproval?.policySha256 !== expected.policySha256 ||
            parent.deletionRequestedAt ||
            parent.deletionCompletedAt ||
            !parent.expiredAt ||
            parent.expiredAt.getTime() <= frozenAt
          )
            unavailable();
        }
        if (
          projectDerivedFileDeadline(
            file.derivedRetention.ownDeadlineAt,
            parents.files.map((parent) => parent.expiredAt!),
          ).getTime() !== file.expiredAt.getTime()
        )
          unavailable();
      }
      file.derivedRetention = { ...file.derivedRetention, migrationEpoch: epoch };
    } else {
      if (file.derivedRetention !== undefined || file.derivedOrigin !== undefined) unavailable();
      if (!file.retentionActivity) {
        if (!initialize) unavailable();
        // This seed deliberately also admits expired custody; it grants no content/read authority.
        file.retentionActivity = {
          version: 1,
          baselineDeadlineAt: new Date(file.expiredAt),
          trackedSince: new Date(frozenAt),
          historyConfidence: 'since-tracking',
          readCount: 0,
          processingCount: 0,
          deadlineGeneration: 0,
        };
      }
      if (!validFileRetentionActivity(file.retentionActivity, file.expiredAt)) unavailable();
      file.retentionActivity = { ...file.retentionActivity, migrationEpoch: epoch };
    }
    const oldEpoch =
      previous.retentionActivity?.migrationEpoch ?? previous.derivedRetention?.migrationEpoch;
    if ((!initialize && oldEpoch !== epoch) || (oldEpoch !== undefined && oldEpoch !== epoch))
      unavailable();
    if (!Number.isSafeInteger(file.expiredAt.getTime())) unavailable();
    const changed = await mongoose.models.File.updateOne(
      {
        ...managedFileScope(owner),
        file_id: row._id,
        retentionRevision: previous.retentionRevision,
        expiredAt: previous.expiredAt,
      },
      {
        $set: {
          expiredAt: file.expiredAt,
          ...(file.retentionRevocationId
            ? { retentionRevocationId: file.retentionRevocationId }
            : {}),
          ...(file.retentionActivity ? { retentionActivity: file.retentionActivity } : {}),
          ...(file.derivedRetention ? { derivedRetention: file.derivedRetention } : {}),
          ...(file.derivedOrigin === undefined ? {} : { derivedOrigin: file.derivedOrigin }),
        },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (changed.matchedCount !== 1) unavailable();
    await mirrorFileRetentionMigration(
      mongoose,
      row,
      previous.expiredAt!.getTime(),
      previousOrigin,
      session,
    );
    let binding: string | null = null;
    if (!cleanup)
      binding = assembleManagedFileSource(
        owner,
        file,
        row,
        'original',
        policy,
        'derived-parent',
        epoch,
        frozenAt,
      ).binding;
    const activity = file.retentionActivity,
      derived = file.derivedRetention;
    const record: FileRetentionMigrationRecord = {
      kind: 'file-retention',
      subject: { tenantId: row.tenantId, ownerUserId: row.userId, fileId: row._id },
      acceptedAt: file.retentionAcceptedAt?.toISOString() ?? null,
      deadlineAt: file.expiredAt.toISOString(),
      sourceBindingSha256: binding,
      custody: cleanup ? 'cleanup-only' : 'current',
      retention: activity
        ? {
            kind: 'original',
            version: 1,
            baselineDeadlineAt: activity.baselineDeadlineAt.toISOString(),
            trackedSince: activity.trackedSince.toISOString(),
            historyConfidence: activity.historyConfidence,
            readCount: activity.readCount,
            processingCount: activity.processingCount,
            deadlineGeneration: activity.deadlineGeneration,
            lastSuccessfulReadAt: activity.lastSuccessfulReadAt?.toISOString() ?? null,
            lastSuccessfulProcessingAt: activity.lastSuccessfulProcessingAt?.toISOString() ?? null,
          }
        : {
            kind: 'derived',
            version: 1,
            ownDeadlineAt: derived!.ownDeadlineAt.toISOString(),
            capBasis: derived!.capBasis,
            trackedSince: derived!.trackedSince.toISOString(),
            deadlineGeneration: derived!.deadlineGeneration,
            originSha256: historical
              ? fileSourceSha256(
                  JSON.stringify(readHistoricalUploadDerivedOrigin(row.derivedOrigin)),
                )
              : null,
          },
    };
    await projectFileHousekeeping(mongoose, previous, file, session);
    prepared.set(key, record);
    return record;
  } finally {
    visiting.delete(row._id);
  }
}

/** Final import barrier: every parent now has its actual imported Upload receipt. No unfreeze here. */
export async function verifyFrozenFileRetentionMigration(
  mongoose: typeof import('mongoose'),
  row: StoredUpload,
  epoch: string,
  frozenAt: number,
  session: ClientSession,
  policy: string,
): Promise<FileRetentionMigrationRecord | null> {
  const record = await prepareFileRetentionMigration(
    mongoose,
    row,
    epoch,
    frozenAt,
    session,
    policy,
    false,
  );
  if (row.acceptedAt === undefined) return record;
  const owner = { userId: row.userId, tenantId: row.tenantId };
  const own = await loadFileSourceMetadata(mongoose, owner, [row._id], session);
  const file = own.files[0];
  if (!file) unavailable();
  if (
    file.deletionRequestedAt ||
    file.deletionCompletedAt ||
    file.expiredAt!.getTime() <= frozenAt ||
    ['deleted', 'expired'].includes(row.state)
  )
    return record;
  const origin = originOf(file);
  if (!origin) return record;
  const rows = await loadFileSourceMetadata(
    mongoose,
    owner,
    origin.ancestors.map((item) => item.subject.operationId),
    session,
  );
  const operations = new Map(rows.operations.map((operation) => [operation._id, operation]));
  const sources = new Map<string, CurrentManagedFileSource>();
  for (const parent of rows.files)
    sources.set(
      parent.file_id,
      assembleManagedFileSource(
        owner,
        parent,
        operations.get(parent.file_id),
        'original',
        policy,
        'derived-parent',
        epoch,
        frozenAt,
      ),
    );
  verifyLineage(file, sources);
  for (const source of sources.values()) verifyLineage(source.file, sources);
  return record;
}

/** Standalone retained admission has an actual deadline; generic legacy policies remain unknown. */
export function classifyFileCoverage(file: IMongoFile): 'excluded' | 'retained' | 'unknown' {
  const retained = [
    file.expiredAt,
    file.retentionAcceptedAt,
    file.retentionActivity,
    file.derivedRetention,
    file.derivedOrigin,
    file.retentionRevocationId,
    file.deletionRequestedAt,
    file.deletionCompletedAt,
    file.deletionRetryAt,
    file.deletionAttempts,
  ].some((value) => value != null && value !== 0);
  // Missing retention metadata cannot make a managed File safe to exclude.
  if (!retained) return file.uploadOperationId == null ? 'excluded' : 'unknown';
  // Legacy deletion markers do not prove retained generation/receipt custody. That owner must
  // classify completed tombstones before this census can certify them. Never infer completion.
  if (file.deletionCompletedAt != null) return 'unknown';
  if (
    (file.deletionAttempts !== undefined &&
      (!Number.isSafeInteger(file.deletionAttempts) || file.deletionAttempts < 0)) ||
    (file.deletionRetryAt != null &&
      (!(file.deletionRetryAt instanceof Date) ||
        !Number.isSafeInteger(file.deletionRetryAt.getTime()))) ||
    ((file.deletionAttempts ?? 0) > 0 && file.deletionRetryAt == null)
  )
    return 'unknown';
  if (
    !Object.prototype.hasOwnProperty.call(file, 'tenantId') ||
    !(
      file.tenantId === null ||
      (typeof file.tenantId === 'string' &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(file.tenantId) &&
        file.tenantId !== '__SYSTEM__')
    ) ||
    !/^[a-f0-9]{24}$/.test(String(file.user)) ||
    !/^[A-Za-z0-9_.:-]{1,256}$/.test(file.file_id) ||
    !Number.isSafeInteger(file.retentionRevision) ||
    file.retentionRevision! < 0 ||
    file.retentionRevision! >= Number.MAX_SAFE_INTEGER ||
    file.expiresAt != null ||
    ((file.deletionRequestedAt || file.deletionCompletedAt) && !file.retentionRevocationId)
  )
    return 'unknown';
  try {
    return currentFileDeadline(file).migrationEpoch === null ? 'retained' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Exact File CAS and projection share the caller's existing administrative transaction. */
export async function prepareStandaloneFileCoverage(
  mongoose: typeof import('mongoose'),
  file: IMongoFile,
  observedAt: Date,
  session: ClientSession,
): Promise<'excluded' | 'retained' | 'unknown'> {
  if (!session.inTransaction()) unavailable();
  const next = { ...file };
  // Only explicit standalone retained admission can supply this truthful legacy baseline.
  // Missing Upload/derived history belongs to its unchanged existing migration, never this seed.
  if (
    !file.retentionActivity &&
    !file.derivedRetention &&
    !file.derivedOrigin &&
    !file.uploadOperationId &&
    file.retentionAcceptedAt instanceof Date &&
    file.expiredAt instanceof Date &&
    Number.isSafeInteger(file.retentionAcceptedAt.getTime()) &&
    Number.isSafeInteger(file.expiredAt.getTime()) &&
    file.retentionAcceptedAt < file.expiredAt
  ) {
    next.retentionActivity = {
      version: 1,
      baselineDeadlineAt: new Date(file.expiredAt),
      trackedSince: observedAt,
      historyConfidence: 'since-tracking',
      readCount: 0,
      processingCount: 0,
      deadlineGeneration: 0,
    };
  }
  const kind = classifyFileCoverage(next);
  if (kind !== 'retained') return kind;
  const fields = [
    'tenantId',
    'user',
    'file_id',
    'expiredAt',
    'retentionAcceptedAt',
    'retentionRevision',
    'retentionActivity',
    'derivedRetention',
    'derivedOrigin',
    'retentionRevocationId',
    'deletionRequestedAt',
    'deletionCompletedAt',
    'deletionRetryAt',
    'deletionAttempts',
    'expiresAt',
  ] as const;
  const fence = Object.fromEntries(
    fields.map((key) => [
      key,
      file[key] === undefined ? { $exists: false } : { $eq: file[key], $exists: true },
    ]),
  );
  // eslint-disable-next-line no-restricted-syntax -- Administrative File migration CAS includes actual _id, explicit namespace/principal, revision and exact selected lifecycle values; raw driver preserves absent-field fences.
  const result = await mongoose.models.File.collection.updateOne(
    { _id: file._id, ...fence },
    {
      $inc: { retentionRevision: 1 },
      ...(next.retentionActivity ? { $set: { retentionActivity: next.retentionActivity } } : {}),
    },
    { session, maxTimeMS: 1000 },
  );
  if (result.matchedCount !== 1) unavailable();
  await projectFileHousekeeping(mongoose, file, next, session);
  if (file.deletionRetryAt instanceof Date) {
    const jobs = createHousekeepingStore(mongoose);
    for (const { work } of fileHousekeepingObligations(next))
      if (
        work.handler === 'file.cleanup' &&
        !(await importFileRetryFloor(jobs.model, work, file.deletionRetryAt, session))
      )
        return 'unknown';
  }
  return 'retained';
}

/** Only this existing File owner interprets the migration freeze fields. */
const frozenFileRetentionFilter = (epoch: string) => ({
  $or: [
    { 'retentionActivity.migrationEpoch': epoch },
    { 'derivedRetention.migrationEpoch': epoch },
  ],
});

export async function assertFrozenFileRetentionPopulation(
  mongoose: typeof import('mongoose'),
  epoch: string,
  expectedFiles: number,
  session: ClientSession,
): Promise<void> {
  const frozenFiles = await mongoose.models.File.countDocuments(frozenFileRetentionFilter(epoch))
    .limit(expectedFiles + 1)
    .session(session)
    .maxTimeMS(1000);
  if (frozenFiles !== expectedFiles) reject('migration_conflict');
}

/** Called only after the complete import barrier commits; the caller owns this page transaction. */
export async function thawFileRetentionMigrationPage(
  mongoose: typeof import('mongoose'),
  epoch: string,
  session: ClientSession,
): Promise<number> {
  const filter = frozenFileRetentionFilter(epoch);
  const files = await mongoose.models.File.find(filter)
    .select('file_id retentionRevision')
    .limit(100)
    .session(session)
    .lean();
  for (const file of files) {
    const changed = await mongoose.models.File.updateOne(
      { _id: file._id, retentionRevision: file.retentionRevision, ...filter },
      {
        $unset: { 'retentionActivity.migrationEpoch': '', 'derivedRetention.migrationEpoch': '' },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (changed.matchedCount !== 1) reject('migration_conflict');
  }
  return files.length;
}
