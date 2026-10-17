import { apiBaseUrl, request } from 'librechat-data-provider';
import type {
  DocumentWorkspace,
  DocumentWorkspaceFormat,
  DocumentWorkspaceVersion,
  UploadOperation,
} from 'librechat-data-provider';
import { sendUploadBody } from '../uploads/api';
import type { WorkspaceEditorDocument } from './WorkspaceEditor';
import type { WorkspaceEditorIdentity } from './model';

const baseUrl = `${apiBaseUrl()}/api/workspaces`;
const maxContentBytes = 65_536;
const maxJsonBytes = 512 * 1024;

/** An immutable content read carries no claim about the workspace's current head. */
export type WorkspaceRevisionContent = {
  workspaceId: string;
  revision: number;
  bytes: Uint8Array;
};

export class WorkspaceRequestError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}

function normalizeError(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'status' in error &&
    (error.status === 401 || error.status === 403)
  ) {
    throw new WorkspaceRequestError('source_unavailable', error.status);
  }
  throw error;
}

async function boundedBytes(response: Response, limit: number, signal: AbortSignal) {
  const reader = response.body?.getReader();
  if (!reader) throw new WorkspaceRequestError('unavailable', response.status);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) throw new WorkspaceRequestError('response_limit', response.status);
      chunks.push(part.value);
    }
    signal.throwIfAborted();
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function fetchResponse(suffix: string, signal: AbortSignal, body?: object) {
  signal.throwIfAborted();
  const response = await request.authenticatedFetch(baseUrl + suffix, {
    method: body ? 'POST' : 'GET',
    ...(body
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceRequestError('source_unavailable', response.status);
  }
  return response;
}

async function json(suffix: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetchResponse(suffix, signal, body);
  let data;
  try {
    data = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(
        await boundedBytes(response, maxJsonBytes, signal),
      ),
    );
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof WorkspaceRequestError) throw error;
    throw new WorkspaceRequestError('unavailable', response.status);
  }
  if (!response.ok) {
    let code = data && typeof data.code === 'string' ? data.code : 'unavailable';
    if (response.status === 404) code = 'not_found';
    throw new WorkspaceRequestError(code, response.status);
  }
  return data;
}

function workspace(value: unknown, expectedId?: string): DocumentWorkspace {
  const item = value as DocumentWorkspace | null;
  if (
    !item ||
    typeof item.workspaceId !== 'string' ||
    !item.workspaceId ||
    (expectedId !== undefined && item.workspaceId !== expectedId) ||
    typeof item.title !== 'string' ||
    !['text', 'markdown'].includes(item.format) ||
    !Number.isSafeInteger(item.revision) ||
    item.revision < 0 ||
    (item.revision === 0
      ? item.headFileId !== null
      : typeof item.headFileId !== 'string' || !item.headFileId) ||
    typeof item.createdAt !== 'string' ||
    typeof item.updatedAt !== 'string' ||
    (item.expiresAt !== null && typeof item.expiresAt !== 'string')
  ) {
    throw new WorkspaceRequestError('unavailable');
  }
  return item;
}

async function limited<T>(
  parent: AbortSignal,
  milliseconds: number,
  task: (signal: AbortSignal) => Promise<T>,
) {
  parent.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, milliseconds);
  try {
    const result = await task(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    return normalizeError(error);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  }
}

export const listWorkspaces = (signal: AbortSignal, before?: string) =>
  limited(signal, 30_000, async (bounded) => {
    const data = (await json(before ? `?before=${encodeURIComponent(before)}` : '', bounded)) as {
      workspaces?: unknown[];
      nextCursor?: unknown;
    } | null;
    if (
      !data ||
      !Array.isArray(data.workspaces) ||
      (data.nextCursor !== null && typeof data.nextCursor !== 'string')
    ) {
      throw new WorkspaceRequestError('unavailable');
    }
    return {
      workspaces: data.workspaces.map((item) => workspace(item)),
      nextCursor: data.nextCursor as string | null,
    };
  });

