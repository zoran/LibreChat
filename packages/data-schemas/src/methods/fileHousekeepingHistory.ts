/** Bounded historical census at the existing GlobalState migration owner. No bulk join workspace. */
import { canonicalManagedJson } from 'librechat-data-provider';
import type {
  FileCoverageRun,
  FileCoveragePopulation,
  FileCoverageFailureCode,
  FileHistoryAccounting,
  FileHistoryPage,
  FileHistoryPosition,
  FileHistoryScope,
  FileHistoryCursor,
  FileHistorySummary,
  FileHistoryStorageBinding,
  FileHistoryStorageRequest,
  FileHistoryMongoInput,
} from 'librechat-data-provider';
import type { MongoHistoryLeaf } from './fileHousekeepingMongoHistory';
import {
  addInteger,
  emptyHistoryAccounting,
  sumHistoryAccounting,
  entryHistoryAccounting,
  historyHasBlockers,
  conservedMongoAccounting,
  conservedPhysicalAccounting,
  sealablePhysicalAccounting,
} from './fileHousekeepingHistoryAccounting';
import {
  boundedHistoryData,
  readHistoryPage,
  readHistoryStorageBinding,
  readHistoryStorageReply,
  readHistoryMongoAcknowledgement,
} from './fileHousekeepingHistoryContract';
import { digest, same, integer, FileHistoryError } from './fileHousekeepingData';

export { FileHistoryError } from './fileHousekeepingData';
function fail(code: FileCoverageFailureCode): never {
  throw new FileHistoryError(code);
}
/** Authenticated existing Objects owner. A current storage/provider digest does not establish
 * historical File/Upload origin. Missing origin stays unsupported/unclassified in returned pages. */
