/** Actual shared process lifecycle/mTLS/threads with inert external AV; no physical AV or Kubernetes proof. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { antivirusReceiptFixture } from './antivirus-fixture.helper';
import { createSecurityTlsFixture } from './tls-fixture.helper';
import { createHttpUploadSecurityPort } from './transport';

const policyBytes = Buffer.from(
  JSON.stringify({
    version: 1,
    markings: [
      'VS-NfD',
      'VS-NUR FÜR DEN DIENSTGEBRAUCH',
      'VS-VERTRAULICH',
      'GEHEIM',
      'STRENG GEHEIM',
    ],
    labels: ['Einstufung'],
  }),
);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const policySha256 = hash(policyBytes);
const text = Buffer.from('hello');
const subject = {
  tenantId: 'entry-tenant',
  userId: 'entry-user',
  operationId: 'entry-upload',
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: text.length,
  sha256: hash(text),
};
const signal = () => AbortSignal.timeout(3000);
const body = async function* () {
  yield text;
};
type ExitResult = { code: number | null; signal: NodeJS.Signals | null };
type OwnedChild = {
  ready(): Promise<void>;
  exited(): Promise<ExitResult>;
  output(): string;
  stop(): Promise<ExitResult>;
};

async function bounded<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned scanner deadline exceeded')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function processIdentity(pid: number) {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').pop()!.split(' ');
    return {
      pid,
      startTicks: fields[19],
      processGroup: fields[2],
      bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

describe('built standalone scanner entry', () => {
  it('changes incarnation within one Pod, fences old executions and joins SIGTERM', async () => {
    const fixture = createSecurityTlsFixture();
    const directory = mkdtempSync(join(tmpdir(), 'scanner-entry-'));
    const entry = join(__dirname, '../../../dist/uploads/security/security-entry.cjs');
    const thread = join(__dirname, '../../../dist/uploads/security/worker-thread.cjs');
    const processEntry = join(__dirname, '../../../dist/uploads/security/security-process.cjs');
    const trustedFixtureEntry = join(directory, 'trusted-security-fixture.cjs');
    const children: OwnedChild[] = [];
    const failures: unknown[] = [];
    const pem = (name: string) => readFileSync(join(fixture.directory, name));
    const tls = { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') };
    let endpoint: string;
    let maintenancePort: number;
    let environment: NodeJS.ProcessEnv;
    const maintenanceToken = 'synthetic-private-maintenance-token-'.repeat(2);

    async function maintenance(
      method: string,
      path: string,
      body?: unknown,
      token = maintenanceToken,
    ) {
      return await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          const req = httpRequest(
            {
              host: '127.0.0.1',
              port: maintenancePort,
              path,
              method,
              signal: AbortSignal.timeout(3000),
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
              res.once('error', reject);
              res.once('end', () => {
                try {
                  resolve({
                    status: res.statusCode!,
                    body: JSON.parse(Buffer.concat(chunks).toString()),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          req.once('error', reject);
          req.end(body === undefined ? undefined : JSON.stringify(body));
        },
      );
    }

    function launch(executable = trustedFixtureEntry): OwnedChild {
      const artifacts = {
        entrySha256: hash(readFileSync(executable)),
        productionEntrySha256: hash(readFileSync(entry)),
        processSha256: hash(readFileSync(processEntry)),
        threadSha256: hash(readFileSync(thread)),
      };
      const child = spawn(process.execPath, [executable], {
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
      });
      const closed = new Promise<ExitResult>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      });
      // Register the real child before any signal; never adopt another process by PID alone.
      const identity = child.pid ? processIdentity(child.pid) : undefined;
      const provenanceFile = join(directory, `child-${child.pid}.json`);
      const provenance = {
        identity,
        parentPid: process.pid,
        entry: executable,
        ...artifacts,
        podUid: environment.POD_UID,
        buildCommit: environment.BUILD_COMMIT,
        checkpoint: 'Own child close event after graceful SIGTERM',
        cancellation:
          'Revalidate PID/startTicks/bootId before own-child SIGTERM or fallback SIGKILL',
      };
      const send = (value: NodeJS.Signals) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const current = child.pid ? processIdentity(child.pid) : undefined;
        if (!current) return;
        if (!identity || JSON.stringify(current) !== JSON.stringify(identity))
          throw new Error('Owned scanner process identity changed; refusing signal');
        child.kill(value);
      };
      const owned = {
        async ready() {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            if (child.exitCode !== null || child.signalCode !== null)
              throw new Error(`Scanner exited before readiness: ${output}`);
            const healthy = await new Promise<boolean>((resolve) => {
              const req = request(endpoint + '/healthz', { ...tls, agent: false }, (res) => {
                res.resume();
                res.once('end', () => resolve(res.statusCode === 200));
              });
              req.once('error', () => resolve(false));
              req.setTimeout(250, () => req.destroy());
              req.end();
            });
            if (
              healthy &&
              (await maintenance('GET', '/readyz').then(
                (result) => result.status === 200,
                () => false,
              ))
            )
              return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(`Scanner did not become ready: ${output}`);
        },
        async exited() {
          const result = await bounded(closed);
          writeFileSync(provenanceFile, JSON.stringify({ ...provenance, closed: result }));
          return result;
        },
        output: () => output,
        async stop() {
          send('SIGTERM');
          let result;
          try {
            result = await bounded(closed);
          } catch (error) {
            send('SIGKILL');
            await bounded(closed);
            throw error;
          }
          writeFileSync(provenanceFile, JSON.stringify({ ...provenance, closed: result }));
          return result;
        },
      };
      children.push(owned);
      writeFileSync(provenanceFile, JSON.stringify(provenance));
      return owned;
    }

    try {
      // Read the real build before spawning; this suite never substitutes a source-level entry.
      readFileSync(entry);
      readFileSync(thread);
      readFileSync(processEntry);
      const port = await availablePort();
      do {
        maintenancePort = await availablePort();
      } while (maintenancePort === port);
      endpoint = `https://127.0.0.1:${port}`;
      const policyFile = join(directory, 'policy.json');
      writeFileSync(policyFile, policyBytes);
      const peersFile = join(directory, 'peers.json');
      writeFileSync(
        peersFile,
        JSON.stringify([
          { certificateSha256: hash(new X509Certificate(pem('client.pem')).raw), role: 'intake' },
        ]),
      );
      environment = {
        NODE_ENV: 'test',
        TMPDIR: directory,
        POD_UID: randomUUID(),
        BUILD_COMMIT: 'a'.repeat(40),
        LIBRECHAT_MAINTENANCE_TOKEN: maintenanceToken,
        LIBRECHAT_MAINTENANCE_PORT: String(maintenancePort),
        UPLOAD_SECURITY_PORT: String(port),
        UPLOAD_SECURITY_TLS_CA_FILE: join(fixture.directory, 'ca.pem'),
        UPLOAD_SECURITY_TLS_CERT_FILE: join(fixture.directory, 'server.pem'),
        UPLOAD_SECURITY_TLS_KEY_FILE: join(fixture.directory, 'server.key'),
        UPLOAD_SECURITY_POLICY_FILE: policyFile,
        UPLOAD_SECURITY_POLICY_SHA256: policySha256,
        UPLOAD_SECURITY_PEERS_FILE: peersFile,
      };
      // Only the external AV boundary is inert; the child executes the real built shared lifecycle.
      writeFileSync(
        trustedFixtureEntry,
        `require(${JSON.stringify(require.resolve('ts-node'))}).register({
          skipProject: true, transpileOnly: true,
          compilerOptions: { module: 'CommonJS', moduleResolution: 'Node', target: 'ES2022', esModuleInterop: true }
        });
        const { readFileSync } = require('node:fs');
        const { createInertAntivirusFixture } = require(${JSON.stringify(join(__dirname, 'antivirus-fixture.helper.ts'))});
        const { startSecurityProcess } = require(${JSON.stringify(processEntry)});
        const material = name => readFileSync(process.env[name]);
        startSecurityProcess({
          env: process.env,
          serviceOptions: {
            antivirus: createInertAntivirusFixture().runtime,
            port: Number(process.env.UPLOAD_SECURITY_PORT),
            policySha256: process.env.UPLOAD_SECURITY_POLICY_SHA256,
            policyBytes: material('UPLOAD_SECURITY_POLICY_FILE'),
            peers: JSON.parse(material('UPLOAD_SECURITY_PEERS_FILE').toString('utf8')),
            tls: { ca: material('UPLOAD_SECURITY_TLS_CA_FILE'), cert: material('UPLOAD_SECURITY_TLS_CERT_FILE'), key: material('UPLOAD_SECURITY_TLS_KEY_FILE') },
            threadPath: ${JSON.stringify(thread)}
          }
        }).catch(() => { console.error('trusted_security_fixture_start_failed'); process.exitCode = 1; });`,
      );
      // The production executable remains unconditional and fails closed without Root AV assets.
      const missingRootAv = launch(entry);
      expect(await missingRootAv.exited()).toEqual({ code: 1, signal: null });
      expect(missingRootAv.output()).toContain('upload_security_start_failed');
      await expect(maintenance('GET', '/readyz')).rejects.toThrow();
      const client = createHttpUploadSecurityPort({
        endpoint,
        allowedHosts: ['127.0.0.1'],
        policySha256,
        tls,
      });
      const first = launch();
      await first.ready();
      expect(await maintenance('GET', '/readyz')).toMatchObject({
        status: 200,
        body: { ready: true },
      });
      expect((await maintenance('GET', '/status', undefined, 'wrong-token')).status).toBe(403);
      const old = await client.prepare({ attemptId: 'entry-upload.1', subject, signal: signal() });
      // Admitted work must stay addressable; only maintenance closure makes readiness false.
      expect((await maintenance('GET', '/readyz')).status).toBe(200);
      const initial = await maintenance('GET', '/status');
      expect(initial).toMatchObject({
        status: 200,
        body: {
          phase: 'running',
          revision: 0,
          storageProviders: {
            ordinaryS3: { state: 'not-owned' },
            managedS3: { state: 'not-owned' },
          },
          identity: {
            podUid: environment.POD_UID,
            source: environment.BUILD_COMMIT,
            incarnation: old.instanceId,
          },
        },
      });
      const requestId = 'entry-maintenance';
      const begin = {
        requestId,
        expectedRevision: initial.body.revision,
        identity: initial.body.identity,
      };
      expect(
        (
          await maintenance('POST', '/begin', {
            ...begin,
            identity: { ...(initial.body.identity as object), incarnation: randomUUID() },
          })
        ).status,
      ).toBe(400);
      expect(await maintenance('POST', '/begin', begin)).toMatchObject({
        status: 200,
        body: { phase: 'quiescing', revision: 1 },
      });
      expect(await maintenance('GET', '/readyz')).toMatchObject({
        status: 503,
        body: { ready: false },
      });
      await expect(
        client.prepare({
          attemptId: 'paused.1',
          subject: { ...subject, operationId: 'paused' },
          signal: signal(),
        }),
      ).rejects.toThrow('security_uninspectable');
      expect(
        await client.inspect({ execution: old, subject, body: body(), signal: signal() }),
      ).toMatchObject({
        decision: { decision: 'approved', subject, policySha256 },
        settlement: { writerStopped: true, transientDataRemoved: true },
      });
      expect(await client.cancel({ execution: old, signal: signal() })).toEqual({
        execution: old,
        antivirusReceipt: antivirusReceiptFixture(old),
        writerStopped: true,
        transientDataRemoved: true,
      });
      expect(await maintenance('GET', '/status')).toMatchObject({
        status: 200,
        body: {
          phase: 'drained',
          known: true,
          revision: 1,
          requestId,
          census: {
            initializing: 0,
            providerExecutions: 0,
            activeStreams: 0,
            unresolved: 0,
            queuedContinuations: 0,
            pendingWrites: 0,
            complete: true,
            admissionClosed: true,
          },
        },
      });
      expect((await maintenance('POST', '/cancel', begin)).status).toBe(409);
      expect(await maintenance('POST', '/cancel', { ...begin, expectedRevision: 1 })).toMatchObject(
        { status: 200, body: { phase: 'running', revision: 2 } },
      );
      expect((await maintenance('GET', '/readyz')).status).toBe(200);
      // Leave a real prepared attempt for the signal handler to stop and join.
      await client.prepare({
        attemptId: 'pending.1',
        subject: { ...subject, operationId: 'pending' },
        signal: signal(),
      });
      expect(await first.stop()).toEqual({ code: 0, signal: null });

      const second = launch();
      await second.ready();
      const current = await client.prepare({
        attemptId: 'entry-upload.1',
        subject,
        signal: signal(),
      });
      expect(current.instanceId).not.toBe(old.instanceId);
      expect(await maintenance('GET', '/status')).toMatchObject({
        status: 200,
        body: {
          phase: 'running',
          revision: 0,
          storageProviders: {
            ordinaryS3: { state: 'not-owned' },
            managedS3: { state: 'not-owned' },
          },
          identity: {
            incarnation: current.instanceId,
            podUid: environment.POD_UID,
            source: environment.BUILD_COMMIT,
          },
        },
      });
      expect((await maintenance('POST', '/begin', begin)).status).toBe(400);
      expect(await client.cancel({ execution: old, signal: signal() })).toEqual({
        execution: old,
        antivirusReceipt: null,
        writerStopped: false,
        transientDataRemoved: false,
      });
      await expect(
        client.inspect({ execution: old, subject, body: body(), signal: signal() }),
      ).rejects.toThrow('security_uninspectable');
      expect(
        await client.inspect({ execution: current, subject, body: body(), signal: signal() }),
      ).toMatchObject({
        decision: { decision: 'approved', subject, policySha256 },
        settlement: { writerStopped: true, transientDataRemoved: true },
      });
      expect(await client.cancel({ execution: current, signal: signal() })).toEqual({
        execution: current,
        antivirusReceipt: antivirusReceiptFixture(current),
        writerStopped: true,
        transientDataRemoved: true,
      });
      expect(await second.stop()).toEqual({ code: 0, signal: null });
    } catch (error) {
      failures.push(error);
    } finally {
      const cleanup = await Promise.allSettled(children.map((child) => child.stop()));
      fixture.close();
      // Keep only the nonsensitive child provenance under the caller's owned TMPDIR.
      rmSync(join(directory, 'policy.json'), { force: true });
      rmSync(join(directory, 'peers.json'), { force: true });
      rmSync(trustedFixtureEntry, { force: true });
      for (const result of cleanup) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    if (failures.length) throw failures[0];
  }, 30000);
});
