/** Dedicated scanner listener; composition supplies only policy, mTLS identity and worker code. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createSecurityRequestHandler } from './transport';
import { waitForSecurityResponse } from './cancellation';
import { inspectSecurityMarkings } from './markings';
import { createSecurityWorker } from './worker';

export async function startSecurityService(options: {
  instanceId: string;
  policyBytes: Uint8Array;
  policySha256: string;
  tls: { ca: Buffer; cert: Buffer; key: Buffer };
  threadPath: string;
  host?: string;
  port?: number;
}): Promise<{
  address: AddressInfo;
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
    createSecurityRequestHandler(worker),
  );
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
    async close(signal = AbortSignal.timeout(10000)): Promise<{ complete: boolean }> {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      const drained = await worker.close(signal);
      try {
        await waitForSecurityResponse(() => stopped, signal);
        return { complete: drained.complete };
      } catch {
        return { complete: false };
      }
    },
  };
}
