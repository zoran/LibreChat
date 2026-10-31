/** worker-fixture.helper.ts owns isolated classifier fixture birth/cleanup and the inert AV port. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, stat, writeFile, rm } from 'node:fs/promises';
import { createInertAntivirusFixture } from './antivirus-fixture.helper';
import { createSecurityWorker } from './worker';
export function createSecurityWorkerFixture() {
  const policy = { version: 1 as const, markings: ['GEHEIM'], labels: ['Einstufung'] };
  const policySha256 = 'a'.repeat(64);
  const complete = { decision: 'clear', coverage: { complete: true, pages: 1, parts: 1 } };
  const signal = () => AbortSignal.timeout(3000);
  const subject = (text = 'Harmloser Text') => ({
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'upload',
    transferGeneration: 1,
    mediaType: 'text/plain',
    bytes: Buffer.byteLength(text),
    sha256: createHash('sha256').update(text).digest('hex'),
  });
  async function* body(text = 'Harmloser Text') {
    yield Buffer.from(text);
  }
  let directory: string;
  const workers: ReturnType<typeof createSecurityWorker>[] = [];
  function worker(options: Partial<Parameters<typeof createSecurityWorker>[0]> = {}) {
    const instance = createSecurityWorker({
      antivirus: createInertAntivirusFixture({ now: options.now }).runtime,
      instanceId: randomUUID(),
      policy,
      policySha256,
      threadPath: join(__dirname, '../../../dist/uploads/security/worker-thread.cjs'),
      ...options,
    });
    workers.push(instance);
    return instance;
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'security-worker-'));
    await writeFile(join(directory, 'package.json'), '{"type":"commonjs"}');
    // Reuse the qualified actual thread artifact; this suite never starts a package build.
    await stat(join(__dirname, '../../../dist/uploads/security/worker-thread.cjs'));
    // Controlled failure fixture: posts a claimed result but deliberately never exits.
    await writeFile(
      join(directory, 'no-exit.js'),
      `require('node:worker_threads').parentPort.postMessage(${JSON.stringify(JSON.stringify(complete))}); require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'thread-started'))}, 'started'); setInterval(()=>{},1000);`,
    );
    await writeFile(
      join(directory, 'bad-exit.js'),
      `require('node:worker_threads').parentPort.postMessage(${JSON.stringify(JSON.stringify(complete))}); process.exit(1);`,
    );
  });
  afterEach(async () => {
    for (const instance of workers.splice(0)) {
      if (!(await instance.close(signal())).complete)
        throw new Error('Owned worker did not settle');
    }
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  return {
    policy,
    policySha256,
    complete,
    signal,
    subject,
    body,
    worker,
    get directory() {
      return directory;
    },
  };
}
