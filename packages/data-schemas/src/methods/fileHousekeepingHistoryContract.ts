/** Sole strict parser for historical pages, accounting and authenticated owner responses. */
import {
  canonicalManagedJson,
  FILE_HISTORY_LIMITS,
  FILE_HISTORY_KINDS,
  FILE_HISTORY_KIND_COUNTS,
  FILE_HISTORY_DISPOSITIONS,
  FILE_HISTORY_BYTE_KEYS,
  FILE_HISTORY_BLOCKER_KEYS,
} from 'librechat-data-provider';
import type {
  FileHistoryEntry,
  FileHistoryPage,
  FileHistoryPosition,
  FileHistoryScope,
  FileHistoryCursor,
  FileHistoryAccounting,
  FileHistorySummary,
  FileHistoryStorageBinding,
  FileHistoryStorageReply,
  FileHistoryMongoAcknowledgement,
} from 'librechat-data-provider';
import { sealablePhysicalAccounting } from './fileHousekeepingHistoryAccounting';
import { shape, integer, hash, same, digest } from './fileHousekeepingData';

const streams = [
  'uploads',
  'bucket-catalog',
  'current-objects',
  'versions',
  'delete-markers',
  'multipart-uploads',
  'multipart-parts',
  'filer-entries',
  'manifest-edges',
  'physical-catalog',
  'volume-index',
  'volume-data',
  'physical-file',
  'verification',
];
const dispositionCounts = [
  'retainedOwned',
  'deletionRequired',
  'deletionInFlight',
  'logicallyAbsentPhysicalPending',
  'absentAndConsumed',
  'unclassified',
];
const kindCountKeys = Object.values(FILE_HISTORY_KIND_COUNTS);
const countKeys = [
  ...kindCountKeys,
  ...dispositionCounts,
  'heldSlots',
  'heldReservations',
  'unknownSizeCount',
];
const storageKeys = ['storageDeploymentId', 'storageStoreId'];
const text = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length > 0 && Buffer.byteLength(v, 'utf8') <= max;
const marker = (v: unknown): v is string => typeof v === 'string' && Buffer.byteLength(v) <= 8192;
const maybeInteger = (v: unknown): boolean => v === null || integer(v);
const tenant = (v: unknown): boolean =>
  v === null || (typeof v === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(v) && v !== '__SYSTEM__');
const storage = (v: Record<string, unknown>): boolean =>
  storageKeys.every((key) => text(v[key], 256));
const volume = (v: Record<string, unknown>): boolean =>
  marker(v.collection) &&
  integer(v.volumeId) &&
  v.volumeId <= 0xffffffff &&
  hash(v.replicaId) &&
  text(v.pvUid, 128);
const revision = (v: unknown): boolean => integer(v) && v <= 0xffff;
export function boundedHistoryData(
  v: unknown,
  limit: number = FILE_HISTORY_LIMITS.pageBytes,
): boolean {
  try {
    return Buffer.byteLength(canonicalManagedJson(v)) <= limit;
  } catch {
    return false;
  }
}
const formatFilePath = (v: unknown): v is string =>
  text(v) &&
  !v.includes('\0') &&
  v.split('/').every((part) => part !== '' && part !== '.' && part !== '..') &&
  boundedHistoryData(v);
