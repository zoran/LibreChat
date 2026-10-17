import { apiBaseUrl, getTokenHeader, request } from 'librechat-data-provider';
import type {
  ManagedUploadSnapshot,
  UploadOperation,
  UploadRequest,
} from 'librechat-data-provider';
import type { TransferProgress } from './progress';
import { createTransferProgress } from './progress';

export const uploadsUrl = `${apiBaseUrl()}/api/uploads`;
const transfers = new Map<string, XMLHttpRequest>();
export const abortManagedTransfer = (id: string) => transfers.get(id)?.abort();

export class UploadRequestError extends Error {
  constructor(
    public code: string,
    public status = 0,
  ) {
    super(code);
  }
}

/** A bounded application response; no file data is read through this JSON path. */
export async function uploadRequest<T>(suffix: string, options?: RequestInit): Promise<T> {
  const response = await request.authenticatedFetch(uploadsUrl + suffix, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const reader = response.body?.getReader();
  if (!reader) throw new UploadRequestError('unavailable', response.status);
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512 * 1024) throw new UploadRequestError('unavailable', response.status);
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (!response.ok)
      throw new UploadRequestError(
        typeof data.code === 'string' ? data.code : 'unavailable',
        response.status,
      );
    return data as T;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export const readUploadSnapshot = async (signal?: AbortSignal): Promise<ManagedUploadSnapshot> => {
  const data = await uploadRequest<ManagedUploadSnapshot>('', { signal });
  return {
    ...data,
    admissionsPaused: typeof data.admissionsPaused === 'boolean' ? data.admissionsPaused : null,
  };
};
export const reserveUpload = (body: UploadRequest, signal: AbortSignal) =>
  uploadRequest<UploadOperation>('/operations', {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
export const changeUpload = (id: string, action: 'cancel' | 'retry' | 'delete') =>
  uploadRequest<UploadOperation>(
    `/operations/${encodeURIComponent(id)}${action === 'delete' ? '' : '/' + action}`,
    {
      method: action === 'delete' ? 'DELETE' : 'POST',
      body: action === 'delete' ? undefined : '{}',
    },
  );

/** One raw transfer, no implicit body retry/resume. Byte progress is measured by the browser. */
export function sendUploadBody(
  id: string,
  file: File,
  signal: AbortSignal,
  onProgress: (progress: TransferProgress) => void,
): Promise<UploadOperation> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const sample = createTransferProgress(file.size);
    let lastPaint = -Infinity;
    let loaded = 0;
    const timer: { handle?: ReturnType<typeof setInterval> } = {};
    const abort = () => xhr.abort();
    const done = () => {
      clearInterval(timer.handle);
      signal.removeEventListener('abort', abort);
      transfers.delete(id);
    };
    xhr.open('PUT', `${uploadsUrl}/operations/${encodeURIComponent(id)}/body`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Filename', encodeURIComponent(file.name));
    const token = getTokenHeader();
    if (token) xhr.setRequestHeader('Authorization', token);
    xhr.timeout = 135_000;
    xhr.upload.onprogress = (event) => {
      const now = performance.now();
      loaded = event.loaded;
      const progress = sample(loaded, now);
      if (now - lastPaint >= 250 || event.loaded >= file.size) {
        lastPaint = now;
        onProgress(progress);
      }
    };
    xhr.onload = () => {
      done();
      try {
        if (xhr.responseText.length > 64 * 1024) throw new Error('response_limit');
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as UploadOperation);
        else reject(new UploadRequestError(data?.code ?? 'unavailable', xhr.status));
      } catch {
        reject(new UploadRequestError('unavailable', xhr.status));
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      done();
      reject(new UploadRequestError('unavailable'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    transfers.set(id, xhr);
    onProgress(sample(0, performance.now()));
    timer.handle = setInterval(() => onProgress(sample(loaded, performance.now())), 1_000);
    try {
      xhr.send(file);
    } catch {
      done();
      reject(new UploadRequestError('unavailable'));
    }
  });
}
