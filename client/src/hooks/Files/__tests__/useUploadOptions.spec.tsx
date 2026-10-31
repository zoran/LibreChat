/** useUploadOptions tests preserve endpoint policy and independent upload availability gates. */
jest.mock('~/features/uploads/useManagedUploads', () => ({
  useManagedUploads: () => ({ enabled: true, newUploadError: mockUploadError }),
}));
let mockUploadError: string | null = null;
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import useUploadOptions from '../useUploadOptions';

const mockDragDropContext = {
  conversationId: 'convo-1',
  get agentId() {
    return mockAgentId;
  },
  endpoint: 'agents',
  endpointType: 'custom',
  useResponsesApi: undefined,
};
let mockProvider: string | undefined = 'Custom Provider';
/* Saved agent ids carry the `agent_` prefix; anything else reads as ephemeral. */
let mockAgentId: string | undefined = 'agent_saved01';

jest.mock('~/Providers', () => ({
  useDragDropContext: () => mockDragDropContext,
}));
jest.mock('~/hooks/Agents/useGetAgentsConfig', () => ({
  __esModule: true,
  default: () => ({ agentsConfig: {} }),
}));
jest.mock('~/hooks/Agents/useAgentCapabilities', () => ({
  __esModule: true,
  default: () => ({ fileSearchEnabled: false, codeEnabled: false, contextEnabled: false }),
}));
jest.mock('~/hooks/Agents/useAgentToolPermissions', () => ({
  __esModule: true,
  default: () => ({ provider: mockProvider, tools: [] }),
}));
jest.mock('~/data-provider', () => ({
  useGetFileConfig: () => ({
    data: jest
      .requireActual('librechat-data-provider')
      .mergeFileConfig({ endpoints: { 'Custom Provider': { legacyFileUploadUX: true } } }),
    isError: false,
    isPaused: false,
    isSuccess: true,
  }),
}));

const render = () => renderHook(() => useUploadOptions(), { wrapper: RecoilRoot });

describe('useUploadOptions endpoint resolution', () => {
  it('applies the agent provider policy rather than the agents entry', () => {
    /* An agent conversation carries endpoint `agents`, but a named custom provider
     * configures its own entry. Reading the conversation endpoint missed it, so a
     * provider that opted into the chooser was treated as unified. */
    mockProvider = 'Custom Provider';

    const { result } = render();

    expect(result.current.isUnifiedMode).toBe(false);
  });

  it('falls back to the conversation endpoint when no provider is resolved', () => {
    mockProvider = undefined;
    mockAgentId = undefined;

    const { result } = render();

    expect(result.current.isUnifiedMode).toBe(true);
  });

  it('withholds resolution until the saved agent provider lands', () => {
    /* Falling back to the agents entry meanwhile reports a settled answer drawn from the
     * wrong record, so an upload routes on a policy the server will not apply. */
    mockProvider = undefined;
    mockAgentId = 'agent_saved01';

    const { result } = render();

    expect(result.current.isConfigResolved).toBe(false);
  });

  it('does not wait on a provider an ephemeral agent will never have', () => {
    mockProvider = undefined;
    mockAgentId = 'ephemeral-convo-1';

    const { result } = render();

    expect(result.current.isConfigResolved).toBe(true);
  });
});

describe('independent upload availability', () => {
  it('disables new paste/drop options for storage failure without altering endpoint policy', () => {
    mockUploadError = 'com_upload_storage_unavailable';
    const { result, rerender } = render();
    expect(result.current.uploadsDisabled).toBe(true);
    expect(result.current.uploadAdmissionError).toBe('com_upload_storage_unavailable');
    mockUploadError = 'com_upload_admission_paused';
    rerender();
    expect(result.current.uploadsDisabled).toBe(true);
    expect(result.current.uploadAdmissionError).toBe('com_upload_admission_paused');
  });
});
