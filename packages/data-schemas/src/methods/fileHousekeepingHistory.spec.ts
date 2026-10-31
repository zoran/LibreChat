/** Local codec/accounting/custody cases; actual Mongo/admin composition lives in its existing suites. */
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { FILE_HOUSEKEEPING_COVERAGE_CONTRACT } from 'librechat-data-provider';
import type {
  FileCoverageRun,
  FileHistoryStorageBinding,
  FileHistoryMongoInput,
  FileHistoryEntry,
  FileHistoryPage,
  FileHistoryScope,
  FileHistoryAccounting,
  FileHistorySummary,
} from 'librechat-data-provider';
import type { FileHistoryAdvancePort } from './fileHousekeepingHistory';
import {
  addInteger,
  emptyHistoryAccounting,
  entryHistoryAccounting,
  sumHistoryAccounting,
  conservedMongoAccounting,
  conservedPhysicalAccounting,
  historyHasBlockers,
  sealablePhysicalAccounting,
} from './fileHousekeepingHistoryAccounting';
import {
  readHistoryPage,
  isHistoryEntry,
  isHistoryAccounting,
  isHistorySummary,
} from './fileHousekeepingHistoryContract';
import { createFileHistoryState, advanceFileHistory } from './fileHousekeepingHistory';
import { mongoHistoryLeaf } from './fileHousekeepingMongoHistory';
import { digest, taggedSource } from './fileHousekeepingData';

const hash = (character: string) => character.repeat(64);
const uploadScope = {
  kind: 'mongo' as const,
  storeId: '11111111-1111-4111-8111-111111111111',
  collection: 'uploads' as const,
  collectionUuid: '22222222-2222-4222-8222-222222222222',
};
function uploadRow(): Record<string, unknown> {
  return {
    _id: 'historical-upload',
    tenantId: 'tenant-a',
    userId: 'user-a',
    state: 'waiting',
    revision: 0,
    generation: 0,
    declaredBytes: 13,
    pendingBytes: 13,
    stagingHeld: false,
    queueCharged: false,
    originalBytes: 0,
    textBytes: 0,
    recordBytes: 1024,
    createdAt: 1,
    expiresAt: 2,
    cleanupPending: false,
  };
}
function observe(row: Record<string, unknown>) {
  return mongoHistoryLeaf(uploadScope, { row, classification: 'unknown', linkedFileKnown: false });
}
const volume: Extract<FileHistoryScope, { kind: 'volume' }> = {
  kind: 'volume',
  storageDeploymentId: 'deployment',
  storageStoreId: 'store',
  collection: '',
  volumeId: 1,
  replicaId: hash('a'),
  pvUid: 'pv-1',
  nativeFileIdSha256: hash('c'),
};
function indexRecord(): FileHistoryEntry {
  return {
    kind: 'indexRecord',
    identity: {
      domain: 'index',
      storageDeploymentId: 'deployment',
      storageStoreId: 'store',
      collection: '',
      volumeId: 1,
      replicaId: hash('a'),
      pvUid: 'pv-1',
      compactRevision: 0,
      indexOffsetBytes: 16,
      needleId: '18446744073709551615',
      component: 'indexRecord',
    },
    sourceRevision: digest(taggedSource({ rawSize: -1, dataOffset: 0 })),
    owner: { kind: 'unresolved' },
    disposition: 'unclassified',
    measuredBytes: 0,
    reservedBytes: 0,
    referenceIdentitySha256: [
      digest({
        domain: 'physical-file',
        storageDeploymentId: volume.storageDeploymentId,
        storageStoreId: volume.storageStoreId,
        pvUid: volume.pvUid,
        nativeFileIdSha256: volume.nativeFileIdSha256,
        component: 'physicalFile',
      }),
    ],
  };
}
function page(
  entries: readonly FileHistoryEntry[],
  changes: Partial<FileHistoryPage> = {},
): FileHistoryPage {
  const body = {
    runSha256: hash('b'),
    round: 0,
    stream: 'volume-index' as const,
    scope: volume,
    cursor: null,
    nextCursor: null,
    eof: true,
    entries,
    ...changes,
  };
  const { pageSha256: _old, ...unsigned } = body as FileHistoryPage;
  return { ...unsigned, pageSha256: digest(unsigned) };
}

