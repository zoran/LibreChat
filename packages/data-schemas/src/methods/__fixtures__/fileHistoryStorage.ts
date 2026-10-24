/** Independent, finite test storage population; never a native authority or empty-seal shortcut. */
import {
  canonicalManagedJson,
  FILE_HISTORY_BLOCKER_KEYS,
  FILE_HISTORY_LIMITS,
} from 'librechat-data-provider';
import type {
  FileCoverageRun,
  FileCoverageResult,
  FileHistoryEntry,
  FileHistoryMongoInput,
  FileHistoryPage,
  FileHistoryPosition,
  FileHistoryScope,
  FileHistoryStorageBinding,
  FileHistoryStorageReply,
  FileHistoryStorageRequest,
} from 'librechat-data-provider';
import type { FileHistoryNativePort } from '../fileHousekeepingHistory';
import { fileCoverageDigest as digest } from '../fileHousekeepingCoverageContract';
import { isHistorySummary } from '../fileHousekeepingHistoryContract';
import { taggedSource } from '../fileHousekeepingData';

type StoredFile = { file_id: string; storageKey: string; bytes: number };
type Slice = {
  position: FileHistoryPosition;
  entries: FileHistoryEntry[];
  next: FileHistoryPosition | null;
};
type RepairedJob = { _id: string; nextAttemptAt: Date };
type HistoryCall = {
  method: 'bind' | 'ingest' | 'page';
  round: number;
  lane?: string;
  stream?: FileHistoryPosition['stream'];
  scope?: FileHistoryScope;
  entries?: number;
  eof?: boolean;
};
export type FileHistoryStorageFixture = {
  port: FileHistoryNativePort;
  calls: HistoryCall[];
  registerFile(file: StoredFile): void;
  settleJobRepair(before: RepairedJob, after: RepairedJob): void;
};
const storage = { storageDeploymentId: 'fixture-deployment', storageStoreId: 'fixture-store' };
const bucket = 'retained-test-files';
const metadataStoreId = 'fixture-filer-store';
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
const same = (a: unknown, b: unknown) => canonicalManagedJson(a) === canonicalManagedJson(b);
const requireFixture = (value: unknown): void => {
  if (!value) throw new Error('Invalid bounded history fixture exchange');
};
/** Exercise the shipped summary parser on actual progress, including resumed rounds. */
export function assertFileHistoryResult(result: FileCoverageResult): void {
  if (result.outcome === 'progress' || result.outcome === 'incomplete') {
    requireFixture(
      isHistorySummary(result.history) &&
        result.history.checkpoint === result.checkpoint &&
        (result.outcome === 'incomplete' || result.lane === result.history.lane),
    );
  } else if (result.outcome === 'sealed') {
    requireFixture(
      isHistorySummary(result.receipt.history) && result.receipt.history.lane === 'ready',
    );
  }
}
function sourceField(source: unknown, name: string): unknown {
  requireFixture(Array.isArray(source) && source[0] === 'object' && Array.isArray(source[1]));
  return (source as [string, [string, unknown][]])[1].find(([key]) => key === name)?.[1];
}

