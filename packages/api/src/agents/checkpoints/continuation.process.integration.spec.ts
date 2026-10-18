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
  createMethods,
  createUploadManagementRepository,
  createGenerationAdmissionMethods,
  snapshotGenerationCheckpointAdmission,
  snapshotCheckpointSourceBinding,
  tenantStorage,
} from '@librechat/data-schemas';
import type { GenerationAdmissionInput, CheckpointSourceBinding } from '@librechat/data-schemas';
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
  sourceBinding?: CheckpointSourceBinding;
  nativeJob?: {
    createdAt: number;
    providerExecutionId: string;
    checkpointNamespace: string;
    generationProtocolVersion: number;
  };
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
const sourcePolicy = 'c'.repeat(64);
const sourceText = 'Retained native source for the two-step process proof';
const originalPolicy = process.env.UPLOAD_SECURITY_POLICY_SHA256;
const originalManaged = process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED;
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
  provenance.push({
    phase: input.phase,
    identity: processIdentity,
    state: 'started',
    argv: [process.execPath, join(__dirname, 'fixtures/continuation-child.cjs')],
    redisUri: input.redisUri,
    redisPrefix: input.redisPrefix,
    redisServiceReceipt: process.env.CONTINUATION_REDIS_RECEIPT,
  });
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
  const redisUri = new URL(process.env.CONTINUATION_REDIS_URI ?? process.env.REDIS_URI ?? '');
  if (
    redisUri.protocol !== 'redis:' ||
    redisUri.hostname !== '127.0.0.1' ||
    redisUri.username ||
    redisUri.password
  )
    throw new Error('An explicitly owned loopback Redis-protocol test service is required');
  const environment = checkpointTestEnvironment();
  scratch = await mkdtemp(join(environment.scratchRoot, 'continuation-process-'));
  await mkdir(join(scratch, 'mongo'), { mode: 0o700 });
  mongo = await MongoMemoryReplSet.create({
    binary: environment.binary,
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    instanceOpts: [{ dbPath: join(scratch, 'mongo'), args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri(), { dbName: 'continuation_process' });
  createModels(mongoose);
  await Promise.all(Object.values(mongoose.models).map((model) => model.init()));
  process.env.UPLOAD_SECURITY_POLICY_SHA256 = sourcePolicy;
  process.env.CORTEX_UPLOAD_MANAGEMENT_ENABLED = 'true';
  await createUploadManagementRepository(mongoose, {
    enabled: true,
    reconciled: true,
  }).initialize();
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
    for (const [key, value] of [
      ['UPLOAD_SECURITY_POLICY_SHA256', originalPolicy],
      ['CORTEX_UPLOAD_MANAGEMENT_ENABLED', originalManaged],
    ]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
  }
}, 30_000);

it.each([
  'continue',
  'changed message',
  'revoked file',
  'expired source',
  'disabled principal',
  'unknown recovery commit',
  'unknown jobstore commit',
  'source deadline before start',
  'source deadline during authorize',
  'unknown capture commit',
])(
  'uses actual native source continuation with %s',
  async (scenario) => {
    const models = createModels(mongoose);
    const methods = createGenerationAdmissionMethods(mongoose);
    await methods.ensureGenerationAdmissionIndexes();
    const user = await models.User.create({
      email: `recovery-proof-${randomUUID()}@example.invalid`,
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
    const owner = { userId: scope.userId, tenantId: scope.tenantId };
    const fileId = randomUUID();
    const now = Date.now();
    // Security approval receipt and original object bytes are explicit local fixtures.
    // Native File/Message ownership, capture, accounting and Mongo fences remain real.
    await models.File.collection.insertOne({
      file_id: fileId,
      uploadOperationId: fileId,
      user: user._id,
      tenantId: owner.tenantId,
      status: 'ready',
      source: 's3',
      type: 'text/plain',
      bytes: 8,
      storageKey: `t/${owner.tenantId}/managed-uploads/${owner.userId}/${fileId}.1__original`,
      retentionAcceptedAt: new Date(now),
      expiredAt: new Date(now + 600000),
      retainedDerivativeBytes: 0,
      securityApproval: {
        version: 1,
        decision: 'approved',
        policySha256: sourcePolicy,
        subject: {
          ...owner,
          operationId: fileId,
          transferGeneration: 1,
          mediaType: 'text/plain',
          bytes: 8,
          sha256: 'a'.repeat(64),
        },
        scannerVersion: 'explicit-synthetic/v1',
        checkedAt: new Date(now).toISOString(),
        coverage: { complete: true, pages: 1, parts: 1 },
      },
    });
    const messageId = randomUUID();
    const messageMethods = createMethods(mongoose);
    const retention = await messageMethods.resolveFileRetentionContext(owner, {
      fileIds: [fileId],
      historyMessageIds: [],
    });
    await tenantStorage.run({ tenantId: owner.tenantId }, () =>
      messageMethods.saveMessage(
        owner,
        { messageId, conversationId: scope.threadId, isCreatedByUser: true, text: sourceText },
        { sourceRetention: retention },
      ),
    );
    const messageRow = await models.Message.collection.findOne({ messageId });
    const sourceInput = {
      fileIds: [fileId],
      messages: [
        { conversationId: scope.threadId, messageId, expectedVersion: messageRow!.__v ?? null },
      ],
    };
    const originalFile = await models.File.collection.findOne({ file_id: fileId });
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
    const caseDirectory = join(scratch, scenario.replaceAll(' ', '-'));
    await mkdir(caseDirectory);
    const effects = join(caseDirectory, 'synthetic-effects.jsonl');
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
      sourceInput,
      sourcePolicy,
      expectedSourceTextSha256: createHash('sha256').update(sourceText).digest('hex'),
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
      redisUri: process.env.CONTINUATION_REDIS_URI ?? process.env.REDIS_URI,
      redisPrefix: `checkpoint-process:${randomUUID()}:`,
    };
    const first = await start(
      { ...common, phase: 'first', captureCommitUnknown: scenario === 'unknown capture commit' },
      scenario === 'unknown capture commit' ? 'capture-denied' : 'quiescent',
    );
    const paused = await bounded(first.report, 'Persisted first step');
    if (scenario === 'unknown capture commit') {
      expect(await stop(first)).toEqual({ code: 0, signal: null });
      expect(await models.GenerationAdmission.countDocuments({ principalId: owner.userId })).toBe(
        0,
      );
      expect(existsSync(effects)).toBe(false);
      return;
    }
    expect(paused.next).toEqual(['agent_b']);
    expect(paused.runId).toBe(common.runId);
    expect(paused.admission).toMatchObject({
      principalId: scope.userId,
      tenantId: scope.tenantId,
      ownerInstanceId: common.podUid,
      processBootId: paused.nativeIdentity.incarnation,
      protocol: '2',
      generationEpoch: paused.nativeJob!.createdAt,
      segmentId: paused.nativeJob!.providerExecutionId,
      continuation: { runId: common.runId, mode: 'checkpoint-only-v1' },
    });
    expect(paused.nativeJob).toMatchObject({
      generationProtocolVersion: 2,
      checkpointNamespace: scope.checkpointNamespace,
    });
    expect(paused.nativeJob!.createdAt).toBeGreaterThan(1);
    expect(paused.sourceBinding!.bindingSha256).toBe(
      paused.admission.continuation!.sourceBindingSha256,
    );
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
    const sourceBinding = snapshotCheckpointSourceBinding(
      owner,
      JSON.parse(JSON.stringify(paused.sourceBinding)),
    );
    const saver = await getDurableAgentCheckpointer(scope, storage, predecessor, sourceBinding);
    const before = await saver.getTuple(config);
    expect(before?.checkpoint.id).toBe(paused.checkpointId);
    expect(before?.checkpoint.channel_values.runStepState).toMatchObject({ runId: common.runId });
    expect(JSON.stringify(before?.checkpoint.channel_values.messages)).toContain('answer-first');
    expect(JSON.stringify(before?.checkpoint.channel_values.messages)).toContain(sourceText);
    for (const name of [storage.checkpointCollectionName, storage.checkpointWritesCollectionName]) {
      const rows = await mongoose.connection
        .db!.collection(name)
        .find({ lc_source_file_ids: fileId })
        .toArray();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.lc_source_binding.bindingSha256).toBe(sourceBinding.bindingSha256);
        expect(row.upserted_at).toBeUndefined();
        expect(row.lc_source_expires_at.getTime()).toBeLessThanOrEqual(
          Date.parse(sourceBinding.expiresAt),
        );
        expect(row.lc_retained_allocations[0].bytes).toBeGreaterThan(0);
      }
    }
    expect(
      (await models.File.collection.findOne({ file_id: fileId }))!.retainedDerivativeBytes,
    ).toBeGreaterThan(originalFile!.retainedDerivativeBytes);
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
    // The parent source read is itself a confirmed native admission fence.
    // Capture the exact stopped boundary after that read, not its earlier revision.
    const stopped = await methods.getGenerationAdmission(predecessor);
    if (!stopped.ok || !stopped.value) throw new Error('Stopped admission unavailable');
    expect(snapshotGenerationCheckpointAdmission(stopped.value)).toEqual(predecessor);
    const stoppedWriteRevision = stopped.value.checkpointWriteRevision;
    expect(stoppedWriteRevision).toBeGreaterThan(active.value.checkpointWriteRevision);
    const terminationFile = join(caseDirectory, 'joined-predecessor.json');
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
    if (scenario === 'changed message')
      await models.Message.collection.updateOne(
        { messageId },
        { $set: { text: 'Changed after capture' }, $inc: { __v: 1 } },
      );
    if (scenario === 'revoked file')
      await models.File.collection.updateOne(
        { file_id: fileId },
        { $set: { 'securityApproval.decision': 'rejected' } },
      );
    if (scenario === 'expired source')
      await models.File.collection.updateOne(
        { file_id: fileId },
        { $set: { expiredAt: new Date(Date.now() - 1000) } },
      );
    if (scenario === 'disabled principal')
      await models.User.collection.updateOne({ _id: user._id }, { $set: { authDisabled: true } });

    const { sourceInput: _sourceInput, ...restart } = common;
    const expiryCases: Record<string, 'before' | 'authorize'> = {
      'source deadline before start': 'before',
      'source deadline during authorize': 'authorize',
    };
    const second = await start(
      {
        ...restart,
        phase: 'second',
        predecessor,
        terminationFile,
        predecessorPid: first.identity.pid,
        expectedSourceDenial: scenario !== 'continue',
        sourceCommitUnknown: scenario === 'unknown recovery commit',
        storeCommitUnknown: scenario === 'unknown jobstore commit',
        expireSourceAt: expiryCases[scenario],
        config,
      },
      scenario === 'continue' ? 'completed' : 'denied',
    );
    const completed = await bounded(second.report, 'Resumed second step');
    expect(await bounded(second.exit, 'Completed process join', 10_000)).toEqual({
      code: 0,
      signal: null,
    });
    expect(await stop(second)).toEqual({ code: 0, signal: null });
    if (scenario !== 'continue') {
      const recoveredOwner = scenario.includes('commit') || scenario.startsWith('source deadline');
      const held = await methods.getGenerationAdmission(predecessor);
      expect(held.ok && held.value).toMatchObject({
        state:
          scenario.includes('commit') || scenario === 'source deadline before start'
            ? 'admitted'
            : 'dispatching',
        active: true,
        ...(recoveredOwner ? {} : { processBootId: predecessor.processBootId }),
        checkpointWriteRevision: stoppedWriteRevision,
      });
      expect(held.ok ? (held.value?.recoveries ?? []) : ['invalid']).toHaveLength(
        recoveredOwner ? 1 : 0,
      );
      expect(
        (await readFile(effects, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line)),
      ).toEqual(firstEffects);
      expect(
        (await models.File.collection.findOne({ file_id: fileId }))!.retainedDerivativeBytes,
      ).toBeGreaterThan(originalFile!.retainedDerivativeBytes);
      return;
    }
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
    expect(recovered.value.state).toBe('settled');
    expect(recovered.value.terminal?.outcome).toBe('completed');
    expect(recovered.value.processBootId).toBe(completed.nativeIdentity.incarnation);
    expect(recovered.value.recoveries).toHaveLength(1);
    expect(recovered.value.recoveries![0]).toMatchObject({
      ownerInstanceId: paused.admission.ownerInstanceId,
      processBootId: paused.admission.processBootId,
      segmentId: paused.admission.segmentId,
      evidence: {
        checkpointWriteRevision: stoppedWriteRevision,
        terminationEvidenceSha256: createHash('sha256')
          .update(await readFile(terminationFile))
          .digest('hex'),
        effectsEvidenceSha256: createHash('sha256')
          .update(`${JSON.stringify(firstEffects[0])}\n`)
          .digest('hex'),
      },
    });
    expect(recovered.value.checkpointWriteRevision).toBeGreaterThan(stoppedWriteRevision);
    expect(completed.next).toEqual([]);
    expect(completed.fetchCalls).toBe(0);
    expect(completed.messages?.map((message) => message.content)).toEqual([
      sourceText,
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
          step.agentId === 'agent_b' &&
          step.status === 'completed' &&
          step.index > firstStep!.index,
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
    await expect(saver.getTuple(config)).rejects.toThrow();
    // Settlement closes even the recovered writer. Inspect durable history directly as
    // the test DB owner instead of manufacturing a new active provider admission.
    await expect(
      getDurableAgentCheckpointer(
        scope,
        storage,
        snapshotGenerationCheckpointAdmission(recovered.value),
        sourceBinding,
      ),
    ).rejects.toThrow('confirmed active dispatch');
    const collection = mongoose.connection.db!.collection(storage.checkpointCollectionName);
    const savedRoot = await collection.findOne({
      lc_source_file_ids: fileId,
      checkpoint_id: paused.checkpointId,
    });
    expect(savedRoot).not.toBeNull();
    const history = await collection
      .find({
        thread_id: savedRoot!.thread_id,
        checkpoint_ns: savedRoot!.checkpoint_ns,
      })
      .toArray();
    const ids = new Set(history.map((row) => row.checkpoint_id));
    expect(ids.size).toBe(history.length);
    expect(ids.has(paused.checkpointId)).toBe(true);
    expect(ids.has(completed.checkpointId)).toBe(true);
    expect(completed.checkpointId).not.toBe(paused.checkpointId);
    for (const row of history) {
      if (row.parent_checkpoint_id) expect(ids.has(row.parent_checkpoint_id)).toBe(true);
    }
  },
  120_000,
);