export const createWorkspace = (format: DocumentWorkspaceFormat, signal: AbortSignal) =>
  limited(signal, 30_000, async (bounded) => {
    const created = workspace(await json('', bounded, { format }));
    if (created.revision !== 0) throw new WorkspaceRequestError('unavailable');
    return created;
  });

async function revisionContent(
  workspaceId: string,
  revision: number,
  signal: AbortSignal,
): Promise<WorkspaceRevisionContent> {
  if (
    typeof workspaceId !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(workspaceId) ||
    workspaceId === '.' ||
    workspaceId === '..' ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  )
    throw new WorkspaceRequestError('invalid_request');
  const response = await fetchResponse(
    `/${encodeURIComponent(workspaceId)}/revisions/${revision}/content`,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceRequestError(
      response.status === 404 ? 'not_found' : 'unavailable',
      response.status,
    );
  }
  return { workspaceId, revision, bytes: await boundedBytes(response, maxContentBytes, signal) };
}

export const loadWorkspaceRevision = (id: string, revision: number, signal: AbortSignal) =>
  limited(signal, 30_000, (bounded) => revisionContent(id, revision, bounded));

async function content(
  item: DocumentWorkspace,
  signal: AbortSignal,
): Promise<WorkspaceEditorDocument> {
  if (item.revision === 0) return { workspace: item, bytes: new Uint8Array() };
  const result = await revisionContent(item.workspaceId, item.revision, signal);
  return { workspace: item, bytes: result.bytes };
}

export const loadWorkspace = (id: string, signal: AbortSignal) =>
  limited(signal, 30_000, async (bounded) =>
    content(workspace(await json(`/${encodeURIComponent(id)}`, bounded), id), bounded),
  );

function operation(value: unknown, expectedId?: string): UploadOperation {
  const item = value as UploadOperation | null;
  if (
    !item ||
    typeof item.id !== 'string' ||
    !item.id ||
    item.version !== 1 ||
    (expectedId !== undefined && item.id !== expectedId) ||
    typeof item.cleanupPending !== 'boolean' ||
    ![
      'waiting',
      'transferring',
      'queued_processing',
      'processing',
      'ready',
      'failed',
      'cancelled',
      'deleted',
      'expired',
    ].includes(item.state)
  ) {
    throw new WorkspaceRequestError('unavailable');
  }
  return item;
}

function wait(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1_000);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** A receipt identifies one immutable revision, never the workspace's current head. */
export type WorkspaceSavedRevision = { version: DocumentWorkspaceVersion; bytes: Uint8Array };
export type WorkspaceSaveAttempt = Readonly<{
  identity: WorkspaceEditorIdentity;
  baseRevision: number;
  idempotencyKey: string;
  /** Every access returns a copy of the original submitted bytes. */
  bytes: Uint8Array;
  phase: 'reserve' | 'transfer' | 'poll' | 'commit' | 'read';
  operationId?: string;
  fileId?: string;
  version?: DocumentWorkspaceVersion;
}>;

function checkpoint(value: WorkspaceSaveAttempt): WorkspaceSaveAttempt {
  const bytes = new Uint8Array(value.bytes);
  return Object.freeze({
    ...value,
    identity: Object.freeze({ ...value.identity }),
    ...(value.version ? { version: Object.freeze({ ...value.version }) } : {}),
    get bytes() {
      return new Uint8Array(bytes);
    },
  });
}

/** The keyed editor owns this attempt; phase checkpoints keep its original identity and bytes. */
export function createWorkspaceSaveAttempt(
  identity: WorkspaceEditorIdentity,
  input: { baseRevision: number; bytes: Uint8Array },
): WorkspaceSaveAttempt {
  if (
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 0 ||
    [identity.tenantId, identity.ownerId, identity.workspaceId].some(
      (part) => typeof part !== 'string' || !part,
    ) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(identity.workspaceId)
  )
    throw new WorkspaceRequestError('invalid_request');
  return checkpoint({ ...input, identity, idempotencyKey: crypto.randomUUID(), phase: 'reserve' });
}