describe('actual native physical history contract', () => {
  test('actual Go and Python DTO corpus preserves both byte domains and partial refusal', () => {
    // Actual one-Store/two-root Go serialization, normalized by the shipped Python owners.
    // This local corpus supplies no original-A/cohort, provider, full-census or seal authority.
    const raw = readFileSync(join(__dirname, '__fixtures__/file-history-native-normalized.json'));
    const corpus = JSON.parse(raw.toString('utf8')) as {
      corpusSha256: string;
      branches: {
        branch: string;
        pages: FileHistoryPage[];
        accounting: FileHistoryAccounting;
        summary: FileHistorySummary;
        baselines: { fileBytes: number; allocatedBytes: number; unsupported: number };
        journalPackets: number;
        continuations: number;
      }[];
    };
    // Pin the normalized compact payload independently of source-file formatting.
    expect(createHash('sha256').update(JSON.stringify(corpus)).digest('hex')).toBe(
      '00cab9d94e1f8f9e82a64088d89fde64106c422bc5c47531f365271a40270c8b',
    );
    expect(corpus.corpusSha256).toBe(
      '1d0a24966488bea029a62fa250e964df0e3fad4387b8f237d21b7dddedba3ba5',
    );
    expect(corpus.branches.map((branch) => branch.branch)).toEqual([
      'managed',
      'zero-byte-unknown',
    ]);
    let pages = 0,
      indexPages = 0;
    for (const branch of corpus.branches) {
      expect(branch.pages).toHaveLength(branch.branch === 'managed' ? 24 : 26);
      let observed = emptyHistoryAccounting();
      for (const [index, value] of branch.pages.entries()) {
        const parsed = readHistoryPage(value);
        expect({
          branch: branch.branch,
          index,
          stream: value.stream,
          accepted: parsed !== null,
        }).toEqual({ branch: branch.branch, index, stream: value.stream, accepted: true });
        pages += 1;
        if (value.stream === 'volume-index') indexPages += 1;
        // The producer exports two real fresh passes; charge only the first pass once.
        if (index < branch.pages.length / 2)
          for (const entry of value.entries)
            observed = sumHistoryAccounting(observed, entryHistoryAccounting(entry));
      }
      expect(observed).toEqual(branch.accounting);
      expect(isHistoryAccounting(observed)).toBe(true);
      expect(isHistorySummary(branch.summary)).toBe(true);
      expect(branch.summary).toMatchObject(observed);
      expect(
        conservedPhysicalAccounting(
          observed,
          branch.baselines.fileBytes,
          branch.baselines.allocatedBytes,
        ),
      ).toBe(true);
      expect(branch.baselines.fileBytes).not.toBe(branch.baselines.allocatedBytes);
      expect(observed.counts.unclassified).toBe(branch.branch === 'managed' ? 62 : 65);
      expect(observed.bytes.allocatedUnclassified).toBe(135168);
      expect(branch.baselines.unsupported).toBeGreaterThan(0);
      expect(branch.journalPackets).toBe(196);
      expect(branch.continuations).toBe(12);
      expect(historyHasBlockers(observed)).toBe(true);
      expect(sealablePhysicalAccounting(observed)).toBe(false);
      expect(isHistorySummary({ ...branch.summary, lane: 'ready' })).toBe(false);
    }
    expect({ pages, indexPages }).toEqual({ pages: 50, indexPages: 8 });
    // Typed directory metadata remains zero-byte structural evidence; its native predicate
    // (isDirectory/inline/chunk/remote/TTL/KV/children) is proved by the Objects owner.
    const directory: FileHistoryEntry = {
      kind: 'filerEntry',
      identity: {
        domain: 'filer',
        storageDeploymentId: 'fixture-deployment',
        storageStoreId: 'fixture-store',
        metadataStoreId: 'fixture-filer',
        path: '/buckets/fixture-directory',
        entryRevisionSha256: hash('a'),
        edgeIndex: null,
        component: 'filerEntry',
      },
      sourceRevision: hash('b'),
      owner: { kind: 'storage-allocation' },
      disposition: 'retained-owned',
      measuredBytes: 0,
      reservedBytes: 0,
      referenceIdentitySha256: [],
    };
    expect(isHistoryEntry(directory)).toBe(true);
    expect(isHistoryEntry({ ...directory, measuredBytes: 1 })).toBe(false);
    expect(isHistoryEntry({ ...directory, reservedBytes: 1 })).toBe(false);
  });
});

