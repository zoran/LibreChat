import * as agentsSdk from '@librechat/agents';
import type { GenerationAdmissionInput, CheckpointSourceBinding } from '@librechat/data-schemas';
import type { DurableAgentCheckpointScope } from '~/agents/checkpointer';
import { getAgentCheckpointer, getDurableAgentCheckpointer } from '~/agents/checkpointer';
import { createCheckpointNamespace } from '~/stream/checkpoints';
import { createRun } from '~/agents/run';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// Only the two external construction boundaries are doubled. The native host,
// owner namespace reader and agent configuration path remain real. SDK stream
// semantics and durable storage have their own real contract/process suites.
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  __esModule: true,
  CHECKPOINT_CONTINUATION_VERSION: 1,
  Run: { create: jest.fn() },
}));
jest.mock('~/agents/checkpointer', () => ({
  getAgentCheckpointer: jest.fn(),
  getDurableAgentCheckpointer: jest.fn(),
}));

type Options = Parameters<typeof createRun>[0];
const checkpointNamespace = createCheckpointNamespace('owner', 'tenant');

function scope(): DurableAgentCheckpointScope {
  return {
    userId: 'owner',
    tenantId: 'tenant',
    threadId: 'conversation',
    checkpointNamespace,
  };
}

function admission(): GenerationAdmissionInput {
  return {
    tenantId: 'tenant',
    principalId: 'owner',
    clientRequestId: 'request',
    conversationId: 'conversation',
    requestFingerprint: 'a'.repeat(64),
    protocol: '2',
    ownerInstanceId: 'pod',
    processBootId: 'boot',
    generationEpoch: 7,
    segmentId: 'segment',
    continuation: {
      version: 1,
      mode: 'checkpoint-only-v1',
      runId: 'response-message',
      threadId: 'conversation',
      checkpointNamespace: scope().checkpointNamespace,
      graphFingerprint: 'b'.repeat(64),
      policyFingerprint: 'c'.repeat(64),
    },
  };
}

function sourceBinding(): CheckpointSourceBinding {
  // Fixed canonical digest fixture; this host unit suite makes no source authorization claim.
  return {
    version: 2,
    owner: { userId: '111111111111111111111111', tenantId: 'tenant' },
    files: [
      { fileId: 'file-one', bindingSha256: 'd'.repeat(64), expiresAt: '2035-01-01T00:00:00.000Z' },
    ],
    messages: [
      {
        conversationId: 'conversation',
        messageId: 'message-one',
        capturedVersion: 0,
        bodySha256: 'e'.repeat(64),
        sourceFileIds: ['file-one'],
        expiresAt: '2035-01-01T00:00:00.000Z',
      },
    ],
    expiresAt: '2035-01-01T00:00:00.000Z',
    bindingSha256: '6f7dde21289a90c45f9099f9796a170a41ba575d56449dfde92b6410d4db0b62',
  };
}

function sourceOptions(): Options {
  const binding = sourceBinding();
  const admitted = admission();
  const sourceScope = {
    ...scope(),
    userId: binding.owner.userId,
    checkpointNamespace: createCheckpointNamespace(binding.owner.userId, 'tenant'),
  };
  return options({
    user: { id: binding.owner.userId, tenantId: 'tenant' } as Options['user'],
    durableCheckpointScope: sourceScope,
    durableCheckpointAdmission: {
      ...admitted,
      principalId: binding.owner.userId,
      continuation: {
        ...admitted.continuation!,
        checkpointNamespace: sourceScope.checkpointNamespace,
        sourceBindingSha256: binding.bindingSha256,
      },
    },
    durableCheckpointSourceBinding: binding,
  });
}

function options(extra: Partial<Options> = {}): Options {
  return {
    signal: new AbortController().signal,
    runId: 'response-message',
    conversationId: 'conversation',
    user: { id: 'owner', tenantId: 'tenant' } as Options['user'],
    agents: [
      {
        id: 'agent',
        name: 'Synthetic native agent',
        description: null,
        created_at: 0,
        avatar: null,
        provider: 'openAI',
        endpoint: 'openAI',
        model: 'synthetic-model',
        tools: [],
        model_parameters: {
          model: 'synthetic-model',
          temperature: null,
          maxContextTokens: null,
          max_context_tokens: null,
          max_output_tokens: null,
          top_p: null,
          frequency_penalty: null,
          presence_penalty: null,
        },
        maxContextTokens: 100_000,
        toolContextMap: {},
      },
    ],
    ...(extra.durableCheckpointScope === undefined
      ? {}
      : { durableCheckpointAdmission: admission() }),
    ...extra,
  };
}

