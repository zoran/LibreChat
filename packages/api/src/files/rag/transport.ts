/** RAG transport owns TLS and dedicated signing; callers own durable operation authority. */
import { createHash } from 'node:crypto';
import { Agent, request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { readFileSync, statSync } from 'node:fs';
import {
  canonicalManagedJson,
  validateManagedCapability,
  MANAGED_DOCUMENT_WIRE_MAX_BYTES,
} from 'librechat-data-provider';
import type { ManagedCapability } from 'librechat-data-provider';
import { signManagedCapability } from '~/crypto/jwt';

type Context = Parameters<typeof validateManagedCapability>[1];
type Authority = Omit<Context, 'now'>;
const unavailable = () => new Error('Managed retrieval transport unavailable');
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const CLIENT_ROOT = '/etc/cortex-retrieval-client';

function material(path: string): Buffer {
  if (!path.startsWith('/') || !statSync(path).isFile() || statSync(path).size > 16384) {
    throw unavailable();
  }
  const bytes = readFileSync(path);
  if (bytes.length === 0 || bytes.length > 16384) {
    throw unavailable();
  }
  return bytes;
}

/** No redirects, proxy trust, client identity headers, retries, or system-root fallback. */
export function createRagTlsTransport(
  baseUrl: string,
  serverCertificateSha256: string,
): {
  send: (options: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: string;
    token?: string;
    timeoutMilliseconds: number;
    signal?: AbortSignal;
  }) => Promise<{ status: number; body: string }>;
  close: () => void;
  health(): Promise<boolean>;
} {
  const base = new URL(baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.pathname !== '/' && base.pathname !== '') ||
    !/^[a-f0-9]{64}$/.test(serverCertificateSha256)
  ) {
    throw unavailable();
  }
  const agent = new Agent({
    ca: material(`${CLIENT_ROOT}/ca.crt`),
    cert: material(`${CLIENT_ROOT}/tls.crt`),
    key: material(`${CLIENT_ROOT}/tls.key`),
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    keepAlive: false,
    maxCachedSessions: 0,
    checkServerIdentity(host, certificate) {
      const error = checkServerIdentity(host, certificate);
      if (error) return error;
      return hash(certificate.raw) === serverCertificateSha256 ? undefined : unavailable();
    },
  });
  async function send(options: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: string;
    token?: string;
    timeoutMilliseconds: number;
    signal?: AbortSignal;
  }): Promise<{ status: number; body: string }> {
    if (
      !/^\/(?:health|embed|query|query_multiple|documents)$/.test(options.path) ||
      !Number.isSafeInteger(options.timeoutMilliseconds) ||
      options.timeoutMilliseconds <= 0 ||
      options.timeoutMilliseconds > 30000
    ) {
      throw unavailable();
    }
    const maxResponseBytes = options.path === '/health' ? 16384 : MANAGED_DOCUMENT_WIRE_MAX_BYTES;
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (options.token) headers.Authorization = `Bearer ${options.token}`;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(options.body));
      }
      const req = request(
        new URL(options.path, base),
        {
          method: options.method,
          agent,
          headers,
          signal: options.signal,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxResponseBytes) {
              response.destroy(unavailable());
              req.destroy(unavailable());
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', () => reject(unavailable()));
          response.once('aborted', () => reject(unavailable()));
          response.once('end', () => {
            const status = response.statusCode ?? 0;
            if (!response.complete || status < 200 || status >= 300) {
              reject(unavailable());
            } else {
              resolve({ status, body: Buffer.concat(chunks).toString('utf8') });
            }
          });
        },
      );
      const timer = setTimeout(() => req.destroy(unavailable()), options.timeoutMilliseconds);
      timer.unref();
      req.once('close', () => clearTimeout(timer));
      req.once('error', () => reject(unavailable()));
      req.end(options.body);
    });
  }
  return {
    send,
    close: () => agent.destroy(),
    async health(): Promise<boolean> {
      const result = await send({ method: 'GET', path: '/health', timeoutMilliseconds: 4000 });
      return result.status === 200 && /^\s*\{\s*"status"\s*:\s*"UP"\s*\}\s*$/.test(result.body);
    },
  };
}

/** The composition caller supplies independent authority; response size uses the existing fixed wire ceiling. */
export function createManagedRagClient(options: { url: string; serverCertificateSha256: string }): {
  close: () => void;
  invoke(input: {
    purpose: ManagedCapability['purpose'];
    method: 'POST' | 'DELETE';
    path: '/embed' | '/query' | '/query_multiple' | '/documents';
    body: unknown;
    capability: unknown;
    authorize: () => Promise<Authority>;
    signal?: AbortSignal;
  }): Promise<unknown>;
} {
  const key = material(`${CLIENT_ROOT}/backend-signing.key`).toString('utf8');
  if (!/^[a-f0-9]{128}$/.test(key)) throw unavailable();
  const transport = createRagTlsTransport(options.url, options.serverCertificateSha256);
  return {
    close: transport.close,
    async invoke(input: {
      purpose: ManagedCapability['purpose'];
      method: 'POST' | 'DELETE';
      path: '/embed' | '/query' | '/query_multiple' | '/documents';
      body: unknown;
      capability: unknown;
      authorize: () => Promise<Authority>;
      signal?: AbortSignal;
    }): Promise<unknown> {
      const allowed =
        (input.purpose === 'index' && input.method === 'POST' && input.path === '/embed') ||
        (input.purpose === 'query' &&
          input.method === 'POST' &&
          (input.path === '/query' || input.path === '/query_multiple')) ||
        (input.purpose === 'purge' && input.method === 'DELETE' && input.path === '/documents');
      if (!allowed || typeof input.authorize !== 'function') throw unavailable();
      const body = canonicalManagedJson(input.body);
      const authority = await input.authorize();
      const context = { ...authority, now: Math.floor(Date.now() / 1000) };
      if (context.purpose !== input.purpose || context.requestSha256 !== hash(body))
        throw unavailable();
      const token = signManagedCapability(input.capability, context, key);
      const deadline =
        input.purpose === 'purge' ? context.cleanupDeadline : context.sourceExpiresAt;
      if (deadline === undefined) throw unavailable();
      const remaining = Math.min(30, context.workDeadline - context.now, deadline - context.now);
      const result = await transport.send({
        method: input.method,
        path: input.path,
        body,
        token,
        timeoutMilliseconds: remaining * 1000,
        signal: input.signal,
      });
      input.signal?.throwIfAborted();
      const current = { ...(await input.authorize()), now: Math.floor(Date.now() / 1000) };
      validateManagedCapability(input.capability, current);
      if (current.requestSha256 !== hash(body) || current.purpose !== input.purpose)
        throw unavailable();
      return JSON.parse(result.body) as unknown;
    },
  };
}

function environmentTransport(env: NodeJS.ProcessEnv) {
  const { RAG_API_URL, RAG_API_SERVER_SHA256 } = env;
  if (!RAG_API_URL || !RAG_API_SERVER_SHA256) {
    throw unavailable();
  }
  return { url: RAG_API_URL, serverCertificateSha256: RAG_API_SERVER_SHA256 };
}

/** The existing RAG owner reads its dedicated key only when an authorized caller is composed. */
export function createManagedRagClientFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof createManagedRagClient> {
  return createManagedRagClient(environmentTransport(env));
}

/** Actual auxiliary health consumer; one fixed client delivery owner supplies its TLS files. */
export async function checkRagApiHealth(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const options = environmentTransport(env);
  const transport = createRagTlsTransport(options.url, options.serverCertificateSha256);
  try {
    return await transport.health();
  } finally {
    transport.close();
  }
}
