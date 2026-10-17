/** Actual built processes, mTLS and scanner threads; this does not prove Kubernetes isolation. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
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
type OwnedChild = { ready(): Promise<void>; stop(): Promise<ExitResult> };

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
    const children: OwnedChild[] = [];
    const failures: unknown[] = [];
    const pem = (name: string) => readFileSync(join(fixture.directory, name));
    const tls = { ca: pem('ca.pem'), cert: pem('client.pem'), key: pem('client.key') };
    let endpoint: string;
    let environment: NodeJS.ProcessEnv;

    function launch(): OwnedChild {
      const artifacts = {
        entrySha256: hash(readFileSync(entry)),
        threadSha256: hash(readFileSync(thread)),
      };
      const child = spawn(process.execPath, [entry], {
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
        entry,
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
            if (healthy) return;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          throw new Error(`Scanner did not become ready: ${output}`);
        },
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
      const port = await availablePort();
      endpoint = `https://127.0.0.1:${port}`;
      const policyFile = join(directory, 'policy.json');
      writeFileSync(policyFile, policyBytes);
      environment = {
        NODE_ENV: 'test',
        TMPDIR: directory,
        POD_UID: randomUUID(),
        BUILD_COMMIT: 'a'.repeat(40),
        UPLOAD_SECURITY_PORT: String(port),
        UPLOAD_SECURITY_TLS_CA_FILE: join(fixture.directory, 'ca.pem'),
        UPLOAD_SECURITY_TLS_CERT_FILE: join(fixture.directory, 'server.pem'),
        UPLOAD_SECURITY_TLS_KEY_FILE: join(fixture.directory, 'server.key'),
        UPLOAD_SECURITY_POLICY_FILE: policyFile,
        UPLOAD_SECURITY_POLICY_SHA256: policySha256,
      };
      const client = createHttpUploadSecurityPort({
        endpoint,
        allowedHosts: ['127.0.0.1'],
        policySha256,
        tls,
      });
      const first = launch();
      await first.ready();
      const old = await client.prepare({ attemptId: 'entry-upload.1', subject, signal: signal() });
      expect(
        await client.inspect({ execution: old, subject, body: body(), signal: signal() }),
      ).toMatchObject({
        decision: { decision: 'approved', subject, policySha256 },
        cleanup: { writerStopped: true, transientDataRemoved: true },
      });
      expect(await client.cancel({ execution: old, signal: signal() })).toEqual({
        execution: old,
        writerStopped: true,
        transientDataRemoved: true,
      });
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
      expect(await client.cancel({ execution: old, signal: signal() })).toEqual({
        execution: old,
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
        cleanup: { writerStopped: true, transientDataRemoved: true },
      });
      expect(await client.cancel({ execution: current, signal: signal() })).toEqual({
        execution: current,
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
      for (const result of cleanup) {
        if (result.status === 'rejected') failures.push(result.reason);
      }
    }
    if (failures.length) throw failures[0];
  }, 30000);
});
