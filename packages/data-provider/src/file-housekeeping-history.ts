/** Closed historical source coordinates for the existing File/HK contract; never seal authority. */
export type FileHistoryStream =
  | 'uploads'
  | 'bucket-catalog'
  | 'current-objects'
  | 'versions'
  | 'delete-markers'
  | 'multipart-uploads'
  | 'multipart-parts'
  | 'filer-entries'
  | 'manifest-edges'
  | 'physical-catalog'
  | 'physical-file'
  | 'volume-index'
  | 'volume-data'
  | 'verification';

/** All numeric coordinates require nonnegative safe-integer validation before use. */
type StorageIdentity = Readonly<{ storageDeploymentId: string; storageStoreId: string }>;

export type FileHistoryScope =
  | Readonly<{
      kind: 'mongo';
      storeId: string;
      collection: 'files' | 'file-jobs' | 'uploads';
      collectionUuid: string;
    }>
  | (StorageIdentity & Readonly<{ kind: 's3-catalog' }>)
  | (StorageIdentity & Readonly<{ kind: 'storage-catalog' }>)
  | (StorageIdentity & Readonly<{ kind: 's3-bucket'; bucket: string }>)
  | (StorageIdentity &
      Readonly<{ kind: 's3-upload'; bucket: string; key: string; uploadId: string }>)
  | (StorageIdentity & Readonly<{ kind: 'filer'; metadataStoreId: string; directory: string }>)
  | (StorageIdentity &
      Readonly<{
        kind: 'filer-entry';
        metadataStoreId: string;
        path: string;
        entryRevisionSha256: string;
      }>)
  | (StorageIdentity & Readonly<{ kind: 'physical-catalog'; pvUid: string }>)
  | (StorageIdentity &
      Readonly<{ kind: 'physical-file'; pvUid: string; nativeFileIdSha256: string }>)
  | (StorageIdentity &
      Readonly<{
        kind: 'volume';
        collection: string;
        volumeId: number; // uint32
        replicaId: string; // exact native replica-identity SHA-256
        pvUid: string;
        nativeFileIdSha256: string; // actual file read by this volume-data/index scope
      }>);

/** Null is the first/empty coordinate, never an omitted or invented continuation marker.
 * Current admitted S3 ListBuckets has no token: its entire bounded catalog or incomplete only.
 * Preserve opaque marker/key/path bytes; an unsupported encoding remains incomplete.
 */
export type FileHistoryCursor =
  | null
  | Readonly<{ kind: 'mongo-id'; idType: 'object-id' | 'string'; value: string }>
  | Readonly<{ kind: 's3-objects'; continuationToken: string }>
  | Readonly<{ kind: 's3-versions'; keyMarker: string; versionIdMarker: string | null }>
  | Readonly<{ kind: 's3-uploads'; keyMarker: string; uploadIdMarker: string | null }>
  | Readonly<{ kind: 's3-parts'; partNumberMarker: number }>
  | Readonly<{ kind: 'filer'; lastEntry: string }>
  | Readonly<{ kind: 'physical-catalog'; sourceSha256: string; afterPath: string | null }>
  | Readonly<{ kind: 'physical-file'; sourceRevision: string; offsetBytes: number }>
  | Readonly<{
      kind: 'manifest-edges';
      entryRevisionSha256: string;
      resolvedManifestSetSha256: string;
      edgeIndex: number; // ordinal in the exact deterministic flattened reference order
    }>
  | Readonly<{
      kind: 'volume-data';
      offsetBytes: number;
      compactRevision: number; // uint16
      dataFileBytes: number;
    }>
  | Readonly<{
      kind: 'volume-index';
      offsetBytes: number;
      compactRevision: number; // uint16
      indexFileBytes: number;
    }>;

export const FILE_HISTORY_LIMITS = { entries: 32, pageBytes: 65536, sample: 16 } as const;
export const FILE_HISTORY_KINDS = [
  'file',
  'fileJob',
  'upload',
  'bucket',
  'object',
  'objectAlias',
  'version',
  'deleteMarker',
  'multipartUpload',
  'multipartPart',
  'physicalFile',
  'physicalAllocation',
  'physicalAlias',
  'filerEntry',
  'manifestEdge',
  'logicalChunk',
  'indexRecord',
  'physicalRecord',
  'physicalReplica',
  'physicalOverhead',
] as const;
export type FileHistoryKind = (typeof FILE_HISTORY_KINDS)[number];
/** Existing counters keep their names; new physical population counters are plural only. */
export const FILE_HISTORY_KIND_COUNTS = {
  file: 'file',
  fileJob: 'fileJob',
  upload: 'upload',
  bucket: 'bucket',
  object: 'object',
  objectAlias: 'objectAlias',
  version: 'version',
  deleteMarker: 'deleteMarker',
  multipartUpload: 'multipartUpload',
  multipartPart: 'multipartPart',
  filerEntry: 'filerEntry',
  manifestEdge: 'manifestEdge',
  logicalChunk: 'logicalChunk',
  indexRecord: 'indexRecord',
  physicalRecord: 'physicalRecord',
  physicalReplica: 'physicalReplica',
  physicalOverhead: 'physicalOverhead',
  physicalFile: 'physicalFiles',
  physicalAllocation: 'physicalAllocations',
  physicalAlias: 'physicalAliases',
} as const;

