jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  ...jest.requireActual('../../../../data-provider/src/upload-management'),
  ...jest.requireActual('../../../../data-provider/src/upload-security'),
  ...jest.requireActual('../../../../data-provider/src/upload-intake'),
}));
import { createHash } from 'node:crypto';
import { UPLOAD_MAX_FILE_BYTES, UPLOAD_INTEGRITY_CHUNK_BYTES } from 'librechat-data-provider';
import type { EmailCodeIdentity } from '@librechat/data-schemas';
import type {
  UploadIntakeGrant,
  UploadLease,
  UploadPromotionRecord,
  UploadStorageReceipt,
  UploadOperation,
} from 'librechat-data-provider';
import { createIntakeControlHandlers } from './control';
import type { IntakeControlOptions } from './control';
import { createUploadAttemptJournal } from '../attempts';
import { createOriginalIntegrity } from '../storage/integrity';
import { UploadManagementError } from '../errors';

// Keep the fake DB's plain JSON data in the same realm as Jest's validators.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = Date.now();
const operationId = '11111111-1111-4111-8111-111111111111';
const promotionId = '22222222-2222-4222-8222-222222222222';
const intake = { hostId: 'intake-node', instanceId: 'intake-pod' };
const app = { hostId: 'app-node', instanceId: 'app-pod' };
const capability = 'a'.repeat(43);
const context = { operationId, capability, worker: intake };
const principal = {
  tenantId: 'cortex-bwi',
  userId: '1'.repeat(24),
  authentication: 'verified-email' as const,
};
const body = Buffer.from('hello');
const digest = createOriginalIntegrity(body.length);
digest.update(body);
const integrity = digest.finish();
const lease: UploadLease = {
  ...intake,
  operationId,
  tenantId: principal.tenantId,
  userId: principal.userId,
  generation: 1,
  kind: 'transfer',
  expiresAt: new Date(now + 60_000).toISOString(),
};
const grant: UploadIntakeGrant = {
  version: 1,
  principal,
  sessionId: '2'.repeat(24),
  authVersion: 0,
  policyVersion: 1,
  expiresAt: new Date(now + 300_000).toISOString(),
};
const approval = {
  version: 1 as const,
  decision: 'approved' as const,
  subject: {
    tenantId: principal.tenantId,
    userId: principal.userId,
    operationId,
    transferGeneration: 1,
    mediaType: 'text/plain',
    bytes: 5,
    sha256: integrity.sha256,
  },
  policySha256: 'a'.repeat(64),
  scannerVersion: 'test/1',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true as const, pages: 1, parts: 1 },
};
const preparation = {
  version: 1 as const,
  promotionId,
  lease,
  approval,
  integrity,
  metadata: { filename: 'example.txt' },
};
const receipt: UploadStorageReceipt = {
  outcome: 'durable',
  source: 's3',
  filepath: 'private-original',
  storageKey: `t/cortex-bwi/managed-uploads/${principal.userId}/${operationId}.1__original`,
  bytes: 5,
  integrity,
};
const signal = () => new AbortController().signal;
const stream = (value = body) =>
  (async function* () {
    yield value;
  })();