export interface FileHistoryNativePort {
  bind(runSha256: string, signal: AbortSignal): Promise<unknown>;
  ingest(input: FileHistoryMongoInput, signal: AbortSignal): Promise<unknown>;
  page(input: FileHistoryStorageRequest, signal: AbortSignal): Promise<unknown>;
}
export type MongoHistoryScope = Extract<FileHistoryScope, { kind: 'mongo' }>;
type MongoFold = {
  fold: string;
  accounting: FileHistoryAccounting;
  queueCount: number;
  population: FileCoveragePopulation;
  filesSha256: string;
  jobsSha256: string;
};
type StorageFold = {
  identity: string;
  full: string;
  accounting: FileHistoryAccounting;
  eofMask: number;
};
export type FileHistoryMigrationState = {
  role: 'file-coverage';
  epoch: string;
  run: FileCoverageRun;
  runSha256: string;
  phase: FileHistorySummary['lane'];
  checkpoint: number;
  population: FileCoveragePopulation;
  filesSha256: string;
  jobsSha256: string;
  history: FileHistorySummary;
  scopes: readonly MongoHistoryScope[];
  binding: FileHistoryStorageBinding;
  mongo: MongoFold;
  storage: StorageFold;
  rawIdentity: string | null;
  joinedFull: string | null;
  verificationMongo: MongoFold | null;
  verificationStorage: StorageFold | null;
  blocked: boolean;
  preparingFiles: boolean;
  repairObservedAt: number;
};
export type FileHistoryAdvancePort = {
  native: FileHistoryNativePort;
  signal: AbortSignal;
  assertCurrent(signal: AbortSignal): Promise<void>;
  observe(
    scope: MongoHistoryScope,
    cursor: FileHistoryCursor,
    repair: boolean,
  ): Promise<MongoHistoryLeaf | null>;
};
const families = [
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
] as const;
const seed = (name: string) => digest(['file-history-v1', name]);
const emptyPopulation = (): FileCoveragePopulation => ({
  filesSeen: 0,
  retainedFiles: 0,
  excludedFiles: 0,
  fileJobsSeen: 0,
  unclassifiedFiles: 0,
  unclassifiedJobs: 0,
});
const mongoFold = (): MongoFold => ({
  fold: seed('mongo'),
  accounting: emptyHistoryAccounting(),
  queueCount: 0,
  population: emptyPopulation(),
  filesSha256: seed('files'),
  jobsSha256: seed('jobs'),
});
const storageFold = (): StorageFold => ({
  identity: seed('storage-identity'),
  full: seed('storage-full'),
  accounting: emptyHistoryAccounting(),
  eofMask: 0,
});
function sourceBinding(run: FileCoverageRun, scopes: readonly MongoHistoryScope[]): string {
  return digest({
    runSha256: digest(run),
    storeId: run.storeId,
    source: run.source,
    native: run.native,
    collections: scopes.map(({ collection, collectionUuid }) => ({ collection, collectionUuid })),
  });
}
export function createFileHistoryState(
  run: FileCoverageRun,
  scopes: readonly MongoHistoryScope[],
  binding: FileHistoryStorageBinding,
): FileHistoryMigrationState {
  if (
    scopes.length !== 3 ||
    !same(
      scopes.map((s) => s.collection),
      ['files', 'file-jobs', 'uploads'],
    ) ||
    scopes.some((s) => s.storeId !== run.storeId)
  )
    fail('source_changed');
  const mongo = mongoFold(),
    storage = storageFold();
  const history: FileHistorySummary = {
    round: binding.round,
    lane: 'uploads',
    checkpoint: 0,
    sourceBindingSha256: sourceBinding(run, scopes),
    storageBindingSha256: binding.storageBindingSha256,
    active: { stream: 'uploads', scope: scopes[0], cursor: null },
    foldSha256: seed('complete'),
    lastPage: null,
    ...emptyHistoryAccounting(),
    sampleIdentitySha256: [],
  };
  return {
    role: 'file-coverage',
    epoch: run.requestId,
    run,
    runSha256: digest(run),
    phase: 'uploads',
    checkpoint: 0,
    population: mongo.population,
    filesSha256: mongo.filesSha256,
    jobsSha256: mongo.jobsSha256,
    history,
    scopes,
    binding,
    mongo,
    storage,
    rawIdentity: null,
    joinedFull: null,
    verificationMongo: null,
    verificationStorage: null,
    blocked: false,
    preparingFiles: true,
    repairObservedAt: Date.now(),
  };
}
export function assertHistorySource(
  state: FileHistoryMigrationState,
  scopes: readonly MongoHistoryScope[],
): void {
  if (sourceBinding(state.run, scopes) !== state.history.sourceBindingSha256)
    fail('source_changed');
}
function phase(
  state: FileHistoryMigrationState,
  lane: FileHistorySummary['lane'],
  active: FileHistoryPosition,
): void {
  state.phase = state.history.lane = lane;
  state.history.active = active;
}
function publicAccounting(state: FileHistoryMigrationState): void {
  const a = sumHistoryAccounting(state.mongo.accounting, state.storage.accounting);
  Object.assign(state.history, a);
  state.population = state.mongo.population;
  state.filesSha256 = state.mongo.filesSha256;
  state.jobsSha256 = state.mongo.jobsSha256;
  state.history.foldSha256 = digest([state.mongo.fold, state.storage.full, a]);
}
function foldMongo(target: MongoFold, page: FileHistoryPage, leaf: MongoHistoryLeaf | null): void {
  if (leaf) {
    target.fold = digest([target.fold, page.scope, leaf.entry]);
    target.accounting = sumHistoryAccounting(target.accounting, leaf.accounting);
    target.queueCount = addInteger(target.queueCount, leaf.queueCount);
    target.population = Object.fromEntries(
      Object.entries(target.population).map(([k, value]) => [
        k,
        addInteger(value, leaf.population[k as keyof FileCoveragePopulation]),
      ]),
    ) as FileCoveragePopulation;
    if (leaf.entry.kind === 'file') target.filesSha256 = digest([target.filesSha256, leaf.entry]);
    if (leaf.entry.kind === 'fileJob') target.jobsSha256 = digest([target.jobsSha256, leaf.entry]);
  }
  if (page.eof) target.fold = digest([target.fold, 'eof', page.scope]);
}
function foldStorage(target: StorageFold, page: FileHistoryPage): void {
  for (const entry of page.entries) {
    target.identity = digest([
      target.identity,
      page.stream,
      page.scope,
      entry.identity,
      entry.sourceRevision,
      entry.measuredBytes,
      entry.reservedBytes,
    ]);
    target.full = digest([target.full, page.stream, page.scope, entry]);
    target.accounting = sumHistoryAccounting(target.accounting, entryHistoryAccounting(entry));
  }
  if (page.eof) {
    target.identity = digest([target.identity, 'eof', page.stream, page.scope]);
    target.full = digest([target.full, 'eof', page.stream, page.scope]);
    target.eofMask |= 1 << families.indexOf(page.stream as (typeof families)[number]);
  }
}
function nextStorage(page: FileHistoryPage, next: FileHistoryPosition | null): void {
  const currentFamily = families.indexOf(page.stream as (typeof families)[number]);
  if (currentFamily < 0) fail('invalid_input');
  if (!page.eof) {
    if (!next || !same(next, { stream: page.stream, scope: page.scope, cursor: page.nextCursor }))
      fail('checkpoint_conflict');
    return;
  }
  if (!next) {
    if (currentFamily !== families.length - 1) fail('unclassified');
    return;
  }
  const nextFamily = families.indexOf(next.stream as (typeof families)[number]);
  if (
    next.cursor !== null ||
    nextFamily < currentFamily ||
    nextFamily > currentFamily + 1 ||
    (nextFamily === currentFamily &&
      canonicalManagedJson(next.scope) <= canonicalManagedJson(page.scope))
  )
    fail('checkpoint_conflict');
}
function observedMongoPage(
  state: FileHistoryMigrationState,
  leaf: MongoHistoryLeaf | null,
): FileHistoryPage {
  const active = state.history.active;
  const nextCursor: FileHistoryCursor =
    leaf && leaf.entry.identity.domain === 'mongo'
      ? {
          kind: 'mongo-id',
          idType: leaf.entry.identity.idType,
          value: leaf.entry.identity.persistedId,
        }
      : null;
  const body = {
    runSha256: state.runSha256,
    round: state.history.round,
    ...active,
    nextCursor,
    eof: leaf === null,
    entries: leaf ? [leaf.entry] : [],
  };
  const page = readHistoryPage({ ...body, pageSha256: digest(body) });
  if (!page) fail('unclassified');
  return page;
}
async function prepareFilePage(
  state: FileHistoryMigrationState,
  port: FileHistoryAdvancePort,
): Promise<FileHistoryPage> {
  const active = state.history.active;
  if (active.scope.kind !== 'mongo' || active.scope.collection !== 'files') fail('source_changed');
  const leaf = await port.observe(active.scope, active.cursor, true);
  const page = observedMongoPage(state, leaf);
  // Legacy File/job policy preparation is completed BEFORE any history population is ingested.
  // Its committed postimages are read again from the start; no observed round is repaired in place.
  if (page.eof) {
    state.preparingFiles = false;
    state.history.active = { stream: 'uploads', scope: state.scopes[0], cursor: null };
    state.history.sampleIdentitySha256 = [];
  } else state.history.active = { ...active, cursor: page.nextCursor };
  return page;
}
async function mongoPage(
  state: FileHistoryMigrationState,
  global: Record<string, unknown>,
  inputSha256: string,
  port: FileHistoryAdvancePort,
): Promise<FileHistoryPage> {
  const active = state.history.active;
  if (active.scope.kind !== 'mongo' || active.stream !== 'uploads') fail('source_changed');
  const verifying = state.phase === 'verify-uploads';
  const leaf = await port.observe(active.scope, active.cursor, false);
  const page = observedMongoPage(state, leaf);
  if (!verifying) {
    const input: FileHistoryMongoInput = {
      runSha256: state.runSha256,
      round: state.history.round,
      checkpoint: state.checkpoint,
      inputSha256,
      sourceBindingSha256: state.history.sourceBindingSha256,
      storageBindingSha256: state.history.storageBindingSha256,
      page,
      source: {
        format: 'tagged-bson-v1',
        rows: leaf ? [{ identitySha256: digest(leaf.entry.identity), value: leaf.source }] : [],
      },
    };
    if (!boundedHistoryData(input)) fail('capacity');
    const ack = readHistoryMongoAcknowledgement(await port.native.ingest(input, port.signal));
    if (
      !ack ||
      !same(ack, {
        inputSha256,
        pageSha256: page.pageSha256,
        sourceBindingSha256: input.sourceBindingSha256,
        storageBindingSha256: input.storageBindingSha256,
      })
    )
      fail('native_changed');
  }
  const target = verifying ? state.verificationMongo! : state.mongo;
  foldMongo(target, page, leaf);
  if (!page.eof) state.history.active = { ...active, cursor: page.nextCursor };
  else {
    const index = state.scopes.findIndex((s) => same(s, active.scope));
    if (index < 0) fail('source_changed');
    if (index < 2)
      state.history.active = { stream: 'uploads', scope: state.scopes[index + 1], cursor: null };
    else {
      if (!conservedMongoAccounting(global, target.accounting, target.queueCount))
        target.accounting.blockers.accountingMismatch = addInteger(
          target.accounting.blockers.accountingMismatch,
          1,
        );
      if (verifying) {
        if (!same(target, state.mongo)) fail('source_changed');
        state.verificationStorage = storageFold();
        phase(state, 'verify-storage', state.binding.initial);
      } else phase(state, 'storage', state.binding.initial);
    }
  }
  return page;
}
async function storagePage(
  state: FileHistoryMigrationState,
  inputSha256: string,
  port: FileHistoryAdvancePort,
): Promise<FileHistoryPage> {
  if (!['storage', 'join', 'verify-storage'].includes(state.phase)) fail('checkpoint_conflict');
  const request: FileHistoryStorageRequest = {
    runSha256: state.runSha256,
    round: state.history.round,
    checkpoint: state.checkpoint,
    inputSha256,
    lane: state.phase as FileHistoryStorageRequest['lane'],
    active: state.history.active,
    sourceBindingSha256: state.history.sourceBindingSha256,
    storageBindingSha256: state.history.storageBindingSha256,
    mongoFoldSha256: state.mongo.fold,
  };
  const reply = readHistoryStorageReply(await port.native.page(request, port.signal));
  if (
    !reply ||
    reply.inputSha256 !== inputSha256 ||
    reply.storageBindingSha256 !== state.history.storageBindingSha256
  )
    fail('native_changed');
  const page = reply.page;
  if (
    page.runSha256 !== state.runSha256 ||
    page.round !== state.history.round ||
    !same({ stream: page.stream, scope: page.scope, cursor: page.cursor }, state.history.active)
  )
    fail('checkpoint_conflict');
  nextStorage(page, reply.next);
  const target = state.phase === 'verify-storage' ? state.verificationStorage! : state.storage;
  foldStorage(target, page);
  if (reply.next) {
    state.history.active = reply.next;
    return page;
  }
  const complete = reply.complete;
  if (
    !page.eof ||
    !complete ||
    target.eofMask !== (1 << families.length) - 1 ||
    complete.mongoFoldSha256 !== state.mongo.fold ||
    complete.identityFoldSha256 !== target.identity
  )
    fail('unclassified');
  if (
    !conservedPhysicalAccounting(
      target.accounting,
      complete.filePhysicalBytes,
      complete.allocatedPhysicalBytes,
    )
  )
    target.accounting.blockers.accountingMismatch = addInteger(
      target.accounting.blockers.accountingMismatch,
      1,
    );
  if (state.phase === 'storage') {
    state.rawIdentity = target.identity;
    // Missing populations/replicas or unequal actual gateways cannot be cured by assigning owners.
    for (const key of [
      'unsupportedSource',
      'missingReplica',
      'accountingMismatch',
      'gatewayDisagreement',
    ] as const)
      target.accounting.blockers[key] = addInteger(
        target.accounting.blockers[key],
        complete.blockers[key],
      );
    if (complete.gatewayPopulationSha256.some((h) => h !== target.identity))
      target.accounting.blockers.gatewayDisagreement = addInteger(
        target.accounting.blockers.gatewayDisagreement,
        1,
      );
    if (
      ['unsupportedSource', 'missingReplica', 'accountingMismatch', 'gatewayDisagreement'].some(
        (key) => target.accounting.blockers[key as keyof typeof target.accounting.blockers] !== 0,
      )
    )
      state.blocked = true;
    else {
      state.storage = storageFold();
      phase(state, 'join', state.binding.initial);
    }
    return page;
  }
  for (const key of Object.keys(complete.blockers) as (keyof typeof complete.blockers)[])
    target.accounting.blockers[key] = addInteger(
      target.accounting.blockers[key],
      complete.blockers[key],
    );
  if (complete.gatewayPopulationSha256.some((h) => h !== target.identity))
    target.accounting.blockers.gatewayDisagreement = addInteger(
      target.accounting.blockers.gatewayDisagreement,
      1,
    );
  if (target.identity !== state.rawIdentity) fail('source_changed');
  if (state.phase === 'verify-storage') {
    if (!same(target, state.storage) || target.full !== state.joinedFull) fail('source_changed');
    if (
      !sealablePhysicalAccounting(target.accounting) ||
      historyHasBlockers(sumHistoryAccounting(state.mongo.accounting, target.accounting))
    )
      fail('unclassified');
    phase(state, 'ready', state.history.active);
  } else {
    state.joinedFull = target.full;
    if (
      !sealablePhysicalAccounting(target.accounting) ||
      historyHasBlockers(sumHistoryAccounting(state.mongo.accounting, target.accounting))
    )
      state.blocked = true;
    else {
      state.verificationMongo = mongoFold();
      phase(state, 'verify-uploads', { stream: 'uploads', scope: state.scopes[0], cursor: null });
    }
  }
  return page;
}
/** One exact page per advance. Last-page replay is handled before any native operation. */
export async function advanceFileHistory(
  state: FileHistoryMigrationState,
  global: Record<string, unknown>,
  inputSha256: string,
  port: FileHistoryAdvancePort,
): Promise<void> {
  await port.assertCurrent(port.signal);
  const binding = readHistoryStorageBinding(await port.native.bind(state.runSha256, port.signal));
  if (!binding) fail('native_changed');
  if (!same(binding, state.binding)) {
    if (
      binding.round !== state.history.round + 1 ||
      binding.providerBindingSha256 !== state.binding.providerBindingSha256 ||
      binding.cohortSha256 !== state.binding.cohortSha256 ||
      !same(binding.gateways, state.binding.gateways) ||
      !binding.priorRoundSettlementSha256
    )
      fail('native_changed');
    const checkpoint = state.checkpoint;
    Object.assign(state, createFileHistoryState(state.run, state.scopes, binding));
    state.checkpoint = state.history.checkpoint = checkpoint;
  }
  if (state.blocked || state.phase === 'ready') return;
  let page: FileHistoryPage;
  if (state.preparingFiles) {
    page = await prepareFilePage(state, port);
  } else if (state.phase === 'uploads' || state.phase === 'verify-uploads') {
    page = await mongoPage(state, global, inputSha256, port);
  } else {
    page = await storagePage(state, inputSha256, port);
  }
  await port.assertCurrent(port.signal);
  publicAccounting(state);
  state.history.lastPage = {
    inputSha256,
    checkpointBefore: state.checkpoint,
    checkpointAfter: addInteger(state.checkpoint, 1),
    pageSha256: page.pageSha256,
  };
  state.checkpoint = state.history.checkpoint = state.history.lastPage.checkpointAfter;
  for (const entry of page.entries) {
    if (
      (entry.disposition === 'unclassified' || entry.owner.kind === 'unresolved') &&
      state.history.sampleIdentitySha256.length < 16
    ) {
      const hash = digest(entry.identity);
      if (!state.history.sampleIdentitySha256.includes(hash))
        state.history.sampleIdentitySha256.push(hash);
    }
  }
  // Progress lives in the existing bounded GlobalState record. No per-population journal.
  if (!integer(state.checkpoint) || !boundedHistoryData(state)) fail('capacity');
}
