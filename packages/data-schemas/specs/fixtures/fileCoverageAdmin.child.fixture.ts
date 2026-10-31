/** Actual admin/Mongo fixtures own streams and normal compiled CLI children; history broker data is synthetic. */
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, chmod, realpath, rm, readFile } from 'node:fs/promises';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
  FILE_HOUSEKEEPING_INVENTORY_CONTRACT,
} from 'librechat-data-provider';
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
} from '../../src/methods/__fixtures__/fileHistoryStorage';
import { fileCoverageDigest } from '../../src/methods/fileHousekeepingCoverageContract';
import { initialFileRetentionActivity } from '../../src/methods/fileActivityTransition';
import { createHousekeepingStore } from '../../src/methods/housekeepingStore';
import { createUploadStore } from '../../src/methods/uploadManagementStore';
import { runFileCoverageAdmin } from '../../src/admin/fileCoverageAdmin';
import { createFileModel } from '../../src/models/file';

export type Frame = {
  kind: string;
  seq: number;
  phase?: string;
  result?: FileCoverageResult;
  [key: string]: unknown;
};

/** One isolated real Mongo owner; caller mutations of the current run remain visible to negative cases. */
export function createFileCoverageAdminFixture(
  mongoose: typeof import('mongoose'),
  currentRun: () => FileCoverageRun,
  POD: string,
) {
  let mongo: MongoMemoryReplSet | undefined;
  let originalEnv: NodeJS.ProcessEnv | undefined;
  let uri: string;
  let target: { mongoReplicaSet: string; mongoDatabase: string };
  const file = createFileModel(mongoose);
  const jobs = createHousekeepingStore(mongoose);
  const store = createUploadStore(mongoose, {});
  let history: ReturnType<typeof createFileHistoryStorageFixture>;
  const invocations = new Set<{ input: PassThrough; result: Promise<number> }>();
  async function start() {
    originalEnv = { ...process.env };
    mongo = new MongoMemoryReplSet({ replSet: { count: 1 } });
    await mongo.start();
    uri = mongo.getUri('test');
    process.env.MONGO_URI = uri;
    process.env.POD_UID = POD;
    process.env.BUILD_COMMIT = 'a'.repeat(40);
    await mongoose.connect(uri);
    const hello = await mongoose.connection.db!.command({ hello: 1 });
    if (typeof hello.setName !== 'string' || !hello.setName)
      throw new Error('Fixture Mongo replica set unavailable');
    target = { mongoReplicaSet: hello.setName, mongoDatabase: mongoose.connection.name };
    await Promise.all([file.init(), store.initialize(), jobs.initialize()]);
  }
  async function close() {
    try {
      for (const invocation of invocations) invocation.input.end();
      await Promise.allSettled([...invocations].map((invocation) => invocation.result));
    } finally {
      try {
        await mongoose.disconnect();
      } finally {
        try {
          await stopMongo();
        } finally {
          if (originalEnv) process.env = originalEnv;
        }
      }
    }
  }
  async function stopMongo() {
    if (mongo && !(await mongo.stop()))
      throw new Error('Owned coverage fixture Mongo did not stop');
  }
  async function reset() {
    await Promise.all([
      store.Counter.deleteMany({}),
      jobs.model.deleteMany({}),
      file.deleteMany({}),
      store.Operation.deleteMany({}),
    ]);
    await store.initialize();
    const counter = await store.Counter.findById('global').lean();
    const run: FileCoverageRun = {
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
        mongoReplicaSet: target.mongoReplicaSet,
        mongoDatabase: target.mongoDatabase,
        writerCohortSha256: 'e'.repeat(64),
        oldApplicationCessationSha256: 'f'.repeat(64),
      },
    };
    history = createFileHistoryStorageFixture(currentRun);
    return { run, history };
  }

  async function historyResponse(frame: Frame, action: FileCoverageAction) {
    const run = currentRun();
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
    const run = currentRun();
    const work = new Set<Promise<void>>();
    let failure: unknown;
    const track = (task: Promise<void>) => {
      const pending = task
        .catch((error: unknown) => {
          failure ??= error;
          input.destroy(error instanceof Error ? error : new Error('Fixture broker failed'));
        })
        .finally(() => work.delete(pending));
      work.add(pending);
    };
    const input = new PassThrough();
    const frames: Frame[] = [];
    const output = new Writable({
      write(bytes, _encoding, done) {
        const frame = JSON.parse(bytes.toString()) as Frame;
        frames.push(frame);
        if (frame.kind === 'assert') {
          track(
            (async () => {
              if (
                (await onAssert?.(frame, input)) !== false &&
                !input.destroyed &&
                !input.writableEnded
              )
                input.write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
            })(),
          );
        }
        if (frame.kind === 'history')
          track(
            historyResponse(frame, action).then((response) => {
              if (!input.destroyed && !input.writableEnded) input.write(response);
            }),
          );
        done();
      },
    });
    const result = runFileCoverageAdmin(input, output).then(async (code) => {
      while (work.size) await Promise.all(work);
      if (failure) throw failure;
      return code;
    });
    const invocation = { input, result };
    invocations.add(invocation);
    void result.then(
      () => invocations.delete(invocation),
      () => invocations.delete(invocation),
    );
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
    const run = currentRun();
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

  return {
    file,
    jobs,
    store,
    start,
    reset,
    close,
    invoke,
    action,
    ready,
    compiled: (mode: string) => runCompiled(mode, uri, POD, currentRun(), historyResponse),
  };
}