export function createFileHistoryStorageFixture(
  currentRun: () => FileCoverageRun,
  options: {
    recognizedFormat?: boolean;
    providerQualified?: boolean;
    unknownPhysical?: boolean;
  } = {},
): FileHistoryStorageFixture {
  const stored = new Map<string, StoredFile>();
  const observed = new Map<string, FileHistoryEntry>();
  const ingested = new Map<string, string>();
  const calls: HistoryCall[] = [];
  // This in-process native fixture declares its own provider. Current deployed configuration
  // cannot authenticate historical client/row origins (APP-PROVIDER-001); no such claim is made.
  const provider = { ...storage, bucket, source: 's3', version: 'unversioned' };
  let binding: FileHistoryStorageBinding = {
    storageBindingSha256: digest(['fixture-storage', provider]),
    providerBindingSha256: digest(provider),
    cohortSha256: digest(['fixture-held-replicas', 1, 2]),
    round: 0,
    priorRoundSettlementSha256: null,
    gateways: [digest('fixture-gateway-a'), digest('fixture-gateway-b')],
    initial: { stream: 'bucket-catalog', scope: { kind: 's3-catalog', ...storage }, cursor: null },
  };
  const fixtureOwner = {
    kind: 'platform-fixture' as const,
    fixtureId: 'explicitly-constructed-storage-metadata',
    bindingSha256: binding.providerBindingSha256,
  };
  function entry(
    identity: FileHistoryEntry['identity'],
    bytes: number,
    original?: Pick<FileHistoryEntry, 'owner' | 'disposition'>,
    references: string[] = [],
  ): FileHistoryEntry {
    return {
      kind: identity.component,
      identity,
      sourceRevision: digest([identity, bytes]),
      owner: original?.owner ?? fixtureOwner,
      disposition: original?.disposition ?? 'retained-owned',
      measuredBytes: bytes,
      reservedBytes: 0,
      referenceIdentitySha256: references,
    };
  }
  function population(raw: boolean): { slices: Slice[]; allocated: number; filePhysical: number } {
    const groups = new Map<
      string,
      { position: FileHistoryPosition; entries: FileHistoryEntry[] }
    >();
    const add = (
      stream: FileHistoryPosition['stream'],
      scope: FileHistoryScope,
      values: FileHistoryEntry[],
    ) => {
      groups.set(canonicalManagedJson([stream, scope]), {
        position: { stream, scope, cursor: null },
        entries: values,
      });
    };
    const objects: FileHistoryEntry[] = [],
      filer: FileHistoryEntry[] = [];
    const files = [...stored.values()].sort((a, b) => a.storageKey.localeCompare(b.storageKey));
    add('bucket-catalog', binding.initial.scope, [
      entry({ domain: 'bucket', ...storage, bucket, component: 'bucket' }, 0),
    ]);
    for (const file of files) {
      const original: Pick<FileHistoryEntry, 'owner' | 'disposition'> = observed.get(
        file.file_id,
      ) ?? {
        owner: { kind: 'unresolved' },
        disposition: 'unclassified',
      };
      const object = entry(
        {
          domain: 'object',
          ...storage,
          bucket,
          key: file.storageKey,
          version: { kind: 'unversioned' },
          component: 'object',
        },
        file.bytes,
        original,
      );
      const path = `/buckets/${bucket}/${file.storageKey}`;
      const node = entry(
        {
          domain: 'filer',
          ...storage,
          metadataStoreId,
          path,
          entryRevisionSha256: digest([path, file.bytes]),
          edgeIndex: null,
          component: 'filerEntry',
        },
        file.bytes,
        original,
        [digest(object.identity)],
      );
      objects.push(object);
      filer.push(node);
    }
    add('current-objects', { kind: 's3-bucket', ...storage, bucket }, objects);
    for (const stream of ['versions', 'delete-markers', 'multipart-uploads'] as const)
      add(stream, { kind: 's3-bucket', ...storage, bucket }, []);
    add('multipart-parts', { kind: 'storage-catalog', ...storage }, []);
    add(
      'filer-entries',
      { kind: 'filer', ...storage, metadataStoreId, directory: `/buckets/${bucket}` },
      filer,
    );
    add('manifest-edges', { kind: 'storage-catalog', ...storage }, []);
    let allocated = 0,
      filePhysical = 0;
    for (const number of [1, 2]) {
      const replica = {
        collection: bucket,
        volumeId: 1,
        replicaId: String(number).repeat(64),
        pvUid: `fixture-pv-${number}`,
      };
      const nativeFileIdSha256 = digest(['fixture-native-inode', number, 'data']);
      const indexFileId = digest(['fixture-native-inode', number, 'index']);
      const scope: FileHistoryScope = {
        kind: 'volume',
        ...storage,
        ...replica,
        nativeFileIdSha256,
      };
      const path = `volumes/${bucket}_1.dat`,
        indexPath = `volumes/${bucket}_1.idx`;
      const catalog: FileHistoryEntry[] = [];
      const container = {
        owner: { kind: 'storage-allocation' as const },
        disposition: 'retained-owned' as const,
      };
      const catalogFile = (
        relativePath: string | null,
        id: string,
        length: number,
        owner: Pick<FileHistoryEntry, 'owner' | 'disposition'> = container,
      ) => {
        const fileIdentity = {
          domain: 'physical-file' as const,
          ...storage,
          pvUid: replica.pvUid,
          nativeFileIdSha256: id,
          component: 'physicalFile' as const,
        };
        catalog.push(
          entry(fileIdentity, length, owner),
          entry({ ...fileIdentity, component: 'physicalAllocation' }, 4096, owner),
          entry(
            {
              domain: 'physical-path',
              ...storage,
              pvUid: replica.pvUid,
              relativePath,
              component: 'physicalAlias',
            },
            0,
            owner,
            [digest(fileIdentity)],
          ),
        );
        filePhysical += length;
        allocated += 4096;
      };
      catalogFile(null, digest(['fixture-native-inode', number, 'root']), 0);
      catalogFile('volumes', digest(['fixture-native-inode', number, 'directory']), 0);
      catalogFile(path, nativeFileIdSha256, 8 + 24 * files.length);
      catalogFile(indexPath, indexFileId, 16 * files.length);
      if (options.unknownPhysical)
        catalogFile('zero-byte-unknown', digest(['fixture-native-inode', number, 'unknown']), 0, {
          owner: { kind: 'unresolved' },
          disposition: 'unclassified',
        });
      add(
        'physical-catalog',
        { kind: 'physical-catalog', ...storage, pvUid: replica.pvUid },
        catalog,
      );
      const indexes: FileHistoryEntry[] = [],
        data: FileHistoryEntry[] = [];
      for (const [index, file] of files.entries()) {
        const original: Pick<FileHistoryEntry, 'owner' | 'disposition'> = observed.get(
          file.file_id,
        ) ?? {
          owner: { kind: 'unresolved' },
          disposition: 'unclassified',
        };
        const physical = entry(
          {
            domain: 'needle',
            ...storage,
            ...replica,
            needleId: String(index + 1),
            cookieHex: '12345678',
            offsetBytes: 8 + index * 24,
            compactRevision: 0,
            component: 'physicalRecord',
          },
          24,
          original,
          [digest(objects[index].identity)],
        );
        indexes.push(
          entry(
            {
              domain: 'index',
              ...storage,
              ...replica,
              compactRevision: 0,
              indexOffsetBytes: index * 16,
              needleId: String(index + 1),
              component: 'indexRecord',
            },
            0,
            { owner: { kind: 'storage-allocation' }, disposition: 'retained-owned' },
            [
              digest(physical.identity),
              digest({
                domain: 'physical-file',
                ...storage,
                pvUid: replica.pvUid,
                nativeFileIdSha256: indexFileId,
                component: 'physicalFile',
              }),
            ],
          ),
        );
        data.push(physical);
      }
      // Content length and inode allocation are independent; metadata/root allocations remain real.
      const overhead = 8;
      const format = entry(
        {
          domain: 'format',
          ...storage,
          ...replica,
          fileRelativePath: `volumes/${bucket}_1.dat`,
          offsetBytes: 0,
          compactRevision: 0,
          component: 'physicalOverhead',
        },
        overhead,
        options.recognizedFormat === false
          ? { owner: { kind: 'unresolved' }, disposition: 'unclassified' }
          : { owner: { kind: 'storage-format' }, disposition: 'retained-owned' },
      );
      // Version2, no TTL/extra bytes, compact revision0, retained replication placement001.
      data.unshift(
        {
          ...format,
          sourceRevision: digest({
            identity: format.identity,
            superBlockBytes: [options.recognizedFormat === false ? 255 : 2, 1, 0, 0, 0, 0, 0, 0],
          }),
        },
        entry(
          {
            domain: 'volume',
            ...storage,
            ...replica,
            compactRevision: 0,
            component: 'physicalReplica',
          },
          0,
          container,
          [
            digest({
              domain: 'physical-file',
              ...storage,
              pvUid: replica.pvUid,
              nativeFileIdSha256,
              component: 'physicalFile',
            }),
          ],
        ),
      );
      add('volume-index', { ...scope, nativeFileIdSha256: indexFileId }, indexes);
      add('volume-data', scope, data);
      const indexFormat = files.length
        ? [
            entry(
              {
                domain: 'physical-extent',
                ...storage,
                pvUid: replica.pvUid,
                nativeFileIdSha256: indexFileId,
                offsetBytes: 0,
                component: 'physicalOverhead',
              },
              16 * files.length,
              { owner: { kind: 'storage-format' }, disposition: 'retained-owned' },
              [
                digest({
                  domain: 'physical-file',
                  ...storage,
                  pvUid: replica.pvUid,
                  nativeFileIdSha256: indexFileId,
                  component: 'physicalFile',
                }),
              ],
            ),
          ]
        : [];
      add(
        'physical-file',
        {
          kind: 'physical-file',
          ...storage,
          pvUid: replica.pvUid,
          nativeFileIdSha256: indexFileId,
        },
        indexFormat,
      );
    }
    const slices: Slice[] = [];
    for (const stream of families) {
      const selected = [...groups.values()]
        .filter((g) => g.position.stream === stream)
        .sort((a, b) =>
          canonicalManagedJson(a.position.scope).localeCompare(
            canonicalManagedJson(b.position.scope),
          ),
        );
      for (const group of selected) {
        const values = group.entries.map((value) =>
          raw
            ? {
                ...value,
                owner: { kind: 'unresolved' as const },
                disposition: 'unclassified' as const,
              }
            : value,
        );
        let position = group.position;
        if (stream === 'bucket-catalog') {
          slices.push({ position, entries: values, next: null });
          continue;
        }
        for (let index = 0; index < values.length; index += FILE_HISTORY_LIMITS.entries) {
          const end = Math.min(index + FILE_HISTORY_LIMITS.entries, values.length);
          let cursor: NonNullable<FileHistoryPosition['cursor']>;
          if (stream === 'current-objects') {
            cursor = { kind: 's3-objects', continuationToken: `fixture-${end}` };
          } else if (stream === 'filer-entries') {
            cursor = { kind: 'filer', lastEntry: String(end) };
          } else if (stream === 'physical-catalog') {
            cursor = {
              kind: 'physical-catalog',
              sourceSha256: digest(['fixture-catalog', group.position.scope]),
              afterPath: values
                .slice(index, end)
                .filter((v) => v.identity.domain === 'physical-path')
                .map((v) =>
                  v.identity.domain === 'physical-path' ? v.identity.relativePath : null,
                )
                .slice(-1)[0],
            };
          } else if (stream === 'physical-file') {
            cursor = {
              kind: 'physical-file',
              sourceRevision: digest(['fixture-file', group.position.scope]),
              offsetBytes: values.slice(0, end).reduce((n, v) => n + v.measuredBytes!, 0),
            };
          } else if (stream === 'volume-index') {
            cursor = {
              kind: 'volume-index',
              offsetBytes: end * 16,
              compactRevision: 0,
              indexFileBytes: values.length * 16,
            };
          } else {
            cursor = {
              kind: 'volume-data',
              offsetBytes: 8 + Math.max(0, end - 2) * 24,
              compactRevision: 0,
              dataFileBytes: 8 + files.length * 24,
            };
          }
          const next = { ...position, cursor };
          slices.push({ position, entries: values.slice(index, end), next });
          position = next;
        }
        // A source is exhausted only by this separately observed empty page.
        slices.push({ position, entries: [], next: null });
      }
    }
    return { slices, allocated, filePhysical };
  }
  const port: FileHistoryNativePort = {
    async bind(runSha256, signal) {
      requireFixture(!signal.aborted && runSha256 === digest(currentRun()));
      calls.push({ method: 'bind', round: binding.round });
      // Match the existing admin transport's plain JSON data boundary.
      return JSON.parse(canonicalManagedJson(binding));
    },
    async ingest(input: FileHistoryMongoInput, signal) {
      requireFixture(
        !signal.aborted &&
          input.runSha256 === digest(currentRun()) &&
          input.round === binding.round,
      );
      const { pageSha256, ...body } = input.page;
      requireFixture(
        pageSha256 === digest(body) &&
          input.page.entries.length <= 1 &&
          input.source.format === 'tagged-bson-v1' &&
          input.source.rows.length === input.page.entries.length &&
          input.storageBindingSha256 === binding.storageBindingSha256,
      );
      const prior = ingested.get(input.inputSha256);
      requireFixture(prior === undefined || prior === digest(input));
      ingested.set(input.inputSha256, digest(input));
      for (const [index, value] of input.page.entries.entries()) {
        const raw = input.source.rows[index];
        requireFixture(
          raw.identitySha256 === digest(value.identity) &&
            value.sourceRevision === digest(raw.value),
        );
        if (value.kind === 'file' && value.owner.kind === 'file') {
          const file = stored.get(value.owner.fileId);
          if (file)
            requireFixture(
              sourceField(raw.value, 'source') === provider.source &&
                sourceField(raw.value, 'storageKey') === file.storageKey &&
                sourceField(raw.value, 'bytes') === file.bytes,
            );
          observed.set(value.owner.fileId, value);
        }
      }
      calls.push({
        method: 'ingest',
        round: binding.round,
        stream: input.page.stream,
        scope: input.page.scope,
        entries: input.page.entries.length,
        eof: input.page.eof,
      });
      return {
        inputSha256: input.inputSha256,
        pageSha256,
        sourceBindingSha256: input.sourceBindingSha256,
        storageBindingSha256: input.storageBindingSha256,
      };
    },
    async page(input: FileHistoryStorageRequest, signal): Promise<FileHistoryStorageReply> {
      requireFixture(
        !signal.aborted &&
          input.runSha256 === digest(currentRun()) &&
          input.round === binding.round &&
          input.storageBindingSha256 === binding.storageBindingSha256,
      );
      const { slices, allocated, filePhysical } = population(input.lane === 'storage');
      const index = slices.findIndex((slice) => same(slice.position, input.active));
      requireFixture(index >= 0);
      const current = slices[index],
        next = current.next ?? slices[index + 1]?.position ?? null;
      const body = {
        runSha256: input.runSha256,
        round: input.round,
        ...current.position,
        nextCursor: current.next?.cursor ?? null,
        eof: current.next === null,
        entries: current.entries,
      };
      const page: FileHistoryPage = { ...body, pageSha256: digest(body) };
      let identity = digest(['file-history-v1', 'storage-identity']);
      for (const slice of slices) {
        for (const value of slice.entries)
          identity = digest([
            identity,
            slice.position.stream,
            slice.position.scope,
            value.identity,
            value.sourceRevision,
            value.measuredBytes,
            value.reservedBytes,
          ]);
        if (!slice.next)
          identity = digest([identity, 'eof', slice.position.stream, slice.position.scope]);
      }
      calls.push({
        method: 'page',
        round: binding.round,
        lane: input.lane,
        stream: page.stream,
        scope: page.scope,
        entries: page.entries.length,
        eof: page.eof,
      });
      return {
        page,
        next,
        inputSha256: input.inputSha256,
        storageBindingSha256: binding.storageBindingSha256,
        complete:
          next === null
            ? {
                mongoFoldSha256: input.mongoFoldSha256,
                identityFoldSha256: identity,
                gatewayPopulationSha256: [identity, identity],
                filePhysicalBytes: filePhysical,
                allocatedPhysicalBytes: allocated,
                blockers: Object.fromEntries(
                  FILE_HISTORY_BLOCKER_KEYS.map((key) => [
                    key,
                    key === 'unsupportedSource' && options.providerQualified === false ? 1 : 0,
                  ]),
                ) as NonNullable<FileHistoryStorageReply['complete']>['blockers'],
              }
            : null,
      };
    },
  };
  return {
    port,
    calls,
    registerFile(file: StoredFile): void {
      const selected = { file_id: file.file_id, storageKey: file.storageKey, bytes: file.bytes };
      const previous = stored.get(file.file_id);
      requireFixture(
        !previous ||
          same(
            [previous.file_id, previous.storageKey, previous.bytes],
            [selected.file_id, selected.storageKey, selected.bytes],
          ),
      );
      stored.set(file.file_id, selected);
    },
    settleJobRepair(before: RepairedJob, after: RepairedJob): void {
      // Only the test's completed actual Mongo repair and reacquired hold advance the native round.
      requireFixture(
        before._id === after._id &&
          before.nextAttemptAt < after.nextAttemptAt &&
          Date.now() < Date.parse(currentRun().originalDeadline),
      );
      const settlement = digest({
        runSha256: digest(currentRun()),
        round: binding.round,
        before: taggedSource(before),
        after: taggedSource(after),
      });
      binding = {
        ...binding,
        round: binding.round + 1,
        priorRoundSettlementSha256: settlement,
        storageBindingSha256: digest([binding.storageBindingSha256, settlement]),
      };
      observed.clear();
      ingested.clear();
    },
  };
}
