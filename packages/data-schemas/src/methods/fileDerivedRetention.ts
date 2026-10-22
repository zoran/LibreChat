/** File-owned bounded ancestry and deadline projection; joins the caller's existing transaction. */
import {
  UPLOAD_DERIVED_MAX_SOURCES,
  UPLOAD_DERIVED_MAX_DESCENDANTS,
  UPLOAD_DERIVED_MAX_ORIGIN_BYTES,
  readUploadDerivedIntent,
  readUploadDerivedOrigin,
  sameUploadDerivedSource,
} from 'librechat-data-provider';
import type {
  UploadDerivedIntent,
  UploadDerivedOrigin,
  UploadDerivedSource,
} from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { CurrentManagedFileSource } from './fileSourceAuthority';
import type { FileOwnerScope, IMongoFile } from '~/types/file';
import type { StoredUpload } from './uploadManagementStore';
import {
  assembleManagedFileSource,
  assertFileSourceOwnerActive,
  currentFileDeadline,
  currentManagedFileFilter,
  FileSourceCapacityError,
  FileSourceUnavailableError,
  loadFileSourceMetadata,
  managedFileScope,
} from './fileSourceAuthority';
import { projectFileHousekeeping } from './fileHousekeepingProjection';
import { mirrorFileActivityDeadline } from './uploadManagementStore';
import { touchActiveUserPrincipal } from './userPrincipal';

