import { request } from 'librechat-data-provider';
import type { DocumentWorkspace, UploadOperation } from 'librechat-data-provider';
import { sendUploadBody } from '../uploads/api';
import { createWorkspace, listWorkspaces, loadWorkspace, saveWorkspace } from './api';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  request: { authenticatedFetch: jest.fn() },
}));
jest.mock('../uploads/api', () => ({ sendUploadBody: jest.fn() }));

const bytes = (text: string) => new TextEncoder().encode(text);
const uuid = '471dc724-88d2-4b3a-88dc-1f67490bc4a4';
const item: DocumentWorkspace = {
  workspaceId: 'draft',
  title: 'Entwurf',
  format: 'markdown',
  revision: 0,
  headFileId: null,
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-17T00:00:00Z',
  expiresAt: null,
};
const op = (changes: Partial<UploadOperation> = {}) => ({
  version: 1,
  id: 'operation',
  state: 'waiting',
  cleanupPending: false,
  canUseInComposer: false,
  ...changes,
});
function respond(data: object | Uint8Array, status = 200) {
  const body = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : bytes(JSON.stringify(data));
  const cancel = jest.fn().mockResolvedValue(undefined);
  const read = jest
    .fn()
    .mockResolvedValueOnce({ done: false, value: body })
    .mockResolvedValueOnce({ done: true });
  (request.authenticatedFetch as jest.Mock).mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    body: { cancel, getReader: () => ({ read, cancel }) },
  });
  return { read, cancel };
}
const fetches = () => (request.authenticatedFetch as jest.Mock).mock.calls;

