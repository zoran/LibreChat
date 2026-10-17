/** Native library transport; the shared provider owns all wire validation. */
import {
  apiBaseUrl,
  request,
  readFileLibraryPage,
  readFileLibraryMetadata,
  readFileLibraryQuery,
  readFileLibraryUpdate,
} from 'librechat-data-provider';
import type { FileLibraryQuery, FileLibraryUpdate } from 'librechat-data-provider';

export class FileLibraryRequestError extends Error {
  constructor(public status: number) {
    super('file_library_unavailable');
  }
}

async function json(path: string, signal: AbortSignal, update?: FileLibraryUpdate) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.throwIfAborted();
  signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 30_000);
  try {
    const response = await request.authenticatedFetch(`${apiBaseUrl()}/api/files${path}`, {
      method: update ? 'PATCH' : 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      signal: controller.signal,
      ...(update
        ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update) }
        : {}),
    });
    controller.signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FileLibraryRequestError(response.status);
    }
    const value: unknown = await response.json();
    controller.signal.throwIfAborted();
    return value;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

export async function getFileLibrary(query: FileLibraryQuery, signal: AbortSignal) {
  const parsed = readFileLibraryQuery(query);
  if (!parsed) throw new FileLibraryRequestError(400);
  const params = new URLSearchParams();
  Object.entries(parsed).forEach(([key, value]) => params.set(key, String(value)));
  const page = readFileLibraryPage(await json(`/library?${params}`, signal));
  if (!page || page.files.length > parsed.limit) throw new FileLibraryRequestError(0);
  return page;
}

export async function updateFileLibrary(
  fileId: string,
  update: FileLibraryUpdate,
  signal: AbortSignal,
) {
  const parsed = readFileLibraryUpdate(update);
  if (!parsed) throw new FileLibraryRequestError(400);
  const metadata = readFileLibraryMetadata(
    await json(`/${encodeURIComponent(fileId)}/library`, signal, parsed),
  );
  if (!metadata) throw new FileLibraryRequestError(0);
  return metadata;
}
