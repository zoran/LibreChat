/** Real Mongo owner and owned duplex-stream evidence; broker replies are explicitly fixtures. */
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { FILE_HOUSEKEEPING_COVERAGE_CONTRACT } from 'librechat-data-provider';
import type {
  FileCoverageAction,
  FileCoverageRun,
  FileCoverageResult,
  FileHistoryMongoInput,
  FileHistoryStorageRequest,
} from 'librechat-data-provider';
import {
  createFileHistoryStorageFixture,
  assertFileHistoryResult,
} from '../methods/__fixtures__/fileHistoryStorage';
import { inspectFileHousekeepingInventory } from '../methods/fileHousekeepingCoverage';
import { fileCoverageDigest } from '../methods/fileHousekeepingCoverageContract';
import { initialFileRetentionActivity } from '../methods/fileActivityTransition';
import { createHousekeepingStore } from '../methods/housekeepingStore';
import { createUploadStore } from '../methods/uploadManagementStore';
import { runFileCoverageAdmin } from './fileCoverageAdmin';
import { createFileModel } from '../models/file';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const POD = '11111111-1111-4111-8111-111111111111';
type Frame = {
  kind: string;
  seq: number;
  phase?: string;
  result?: FileCoverageResult;
  [key: string]: unknown;
};