describe('workspace API composition through native managed intake', () => {
  let originalUuid: PropertyDescriptor | undefined;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers();
    originalUuid = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => uuid });
    (sendUploadBody as jest.Mock).mockResolvedValue(op({ state: 'processing' }));
  });
  afterEach(() => {
    jest.useRealTimers();
    if (originalUuid) Object.defineProperty(crypto, 'randomUUID', originalUuid);
    else Reflect.deleteProperty(crypto, 'randomUUID');
  });

  it('lists private metadata, creates an empty draft and opens revision zero without any body transfer', async () => {
    const signal = new AbortController().signal;
    respond({ workspaces: [item], nextCursor: 'next/+' });
    respond(item);
    respond(item);
    await expect(listWorkspaces(signal, 'cursor/+')).resolves.toMatchObject({ workspaces: [item] });
    await expect(createWorkspace('markdown', signal)).resolves.toEqual(item);
    await expect(loadWorkspace('draft', signal)).resolves.toEqual({
      workspace: item,
      bytes: new Uint8Array(),
    });
    expect(fetches()[0][0]).toBe('/api/workspaces?before=cursor%2F%2B');
    expect(JSON.parse(fetches()[1][1].body)).toEqual({ format: 'markdown' });
    expect(fetches()).toHaveLength(3);
    expect(sendUploadBody).not.toHaveBeenCalled();
    for (const [, options] of fetches())
      expect(options).toMatchObject({
        credentials: 'same-origin',
        cache: 'no-store',
        signal: expect.any(AbortSignal),
      });
  });

  it('transfers once, waits for bound ready/cleanup status, commits once and reads the exact immutable revision', async () => {
    const data = bytes('\uFEFFPrivater Entwurf\r\n');
    const committed = { ...item, revision: 1, headFileId: 'approved-file' };
    respond(op());
    respond(op({ state: 'ready', fileId: 'approved-file', cleanupPending: true }));
    respond(op({ state: 'ready', fileId: 'approved-file', cleanupPending: false }));
    respond(committed);
    respond(data);
    const promise = saveWorkspace(
      'draft',
      { baseRevision: 0, bytes: data },
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result.workspace).toEqual(committed);
    expect(Array.from(result.bytes)).toEqual(Array.from(data));
    expect(sendUploadBody).toHaveBeenCalledTimes(1);
    const [id, file, signal] = (sendUploadBody as jest.Mock).mock.calls[0];
    expect(id).toBe('operation');
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({
      name: 'cortex-entwurf.txt',
      type: 'text/plain',
      size: data.length,
    });
    expect(signal.aborted).toBe(false);
    expect(fetches().map(([url]) => url)).toEqual([
      '/api/workspaces/draft/saves',
      '/api/workspaces/draft/saves/operation?baseRevision=0',
      '/api/workspaces/draft/saves/operation?baseRevision=0',
      '/api/workspaces/draft/revisions',
      '/api/workspaces/draft/revisions/1/content',
    ]);
    expect(JSON.parse(fetches()[0][1].body)).toEqual({
      baseRevision: 0,
      declaredBytes: data.length,
      idempotencyKey: uuid,
    });
    expect(JSON.parse(fetches()[3][1].body)).toEqual({ baseRevision: 0, fileId: 'approved-file' });
    for (const [, options] of fetches())
      expect(options.body ?? '').not.toContain('Privater Entwurf');
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['security_rejected', 'security_uninspectable'])(
    'passes %s without a commit or new reservation',
    async (error) => {
      respond(op());
      respond(op({ state: 'failed', error: error as UploadOperation['error'] }));
      await expect(
        saveWorkspace(
          'draft',
          { baseRevision: 0, bytes: bytes('text') },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: error });
      expect(fetches()).toHaveLength(2);
      expect(sendUploadBody).toHaveBeenCalledTimes(1);
    },
  );

  it('does not commit an operation response for another reservation', async () => {
    respond(op());
    respond(op({ id: 'foreign', state: 'ready', fileId: 'foreign-file' }));
    await expect(
      saveWorkspace(
        'draft',
        { baseRevision: 0, bytes: bytes('text') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetches()).toHaveLength(2);
  });

  it('does not retry a revision conflict or an unknown commit outcome', async () => {
    for (const outcome of ['revision_conflict', 'network']) {
      (request.authenticatedFetch as jest.Mock).mockReset();
      respond(op());
      respond(op({ state: 'ready', fileId: 'approved-file' }));
      if (outcome === 'revision_conflict') respond({ code: outcome }, 409);
      else
        (request.authenticatedFetch as jest.Mock).mockRejectedValueOnce(
          new TypeError('Network error'),
        );
      await expect(
        saveWorkspace(
          'draft',
          { baseRevision: 0, bytes: bytes('text') },
          new AbortController().signal,
        ),
      ).rejects.toBeDefined();
      expect(fetches()).toHaveLength(3);
    }
  });

  it('rejects a moved commit head without fetching another revision', async () => {
    respond(op());
    respond(op({ state: 'ready', fileId: 'approved-file' }));
    respond({ ...item, revision: 2, headFileId: 'someone-elses-file' });
    await expect(
      saveWorkspace(
        'draft',
        { baseRevision: 0, bytes: bytes('text') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetches()).toHaveLength(3);
  });

  it.each([401, 403])('clears authorization on HTTP %s without reading content', async (status) => {
    const body = respond({ code: 'forbidden' }, status);
    await expect(loadWorkspace('draft', new AbortController().signal)).rejects.toMatchObject({
      code: 'source_unavailable',
      status,
    });
    expect(body.read).not.toHaveBeenCalled();
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized content and cancels the bounded reader', async () => {
    respond({ ...item, revision: 1, headFileId: 'file' });
    const content = respond(new Uint8Array(65_537));
    await expect(loadWorkspace('draft', new AbortController().signal)).rejects.toMatchObject({
      code: 'response_limit',
    });
    expect(content.cancel).toHaveBeenCalledTimes(1);
  });

  it.each([0, 65_537])('sends no metadata or synthetic bytes for invalid size %s', async (size) => {
    await expect(
      saveWorkspace(
        'draft',
        { baseRevision: 0, bytes: new Uint8Array(size) },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: size ? 'document_too_large' : 'empty_document' });
    expect(request.authenticatedFetch).not.toHaveBeenCalled();
    expect(sendUploadBody).not.toHaveBeenCalled();
  });

  it('aborts bounded polling on owner disposal and leaves no commit or timer', async () => {
    const owner = new AbortController();
    respond(op());
    respond(op({ state: 'processing' }));
    const promise = saveWorkspace('draft', { baseRevision: 0, bytes: bytes('text') }, owner.signal);
    const rejected = promise.catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    owner.abort();
    expect(await rejected).toMatchObject({ name: 'AbortError' });
    expect(fetches()).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});