/** Reference hashing names an already authenticated native inode; it never mints its identity. */
function physicalFileReference(v: {
  storageDeploymentId: string;
  storageStoreId: string;
  pvUid: string;
  nativeFileIdSha256: string;
}): string {
  return digest({
    domain: 'physical-file',
    storageDeploymentId: v.storageDeploymentId,
    storageStoreId: v.storageStoreId,
    pvUid: v.pvUid,
    nativeFileIdSha256: v.nativeFileIdSha256,
    component: 'physicalFile',
  });
}
export function isHistoryScope(v: unknown): v is FileHistoryScope {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  if (x.kind === 'mongo')
    return (
      shape(x, ['kind', 'storeId', 'collection', 'collectionUuid']) &&
      text(x.storeId, 128) &&
      ['files', 'file-jobs', 'uploads'].includes(String(x.collection)) &&
      typeof x.collectionUuid === 'string' &&
      /^[a-f0-9-]{36}$/.test(x.collectionUuid)
    );
  if (x.kind === 's3-catalog' || x.kind === 'storage-catalog')
    return shape(x, ['kind', ...storageKeys]) && storage(x);
  if (x.kind === 's3-bucket')
    return shape(x, ['kind', ...storageKeys, 'bucket']) && storage(x) && text(x.bucket, 255);
  if (x.kind === 's3-upload')
    return (
      shape(x, ['kind', ...storageKeys, 'bucket', 'key', 'uploadId']) &&
      storage(x) &&
      text(x.bucket, 255) &&
      text(x.key) &&
      text(x.uploadId)
    );
  if (x.kind === 'filer')
    return (
      shape(x, ['kind', ...storageKeys, 'metadataStoreId', 'directory']) &&
      storage(x) &&
      text(x.metadataStoreId, 256) &&
      text(x.directory)
    );
  if (x.kind === 'filer-entry')
    return (
      shape(x, ['kind', ...storageKeys, 'metadataStoreId', 'path', 'entryRevisionSha256']) &&
      storage(x) &&
      text(x.metadataStoreId, 256) &&
      text(x.path) &&
      hash(x.entryRevisionSha256)
    );
  if (x.kind === 'physical-catalog')
    return shape(x, ['kind', ...storageKeys, 'pvUid']) && storage(x) && text(x.pvUid, 128);
  if (x.kind === 'physical-file')
    return (
      shape(x, ['kind', ...storageKeys, 'pvUid', 'nativeFileIdSha256']) &&
      storage(x) &&
      text(x.pvUid, 128) &&
      hash(x.nativeFileIdSha256)
    );
  return (
    x.kind === 'volume' &&
    shape(x, [
      'kind',
      ...storageKeys,
      'collection',
      'volumeId',
      'replicaId',
      'pvUid',
      'nativeFileIdSha256',
    ]) &&
    storage(x) &&
    volume(x) &&
    hash(x.nativeFileIdSha256)
  );
}
export function isHistoryCursor(v: unknown): v is FileHistoryCursor {
  if (v === null) return true;
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  if (x.kind === 'mongo-id')
    return (
      shape(x, ['kind', 'idType', 'value']) &&
      text(x.value) &&
      (x.idType === 'string' ||
        (x.idType === 'object-id' && /^[a-f0-9]{24}$/.test(String(x.value))))
    );
  if (x.kind === 's3-objects')
    return shape(x, ['kind', 'continuationToken']) && text(x.continuationToken, 8192);
  if (x.kind === 's3-versions')
    return (
      shape(x, ['kind', 'keyMarker', 'versionIdMarker']) &&
      marker(x.keyMarker) &&
      (x.versionIdMarker === null || marker(x.versionIdMarker))
    );
  if (x.kind === 's3-uploads')
    return (
      shape(x, ['kind', 'keyMarker', 'uploadIdMarker']) &&
      marker(x.keyMarker) &&
      (x.uploadIdMarker === null || marker(x.uploadIdMarker))
    );
  if (x.kind === 's3-parts')
    return (
      shape(x, ['kind', 'partNumberMarker']) &&
      integer(x.partNumberMarker) &&
      x.partNumberMarker <= 10000
    );
  if (x.kind === 'filer') return shape(x, ['kind', 'lastEntry']) && marker(x.lastEntry);
  if (x.kind === 'manifest-edges')
    return (
      shape(x, ['kind', 'entryRevisionSha256', 'resolvedManifestSetSha256', 'edgeIndex']) &&
      hash(x.entryRevisionSha256) &&
      hash(x.resolvedManifestSetSha256) &&
      integer(x.edgeIndex)
    );
  if (x.kind === 'physical-catalog')
    return (
      shape(x, ['kind', 'sourceSha256', 'afterPath']) &&
      hash(x.sourceSha256) &&
      (x.afterPath === null || formatFilePath(x.afterPath))
    );
  if (x.kind === 'physical-file')
    return (
      shape(x, ['kind', 'sourceRevision', 'offsetBytes']) &&
      hash(x.sourceRevision) &&
      integer(x.offsetBytes)
    );
  if (x.kind === 'volume-data')
    return (
      shape(x, ['kind', 'offsetBytes', 'compactRevision', 'dataFileBytes']) &&
      integer(x.offsetBytes) &&
      integer(x.dataFileBytes) &&
      x.offsetBytes <= x.dataFileBytes &&
      revision(x.compactRevision)
    );
  return (
    x.kind === 'volume-index' &&
    shape(x, ['kind', 'offsetBytes', 'compactRevision', 'indexFileBytes']) &&
    integer(x.offsetBytes) &&
    integer(x.indexFileBytes) &&
    x.offsetBytes <= x.indexFileBytes &&
    revision(x.compactRevision)
  );
}
export function isHistoryPosition(v: unknown): v is FileHistoryPosition {
  if (
    !shape(v, ['stream', 'scope', 'cursor']) ||
    !streams.includes(String(v.stream)) ||
    !isHistoryScope(v.scope) ||
    !isHistoryCursor(v.cursor)
  )
    return false;
  const { stream, scope, cursor } = v;
  if (scope.kind === 'storage-catalog')
    return stream !== 'uploads' && stream !== 'verification' && cursor === null;
  if (scope.kind === 'mongo')
    return (
      ['uploads', 'verification'].includes(String(stream)) &&
      (cursor === null ||
        (cursor.kind === 'mongo-id' &&
          cursor.idType === (scope.collection === 'files' ? 'object-id' : 'string')))
    );
  const matrix: Record<string, readonly [string, string][]> = {
    's3-catalog': [['bucket-catalog', 'none']],
    's3-bucket': [
      ['current-objects', 's3-objects'],
      ['versions', 's3-versions'],
      ['delete-markers', 's3-versions'],
      ['multipart-uploads', 's3-uploads'],
    ],
    's3-upload': [['multipart-parts', 's3-parts']],
    filer: [
      ['bucket-catalog', 'filer'],
      ['filer-entries', 'filer'],
    ],
    'filer-entry': [['manifest-edges', 'manifest-edges']],
    'physical-catalog': [['physical-catalog', 'physical-catalog']],
    'physical-file': [['physical-file', 'physical-file']],
    volume: [
      ['volume-data', 'volume-data'],
      ['volume-index', 'volume-index'],
    ],
  };
  return (
    (matrix[scope.kind] ?? []).some(
      ([s, c]) => stream === s && (cursor === null || cursor.kind === c),
    ) &&
    !(scope.kind === 's3-catalog' && cursor !== null) &&
    !(
      scope.kind === 'filer-entry' &&
      cursor?.kind === 'manifest-edges' &&
      scope.entryRevisionSha256 !== cursor.entryRevisionSha256
    )
  );
}
function principal(v: unknown): boolean {
  return (
    (shape(v, ['kind', 'tenantId', 'userId']) &&
      v.kind === 'resolved' &&
      tenant(v.tenantId) &&
      text(v.userId, 128)) ||
    (shape(v, ['kind', 'rawSha256']) && v.kind === 'unresolved' && hash(v.rawSha256))
  );
}
function owner(v: unknown): boolean {
  if (
    shape(v, ['kind']) &&
    ['unresolved', 'storage-format', 'storage-allocation'].includes(String(v.kind))
  )
    return true;
  if (shape(v, ['kind', 'fixtureId', 'bindingSha256']))
    return v.kind === 'platform-fixture' && text(v.fixtureId, 256) && hash(v.bindingSha256);
  if (shape(v, ['kind', 'storeId', 'tenantId', 'userId', 'fileId', 'revision']))
    return (
      v.kind === 'file' &&
      text(v.storeId, 128) &&
      tenant(v.tenantId) &&
      text(v.userId, 128) &&
      text(v.fileId, 256) &&
      integer(v.revision)
    );
  return (
    shape(v, [
      'kind',
      'storeId',
      'tenantId',
      'userId',
      'operationId',
      'generation',
      'custodyIdentitySha256',
    ]) &&
    v.kind === 'upload' &&
    text(v.storeId, 128) &&
    tenant(v.tenantId) &&
    text(v.userId, 128) &&
    text(v.operationId, 128) &&
    integer(v.generation) &&
    hash(v.custodyIdentitySha256)
  );
}
function identity(v: unknown, kind: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  if (x.component !== kind) return false;
  if (x.domain === 'mongo')
    return (
      shape(x, [
        'domain',
        'storeId',
        'collection',
        'idType',
        'persistedId',
        'principal',
        'revision',
        'generation',
        'component',
      ]) &&
      text(x.storeId, 128) &&
      principal(x.principal) &&
      maybeInteger(x.revision) &&
      maybeInteger(x.generation) &&
      isHistoryCursor({ kind: 'mongo-id', idType: x.idType, value: x.persistedId }) &&
      ((kind === 'file' && x.collection === 'files' && x.idType === 'object-id') ||
        (kind === 'fileJob' && x.collection === 'file-jobs' && x.idType === 'string') ||
        (kind === 'upload' && x.collection === 'uploads' && x.idType === 'string'))
    );
  if (!storage(x)) return false;
  if (x.domain === 'physical-file')
    return (
      shape(x, ['domain', ...storageKeys, 'pvUid', 'nativeFileIdSha256', 'component']) &&
      ['physicalFile', 'physicalAllocation'].includes(String(kind)) &&
      text(x.pvUid, 128) &&
      hash(x.nativeFileIdSha256)
    );
  if (x.domain === 'physical-path')
    return (
      shape(x, ['domain', ...storageKeys, 'pvUid', 'relativePath', 'component']) &&
      kind === 'physicalAlias' &&
      text(x.pvUid, 128) &&
      (x.relativePath === null || formatFilePath(x.relativePath))
    );
  if (x.domain === 'physical-extent')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'pvUid',
        'nativeFileIdSha256',
        'offsetBytes',
        'component',
      ]) &&
      ['physicalRecord', 'physicalOverhead'].includes(String(kind)) &&
      text(x.pvUid, 128) &&
      hash(x.nativeFileIdSha256) &&
      integer(x.offsetBytes)
    );
  if (x.domain === 'bucket')
    return (
      shape(x, ['domain', ...storageKeys, 'bucket', 'component']) &&
      kind === 'bucket' &&
      text(x.bucket, 255)
    );
  if (x.domain === 'object') {
    const version = x.version;
    return (
      shape(x, ['domain', ...storageKeys, 'bucket', 'key', 'version', 'component']) &&
      text(x.bucket, 255) &&
      text(x.key) &&
      ['object', 'objectAlias', 'version', 'deleteMarker'].includes(String(kind)) &&
      ((shape(version, ['kind']) &&
        ['unversioned', 'null-version'].includes(String(version.kind))) ||
        (shape(version, ['kind', 'versionId']) &&
          version.kind === 'version' &&
          text(version.versionId))) &&
      !(kind === 'object' && (version as { kind: string }).kind !== 'unversioned') &&
      !(kind !== 'object' && (version as { kind: string }).kind === 'unversioned')
    );
  }
  if (x.domain === 'multipart')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'bucket',
        'key',
        'uploadId',
        'partNumber',
        'component',
      ]) &&
      text(x.bucket, 255) &&
      text(x.key) &&
      text(x.uploadId) &&
      ((kind === 'multipartUpload' && x.partNumber === null) ||
        (kind === 'multipartPart' &&
          integer(x.partNumber) &&
          x.partNumber >= 1 &&
          x.partNumber <= 10000))
    );
  if (x.domain === 'filer')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'metadataStoreId',
        'path',
        'entryRevisionSha256',
        'edgeIndex',
        'component',
      ]) &&
      text(x.metadataStoreId, 256) &&
      text(x.path) &&
      hash(x.entryRevisionSha256) &&
      ((kind === 'filerEntry' && x.edgeIndex === null) ||
        (kind === 'manifestEdge' && integer(x.edgeIndex)))
    );
  if (x.domain === 'format')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'collection',
        'volumeId',
        'replicaId',
        'pvUid',
        'compactRevision',
        'fileRelativePath',
        'offsetBytes',
        'component',
      ]) &&
      volume(x) &&
      revision(x.compactRevision) &&
      formatFilePath(x.fileRelativePath) &&
      integer(x.offsetBytes) &&
      kind === 'physicalOverhead'
    );
  if (x.domain === 'index')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'collection',
        'volumeId',
        'replicaId',
        'pvUid',
        'compactRevision',
        'indexOffsetBytes',
        'needleId',
        'component',
      ]) &&
      volume(x) &&
      revision(x.compactRevision) &&
      integer(x.indexOffsetBytes) &&
      kind === 'indexRecord' &&
      typeof x.needleId === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(x.needleId) &&
      BigInt(x.needleId) <= BigInt('18446744073709551615')
    );
  if (x.domain === 'volume')
    return (
      shape(x, [
        'domain',
        ...storageKeys,
        'collection',
        'volumeId',
        'replicaId',
        'pvUid',
        'compactRevision',
        'component',
      ]) &&
      volume(x) &&
      revision(x.compactRevision) &&
      kind === 'physicalReplica'
    );
  return (
    x.domain === 'needle' &&
    shape(x, [
      'domain',
      ...storageKeys,
      'collection',
      'volumeId',
      'needleId',
      'cookieHex',
      'replicaId',
      'pvUid',
      'offsetBytes',
      'compactRevision',
      'component',
    ]) &&
    volume(x) &&
    revision(x.compactRevision) &&
    integer(x.offsetBytes) &&
    typeof x.needleId === 'string' &&
    /^(0|[1-9][0-9]{0,19})$/.test(x.needleId) &&
    BigInt(x.needleId) <= BigInt('18446744073709551615') &&
    typeof x.cookieHex === 'string' &&
    /^[a-f0-9]{8}$/.test(x.cookieHex) &&
    ['logicalChunk', 'physicalRecord'].includes(String(kind))
  );
}
export function isHistoryEntry(v: unknown): v is FileHistoryEntry {
  if (
    !shape(v, [
      'kind',
      'identity',
      'sourceRevision',
      'owner',
      'disposition',
      'measuredBytes',
      'reservedBytes',
      'referenceIdentitySha256',
    ]) ||
    !FILE_HISTORY_KINDS.includes(v.kind as never) ||
    !identity(v.identity, v.kind) ||
    !hash(v.sourceRevision) ||
    !owner(v.owner) ||
    !FILE_HISTORY_DISPOSITIONS.includes(v.disposition as never) ||
    !maybeInteger(v.measuredBytes) ||
    !maybeInteger(v.reservedBytes) ||
    !Array.isArray(v.referenceIdentitySha256) ||
    v.referenceIdentitySha256.length > FILE_HISTORY_LIMITS.entries ||
    !v.referenceIdentitySha256.every(hash) ||
    new Set(v.referenceIdentitySha256).size !== v.referenceIdentitySha256.length
  )
    return false;
  const entry = v as FileHistoryEntry;
  if (entry.owner.kind === 'storage-format') {
    if (
      entry.kind !== 'physicalOverhead' ||
      entry.disposition !== 'retained-owned' ||
      !integer(entry.measuredBytes) ||
      entry.reservedBytes !== 0
    )
      return false;
    if (
      entry.identity.domain === 'format'
        ? entry.referenceIdentitySha256.length !== 0
        : entry.identity.domain !== 'physical-extent' ||
          !same(entry.referenceIdentitySha256, [physicalFileReference(entry.identity)])
    )
      return false;
  }
  if (entry.owner.kind === 'storage-allocation') {
    if (['bucket', 'indexRecord', 'physicalReplica', 'filerEntry'].includes(entry.kind)) {
      if (entry.measuredBytes !== 0 || entry.reservedBytes !== 0) return false;
    } else if (
      !['physicalFile', 'physicalAllocation', 'physicalAlias'].includes(entry.kind) ||
      !integer(entry.measuredBytes) ||
      entry.reservedBytes !== 0
    )
      return false;
  }
  if (
    entry.kind === 'physicalOverhead' &&
    entry.identity.domain === 'format' &&
    entry.referenceIdentitySha256.length !== 0
  )
    return false;
  if (['physicalFile', 'physicalAllocation'].includes(entry.kind) && entry.reservedBytes !== 0)
    return false;
  if (
    ['physicalAlias', 'physicalReplica'].includes(entry.kind) &&
    (entry.measuredBytes !== 0 ||
      entry.reservedBytes !== 0 ||
      entry.referenceIdentitySha256.length !== 1)
  )
    return false;
  if (
    entry.kind === 'physicalAllocation' &&
    entry.disposition === 'absent-and-consumed' &&
    entry.measuredBytes !== 0
  )
    return false;
  if (
    entry.kind === 'physicalOverhead' &&
    entry.owner.kind !== 'storage-format' &&
    !(entry.owner.kind === 'unresolved' && entry.disposition === 'unclassified')
  )
    return false;
  if (entry.owner.kind === 'unresolved' && entry.disposition === 'retained-owned') return false;
  if (
    ['objectAlias', 'indexRecord'].includes(entry.kind) &&
    (entry.measuredBytes !== 0 || entry.reservedBytes !== 0)
  )
    return false;
  return true;
}
function entryInScope(entry: FileHistoryEntry, position: FileHistoryPosition): boolean {
  const { identity: i } = entry,
    { scope, stream } = position;
  if (scope.kind === 'mongo')
    return i.domain === 'mongo' && i.storeId === scope.storeId && i.collection === scope.collection;
  if (scope.kind === 'storage-catalog') return false;
  if (
    i.domain === 'mongo' ||
    i.storageDeploymentId !== scope.storageDeploymentId ||
    i.storageStoreId !== scope.storageStoreId
  )
    return false;
  if (scope.kind === 'physical-catalog')
    return (
      (i.domain === 'physical-file' || i.domain === 'physical-path') && i.pvUid === scope.pvUid
    );
  if (scope.kind === 'physical-file')
    return (
      ((i.domain === 'physical-extent' && i.nativeFileIdSha256 === scope.nativeFileIdSha256) ||
        i.domain === 'format') &&
      i.pvUid === scope.pvUid
    );
  if (scope.kind === 's3-catalog') return i.domain === 'bucket';
  if (scope.kind === 's3-bucket')
    return (
      (i.domain === 'object' || i.domain === 'multipart') &&
      i.bucket === scope.bucket &&
      (
        {
          'current-objects': ['object', 'objectAlias'],
          versions: ['version'],
          'delete-markers': ['deleteMarker'],
          'multipart-uploads': ['multipartUpload'],
        } as Record<string, string[]>
      )[stream]?.includes(entry.kind) === true
    );
  if (scope.kind === 's3-upload')
    return (
      i.domain === 'multipart' &&
      entry.kind === 'multipartPart' &&
      i.bucket === scope.bucket &&
      i.key === scope.key &&
      i.uploadId === scope.uploadId
    );
  if (scope.kind === 'filer' || scope.kind === 'filer-entry')
    return (
      i.domain === 'filer' &&
      i.metadataStoreId === scope.metadataStoreId &&
      (scope.kind === 'filer'
        ? entry.kind === 'filerEntry'
        : entry.kind === 'manifestEdge' &&
          i.path === scope.path &&
          i.entryRevisionSha256 === scope.entryRevisionSha256)
    );
  if (
    entry.kind === 'physicalReplica' &&
    !same(entry.referenceIdentitySha256, [physicalFileReference(scope)])
  )
    return false;
  if (
    entry.kind === 'indexRecord' &&
    !entry.referenceIdentitySha256.includes(physicalFileReference(scope))
  )
    return false;
  return (
    ((stream === 'volume-index' && (i.domain === 'index' || i.domain === 'format')) ||
      (stream === 'volume-data' &&
        (i.domain === 'needle' || i.domain === 'volume' || i.domain === 'format'))) &&
    i.collection === scope.collection &&
    i.volumeId === scope.volumeId &&
    i.replicaId === scope.replicaId &&
    i.pvUid === scope.pvUid
  );
}
export function readHistoryPage(v: unknown): FileHistoryPage | null {
  try {
    if (
      !boundedHistoryData(v) ||
      !shape(v, [
        'runSha256',
        'round',
        'stream',
        'scope',
        'cursor',
        'nextCursor',
        'eof',
        'entries',
        'pageSha256',
      ]) ||
      !hash(v.runSha256) ||
      !integer(v.round) ||
      !hash(v.pageSha256) ||
      typeof v.eof !== 'boolean' ||
      !isHistoryPosition({ stream: v.stream, scope: v.scope, cursor: v.cursor }) ||
      !isHistoryPosition({ stream: v.stream, scope: v.scope, cursor: v.nextCursor }) ||
      !Array.isArray(v.entries) ||
      v.entries.length > FILE_HISTORY_LIMITS.entries ||
      !v.entries.every(isHistoryEntry) ||
      (v.eof ? v.nextCursor !== null : v.nextCursor === null || same(v.cursor, v.nextCursor))
    )
      return null;
    const position = { stream: v.stream, scope: v.scope, cursor: v.cursor } as FileHistoryPosition;
    if (position.scope.kind === 'storage-catalog' && (!v.eof || v.entries.length !== 0))
      return null;
    if (
      !v.entries.every((entry) => entryInScope(entry, position)) ||
      new Set(v.entries.map((entry) => digest(entry.identity))).size !== v.entries.length
    )
      return null;
    if (position.scope.kind === 'mongo') {
      let previous = position.cursor?.kind === 'mongo-id' ? position.cursor.value : null;
      for (const entry of v.entries) {
        if (entry.identity.domain !== 'mongo') return null;
        const current = entry.identity.persistedId;
        if (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(current)) >= 0)
          return null;
        previous = current;
      }
      if (
        !v.eof &&
        (v.nextCursor as FileHistoryCursor)?.kind === 'mongo-id' &&
        (v.nextCursor as Extract<FileHistoryCursor, { kind: 'mongo-id' }>).value !== previous
      )
        return null;
    }
    if (position.scope.kind === 'physical-catalog') {
      let previous: string | null | undefined =
        position.cursor?.kind === 'physical-catalog' ? position.cursor.afterPath : undefined;
      const aliases = v.entries.filter((entry) => entry.identity.domain === 'physical-path');
      if (previous === undefined && aliases[0]?.identity.domain !== 'physical-path') return null;
      for (const entry of aliases) {
        if (entry.identity.domain !== 'physical-path') return null;
        const path = entry.identity.relativePath;
        if (
          previous === undefined
            ? path !== null
            : path === null ||
              (previous !== null && Buffer.compare(Buffer.from(previous), Buffer.from(path)) >= 0)
        )
          return null;
        previous = path;
      }
      if (!v.eof && (v.nextCursor as FileHistoryCursor)?.kind === 'physical-catalog') {
        const next = v.nextCursor as Extract<FileHistoryCursor, { kind: 'physical-catalog' }>;
        if (
          next.afterPath !== previous ||
          (position.cursor?.kind === 'physical-catalog' &&
            next.sourceSha256 !== position.cursor.sourceSha256)
        )
          return null;
      }
    }
    if (position.scope.kind === 'volume' && position.stream === 'volume-data') {
      const cursor = position.cursor?.kind === 'volume-data' ? position.cursor : null;
      let offset = cursor?.offsetBytes ?? 0;
      for (const entry of v.entries) {
        if (entry.kind !== 'physicalRecord' && entry.kind !== 'physicalOverhead') continue;
        const i = entry.identity;
        if (
          (i.domain !== 'needle' && i.domain !== 'format') ||
          i.offsetBytes !== offset ||
          !integer(entry.measuredBytes) ||
          !integer(offset + entry.measuredBytes)
        )
          return null;
        offset += entry.measuredBytes;
      }
      if (
        v.eof
          ? cursor !== null && offset !== cursor.dataFileBytes
          : (v.nextCursor as FileHistoryCursor)?.kind !== 'volume-data'
      )
        return null;
      if (!v.eof) {
        const next = v.nextCursor as Extract<FileHistoryCursor, { kind: 'volume-data' }>;
        if (
          next.offsetBytes !== offset ||
          (cursor !== null &&
            (next.dataFileBytes !== cursor.dataFileBytes ||
              next.compactRevision !== cursor.compactRevision))
        )
          return null;
      }
    }
    if (position.scope.kind === 'physical-file') {
      let offset = position.cursor?.kind === 'physical-file' ? position.cursor.offsetBytes : 0;
      for (const entry of v.entries) {
        const i = entry.identity;
        if (
          (i.domain !== 'physical-extent' && i.domain !== 'format') ||
          i.offsetBytes !== offset ||
          !integer(entry.measuredBytes) ||
          !integer(offset + entry.measuredBytes)
        )
          return null;
        offset += entry.measuredBytes;
      }
      if (
        !v.eof &&
        ((v.nextCursor as FileHistoryCursor)?.kind !== 'physical-file' ||
          (v.nextCursor as Extract<FileHistoryCursor, { kind: 'physical-file' }>).offsetBytes !==
            offset ||
          (position.cursor?.kind === 'physical-file' &&
            (v.nextCursor as Extract<FileHistoryCursor, { kind: 'physical-file' }>)
              .sourceRevision !== position.cursor.sourceRevision))
      )
        return null;
    }
    const { pageSha256, ...body } = v;
    return digest(body) === pageSha256 ? (v as FileHistoryPage) : null;
  } catch {
    return null;
  }
}
export function isHistoryAccounting(v: unknown): v is FileHistoryAccounting {
  return (
    shape(v, ['counts', 'bytes', 'blockers']) &&
    shape(v.counts, countKeys) &&
    Object.values(v.counts).every(integer) &&
    shape(v.bytes, FILE_HISTORY_BYTE_KEYS) &&
    Object.values(v.bytes).every(maybeInteger) &&
    shape(v.blockers, FILE_HISTORY_BLOCKER_KEYS) &&
    Object.values(v.blockers).every(integer) &&
    integer(
      kindCountKeys.reduce((n, k) => n + Number((v.counts as Record<string, unknown>)[k]), 0),
    ) &&
    kindCountKeys.reduce((n, k) => n + Number((v.counts as Record<string, unknown>)[k]), 0) ===
      dispositionCounts.reduce((n, k) => n + Number((v.counts as Record<string, unknown>)[k]), 0) &&
    (!Object.values(v.bytes).includes(null) || Number(v.counts.unknownSizeCount) > 0)
  );
}
export function isHistorySummary(v: unknown): v is FileHistorySummary {
  if (
    !boundedHistoryData(v) ||
    !shape(v, [
      'round',
      'lane',
      'checkpoint',
      'sourceBindingSha256',
      'storageBindingSha256',
      'active',
      'foldSha256',
      'lastPage',
      'counts',
      'bytes',
      'blockers',
      'sampleIdentitySha256',
    ]) ||
    !integer(v.round) ||
    !integer(v.checkpoint) ||
    !['uploads', 'storage', 'join', 'verify-uploads', 'verify-storage', 'ready'].includes(
      String(v.lane),
    ) ||
    !hash(v.sourceBindingSha256) ||
    !hash(v.storageBindingSha256) ||
    !hash(v.foldSha256) ||
    !isHistoryPosition(v.active) ||
    !isHistoryAccounting({ counts: v.counts, bytes: v.bytes, blockers: v.blockers }) ||
    !Array.isArray(v.sampleIdentitySha256) ||
    v.sampleIdentitySha256.length > FILE_HISTORY_LIMITS.sample ||
    !v.sampleIdentitySha256.every(hash)
  )
    return false;
  if (v.lane === 'ready' && !sealablePhysicalAccounting(v as FileHistorySummary)) return false;
  return v.lastPage === null
    ? v.checkpoint === 0 && v.lane === 'uploads'
    : shape(v.lastPage, ['inputSha256', 'checkpointBefore', 'checkpointAfter', 'pageSha256']) &&
        hash(v.lastPage.inputSha256) &&
        hash(v.lastPage.pageSha256) &&
        integer(v.lastPage.checkpointBefore) &&
        integer(v.lastPage.checkpointAfter) &&
        v.lastPage.checkpointAfter === v.checkpoint &&
        v.lastPage.checkpointAfter === v.lastPage.checkpointBefore + 1;
}
export function readHistoryStorageBinding(v: unknown): FileHistoryStorageBinding | null {
  return boundedHistoryData(v) &&
    shape(v, [
      'storageBindingSha256',
      'providerBindingSha256',
      'cohortSha256',
      'round',
      'priorRoundSettlementSha256',
      'gateways',
      'initial',
    ]) &&
    hash(v.storageBindingSha256) &&
    hash(v.providerBindingSha256) &&
    hash(v.cohortSha256) &&
    integer(v.round) &&
    (v.round === 0 ? v.priorRoundSettlementSha256 === null : hash(v.priorRoundSettlementSha256)) &&
    Array.isArray(v.gateways) &&
    v.gateways.length === 2 &&
    v.gateways.every(hash) &&
    v.gateways[0] !== v.gateways[1] &&
    isHistoryPosition(v.initial) &&
    v.initial.stream === 'bucket-catalog' &&
    v.initial.cursor === null &&
    v.initial.scope.kind !== 'mongo'
    ? (v as FileHistoryStorageBinding)
    : null;
}
export function readHistoryStorageReply(v: unknown): FileHistoryStorageReply | null {
  if (
    !boundedHistoryData(v) ||
    !shape(v, ['page', 'next', 'inputSha256', 'storageBindingSha256', 'complete']) ||
    !readHistoryPage(v.page) ||
    !hash(v.inputSha256) ||
    !hash(v.storageBindingSha256) ||
    (v.next !== null && !isHistoryPosition(v.next))
  )
    return null;
  if (v.complete === null) return v.next !== null ? (v as FileHistoryStorageReply) : null;
  const c = v.complete;
  return v.next === null &&
    shape(c, [
      'mongoFoldSha256',
      'identityFoldSha256',
      'gatewayPopulationSha256',
      'filePhysicalBytes',
      'allocatedPhysicalBytes',
      'blockers',
    ]) &&
    hash(c.mongoFoldSha256) &&
    hash(c.identityFoldSha256) &&
    Array.isArray(c.gatewayPopulationSha256) &&
    c.gatewayPopulationSha256.length === 2 &&
    c.gatewayPopulationSha256.every(hash) &&
    integer(c.filePhysicalBytes) &&
    integer(c.allocatedPhysicalBytes) &&
    shape(c.blockers, FILE_HISTORY_BLOCKER_KEYS) &&
    Object.values(c.blockers).every(integer)
    ? (v as FileHistoryStorageReply)
    : null;
}
export function readHistoryMongoAcknowledgement(
  v: unknown,
): FileHistoryMongoAcknowledgement | null {
  return boundedHistoryData(v) &&
    shape(v, ['inputSha256', 'pageSha256', 'sourceBindingSha256', 'storageBindingSha256']) &&
    Object.values(v).every(hash)
    ? (v as FileHistoryMongoAcknowledgement)
    : null;
}
