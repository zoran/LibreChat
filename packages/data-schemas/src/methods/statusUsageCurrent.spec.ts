/** Real isolated Mongo predicates and installed-driver command/lifetime regressions. */
import mongoose from 'mongoose';
import { performance } from 'node:perf_hooks';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  uploadSecuritySettlementFixture,
  uploadSecurityFixture,
  originalWriteBindingFixture,
} from '../../specs/fixtures/uploadManagement.security.fixture';
import { createStatusUsageCurrentMethods } from './statusUsageCurrent';

const at = 1792454400000;
const tenant = 'cortex-bwi';
const hash = 'a'.repeat(64);
const policy = {
  configured: true as const,
  tenantId: tenant,
  policyVersion: 7,
  domains: ['bwi.de'],
  uploadSecurityPolicySha256: hash,
  qualification: { email: 'load@qualification.example', notAfter: at + 10 },
};
let mongo: MongoMemoryReplSet;
let methods: ReturnType<typeof createStatusUsageCurrentMethods>;
let commands: mongoose.mongo.CommandStartedEvent[] = [];
const db = () => mongoose.connection.db!;
const collection = (name: string) => mongoose.models[name].collection;
const user = new mongoose.Types.ObjectId();
async function account(email = 'test@bwi.de') {
  await collection('User').insertOne({
    _id: user,
    tenantId: tenant,
    provider: 'email_code',
    email,
    emailVerified: true,
    authDisabled: false,
    authVersion: 0,
  });
  await collection('Session').insertOne({
    user,
    tenantId: tenant,
    authMethod: 'email_code',
    authPolicyVersion: 7,
    authVersion: 0,
    refreshGeneration: 0,
    authCreatedAt: new Date(at - 1000),
    expiration: new Date(at + 10000),
    idleExpiresAt: new Date(at + 10000),
  });
}
async function document() {
  const id = 'original-1';
  const storage = `t/${tenant}/managed-uploads/${user}/${id}.1__original`;
  const security = uploadSecurityFixture(
    {
      decision: 'approved',
      policySha256: hash,
      subject: {
        tenantId: tenant,
        userId: String(user),
        operationId: id,
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: 8,
        sha256: hash,
      },
      scannerVersion: 'fixture-v1',
      checkedAt: new Date(at - 1000).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
    },
    {
      custody: { kind: 'none' },
      attemptId: `${id}.1`,
      instanceId: '11111111-1111-4111-8111-111111111111',
      executionId: '22222222-2222-4222-8222-222222222222',
      expiresAt: new Date(at + 60000).toISOString(),
    },
  );
  const approval = security.approval;
  const execution = security.execution;
  const original: Parameters<typeof originalWriteBindingFixture>[0] = {
    outcome: 'durable',
    source: 's3',
    storageKey: storage,
    filepath: `/api/files/managed/${id}`,
    bytes: 8,
    integrity: {
      version: 1,
      algorithm: 'sha256',
      sha256: hash,
      chunkBytes: 262144,
      chunkSha256: [hash],
    },
  };
  const writeBinding = originalWriteBindingFixture(original, approval, at);
  await collection('UploadOperation').insertOne({
    _id: id as never,
    tenantId: tenant,
    userId: String(user),
    state: 'ready',
    writerStopped: true,
    publishedDigest: hash,
    mediaType: 'text/plain',
    acceptedAt: at - 1000,
    expiresAt: at + 10000,
    generation: 1,
    attemptGeneration: 1,
    declaredBytes: 8,
    actualBytes: 8,
    securityApproval: approval,
    securityExecution: execution,
    securitySettlement: uploadSecuritySettlementFixture(execution, {
      writerStopped: true,
      transientDataRemoved: true,
    }),
    original,
    writeBinding,
  });
  await collection('File').insertOne({
    file_id: id,
    uploadOperationId: id,
    user,
    tenantId: tenant,
    retentionAcceptedAt: new Date(at - 1000),
    expiredAt: new Date(at + 10000),
    status: 'ready',
    previewRevision: '1',
    source: 's3',
    type: 'text/plain',
    bytes: 8,
    storageKey: storage,
    securityApproval: approval,
    originalWriteBinding: writeBinding,
  });
}
describe('current usage Mongo predicates', () => {
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      binary: { systemBinary: process.env.MONGOMS_SYSTEM_BINARY },
      replSet: { count: 1, args: ['--setParameter', 'enableTestCommands=1'] },
    });
    await mongoose.connect(mongo.getUri('current_usage'), { monitorCommands: true });
    for (const name of ['Session', 'User', 'File', 'UploadOperation']) {
      mongoose.model(name, new mongoose.Schema({}, { strict: false }));
      await collection(name).createIndex({ tenantId: 1 });
    }
    mongoose.connection.getClient().on('commandStarted', (event) => commands.push(event));
    methods = createStatusUsageCurrentMethods(mongoose, policy);
  }, 30000);
  beforeEach(async () => {
    for (const name of ['Session', 'User', 'File', 'UploadOperation'])
      await collection(name).deleteMany({});
    commands = [];
  });
  afterAll(async () => {
    await mongoose.disconnect();
    mongoose.deleteModel(/.*/);
    await mongo?.stop();
  });

  test('complete zero is scoped query evidence; all aggregate commands obey 2000ms', async () => {
    for (const read of [methods.readCurrentAccounts, methods.readCurrentOriginalDocuments])
      expect(await read(at)).toEqual({ value: 0, asOfMs: at, queryCompleted: true, gap: null });
    const aggregates = commands.filter((e) => e.commandName === 'aggregate');
    expect(aggregates).toHaveLength(2);
    for (const event of aggregates) {
      expect(event.command.maxTimeMS).toBeGreaterThan(0);
      expect(event.command.maxTimeMS).toBeLessThanOrEqual(2000);
    }
    expect(commands.some((e) => ['getMore', 'killCursors'].includes(e.commandName))).toBe(false);
  });
  test('real lookup counts distinct eligible account and excludes foreign tenant', async () => {
    await account();
    const original = await collection('Session').findOne({ user });
    await collection('Session').insertOne({ ...original, _id: new mongoose.Types.ObjectId() });
    expect(await methods.readCurrentAccounts(at)).toMatchObject({ value: 1, gap: null });
    await collection('User').updateOne({ _id: user }, { $set: { tenantId: 'other' } });
    expect(await methods.readCurrentAccounts(at)).toMatchObject({ value: 0, gap: null });
  });
  test.each([
    'authDisabled',
    'agentTriggerDeletionStartedAt',
    'credentialsChangedAt',
    'twoFactorEnrolledAt',
  ])('actual User %s retirement removes eligibility', async (field) => {
    await account();
    await collection('User').updateOne(
      { _id: user },
      { $set: { [field]: field === 'authDisabled' ? true : new Date(at) } },
    );
    expect(await methods.readCurrentAccounts(at)).toMatchObject({ value: 0, gap: null });
  });
  test('qualification recipient expires at equality', async () => {
    await account(policy.qualification.email);
    expect(await methods.readCurrentAccounts(at)).toMatchObject({ value: 1 });
    expect(await methods.readCurrentAccounts(at + 10)).toMatchObject({ value: 0 });
  });
  test('real File publication and full owner security evidence produce one original', async () => {
    await document();
    expect(await methods.readCurrentOriginalDocuments(at)).toMatchObject({ value: 1, gap: null });
    await collection('File').updateOne({}, { $set: { deletionRequestedAt: new Date(at) } });
    expect(await methods.readCurrentOriginalDocuments(at)).toMatchObject({ value: 0, gap: null });
  });
  test.each([
    'securitySettlement',
    'securityExecution',
    'securityApproval.subject',
    'original.integrity.chunkSha256',
  ])('missing actual Upload %s cannot become exact document count', async (field) => {
    await document();
    await collection('UploadOperation').updateOne({}, { $unset: { [field]: '' } });
    expect(await methods.readCurrentOriginalDocuments(at)).toMatchObject({
      value: null,
      gap: 'unsupported_classification',
    });
  });
  test('legacy original is unknown, not zero', async () => {
    await collection('File').insertOne({ tenantId: tenant, user, file_id: 'legacy' });
    expect(await methods.readCurrentOriginalDocuments(at)).toMatchObject({
      value: null,
      gap: 'unsupported_classification',
    });
  });
  test('actual driver interruption returns a gap and no detached cursor cleanup', async () => {
    await db()
      .admin()
      .command({
        configureFailPoint: 'failCommand',
        mode: { times: 1 },
        data: { failCommands: ['aggregate'], blockConnection: true, blockTimeMS: 3000 },
      });
    const started = performance.now();
    try {
      expect(await methods.readCurrentAccounts(at)).toMatchObject({
        value: null,
        gap: 'query_timeout',
      });
      expect(performance.now() - started).toBeLessThan(2800);
    } finally {
      await db().admin().command({ configureFailPoint: 'failCommand', mode: 'off' });
    }
    expect(commands.filter((e) => e.commandName === 'killCursors')).toHaveLength(0);
  }, 10000);

  test.each([
    ['attemptGeneration', 2],
    ['declaredBytes', 9],
    ['securitySettlement.transientDataRemoved', false],
    ['securityApproval.subject.userId', 'other-user'],
  ])('mismatched owner proof %s remains unknown', async (field, value) => {
    await document();
    await collection('UploadOperation').updateOne({}, { $set: { [String(field)]: value } });
    const proof = await methods.readCurrentOriginalDocuments(at);
    expect(proof).toMatchObject({
      value: null,
      queryCompleted: false,
      gap: 'unsupported_classification',
    });
    expect(JSON.stringify(proof)).not.toContain(String(user));
    expect(JSON.stringify(proof)).not.toContain(hash);
  });
  test('10001 real distinct eligible accounts cannot become a truncated exact count', async () => {
    const users = Array.from({ length: 10001 }, () => new mongoose.Types.ObjectId());
    await collection('User').insertMany(
      users.map((_id) => ({
        _id,
        tenantId: tenant,
        provider: 'email_code',
        email: 'fixture@bwi.de',
        emailVerified: true,
        authVersion: 0,
      })),
    );
    await collection('Session').insertMany(
      users.map((user) => ({
        user,
        tenantId: tenant,
        authMethod: 'email_code',
        authPolicyVersion: 7,
        authVersion: 0,
        refreshGeneration: 0,
        authCreatedAt: new Date(at - 1000),
        expiration: new Date(at + 10000),
        idleExpiresAt: new Date(at + 10000),
      })),
    );
    const proof = await methods.readCurrentAccounts(at);
    expect(proof).toMatchObject({ value: null, queryCompleted: false });
    // This bounded query may exhaust its fixed operation budget before reaching
    // the sentinel; neither outcome permits a truncated exact count.
    expect(['capacity', 'query_timeout']).toContain(proof.gap);
  });

  test('the completed query sentinel distinguishes 10000 from 10001', async () => {
    for (const value of [10000, 10001]) {
      const command = jest.spyOn(db(), 'command').mockResolvedValueOnce({
        cursor: { id: mongoose.mongo.Long.ZERO, firstBatch: [{ count: [{ value }] }] },
      } as never);
      try {
        expect(await methods.readCurrentAccounts(at)).toMatchObject(
          value === 10000
            ? { value, queryCompleted: true, gap: null }
            : { value: null, queryCompleted: false, gap: 'capacity' },
        );
      } finally {
        command.mockRestore();
      }
    }
  });
});