/** DB/storage are observed ports; native auth, provider readers, integrity and writer journal are real. */
function fixture() {
  let bound = true,
    native = true;
  let record: UploadPromotionRecord | null = null;
  const identity = {
    user: { email: 'person@employees.example.test' },
    grant: {
      ...grant,
      userId: principal.userId,
      tenantId: principal.tenantId,
      refreshGeneration: 4,
      createdAt: now - 1000,
      idleExpiresAt: now + 600_000,
      absoluteExpiresAt: now + 900_000,
    },
  } as unknown as EmailCodeIdentity;
  const operation = {
    version: 1,
    id: operationId,
    state: 'transferring',
    scope: { kind: 'personal' },
    mediaType: 'text/plain',
    declaredBytes: 5,
  } as UploadOperation;
  const journal = createUploadAttemptJournal(app);
  const repository: IntakeControlOptions['repository'] = {
    readIntake: jest.fn(async (_id, hash) => {
      if (hash !== createHash('sha256').update(capability).digest('hex'))
        throw new UploadManagementError('unauthorized');
      return { grant: copy(grant), ...(bound ? { worker: intake, generation: 1 } : {}) };
    }),
    claim: jest.fn(async () => {
      bound = true;
      return copy(lease);
    }),
    preparePromotion: jest.fn(async (input) => {
      record = { ...copy(input), state: 'prepared', writerStopped: true };
      return copy(record);
    }),
    getPromotion: jest.fn(async () => copy(record)),
    beginPromotion: jest.fn(async () => {
      if (!record || record.state !== 'prepared') throw new UploadManagementError('not_ready');
      record = { ...record, state: 'writing', writerStopped: false };
      return copy(record);
    }),
    settlePromotion: jest.fn(async (input) => {
      if (!record || record.state !== 'writing') throw new UploadManagementError('not_ready');
      record = {
        ...record,
        state: input.writerStopped ? 'settled' : 'writing',
        writerStopped: input.writerStopped,
        ...(input.receipt ? { receipt: copy(input.receipt) } : {}),
      };
      return copy(record);
    }),
  };
  const management: IntakeControlOptions['management'] = {
    get: jest.fn(async () => copy(operation)),
    renew: jest.fn(async () => copy(lease)),
    fail: jest.fn(async () => operation),
    cancel: jest.fn(async () => operation),
    bindSecurityExecution: jest.fn(async () => undefined),
    settleSecurityExecution: jest.fn(async () => undefined),
    claimWorkBytes: jest.fn(async () => ({ generation: 1, bytes: 5, expiresAt: lease.expiresAt })),
    completeWorkBytes: jest.fn(async () => undefined),
    accept: jest.fn(async () => operation),
    confirmCleanup: jest.fn(async () => operation),
  };
  const resources = { assertSafe: jest.fn(async () => undefined) };
  const storage = {
    put: jest.fn(async (input: Parameters<IntakeControlOptions['storage']['put']>[0]) => {
      for await (const chunk of input.body) expect(Buffer.from(chunk)).toEqual(body);
      return copy(receipt);
    }),
  };
  const identityRepository = {
    readEmailCodeIdentity: jest.fn(async () => (native ? copy(identity) : null)),
  };
  const handlers = createIntakeControlHandlers({
    repository,
    management,
    identityRepository,
    resources,
    storage,
    attempts: journal.attempts,
    worker: app,
    now: () => now,
  });
  const command = (value: unknown, ctx = context) => handlers.control(ctx, value, signal());
  const prepare = () => command({ action: 'prepare-promotion', input: preparation });
  return {
    handlers,
    repository,
    management,
    resources,
    storage,
    identityRepository,
    journal,
    command,
    prepare,
    unbind: () => {
      bound = false;
      operation.state = 'waiting';
    },
    revoke: () => {
      native = false;
    },
    record: () => record,
  };
}

