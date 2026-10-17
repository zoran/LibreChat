/** Public SDK + native host + real Mongo across joined OS processes; no graph/saver mocks. */
import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { createCheckpointNamespace } from '../../stream/checkpoints';
import { getDurableAgentCheckpointer } from '../checkpointer';

type Identity = { pid: number; startTicks: string; bootId: string; processGroup: number };
type Report = {
  type: string;
  checkpointId: string;
  next: string[];
  runId?: string;
  messages?: Array<{ id: string; content: unknown }>;
  steps: Array<{ id: string; agentId: string; status: string; index: number }>;
  fetchCalls?: number;
};
type OwnedChild = {
  child: ChildProcess;
  identity: Identity;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  report: Promise<Report>;
  output: () => string;
  joined?: { code: number | null; signal: NodeJS.Signals | null };
};

function identity(pid: number): Identity | null {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').pop()!.trim().split(/\s+/);
    return {
      pid,
      startTicks: fields[19],
      processGroup: Number(fields[2]),
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function bounded<T>(promise: Promise<T>, label: string, timeout = 45_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function sdkRoot(): string {
  if (process.env.CONTINUATION_SDK_ROOT) return resolve(process.env.CONTINUATION_SDK_ROOT);
  let directory = dirname(require.resolve('@librechat/agents'));
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (
      existsSync(manifest) &&
      JSON.parse(readFileSync(manifest, 'utf8')).name === '@librechat/agents'
    )
      return directory;
    directory = dirname(directory);
  }
  throw new Error('A built public @librechat/agents package is required');
}

let scratch: string;
let mongo: MongoMemoryServer | undefined;
const owned: OwnedChild[] = [];
const provenance: Array<Record<string, unknown>> = [];
async function record() {
  await writeFile(join(scratch, 'processes.json'), JSON.stringify(provenance, null, 2), {
    mode: 0o600,
  });
}
async function start(input: Record<string, unknown>, expected: string): Promise<OwnedChild> {
  const child = fork(join(__dirname, 'fixtures/continuation-child.cjs'), [], {
    cwd: scratch,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      TMPDIR: scratch,
      LANGCHAIN_TRACING_V2: 'false',
      LANGSMITH_TRACING: 'false',
      MONGOMS_RUNTIME_DOWNLOAD: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
  const processIdentity = identity(child.pid!);
  if (!processIdentity) throw new Error('Owned child identity could not be recorded');
  let output = '';
  child.stdout!.on('data', (value) => {
    output += value.toString();
  });
  child.stderr!.on('data', (value) => {
    output += value.toString();
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.once('exit', (code, signal) => done({ code, signal })),
  );
  const report = new Promise<Report>((done, reject) => {
    child.on('message', (value: Report) => {
      if (value.type === expected) done(value);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      reject(new Error(`Child ended before ${expected}: ${code}/${signal}\n${output}`)),
    );
  });
  // Attach immediately so startup failure remains owned while the receipt is persisted.
  void report.catch(() => undefined);
  const actor = { child, identity: processIdentity, exit, report, output: () => output };
  owned.push(actor);
  provenance.push({ phase: input.phase, identity: processIdentity, state: 'started' });
  await record();
  child.send(input);
  return actor;
}

async function stop(actor: OwnedChild, signal: NodeJS.Signals = 'SIGTERM') {
  if (actor.joined) return actor.joined;
  if (actor.child.exitCode === null && actor.child.signalCode === null) {
    const actual = identity(actor.identity.pid);
    if (actual) {
      expect(actual).toEqual(actor.identity);
      actor.child.kill(signal);
    }
  }
  let result;
  try {
    result = await bounded(actor.exit, 'Owned child join', 10_000);
  } catch {
    // A failed test still joins its own child; never signal an unverified PID.
    const actual = identity(actor.identity.pid);
    if (actual) {
      expect(actual).toEqual(actor.identity);
      actor.child.kill('SIGKILL');
    }
    result = await bounded(actor.exit, 'Forced owned child join', 5_000);
  }
  actor.joined = result;
  provenance.push({ identity: actor.identity, state: 'joined', ...result });
  await record();
  expect(identity(actor.identity.pid)).toBeNull();
  return result;
}

beforeAll(async () => {
  if (!process.env.UPLOAD_TEST_TMPDIR) throw new Error('Explicit owned test scratch is required');
  if (!process.env.MONGOMS_SYSTEM_BINARY || process.env.MONGOMS_RUNTIME_DOWNLOAD !== 'false') {
    throw new Error('An installed Mongo binary with runtime downloads disabled is required');
  }
  scratch = await mkdtemp(join(process.env.UPLOAD_TEST_TMPDIR, 'continuation-process-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryServer.create({
    binary: { version: '7.0.43', systemBinary: process.env.MONGOMS_SYSTEM_BINARY },
    instance: {
      dbPath: join(scratch, 'mongo'),
      args: ['--nounixsocket'],
      storageEngine: 'wiredTiger',
    },
  });
  await mongoose.connect(mongo.getUri(), { dbName: 'continuation_process' });
}, 60_000);

afterAll(async () => {
  try {
    for (const actor of owned) await stop(actor);
  } finally {
    try {
      await mongoose.disconnect();
    } finally {
      await mongo?.stop();
    }
    // Keep process receipts and synthetic effect evidence; remove only database files.
    if (scratch) await rm(join(scratch, 'mongo'), { recursive: true, force: true });
  }
}, 30_000);

it('continues native A → B after joined process loss without replaying the completed step', async () => {
  const scope = {
    userId: 'proof-owner',
    tenantId: 'proof-tenant',
    threadId: randomUUID(),
    checkpointNamespace: createCheckpointNamespace('proof-owner', 'proof-tenant'),
  };
  const storage = {
    type: 'mongo' as const,
    ttl: 3600,
    checkpointCollectionName: 'process_checkpoints',
    checkpointWritesCollectionName: 'process_writes',
  };
  const config = {
    configurable: { thread_id: scope.threadId, checkpoint_ns: '' },
    streamMode: 'values',
    version: 'v2',
    recursionLimit: 20,
  };
  const effects = join(scratch, 'synthetic-effects.jsonl');
  const common = {
    scope,
    storage,
    config,
    effects,
    runId: randomUUID(),
    sdkRoot: sdkRoot(),
    apiEntry: process.env.CONTINUATION_API_ENTRY ?? resolve(__dirname, '../../../dist/index.cjs'),
    mongoUri: mongo!.getUri(),
    dbName: 'continuation_process',
  };
  const first = await start({ ...common, phase: 'first' }, 'quiescent');
  const paused = await bounded(first.report, 'Persisted first step');
  expect(paused.next).toEqual(['agent_b']);
  expect(paused.runId).toBe(common.runId);
  const saver = await getDurableAgentCheckpointer(scope, storage);
  const before = await saver.getTuple(config);
  expect(before?.checkpoint.id).toBe(paused.checkpointId);
  expect(before?.checkpoint.channel_values.runStepState).toMatchObject({ runId: common.runId });
  expect(JSON.stringify(before?.checkpoint.channel_values.messages)).toContain('answer-first');
  const savedMessages = before!.checkpoint.channel_values.messages as Array<{
    id: string;
    content: unknown;
  }>;
  const savedAnswer = savedMessages.find((message) => message.content === 'answer-first');
  expect(savedAnswer?.id).toEqual(expect.any(String));
  const firstStep = paused.steps.find(
    (step) => step.agentId === 'agent_a' && step.status === 'completed',
  );
  expect(firstStep).toBeDefined();
  expect(
    (before!.checkpoint.channel_values.runStepState as { nextIndex: number }).nextIndex,
  ).toBeGreaterThan(firstStep!.index);
  const firstEffects = (await readFile(effects, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(firstEffects).toEqual([{ phase: 'first', model: 'first', pid: first.identity.pid }]);
  // Hard loss deliberately prevents graceful shutdown from changing the saved boundary.
  expect(await stop(first, 'SIGKILL')).toEqual({ code: null, signal: 'SIGKILL' });

  const second = await start(
    {
      ...common,
      phase: 'second',
      config: {
        ...config,
        configurable: { ...config.configurable, checkpoint_id: paused.checkpointId },
      },
    },
    'completed',
  );
  const completed = await bounded(second.report, 'Resumed second step');
  expect(await bounded(second.exit, 'Completed process join', 10_000)).toEqual({
    code: 0,
    signal: null,
  });
  expect(second.identity.pid).not.toBe(first.identity.pid);
  expect(completed.next).toEqual([]);
  expect(completed.fetchCalls).toBe(0);
  expect(completed.messages?.map((message) => message.content)).toEqual([
    'Synthetic two-step process proof',
    'answer-first',
    'answer-second',
  ]);
  expect(completed.messages?.find((message) => message.content === 'answer-first')?.id).toBe(
    savedAnswer!.id,
  );
  expect(
    completed.steps.some((step) => step.agentId === 'agent_a' || step.id === firstStep!.id),
  ).toBe(false);
  expect(
    completed.steps.some(
      (step) =>
        step.agentId === 'agent_b' && step.status === 'completed' && step.index > firstStep!.index,
    ),
  ).toBe(true);
  expect(
    (await readFile(effects, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual([
    { phase: 'first', model: 'first', pid: first.identity.pid },
    { phase: 'second', model: 'second', pid: second.identity.pid },
  ]);
  const after = await saver.getTuple(config);
  expect(after?.checkpoint.id).toBe(completed.checkpointId);
  expect(after?.checkpoint.id).not.toBe(paused.checkpointId);
  const history = [];
  for await (const tuple of saver.list(config)) history.push(tuple);
  expect(new Set(history.map((tuple) => tuple.checkpoint.id)).size).toBe(history.length);
  expect(history.some((tuple) => tuple.checkpoint.id === paused.checkpointId)).toBe(true);
  for (const tuple of history) {
    if (tuple.parentConfig)
      expect((await saver.getTuple(tuple.parentConfig))?.checkpoint.id).toBe(
        tuple.parentConfig.configurable?.checkpoint_id,
      );
  }
}, 120_000);