export const FILE_HISTORY_DISPOSITIONS = [
  'retained-owned',
  'deletion-required',
  'deletion-in-flight',
  'logically-absent-physical-pending',
  'absent-and-consumed',
  'unclassified',
] as const;
export type FileHistoryDisposition = (typeof FILE_HISTORY_DISPOSITIONS)[number];
export type FileHistoryPrincipal =
  | Readonly<{ kind: 'resolved'; tenantId: string | null; userId: string }>
  | Readonly<{ kind: 'unresolved'; rawSha256: string }>;
export type FileHistoryVersion =
  | Readonly<{ kind: 'unversioned' | 'null-version' }>
  | Readonly<{ kind: 'version'; versionId: string }>;
/** Authenticated same-round native inode identity; paths never define file identity. */
export type FileHistoryFileIdentity = StorageIdentity &
  Readonly<{
    domain: 'physical-file';
    pvUid: string;
    nativeFileIdSha256: string;
    component: 'physicalFile' | 'physicalAllocation';
  }>;
export type FileHistoryPathIdentity = StorageIdentity &
  Readonly<{
    domain: 'physical-path';
    pvUid: string;
    relativePath: string | null;
    component: 'physicalAlias';
  }>;
export type FileHistoryExtentIdentity = StorageIdentity &
  Readonly<{
    domain: 'physical-extent';
    pvUid: string;
    nativeFileIdSha256: string;
    offsetBytes: number;
    component: 'physicalRecord' | 'physicalOverhead';
  }>;
export type FileHistoryIdentity =
  | FileHistoryFileIdentity
  | FileHistoryPathIdentity
  | FileHistoryExtentIdentity
  | Readonly<{
      domain: 'mongo';
      storeId: string;
      collection: 'files' | 'file-jobs' | 'uploads';
      idType: 'object-id' | 'string';
      persistedId: string;
      principal: FileHistoryPrincipal;
      revision: number | null;
      generation: number | null;
      component: FileHistoryKind;
    }>
  | (StorageIdentity & Readonly<{ domain: 'bucket'; bucket: string; component: 'bucket' }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'object';
        bucket: string;
        key: string;
        version: FileHistoryVersion;
        component: 'object' | 'objectAlias' | 'version' | 'deleteMarker';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'multipart';
        bucket: string;
        key: string;
        uploadId: string;
        partNumber: number | null;
        component: 'multipartUpload' | 'multipartPart';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'filer';
        metadataStoreId: string;
        path: string;
        entryRevisionSha256: string;
        edgeIndex: number | null;
        component: 'filerEntry' | 'manifestEdge';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'needle';
        collection: string;
        volumeId: number;
        needleId: string;
        cookieHex: string;
        replicaId: string;
        pvUid: string;
        offsetBytes: number;
        compactRevision: number;
        component: 'logicalChunk' | 'physicalRecord';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'format';
        collection: string;
        volumeId: number;
        replicaId: string;
        pvUid: string;
        compactRevision: number;
        fileRelativePath: string;
        offsetBytes: number;
        component: 'physicalOverhead';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'index';
        collection: string;
        volumeId: number;
        replicaId: string;
        pvUid: string;
        compactRevision: number;
        indexOffsetBytes: number;
        needleId: string;
        component: 'indexRecord';
      }>)
  | (StorageIdentity &
      Readonly<{
        domain: 'volume';
        collection: string;
        volumeId: number;
        replicaId: string;
        pvUid: string;
        compactRevision: number;
        component: 'physicalReplica';
      }>);
export type FileHistoryOwner =
  | Readonly<{
      kind: 'file';
      storeId: string;
      tenantId: string | null;
      userId: string;
      fileId: string;
      revision: number;
    }>
  | Readonly<{
      kind: 'upload';
      storeId: string;
      tenantId: string | null;
      userId: string;
      operationId: string;
      generation: number;
      custodyIdentitySha256: string;
    }>
  | Readonly<{ kind: 'platform-fixture'; fixtureId: string; bindingSha256: string }>
  | Readonly<{ kind: 'storage-format' }>
  | Readonly<{ kind: 'storage-allocation' }>
  | Readonly<{ kind: 'unresolved' }>;
export type FileHistoryEntry = Readonly<{
  kind: FileHistoryKind;
  identity: FileHistoryIdentity;
  sourceRevision: string; // SHA-256 of the exact typed source observation, never ETag authority.
  owner: FileHistoryOwner;
  disposition: FileHistoryDisposition;
  measuredBytes: number | null;
  reservedBytes: number | null;
  referenceIdentitySha256: readonly string[];
}>;
export type FileHistoryPage = Readonly<{
  runSha256: string;
  round: number;
  stream: FileHistoryStream;
  scope: FileHistoryScope;
  cursor: FileHistoryCursor;
  nextCursor: FileHistoryCursor;
  eof: boolean;
  entries: readonly FileHistoryEntry[];
  pageSha256: string;
}>;
export type FileHistoryCounts = Record<
  (typeof FILE_HISTORY_KIND_COUNTS)[FileHistoryKind],
  number
