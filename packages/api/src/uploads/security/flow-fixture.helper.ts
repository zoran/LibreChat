/** flow-fixture.helper.ts owns isolated Mongo/TLS/raw-byte setup and cleanup; AV remains inert. */
import path from 'node:path';
import mongoose from 'mongoose';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash, X509Certificate } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { readUploadOriginalWriteBinding } from 'librechat-data-provider';
import { createModels, createUploadManagementRepository } from '@librechat/data-schemas';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import type { Request, Response } from 'express';
import type { StoragePort, UploadSecurityPort } from '../contract';
import { createInertAntivirusFixture } from './antivirus-fixture.helper';
import { createSecurityTlsFixture } from './tls-fixture.helper';
import { createRawUploadBodyHandler } from '../transport/body';
import { createHttpUploadSecurityPort } from './transport';
import { createUploadManagement } from '../management';
import { startSecurityService } from './service';
export function createSecurityFlowFixture() {
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
      antivirus: createInertAntivirusFixture().runtime,
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
  }, 30000);
  beforeEach(async () => {
    for (const name of [
      'User',
      'File',
      'Message',
      'UploadOperation',
      'UploadCounter',
      'HousekeepingJob',
      'FileReadReceipt',
    ])
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
        authorize: async (owner, request) =>
          owner.tenantId === principal.tenantId &&
          owner.userId === principal.userId &&
          owner.authentication === principal.authentication &&
          request.owner.scope.kind === 'personal' &&
          'ownerUserId' in request.owner &&
          request.owner.ownerUserId === owner.userId &&
          request.owner.tenantId === owner.tenantId,
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
      if (service) complete = (await service.close(AbortSignal.timeout(10000))).complete;
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
  }, 30000);
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
      expect(input.lease.operationId).toBe(id);
      const storageKey = `t/${input.lease.tenantId}/managed-uploads/${input.lease.userId}/${input.lease.operationId}.${input.lease.generation}__original`;
      const proposal = {
        bucket: 'fixture-security-originals',
        key: storageKey,
        operationId: input.lease.operationId,
        generation: String(input.lease.generation),
        bytes: input.bytes,
        wholeSHA256: input.integrity.sha256,
        mediaType: input.mediaType,
      };
      // Match the real S3 adapter: persist the exact original before consuming body bytes.
      expect(typeof input.bindWrite).toBe('function');
      const binding = { ...(await input.bindWrite(proposal)) };
      expect(readUploadOriginalWriteBinding(binding)).toEqual(binding);
      expect(binding).toEqual({
        version: 1,
        ...proposal,
        originalDeadline: binding.originalDeadline,
      });
      expect(Date.parse(binding.originalDeadline)).toBeGreaterThan(Date.now());
      const persisted = await observer.models.UploadOperation.findById(id).lean<{
        writeBinding?: unknown;
      }>();
      expect(persisted).toHaveProperty('writeBinding');
      expect(readUploadOriginalWriteBinding(Object.assign({}, persisted?.writeBinding))).toEqual(
        binding,
      );
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
        storageKey,
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
      deadlineMs: 15000,
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
  return {
    get db() {
      return db;
    },
    get observer() {
      return observer;
    },
    get service() {
      return service;
    },
    get serviceOptions() {
      return serviceOptions;
    },
    get port() {
      return port;
    },
    get repository() {
      return repository;
    },
    get management() {
      return management;
    },
    get root() {
      return root;
    },
    get stagingRoot() {
      return stagingRoot;
    },
    get ordinaryRoot() {
      return ordinaryRoot;
    },
    get policyBytes() {
      return policyBytes;
    },
    get policySha256() {
      return policySha256;
    },
    get principal() {
      return principal;
    },
    get worker() {
      return worker;
    },
    get ingestDerivedFlow() {
      return ingestDerivedFlow;
    },
    get document() {
      return document;
    },
  };
}
