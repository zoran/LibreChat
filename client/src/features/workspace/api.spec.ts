import { request } from 'librechat-data-provider';
import type { DocumentWorkspace, UploadOperation } from 'librechat-data-provider';
import { sendUploadBody } from '../uploads/api';
import {
  createWorkspace,
  listWorkspaces,
  loadWorkspace,
  loadWorkspaceRevision,
  createWorkspaceSaveAttempt,
  saveWorkspace as resumeSave,
} from './api';

jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  request: { authenticatedFetch: jest.fn() },
}));
jest.mock('../uploads/api', () => ({ sendUploadBody: jest.fn() }));

const bytes = (text: string) => new TextEncoder().encode(text);
const identity = { ownerId: 'owner', tenantId: 'personal', workspaceId: 'draft' };
const saveWorkspace = async (
  id: string,
  input: { baseRevision: number; bytes: Uint8Array },
  signal: AbortSignal,
) =>
  resumeSave(
    createWorkspaceSaveAttempt({ ...identity, workspaceId: id }, input),
    signal,
    () => undefined,
  );
const committed = (fileId = 'approved-file', revision = 1) => ({
  workspaceId: 'draft',
  revision,
  fileId,
  createdAt: '2026-10-17T00:00:00Z',
  expiresAt: '2026-11-14T00:00:00Z',
});
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

  it('reads only the explicitly selected historical revision without inventing head metadata or writing', async () => {
    const content = bytes('\uFEFFAlte Version\r\n');
    respond(content);
    await expect(loadWorkspaceRevision('draft', 2, new AbortController().signal)).resolves.toEqual({
      workspaceId: 'draft',
      revision: 2,
      bytes: content,
    });
    expect(fetches()).toHaveLength(1);
    expect(fetches()[0]).toEqual([
      '/api/workspaces/draft/revisions/2/content',
      expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin' }),
    ]);
    expect(fetches()[0][1].body).toBeUndefined();
    expect(sendUploadBody).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects invalid historical revision %s before requesting bytes',
    async (revision) => {
      await expect(
        loadWorkspaceRevision('draft', revision, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetches()).toHaveLength(0);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['', '../other', '.', '..', 'x'.repeat(129)])(
    'rejects an invalid historical workspace identifier %s',
    async (id) => {
      await expect(
        loadWorkspaceRevision(id, 1, new AbortController().signal),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(fetches()).toHaveLength(0);
    },
  );

  it.each([401, 403, 404])(
    'keeps historical HTTP %s distinct from a valid content response',
    async (status) => {
      const body = respond({ code: 'not_found' }, status);
      await expect(
        loadWorkspaceRevision('draft', 1, new AbortController().signal),
      ).rejects.toMatchObject({
        code: status === 404 ? 'not_found' : 'source_unavailable',
        status,
      });
      expect(body.read).not.toHaveBeenCalled();
      expect(body.cancel).toHaveBeenCalledTimes(1);
      expect(sendUploadBody).not.toHaveBeenCalled();
    },
  );

  it('bounds historical content and rejects a late response after cancellation', async () => {
    const oversized = respond(new Uint8Array(65_537));
    await expect(
      loadWorkspaceRevision('draft', 1, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'response_limit' });
    expect(oversized.cancel).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    let release!: (response: unknown) => void;
    (request.authenticatedFetch as jest.Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const read = loadWorkspaceRevision('draft', 1, controller.signal);
    const result = read.catch((error: unknown) => error);
    controller.abort();
    release({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: jest.fn(), cancel: async () => undefined }) },
    });
    expect(await result).toMatchObject({ name: 'AbortError' });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('transfers once, waits for bound ready/cleanup status, commits once and reads the exact immutable revision', async () => {
    const data = bytes('\uFEFFPrivater Entwurf\r\n');
    const version = committed();
    respond(op());
    respond(op({ state: 'ready', fileId: 'approved-file', cleanupPending: true }));
    respond(op({ state: 'ready', fileId: 'approved-file', cleanupPending: false }));
    respond(version);
    respond(data);
    const promise = saveWorkspace(
      'draft',
      { baseRevision: 0, bytes: data },
      new AbortController().signal,
    );
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await promise;
    expect(result.version).toEqual(version);
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

  it('rejects another revision in place of the exact immutable receipt', async () => {
    respond(op());
    respond(op({ state: 'ready', fileId: 'approved-file' }));
    respond(committed('someone-elses-file', 2));
    await expect(
      saveWorkspace(
        'draft',
        { baseRevision: 0, bytes: bytes('text') },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(fetches()).toHaveLength(3);
  });

  it.each(['reserve', 'transfer', 'poll', 'commit', 'read'])(
    'reconciles a %s failure with the same captured identity and no duplicate body',
    async (phase) => {
      const data = bytes('Original attempt');
      let attempt = createWorkspaceSaveAttempt(identity, { baseRevision: 0, bytes: data });
      const key = attempt.idempotencyKey;
      data.fill(0);
      attempt.bytes.fill(0);
      const network = () =>
        (request.authenticatedFetch as jest.Mock).mockRejectedValueOnce(
          new TypeError('Lost response'),
        );
      if (phase === 'reserve') network();
      else {
        respond(op());
        if (phase === 'transfer')
          (sendUploadBody as jest.Mock).mockRejectedValueOnce(new TypeError('Lost body response'));
        else if (phase === 'poll') network();
        else {
          respond(op({ state: 'ready', fileId: 'approved-file' }));
          if (phase === 'commit') network();
          else {
            respond(committed());
            network();
          }
        }
      }
      const progress = (next: typeof attempt) => {
        attempt = next;
      };
      await expect(resumeSave(attempt, new AbortController().signal, progress)).rejects.toThrow();
      expect(attempt.idempotencyKey).toBe(key);
      expect(Object.isFrozen(attempt)).toBe(true);
      expect(attempt.bytes).toEqual(bytes('Original attempt'));
      if (phase === 'reserve') respond(op());
      if (['reserve', 'transfer', 'poll'].includes(phase))
        respond(op({ state: 'ready', fileId: 'approved-file' }));
      if (phase !== 'read') respond(committed());
      respond(bytes('Original attempt'));
      await expect(resumeSave(attempt, new AbortController().signal, progress)).resolves.toEqual({
        version: committed(),
        bytes: bytes('Original attempt'),
      });
      expect(sendUploadBody).toHaveBeenCalledTimes(1);
      const reservations = fetches().filter(([url]) => url.endsWith('/saves'));
      for (const [, options] of reservations)
        expect(JSON.parse(options.body).idempotencyKey).toBe(key);
      expect(reservations).toHaveLength(phase === 'reserve' ? 2 : 1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('holds an unknown body that is still waiting without retransmitting it', async () => {
    let attempt = createWorkspaceSaveAttempt(identity, { baseRevision: 0, bytes: bytes('text') });
    respond(op());
    (sendUploadBody as jest.Mock).mockRejectedValueOnce(new TypeError('unknown body'));
    const progress = (next: typeof attempt) => {
      attempt = next;
    };
    await expect(resumeSave(attempt, new AbortController().signal, progress)).rejects.toThrow();
    respond(op());
    const owner = new AbortController();
    const recovery = resumeSave(attempt, owner.signal, progress).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    owner.abort();
    expect(await recovery).toMatchObject({ name: 'AbortError' });
    expect(sendUploadBody).toHaveBeenCalledTimes(1);
    expect(fetches().filter(([url]) => url.endsWith('/revisions'))).toHaveLength(0);
  });

  it('keeps a conflicting replay bound to the original File and refuses different confirmed bytes', async () => {
    let attempt = createWorkspaceSaveAttempt(identity, { baseRevision: 0, bytes: bytes('mine') });
    const progress = (next: typeof attempt) => {
      attempt = next;
    };
    respond(op());
    respond(op({ state: 'ready', fileId: 'approved-file' }));
    respond({ code: 'revision_conflict' }, 409);
    await expect(resumeSave(attempt, new AbortController().signal, progress)).rejects.toMatchObject(
      { code: 'revision_conflict' },
    );
    respond(committed());
    respond(bytes('other'));
    await expect(resumeSave(attempt, new AbortController().signal, progress)).rejects.toMatchObject(
      { code: 'unavailable' },
    );
    expect(sendUploadBody).toHaveBeenCalledTimes(1);
    expect(attempt.bytes).toEqual(bytes('mine'));
    expect(
      fetches()
        .filter(([url]) => url.endsWith('/revisions'))
        .map(([, options]) => JSON.parse(options.body)),
    ).toEqual([
      { baseRevision: 0, fileId: 'approved-file' },
      { baseRevision: 0, fileId: 'approved-file' },
    ]);
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
