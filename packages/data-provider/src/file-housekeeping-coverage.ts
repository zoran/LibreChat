import type { FileHistoryLane, FileHistorySummary } from './file-housekeeping-history';
import type { FileInventoryCounts } from './upload-management';

// This literal identifies behavior, not permission. Actual executable source/image provenance is
// independently authenticated by the native owner and compared before any mutation.
export const FILE_HOUSEKEEPING_COVERAGE_CONTRACT = {
  id: 'file-housekeeping-coverage',
  version: 2,
  projection: 'atomic-file-job-v1',
  population: 'all-files-uploads-storage-v1',
} as const;
export type FileCoverageCompiledContract = typeof FILE_HOUSEKEEPING_COVERAGE_CONTRACT;

export type FileCoverageSource = Readonly<{
  sourceRevision: string; // exact baked 40 lower-case hex; never BUILD_COMMIT override
  imageDigest: string; // sha256: followed by 64 lower-case hex
  manifestSha256: string; // immutable CI owner/source manifest, authenticated by native owner
}>;
export type FileCoverageNativeBinding = Readonly<{
  invocationId: string;
  invocationGeneration: number;
  originalRequestSha256: string;
  namespaceUid: string;
  mongoReplicaSet: string;
  mongoDatabase: string;
  writerCohortSha256: string;
  /**
   * Exact legacy App CRI cessation before native DDL under the original invocation,
   * with Intake's separately retained live pause/drain and exact incarnation.
   * Does not attest database/storage effects or server TTL completion.
   */
  oldApplicationCessationSha256: string;
}>;
/** Data claims only. Possessing this object or knowing its hashes never authorizes a mutation. */
export type FileCoverageRun = Readonly<{
  version: 1;
  requestId: string; // immutable UUID for the complete finite producer run
  storeId: string; // exact existing GlobalState storeId
  generation: number; // desired next generation at begin, unchanged for this entire run
  originalDeadline: string; // canonical UTC milliseconds; no retry extension
  contract: FileCoverageCompiledContract;
  source: FileCoverageSource;
  native: FileCoverageNativeBinding;
}>;
export type FileCoverageInvalidateReason =
  | 'source_changed'
  | 'writer_admission'
  | 'migration'
  | 'restore'
  | 'owner_conflict';
/** Closed discriminated input; JSON parsers reject extra keys, accessors and non-own data. */
export type FileCoverageAction =
  | Readonly<{
      action: 'prepare-ttl';
      run: FileCoverageRun;
      collectionUuid: string;
      indexName: string;
      indexSha256: string;
    }>
  | Readonly<{ action: 'begin'; run: FileCoverageRun }>
  | Readonly<{ action: 'advance'; run: FileCoverageRun; expectedCheckpoint: number }>
  | Readonly<{ action: 'verify-seal'; run: FileCoverageRun; expectedCheckpoint: number }>
  | Readonly<{
      action: 'invalidate';
      version: 1;
      requestId: string;
      storeId: string;
      expectedGeneration: number;
      originalDeadline: string;
      reason: FileCoverageInvalidateReason;
    }>
  | Readonly<{
      action: 'inspect';
      version: 1;
      storeId: string;
      generation: number;
      runSha256: string;
    }>;
export type FileCoveragePopulation = Readonly<{
  filesSeen: number;
  retainedFiles: number;
  excludedFiles: number;
  fileJobsSeen: number;
  unclassifiedFiles: number;
  unclassifiedJobs: number;
}>;
export type FileCoverageReceipt = Readonly<{
  version: 1;
  storeId: string;
  generation: number;
  runSha256: string; // canonical complete immutable FileCoverageRun, computed by data owner
  contract: FileCoverageCompiledContract;
  source: FileCoverageSource;
  native: FileCoverageNativeBinding;
  snapshot: Readonly<{
    seconds: number;
    increment: number; // exact Mongo Timestamp pair from the actual pinned read session
    observedAt: string; // server observation; not wall-clock snapshot authority
  }>;
  population: FileCoveragePopulation & Readonly<{ unclassifiedFiles: 0; unclassifiedJobs: 0 }>;
  history: FileHistorySummary;
  filesSha256: string;
  jobsSha256: string;
  projectionSha256: string;
  sealedAt: string; // actual database commit operation's server-time observation
  receiptSha256: string; // canonical body excluding this field
}>;
export type FileCoverageFailureCode =
  | 'invalid_input'
  | 'native_unavailable'
  | 'native_changed'
  | 'store_changed'
  | 'generation_conflict'
  | 'checkpoint_conflict'
  | 'migration_conflict'
  | 'source_changed'
  | 'unclassified'
  | 'deadline'
  | 'capacity'
  | 'unavailable'
  | 'unknown_commit';
/** Current actual catalog observation; it is not a DDL or exclusion receipt. */
export type FileCoverageCatalog = Readonly<{
  collectionUuid: string;
  fileTtlIndexes: readonly Readonly<{ name: string; indexSha256: string }>[];
}>;
export type FileCoverageResult =
  | Readonly<{
      outcome: 'prepared'; // Current raw expiry absence only; not a DDL/settlement/coverage receipt.
      storeId: string;
      generation: number;
      runSha256: string;
      collectionUuid: string;
      indexName: string;
      indexSha256: string;
      snapshot: Readonly<{ seconds: number; increment: number }>;
      population: Pick<
        FileInventoryCounts,
        | 'totalFiles'
        | 'expiresAtAbsentOrNull'
        | 'expiresAtScalarDate'
        | 'expiresAtArray'
        | 'expiresAtOther'
      >;
    }>
  | Readonly<{
      outcome: 'progress';
      generation: number;
      runSha256: string;
      checkpoint: number;
      lane: FileHistoryLane;
      population: FileCoveragePopulation;
      history: FileHistorySummary;
    }>
  | Readonly<{
      outcome: 'incomplete';
      generation: number;
      runSha256: string;
      checkpoint: number;
      history: FileHistorySummary;
    }>
  | Readonly<{ outcome: 'sealed'; receipt: FileCoverageReceipt }>
  | Readonly<{ outcome: 'invalidated'; generation: number; requestSha256: string }>
  | Readonly<{
      outcome: 'observed';
      generation: number | null;
      phase: 'absent' | 'invalid' | 'preparing' | 'sealed';
      receipt: FileCoverageReceipt | null;
      catalog: FileCoverageCatalog;
    }>
  | Readonly<{ outcome: 'refused' | 'unknown'; code: FileCoverageFailureCode }>;
