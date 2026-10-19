/** Dedicated scanner listener; composition supplies only policy, mTLS identity and worker code. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { SecurityProcessProfile } from './process-launcher';
import type { SecurityPdfOcrConfiguration } from './pdf-ocr';
import type { UploadSecurityClientPeer } from './transport';
import type { ApplicationWorkPort } from '~/app';
import { createSecurityProcessLauncher } from './process-launcher';
import { createSecurityRequestHandler } from './transport';
import { waitForSecurityResponse } from './cancellation';
import { createSecurityPdfOcrProvider } from './pdf-ocr';
import { inspectSecurityMarkings } from './markings';
import { createSecurityWorker } from './worker';

export async function startSecurityService(options: {
  instanceId: string;
  policyBytes: Uint8Array;
  policySha256: string;
  tls: { ca: Buffer; cert: Buffer; key: Buffer };
  peers: readonly UploadSecurityClientPeer[];
  threadPath: string;
  pdf?: { provider: SecurityPdfOcrConfiguration; process: SecurityProcessProfile };
  host?: string;
  port?: number;
}): Promise<{
  address: AddressInfo;
  maintenance: ApplicationWorkPort;
  close(signal?: AbortSignal): Promise<{ complete: boolean }>;
}> {
  if (
    options.policyBytes.byteLength > 65536 ||
    createHash('sha256').update(options.policyBytes).digest('hex') !== options.policySha256
  )
    throw new Error('Security policy unavailable');
  const policy = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(options.policyBytes));
  for (const marking of [
    'VS-NfD',
    'VS-NUR FÜR DEN DIENSTGEBRAUCH',
    'VS-VERTRAULICH',
    'GEHEIM',
    'STRENG GEHEIM',
  ]) {
    const result = inspectSecurityMarkings(policy, {
      version: 1,
      coverage: { complete: true, pages: 1, parts: 1 },
      units: [{ part: 1, page: 1, placement: 'heading', text: marking }],
    });
    if (result.decision !== 'rejected') throw new Error('Required security markings unavailable');
  }
  const worker = createSecurityWorker({
    instanceId: options.instanceId,
    policy,
    policySha256: options.policySha256,
    threadPath: options.threadPath,
    ...(options.pdf
      ? {
          pdf: {
            provider: createSecurityPdfOcrProvider(options.pdf.provider),
            launcher: createSecurityProcessLauncher(options.pdf.process),
          },
        }
      : {}),
  });
  const active = new Set<Promise<void>>();
  let stopped = false;
  let closed: Promise<void> | undefined;
  const maintenance: ApplicationWorkPort = {
    pauseAdmissions(requestId) {
      return !stopped && worker.maintenance.pauseAdmissions(requestId);
    },
    resumeAdmissions(requestId) {
      return !stopped && active.size === 0 && worker.maintenance.resumeAdmissions(requestId);
    },
    async getMaintenanceCensus(requestId) {
      const census = await worker.maintenance.getMaintenanceCensus(requestId);
      return {
        ...census,
        // Handler and worker are distinct obligations, even for the same inspection.
        pendingWrites: census.pendingWrites + active.size,
        complete: census.complete && active.size === 0,
      };
    },
  };
  const handler = createSecurityRequestHandler(worker, {
    peers: options.peers,
    track(work) {
      active.add(work);
      void work.finally(() => active.delete(work)).catch(() => undefined);
    },
  });
  const server = createServer(
    {
      ...options.tls,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxHeaderSize: 8192,
      requestTimeout: 60000,
      headersTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    handler,
  );
  // Do not let Node grant body admission before the same peer/role gate runs.
  server.on('checkContinue', handler);
  server.on('checkExpectation', handler);
  server.maxConnections = 8;
  server.maxRequestsPerSocket = 2;
  server.setTimeout(65000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8443, options.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return {
    address: server.address() as AddressInfo,
    maintenance,
    async close(signal = AbortSignal.timeout(10000)): Promise<{ complete: boolean }> {
      if (!stopped) {
        stopped = true;
        closed = new Promise<void>((resolve) => server.close(() => resolve()));
      }
      const drained = worker.close(signal);
      server.closeAllConnections();
      try {
        return await waitForSecurityResponse(async () => {
          const result = await drained;
          await closed;
          while (active.size) await Promise.allSettled([...active]);
          return { complete: result.complete };
        }, signal);
      } catch {
        return { complete: false };
      }
    },
  };
}
