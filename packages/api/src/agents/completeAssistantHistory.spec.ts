/** Singleton admission and semantic identity at their actual run/compatibility owners. */
import { assertCompleteAssistantHistorySingleton, shouldReplayReasoningContent } from './run';
import { createInitializedAgentContextFingerprint } from './compatibility';

type RunAgent = NonNullable<Parameters<typeof assertCompleteAssistantHistorySingleton>[0][number]>;
type LazyAgent = NonNullable<RunAgent['lazySubagentConfigs']>[number];

const root = (flag?: boolean) =>
  ({
    id: 'root',
    name: 'Root',
    description: null,
    avatar: null,
    created_at: 0,
    provider: 'openAI',
    model: 'synthetic-k3',
    model_parameters: {
      model: 'synthetic-k3',
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
    ...(flag === undefined ? {} : { preserveAssistantHistory: flag }),
  }) satisfies RunAgent;

const lazy = (flag?: boolean, id = 'lazy'): LazyAgent => ({
  ...root(flag),
  id,
  configId: id,
  resolve: jest.fn(async () => ({ ...root(flag), id })),
});

describe('complete assistant history admission', () => {
  it('admits a singleton and preserves the legacy absent/false path', () => {
    expect(assertCompleteAssistantHistorySingleton([root(true)])).toBe(true);
    expect(shouldReplayReasoningContent(root(true))).toBe(true);
    expect(assertCompleteAssistantHistorySingleton([root(), { ...root(), id: 'other' }])).toBe(
      false,
    );
    expect(
      assertCompleteAssistantHistorySingleton([{ ...root(false), subagents: { enabled: true } }]),
    ).toBe(false);
  });
  it.each([
    ['two fully opted-in roots', () => [root(true), { ...root(true), id: 'other' }]],
    [
      'eager child',
      () => [{ ...root(true), subagentAgentConfigs: [{ ...root(true), id: 'child' }] }],
    ],
    ['lazy missing capability', () => [{ ...root(true), lazySubagentConfigs: [lazy()] }]],
    ['opted-in lazy', () => [{ ...root(), lazySubagentConfigs: [lazy(true)] }]],
    [
      'graph metadata',
      () => [{ ...root(true), subagentGraphMemberMetadata: [{ ...root(), id: 'member' }] }],
    ],
    [
      'saved graph',
      () => [
        {
          ...root(true),
          subagentGraphConfigs: [
            {
              definition: {
                type: 'team',
                name: 'Synthetic team',
                description: 'Complete-history graph admission fixture',
                agent_ids: ['member'],
                edges: [],
                entry_agent_id: 'member',
                result_agent_id: 'member',
              },
              memberConfigs: [{ ...root(true), id: 'member' }],
            },
          ],
        },
      ],
    ],
    ['handoff edges', () => [{ ...root(true), edges: [{ from: 'root', to: 'other' }] }]],
    [
      'declared children',
      () => [{ ...root(true), subagents: { enabled: false, agent_ids: ['later'] } }],
    ],
    ['self spawning', () => [{ ...root(true), subagents: { enabled: true, allowSelf: true } }]],
  ] as const)('rejects %s before provider execution', (_name, build) => {
    expect(() => assertCompleteAssistantHistorySingleton(build())).toThrow('without agent graphs');
  });
  it('rejects graph-origin conversion even when the resolved child is itself a singleton', () => {
    expect(() => assertCompleteAssistantHistorySingleton([root(true)], true)).toThrow();
  });
  it('does not discard an opted-in second descriptor with the same ID', () => {
    const a = { ...root(), lazySubagentConfigs: [lazy(true, 'root')] };
    expect(() => assertCompleteAssistantHistorySingleton([a])).toThrow();
  });
  it('preserves legacy fingerprint bytes but invalidates warm state on true capability', () => {
    const fingerprint = (flag?: boolean) =>
      createInitializedAgentContextFingerprint({ agents: [root(flag)] });
    expect(JSON.stringify(fingerprint())).toBe(JSON.stringify(fingerprint(false)));
    expect(fingerprint(true).digest).not.toBe(fingerprint().digest);
  });
});