describe('historical population closed source and accounting', () => {
  test('expired waiting source preserves its reservations and raw state instead of normalizing expiry', () => {
    const row = uploadRow(),
      before = digest(taggedSource(row));
    const result = observe(Object.freeze(row));
    expect(digest(taggedSource(row))).toBe(before);
    expect(row).toMatchObject({ state: 'waiting', expiresAt: 2, pendingBytes: 13 });
    expect(result.entry).toMatchObject({
      kind: 'upload',
      disposition: 'deletion-in-flight',
      reservedBytes: 13,
    });
    expect(result.accounting.bytes.uploadPending).toBe(13);
    expect(result.accounting.blockers.reservation).toBeGreaterThan(0);
    expect(historyHasBlockers(result.accounting)).toBe(true);
  });
  test('missing tenant stays unresolved while explicit guest null retains a distinct source identity', () => {
    const missing = uploadRow();
    delete missing.tenantId;
    const guest = { ...uploadRow(), tenantId: null };
    const a = observe(missing),
      b = observe(guest);
    expect(a.entry.owner).toEqual({ kind: 'unresolved' });
    expect(a.entry.identity).toMatchObject({ principal: { kind: 'unresolved' } });
    expect(b.entry.identity).toMatchObject({ principal: { kind: 'resolved', tenantId: null } });
    expect(a.entry.sourceRevision).not.toBe(b.entry.sourceRevision);
    expect(a.accounting.blockers.unclassified).toBeGreaterThan(0);
  });
  test('an expired active generation retains actor, unknown PUT and slot obligations', () => {
    const row = {
      ...uploadRow(),
      state: 'processing',
      generation: 4,
      attemptGeneration: 3,
      worker: { hostId: 'host', instanceId: 'instance' },
      slot: 'processing',
    };
    const result = observe(row);
    expect(result.accounting.counts.heldSlots).toBe(1);
    expect(result.accounting.blockers.actor).toBe(1);
    expect(result.accounting.blockers.unknownPut).toBe(1);
    expect(result.entry.measuredBytes).toBeNull();
    expect(result.accounting.counts.unknownSizeCount).toBeGreaterThan(0);
  });
  test('a terminal state and absent original marker do not substitute for consumed cleanup custody', () => {
    const result = observe({
      ...uploadRow(),
      state: 'deleted',
      generation: 2,
      attemptGeneration: 1,
      pendingBytes: 0,
      writerStopped: true,
      original: {
        outcome: 'absent',
        bytes: 0,
        source: 's3',
        filepath: '/original',
        storageKey: 'original-key',
      },
    });
    expect(result.entry.disposition).toBe('deletion-required');
    expect(result.accounting.blockers.requiredDelete).toBe(1);
    expect(result.accounting.counts.absentAndConsumed).toBe(0);
  });
  test('append-index tombstone identity remains lossless without an invented cookie or data offset', () => {
    const record = indexRecord(),
      result = page([record]);
    expect(readHistoryPage(result)).toEqual(result);
    expect(record.identity).toMatchObject({
      domain: 'index',
      needleId: '18446744073709551615',
      indexOffsetBytes: 16,
    });
    expect(
      readHistoryPage(
        page([
          {
            ...record,
            identity: { ...record.identity, cookieHex: '00000000' },
          } as unknown as FileHistoryEntry,
        ]),
      ),
    ).toBeNull();
    expect(readHistoryPage(page([record], { stream: 'volume-data' }))).toBeNull();
  });
  test('recognized superblock bytes have actual format identity and no tenant or fixture owner', () => {
    const overhead = {
      kind: 'physicalOverhead',
      identity: {
        domain: 'format',
        storageDeploymentId: volume.storageDeploymentId,
        storageStoreId: volume.storageStoreId,
        collection: volume.collection,
        volumeId: volume.volumeId,
        replicaId: volume.replicaId,
        pvUid: volume.pvUid,
        compactRevision: 0,
        fileRelativePath: 'volumes/1.dat',
        offsetBytes: 0,
        component: 'physicalOverhead',
      },
      sourceRevision: digest(['actual-format-bytes', '0300000000000000']),
      owner: { kind: 'storage-format' },
      disposition: 'retained-owned',
      measuredBytes: 8,
      reservedBytes: 0,
      referenceIdentitySha256: [],
    } satisfies FileHistoryEntry;
    const observed = page([overhead], { stream: 'volume-data' });
    expect(readHistoryPage(observed)).toEqual(observed);
    const otherFile: FileHistoryEntry = {
      ...overhead,
      identity: { ...overhead.identity, fileRelativePath: 'archive/1.dat' },
    };
    expect(digest(otherFile.identity)).not.toBe(digest(overhead.identity));
    expect(page([otherFile], { stream: 'volume-data' }).pageSha256).not.toBe(observed.pageSha256);
    expect(readHistoryPage(page([overhead, otherFile], { stream: 'volume-data' }))).toBeNull();
    expect(readHistoryPage(page([overhead, overhead], { stream: 'volume-data' }))).toBeNull();
    const oldIdentity = { ...overhead.identity } as Record<string, unknown>;
    delete oldIdentity.fileRelativePath;
    expect(isHistoryEntry({ ...overhead, identity: oldIdentity })).toBe(false);
    for (const fileRelativePath of [
      undefined,
      null,
      '',
      '/1.dat',
      'volumes/',
      'volumes//1.dat',
      '.',
      '..',
      './1.dat',
      'volumes/../1.dat',
      'x\0y',
      '\ud800',
      '\udfff',
      'é'.repeat(2048) + 'a',
    ]) {
      expect(
        isHistoryEntry({ ...overhead, identity: { ...overhead.identity, fileRelativePath } }),
      ).toBe(false);
    }
    for (const fileRelativePath of [
      'volumes/%2e%2e.dat',
      'a\\b:1.dat',
      'é'.repeat(2048),
      '😀'.repeat(1024),
      'e\u0301/1.dat',
    ]) {
      const exact: FileHistoryEntry = {
        ...overhead,
        identity: { ...overhead.identity, fileRelativePath },
      };
      expect(isHistoryEntry(exact)).toBe(true);
      expect(readHistoryPage(page([exact], { stream: 'volume-data' }))?.entries[0]).toEqual(exact);
    }
    const accounting = entryHistoryAccounting(overhead);
    expect(accounting.bytes.physicalOverhead).toBe(8);
    expect(accounting.bytes.logicalObjects).toBe(0);
    expect(historyHasBlockers(accounting)).toBe(false);
    for (const change of [
      { owner: { kind: 'platform-fixture', fixtureId: 'fake', bindingSha256: hash('a') } },
      { identity: { ...overhead.identity, needleId: '0', cookieHex: '00000000' } },
      { reservedBytes: 1 },
      { measuredBytes: null },
      { referenceIdentitySha256: [hash('a')] },
    ])
      expect(
        readHistoryPage(
          page([{ ...overhead, ...change } as FileHistoryEntry], { stream: 'volume-data' }),
        ),
      ).toBeNull();
    const unknown = {
      ...overhead,
      owner: { kind: 'unresolved' as const },
      disposition: 'unclassified' as const,
    };
    expect(readHistoryPage(page([unknown], { stream: 'volume-data' }))).not.toBeNull();
    expect(historyHasBlockers(entryHistoryAccounting(unknown))).toBe(true);
  });
  test('native structural references and metadata extents require their actual file reference', () => {
    const index = {
      ...indexRecord(),
      owner: { kind: 'storage-allocation' as const },
      disposition: 'retained-owned' as const,
    };
    expect(readHistoryPage(page([index]))).not.toBeNull();
    expect(readHistoryPage(page([{ ...index, referenceIdentitySha256: [] }]))).toBeNull();
    expect(isHistoryEntry({ ...index, measuredBytes: 1 })).toBe(false);
    const metadata: FileHistoryEntry = {
      ...index,
      kind: 'physicalOverhead',
      identity: {
        domain: 'physical-extent',
        storageDeploymentId: volume.storageDeploymentId,
        storageStoreId: volume.storageStoreId,
        pvUid: volume.pvUid,
        nativeFileIdSha256: volume.nativeFileIdSha256,
        offsetBytes: 0,
        component: 'physicalOverhead',
      },
      owner: { kind: 'storage-format' },
      measuredBytes: 16,
    };
    expect(isHistoryEntry(metadata)).toBe(true);
    expect(isHistoryEntry({ ...metadata, referenceIdentitySha256: [] })).toBe(false);
    expect(isHistoryEntry({ ...metadata, referenceIdentitySha256: [hash('d')] })).toBe(false);
    expect(
      isHistoryEntry({ ...metadata, owner: { kind: 'unresolved' }, disposition: 'unclassified' }),
    ).toBe(true);
  });
  test('repeating the same index identity and overcharging its reference metadata are rejected', () => {
    const record = indexRecord();
    expect(readHistoryPage(page([record, record]))).toBeNull();
    expect(readHistoryPage(page([{ ...record, measuredBytes: 16 }]))).toBeNull();
  });
  test('neither a truncated page nor a single oversized source reference can become EOF', () => {
    expect(readHistoryPage(page([indexRecord()], { eof: false }))).toBeNull();
    expect(
      readHistoryPage(page([{ ...indexRecord(), sourceRevision: 'a'.repeat(65536) }])),
    ).toBeNull();
  });
  test.each([
    'deletionRequired',
    'deletionInFlight',
    'logicallyAbsentPhysicalPending',
    'unclassified',
  ] as const)('zero claimed blockers cannot seal unresolved disposition %s', (key) => {
    const value = emptyHistoryAccounting();
    value.counts.upload = 1;
    value.counts[key] = 1;
    expect(isHistoryAccounting(value)).toBe(true);
    expect(historyHasBlockers(value)).toBe(true);
  });
  test('count conservation rejects a population entry missing its disposition', () => {
    const value = emptyHistoryAccounting();
    value.counts.upload = 1;
    expect(isHistoryAccounting(value)).toBe(false);
  });
  test('unknown sizes propagate and checked arithmetic never saturates', () => {
    const a = entryHistoryAccounting({
      ...indexRecord(),
      kind: 'physicalRecord',
      measuredBytes: null,
    });
    expect(a.counts.unknownSizeCount).toBe(1);
    expect(a.bytes.physicalUnattributed).toBeNull();
    expect(sumHistoryAccounting(emptyHistoryAccounting(), a).bytes.physicalUnattributed).toBeNull();
    expect(() => addInteger(Number.MAX_SAFE_INTEGER, 1)).toThrow();
    expect(() => addInteger(-0, 1)).toThrow();
  });
  test('physical conservation does not discharge known dead records', () => {
    const value = emptyHistoryAccounting();
    Object.assign(value.bytes, {
      physicalFileBytes: 100,
      physicalAllocated: 4096,
      allocatedRetained: 4096,
      physicalLive: 60,
      physicalDead: 30,
      physicalOverhead: 10,
    });
    value.blockers.physicalReclamation = 1;
    expect(conservedPhysicalAccounting(value, 100, 4096)).toBe(true);
    expect(historyHasBlockers(value)).toBe(true);
    expect(conservedPhysicalAccounting(value, 100, 4097)).toBe(false);
  });
  test('inode allocation and encoded content are separate and balanced unknown zero-byte files still refuse', () => {
    const nativeFileIdSha256 = hash('d');
    const fileIdentity = {
      domain: 'physical-file' as const,
      storageDeploymentId: 'deployment',
      storageStoreId: 'store',
      pvUid: 'pv-1',
      nativeFileIdSha256,
      component: 'physicalFile' as const,
    };
    const file: FileHistoryEntry = {
      kind: 'physicalFile',
      identity: fileIdentity,
      sourceRevision: hash('e'),
      owner: { kind: 'storage-allocation' },
      disposition: 'retained-owned',
      measuredBytes: 8,
      reservedBytes: 0,
      referenceIdentitySha256: [],
    };
    const allocation: FileHistoryEntry = {
      ...file,
      kind: 'physicalAllocation',
      identity: { ...fileIdentity, component: 'physicalAllocation' },
      measuredBytes: 4096,
    };
    const alias: FileHistoryEntry = {
      ...file,
      kind: 'physicalAlias',
      identity: {
        domain: 'physical-path',
        storageDeploymentId: 'deployment',
        storageStoreId: 'store',
        pvUid: 'pv-1',
        relativePath: null,
        component: 'physicalAlias',
      },
      measuredBytes: 0,
      referenceIdentitySha256: [digest(fileIdentity)],
    };
    for (const value of [file, allocation, alias]) expect(isHistoryEntry(value)).toBe(true);
    expect(isHistoryEntry({ ...file, reservedBytes: 1 })).toBe(false);
    expect(isHistoryEntry({ ...alias, referenceIdentitySha256: [] })).toBe(false);
    expect(isHistoryEntry({ ...alias, identity: { ...alias.identity, relativePath: '' } })).toBe(
      false,
    );
    const a = [file, allocation, alias].reduce(
      (total, value) => sumHistoryAccounting(total, entryHistoryAccounting(value)),
      emptyHistoryAccounting(),
    );
    a.bytes.physicalOverhead = 8;
    expect(a.counts).toMatchObject({
      physicalFiles: 1,
      physicalAllocations: 1,
      physicalAliases: 1,
    });
    expect(isHistoryAccounting(a)).toBe(true);
    expect(conservedPhysicalAccounting(a, 8, 4096)).toBe(true);
    expect(conservedPhysicalAccounting(a, 4096, 8)).toBe(false);
    expect(sealablePhysicalAccounting(a)).toBe(true);
    const unknown = sumHistoryAccounting(
      a,
      entryHistoryAccounting({
        ...file,
        owner: { kind: 'unresolved' },
        disposition: 'unclassified',
        measuredBytes: 0,
      }),
    );
    const charged = sumHistoryAccounting(
      unknown,
      entryHistoryAccounting({
        ...allocation,
        owner: { kind: 'unresolved' },
        disposition: 'unclassified',
        measuredBytes: 0,
      }),
    );
    expect(conservedPhysicalAccounting(charged, 8, 4096)).toBe(true);
    expect(sealablePhysicalAccounting(charged)).toBe(false);
  });
  test('physical file pages reject gaps, overlaps, source rewind and wrong native file identity', () => {
    const scope = {
      kind: 'physical-file' as const,
      storageDeploymentId: 'deployment',
      storageStoreId: 'store',
      pvUid: 'pv-1',
      nativeFileIdSha256: hash('d'),
    };
    const { kind: _scopeKind, ...coordinate } = scope;
    const extent: FileHistoryEntry = {
      kind: 'physicalRecord',
      identity: {
        domain: 'physical-extent',
        ...coordinate,
        offsetBytes: 0,
        component: 'physicalRecord',
      },
      sourceRevision: hash('e'),
      owner: { kind: 'unresolved' },
      disposition: 'unclassified',
      measuredBytes: 8,
      reservedBytes: 0,
      referenceIdentitySha256: [],
    };
    const good = page([extent], { stream: 'physical-file', scope });
    expect(readHistoryPage(good)).toEqual(good);
    const wrong = (offsetBytes: number) =>
      page([{ ...extent, identity: { ...extent.identity, offsetBytes } } as FileHistoryEntry], {
        stream: 'physical-file',
        scope,
      });
    expect(readHistoryPage(wrong(1))).toBeNull();
    expect(
      readHistoryPage(
        page(
          [
            extent,
            { ...extent, identity: { ...extent.identity, offsetBytes: 4 } } as FileHistoryEntry,
          ],
          { stream: 'physical-file', scope },
        ),
      ),
    ).toBeNull();
    expect(
      readHistoryPage(
        page([extent], {
          stream: 'physical-file',
          scope: { ...scope, nativeFileIdSha256: hash('f') },
        }),
      ),
    ).toBeNull();
    const cursor = { kind: 'physical-file' as const, sourceRevision: hash('a'), offsetBytes: 0 };
    expect(
      readHistoryPage(
        page([extent], {
          stream: 'physical-file',
          scope,
          cursor,
          eof: false,
          nextCursor: { ...cursor, offsetBytes: 8, sourceRevision: hash('b') },
        }),
      ),
    ).toBeNull();
  });
  test('File derivatives already in the baseline are counted once alongside original Upload counters', () => {
    const a = emptyHistoryAccounting();
    Object.assign(a.bytes, {
      uploadOriginal: 13,
      uploadText: 4,
      uploadRecord: 1024,
      fileDerivative: 5,
    });
    a.counts.upload = 1;
    const global = {
      baseline: { originalBytes: 7, objectBytes: 7, textBytes: 5, recordBytes: 8, bundles: 2 },
      originalBytes: 20,
      objectBytes: 20,
      textBytes: 9,
      recordBytes: 1032,
      bundles: 3,
      queueCount: 0,
      queueBytes: 0,
    };
    expect(conservedMongoAccounting(global, a, 0)).toBe(true);
    expect(conservedMongoAccounting({ ...global, textBytes: 14 }, a, 0)).toBe(false);
  });
  test('a forged ready summary cannot omit its last accepted page', () => {
    const summary = {
      ...emptyHistoryAccounting(),
      round: 0,
      lane: 'ready',
      checkpoint: 0,
      sourceBindingSha256: hash('a'),
      storageBindingSha256: hash('b'),
      foldSha256: hash('c'),
      active: { stream: 'volume-index', scope: volume, cursor: null },
      lastPage: null,
      sampleIdentitySha256: [],
    };
    expect(isHistorySummary(summary)).toBe(false);
  });
});

