import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { useEditArtifact, useRefreshArtifact } from '../mutations';

const mockEdit = jest.fn();
const mockGet = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    editArtifact: (...args: unknown[]) => mockEdit(...args),
    getMessagesByConvoId: (...args: unknown[]) => mockGet(...args),
  },
}));
const artifact = {
  id: 'artifact',
  messageId: 'message',
  index: 0,
  content: 'ORIGINAL',
  lastUpdateTime: 0,
};
const message = (body = 'ORIGINAL', version = 1, title = 'Example') =>
  ({
    messageId: 'message',
    conversationId: 'conversation',
    text: `:::artifact{identifier="example" type="text/plain" title="${title}"}\n${body}\n:::`,
    __v: version,
    metadata: { sourceCoverage: { version: 1 }, keep: 'preserved' },
  }) as unknown as TMessage;
function setup(seed = true) {
  const client = new QueryClient({
    defaultOptions: {
      mutations: { retry: 3, retryDelay: 1 },
      queries: { retry: false, cacheTime: Infinity },
    },
    logger: { log: () => {}, warn: () => {}, error: () => {} },
  });
  if (seed) client.setQueryData([QueryKeys.messages, 'conversation'], [message()]);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}
beforeEach(() => {
  mockEdit.mockReset();
  mockGet.mockReset();
});
it('commits the server version, invalidates only source coverage and preserves the remaining metadata', async () => {
  const { client, wrapper } = setup();
  mockEdit.mockResolvedValue({ ...message('SAVED', 8), content: [] });
  const { result } = renderHook(() => useEditArtifact(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({
      messageId: 'message',
      index: 0,
      original: 'ORIGINAL',
      updated: 'SAVED',
      expectedVersion: 1,
    });
  });
  const stored = client.getQueryData<TMessage[]>([QueryKeys.messages, 'conversation'])![0];
  expect(stored).toMatchObject({
    __v: 8,
    text: message('SAVED').text,
    metadata: { keep: 'preserved' },
  });
  expect(stored.metadata).not.toHaveProperty('sourceCoverage');
  expect(mockEdit).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 1 }));
});
it('does not let global mutation retry defaults repeat a version conflict or replace cached content', async () => {
  const { client, wrapper } = setup();
  const before = client.getQueryData([QueryKeys.messages, 'conversation']);
  mockEdit.mockRejectedValue({
    isAxiosError: true,
    response: { status: 409, data: { code: 'MESSAGE_VERSION_CONFLICT' } },
  });
  const { result } = renderHook(() => useEditArtifact(), { wrapper });
  act(() =>
    result.current.mutate({
      messageId: 'message',
      index: 0,
      original: 'ORIGINAL',
      updated: 'LOCAL',
    }),
  );
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(mockEdit).toHaveBeenCalledTimes(1);
  expect(client.getQueryData([QueryKeys.messages, 'conversation'])).toBe(before);
});
it('refreshes the existing authenticated message query and binds parsed content to its actual version', async () => {
  const { wrapper } = setup();
  mockGet.mockResolvedValue([message('REMOTE', 7)]);
  const { result } = renderHook(() => useRefreshArtifact(artifact, 'conversation'), { wrapper });
  let revision;
  await act(async () => {
    revision = await result.current.load();
  });
  expect(mockGet).toHaveBeenCalledWith('conversation', { toolPreviews: true });
  expect(revision).toMatchObject({
    messageId: 'message',
    index: 0,
    content: 'REMOTE\n',
    version: 7,
  });
  expect(mockEdit).not.toHaveBeenCalled();
});
it('refuses a shifted artifact identity and an unknown initial source', async () => {
  const { wrapper } = setup();
  mockGet.mockResolvedValue([message('OTHER', 7, 'Different artifact')]);
  const { result } = renderHook(() => useRefreshArtifact(artifact, 'conversation'), { wrapper });
  await expect(result.current.load()).rejects.toThrow('Artifact revision unavailable');
  const absent = setup(false);
  const missing = renderHook(() => useRefreshArtifact(artifact, 'conversation'), {
    wrapper: absent.wrapper,
  });
  await expect(missing.result.current.load()).rejects.toThrow('Artifact revision unavailable');
  expect(mockGet).toHaveBeenCalledTimes(1);
});
it('retains the original identity when a conflicted editor remounts after the cache changed', async () => {
  const { client, wrapper } = setup();
  const first = renderHook(() => useRefreshArtifact(artifact, 'conversation'), { wrapper });
  const originalIdentity = first.result.current.source;
  first.unmount();
  client.setQueryData([QueryKeys.messages, 'conversation'], [message('OTHER', 6, 'Other')]);
  mockGet.mockResolvedValue([message('OTHER', 7, 'Other')]);
  const next = renderHook(() => useRefreshArtifact(artifact, 'conversation', originalIdentity), {
    wrapper,
  });
  await expect(next.result.current.load()).rejects.toThrow('Artifact revision unavailable');
});

it('does not roll a newer cached revision back when an earlier successful save arrives late', async () => {
  const { client, wrapper } = setup();
  const newest = [message('NEWER', 9)];
  mockEdit.mockImplementation(async () => {
    client.setQueryData([QueryKeys.messages, 'conversation'], newest);
    return { ...message('OLDER', 8), content: [] };
  });
  const { result } = renderHook(() => useEditArtifact(), { wrapper });
  await act(async () => {
    await result.current.mutateAsync({
      messageId: 'message',
      index: 0,
      original: 'ORIGINAL',
      updated: 'OLDER',
    });
  });
  expect(client.getQueryData([QueryKeys.messages, 'conversation'])).toEqual(newest);
});

it('compares the authenticated refresh without rolling back an overlapping native cache update', async () => {
  const { client, wrapper } = setup();
  const newer = [message('NEWER', 9)];
  mockGet.mockImplementation(async () => {
    client.setQueryData([QueryKeys.messages, 'conversation'], newer);
    return [message('FRESHLY-READ', 7)];
  });
  const { result } = renderHook(() => useRefreshArtifact(artifact, 'conversation'), { wrapper });
  let revision;
  await act(async () => {
    revision = await result.current.load();
  });
  expect(revision).toMatchObject({ content: 'FRESHLY-READ\n', version: 7 });
  expect(client.getQueryData([QueryKeys.messages, 'conversation'])).toEqual(newer);
});