const nativeRun = { processStream: jest.fn() };
const durableSaver = { kind: 'durable-fixture' };
const lazySaver = { kind: 'lazy-fixture' };
const sdk = jest.requireMock('@librechat/agents') as { CHECKPOINT_CONTINUATION_VERSION?: number };

beforeEach(() => {
  jest.resetAllMocks();
  sdk.CHECKPOINT_CONTINUATION_VERSION = 1;
  jest.mocked(agentsSdk.Run.create).mockResolvedValue(nativeRun as never);
  jest.mocked(getDurableAgentCheckpointer).mockResolvedValue(durableSaver as never);
  jest.mocked(getAgentCheckpointer).mockResolvedValue(lazySaver as never);
});

it('leaves ordinary runs and the existing lazy event-actor path unchanged', async () => {
  await createRun(options());
  expect(agentsSdk.Run.create).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ checkpointPolicy: expect.anything() }),
  );
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();

  await createRun(options({ eventActorCheckpointing: true }));
  expect(getAgentCheckpointer).toHaveBeenCalledTimes(1);
  expect(agentsSdk.Run.create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      graphConfig: expect.objectContaining({
        compileOptions: expect.objectContaining({ checkpointer: lazySaver }),
      }),
    }),
  );
});

it('binds the native durable saver and SDK sync policy without replacing Run', async () => {
  const binding = scope();
  await expect(
    createRun(options({ durableCheckpointScope: binding, eventActorCheckpointing: true })),
  ).resolves.toBe(nativeRun);
  expect(getDurableAgentCheckpointer).toHaveBeenCalledWith(
    binding,
    undefined,
    admission(),
    undefined,
  );
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: 'response-message',
      checkpointPolicy: { threadId: 'conversation', durability: 'sync' },
      graphConfig: expect.objectContaining({
        compileOptions: expect.objectContaining({ checkpointer: durableSaver }),
      }),
    }),
  );
});

it('captures and forwards the exact private source binding before the durable factory yields', async () => {
  const input = sourceOptions();
  const expected = sourceBinding();
  jest
    .mocked(getDurableAgentCheckpointer)
    .mockImplementationOnce(async (_scope, _cfg, savedAdmission, savedSource) => {
      expect(savedSource).toEqual(expected);
      expect(savedSource).not.toBe(input.durableCheckpointSourceBinding);
      expect(Object.isFrozen(savedSource)).toBe(true);
      expect(Object.isFrozen(savedSource!.messages[0].sourceFileIds)).toBe(true);
      expect(savedAdmission!.continuation!.sourceBindingSha256).toBe(savedSource!.bindingSha256);
      Object.assign(input.durableCheckpointSourceBinding!.files[0], {
        bindingSha256: 'f'.repeat(64),
      });
      input.durableCheckpointSourceBinding = undefined;
      input.durableCheckpointAdmission!.continuation = {
        ...admission().continuation!,
        sourceBindingSha256: 'f'.repeat(64),
      };
      await Promise.resolve();
      expect(savedSource).toEqual(expected);
      return durableSaver as never;
    });
  await expect(createRun(input)).resolves.toBe(nativeRun);
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
});

it.each(['option', 'inherited option', 'binding field'] as const)(
  'rejects a private source %s accessor without evaluating it',
  async (kind) => {
    const input = sourceOptions();
    const getter = jest.fn(() => sourceBinding());
    if (kind === 'option')
      Object.defineProperty(input, 'durableCheckpointSourceBinding', { get: getter });
    if (kind === 'inherited option') {
      delete input.durableCheckpointSourceBinding;
      Object.setPrototypeOf(
        input,
        Object.defineProperty({}, 'durableCheckpointSourceBinding', { get: getter }),
      );
    }
    if (kind === 'binding field')
      Object.defineProperty(input.durableCheckpointSourceBinding!, 'files', { get: getter });
    await expect(createRun(input)).rejects.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
    expect(getAgentCheckpointer).not.toHaveBeenCalled();
    expect(agentsSdk.Run.create).not.toHaveBeenCalled();
  },
);

