/** Real raw/Mongo/mTLS/thread flow. Ordinary storage alone is a local-byte test double, not S3. */
import path from 'node:path';
import mongoose from 'mongoose';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createModels, createUploadManagementRepository } from '@librechat/data-schemas';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { UploadSecurityInspection, UploadSecurityExecution } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { StoragePort, UploadSecurityPort } from '../contract';
import { createSecurityTlsFixture } from './tls-fixture.helper';
import { createRawUploadBodyHandler } from '../transport/body';
import { createHttpUploadSecurityPort } from './transport';
import { createUploadManagement } from '../management';
import { startSecurityService } from './service';

describe('assembled scanner admission with real Mongo, mTLS and worker thread', () => {
  const db = new mongoose.Mongoose();
  const observer = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet | undefined;
  let certificates: ReturnType<typeof createSecurityTlsFixture> | undefined;
  let service: Awaited<ReturnType<typeof startSecurityService>> | undefined;
  let serviceOptions: Parameters<typeof startSecurityService>[0];
  let port: UploadSecurityPort;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  let management: ReturnType<typeof createUploadManagement>;
  let root: string | undefined;
  let stagingRoot: string;
  let ordinaryRoot: string;
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
  const policySha256 = createHash('sha256').update(policyBytes).digest('hex');
  const principal = {
    tenantId: 'flow-tenant',
    userId: new mongoose.Types.ObjectId().toString(),
    authentication: 'verified-email' as const,
  };
  const worker = { hostId: 'flow-host', instanceId: 'flow-app' };

  beforeAll(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    const threadPath = path.resolve(__dirname, '../../../dist/uploads/security/worker-thread.cjs');
    await stat(threadPath); // Missing build is a failure, never an implicit build or fake thread.
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'scanner-flow-'));
    stagingRoot = path.join(root, 'staging');
    ordinaryRoot = path.join(root, 'ordinary-storage-fake');
    await Promise.all([mkdir(stagingRoot), mkdir(ordinaryRoot)]);
    certificates = createSecurityTlsFixture();
    const certificate = (name: string) => readFile(path.join(certificates!.directory, name));
    const ca = await certificate('ca.pem');
    serviceOptions = {
      instanceId: '11111111-1111-4111-8111-111111111111',
      peers: [
        {
          certificateSha256: createHash('sha256')
            .update(new X509Certificate(await certificate('client.pem')).raw)
            .digest('hex'),
          role: 'intake',
        },
      ],
      policyBytes,
      policySha256,
      threadPath,
      host: '127.0.0.1',
      port: 0,
      tls: { ca, cert: await certificate('server.pem'), key: await certificate('server.key') },
    };
    service = await startSecurityService(serviceOptions);
    port = createHttpUploadSecurityPort({
      endpoint: `https://127.0.0.1:${service.address.port}`,
      allowedHosts: ['127.0.0.1'],
      policySha256,
      tls: { ca, cert: await certificate('client.pem'), key: await certificate('client.key') },
    });
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([db.connect(mongo.getUri('flow')), observer.connect(mongo.getUri('flow'))]);
    createModels(db);
    createModels(observer);
    await Promise.all([db.models.File.init(), observer.models.File.init()]);
  }, 30_000);

  beforeEach(async () => {
    for (const name of ['File', 'Message', 'UploadOperation', 'UploadCounter'])
      if (db.models[name]) await db.models[name].deleteMany({});
    for (const name of await readdir(ordinaryRoot)) await rm(path.join(ordinaryRoot, name));
    repository = createUploadManagementRepository(db, {
      enabled: true,
      reconciled: true,
      securityPolicySha256: policySha256,
      baseline: { originalBytes: 0, objectBytes: 0, textBytes: 0, recordBytes: 0, bundles: 0 },
    });
    const independent = createUploadManagementRepository(observer, {
      securityPolicySha256: policySha256,
    });
    await repository.initialize();
    await independent.initialize();
    management = createUploadManagement({
      repository,
      // Fixed test principal; repository ownership fences remain real on both Mongo clients.
      identity: {
        authorize: async (owner, scope) =>
          owner.tenantId === principal.tenantId &&
          owner.userId === principal.userId &&
          owner.authentication === principal.authentication &&
          scope.kind === 'personal',
      },
      // Trusted fixture admission only. This suite makes no native resource/isolation claim.
      resources: {
        assertSafe: async () => {
          await stat(stagingRoot);
        },
      },
    });
  });

  afterAll(async () => {
    let complete = true;
    try {
      if (service) complete = (await service.close(AbortSignal.timeout(10_000))).complete;
    } finally {
      try {
        await Promise.all([db.disconnect(), observer.disconnect()]);
      } finally {
        try {
          await mongo?.stop();
        } finally {
          certificates?.close();
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
    }
    if (!complete) throw new Error('Security service did not confirm complete shutdown');
  }, 30_000);

  it('rejects a policy hash that does not bind the actual policy bytes', async () => {
    await expect(
      startSecurityService({ ...serviceOptions, policySha256: '0'.repeat(64) }).then(
        async (unexpected) => {
          await unexpected.close();
          return unexpected;
        },
      ),
    ).rejects.toThrow('Security policy unavailable');
  });

  it('rejects correctly hashed policy bytes that omit the required markings', async () => {
    const incomplete = Buffer.from(JSON.stringify({ version: 1, markings: ['SYNTHETIC'] }));
    await expect(
      startSecurityService({
        ...serviceOptions,
        policyBytes: incomplete,
        policySha256: createHash('sha256').update(incomplete).digest('hex'),
      }).then(async (unexpected) => {
        await unexpected.close();
        return unexpected;
      }),
    ).rejects.toThrow('Required security markings unavailable');
  });

  it.each([
    ['allowed', Buffer.from('Freigegebener Text mit überprüfbarem Inhalt.'), undefined],
    ['marked', Buffer.from('Einstufung: VS-VERTRAULICH'), 'security_rejected'],
    ['invalid-utf8', Buffer.from([0xc3, 0x28]), 'security_uninspectable'],
  ] as const)(
    'runs %s bytes through the real scanner before ordinary storage',
    async (name, bytes, rejection) => {
      const filename = `Cortex-TEST-Privat-Grüße-${name}.txt`;
      const operation = await management.reserve(principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: bytes.length,
      });
      const originalSha256 = createHash('sha256').update(bytes).digest('hex');
      const observedInspections: UploadSecurityInspection[] = [];
      const bindings: { execution: UploadSecurityExecution; stored: unknown }[] = [];
      const storageStates: { stored: unknown; files: number }[] = [];
      const readOperation = () => observer.models.UploadOperation.findById(operation.id).lean();
      expect(await readOperation()).not.toHaveProperty('filename');
      expect(JSON.stringify(await readOperation())).not.toContain('Cortex-TEST-Privat');
      expect(JSON.stringify(await management.list(principal))).not.toContain('Cortex-TEST-Privat');
      const security: UploadSecurityPort = {
        policySha256: port.policySha256,
        prepare: (input) => port.prepare(input),
        cancel: (input) => port.cancel(input),
        async inspect(input) {
          bindings.push({ execution: input.execution, stored: await readOperation() });
          expect(bindings.at(-1)!.stored).not.toHaveProperty('filename');
          expect(JSON.stringify(bindings.at(-1)!.stored)).not.toContain('Cortex-TEST-Privat');
          const result = await port.inspect(input);
          observedInspections.push(result);
          return result;
        },
      };
      const ordinaryPath = path.join(ordinaryRoot, operation.id);
      // S3-compatible receipt shape only; the ordinary byte effect is exclusively this temp file.
      const put = jest.fn(async (input: Parameters<StoragePort['put']>[0]) => {
        storageStates.push({
          stored: await readOperation(),
          files: await observer.models.File.countDocuments({}),
        });
        const chunks: Buffer[] = [];
        for await (const chunk of input.body) {
          input.signal.throwIfAborted();
          chunks.push(Buffer.from(chunk));
        }
        await writeFile(ordinaryPath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
        return {
          outcome: 'durable' as const,
          source: 's3',
          bytes: input.bytes,
          integrity: input.integrity,
          filepath: `/api/files/download/${operation.id}`,
          storageKey: `t/${input.lease.tenantId}/managed-uploads/${input.lease.userId}/${operation.id}.${input.lease.generation}__original`,
        };
      });
      const storage: StoragePort = {
        put,
        async *read() {
          yield await readFile(ordinaryPath);
        },
        async remove() {
          await rm(ordinaryPath, { force: true });
          return 'absent';
        },
      };
      const request = Object.assign(new PassThrough(), {
        params: { id: operation.id },
        body: undefined,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-upload-filename': encodeURIComponent(filename),
        },
      });
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        statusCode: 0,
        value: undefined as unknown,
        setHeader() {},
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(value: unknown) {
          this.value = value;
          this.headersSent = true;
          this.writableEnded = true;
          return this;
        },
      });
      const handler = createRawUploadBodyHandler({
        management,
        principal: async () => principal,
        storage,
        security,
        worker,
        stagingRoot,
        claimBytes: management.claimWorkBytes,
        completeBytes: management.completeWorkBytes,
        deadlineMs: 15_000,
      });
      const done = handler(
        request as unknown as Request,
        response as unknown as Response,
        (error) => {
          if (error) throw error;
        },
      );
      request.end(bytes);
      await done;
      expect(bindings).toHaveLength(1);
      expect(bindings[0].stored).toMatchObject({
        state: 'transferring',
        securityExecution: bindings[0].execution,
      });
      expect(bindings[0].stored).not.toHaveProperty('securitySettlement');
      expect(observedInspections).toHaveLength(1);
      const stored = await readOperation();
      expect(stored).toMatchObject({
        securityExecution: bindings[0].execution,
        securitySettlement: {
          execution: bindings[0].execution,
          writerStopped: true,
          transientDataRemoved: true,
        },
        stagingHeld: false,
        cleanupPending: false,
      });
      expect(await readdir(stagingRoot)).toEqual([]);
      await expect(
        management.get(
          { ...principal, userId: new mongoose.Types.ObjectId().toString() },
          operation.id,
        ),
      ).rejects.toMatchObject({ code: 'forbidden' });
      if (rejection) {
        expect(response.statusCode).toBe(422);
        expect(response.value).toEqual({ code: rejection });
        expect(observedInspections[0].decision).toMatchObject({
          decision: rejection === 'security_rejected' ? 'rejected' : 'uninspectable',
        });
        expect(put).not.toHaveBeenCalled();
        expect(await readdir(ordinaryRoot)).toEqual([]);
        expect(await observer.models.File.countDocuments({})).toBe(0);
        expect(stored).not.toHaveProperty('securityApproval');
        expect(stored).not.toHaveProperty('filename');
        expect(JSON.stringify(stored)).not.toContain('Cortex-TEST-Privat');
        expect(JSON.stringify(await management.list(principal))).not.toContain(
          'Cortex-TEST-Privat',
        );
        expect(await management.claimProcessing(worker)).toBeNull();
        expect(await management.usage(principal)).toMatchObject({
          usedBytes: 0,
          retainedBytes: 0,
          reservedBytes: 0,
        });
      } else {
        expect(response.statusCode).toBe(202);
        expect(response.value).toMatchObject({ id: operation.id, state: 'queued_processing' });
        expect(put).toHaveBeenCalledTimes(1);
        expect(put.mock.calls[0][0].filename).toBe(filename);
        expect(storageStates[0].stored).not.toHaveProperty('filename');
        expect(storageStates[0]).toMatchObject({
          files: 0,
          stored: {
            state: 'transferring',
            securityExecution: bindings[0].execution,
            securitySettlement: {
              execution: bindings[0].execution,
              writerStopped: true,
              transientDataRemoved: true,
            },
          },
        });
        expect(await readFile(ordinaryPath)).toEqual(bytes);
        const approved = observedInspections[0].decision;
        expect(approved).toMatchObject({
          decision: 'approved',
          policySha256,
          scannerVersion: 'txt-worker-v1',
          subject: {
            tenantId: principal.tenantId,
            userId: principal.userId,
            operationId: operation.id,
            transferGeneration: 1,
            mediaType: 'text/plain',
            bytes: bytes.length,
            sha256: originalSha256,
          },
        });
        expect(stored).toMatchObject({
          state: 'queued_processing',
          securityApproval: approved,
          filename,
        });
        const file = await observer.models.File.findOne({ file_id: operation.id })
          .select('+securityApproval')
          .lean();
        expect(file).toMatchObject({ status: 'pending', securityApproval: approved, filename });
        expect(await management.usage(principal)).toMatchObject({
          usedBytes: bytes.length,
          retainedBytes: bytes.length,
          reservedBytes: 0,
        });
        const parserLease = await management.claimProcessing(worker);
        expect(parserLease?.generation).toBe(2);
        expect((await management.getProcessingInput(parserLease!)).securityApproval).toEqual(
          approved,
        );
        // No parser starts in this suite; release its admitted resources through the real owner.
        await management.fail(parserLease!, 'processing_failed');
        await management.confirmCleanup({
          operationId: operation.id,
          generation: parserLease!.generation,
          writerStopped: true,
          localCopiesAbsent: true,
          originalAbsent: false,
          textAndHistoryRemoved: true,
        });
      }
    },
    30_000,
  );
});