/** Normal CJS package export, original child close and all broker writes stay in one fixture custody. */
async function runCompiled(
  mode: string,
  uri: string,
  POD: string,
  run: FileCoverageRun,
  historyResponse: (frame: Frame, action: FileCoverageAction) => Promise<string>,
) {
  const cli = await realpath(
    resolve(__dirname, '../../../../config/file-housekeeping-coverage.js'),
  );
  const compiled = createRequire(cli).resolve('@librechat/data-schemas/file-housekeeping-coverage');
  if (
    (await realpath(compiled)) !==
    (await realpath(resolve(__dirname, '../../dist/admin/fileCoverageAdmin.cjs')))
  )
    throw new Error('Normal compiled coverage admin artifact required');
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
              mongoReplicaSet: run.native.mongoReplicaSet,
              mongoDatabase: run.native.mongoDatabase,
            },
            originalDeadline: run.originalDeadline,
            lookAheadMs: 30_000,
          },
        }
      : { kind: 'open', seq: 0, podUid: POD, run, action: { action: 'begin', run } };
  const correlation =
    mode === 'inventory'
      ? { inventorySha256: fileCoverageDigest(opening.request) }
      : {
          runSha256: fileCoverageDigest(run),
          actionSha256: fileCoverageDigest({ action: 'begin', run }),
        };
  const cwd = await mkdtemp(join(tmpdir(), 'file-coverage-admin-'));
  let joined = true;
  try {
    await chmod(cwd, 0o700);
    const child = spawn(process.execPath, [cli], {
      cwd,
      env: { MONGO_URI: uri, POD_UID: POD, BUILD_COMMIT: run.source.sourceRevision },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    joined = false;
    const frames: Frame[] = [];
    const work = new Set<Promise<void>>();
    let pending = Buffer.alloc(0),
      total = 0,
      errors = '',
      failure: Error | undefined;
    let spawned = false,
      code: number | null = null,
      signal: NodeJS.Signals | null = null;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cancel = (error: Error) => {
      failure ??= error;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 500);
    };
    const closed = new Promise<void>((done) => {
      child.once('error', (error) => {
        failure ??= error;
      });
      child.once('close', (exit, reason) => {
        code = exit;
        signal = reason;
        joined = true;
        done();
      });
    });
    const budget = setTimeout(
      () => cancel(new Error('Compiled admin exceeded original five-second budget')),
      5_000,
    );
    const track = (task: Promise<void>) => {
      const original = task
        .catch((error: unknown) =>
          cancel(error instanceof Error ? error : new Error('Fixture broker failed')),
        )
        .finally(() => work.delete(original));
      work.add(original);
    };
    const write = (value: string) =>
      new Promise<void>((done, reject) => {
        if (child.stdin.destroyed || child.stdin.writableEnded)
          return reject(new Error('Owned child input closed'));
        child.stdin.write(value, (error) => (error ? reject(error) : done()));
      });
    let startTicks: string | undefined;
    const onFrame = async (frame: Frame) => {
      if (failure) return;
      if (frame.kind === 'hello') {
        if (
          !spawned ||
          frame.pid !== child.pid ||
          frame.podUid !== POD ||
          frame.sourceRevision !== run.source.sourceRevision ||
          frame.startTicks !== startTicks ||
          JSON.stringify(frame.contract) !==
            JSON.stringify(
              mode === 'inventory'
                ? FILE_HOUSEKEEPING_INVENTORY_CONTRACT
                : FILE_HOUSEKEEPING_COVERAGE_CONTRACT,
            )
        )
          throw new Error('Compiled admin child identity mismatch');
      }
      if (frame.kind !== 'result')
        for (const [key, value] of Object.entries(correlation))
          if (frame[key] !== value) throw new Error('Compiled admin correlation mismatch');
      if (frame.kind === 'assert')
        await write(JSON.stringify({ kind: 'current', seq: frame.seq }) + '\n');
      if (frame.kind === 'history')
        await write(await historyResponse(frame, { action: 'begin', run }));
    };
    child.stdout.on('data', (bytes: Buffer) => {
      try {
        total += bytes.length;
        if (total > 1_048_576) throw new Error('Compiled admin output budget exceeded');
        pending = Buffer.concat([pending, bytes]);
        let split: number;
        while ((split = pending.indexOf(10)) !== -1) {
          if (split < 1 || split + 1 > 66_560)
            throw new Error('Compiled admin frame limit exceeded');
          const frame = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, split)),
          ) as Frame;
          pending = pending.subarray(split + 1);
          if (
            !frame ||
            !['hello', 'assert', 'history', 'result'].includes(frame.kind) ||
            !Number.isSafeInteger(frame.seq) ||
            frame.seq !== frames.length ||
            frame.seq > 64 ||
            (!frames.length && frame.kind !== 'hello') ||
            (frames.length > 0 &&
              (frame.kind === 'hello' || frames[frames.length - 1].kind === 'result'))
          )
            throw new Error('Compiled admin frame sequence invalid');
          frames.push(frame);
          track(onFrame(frame));
        }
        if (pending.length >= 66_560)
          throw new Error('Compiled admin unterminated frame limit exceeded');
      } catch (error) {
        cancel(error instanceof Error ? error : new Error('Compiled admin frame invalid'));
      }
    });
    child.stderr.on('data', (bytes: Buffer) => {
      if (Buffer.byteLength(errors) + bytes.length > 66_560)
        cancel(new Error('Compiled admin stderr budget exceeded'));
      else errors += bytes.toString();
    });
    child.stdin.on('error', cancel);
    child.stdout.on('error', cancel);
    child.stderr.on('error', cancel);
    child.once('spawn', () => {
      spawned = true;
      track(
        (async () => {
          const stat = await readFile('/proc/' + child.pid + '/stat', 'utf8');
          startTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
          if (!/^\d+$/.test(startTicks)) throw new Error('Owned child start identity unavailable');
          await write(JSON.stringify(opening) + '\n');
        })(),
      );
    });
    try {
      await closed;
      while (work.size) await Promise.all(work);
    } finally {
      clearTimeout(budget);
      clearTimeout(escalation);
    }
    if (failure) throw failure;
    if (!spawned || signal !== null) throw new Error('Owned compiled admin did not exit normally');
    return { child, frames, code, errors, pending: pending.toString(), signal };
  } finally {
    // A signal or missing acknowledgment never proves a remote/native settlement.
    if (joined) await rm(cwd, { recursive: true, force: true });
  }
}
