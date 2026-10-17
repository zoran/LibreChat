import * as agentsSdk from '@librechat/agents';
import type { GenerationAdmissionInput } from '@librechat/data-schemas';
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
  jest.clearAllMocks();
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
  expect(getDurableAgentCheckpointer).toHaveBeenCalledWith(binding, undefined, admission());
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
