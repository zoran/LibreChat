/** Actual native grants, Mongo, HTTP Intake, mTLS Control and scanner thread; ordinary storage is a local-byte fixture. */
import path from 'node:path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import {
  createEmailCodeMethods,
  createModels,
  createUploadManagementRepository,
} from '@librechat/data-schemas';
import type {
  UploadIntakeGrant,
  UploadPromotionRecord,
  UploadLease,
  UploadSecuritySettlement,
  UploadSecurityApproval,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { StoragePort } from '../contract';
import type { IntakeChannel } from './channel';
import { createIntakeChannel, startIntakeControlService } from './channel';
import { createSecurityTlsFixture } from '../security/tls-fixture.helper';
import { createHttpUploadSecurityPort } from '../security/transport';
import { createEmailCodeUploadGrant } from '~/auth/emailCode';
import { startSecurityService } from '../security/service';
import { createUploadAttemptJournal } from '../attempts';
import { createIntakeControlHandlers } from './control';
import { createUploadManagement } from '../management';
import { startIntakeService } from './service';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const intakeWorker = { hostId: 'intake-host', instanceId: 'intake-flow' };
const appWorker = { hostId: 'app-host', instanceId: 'app-flow' };
const origin = 'https://intake.example.test';
const tenantId = 'intake-flow';
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
const policySha256 = digest(policyBytes);

describe('isolated Intake through native authority, scanner and App promotion', () => {
  const db = new mongoose.Mongoose();
  const observer = new mongoose.Mongoose();
  const environment = {
    AUTH_MODE: 'email_code',
    EMAIL_CODE_TENANT_ID: tenantId,
    EMAIL_CODE_ALLOWED_DOMAINS: 'employees.example.test',
    EMAIL_CODE_POLICY_VERSION: '1',
    EMAIL_CODE_HMAC_KEY: 'synthetic-flow-hmac-key-'.repeat(3),
    JWT_SECRET: 'synthetic-flow-jwt-secret',
  };
  const previous = Object.fromEntries(
    Object.keys(environment).map((key) => [key, process.env[key]]),
  );
  let mongo: MongoMemoryReplSet | undefined;
  let tls: ReturnType<typeof createSecurityTlsFixture> | undefined;
  let scanner: Awaited<ReturnType<typeof startSecurityService>> | undefined;
  let control: Awaited<ReturnType<typeof startIntakeControlService>> | undefined;
  let intake: Awaited<ReturnType<typeof startIntakeService>> | undefined;
  let journal: ReturnType<typeof createUploadAttemptJournal>;
  let repository: ReturnType<typeof createUploadManagementRepository>;
  let identity: ReturnType<typeof createEmailCodeMethods>;
  let management: ReturnType<typeof createUploadManagement>;
  let channel: IntakeChannel;
  let ordinaryPut: jest.MockedFunction<StoragePort['put']>;
  let root: string;
  let stagingRoot: string;
  let ordinaryRoot: string;
  let grant: UploadIntakeGrant;
  let cancelBeforePromotion: boolean;
  let expectedCompleteDrain: boolean;
  let promotionLease: UploadLease | undefined;
  const certificate = (name: string) => readFile(path.join(tls!.directory, name));
  const stored = (id: string) =>
    observer.models.UploadOperation.findById(id).lean<{
      state: string;
      securitySettlement?: UploadSecuritySettlement;
      securityApproval?: UploadSecurityApproval;
      promotion?: UploadPromotionRecord;
    }>();

  beforeAll(async () => {
    Object.assign(process.env, environment);
    if (!process.env.UPLOAD_TEST_TMPDIR)
      throw new Error('Explicit isolated upload test directory required');
    const threadPath = path.resolve(__dirname, '../../../dist/uploads/security/worker-thread.cjs');
    await stat(threadPath);
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(path.join(process.env.UPLOAD_TEST_TMPDIR, 'intake-composed-'));
    stagingRoot = path.join(root, 'intake-staging');
    ordinaryRoot = path.join(root, 'ordinary-byte-storage-fixture');
    await Promise.all([mkdir(stagingRoot, { mode: 0o700 }), mkdir(ordinaryRoot, { mode: 0o700 })]);
    tls = createSecurityTlsFixture();
    scanner = await startSecurityService({
      instanceId: '11111111-1111-4111-8111-111111111111',
      policyBytes,
      policySha256,
      threadPath,
      host: '127.0.0.1',
      port: 0,
      tls: {
        ca: await certificate('ca.pem'),
        cert: await certificate('server.pem'),
        key: await certificate('server.key'),
      },
    });
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await Promise.all([
      db.connect(mongo.getUri('composed')),
      observer.connect(mongo.getUri('composed')),
    ]);
    createModels(db);
    createModels(observer);
    await Promise.all([
      db.models.File.init(),
      db.models.User.init(),
      db.models.Session.init(),
      observer.models.File.init(),
    ]);
    identity = createEmailCodeMethods(observer);
  }, 30_000);

  async function nativeGrant(): Promise<UploadIntakeGrant> {
    const userId = new mongoose.Types.ObjectId();
    const sessionId = new mongoose.Types.ObjectId();
    const now = Date.now();
    // Synthetic authentication setup; native grant issuance and live Mongo identity reads remain real.
    await db.models.User.create({
      _id: userId,
      tenantId,
      email: `${userId}@employees.example.test`,
      provider: 'email_code',
      emailVerified: true,
      authVersion: 0,
    });
    await db.models.Session.create({
      _id: sessionId,
      user: userId,
      tenantId,
      authMethod: 'email_code',
      authPolicyVersion: 1,
      authVersion: 0,
      refreshGeneration: 0,
      authCreatedAt: new Date(now),
      idleExpiresAt: new Date(now + 600_000),
      expiration: new Date(now + 600_000),
      refreshTokenHash: digest(randomBytes(32)),
    });
    const token = jwt.sign(
      {
        id: String(userId),
        sessionId: String(sessionId),
        tenantId,
        authMethod: 'email_code',
        authVersion: 0,
        policyVersion: 1,
        generation: 0,
        issuedAtMs: now,
        tokenUse: 'access',
      },
      environment.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: 300 },
    );
    const verified = jwt.verify(token, environment.JWT_SECRET, { algorithms: ['HS256'] });
    const issued = await createEmailCodeUploadGrant(verified, identity);
    if (!issued) throw new Error('Native fixture grant unavailable');
    return issued;
  }

  beforeEach(async () => {
    for (const name of ['File', 'Message', 'UploadOperation', 'UploadCounter', 'Session', 'User'])
      if (db.models[name]) await db.models[name].deleteMany({});
    for (const name of await readdir(ordinaryRoot)) await rm(path.join(ordinaryRoot, name));
    cancelBeforePromotion = false;
    expectedCompleteDrain = true;
    promotionLease = undefined;
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
    grant = await nativeGrant();
    // Resource admission is a trusted fixture; this suite does not qualify host capacity or namespaces.
    const resources = {
      assertSafe: async () => {
        await stat(stagingRoot);
      },
    };
    management = createUploadManagement({
      repository,
      resources,
      identity: {
        authorize: async (owner, scope) =>
          owner.tenantId === tenantId &&
          owner.authentication === 'verified-email' &&
          scope.kind === 'personal',
      },
    });
    journal = createUploadAttemptJournal(appWorker);
    ordinaryPut = jest.fn(async (input): Promise<UploadStorageReceipt> => {
      // This is the first ordinary document consumer. All authority is observed through a separate Mongo connection.
      assert.equal(await observer.models.File.countDocuments({}), 0);
      const row = await stored(input.lease.operationId);
      assert.equal(row?.state, 'transferring');
      assert.equal(row?.securitySettlement?.writerStopped, true);
      assert.equal(row?.securitySettlement?.transientDataRemoved, true);
      assert.equal(row?.promotion?.state, 'writing');
      assert.equal(row?.promotion?.writerStopped, false);
      assert.equal(row?.promotion?.worker.hostId, appWorker.hostId);
      assert.equal(row?.promotion?.worker.instanceId, appWorker.instanceId);
      assert.equal(row?.promotion?.approval.decision, 'approved');
      assert.equal(row?.promotion?.approval.policySha256, policySha256);
      assert.equal(input.securityApproval?.decision, 'approved');
      assert.equal(input.securityApproval?.policySha256, policySha256);
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        input.signal.throwIfAborted();
        chunks.push(Buffer.from(chunk));
      }
      await writeFile(path.join(ordinaryRoot, input.lease.operationId), Buffer.concat(chunks), {
        flag: 'wx',
        mode: 0o600,
      });
      return {
        outcome: 'durable',
        source: 's3',
        bytes: input.bytes,
        integrity: input.integrity,
        filepath: `/api/files/download/${input.lease.operationId}`,
        storageKey: `t/${input.lease.tenantId}/managed-uploads/${input.lease.userId}/${input.lease.operationId}.${input.lease.generation}__original`,
      };
    });
    const handlers = createIntakeControlHandlers({
      repository,
      identityRepository: identity,
      management,
      resources,
      storage: { put: ordinaryPut },
      attempts: journal.attempts,
      worker: appWorker,
    });
    control = await startIntakeControlService({
      handlers,
      host: '127.0.0.1',
      port: 0,
      deadlineMs: 15_000,
      tls: {
        ca: await certificate('ca.pem'),
        cert: await certificate('server.pem'),
        key: await certificate('server.key'),
      },
      peers: [
        {
          certificateSha256: new X509Certificate(await certificate('client.pem')).fingerprint256
            .replaceAll(':', '')
            .toLowerCase(),
          worker: intakeWorker,
        },
      ],
    });
    channel = createIntakeChannel({
      endpoint: `https://127.0.0.1:${control.address.port}`,
      allowedHosts: ['127.0.0.1'],
      tls: {
        ca: await certificate('ca.pem'),
        cert: await certificate('client.pem'),
        key: await certificate('client.key'),
      },
    });
    const observedChannel: IntakeChannel = {
      async control(input) {
        if ((input.command as { action?: string })?.action === 'prepare-promotion') {
          promotionLease = (input.command as { input: { lease: UploadLease } }).input.lease;
          if (cancelBeforePromotion) await management.cancel(grant.principal, input.operationId);
        }
        return channel.control(input);
      },
      promote: (input) => channel.promote(input),
    };
    intake = await startIntakeService({
      channel: observedChannel,
      security: createHttpUploadSecurityPort({
        endpoint: `https://127.0.0.1:${scanner!.address.port}`,
        allowedHosts: ['127.0.0.1'],
        policySha256,
        tls: {
          ca: await certificate('ca.pem'),
          cert: await certificate('client.pem'),
          key: await certificate('client.key'),
        },
      }),
      worker: intakeWorker,
      stagingRoot,
      allowedOrigins: [origin],
      host: '127.0.0.1',
      port: 0,
      deadlineMs: 15_000,
    });
  }, 20_000);

  afterEach(async () => {
    const raw = await intake?.close(AbortSignal.timeout(5_000));
    intake = undefined;
    const app = await control?.close(AbortSignal.timeout(5_000));
    control = undefined;
    const attempts = await journal?.close(AbortSignal.timeout(5_000));
    assert.equal(app?.complete, true);
    assert.equal(attempts?.complete, true);
    assert.equal(raw?.complete, expectedCompleteDrain);
    assert.equal((await readdir(stagingRoot)).length, 0);
  }, 20_000);

  afterAll(async () => {
    try {
      if (scanner) assert.equal((await scanner.close(AbortSignal.timeout(10_000))).complete, true);
    } finally {
      try {
        await Promise.all([db.disconnect(), observer.disconnect()]);
      } finally {
        await mongo?.stop();
        tls?.close();
        if (root) await rm(root, { recursive: true, force: true });
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    }
  }, 30_000);

  async function ticket(bytes: Buffer, owner = grant) {
    const operation = await management.reserve(owner.principal, {
      idempotencyKey: randomUUID(),
      mediaType: 'text/plain',
      declaredBytes: bytes.length,
    });
    const capability = randomBytes(32).toString('base64url');
    await repository.issueIntake(
      owner.principal,
      operation.id,
      digest(capability),
      owner,
      Date.now(),
    );
    return { operationId: operation.id, capability };
  }

  function submit(
    input: { operationId: string; capability: string },
    bytes: Buffer,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: intake!.address.port,
          path: `/api/uploads/operations/${input.operationId}/body`,
          method: 'PUT',
          signal: AbortSignal.timeout(20_000),
          headers: {
            Origin: origin,
            'Content-Type': 'application/octet-stream',
            'Content-Length': bytes.length,
            'X-Upload-Capability': input.capability,
            'X-Upload-Filename': encodeURIComponent('Freigegebener Testtext.txt'),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          res.on('error', reject);
          res.on('end', () => {
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
      req.end(bytes);
    });
  }

  async function noOrdinaryContent() {
    expect(ordinaryPut).not.toHaveBeenCalled();
    expect(await readdir(ordinaryRoot)).toEqual([]);
    expect(await observer.models.File.countDocuments({})).toBe(0);
  }

  it('accepts actual scanned bytes once, and rejects body replay and duplicate promotion without another source read', async () => {
    const bytes = Buffer.from('Freigegebener überprüfbarer Text.');
    const issued = await ticket(bytes);
    const response = await submit(issued, bytes);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ id: issued.operationId, state: 'queued_processing' });
    expect(ordinaryPut).toHaveBeenCalledTimes(1);
    expect(await readFile(path.join(ordinaryRoot, issued.operationId))).toEqual(bytes);
    const row = await stored(issued.operationId);
    expect(row).toMatchObject({
      promotion: { state: 'settled', writerStopped: true, worker: appWorker },
      securityApproval: { scannerVersion: 'txt-worker-v1' },
    });
    expect(
      await observer.models.File.findOne({ file_id: issued.operationId })
        .select('+securityApproval')
        .lean(),
    ).toMatchObject({
      securityApproval: { decision: 'approved', policySha256 },
      filename: 'Freigegebener Testtext.txt',
    });
    expect(JSON.stringify(response.body)).not.toContain(issued.capability);
    const replay = await submit(issued, bytes);
    expect(replay.status).toBeGreaterThanOrEqual(400);
    const promotion = row!.promotion as UploadPromotionRecord;
    const consumed = jest.fn();
    await expect(
      channel.promote({
        ...issued,
        promotionId: promotion.promotionId,
        bytes: bytes.length,
        integrity: promotion.integrity,
        body: (async function* () {
          consumed();
          yield bytes;
        })(),
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toBeDefined();
    expect(consumed).not.toHaveBeenCalled();
    expect(ordinaryPut).toHaveBeenCalledTimes(1);
    expect(await observer.models.File.countDocuments({})).toBe(1);
  }, 30_000);

  it.each([
    [Buffer.from('Einstufung: VS-VERTRAULICH'), 'security_rejected'],
    [Buffer.from([0xc3, 0x28]), 'security_uninspectable'],
  ])(
    'keeps scanner rejection %s outside App storage and File',
    async (bytes, code) => {
      const issued = await ticket(bytes as Buffer);
      const response = await submit(issued, bytes as Buffer);
      expect(response).toEqual({ status: 422, body: { code } });
      await noOrdinaryContent();
      expect(await stored(issued.operationId)).toMatchObject({
        securitySettlement: { writerStopped: true, transientDataRemoved: true },
      });
      expect(await stored(issued.operationId)).not.toHaveProperty('promotion');
    },
    30_000,
  );

  it('rejects forged capabilities, cross-owner operation binding and caller-supplied principals', async () => {
    const bytes = Buffer.from('Ungeprüfter Eingang.');
    const issued = await ticket(bytes);
    const other = await ticket(bytes, await nativeGrant());
    for (const forged of [
      { ...issued, capability: randomBytes(32).toString('base64url') },
      { ...issued, capability: other.capability },
    ]) {
      const response = await submit(forged, bytes);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).toMatchObject({ code: 'unauthorized' });
    }
    await expect(
      channel.control({
        ...issued,
        command: {
          action: 'claim',
          principal: { ...grant.principal, userId: new mongoose.Types.ObjectId().toString() },
        },
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await noOrdinaryContent();
    expect(await stored(issued.operationId)).not.toHaveProperty('securityExecution');
  });

  it('rejects an issued capability after actual native session revocation', async () => {
    const bytes = Buffer.from('Keine Annahme nach Abmeldung.');
    const issued = await ticket(bytes);
    await identity.revokeEmailCodeSession(grant.sessionId, grant.principal.userId, tenantId);
    const response = await submit(issued, bytes);
    expect(response.body).toMatchObject({ code: 'unauthorized' });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await noOrdinaryContent();
  });

  it('refuses the old transfer lease after real cancellation before promotion', async () => {
    const bytes = Buffer.from('Zulässiger Text, dessen Vorgang abgebrochen wird.');
    const issued = await ticket(bytes);
    cancelBeforePromotion = true;
    expectedCompleteDrain = false; // A failed remote storage call without a receipt retains its unresolved journal entry.
    const response = await submit(issued, bytes);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(promotionLease).toBeDefined();
    await expect(
      channel.control({
        ...issued,
        command: { action: 'renew', lease: promotionLease },
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    await noOrdinaryContent();
    expect(await stored(issued.operationId)).not.toHaveProperty('promotion');
  }, 30_000);
});
