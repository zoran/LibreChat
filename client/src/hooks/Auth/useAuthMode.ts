import { useQuery } from '@tanstack/react-query';
import { apiBaseUrl } from 'librechat-data-provider';
import type { EmailCodeConfig } from 'librechat-data-provider';

export class EmailCodeRequestError extends Error {
  constructor(
    public code: string,
    public retryAfter = 0,
  ) {
    super(code);
  }
}

export async function emailCodeRequest<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${apiBaseUrl()}/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal,
    headers:
      body === undefined
        ? undefined
        : {
            'Content-Type': 'application/json',
            ...(path === 'guest' || path.startsWith('browser')
              ? { 'X-LibreChat-Browser': '1' }
              : {}),
          },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw new EmailCodeRequestError(
      typeof data?.code === 'string' ? data.code : 'EMAIL_CODE_UNAVAILABLE',
      Math.max(0, Math.min(3600, Number(response.headers.get('Retry-After')) || 0)),
    );
  }
  return data as T;
}

/** One shared discovery request; no client setting grants a server authentication mode. */
export default function useAuthMode(enabled = true) {
  return useQuery<EmailCodeConfig>(
    ['authMode'],
    ({ signal }) => emailCodeRequest('mode', undefined, signal),
    {
      staleTime: 60_000,
      retry: false,
      enabled,
    },
  );
}
