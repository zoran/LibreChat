/** Closed data-only coverage parsing; hashes never authenticate the native producer. */
import { createHash } from 'node:crypto';
import { FILE_HOUSEKEEPING_COVERAGE_CONTRACT, canonicalManagedJson } from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileCoverageRun,
  FileCoverageNativeBinding,
  FileCoverageSource,
  FileCoverageReceipt,
  FileCoveragePopulation,
  FileInventoryRequest,
} from 'librechat-data-provider';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < Number.MAX_SAFE_INTEGER;
const instant = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const hash = (v: unknown): v is string => typeof v === 'string' && HASH.test(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
const digest = (v: unknown): string =>
  createHash('sha256').update(canonicalManagedJson(v)).digest('hex');
function shape(v: unknown, keys: readonly string[]): v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v))
  )
    return false;
  const own = Reflect.ownKeys(v);
  return (
    own.length === keys.length &&
    own.every(
      (k) =>
        typeof k === 'string' &&
        keys.includes(k) &&
        Object.getOwnPropertyDescriptor(v, k)?.enumerable === true &&
        'value' in Object.getOwnPropertyDescriptor(v, k)!,
    )
  );
}
const same = (a: unknown, b: unknown): boolean =>
  canonicalManagedJson(a) === canonicalManagedJson(b);
function source(v: unknown): v is FileCoverageSource {
  return (
    shape(v, ['sourceRevision', 'imageDigest', 'manifestSha256']) &&
    typeof v.sourceRevision === 'string' &&
    /^[a-f0-9]{40}$/.test(v.sourceRevision) &&
    typeof v.imageDigest === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(v.imageDigest) &&
    hash(v.manifestSha256)
  );
}
function native(v: unknown): v is FileCoverageNativeBinding {
  return (
    shape(v, [
      'invocationId',
      'invocationGeneration',
      'originalRequestSha256',
      'namespaceUid',
      'mongoReplicaSet',
      'mongoDatabase',
      'writerCohortSha256',
      'oldTimerDrainSha256',
    ]) &&
    id(v.invocationId) &&
    integer(v.invocationGeneration) &&
    hash(v.originalRequestSha256) &&
    typeof v.namespaceUid === 'string' &&
    UUID.test(v.namespaceUid) &&
    id(v.mongoReplicaSet) &&
    id(v.mongoDatabase) &&
    hash(v.writerCohortSha256) &&
    hash(v.oldTimerDrainSha256)
  );
}
function run(v: unknown): v is FileCoverageRun {
  return (
    shape(v, [
      'version',
      'requestId',
      'storeId',
      'generation',
      'originalDeadline',
      'contract',
      'source',
      'native',
    ]) &&
    v.version === 1 &&
    typeof v.requestId === 'string' &&
    UUID.test(v.requestId) &&
    typeof v.storeId === 'string' &&
    UUID.test(v.storeId) &&
    integer(v.generation) &&
    v.generation > 0 &&
    instant(v.originalDeadline) &&
    shape(v.contract, ['id', 'version', 'projection', 'population']) &&
    same(v.contract, FILE_HOUSEKEEPING_COVERAGE_CONTRACT) &&
    source(v.source) &&
    native(v.native)
  );
}
const populationKeys = [
  'filesSeen',
  'retainedFiles',
  'excludedFiles',
  'fileJobsSeen',
  'unclassifiedFiles',
  'unclassifiedJobs',
];
function population(v: unknown): v is FileCoveragePopulation {
  return (
    shape(v, populationKeys) &&
    Object.values(v).every(integer) &&
    Number(v.retainedFiles) + Number(v.excludedFiles) + Number(v.unclassifiedFiles) === v.filesSeen
  );
}
/** Structural/hash validation only; the producer's native authority is never reconstructed here. */
export function readFileCoverageReceipt(
  v: unknown,
  storeId: string,
  expectedRun?: FileCoverageRun,
): FileCoverageReceipt | null {
  try {
    if (
      !shape(v, [
        'version',
        'storeId',
        'generation',
        'runSha256',
        'contract',
        'source',
        'native',
        'snapshot',
        'population',
        'filesSha256',
        'jobsSha256',
        'projectionSha256',
        'sealedAt',
        'receiptSha256',
      ]) ||
      v.version !== 1 ||
      v.storeId !== storeId ||
      !integer(v.generation) ||
      v.generation === 0 ||
      !hash(v.runSha256) ||
      !shape(v.contract, ['id', 'version', 'projection', 'population']) ||
      !same(v.contract, FILE_HOUSEKEEPING_COVERAGE_CONTRACT) ||
      !source(v.source) ||
      !native(v.native) ||
      !shape(v.snapshot, ['seconds', 'increment', 'observedAt']) ||
      !integer(v.snapshot.seconds) ||
      v.snapshot.seconds > 0xffffffff ||
      !integer(v.snapshot.increment) ||
      v.snapshot.increment > 0xffffffff ||
      !instant(v.snapshot.observedAt) ||
      !population(v.population) ||
      v.population.unclassifiedFiles !== 0 ||
      v.population.unclassifiedJobs !== 0 ||
      !['filesSha256', 'jobsSha256', 'projectionSha256', 'receiptSha256'].every((k) =>
        hash(v[k]),
      ) ||
      !instant(v.sealedAt)
    )
      return null;
    if (
      expectedRun &&
      (v.generation !== expectedRun.generation ||
        v.runSha256 !== digest(expectedRun) ||
        !same(v.source, expectedRun.source) ||
        !same(v.native, expectedRun.native))
    )
      return null;
    const { receiptSha256, ...body } = v;
    return digest(body) === receiptSha256 ? (v as unknown as FileCoverageReceipt) : null;
  } catch {
    return null;
  }
}
function action(v: unknown): v is FileCoverageAction {
  if (
    !v ||
    typeof v !== 'object' ||
    !('value' in (Object.getOwnPropertyDescriptor(v, 'action') ?? {}))
  )
    return false;
  const a = v as FileCoverageAction;
  if (a.action === 'inspect')
    return (
      shape(a, ['action', 'version', 'storeId', 'generation', 'runSha256']) &&
      a.version === 1 &&
      UUID.test(a.storeId) &&
      integer(a.generation) &&
      hash(a.runSha256)
    );
  if (a.action === 'invalidate')
    return (
      shape(a, [
        'action',
        'version',
        'requestId',
        'storeId',
        'expectedGeneration',
        'originalDeadline',
        'reason',
      ]) &&
      a.version === 1 &&
      UUID.test(a.requestId) &&
      UUID.test(a.storeId) &&
      integer(a.expectedGeneration) &&
      instant(a.originalDeadline) &&
      ['source_changed', 'writer_admission', 'migration', 'restore', 'owner_conflict'].includes(
        a.reason,
      )
    );
  if (a.action === 'prepare-ttl')
    return (
      shape(a, ['action', 'run', 'collectionUuid', 'indexName', 'indexSha256']) &&
      run(a.run) &&
      typeof a.collectionUuid === 'string' &&
      UUID.test(a.collectionUuid) &&
      id(a.indexName) &&
      hash(a.indexSha256)
    );
  if (!['begin', 'advance', 'verify-seal'].includes(a.action)) return false;
  return (
    shape(a, a.action === 'begin' ? ['action', 'run'] : ['action', 'run', 'expectedCheckpoint']) &&
    run(a.run) &&
    (a.action === 'begin' || integer(a.expectedCheckpoint))
  );
}

