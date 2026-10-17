/** Native admission + fenced saver + public SDK across joined OS processes; no owner mocks. */
import mongoose from 'mongoose';
import { fork } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import {
  createModels,
  createGenerationAdmissionMethods,
  snapshotGenerationCheckpointAdmission,
} from '@librechat/data-schemas';
import type { GenerationAdmissionInput } from '@librechat/data-schemas';
import type { ChildProcess } from 'node:child_process';
import { checkpointTestEnvironment } from './__tests__/helpers/mongo';
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
  admission: GenerationAdmissionInput;
  nativeIdentity: { podUid: string; source: string; incarnation: string };
  recovery?: { winners: number; aclChecks: number; losingWriteRejected: boolean };
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
let mongo: MongoMemoryReplSet | undefined;
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
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'continuation-process-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
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

it('recovers one native admission after joined process loss, fences old writers and continues only B', async () => {
  const models = createModels(mongoose);
  const methods = createGenerationAdmissionMethods(mongoose);
  await methods.ensureGenerationAdmissionIndexes();
  const user = await models.User.create({
    email: 'recovery-proof@example.invalid',
    tenantId: 'proof-tenant',
  });
  const scope = {
    userId: String(user._id),
    tenantId: 'proof-tenant',
    threadId: randomUUID(),
    checkpointNamespace: createCheckpointNamespace(String(user._id), 'proof-tenant'),
  };
  await models.Conversation.create({
    user: scope.userId,
    tenantId: scope.tenantId,
    conversationId: scope.threadId,
    endpoint: 'agents',
  });
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
    podUid: randomUUID(),
    // Synthetic deployment metadata; process incarnation comes from the native identity owner.
    buildCommit: 'a'.repeat(40),
    clientRequestId: randomUUID(),
    generationEpoch: 1,
    segmentId: randomUUID(),
    graphFingerprint: createHash('sha256')
      .update(await readFile(join(__dirname, 'fixtures/continuation-child.cjs')))
      .digest('hex'),
    policyFingerprint: createHash('sha256')
      .update('checkpoint-only-v1; synthetic-model; no-tools')
      .digest('hex'),
    sdkRoot: sdkRoot(),
    apiEntry: process.env.CONTINUATION_API_ENTRY ?? resolve(__dirname, '../../../dist/index.cjs'),
    mongoUri: mongo!.getUri(),
    dbName: 'continuation_process',
  };
  const first = await start({ ...common, phase: 'first' }, 'quiescent');
  const paused = await bounded(first.report, 'Persisted first step');
  expect(paused.next).toEqual(['agent_b']);
  expect(paused.runId).toBe(common.runId);
  expect(paused.admission).toMatchObject({
    principalId: scope.userId,
    tenantId: scope.tenantId,
    ownerInstanceId: common.podUid,
    processBootId: paused.nativeIdentity.incarnation,
    segmentId: common.segmentId,
    continuation: { runId: common.runId, mode: 'checkpoint-only-v1' },
  });
  const active = await methods.getGenerationAdmission({
    tenantId: scope.tenantId,
    principalId: scope.userId,
    clientRequestId: common.clientRequestId,
  });
  expect(active.ok).toBe(true);
  if (!active.ok || !active.value) throw new Error('Real initial admission unavailable');
  expect(active.value.state).toBe('dispatching');
  expect(active.value.checkpointWriteRevision).toBeGreaterThan(0);
  // Authorize the parent reader from its independent native DB read, not the IPC report.
  // Node IPC objects also originate outside Jest's plain-object realm.
  const predecessor = snapshotGenerationCheckpointAdmission(active.value);
  expect(predecessor).toEqual(paused.admission);
  const saver = await getDurableAgentCheckpointer(scope, storage, predecessor);
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
  const terminated = await stop(first, 'SIGKILL');
  expect(terminated).toEqual({ code: null, signal: 'SIGKILL' });
  const terminationFile = join(scratch, 'joined-predecessor.json');
  await writeFile(
    terminationFile,
    JSON.stringify({
      identity: first.identity,
      exit: terminated,
      admission: predecessor,
      nativeIdentity: paused.nativeIdentity,
    }),
    { mode: 0o600 },
  );

  const second = await start(
    {
      ...common,
      phase: 'second',
      predecessor,
      terminationFile,
      predecessorPid: first.identity.pid,
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
  expect(await stop(second)).toEqual({ code: 0, signal: null });
  expect(second.identity.pid).not.toBe(first.identity.pid);
  expect(completed.nativeIdentity.podUid).toBe(paused.nativeIdentity.podUid);
  expect(completed.nativeIdentity.incarnation).not.toBe(paused.nativeIdentity.incarnation);
  expect(completed.admission.processBootId).toBe(completed.nativeIdentity.incarnation);
  expect(completed.admission.continuation).toEqual(paused.admission.continuation);
  expect(completed.recovery).toMatchObject({ winners: 1, losingWriteRejected: true });
  expect(completed.recovery!.aclChecks).toBe(2);
  const recovered = await methods.getGenerationAdmission(predecessor);
  expect(recovered.ok).toBe(true);
  if (!recovered.ok || !recovered.value) throw new Error('Recovered admission unavailable');
  expect(recovered.value.state).toBe('dispatching');
  expect(recovered.value.processBootId).toBe(completed.nativeIdentity.incarnation);
  expect(recovered.value.recoveries).toHaveLength(1);
  expect(recovered.value.recoveries![0]).toMatchObject({
    ownerInstanceId: paused.admission.ownerInstanceId,
    processBootId: paused.admission.processBootId,
    segmentId: paused.admission.segmentId,
    evidence: {
      checkpointWriteRevision: active.value.checkpointWriteRevision,
      terminationEvidenceSha256: createHash('sha256')
        .update(await readFile(terminationFile))
        .digest('hex'),
      effectsEvidenceSha256: createHash('sha256')
        .update(`${JSON.stringify(firstEffects[0])}\n`)
        .digest('hex'),
    },
  });
  expect(recovered.value.checkpointWriteRevision).toBeGreaterThan(
    active.value.checkpointWriteRevision,
  );
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
  // This is the original real saver instance, captured while its owner was dispatching.
  // Recovery must fence its actual Mongo pending-write path, not only factory creation.
  await expect(
    saver.putWrites(before!.config, [['messages', 'forbidden-late-write']], 'old-owner'),
  ).rejects.toThrow('Durable checkpoint writer no longer holds confirmed admission');
  const afterStale = await methods.getGenerationAdmission(predecessor);
  expect(afterStale).toEqual(recovered);
  expect(
    await mongoose.connection
      .db!.collection(storage.checkpointWritesCollectionName)
      .countDocuments({ task_id: 'old-owner' }),
  ).toBe(0);
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
