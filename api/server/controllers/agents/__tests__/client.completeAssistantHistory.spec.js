/** Constructor snapshot and actual warm-context consumer must agree on capability. */
const { GenerationJobManager } = require('@librechat/api');
const AgentClient = require('../client');

function create(value) {
  const agent = {
    id: 'synthetic-root',
    provider: 'openAI',
    endpoint: 'openAI',
    instructions: 'synthetic',
    model_parameters: { model: 'synthetic-k3' },
    tools: [],
    ...(value === undefined ? {} : { preserveAssistantHistory: value }),
  };
  const client = new AgentClient({
    agent,
    endpoint: 'agents',
    req: {
      user: { id: 'synthetic-user' },
      body: { endpoint: 'agents' },
      config: { endpoints: { agents: {} } },
      _isAgentTrigger: true,
      _agentEventBindingParentConversationId: 'synthetic-parent',
    },
    res: {},
    endpointTokenConfig: {},
    eventHandlers: {},
    contentParts: [],
    collectedUsage: [],
    artifactPromises: [],
  });
  client.getEventActorMemorySnapshots = jest.fn().mockResolvedValue([]);
  return { client, agent };
}

describe('complete history initialization snapshot', () => {
  afterAll(async () => {
    await GenerationJobManager.destroy();
  });
  it('keeps absent and false snapshots/fingerprints byte-identical', async () => {
    const a = create();
    const b = create(false);
    expect(JSON.stringify(a.client.eventActorAgentContextSources)).toBe(
      JSON.stringify(b.client.eventActorAgentContextSources),
    );
    expect((await a.client.getEventActorContext()).fingerprint).toEqual(
      (await b.client.getEventActorContext()).fingerprint,
    );
  });
  it('retains true at construction and invalidates the old warm fingerprint', async () => {
    const old = create();
    const current = create(true);
    expect(current.client.eventActorAgentContextSources[0].preserveAssistantHistory).toBe(true);
    const before = await current.client.getEventActorContext();
    current.agent.preserveAssistantHistory = false;
    current.agent.instructions = 'later request decoration';
    expect((await current.client.getEventActorContext()).fingerprint).toEqual(before.fingerprint);
    expect(before.fingerprint).not.toEqual((await old.client.getEventActorContext()).fingerprint);
    const prepared = await current.client.prepareEventActorContext({
      contextFingerprint: (await old.client.getEventActorContext()).fingerprint,
      skillManifest: [],
      discoveredToolNames: [],
    });
    expect(prepared.fingerprint).toEqual(before.fingerprint);
  });
  it('rejects an opted-in constructor with declared agent handoff edges', () => {
    const a = create(true);
    expect(
      () =>
        new AgentClient({
          ...a.client.options,
          agent: { ...a.agent, edges: [{ from: 'synthetic-root', to: 'child' }] },
        }),
    ).toThrow('without agent graphs');
  });
});