export {
  integer as isFileCoverageInteger,
  hash as isFileCoverageHash,
  id as isFileCoverageIdentifier,
  digest as fileCoverageDigest,
  same as sameFileCoverageData,
  source as isFileCoverageSource,
  native as isFileCoverageNativeBinding,
  action as isFileCoverageAction,
  population as isFileCoveragePopulation,
};

/** No arbitrary collection, query, aggregation, store, run or mutation input. */
export function isFileInventoryRequest(v: unknown): v is FileInventoryRequest {
  return (
    shape(v, [
      'action',
      'version',
      'requestId',
      'source',
      'target',
      'originalDeadline',
      'lookAheadMs',
    ]) &&
    v.action === 'inventory' &&
    v.version === 1 &&
    typeof v.requestId === 'string' &&
    UUID.test(v.requestId) &&
    source(v.source) &&
    shape(v.target, ['namespaceUid', 'mongoReplicaSet', 'mongoDatabase']) &&
    typeof v.target.namespaceUid === 'string' &&
    UUID.test(v.target.namespaceUid) &&
    id(v.target.mongoReplicaSet) &&
    id(v.target.mongoDatabase) &&
    instant(v.originalDeadline) &&
    integer(v.lookAheadMs) &&
    v.lookAheadMs <= 300_000
  );
}