describe('historical pre-census checkpoint handoff', () => {
  test('first real Mongo ingest and a native-settled new round retain actual preparation checkpoints', async () => {
    const run: FileCoverageRun = {
      version: 1,
      requestId: '33333333-3333-4333-8333-333333333333',
      storeId: uploadScope.storeId,
      generation: 1,
      originalDeadline: '2099-01-01T00:00:00.000Z',
      contract: FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
      source: {
        sourceRevision: 'a'.repeat(40),
        imageDigest: `sha256:${hash('b')}`,
        manifestSha256: hash('c'),
      },
      native: {
        invocationId: 'actual-fixture-invocation',
        invocationGeneration: 1,
        originalRequestSha256: hash('d'),
        namespaceUid: runNamespace(),
        mongoReplicaSet: 'fixture',
        mongoDatabase: 'fixture',
        writerCohortSha256: hash('e'),
        oldApplicationCessationSha256: hash('f'),
      },
    };
    const scopes = ['files', 'file-jobs', 'uploads'].map((collection) => ({
      ...uploadScope,
      collection: collection as 'files' | 'file-jobs' | 'uploads',
    }));
    let binding: FileHistoryStorageBinding = {
      storageBindingSha256: hash('1'),
      providerBindingSha256: hash('2'),
      cohortSha256: hash('3'),
      round: 0,
      priorRoundSettlementSha256: null,
      gateways: [hash('4'), hash('5')],
      initial: {
        stream: 'bucket-catalog',
        scope: { kind: 's3-catalog', storageDeploymentId: 'deployment', storageStoreId: 'store' },
        cursor: null,
      },
    };
    const row = {
      _id: '000000000000000000000001',
      user: 'user-a',
      tenantId: 'tenant-a',
      file_id: 'file-a',
      retentionRevision: 1,
      expiredAt: new Date('2099-01-01T00:00:00.000Z'),
      bytes: 8,
      retainedDerivativeBytes: 0,
      retainedDerivativeReservations: [],
    };
    const state = createFileHistoryState(run, scopes, binding),
      ingested: FileHistoryMongoInput[] = [];
    const observations: { collection: string; cursor: unknown; repair: boolean }[] = [];
    const port: FileHistoryAdvancePort = {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      native: {
        bind: async () => binding,
        page: async () => {
          throw new Error('No storage page expected');
        },
        ingest: async (input) => {
          ingested.push(input);
          return {
            inputSha256: input.inputSha256,
            pageSha256: input.page.pageSha256,
            sourceBindingSha256: input.sourceBindingSha256,
            storageBindingSha256: input.storageBindingSha256,
          };
        },
      },
      observe: async (scope, cursor, repair) => {
        observations.push({ collection: scope.collection, cursor, repair });
        return scope.collection === 'files' && cursor === null
          ? mongoHistoryLeaf(scope, { row, classification: 'retained', linkedFileKnown: false })
          : null;
      },
    };
    const originalRunSha256 = digest(run),
      global = {};
    for (let n = 0; n < 2; n++)
      await advanceFileHistory(state, global, digest(['prepare', n]), port);
    expect(ingested).toHaveLength(0);
    expect(state).toMatchObject({ checkpoint: 2, preparingFiles: false });
    await advanceFileHistory(state, global, digest(['first-ingest']), port);
    expect(ingested).toHaveLength(1);
    expect(ingested[0]).toMatchObject({
      checkpoint: 2,
      round: 0,
      page: { stream: 'uploads', scope: { collection: 'files' }, cursor: null, eof: false },
    });
    expect(state.history.lastPage).toMatchObject({ checkpointBefore: 2, checkpointAfter: 3 });
    binding = {
      ...binding,
      round: 1,
      storageBindingSha256: hash('6'),
      priorRoundSettlementSha256: hash('7'),
    };
    await advanceFileHistory(state, global, digest(['settled-new-round']), port);
    expect(state).toMatchObject({ checkpoint: 4, preparingFiles: true, history: { round: 1 } });
    expect(ingested).toHaveLength(1);
    expect(state.history.lastPage).toMatchObject({ checkpointBefore: 3, checkpointAfter: 4 });
    await advanceFileHistory(state, global, digest(['new-preparation-eof']), port);
    await advanceFileHistory(state, global, digest(['new-first-ingest']), port);
    expect(ingested[1]).toMatchObject({
      checkpoint: 5,
      round: 1,
      page: { scope: { collection: 'files' }, cursor: null },
    });
    expect(observations.map((item) => item.repair)).toEqual([true, true, false, true, true, false]);
    expect(digest(state.run)).toBe(originalRunSha256);
    expect(isHistorySummary(state.history)).toBe(true);
  });
});
function runNamespace(): string {
  return '44444444-4444-4444-8444-444444444444';
}