describe('application intake control', () => {
  const original = { ...process.env };
  beforeAll(() => {
    process.env.AUTH_MODE = 'email_code';
    process.env.EMAIL_CODE_TENANT_ID = principal.tenantId;
    process.env.EMAIL_CODE_ALLOWED_DOMAINS = 'employees.example.test';
    process.env.EMAIL_CODE_HMAC_KEY = 'test-only-separate-key-'.repeat(3);
    process.env.EMAIL_CODE_POLICY_VERSION = '1';
  });
  afterAll(() => {
    process.env = original;
  });

  it('uses body-free durable preparation, the real App writer and only the stored receipt at accept', async () => {
    const f = fixture();
    expect(await f.command({ action: 'authorize' })).toEqual(principal);
    expect(await f.prepare()).toMatchObject({ state: 'prepared', worker: app });
    expect(f.storage.put).not.toHaveBeenCalled();
    const promotion = await f.handlers.promote(context, promotionId, 5, signal());
    expect(f.repository.beginPromotion).toHaveBeenCalledWith(lease, promotionId, app, now);
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(await promotion.consume(stream())).toMatchObject({
      state: 'settled',
      writerStopped: true,
      receipt,
    });
    await expect(promotion.consume(stream())).rejects.toMatchObject({ code: 'not_ready' });
    await promotion.close();
    await f.command({ action: 'accept', lease, promotionId });
    expect(f.management.accept).toHaveBeenCalledWith(
      principal,
      operationId,
      lease,
      receipt,
      approval,
      preparation.metadata,
    );
    const proof = await f.journal.attempts.stopAndJoin(
      { operationId, generation: 1, worker: app },
      signal(),
    );
    expect(proof).toMatchObject({
      writerStopped: true,
      localCopiesAbsent: true,
      storageOutcome: 'durable',
    });
    expect(
      await f.journal.attempts.stopAndJoin(
        { operationId, generation: 1, worker: intake },
        signal(),
      ),
    ).toMatchObject({ writerStopped: false });
    expect(await f.journal.close()).toEqual({ complete: true });
  });

  it('preserves the existing maximum-size integrity contract at the control snapshot boundary', async () => {
    const f = fixture();
    const count = Math.ceil(UPLOAD_MAX_FILE_BYTES / UPLOAD_INTEGRITY_CHUNK_BYTES);
    expect(count).toBe(120);
    const input = {
      ...preparation,
      approval: { ...approval, subject: { ...approval.subject, bytes: UPLOAD_MAX_FILE_BYTES } },
      integrity: {
        ...integrity,
        chunkSha256: Array.from({ length: count }, () => integrity.sha256),
      },
    };
    await expect(f.command({ action: 'prepare-promotion', input })).resolves.toMatchObject({
      state: 'prepared',
    });
    expect(f.repository.preparePromotion).toHaveBeenCalledTimes(1);
    input.integrity.chunkSha256.push(integrity.sha256);
    await expect(f.command({ action: 'prepare-promotion', input })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.repository.preparePromotion).toHaveBeenCalledTimes(1);
    expect(f.storage.put).not.toHaveBeenCalled();
  });

  it('checks live native auth, capability and exact lease owner/generation on commands', async () => {
    const f = fixture();
    for (const changed of [
      { userId: '3'.repeat(24) },
      { tenantId: 'another' },
      { generation: 2 },
      { instanceId: 'foreign' },
    ])
      await expect(
        f.command({ action: 'renew', lease: { ...lease, ...changed } }),
      ).rejects.toMatchObject({ code: 'lease_lost' });
    await expect(
      f.command({ action: 'get' }, { ...context, capability: 'b'.repeat(43) }),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    f.revoke();
    for (const action of ['authorize', 'get', 'claim', 'cancel', 'get-promotion'])
      await expect(f.command({ action })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.management.renew).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
  });

  it('takes no getter/prototype input and exposes no arbitrary command, proof or Appworker authority', async () => {
    const f = fixture();
    const getter = jest.fn(() => 'get');
    const hostile = Object.defineProperty({}, 'action', { enumerable: true, get: getter });
    for (const command of [
      hostile,
      Object.assign(Object.create({}), { action: 'get' }),
      { action: 'get', principal },
      { action: 'constructor' },
      { action: 'accept', lease, promotionId, receipt },
      { action: 'prepare-promotion', input: { ...preparation, worker: intake } },
    ])
      await expect(f.command(command)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(getter).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.repository.preparePromotion).not.toHaveBeenCalled();
    expect(f.management.accept).not.toHaveBeenCalled();
  });

  it('detaches command and service identity before the first native authentication await', async () => {
    const f = fixture();
    const mutableContext = copy(context);
    const input = copy(preparation);
    const pending = f.command({ action: 'prepare-promotion', input }, mutableContext);
    mutableContext.operationId = 'foreign';
    mutableContext.worker.instanceId = 'foreign';
    input.lease.generation = 2;
    input.approval.subject.userId = '3'.repeat(24);
    input.integrity.chunkSha256[0] = 'f'.repeat(64);
    await expect(pending).resolves.toMatchObject({ state: 'prepared' });
    expect(f.repository.preparePromotion).toHaveBeenCalledWith(
      { ...preparation, worker: app },
      now,
    );
  });

  it('enforces resources and atomic capability claim without permitting a bound replay', async () => {
    const f = fixture();
    f.unbind();
    jest
      .mocked(f.resources.assertSafe)
      .mockRejectedValueOnce(new UploadManagementError('capacity_exceeded'));
    await expect(f.command({ action: 'claim' })).rejects.toMatchObject({
      code: 'capacity_exceeded',
    });
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(await f.command({ action: 'claim' })).toEqual(lease);
    expect(f.repository.claim).toHaveBeenCalledWith({
      kind: 'transfer',
      principal,
      operationId,
      worker: intake,
      intake: { capabilitySha256: createHash('sha256').update(capability).digest('hex') },
      now,
    });
    await expect(f.command({ action: 'claim' })).rejects.toMatchObject({ code: 'lease_lost' });
  });

  it('does not settle another in-flight App claim when journal binding loses a race', async () => {
    const f = fixture();
    await f.prepare();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const begin = f.repository.beginPromotion;
    jest.mocked(f.repository.beginPromotion).mockImplementationOnce(async (...args) => {
      await gate;
      return begin(...args);
    });
    const first = f.handlers.promote(context, promotionId, 5, signal());
    while (!jest.mocked(begin).mock.calls.length) await Promise.resolve();
    await expect(f.handlers.promote(context, promotionId, 5, signal())).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(f.repository.settlePromotion).not.toHaveBeenCalled();
    release();
    const owned = await first;
    await owned.close();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(await f.journal.close()).toEqual({ complete: true });
  });

  it('rechecks auth and lease before touching the body and settles an unused claim without a receipt', async () => {
    const f = fixture();
    await f.prepare();
    const promotion = await f.handlers.promote(context, promotionId, 5, signal());
    f.revoke();
    const consumed = jest.fn();
    await expect(
      promotion.consume(
        (async function* () {
          consumed();
          yield body;
        })(),
      ),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    await promotion.close();
    expect(consumed).not.toHaveBeenCalled();
    expect(f.storage.put).not.toHaveBeenCalled();
    expect(f.record()).toMatchObject({ state: 'settled', writerStopped: true });
    expect(f.record()).not.toHaveProperty('receipt');
    expect(await f.journal.close()).toEqual({ complete: true });
  });

  it.each(['unknown', 'throw', 'tampered'] as const)(
    'retains the App obligation for %s PUT outcomes',
    async (outcome) => {
      const f = fixture();
      await f.prepare();
      if (outcome === 'unknown')
        f.storage.put.mockResolvedValueOnce({ ...receipt, outcome: 'unknown' });
      if (outcome === 'throw') f.storage.put.mockRejectedValueOnce(new Error('transport lost'));
      const promotion = await f.handlers.promote(context, promotionId, 5, signal());
      const result = promotion.consume(
        stream(outcome === 'tampered' ? Buffer.from('WRONG') : body),
      );
      if (outcome === 'unknown')
        await expect(result).resolves.toMatchObject({ state: 'writing', writerStopped: false });
      else await expect(result).rejects.toBeDefined();
      await promotion.close();
      expect(f.record()).toMatchObject({ state: 'writing', writerStopped: false });
      await expect(f.command({ action: 'accept', lease, promotionId })).rejects.toMatchObject({
        code: 'not_ready',
      });
      expect(await f.journal.close()).toEqual({ complete: false });
    },
  );

  it('records a joined durable PUT despite later lease loss without accepting or renewing its authority', async () => {
    const f = fixture();
    await f.prepare();
    f.storage.put.mockImplementationOnce(async (input) => {
      for await (const _chunk of input.body) {
        /* consume exact bytes */
      }
      jest.mocked(f.management.accept).mockRejectedValue(new UploadManagementError('lease_lost'));
      return copy(receipt);
    });
    const promotion = await f.handlers.promote(context, promotionId, 5, signal());
    await expect(promotion.consume(stream())).resolves.toMatchObject({
      state: 'settled',
      writerStopped: true,
    });
    await promotion.close();
    await expect(f.command({ action: 'accept', lease, promotionId })).rejects.toMatchObject({
      code: 'lease_lost',
    });
    expect(f.repository.settlePromotion).toHaveBeenCalledTimes(1);
    expect(await f.journal.close()).toEqual({ complete: true });
  });

  it('joins an outstanding App PUT before closing or issuing a stopped-writer settlement', async () => {
    const f = fixture();
    await f.prepare();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const joined = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.storage.put.mockImplementationOnce(async (input) => {
      for await (const _chunk of input.body) {
        /* consume exact bytes before awaiting remote completion */
      }
      entered();
      await joined;
      return copy(receipt);
    });
    const promotion = await f.handlers.promote(context, promotionId, 5, signal());
    const pending = promotion.consume(stream());
    await started;
    let closed = false;
    const closing = promotion.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(f.record()).toMatchObject({ state: 'writing', writerStopped: false });
    expect(f.repository.settlePromotion).not.toHaveBeenCalled();
    release();
    await pending;
    await closing;
    expect(f.record()).toMatchObject({ state: 'settled', writerStopped: true });
    expect(await f.journal.close()).toEqual({ complete: true });
  });

  it('never authorizes history deletion or false original absence through Intake cleanup', async () => {
    const f = fixture();
    await f.prepare();
    const proof = {
      operationId,
      generation: 1,
      writerStopped: true,
      originalAbsent: true,
      localCopiesAbsent: true,
      textAndHistoryRemoved: false,
    };
    await expect(
      f.command({ action: 'confirm-cleanup', proof: { ...proof, textAndHistoryRemoved: true } }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const promotion = await f.handlers.promote(context, promotionId, 5, signal());
    await expect(f.command({ action: 'confirm-cleanup', proof })).rejects.toMatchObject({
      code: 'not_ready',
    });
    await promotion.consume(stream());
    await promotion.close();
    await expect(f.command({ action: 'confirm-cleanup', proof })).rejects.toMatchObject({
      code: 'not_ready',
    });
    await f.command({ action: 'confirm-cleanup', proof: { ...proof, originalAbsent: false } });
    expect(f.management.confirmCleanup).toHaveBeenCalledTimes(1);
    expect(await f.journal.close()).toEqual({ complete: true });
  });
});