function unavailable(): never {
  throw new FileSourceUnavailableError();
}
export const originOf = (file: IMongoFile): UploadDerivedOrigin | undefined => {
  if (file.derivedOrigin === undefined) return undefined;
  const origin = readUploadDerivedOrigin(file.derivedOrigin);
  if (!origin || origin.ancestors.some((source) => source.subject.operationId === file.file_id))
    unavailable();
  return origin;
};
export function projectDerivedFileDeadline(
  ownDeadlineAt: Date,
  currentParentDeadlines: readonly Date[],
): Date {
  if (
    !(ownDeadlineAt instanceof Date) ||
    !Number.isSafeInteger(ownDeadlineAt.getTime()) ||
    currentParentDeadlines.length > UPLOAD_DERIVED_MAX_SOURCES ||
    currentParentDeadlines.some(
      (value) => !(value instanceof Date) || !Number.isSafeInteger(value.getTime()),
    )
  )
    unavailable();
  return new Date(
    Math.min(ownDeadlineAt.getTime(), ...currentParentDeadlines.map((value) => value.getTime())),
  );
}
export function derivedSourceOf(source: CurrentManagedFileSource): UploadDerivedSource {
  return {
    subject: source.file.securityApproval!.subject,
    policySha256: source.file.securityApproval!.policySha256,
    sourceBindingSha256: source.binding,
    expiresAt: source.file.expiredAt!.getTime(),
  };
}
export function verifyLineage(
  file: IMongoFile,
  sources: Map<string, CurrentManagedFileSource>,
): void {
  const origin = originOf(file);
  if (!origin) return;
  const own = new Set(origin.ancestors.map((item) => item.subject.operationId));
  for (const expected of origin.ancestors) {
    const actual = sources.get(expected.subject.operationId);
    if (!actual || !sameUploadDerivedSource(expected, derivedSourceOf(actual))) unavailable();
    if (
      (originOf(actual.file)?.ancestors ?? []).some(
        (parent) => !own.has(parent.subject.operationId),
      )
    )
      unavailable();
  }
}
async function metadata(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  ids: readonly string[],
  session: ClientSession,
): Promise<{ files: Map<string, IMongoFile>; operations: Map<string, StoredUpload> }> {
  if (ids.length > UPLOAD_DERIVED_MAX_DESCENDANTS * UPLOAD_DERIVED_MAX_SOURCES + 1)
    throw new FileSourceCapacityError();
  const files = new Map<string, IMongoFile>(),
    operations = new Map<string, StoredUpload>();
  for (let index = 0; index < ids.length; index += 64) {
    const batch = await loadFileSourceMetadata(
      mongoose,
      owner,
      ids.slice(index, index + 64),
      session,
    );
    for (const file of batch.files) files.set(file.file_id, file);
    for (const operation of batch.operations) operations.set(operation._id, operation);
  }
  return { files, operations };
}
/** Capture current actual-receipt identities; dates in the returned origin remain provenance. */
export async function captureDerivedFileOrigin(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  value: UploadDerivedIntent,
  session: ClientSession,
  policy: string,
): Promise<UploadDerivedOrigin> {
  const intent = readUploadDerivedIntent(value);
  if (!intent || !session.inTransaction()) unavailable();
  await touchActiveUserPrincipal(
    mongoose,
    { userId: owner.userId, tenantId: owner.tenantId ?? null },
    session,
  );
  const heads = await metadata(mongoose, owner, intent.directSourceFileIds, session);
  const ids = new Set(intent.directSourceFileIds);
  for (const id of intent.directSourceFileIds) {
    const file = heads.files.get(id);
    if (!file) unavailable();
    for (const parent of originOf(file)?.ancestors ?? []) ids.add(parent.subject.operationId);
  }
  const rows = await metadata(mongoose, owner, [...ids], session);
  const sources = new Map<string, CurrentManagedFileSource>();
  for (const id of ids) {
    const file = rows.files.get(id);
    if (!file) unavailable();
    const source = assembleManagedFileSource(
      owner,
      file,
      rows.operations.get(id),
      'original',
      policy,
      'derived-parent',
    );
    if (file.status !== 'ready' || source.operation.state !== 'ready') unavailable();
    sources.set(id, source);
  }
  for (const source of sources.values()) verifyLineage(source.file, sources);
  if (sources.size > UPLOAD_DERIVED_MAX_SOURCES) throw new FileSourceCapacityError();
  const valueV2 = { version: 2, ...intent, ancestors: [...sources.values()].map(derivedSourceOf) };
  if (Buffer.byteLength(JSON.stringify(valueV2), 'utf8') > UPLOAD_DERIVED_MAX_ORIGIN_BYTES)
    throw new FileSourceCapacityError();
  const origin = readUploadDerivedOrigin(valueV2);
  if (!origin) unavailable();
  for (const source of sources.values()) {
    const touched = await mongoose.models.File.updateOne(
      {
        ...currentManagedFileFilter(
          owner,
          source.file.file_id,
          Date.now(),
          policy,
          'derived-parent',
        ),
        retentionRevision: source.file.retentionRevision,
        expiredAt: source.file.expiredAt,
      },
      { $inc: { retentionRevision: 1 } },
      { session, timestamps: false },
    );
    if (touched.matchedCount !== 1) unavailable();
  }
  return origin;
}