it.each([
  'missing binding',
  'missing digest',
  'different digest',
  'foreign owner',
  'foreign tenant',
  'missing scope',
  'missing admission',
])('rejects %s before source storage or SDK construction', async (kind) => {
  const input = sourceOptions();
  if (kind === 'missing binding') input.durableCheckpointSourceBinding = undefined;
  if (kind === 'missing digest') input.durableCheckpointAdmission = admission();
  if (kind === 'different digest')
    input.durableCheckpointAdmission!.continuation = {
      ...admission().continuation!,
      sourceBindingSha256: 'f'.repeat(64),
    };
  if (kind === 'foreign owner')
    Object.assign(input.durableCheckpointSourceBinding!.owner, { userId: 'foreign' });
  if (kind === 'foreign tenant')
    Object.assign(input.durableCheckpointSourceBinding!.owner, { tenantId: 'foreign' });
  if (kind === 'missing scope') input.durableCheckpointScope = undefined;
  if (kind === 'missing admission') input.durableCheckpointAdmission = undefined;
  await expect(createRun(input)).rejects.toThrow();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it.each(['unavailable source', 'unknown source read commit'])(
  'preserves %s failure without constructing a fallback run',
  async (reason) => {
    const failure = new Error(reason);
    jest.mocked(getDurableAgentCheckpointer).mockRejectedValueOnce(failure);
    await expect(createRun(sourceOptions())).rejects.toBe(failure);
    expect(getAgentCheckpointer).not.toHaveBeenCalled();
    expect(agentsSdk.Run.create).not.toHaveBeenCalled();
  },
);

it.each([
  ['foreign owner', { userId: 'other' }, {}],
  ['foreign tenant', { tenantId: 'other' }, {}],
  ['foreign thread', { threadId: 'other' }, {}],
  ['foreign namespace', { checkpointNamespace: createCheckpointNamespace('other', 'tenant') }, {}],
  ['missing owner', {}, { user: undefined }],
  ['missing explicit conversation', {}, { conversationId: undefined }],
  ['explicit tenant mismatch', {}, { tenantId: 'other' }],
] as const)('rejects %s before storage or SDK construction', async (_name, changes, extra) => {
  await expect(
    createRun(options({ durableCheckpointScope: { ...scope(), ...changes }, ...extra })),
  ).rejects.toThrow();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it.each([
  ['loaded tools', { tools: [{ name: 'remote-write' }] }],
  ['deferred registry', { toolRegistry: new Map([['remote-write', {}]]) }],
  ['serialized tools', { toolDefinitions: [{ name: 'remote-write' }] }],
  ['deferred discovery', { hasDeferredTools: true }],
  ['subagent spawn', { subagents: { enabled: true } }],
  ['lazy delegate', { lazySubagentConfigs: [{ id: 'child' }] }],
  ['background tools', { backgroundToolNames: ['remote-write'] }],
  ['handoff edge', { edges: [{ from: 'agent', to: 'other', edgeType: 'handoff' }] }],
] as const)('rejects checkpoint-only %s before persistence', async (_name, changes) => {
  const input = options({ durableCheckpointScope: scope() });
  input.agents = [{ ...input.agents[0], ...changes } as Options['agents'][number]];
  await expect(createRun(input)).rejects.toThrow('Checkpoint-only');
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it.each([
  ['run files', { runFiles: { activate: jest.fn() } }],
  ['detached task owner', { subagentTasks: {} }],
  ['client tools', { clientToolNames: new Set(['client-write']) }],
  ['forced discovered tools', { discoveredToolNames: ['deferred-write'] }],
] as const)('rejects checkpoint-only %s before persistence', async (_name, changes) => {
  await expect(
    createRun(options({ durableCheckpointScope: scope(), ...(changes as Partial<Options>) })),
  ).rejects.toThrow('Checkpoint-only');
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('checks the assembled tools again after async setup without executing them', async () => {
  const input = options({ durableCheckpointScope: scope() });
  const invoke = jest.fn();
  jest.mocked(getDurableAgentCheckpointer).mockImplementationOnce(async () => {
    input.agents[0].tools = [{ name: 'late-write', invoke } as never];
    return durableSaver as never;
  });
  await expect(createRun(input)).rejects.toThrow('resolved an unsupported tool surface');
  expect(invoke).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('preserves the checkpoint-only native direct agent chain', async () => {
  const input = options({ durableCheckpointScope: scope() });
  input.agents[0].edges = [{ from: 'agent', to: 'second', edgeType: 'direct' }];
  input.agents.push({ ...input.agents[0], id: 'second', edges: [] });
  await expect(createRun(input)).resolves.toBe(nativeRun);
  expect(agentsSdk.Run.create).toHaveBeenCalledWith(
    expect.objectContaining({
      graphConfig: expect.objectContaining({ type: 'multi-agent' }),
    }),
  );
});

it('does not activate a profile or derive its thread from request data', async () => {
  const requestBody = {
    conversationId: 'conversation',
    durableCheckpointScope: scope(),
  } as Options['requestBody'];
  await createRun(options({ requestBody }));
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).toHaveBeenLastCalledWith(
    expect.not.objectContaining({ checkpointPolicy: expect.anything() }),
  );
  jest.clearAllMocks();
  await expect(
    createRun(options({ conversationId: undefined, requestBody, durableCheckpointScope: scope() })),
  ).rejects.toThrow();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('refuses an SDK that cannot enforce the checkpoint policy', async () => {
  sdk.CHECKPOINT_CONTINUATION_VERSION = undefined;
  await expect(createRun(options({ durableCheckpointScope: scope() }))).rejects.toThrow();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('propagates durable storage failure without lazy or memory fallback', async () => {
  const failure = new Error('durable storage unavailable');
  jest.mocked(getDurableAgentCheckpointer).mockRejectedValueOnce(failure);
  await expect(createRun(options({ durableCheckpointScope: scope() }))).rejects.toBe(failure);
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('refuses an unexpectedly absent saver instead of enabling SDK memory storage', async () => {
  jest.mocked(getDurableAgentCheckpointer).mockResolvedValueOnce(undefined as never);
  await expect(createRun(options({ durableCheckpointScope: scope() }))).rejects.toThrow(
    'requires a persistent checkpointer',
  );
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});

it('snapshots the owner binding before the durable factory yields', async () => {
  const binding = scope();
  const original = { ...binding };
  const admitted = admission();
  const originalAdmission = admission();
  jest
    .mocked(getDurableAgentCheckpointer)
    .mockImplementationOnce(async (received, _cfg, savedAdmission) => {
      expect(received).not.toBe(binding);
      expect(Object.isFrozen(received)).toBe(true);
      expect(savedAdmission).not.toBe(admitted);
      expect(Object.isFrozen(savedAdmission)).toBe(true);
      expect(Object.isFrozen(savedAdmission?.continuation)).toBe(true);
      binding.threadId = 'changed-after-admission';
      binding.userId = 'other';
      admitted.segmentId = 'other-segment';
      admitted.continuation = { ...admitted.continuation!, runId: 'other-run' };
      await Promise.resolve();
      expect(received).toEqual(original);
      expect(savedAdmission).toEqual(originalAdmission);
      return durableSaver as never;
    });
  await createRun(
    options({ durableCheckpointScope: binding, durableCheckpointAdmission: admitted }),
  );
  expect(agentsSdk.Run.create).toHaveBeenLastCalledWith(
    expect.objectContaining({ checkpointPolicy: { threadId: 'conversation', durability: 'sync' } }),
  );
});

it.each([
  ['missing admission', { durableCheckpointAdmission: undefined }],
  [
    'admission without scope',
    { durableCheckpointScope: undefined, durableCheckpointAdmission: admission() },
  ],
  ['missing explicit run ID', { runId: undefined }],
  ['different run ID', { runId: 'other-run' }],
  ['foreign principal', { durableCheckpointAdmission: { ...admission(), principalId: 'other' } }],
  ['foreign tenant', { durableCheckpointAdmission: { ...admission(), tenantId: 'other' } }],
  [
    'foreign conversation',
    { durableCheckpointAdmission: { ...admission(), conversationId: 'other' } },
  ],
  [
    'missing continuation',
    { durableCheckpointAdmission: { ...admission(), continuation: undefined } },
  ],
  [
    'foreign continuation thread',
    {
      durableCheckpointAdmission: {
        ...admission(),
        continuation: { ...admission().continuation!, threadId: 'other' },
      },
    },
  ],
  [
    'foreign continuation namespace',
    {
      durableCheckpointAdmission: {
        ...admission(),
        continuation: { ...admission().continuation!, checkpointNamespace: 'other' },
      },
    },
  ],
  [
    'malformed graph identity',
    {
      durableCheckpointAdmission: {
        ...admission(),
        continuation: { ...admission().continuation!, graphFingerprint: 'invalid' },
      },
    },
  ],
] as const)('rejects %s before run-file activation and the first await', async (_name, extra) => {
  const activate = jest.fn();
  await expect(
    createRun(
      options({
        durableCheckpointScope: scope(),
        runFiles: { activate } as unknown as Options['runFiles'],
        ...extra,
      }),
    ),
  ).rejects.toThrow();
  expect(activate).not.toHaveBeenCalled();
  expect(getDurableAgentCheckpointer).not.toHaveBeenCalled();
  expect(getAgentCheckpointer).not.toHaveBeenCalled();
  expect(agentsSdk.Run.create).not.toHaveBeenCalled();
});
