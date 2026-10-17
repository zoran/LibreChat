/** Actual native grants, Mongo, HTTP Intake, mTLS Control, resource guards and scanner thread; cgroup files and ordinary byte storage are fixtures. */
import path from 'node:path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { request } from 'node:http';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { readUploadIntakeRecovery } from 'librechat-data-provider';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import {
  createEmailCodeMethods,
  createModels,
  createUploadManagementRepository,
} from '@librechat/data-schemas';
import type {
  UploadWorker,
  UploadIntakeGrant,
  UploadPromotionRecord,
  UploadLease,
  UploadSecuritySettlement,
  UploadSecurityApproval,
  UploadStorageReceipt,
} from 'librechat-data-provider';
import type { ResourcePort, StoragePort } from '../contract';
import type { IntakeChannel } from './channel';
import {
  LOCAL_FLOOR_BYTES,
  LOCAL_POOL_BYTES,
  measureUploadDirectory,
  uploadLocalReservation,
} from '../platform/local';
import { createIntakeChannel, startIntakeControlService } from './channel';
import { createSecurityTlsFixture } from '../security/tls-fixture.helper';
import { createHttpUploadSecurityPort } from '../security/transport';
import { createUploadResourcePort } from '../control/hardGuards';
import { createMaintenanceIdentity } from '../../app/identity';
import { createEmailCodeUploadGrant } from '~/auth/emailCode';
import { startSecurityService } from '../security/service';
import { createUploadAttemptJournal } from '../attempts';
import { createIntakeControlHandlers } from './control';
import { createUploadManagement } from '../management';
import { startIntakeService } from './service';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const intakeEnvironment = {
  POD_UID: '11111111-1111-4111-8111-111111111111',
  BUILD_COMMIT: 'a'.repeat(40),
};
// Real native identity creation; the synthetic Pod describes trusted test composition, not Pod attestation.
const intakeWorker = {
  hostId: 'intake-host',
  instanceId: createMaintenanceIdentity(intakeEnvironment, true).incarnation,
};
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
  let appResources: ResourcePort;
  let channel: IntakeChannel;
  let ordinaryPut: jest.MockedFunction<StoragePort['put']>;
  let root: string;
  let stagingRoot: string;
  let appStagingRoot: string;
  let intakeCgroupDirectory: string;
  let appCgroupDirectory: string;
  let ordinaryRoot: string;
  let grant: UploadIntakeGrant;
  let cancelBeforePromotion: boolean;
  let revokeAfterClaim: boolean;
  let losePromotionReply: boolean;
  let unknownStorageOutcome: boolean;
  let loseFirstRecoveryRequest: boolean;
  let recoveryRequests: number;
  let lostReplies: number;
  let ordinaryBytes: number;
  let receivedBytes: number;
  let renewals: UploadLease[];
  let onRenew: (() => void) | undefined;
  let expectedCompleteDrain: boolean;
  let expectedAppDrain: boolean;
  let intakeDrain: { complete: boolean } | undefined;
  let claimedLease: UploadLease | undefined;
  let promotionLease: UploadLease | undefined;
  const certificate = (name: string) => readFile(path.join(tls!.directory, name));
  const clientFor = async (worker: UploadWorker) =>
    createIntakeChannel({
      endpoint: `https://127.0.0.1:${control!.address.port}`,
      allowedHosts: ['127.0.0.1'],
      worker,
      tls: {
        ca: await certificate('ca.pem'),
        cert: await certificate('client.pem'),
        key: await certificate('client.key'),
      },
    });
  const stored = (id: string) =>
    observer.models.UploadOperation.findById(id).lean<{
      state: string;
      securitySettlement?: UploadSecuritySettlement;
      securityApproval?: UploadSecurityApproval;
      promotion?: UploadPromotionRecord;
      intake?: { closed?: boolean; cleanupAcknowledged?: boolean };
      writerStopped?: boolean;
      cleanupPending: boolean;
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
    appStagingRoot = path.join(root, 'app-staging');
    intakeCgroupDirectory = path.join(root, 'intake-cgroup-fixture');
    appCgroupDirectory = path.join(root, 'app-cgroup-fixture');
    ordinaryRoot = path.join(root, 'ordinary-byte-storage-fixture');
    await Promise.all(
      [stagingRoot, appStagingRoot, intakeCgroupDirectory, appCgroupDirectory, ordinaryRoot].map(
        (directory) => mkdir(directory, { mode: 0o700 }),
      ),
    );
    tls = createSecurityTlsFixture();
    scanner = await startSecurityService({
      instanceId: '11111111-1111-4111-8111-111111111111',
      policyBytes,
      policySha256,
      threadPath,
      peers: [
        {
          certificateSha256: digest(new X509Certificate(await certificate('client.pem')).raw),
          role: 'intake',
        },
      ],
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
    // Two synthetic cgroups model independent limits; both guards read the real files and mounts.
    for (const directory of [intakeCgroupDirectory, appCgroupDirectory]) {
      await writeFile(path.join(directory, 'memory.current'), '33554432\n');
      await writeFile(path.join(directory, 'memory.max'), '1073741824\n');
    }
    cancelBeforePromotion = false;
    revokeAfterClaim = losePromotionReply = unknownStorageOutcome = false;
    loseFirstRecoveryRequest = false;
    recoveryRequests = 0;
    lostReplies = ordinaryBytes = receivedBytes = 0;
    renewals = [];
    onRenew = undefined;
    expectedCompleteDrain = true;
    expectedAppDrain = true;
    intakeDrain = undefined;
    claimedLease = undefined;
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
    const clock = () => ({ nowMs: Date.now(), monotonicMs: performance.now() });
    appResources = createUploadResourcePort({
      cgroupDirectory: appCgroupDirectory,
      mounts: [
        {
          slot: 'staging',
          path: appStagingRoot,
          capacityBytes: LOCAL_POOL_BYTES,
          floorBytes: LOCAL_FLOOR_BYTES,
        },
      ],
      reservations: async (phase, lease) => {
        const held = await repository.localReservations(appWorker, Date.now());
        const disk = await measureUploadDirectory(appStagingRoot, clock);
        return {
          ...uploadLocalReservation({
            worker: appWorker,
            journal: held,
            disk,
            phase,
            lease,
            clock: clock(),
          }),
          observedAtMs: Math.min(held.observedAt, disk.observedAtMs),
        };
      },
      // Backend durability is a fixture; local resource measurements and worker matching are real.
      durability: async () => {
        const at = clock();
        return {
          state: 'safe',
          observedAtMs: at.nowMs,
          expiresAtMs: at.nowMs + 60_000,
          expiresMonotonicMs: at.monotonicMs + 60_000,
        };
      },
      clock,
    });
    management = createUploadManagement({
      repository,
      resources: appResources,
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
        ordinaryBytes += chunk.byteLength;
      }
      await writeFile(path.join(ordinaryRoot, input.lease.operationId), Buffer.concat(chunks), {
        flag: 'wx',
        mode: 0o600,
      });
      return {
        // The unknown variant models an unconfirmed remote PUT; it is never a stopped-writer proof.
        outcome: unknownStorageOutcome ? 'unknown' : 'durable',
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
      resources: appResources,
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
          role: 'intake',
          hostIds: [intakeWorker.hostId],
        },
      ],
    });
    channel = await clientFor(intakeWorker);
    const observedChannel: IntakeChannel = {
      async control(input) {
        if ((input.command as { action?: string })?.action === 'seal-recovery') {
          recoveryRequests += 1;
          if (loseFirstRecoveryRequest) {
            loseFirstRecoveryRequest = false;
            throw new Error('Synthetic loss of first technical recovery request');
          }
        }
        if ((input.command as { action?: string })?.action === 'prepare-promotion') {
          promotionLease = (input.command as { input: { lease: UploadLease } }).input.lease;
          if (cancelBeforePromotion) await management.cancel(grant.principal, input.operationId);
        }
        const result = await channel.control(input);
        if ((input.command as { action?: string })?.action === 'claim' && result !== null) {
          claimedLease = result as UploadLease;
          if (revokeAfterClaim)
            await identity.revokeEmailCodeSession(
              grant.sessionId,
              grant.principal.userId,
              tenantId,
            );
        }
        if ((input.command as { action?: string })?.action === 'renew') {
          renewals.push(result as UploadLease);
          onRenew?.();
        }
        return result;
      },
      async promote(input) {
        const result = await channel.promote(input);
        if (losePromotionReply) {
          // Fault injection discards only a completed real mTLS response, never App work or receipts.
          assert.equal((await stored(input.operationId))?.promotion?.state, 'settled');
          lostReplies += 1;
          throw new Error('Synthetic loss of successful promotion reply');
        }
        return result;
      },
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
      localResources: { cgroupDirectory: intakeCgroupDirectory, storage: 'disk' },
      allowedOrigins: [origin],
      host: '127.0.0.1',
      port: 0,
      deadlineMs: 15_000,
      observe: (event) => {
        if (event.kind === 'received') receivedBytes += event.bytes;
      },
    });
  }, 20_000);

  afterEach(async () => {
    const raw = intakeDrain ?? (await intake?.close(AbortSignal.timeout(5_000)));
    intake = undefined;
    const app = await control?.close(AbortSignal.timeout(5_000));
    control = undefined;
    const attempts = await journal?.close(AbortSignal.timeout(5_000));
    assert.equal(app?.complete, true);
    assert.equal(attempts?.complete, expectedAppDrain);
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
    finishAfter?: Promise<void>,
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
      if (finishAfter) {
        req.write(bytes.subarray(0, 1));
        void finishAfter.then(
          () => req.end(bytes.subarray(1)),
          (error) => req.destroy(error),
        );
      } else req.end(bytes);
    });
  }

  async function noOrdinaryContent() {
    expect(ordinaryPut).not.toHaveBeenCalled();
    expect(await readdir(ordinaryRoot)).toEqual([]);
    expect(await observer.models.File.countDocuments({})).toBe(0);
  }

  async function recovery(input: { operationId: string; capability: string }) {
    intakeDrain = await intake!.close(AbortSignal.timeout(5_000));
    const value = readUploadIntakeRecovery(
      await channel.control({
        ...input,
        command: { action: 'seal-recovery', transferGeneration: claimedLease!.generation },
        signal: AbortSignal.timeout(5_000),
      }),
    );
    expect(value).not.toBeNull();
    expect(value).toMatchObject({
      operationId: input.operationId,
      transferGeneration: claimedLease!.generation,
      worker: intakeWorker,
      closed: true,
    });
    return value!;
  }

  async function rejectsUserWork(input: { operationId: string; capability: string }) {
    const promotionId = (await stored(input.operationId))?.promotion?.promotionId ?? randomUUID();
    for (const command of [
      { action: 'claim' },
      { action: 'accept', lease: claimedLease, promotionId },
    ])
      await expect(
        channel.control({ ...input, command, signal: AbortSignal.timeout(5_000) }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
  }

  it('keeps separate Intake and App worker reservations valid through an actual five-second heartbeat', async () => {
    const bytes = Buffer.from('Freigegebener Text nach einem echten Intake-Heartbeat.');
    const issued = await ticket(bytes);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const renewed = new Promise<void>((resolve, reject) => {
      onRenew = resolve;
      timeout = setTimeout(
        () => reject(new Error('Actual Intake heartbeat was not renewed')),
        10_000,
      );
    });
    const started = performance.now();
    try {
      const finish = renewed.then(async () => {
        // This is the former failure path: an Intake lease cannot own App-local reservations.
        await expect(
          appResources.assertSafe({
            phase: 'transfer',
            hostId: intakeWorker.hostId,
            lease: claimedLease!,
          }),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(ordinaryPut).not.toHaveBeenCalled();
        expect(await observer.models.File.countDocuments({})).toBe(0);
      });
      const response = await submit(issued, bytes, finish);
      await finish;
      expect(performance.now() - started).toBeGreaterThanOrEqual(5_000);
      expect(response).toMatchObject({ status: 202, body: { state: 'queued_processing' } });
      expect(renewals).toHaveLength(1);
      expect(renewals[0]).toMatchObject({
        ...intakeWorker,
        operationId: issued.operationId,
        generation: claimedLease!.generation,
      });
      expect(Date.parse(renewals[0].expiresAt)).toBeGreaterThan(
        Date.parse(claimedLease!.expiresAt),
      );
      expect(receivedBytes).toBe(bytes.length);
      expect(ordinaryPut).toHaveBeenCalledTimes(1);
      expect(await readFile(path.join(ordinaryRoot, issued.operationId))).toEqual(bytes);
      expect(await observer.models.File.countDocuments({ file_id: issued.operationId })).toBe(1);
    } finally {
      clearTimeout(timeout);
      onRenew = undefined;
    }
  }, 20_000);

  it('rejects Intake memory pressure before claim or received bytes while App admission remains healthy', async () => {
    const bytes = Buffer.from('Dieser Text darf den isolierten Eingangsstream nicht passieren.');
    const issued = await ticket(bytes);
    await writeFile(path.join(intakeCgroupDirectory, 'memory.current'), '939524096\n');
    await expect(
      appResources.assertSafe({ phase: 'admission', hostId: appWorker.hostId }),
    ).resolves.toBeUndefined();
    expect(await submit(issued, bytes)).toMatchObject({
      status: 503,
      body: { code: 'unavailable' },
    });
    expect(claimedLease).toBeUndefined();
    expect(receivedBytes).toBe(0);
    expect(await readdir(stagingRoot)).toEqual([]);
    await noOrdinaryContent();
  });

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

    const replacementWorker = {
      hostId: intakeWorker.hostId,
      instanceId: createMaintenanceIdentity(intakeEnvironment, true).incarnation,
    };
    expect(replacementWorker.instanceId).not.toBe(intakeWorker.instanceId);
    const replacement = await clientFor(replacementWorker);
    const localSettlement = {
      version: 1,
      operationId: issued.operationId,
      transferGeneration: claimedLease!.generation,
      worker: intakeWorker,
      localWriterStopped: true,
      localCopiesAbsent: true,
    };
    for (const [command, code] of [
      [{ action: 'renew', lease: claimedLease }, 'lease_lost'],
      [{ action: 'seal-recovery', transferGeneration: claimedLease!.generation }, 'unauthorized'],
      [{ action: 'confirm-recovery', settlement: localSettlement }, 'lease_lost'],
      [
        {
          action: 'confirm-recovery',
          settlement: { ...localSettlement, worker: replacementWorker },
        },
        'unauthorized',
      ],
    ]) {
      await expect(
        replacement.control({ ...issued, command, signal: AbortSignal.timeout(5000) }),
      ).rejects.toMatchObject({ code });
    }
    // The same authorized role may start its own attempt, but cannot inherit the old incarnation's obligations.
    const fresh = await ticket(bytes);
    const freshLease = (await replacement.control({
      ...fresh,
      command: { action: 'claim' },
      signal: AbortSignal.timeout(5000),
    })) as UploadLease;
    expect(freshLease).toMatchObject({ ...replacementWorker, operationId: fresh.operationId });
    await expect(
      replacement.control({
        ...fresh,
        command: { action: 'seal-recovery', transferGeneration: freshLease.generation },
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toMatchObject({ closed: true, acknowledged: false, worker: replacementWorker });
    await expect(
      replacement.control({
        ...fresh,
        command: {
          action: 'confirm-recovery',
          settlement: {
            ...localSettlement,
            operationId: fresh.operationId,
            transferGeneration: freshLease.generation,
            worker: replacementWorker,
          },
        },
        signal: AbortSignal.timeout(5000),
      }),
    ).resolves.toMatchObject({
      acknowledged: true,
      worker: replacementWorker,
      storageOutcome: 'not_started',
    });
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
    const response = await submit(issued, bytes);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(promotionLease).toBeDefined();
    expect(await recovery(issued)).toMatchObject({
      acknowledged: true,
      storageOutcome: 'not_started',
      appWriterStopped: true,
    });
    expect(intakeDrain).toEqual({ complete: true });
    expect(await stored(issued.operationId)).toMatchObject({
      state: 'cancelled',
      intake: { closed: true, cleanupAcknowledged: true },
    });
    await rejectsUserWork(issued);
    await noOrdinaryContent();
    expect(await stored(issued.operationId)).not.toHaveProperty('promotion');
  }, 30_000);

  it.each(['revoked-after-claim', 'lost-successful-promotion-reply'] as const)(
    'recovers %s through the bound technical path without reopening user authority or sending bytes twice',
    async (fault) => {
      const bytes = Buffer.from('Zulässiger Text für technische Bereinigung.');
      const issued = await ticket(bytes);
      revokeAfterClaim = fault === 'revoked-after-claim';
      losePromotionReply = fault === 'lost-successful-promotion-reply';
      const response = await submit(issued, bytes);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(claimedLease).toBeDefined();
      const view = await recovery(issued);
      expect(view).toMatchObject({
        acknowledged: true,
        appWriterStopped: true,
        storageOutcome: revokeAfterClaim ? 'not_started' : 'durable',
      });
      expect(intakeDrain).toEqual({ complete: true });
      expect(await stored(issued.operationId)).toMatchObject({
        intake: { closed: true, cleanupAcknowledged: true },
      });
      await rejectsUserWork(issued);
      expect(await observer.models.File.countDocuments({})).toBe(0);
      if (revokeAfterClaim) {
        await noOrdinaryContent();
      } else {
        expect(lostReplies).toBe(1);
        expect(ordinaryPut).toHaveBeenCalledTimes(1);
        expect(ordinaryBytes).toBe(bytes.length);
        expect(await readFile(path.join(ordinaryRoot, issued.operationId))).toEqual(bytes);
        expect(await stored(issued.operationId)).toMatchObject({
          promotion: { state: 'settled', writerStopped: true, receipt: { outcome: 'durable' } },
        });
      }
    },
    30_000,
  );

  it('retries a lost technical recovery request while the service stays open, without a new upload', async () => {
    const bytes = Buffer.from('Technische Bereinigung ohne neuen Browseraufruf.');
    const issued = await ticket(bytes);
    losePromotionReply = loseFirstRecoveryRequest = true;
    expect((await submit(issued, bytes)).status).toBeGreaterThanOrEqual(400);
    const until = Date.now() + 5000;
    let recovered = false;
    while (Date.now() < until) {
      const row = await stored(issued.operationId);
      const census = await intake!.maintenance.getMaintenanceCensus(null);
      if (row?.intake?.cleanupAcknowledged === true && census.complete) {
        recovered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(recovered).toBe(true);
    expect(recoveryRequests).toBeGreaterThanOrEqual(2);
    expect(intakeDrain).toBeUndefined();
    expect(lostReplies).toBe(1);
    expect(ordinaryPut).toHaveBeenCalledTimes(1);
    expect(ordinaryBytes).toBe(bytes.length);
    expect(await stored(issued.operationId)).toMatchObject({
      intake: { closed: true, cleanupAcknowledged: true },
      promotion: { state: 'settled', writerStopped: true, receipt: { outcome: 'durable' } },
    });
    await rejectsUserWork(issued);
    expect(await observer.models.File.countDocuments({})).toBe(0);
  }, 30_000);

  it('keeps an unknown App PUT incomplete after technical recovery and refuses user replay', async () => {
    const bytes = Buffer.from('Unbestätigter tatsächlicher App-Schreibversuch.');
    const issued = await ticket(bytes);
    unknownStorageOutcome = true;
    expectedCompleteDrain = expectedAppDrain = false;
    const response = await submit(issued, bytes);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await recovery(issued)).toMatchObject({
      acknowledged: false,
      storageOutcome: 'unknown',
      appWriterStopped: false,
    });
    expect(intakeDrain).toEqual({ complete: false });
    expect(await stored(issued.operationId)).toMatchObject({
      cleanupPending: true,
      intake: { closed: true },
      promotion: { state: 'writing', writerStopped: false },
    });
    expect((await stored(issued.operationId))?.intake?.cleanupAcknowledged).not.toBe(true);
    await rejectsUserWork(issued);
    expect(ordinaryPut).toHaveBeenCalledTimes(1);
    expect(ordinaryBytes).toBe(bytes.length);
    expect(await observer.models.File.countDocuments({})).toBe(0);
  }, 30_000);
});