describe('current usage constructor validation', () => {
  const cases: [string, unknown][] = [
    ['missing policy', undefined],
    ['null policy', null],
    ['number policy', 3],
    ['string policy', 'policy'],
    ['boolean policy', true],
    ['array policy', Object.assign([], policy)],
    ['function policy', Object.assign(() => undefined, policy)],
    [
      'missing tenant',
      Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'tenantId')),
    ],
    ...[
      undefined,
      null,
      3,
      true,
      [],
      {},
      new String(tenant),
      Symbol('tenant'),
      '__SYSTEM__',
      'bad tenant',
      '',
    ].map((value, i): [string, unknown] => ['invalid tenant ' + i, { ...policy, tenantId: value }]),
    ...[undefined, null, 3, true, [], {}, new String(hash), Symbol('hash')].map(
      (value, i): [string, unknown] => [
        'invalid hash ' + i,
        { ...policy, uploadSecurityPolicySha256: value },
      ],
    ),
    ...[undefined, false, 1, 'true', new Boolean(true)].map((value, i): [string, unknown] => [
      'invalid configured ' + i,
      { ...policy, configured: value },
    ]),
    ...[null, false, 0, [], 'qualification'].map((value, i): [string, unknown] => [
      'invalid qualification ' + i,
      { ...policy, qualification: value },
    ]),
  ];
  test.each(cases)('%s fails before any model or database access', (_label, input) => {
    const access = jest.fn(() => {
      throw Error('UNEXPECTED_MODEL_ACCESS');
    });
    const blocked = new Proxy({}, { get: access }) as typeof mongoose;
    expect(() =>
      createStatusUsageCurrentMethods(
        blocked,
        input as Parameters<typeof createStatusUsageCurrentMethods>[1],
      ),
    ).toThrow('STATUS_USAGE_POLICY_INVALID');
    expect(access).not.toHaveBeenCalled();
  });
  test('does not coerce object tenant or hash values', () => {
    for (const field of ['tenantId', 'uploadSecurityPolicySha256']) {
      const coerce = jest.fn(() => (field === 'tenantId' ? tenant : hash));
      expect(() =>
        createStatusUsageCurrentMethods(
          {} as typeof mongoose,
          { ...policy, [field]: { toString: coerce, [Symbol.toPrimitive]: coerce } } as never,
        ),
      ).toThrow('STATUS_USAGE_POLICY_INVALID');
      expect(coerce).not.toHaveBeenCalled();
    }
  });
  test('accepts explicitly configured policy without model or query access', () => {
    const access = jest.fn(() => {
      throw Error('UNEXPECTED_MODEL_ACCESS');
    });
    const methods = createStatusUsageCurrentMethods(
      new Proxy({}, { get: access }) as typeof mongoose,
      policy,
    );
    expect(typeof methods.readCurrentAccounts).toBe('function');
    expect(typeof methods.readCurrentOriginalDocuments).toBe('function');
    expect(access).not.toHaveBeenCalled();
  });
});