/** One bounded atomic transition. Expired/revoked descendants never re-enter live retention. */
export async function refreshDerivedFileDeadlines(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  previousRoot: IMongoFile,
  nextRoot: IMongoFile,
  session: ClientSession,
): Promise<void> {
  if (!session.inTransaction() || previousRoot.file_id !== nextRoot.file_id) unavailable();
  const before = currentFileDeadline(previousRoot),
    after = currentFileDeadline(nextRoot);
  if (after.deadlineAt.getTime() === before.deadlineAt.getTime()) return;
  await assertFileSourceOwnerActive(mongoose, owner, session);
  const now = Date.now();
  const descendants = await mongoose.models.File.find({
    ...managedFileScope(owner),
    'derivedOrigin.ancestors.subject.operationId': previousRoot.file_id,
    deletionCompletedAt: null,
  })
    .select(
      '-text -documentStructure +derivedOrigin +derivedRetention +retentionActivity +securityApproval',
    )
    .hint('file_derived_ancestors')
    .limit(UPLOAD_DERIVED_MAX_DESCENDANTS + 1)
    .session(session)
    .maxTimeMS(1000)
    .lean<IMongoFile[]>();
  if (descendants.length > UPLOAD_DERIVED_MAX_DESCENDANTS) throw new FileSourceCapacityError();
  const live = descendants.filter(
    (file) => file.expiredAt && file.expiredAt.getTime() > now && !file.deletionRequestedAt,
  );
  const ids = new Set([previousRoot.file_id]);
  for (const file of live) {
    const origin = originOf(file);
    if (!origin) unavailable();
    ids.add(file.file_id);
    for (const source of origin.ancestors) ids.add(source.subject.operationId);
  }
  const rows = await metadata(mongoose, owner, [...ids], session);
  // Root File was conditionally changed by this caller; its Upload projection is still old here.
  rows.files.set(previousRoot.file_id, previousRoot);
  const sources = new Map<string, CurrentManagedFileSource>();
  const policy = previousRoot.securityApproval?.policySha256;
  if (!policy) unavailable();
  for (const id of ids) {
    const file = rows.files.get(id);
    if (!file) unavailable();
    sources.set(
      id,
      assembleManagedFileSource(
        owner,
        file,
        rows.operations.get(id),
        'original',
        policy,
        'derived-parent',
      ),
    );
  }
  for (const source of sources.values()) verifyLineage(source.file, sources);
  const deadlines = new Map([...sources].map(([id, source]) => [id, source.file.expiredAt!]));
  deadlines.set(nextRoot.file_id, after.deadlineAt);
  live.sort((a, b) => originOf(a)!.ancestors.length - originOf(b)!.ancestors.length);
  for (const file of live) {
    const current = currentFileDeadline(file),
      origin = originOf(file)!;
    if (
      current.kind !== 'derived' ||
      current.migrationEpoch !== null ||
      current.deadlineGeneration === Number.MAX_SAFE_INTEGER
    )
      unavailable();
    const originalParents = origin.ancestors.map(
      (source) => sources.get(source.subject.operationId)?.file.expiredAt ?? unavailable(),
    );
    if (
      projectDerivedFileDeadline(
        file.derivedRetention!.ownDeadlineAt,
        originalParents,
      ).getTime() !== current.deadlineAt.getTime()
    )
      unavailable();
    const nextDeadline = projectDerivedFileDeadline(
      file.derivedRetention!.ownDeadlineAt,
      origin.ancestors.map((source) => deadlines.get(source.subject.operationId) ?? unavailable()),
    );
    deadlines.set(file.file_id, nextDeadline);
    if (nextDeadline.getTime() === current.deadlineAt.getTime()) continue;
    if (nextDeadline.getTime() <= Date.now()) unavailable();
    const next: IMongoFile = {
      ...file,
      expiredAt: nextDeadline,
      retentionRevision: (file.retentionRevision ?? 0) + 1,
      derivedRetention: {
        ...file.derivedRetention!,
        deadlineGeneration: current.deadlineGeneration + 1,
      },
    };
    const changed = await mongoose.models.File.updateOne(
      {
        ...currentManagedFileFilter(owner, file.file_id, Date.now(), policy, 'derived-parent'),
        retentionRevision: file.retentionRevision,
        expiredAt: file.expiredAt,
      },
      {
        $set: { expiredAt: nextDeadline, derivedRetention: next.derivedRetention },
        $inc: { retentionRevision: 1 },
      },
      { session, timestamps: false },
    );
    if (changed.matchedCount !== 1) unavailable();
    await mirrorFileActivityDeadline(
      mongoose,
      sources.get(file.file_id)!.operation,
      nextDeadline.getTime(),
      session,
      'derived-projection',
    );
    await projectFileHousekeeping(mongoose, file, next, session);
  }
}

/** Freeze/backfill an actual File/Upload pair, retaining exact cleanup custody and replay identity. */