function receipt(value: unknown, attempt: WorkspaceSaveAttempt): DocumentWorkspaceVersion {
  const item = value as DocumentWorkspaceVersion | null;
  if (
    !item ||
    item.workspaceId !== attempt.identity.workspaceId ||
    item.revision !== attempt.baseRevision + 1 ||
    item.fileId !== attempt.fileId ||
    typeof item.createdAt !== 'string' ||
    typeof item.expiresAt !== 'string'
  )
    throw new WorkspaceRequestError('unavailable');
  return {
    workspaceId: item.workspaceId,
    revision: item.revision,
    fileId: item.fileId,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
  };
}

/** Resume the same native save. A possibly started body is only polled, never retransmitted. */
export const saveWorkspace = (
  attempt: WorkspaceSaveAttempt,
  signal: AbortSignal,
  onProgress: (next: WorkspaceSaveAttempt) => void,
): Promise<WorkspaceSavedRevision> =>
  limited(signal, 180_000, async (bounded) => {
    let current = attempt;
    if (!current.bytes.length) throw new WorkspaceRequestError('empty_document');
    if (current.bytes.length > maxContentBytes)
      throw new WorkspaceRequestError('document_too_large');
    const advance = (next: Partial<WorkspaceSaveAttempt>) => {
      bounded.throwIfAborted();
      current = checkpoint({ ...current, ...next });
      onProgress(current);
    };
    const prefix = `/${encodeURIComponent(current.identity.workspaceId)}`;
    if (current.phase === 'reserve') {
      const reserved = operation(
        await json(`${prefix}/saves`, bounded, {
          baseRevision: current.baseRevision,
          declaredBytes: current.bytes.length,
          idempotencyKey: current.idempotencyKey,
        }),
      );
      advance({
        operationId: reserved.id,
        phase: reserved.state === 'waiting' ? 'transfer' : 'poll',
      });
    }
    if (current.phase === 'transfer') {
      const file = new File([new Uint8Array(current.bytes)], 'cortex-entwurf.txt', {
        type: 'text/plain',
      });
      // Persist this phase in the owning session BEFORE the external body effect starts.
      advance({ phase: 'poll' });
      operation(
        await sendUploadBody(current.operationId!, file, bounded, () => undefined),
        current.operationId,
      );
    }
    if (current.phase === 'poll') {
      for (let count = 0; count < 120; count++) {
        bounded.throwIfAborted();
        const status = operation(
          await json(
            `${prefix}/saves/${encodeURIComponent(current.operationId!)}?baseRevision=${current.baseRevision}`,
            bounded,
          ),
          current.operationId,
        );
        if (['failed', 'cancelled', 'deleted', 'expired'].includes(status.state)) {
          throw new WorkspaceRequestError(status.error ?? status.state);
        }
        if (status.state === 'ready' && !status.cleanupPending) {
          if (typeof status.fileId !== 'string' || !status.fileId)
            throw new WorkspaceRequestError('unavailable');
          advance({ fileId: status.fileId, phase: 'commit' });
          break;
        }
        await wait(bounded);
      }
      if (current.phase === 'poll') throw new WorkspaceRequestError('save_timeout');
    }
    if (current.phase === 'commit') {
      const version = receipt(
        await json(`${prefix}/revisions`, bounded, {
          baseRevision: current.baseRevision,
          fileId: current.fileId,
        }),
        current,
      );
      advance({ version, phase: 'read' });
    }
    if (current.phase !== 'read' || !current.version)
      throw new WorkspaceRequestError('unavailable');
    const result = await revisionContent(
      current.identity.workspaceId,
      current.version.revision,
      bounded,
    );
    const submitted = current.bytes;
    if (
      result.bytes.length !== submitted.length ||
      !result.bytes.every((byte, index) => byte === submitted[index])
    ) {
      throw new WorkspaceRequestError('unavailable');
    }
    return { version: { ...current.version }, bytes: result.bytes };
  });
