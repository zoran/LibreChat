/** Public raw intake only. Deployment owns ingress routing, network isolation and credentials. */
import path from 'node:path';
import express from 'express';
import { createServer } from 'node:http';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import type { RequestHandler } from 'express';
import type { AddressInfo } from 'node:net';
import type { RemoteIntakeBodyOptions } from './remote';
import type { ApplicationWorkPort } from '~/app';
import type { IntakeChannel } from './channel';
import { createRemoteIntakeBodyHandler } from './remote';
import { createUploadAttemptJournal } from '../attempts';
import { createUploadBodyRouter } from '../http';

export type IntakeServiceOptions = Omit<RemoteIntakeBodyOptions, 'attempts'> & {
  allowedOrigins: readonly string[];
  host?: string;
  port?: number;
};

export async function startIntakeService(options: IntakeServiceOptions): Promise<{
  address: AddressInfo;
  maintenance: ApplicationWorkPort;
  close(signal?: AbortSignal): Promise<{ complete: boolean }>;
}> {
  const milliseconds = options.deadlineMs ?? 120_000;
  if (
    !path.isAbsolute(options.stagingRoot) ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 120_000
  )
    throw new Error('Invalid intake configuration');
  const journal = createUploadAttemptJournal(options.worker);
  const active = new Set<Promise<unknown>>();
  function track<T>(pending: Promise<T>): Promise<T> {
    active.add(pending);
    void pending.finally(() => active.delete(pending)).catch(() => undefined);
    return pending;
  }
  const channel: IntakeChannel = {
    control: (input) => track(options.channel.control(input)),
    promote: (input) => track(options.channel.promote(input)),
  };
  const remote = createRemoteIntakeBodyHandler({ ...options, channel, attempts: journal.attempts });
  const body: RequestHandler = (request, response, next) =>
    track(Promise.resolve(remote(request, response, next)));
  const router = createUploadBodyRouter({
    allowedOrigins: options.allowedOrigins,
    principal: remote.principal,
    body,
  });
  const app = express();
  app.disable('x-powered-by');
  let stopped = false;
  app.use((request, response, next) => {
    request.pause();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    if (stopped) {
      response.status(503).json({ code: 'unavailable' });
      return;
    }
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      response.status(400).json({ code: 'invalid_request' });
      return;
    }
    next();
  });
  app.use('/api/uploads', router);
  app.use((_request, response) => {
    response.status(404).json({ code: 'not_found' });
  });
  await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
  const staging = await lstat(options.stagingRoot);
  if (
    !staging.isDirectory() ||
    staging.isSymbolicLink() ||
    typeof process.getuid !== 'function' ||
    staging.uid !== process.getuid() ||
    (staging.mode & 0o077) !== 0 ||
    (await realpath(options.stagingRoot)) !== path.resolve(options.stagingRoot)
  )
    throw new Error('Invalid intake staging root');
  const server = createServer(
    {
      maxHeaderSize: 8192,
      requestTimeout: milliseconds,
      headersTimeout: Math.min(milliseconds, 5000),
      keepAliveTimeout: 1000,
    },
    app,
  );
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 1;
  server.setTimeout(milliseconds, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8080, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  let closed: Promise<void> | undefined;
  return {
    address: server.address() as AddressInfo,
    maintenance: journal.maintenance,
    async close(signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<{ complete: boolean }> {
      if (!stopped) {
        stopped = true;
        closed = new Promise((resolve) => server.close(() => resolve()));
      }
      const journalResult = journal.close(signal);
      server.closeAllConnections();
      let abort!: () => void;
      try {
        const interrupted = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('Intake drain interrupted'));
          signal.addEventListener('abort', abort, { once: true });
        });
        signal.throwIfAborted();
        const drained = (async () => {
          const result = await journalResult;
          await closed;
          while (active.size) await Promise.allSettled([...active]);
          return { complete: result.complete && (await readdir(options.stagingRoot)).length === 0 };
        })();
        return await Promise.race([drained, interrupted]);
      } catch {
        return { complete: false };
      } finally {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}