> & {
  retainedOwned: number;
  deletionRequired: number;
  deletionInFlight: number;
  logicallyAbsentPhysicalPending: number;
  absentAndConsumed: number;
  unclassified: number;
  heldSlots: number;
  heldReservations: number;
  unknownSizeCount: number;
};
export const FILE_HISTORY_BYTE_KEYS = [
  'uploadOriginal',
  'uploadText',
  'uploadPending',
  'uploadStaging',
  'uploadRecord',
  'uploadQueue',
  'fileOriginal',
  'fileDerivative',
  'fileDerivativeReservation',
  'logicalObjects',
  'logicalVersions',
  'multipartParts',
  'physicalLive',
  'physicalDead',
  'physicalUnattributed',
  'physicalOverhead',
  'physicalFileBytes',
  'physicalAllocated',
  'allocatedRetained',
  'allocatedPending',
  'allocatedUnclassified',
] as const;
export type FileHistoryBytes = Record<(typeof FILE_HISTORY_BYTE_KEYS)[number], number | null>;
export const FILE_HISTORY_BLOCKER_KEYS = [
  'unclassified',
  'unknownSize',
  'missingReference',
  'missingReplica',
  'actor',
  'unknownPut',
  'reservation',
  'requiredDelete',
  'requiredAbort',
  'physicalReclamation',
  'unsupportedSource',
  'gatewayDisagreement',
  'accountingMismatch',
] as const;
export type FileHistoryBlockers = Record<(typeof FILE_HISTORY_BLOCKER_KEYS)[number], number>;
export type FileHistoryAccounting = {
  counts: FileHistoryCounts;
  bytes: FileHistoryBytes;
  blockers: FileHistoryBlockers;
};
export type FileHistoryLane =
  | 'uploads'
  | 'storage'
  | 'join'
  | 'verify-uploads'
  | 'verify-storage'
  | 'ready';
export type FileHistoryPosition = Readonly<{
  stream: FileHistoryStream;
  scope: FileHistoryScope;
  cursor: FileHistoryCursor;
}>;
export type FileHistorySummary = FileHistoryAccounting & {
  round: number;
  lane: FileHistoryLane;
  checkpoint: number;
  sourceBindingSha256: string;
  storageBindingSha256: string;
  active: FileHistoryPosition;
  foldSha256: string;
  lastPage: null | {
    inputSha256: string;
    checkpointBefore: number;
    checkpointAfter: number;
    pageSha256: string;
  };
  sampleIdentitySha256: string[];
};

/** Existing authenticated Objects owner port, never caller-provided page or seal authority. */
export type FileHistoryStorageBinding = Readonly<{
  /** Current native bindings correlate the held owner; hashes alone never prove historical origin. */
  storageBindingSha256: string;
  providerBindingSha256: string;
  cohortSha256: string;
  round: number;
  priorRoundSettlementSha256: string | null;
  gateways: readonly [string, string];
  initial: FileHistoryPosition;
}>;
export type FileHistoryStorageRequest = Readonly<{
  runSha256: string;
  round: number;
  checkpoint: number;
  inputSha256: string;
  lane: 'storage' | 'join' | 'verify-storage';
  active: FileHistoryPosition;
  sourceBindingSha256: string;
  storageBindingSha256: string;
  mongoFoldSha256: string;
}>;
export type FileHistoryStorageReply = Readonly<{
  page: FileHistoryPage;
  next: FileHistoryPosition | null;
  inputSha256: string;
  storageBindingSha256: string;
  complete: null | {
    mongoFoldSha256: string;
    identityFoldSha256: string;
    gatewayPopulationSha256: readonly [string, string];
    filePhysicalBytes: number;
    allocatedPhysicalBytes: number;
    blockers: FileHistoryBlockers;
  };
}>;
/** Bounded original Mongo source data is private input to the existing Objects join.
 * `source` is canonical tagged BSON data, preserving missing/null/types without schema defaults.
 * The acknowledgement correlates an already committed Objects page; retries keep this input.
 */
export type FileHistoryMongoInput = Readonly<{
  runSha256: string;
  round: number;
  checkpoint: number;
  inputSha256: string;
  sourceBindingSha256: string;
  storageBindingSha256: string;
  page: FileHistoryPage;
  source: Readonly<{
    format: 'tagged-bson-v1';
    rows: readonly Readonly<{ identitySha256: string; value: unknown }>[];
  }>;
}>;
export type FileHistoryMongoAcknowledgement = Readonly<{
  inputSha256: string;
  pageSha256: string;
  sourceBindingSha256: string;
  storageBindingSha256: string;
}>;
