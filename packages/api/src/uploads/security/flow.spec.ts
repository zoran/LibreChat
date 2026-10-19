/** Real raw/Mongo/mTLS/thread flow. Ordinary storage alone is a local-byte test double, not S3. */
import path from 'node:path';
import mongoose from 'mongoose';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { UPLOAD_RETENTION_MS } from 'librechat-data-provider';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { createModels, createUploadManagementRepository } from '@librechat/data-schemas';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type {
  UploadDerivedOrigin,
  UploadSecurityApproval,
  UploadSecurityInspection,
  UploadSecurityExecution,
} from 'librechat-data-provider';
import type { UploadSecurityScopeReceipt } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { StoragePort, UploadSecurityPort } from '../contract';
import type { SecurityPdfOcrProvider } from './pdf-ocr';
import { extractManagedDocument } from '~/files/documents/managed';
import { createSecurityTlsFixture } from './tls-fixture.helper';
import { createRawUploadBodyHandler } from '../transport/body';
import { observeSecurityProcess } from './process-observer';
import { createHttpUploadSecurityPort } from './transport';
import { createUploadManagement } from '../management';
import { startSecurityService } from './service';
import { createSecurityWorker } from './worker';

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
    for (const name of ['User', 'File', 'Message', 'UploadOperation', 'UploadCounter'])
      if (db.models[name]) await db.models[name].deleteMany({});
    await db.models.User.create({
      _id: principal.userId,
      tenantId: principal.tenantId,
      email: 'scanner-flow@example.test',
      emailVerified: true,
    });
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

  /** Same raw/scanner path; only the ordinary storage byte effect is a local fixture. */
  async function ingestDerivedFlow(id: string, bytes: Buffer, security: UploadSecurityPort = port) {
    const put = jest.fn(async (input: Parameters<StoragePort['put']>[0]) => {
      expect(input.securityApproval).toMatchObject({
        decision: 'approved',
        subject: {
          operationId: id,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      });
      expect(await observer.models.File.countDocuments({ file_id: id })).toBe(0);
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        input.signal.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
      await writeFile(path.join(ordinaryRoot, id), Buffer.concat(chunks), {
        flag: 'wx',
        mode: 0o600,
      });
      return {
        outcome: 'durable' as const,
        source: 's3',
        bytes: input.bytes,
        integrity: input.integrity,
        filepath: `/api/files/managed/${id}`,
        storageKey: `t/${input.lease.tenantId}/managed-uploads/${input.lease.userId}/${id}.${input.lease.generation}__original`,
      };
    });
    const request = Object.assign(new PassThrough(), {
      params: { id },
      body: undefined,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(bytes.length),
        'x-upload-filename': encodeURIComponent('Abgeleiteter Entwurf.txt'),
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
      storage: { put },
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
    expect(await readdir(stagingRoot)).toEqual([]);
    return { response, put };
  }

  function document(): Buffer {
    const stream = 'BT /F1 10 Tf 10 50 Td (Synthetic source) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let text = '%PDF-1.4\n';
    const offsets = [0];
    for (const [i, item] of objects.entries()) {
      offsets.push(Buffer.byteLength(text));
      text += `${i + 1} 0 obj\n${item}\nendobj\n`;
    }
    const offset = Buffer.byteLength(text);
    text +=
      `xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
        .join('');
    return Buffer.from(
      text + `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
    );
  }
  it.each(['approved', 'lost-bind-ack', 'unknown-retirement'])(
    'keeps native PDF %s behind original Mongo binding and full scope retirement',
    async (mode) => {
      const bytes = document();
      const operation = await management.reserve(principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'application/pdf',
        declaredBytes: bytes.length,
      });
      let execution: UploadSecurityExecution | undefined;
      let pages = 0;
      let retired = mode !== 'unknown-retirement';
      const receipt = (): UploadSecurityScopeReceipt | null =>
        execution?.custody.kind === 'pdf-ocr' && retired
          ? {
              version: 1,
              scope: execution.custody.scope,
              state: 'retired',
              writerStopped: true,
              transientDataRemoved: true,
              dispatchedPages: Array.from({ length: pages }, (_, index) => index + 1),
            }
          : null;
      const provider: SecurityPdfOcrProvider = {
        async prepare(input) {
          expect(
            await observer.models.UploadOperation.findById(operation.id).lean(),
          ).not.toHaveProperty('securityExecution');
          execution = {
            ...input.execution,
            custody: {
              kind: 'pdf-ocr',
              scope: {
                version: 1,
                scopeId: 'scope-fixture',
                attemptId: input.execution.attemptId,
                scannerInstanceId: input.execution.instanceId,
                scannerExecutionId: input.execution.executionId,
                expiresAt: input.execution.expiresAt,
                documentSha256: input.subject.sha256,
                pageLimit: 32,
                requestIdScheme: 'cortex-ocr-page-sha256-v1',
                workDeadline: input.workDeadline,
                cleanupDeadline: input.cleanupDeadline,
                providerBinding: {
                  podUid: 'pod-fixture',
                  containerId: 'a'.repeat(64),
                  runtimeImage: 'registry.invalid/ocr@sha256:' + 'b'.repeat(64),
                  sourceManifestSha256: 'c'.repeat(64),
                  modelRevision: 'aaa02f3811945a91062062994c5c4a3f4c0af2b0',
                  profileSha256: 'd'.repeat(64),
                  apiIncarnation: 'api-fixture',
                  engineIncarnation: 'engine-fixture',
                  workerIncarnation: 'worker-fixture',
                },
              },
            },
          };
          return execution;
        },
        open: () => ({
          async readPage() {
            const row = await observer.models.UploadOperation.findById(operation.id).lean();
            expect(row).toMatchObject({ securityExecution: execution });
            expect(row).not.toHaveProperty('original');
            expect(await observer.models.File.countDocuments({ file_id: operation.id })).toBe(0);
            pages++;
            return { complete: true, readable: true, text: 'Synthetic readable text' };
          },
          close: async () => receipt(),
          cancel: async () => receipt(),
          localCopiesRemoved: () => true,
        }),
      };
      const launcher = {
        run: jest.fn(
          async (
            input: Parameters<
              NonNullable<Parameters<typeof createSecurityWorker>[0]['pdf']>['launcher']['run']
            >[0],
          ) => {
            const child = spawn(
              process.execPath,
              [path.resolve(__dirname, '../../../dist/uploads/security/pdf-child.cjs')],
              {
                stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
                env: { NODE_ENV: 'test' },
              },
            );
            const joined = new Promise<void>((resolve) => child.once('close', () => resolve()));
            try {
              return await observeSecurityProcess({ child, ...input });
            } finally {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              await joined;
            }
          },
        ),
      };
      const scanner = createSecurityWorker({
        instanceId: randomUUID(),
        policy: JSON.parse(policyBytes.toString()),
        policySha256,
        threadPath: serviceOptions.threadPath,
        pdf: { provider, launcher },
      });
      const bind = repository.bindSecurityExecution.bind(repository);
      const lost =
        mode === 'lost-bind-ack'
          ? jest
              .spyOn(repository, 'bindSecurityExecution')
              .mockImplementationOnce(async (...args) => {
                await bind(...args);
                throw new Error('fixture-lost-bind-ack');
              })
          : undefined;
      try {
        const result = await ingestDerivedFlow(operation.id, bytes, scanner);
        const row = await observer.models.UploadOperation.findById(operation.id).lean();
        expect(row).toMatchObject({ securityExecution: execution });
        if (mode === 'approved') {
          expect(result.response.statusCode).toBe(202);
          expect(result.put).toHaveBeenCalledTimes(1);
          expect(row).toMatchObject({
            securitySettlement: { providerReceipt: { state: 'retired', dispatchedPages: [1] } },
          });
          expect(pages).toBe(1);
        } else {
          expect(result.response.statusCode).toBe(422);
          expect(result.put).not.toHaveBeenCalled();
          expect(await observer.models.File.countDocuments({ file_id: operation.id })).toBe(0);
          if (mode === 'lost-bind-ack') {
            expect(pages).toBe(0);
            expect(launcher.run).not.toHaveBeenCalled();
          } else {
            expect(row).not.toHaveProperty('securitySettlement');
            expect(row).toMatchObject({ stagingHeld: true });
          }
        }
      } finally {
        lost?.mockRestore();
        retired = true;
        expect((await scanner.close(AbortSignal.timeout(5000))).complete).toBe(true);
      }
    },
  );

  async function publishDerivedFlow(id: string) {
    const lease = await management.claimProcessing(worker);
    expect(lease?.operationId).toBe(id);
    const input = await management.getProcessingInput(lease!);
    expect(input.securityApproval.subject.operationId).toBe(id);
    // This receipt represents the joined in-process extractor below, not an isolated parser job.
    await management.bindProcessingExecution(lease!, {
      attemptId: `${id}.${lease!.generation}`,
      instanceId: 'flow-inline-extractor',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const { text, structure } = await extractManagedDocument({
      filePath: path.join(ordinaryRoot, id),
      mediaType: 'text/plain',
    });
    await management.publish(lease!, { text, structure, writerStopped: true });
    await management.confirmCleanup({
      operationId: id,
      generation: lease!.generation,
      writerStopped: true,
      localCopiesAbsent: true,
      originalAbsent: false,
      textAndHistoryRemoved: false,
    });
    return management.get(principal, id);
  }

  it.each(['approved', 'marked'] as const)(
    'keeps native derived %s bytes behind the same real scanner and source lifecycle',
    async (decision) => {
      const sourceBytes = Buffer.from('Unmarkierter Quellentext für den abgeleiteten Entwurf.');
      const source = await management.reserve(principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: sourceBytes.length,
      });
      const uploadedSource = await ingestDerivedFlow(source.id, sourceBytes);
      expect(uploadedSource.response.statusCode).toBe(202);
      const readySource = await publishDerivedFlow(source.id);
      expect(readySource).toMatchObject({ state: 'ready', canUseInComposer: true });
      const sourceFile = await observer.models.File.findOne({ file_id: source.id })
        .select('+securityApproval')
        .lean<IMongoFile>();
      expect(sourceFile).toMatchObject({ status: 'ready', text: sourceBytes.toString('utf8') });

      const bytes = Buffer.from(
        decision === 'marked'
          ? 'Einstufung: VS-VERTRAULICH\nNeu erzeugter Entwurf.'
          : 'Abgeleiteter Entwurf aus einer freigegebenen Quelle.',
      );
      const derived = await management.reserveDerived(principal, {
        idempotencyKey: randomUUID(),
        mediaType: 'text/plain',
        declaredBytes: bytes.length,
        derived: {
          binding: { purpose: 'workspace-draft', sourceId: 'flow-draft', sourceRevision: 1 },
          directSourceFileIds: [source.id],
        },
      });
      const captured = await observer.models.UploadOperation.findById(derived.id).lean<{
        derivedOrigin?: UploadDerivedOrigin;
      }>();
      expect(captured?.derivedOrigin).toMatchObject({
        version: 1,
        directSourceFileIds: [source.id],
        ancestors: [
          {
            subject: sourceFile!.securityApproval!.subject,
            policySha256,
            expiresAt: Date.parse(readySource.expiresAt!),
          },
        ],
      });
      const received = await ingestDerivedFlow(derived.id, bytes);
      const stored = await observer.models.UploadOperation.findById(derived.id).lean<{
        securityApproval?: UploadSecurityApproval;
      }>();
      expect(stored).toMatchObject({
        derivedOrigin: captured!.derivedOrigin,
        securitySettlement: { writerStopped: true, transientDataRemoved: true },
        stagingHeld: false,
        cleanupPending: false,
      });
      if (decision === 'marked') {
        expect(received.response.statusCode).toBe(422);
        expect(received.response.value).toEqual({ code: 'security_rejected' });
        expect(received.put).not.toHaveBeenCalled();
        expect(stored).not.toHaveProperty('securityApproval');
        expect(stored).not.toHaveProperty('original');
        expect(await observer.models.File.findOne({ file_id: derived.id })).toBeNull();
        expect(await readdir(ordinaryRoot)).toEqual([source.id]);
        expect(await management.claimProcessing(worker)).toBeNull();
      } else {
        expect(received.response.statusCode).toBe(202);
        expect(received.put).toHaveBeenCalledTimes(1);
        expect(await readFile(path.join(ordinaryRoot, derived.id))).toEqual(bytes);
        expect(stored?.securityApproval).toMatchObject({
          scannerVersion: 'complete-content-v4',
          subject: {
            operationId: derived.id,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
        });
        const ready = await publishDerivedFlow(derived.id);
        expect(ready).toMatchObject({
          state: 'ready',
          canUseInComposer: false,
          expiresAt: readySource.expiresAt,
        });
        expect(Date.parse(ready.acceptedAt!) + UPLOAD_RETENTION_MS).toBeGreaterThan(
          Date.parse(ready.expiresAt!),
        );
        const file = await observer.models.File.findOne({ file_id: derived.id })
          .select('+derivedOrigin')
          .lean();
        expect(file).toMatchObject({
          status: 'ready',
          text: bytes.toString('utf8'),
          derivedOrigin: captured!.derivedOrigin,
          expiredAt: new Date(ready.expiresAt!),
        });
        expect(
          await observer.models.File.findOne({ file_id: derived.id }).lean(),
        ).not.toHaveProperty('derivedOrigin');
      }
      const publicOperations = await management.list(principal);
      for (const operation of publicOperations) {
        expect(operation).not.toHaveProperty('derivedOrigin');
        expect(operation).not.toHaveProperty('securityApproval');
      }
      expect(await management.get(principal, source.id)).toEqual(readySource);
      expect(await readFile(path.join(ordinaryRoot, source.id))).toEqual(sourceBytes);
      expect(
        await observer.models.File.findOne({ file_id: source.id })
          .select('+securityApproval')
          .lean(),
      ).toMatchObject({
        status: 'ready',
        securityApproval: sourceFile!.securityApproval,
        text: sourceBytes.toString('utf8'),
        expiredAt: sourceFile!.expiredAt,
      });
    },
    30_000,
  );

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
          const binding = { execution: input.execution, stored: await readOperation() };
          bindings.push(binding);
          expect(binding.stored).not.toHaveProperty('filename');
          expect(JSON.stringify(binding.stored)).not.toContain('Cortex-TEST-Privat');
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
          scannerVersion: 'complete-content-v4',
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