describe('fixed File coverage admin', () => {
  let mongo: MongoMemoryReplSet;
  let store: ReturnType<typeof createUploadStore>;
  let run: FileCoverageRun;
  let history: ReturnType<typeof createFileHistoryStorageFixture>;
  let originalEnv: NodeJS.ProcessEnv;
  const file = createFileModel(mongoose);
  const jobs = createHousekeepingStore(mongoose);
  beforeAll(async () => {
    originalEnv = { ...process.env };
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    process.env.MONGO_URI = mongo.getUri();
    process.env.POD_UID = POD;
    process.env.BUILD_COMMIT = 'a'.repeat(40);
    await mongoose.connect(mongo.getUri());
    store = createUploadStore(mongoose, {});
    await Promise.all([file.init(), store.initialize(), jobs.initialize()]);
  });
  beforeEach(async () => {
    await Promise.all([
      store.Counter.deleteMany({}),
      jobs.model.deleteMany({}),
      file.deleteMany({}),
      store.Operation.deleteMany({}),
    ]);
    await store.initialize();
    const counter = await store.Counter.findById('global').lean();
    run = {
      version: 1,
      requestId: randomUUID(),
      storeId: (counter!.value as { storeId: string }).storeId,
      generation: 1,
      originalDeadline: new Date(Date.now() + 60_000).toISOString(),
      contract: FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
      source: {
        sourceRevision: 'a'.repeat(40),
        imageDigest: `sha256:${'b'.repeat(64)}`,
        manifestSha256: 'c'.repeat(64),
      },
      native: {
        invocationId: 'fixture-invocation',
        invocationGeneration: 1,
        originalRequestSha256: 'd'.repeat(64),
        namespaceUid: randomUUID(),
        mongoReplicaSet: 'testset',
        mongoDatabase: 'test',
        writerCohortSha256: 'e'.repeat(64),
        oldApplicationCessationSha256: 'f'.repeat(64),
      },
    };
    history = createFileHistoryStorageFixture(() => run);
  });
  afterEach(() => jest.restoreAllMocks());
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
    process.env = originalEnv;
  });

  async function historyResponse(frame: Frame, action: FileCoverageAction) {
    expect(Object.keys(frame).sort()).toEqual(
      ['kind', 'seq', 'method', 'runSha256', 'actionSha256', 'payload'].sort(),
    );
    expect(frame.runSha256).toBe(fileCoverageDigest(run));
    expect(frame.actionSha256).toBe(fileCoverageDigest(action));
    expect(frame.seq).toBeLessThanOrEqual(64);
    const signal = new AbortController().signal;
    let payload: unknown;
    if (frame.method === 'bind') {
      expect(frame.payload).toEqual({ runSha256: fileCoverageDigest(run) });
      payload = await history.port.bind(fileCoverageDigest(run), signal);
    } else if (frame.method === 'ingest')
      payload = await history.port.ingest(frame.payload as FileHistoryMongoInput, signal);
    else if (frame.method === 'page')
      payload = await history.port.page(frame.payload as FileHistoryStorageRequest, signal);
    else throw new Error('Unexpected fixture history method');
    const response =
      JSON.stringify({ kind: 'history-result', seq: frame.seq, method: frame.method, payload }) +
      '\n';
    expect(Buffer.byteLength(response)).toBeLessThanOrEqual(66560);
    return response;
  }

  function invoke(
    action: FileCoverageAction,
    onAssert?: (frame: Frame, input: PassThrough) => Promise<boolean | void>,
  ) {
    const input = new PassThrough();
    const frames: Frame[] = [];
    const output = new Writable({
      write(bytes, _encoding, done) {
        const frame = JSON.parse(bytes.toString()) as Frame;
        frames.push(frame);
        if (frame.kind === 'assert') {
          void (async () => {
            if (
              (await onAssert?.(frame, input)) !== false &&
              !input.destroyed &&
              !input.writableEnded
            )
              input.write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
          })();
        }
        if (frame.kind === 'history')
          void historyResponse(frame, action)
            .then((response) => {
              if (!input.destroyed && !input.writableEnded) input.write(response);
            })
            .catch((error: Error) => input.destroy(error));
        done();
      },
    });
    const result = runFileCoverageAdmin(input, output);
    input.write(JSON.stringify({ kind: 'open', seq: 0, podUid: POD, run, action }) + '\n');
    return { input, frames, result };
  }
  async function action(value: FileCoverageAction) {
    const invocation = invoke(value);
    expect(await invocation.result).toBe(0);
    expect(invocation.frames[invocation.frames.length - 2]).toMatchObject({
      kind: 'assert',
      phase: 'closed',
    });
    expect(invocation.frames[invocation.frames.length - 1]).toMatchObject({ kind: 'result' });
    const result = invocation.frames[invocation.frames.length - 1]!.result!;
    assertFileHistoryResult(result);
    return result;
  }
  async function ready() {
    const user = new mongoose.Types.ObjectId(),
      deadline = new Date(Date.now() + 86_400_000);
    const retained = {
      user,
      tenantId: 'tenant-a',
      file_id: 'retained-admin-file',
      filename: 'file',
      filepath: `https://fixture.invalid/retained-test-files/t/tenant-a/files/${user}/admin`,
      source: 's3',
      storageKey: `t/tenant-a/files/${user}/admin`,
      type: 'text/plain',
      bytes: 1,
      expiredAt: deadline,
      retentionRevision: 0,
      retainedDerivativeBytes: 0,
      retainedDerivativeReservations: [],
      retentionActivity: initialFileRetentionActivity(deadline, new Date(0), 'complete'),
    };
    history.registerFile(retained);
    await file.create(retained);
    let result = await action({ action: 'begin', run });
    for (let n = 0; n < 192 && result.outcome === 'progress' && result.lane !== 'ready'; n++)
      result = await action({ action: 'advance', run, expectedCheckpoint: result.checkpoint });
    expect(result).toMatchObject({ outcome: 'progress', lane: 'ready' });
    return result as Extract<FileCoverageResult, { outcome: 'progress' }>;
  }

  test.each([false, true])(
    'cutover inspect: expired original run stays read-only and joins original client close (rejection %s)',
    async (rejectClose) => {
      const progress = await ready();
      const sealed = await action({
        action: 'verify-seal',
        run,
        expectedCheckpoint: progress.checkpoint,
      });
      expect(sealed.outcome).toBe('sealed');
      const before = await store.Counter.findById('global').lean();
      const originalRunHash = fileCoverageDigest(run);
      const entered = deferred(),
        release = deferred();
      const close = mongoose.Connection.prototype.close;
      const spy = jest
        .spyOn(mongoose.Connection.prototype, 'close')
        .mockImplementation(async function (this: mongoose.Connection, ...args) {
          entered.resolve();
          await release.promise;
          await close.apply(this, args);
          if (rejectClose) throw new Error('fixture original client close rejected');
        });
      const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse(run.originalDeadline) + 1);
      const invocation = invoke({
        action: 'inspect',
        version: 1,
        storeId: run.storeId,
        generation: run.generation,
        runSha256: originalRunHash,
      });
      let settled = false;
      void invocation.result.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        expect(settled).toBe(false);
        expect(invocation.frames.some((frame) => frame.kind === 'result')).toBe(false);
      } finally {
        release.resolve();
      }
      try {
        expect(await invocation.result).toBe(rejectClose ? 1 : 0);
        expect(
          invocation.frames.filter((frame) => frame.kind === 'assert').map((frame) => frame.phase),
        ).toEqual(['before-open', 'connected', 'before-action', 'owner', 'closed']);
        expect(invocation.frames[invocation.frames.length - 1]?.result).toMatchObject(
          rejectClose
            ? { outcome: 'refused', code: 'unavailable' }
            : {
                outcome: 'observed',
                phase: 'sealed',
                receipt: (sealed as { receipt: unknown }).receipt,
                catalog: { collectionUuid: expect.any(String), fileTtlIndexes: [] },
              },
        );
        expect(fileCoverageDigest(run)).toBe(originalRunHash);
      } finally {
        spy.mockRestore();
        clock.mockRestore();
      }
      expect(await store.Counter.findById('global').lean()).toEqual(before);
    },
  );

  test('cutover inspect: a rehashed receipt cannot change the original native binding', async () => {
    const progress = await ready();
    const sealed = await action({
      action: 'verify-seal',
      run,
      expectedCheckpoint: progress.checkpoint,
    });
    if (sealed.outcome !== 'sealed') throw new Error('fixture did not seal');
    const { receiptSha256: _hash, ...body } = {
      ...sealed.receipt,
      native: { ...sealed.receipt.native, writerCohortSha256: '0'.repeat(64) },
    };
    await store.Counter.updateOne(
      { _id: 'global' },
      {
        $set: {
          'value.fileHousekeepingCoverage.receipt': {
            ...body,
            receiptSha256: fileCoverageDigest(body),
          },
        },
      },
    );
    const invocation = invoke({
      action: 'inspect',
      version: 1,
      storeId: run.storeId,
      generation: run.generation,
      runSha256: fileCoverageDigest(run),
    });
    expect(await invocation.result).toBe(1);
    expect(invocation.frames[invocation.frames.length - 1]?.result).toEqual({
      outcome: 'refused',
      code: 'unavailable',
    });
  });

  test.each([false, true])(
    'temporary absence: prepared result waits for original admin close (rejection %s)',
    async (rejectClose) => {
      await file.collection.createIndex(
        { expiresAt: 1 },
        { name: 'expiresAt_1', expireAfterSeconds: 3600 },
      );
      await file.collection.insertOne({
        file_id: 'permanent-admin',
        user: new mongoose.Types.ObjectId(),
      } as never);
      const [catalog] = await mongoose.connection
        .db!.listCollections({ name: 'files' }, { nameOnly: false })
        .toArray();
      const index = (await file.collection.listIndexes().toArray()).find(
        (value) => value.name === 'expiresAt_1',
      )!;
      const observation = await inspectFileHousekeepingInventory(
        mongoose,
        {
          action: 'inventory',
          version: 1,
          requestId: run.requestId,
          source: run.source,
          target: {
            namespaceUid: run.native.namespaceUid,
            mongoReplicaSet: run.native.mongoReplicaSet,
            mongoDatabase: run.native.mongoDatabase,
          },
          originalDeadline: run.originalDeadline,
          lookAheadMs: 0,
        },
        new AbortController().signal,
      );
      if (observation.outcome !== 'inventoried') throw new Error('fixture catalog unavailable');
      const input: FileCoverageAction = {
        action: 'prepare-ttl',
        run,
        collectionUuid: catalog.info!.uuid!.toUUID().toHexString(),
        indexName: index.name!,
        indexSha256: observation.ttl.indexes[0].specSha256,
      };
      const entered = deferred(),
        release = deferred();
      const close = mongoose.Connection.prototype.close;
      const spy = jest
        .spyOn(mongoose.Connection.prototype, 'close')
        .mockImplementation(async function (this: mongoose.Connection, ...args) {
          entered.resolve();
          await release.promise;
          await close.apply(this, args);
          if (rejectClose) throw new Error('fixture original client close rejected');
        });
      const invocation = invoke(input);
      let settled = false;
      void invocation.result.then(() => {
        settled = true;
      });
      try {
        await entered.promise;
        expect(settled).toBe(false);
        expect(invocation.frames.some((frame) => frame.kind === 'result')).toBe(false);
      } finally {
        release.resolve();
      }
      try {
        expect(await invocation.result).toBe(rejectClose ? 1 : 0);
        expect(invocation.frames[invocation.frames.length - 2]).toMatchObject({
          kind: 'assert',
          phase: 'closed',
        });
        expect(invocation.frames[invocation.frames.length - 1]).toMatchObject({
          kind: 'result',
          result: rejectClose
            ? { outcome: 'unknown', code: 'unknown_commit' }
            : { outcome: 'prepared', population: { totalFiles: 1, expiresAtAbsentOrNull: 1 } },
        });
        expect((await store.Counter.findById('global').lean())!.value).not.toHaveProperty(
          'fileHousekeepingCoverage',
        );
      } finally {
        spy.mockRestore();
      }
    },
  );

  test('executes the actual Mongo owner through seal and reads only its exact receipt', async () => {
    const progress = await ready();
    const sealed = await action({
      action: 'verify-seal',
      run,
      expectedCheckpoint: progress.checkpoint,
    });
    expect(sealed).toMatchObject({
      outcome: 'sealed',
      receipt: {
        version: 1,
        contract: { ...FILE_HOUSEKEEPING_COVERAGE_CONTRACT, version: 2 },
        native: { oldApplicationCessationSha256: run.native.oldApplicationCessationSha256 },
        history: {
          counts: { file: 1, fileJob: 3, object: 1, indexRecord: 2, physicalReplica: 2 },
          bytes: { fileOriginal: 1, fileDerivative: 0, physicalAllocated: 32768 },
        },
      },
    });
    const observed = await action({
      action: 'inspect',
      version: 1,
      storeId: run.storeId,
      generation: run.generation,
      runSha256: fileCoverageDigest(run),
    });
    expect(observed).toMatchObject({
      outcome: 'observed',
      phase: 'sealed',
      receipt: (sealed as { receipt: unknown }).receipt,
    });
    const row = await store.Counter.findById('global').lean();
    expect(row!.value).toHaveProperty(
      'fileHousekeepingCoverage.receipt',
      (sealed as { receipt: unknown }).receipt,
    );
  });

  test.each(['pod', 'source', 'action', 'contract', 'legacy-native', 'extra-native'])(
    'rejects changed %s identity before opening Mongo',
    async (change) => {
      const opening = jest.spyOn(mongoose.Mongoose.prototype, 'connect');
      let value: FileCoverageAction = { action: 'begin', run: structuredClone(run) };
      if (change === 'pod') process.env.POD_UID = randomUUID();
      if (change === 'source')
        value = {
          action: 'begin',
          run: { ...run, source: { ...run.source, sourceRevision: '0'.repeat(40) } },
        };
      if (change === 'action')
        value = {
          action: 'begin',
          run: { ...run, originalDeadline: new Date(Date.now() + 20_000).toISOString() },
        };
      if (change === 'contract') (value.run.contract as { version: number }).version = 1;
      if (change === 'legacy-native' || change === 'extra-native') {
        const native = value.run.native as unknown as Record<string, unknown>;
        native.oldTimerDrainSha256 = native.oldApplicationCessationSha256;
        if (change === 'legacy-native') delete native.oldApplicationCessationSha256;
      }
      // Keep the opening and action identical: the current contract must reject the data itself.
      if (['contract', 'legacy-native', 'extra-native'].includes(change)) run = value.run;
      try {
        const invocation = invoke(value);
        expect(await invocation.result).toBe(1);
        expect(opening).not.toHaveBeenCalled();
        expect(invocation.frames.some((frame) => frame.kind === 'hello')).toBe(false);
      } finally {
        process.env.POD_UID = POD;
      }
    },
  );

  test('checks the real connected replica set before a data-owner mutation', async () => {
    run = { ...run, native: { ...run.native, mongoReplicaSet: 'wrong-rs' } };
    const before = await store.Counter.findById('global').lean();
    const invocation = invoke({ action: 'begin', run });
    expect(await invocation.result).toBe(1);
    expect(await store.Counter.findById('global').lean()).toEqual(before);
    expect(invocation.frames[invocation.frames.length - 1]).toMatchObject({
      result: { outcome: 'refused', code: 'unavailable' },
    });
  });

  test('rejects an altered broker sequence after connect without mutation', async () => {
    const before = await store.Counter.findById('global').lean();
    const invocation = invoke({ action: 'begin', run }, async (frame, input) => {
      if (frame.phase !== 'connected') return;
      input.write(JSON.stringify({ kind: 'current', seq: frame.seq - 1 }) + '\n');
      return false;
    });
    expect(await invocation.result).toBe(1);
    expect(await store.Counter.findById('global').lean()).toEqual(before);
  });

  test('retains the original opening after stream loss and closes the eventual client', async () => {
    const entered = deferred(),
      release = deferred(),
      closed = deferred();
    const connect = mongoose.Mongoose.prototype.connect;
    const close = mongoose.Connection.prototype.close;
    jest.spyOn(mongoose.Mongoose.prototype, 'connect').mockImplementation(async function (
      this: mongoose.Mongoose,
      ...args
    ) {
      entered.resolve();
      await release.promise;
      return await connect.apply(this, args);
    });
    jest.spyOn(mongoose.Connection.prototype, 'close').mockImplementation(async function (
      this: mongoose.Connection,
      ...args
    ) {
      const value = await close.apply(this, args);
      closed.resolve();
      return value;
    });
    const invocation = invoke({ action: 'begin', run });
    let settled = false;
    void invocation.result.then(() => {
      settled = true;
    });
    await entered.promise;
    invocation.input.end();
    await delay(20);
    expect(settled).toBe(false);
    release.resolve();
    expect(await invocation.result).toBe(1);
    await closed.promise;
    expect(invocation.frames.some((frame) => frame.kind === 'result')).toBe(false);
    expect((await store.Counter.findById('global').lean())!.value).not.toHaveProperty(
      'fileHousekeepingCoverage',
    );
  });

  test('a persisted seal and lost stream cannot substitute for original close or remote success', async () => {
    const progress = await ready();
    const closing = deferred(),
      release = deferred();
    const close = mongoose.Connection.prototype.close;
    jest.spyOn(mongoose.Connection.prototype, 'close').mockImplementation(async function (
      this: mongoose.Connection,
      ...args
    ) {
      closing.resolve();
      await release.promise;
      return await close.apply(this, args);
    });
    const invocation = invoke({
      action: 'verify-seal',
      run,
      expectedCheckpoint: progress.checkpoint,
    });
    let settled = false;
    void invocation.result.then(() => {
      settled = true;
    });
    await closing.promise;
    expect((await store.Counter.findById('global').lean())!.value).toHaveProperty(
      'fileHousekeepingCoverage.phase',
      'sealed',
    );
    invocation.input.end();
    await delay(20);
    expect(settled).toBe(false);
    expect(invocation.frames.some((frame) => frame.kind === 'result')).toBe(false);
    release.resolve();
    expect(await invocation.result).toBe(1);
  });

  test('deadline cancellation still joins an original pending client close', async () => {
    run = { ...run, originalDeadline: new Date(Date.now() + 600).toISOString() };
    const closing = deferred(),
      release = deferred();
    const close = mongoose.Connection.prototype.close;
    jest.spyOn(mongoose.Connection.prototype, 'close').mockImplementation(async function (
      this: mongoose.Connection,
      ...args
    ) {
      closing.resolve();
      await release.promise;
      return await close.apply(this, args);
    });
    const invocation = invoke({ action: 'begin', run });
    let settled = false;
    void invocation.result.then(() => {
      settled = true;
    });
    await closing.promise;
    await delay(650);
    expect(settled).toBe(false);
    release.resolve();
    expect(await invocation.result).toBe(1);
    expect(invocation.frames.some((frame) => frame.kind === 'result')).toBe(false);
  });

  test.each([
    ['EOF', false],
    ['EOF', true],
    ['deadline', false],
    ['deadline', true],
  ] as const)(
    'retains original output after %s until its callback settles (write error: %s)',
    async (cancellation, writeError) => {
      const entered = deferred();
      let finishWrite!: (error?: Error) => void;
      const input = new PassThrough();
      const frames: Frame[] = [];
      const output = new Writable({
        write(bytes, _encoding, done) {
          frames.push(JSON.parse(bytes.toString()) as Frame);
          finishWrite = done;
          entered.resolve();
        },
      });
      if (cancellation === 'deadline')
        run = { ...run, originalDeadline: new Date(Date.now() + 100).toISOString() };
      const opening = jest.spyOn(mongoose.Mongoose.prototype, 'connect');
      const result = runFileCoverageAdmin(input, output);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      input.write(
        JSON.stringify({
          kind: 'open',
          seq: 0,
          podUid: POD,
          run,
          action: { action: 'begin', run },
        }) + '\n',
      );
      await entered.promise;
      if (cancellation === 'EOF') input.end();
      try {
        await delay(cancellation === 'EOF' ? 20 : 150);
        expect(settled).toBe(false);
        expect(output.listenerCount('error')).toBeGreaterThan(0);
        expect(frames.map((frame) => frame.kind)).toEqual(['hello']);
        expect(opening).not.toHaveBeenCalled();
      } finally {
        // Ensure even the deliberately failing preimage leaves no held fixture.
        if (output.listenerCount('error') === 0) output.once('error', () => {});
        finishWrite(writeError ? new Error('fixture late write failure') : undefined);
        expect(await result).toBe(1);
        await delay(20);
      }
      expect(frames.some((frame) => frame.kind === 'result')).toBe(false);
    },
  );

  test('expired inspect is read only and does not initialize a replacement store', async () => {
    run = { ...run, originalDeadline: new Date(0).toISOString() };
    const before = await store.Counter.findById('global').lean();
    const result = await action({
      action: 'inspect',
      version: 1,
      storeId: run.storeId,
      generation: run.generation,
      runSha256: fileCoverageDigest(run),
    });
    expect(result).toMatchObject({ outcome: 'observed', phase: 'absent', receipt: null });
    expect(await store.Counter.findById('global').lean()).toEqual(before);
  });

  test('bounded malformed input cannot dispatch or leak its contents', async () => {
    for (const bytes of [
      Buffer.from([0xff, 10]),
      Buffer.from('null\n'),
      Buffer.alloc(66_561, 120),
    ]) {
      const input = new PassThrough(),
        output = new PassThrough();
      const chunks: Buffer[] = [];
      output.on('data', (chunk) => chunks.push(chunk));
      const pending = runFileCoverageAdmin(input, output);
      input.write(bytes);
      expect(await pending).toBe(1);
      expect(Buffer.concat(chunks).toString()).not.toContain('xxxxxxxx');
    }
  });

  test.each(['coverage', 'inventory'])(
    'the fixed CJS entry executes the compiled %s admin in a real owned child',
    async (mode) => {
      if (mode === 'inventory') await store.Counter.deleteMany({});
      const fixture = process.env.FILE_COVERAGE_ADMIN_FIXTURE_ROOT!;
      expect(fixture).toBeTruthy();
      const child = spawn(
        process.execPath,
        [fixture + '/candidate/config/file-housekeeping-coverage.js'],
        {
          env: { ...process.env, NODE_PATH: process.env.FILE_COVERAGE_ADMIN_MODULES },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const frames: Frame[] = [];
      let pending = '',
        errors = '';
      child.stdout.on('data', (bytes) => {
        pending += bytes.toString();
        let split: number;
        while ((split = pending.indexOf('\n')) >= 0) {
          const frame = JSON.parse(pending.slice(0, split)) as Frame;
          pending = pending.slice(split + 1);
          frames.push(frame);
          if (frame.kind === 'assert')
            child.stdin.write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
          if (frame.kind === 'history')
            void historyResponse(frame, { action: 'begin', run })
              .then((response) => {
                if (!child.stdin.destroyed && !child.stdin.writableEnded)
                  child.stdin.write(response);
              })
              .catch((error: Error) => {
                errors += error.message;
                child.stdin.end();
              });
        }
      });
      child.stderr.on('data', (bytes) => {
        errors += bytes.toString();
      });
      const opening =
        mode === 'inventory'
          ? {
              kind: 'inventory',
              seq: 0,
              podUid: POD,
              request: {
                action: 'inventory',
                version: 1,
                requestId: randomUUID(),
                source: run.source,
                target: {
                  namespaceUid: run.native.namespaceUid,
                  mongoReplicaSet: 'testset',
                  mongoDatabase: 'test',
                },
                originalDeadline: run.originalDeadline,
                lookAheadMs: 30_000,
              },
            }
          : { kind: 'open', seq: 0, podUid: POD, run, action: { action: 'begin', run } };
      child.stdin.write(JSON.stringify(opening) + '\n');
      // Fixture cancellation is a failed test, never native remote-settlement proof.
      const timeout = setTimeout(() => child.kill('SIGTERM'), 5_000);
      const code = await new Promise((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      }).finally(() => clearTimeout(timeout));
      expect({ code, errors, pending }).toEqual({ code: 0, errors: '', pending: '' });
      expect(frames[0]).toMatchObject({ kind: 'hello', pid: child.pid });
      expect(frames[frames.length - 1]).toMatchObject({
        kind: 'result',
        result: { outcome: mode === 'inventory' ? 'inventoried' : 'progress' },
      });
      if (mode === 'inventory') expect(await store.Counter.countDocuments()).toBe(0);
      else
        expect((await store.Counter.findById('global').lean())!.value).toHaveProperty(
          'fileHousekeepingCoverage.phase',
          'preparing',
        );
    },
  );
  test('inventory distinct opening reads actual Mongo without a Counter, mutation or synthetic run', async () => {
    await store.Counter.deleteMany({});
    const input = new PassThrough();
    const frames: Frame[] = [];
    const output = new Writable({
      write(bytes, _encoding, done) {
        const frame = JSON.parse(bytes.toString()) as Frame;
        frames.push(frame);
        if (frame.kind === 'assert')
          input.write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
        done();
      },
    });
    const pending = runFileCoverageAdmin(input, output);
    input.write(
      JSON.stringify({
        kind: 'inventory',
        seq: 0,
        podUid: POD,
        request: {
          action: 'inventory',
          version: 1,
          requestId: randomUUID(),
          source: run.source,
          target: {
            namespaceUid: run.native.namespaceUid,
            mongoReplicaSet: 'testset',
            mongoDatabase: 'test',
          },
          originalDeadline: new Date(Date.now() + 60_000).toISOString(),
          lookAheadMs: 30_000,
        },
      }) + '\n',
    );
    expect(await pending).toBe(0);
    expect(frames[0]).toMatchObject({
      kind: 'hello',
      contract: { id: 'file-housekeeping-inventory', version: 1 },
    });
    expect(frames[0]).not.toHaveProperty('runSha256');
    expect(frames[frames.length - 1]).toMatchObject({
      kind: 'result',
      result: { outcome: 'inventoried', diagnosticOnly: true, counts: { totalFiles: 0 } },
    });
    expect(await store.Counter.countDocuments()).toBe(0);
  });

  test.each(['extra-query', 'synthetic-run', 'source', 'deadline', 'horizon'])(
    'inventory refuses %s before opening Mongo',
    async (invalid) => {
      const opening = jest.spyOn(mongoose.Mongoose.prototype, 'connect');
      const request = {
        action: 'inventory',
        version: 1,
        requestId: randomUUID(),
        source: { ...run.source },
        target: {
          namespaceUid: run.native.namespaceUid,
          mongoReplicaSet: 'testset',
          mongoDatabase: 'test',
        },
        originalDeadline: new Date(Date.now() + 60_000).toISOString(),
        lookAheadMs: 30_000,
      };
      const value: Record<string, unknown> = { kind: 'inventory', seq: 0, podUid: POD, request };
      if (invalid === 'extra-query')
        Object.assign(request, { query: { filename: 'private-input' } });
      if (invalid === 'synthetic-run') value.run = run;
      if (invalid === 'source') request.source.sourceRevision = '0'.repeat(40);
      if (invalid === 'deadline') request.originalDeadline = new Date(0).toISOString();
      if (invalid === 'horizon') request.lookAheadMs = 300_001;
      const input = new PassThrough();
      const frames: Frame[] = [];
      const output = new Writable({
        write(bytes, _encoding, done) {
          frames.push(JSON.parse(bytes.toString()) as Frame);
          done();
        },
      });
      const pending = runFileCoverageAdmin(input, output);
      input.write(JSON.stringify(value) + '\n');
      expect(await pending).toBe(1);
      expect(opening).not.toHaveBeenCalled();
      expect(JSON.stringify(frames)).not.toContain('private-input');
      expect(frames.some((frame) => frame.kind === 'hello')).toBe(false);
    },
  );
  test('inventory retains the original Mongo close after stream loss and emits no successful result', async () => {
    const closing = deferred(),
      release = deferred();
    const close = mongoose.Connection.prototype.close;
    jest.spyOn(mongoose.Connection.prototype, 'close').mockImplementation(async function (
      this: mongoose.Connection,
      ...args
    ) {
      closing.resolve();
      await release.promise;
      return await close.apply(this, args);
    });
    const input = new PassThrough();
    const frames: Frame[] = [];
    const output = new Writable({
      write(bytes, _encoding, done) {
        const frame = JSON.parse(bytes.toString()) as Frame;
        frames.push(frame);
        if (frame.kind === 'assert')
          input.write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
        done();
      },
    });
    const pending = runFileCoverageAdmin(input, output);
    input.write(
      JSON.stringify({
        kind: 'inventory',
        seq: 0,
        podUid: POD,
        request: {
          action: 'inventory',
          version: 1,
          requestId: randomUUID(),
          source: run.source,
          target: {
            namespaceUid: run.native.namespaceUid,
            mongoReplicaSet: 'testset',
            mongoDatabase: 'test',
          },
          originalDeadline: run.originalDeadline,
          lookAheadMs: 30_000,
        },
      }) + '\n',
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    try {
      await closing.promise;
      input.end();
      await delay(20);
      expect(settled).toBe(false);
      expect(frames.some((frame) => frame.kind === 'result')).toBe(false);
    } finally {
      release.resolve();
    }
    expect(await pending).toBe(1);
    expect(frames.some((frame) => frame.kind === 'result')).toBe(false);
  });
});
