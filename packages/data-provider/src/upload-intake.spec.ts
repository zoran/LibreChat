import { antivirusFixture } from './__fixtures__/upload-antivirus';
import {
  readUploadIntakeGrant,
  readUploadIntakeTicket,
  readUploadPromotionInput,
  readUploadPromotionRecord,
  readUploadPromotionSettlement,
} from './upload-intake';

const userId = 'a'.repeat(24);
const operationId = '11111111-1111-4111-8111-111111111111';
const promotionId = '22222222-2222-4222-8222-222222222222';
const expiresAt = '2026-10-17T04:20:00.000Z';
const grant = () => ({
  version: 1,
  principal: { authentication: 'verified-email', tenantId: 'tenant', userId },
  sessionId: 'b'.repeat(24),
  authVersion: 0,
  policyVersion: 1,
  expiresAt,
});
const ticket = () => ({ version: 1, operationId, capability: 'A'.repeat(43), expiresAt });
const promotionSubject = () => ({
  tenantId: 'tenant',
  userId,
  operationId,
  transferGeneration: 1,
  mediaType: 'text/plain',
  bytes: 5,
  sha256: 'b'.repeat(64),
});
const promotion = () => ({
  version: 1,
  promotionId,
  lease: {
    tenantId: 'tenant',
    userId,
    operationId,
    generation: 1,
    kind: 'transfer',
    hostId: 'intake-host',
    instanceId: 'intake-instance',
    expiresAt,
  },
  worker: { hostId: 'app-host', instanceId: 'app-instance' },
  approval: {
    version: 2,
    antivirus: antivirusFixture(promotionSubject(), Date.parse(expiresAt)).approval,
    decision: 'approved',
    policySha256: 'a'.repeat(64),
    scannerVersion: 'scanner/1',
    checkedAt: expiresAt,
    coverage: { complete: true, pages: 1, parts: 1 },
    subject: promotionSubject(),
  },
  integrity: {
    version: 1,
    algorithm: 'sha256',
    sha256: 'b'.repeat(64),
    chunkBytes: 262144,
    chunkSha256: ['b'.repeat(64)],
  },
  metadata: { filename: ' Grüße 📄.txt ' },
});
const receipt = () => ({
  outcome: 'durable',
  bytes: 5,
  source: 's3',
  filepath: 'approved/original',
  storageKey: 'approved/original',
  integrity: promotion().integrity,
});
const settlement = () => ({
  operationId,
  transferGeneration: 1,
  promotionId,
  worker: promotion().worker,
  writerStopped: true,
  receipt: receipt(),
});
const record = () => ({
  ...promotion(),
  state: 'settled',
  writerStopped: true,
  receipt: receipt(),
});

describe('isolated intake shared data boundaries', () => {
  it.each([
    ['grant', grant, readUploadIntakeGrant],
    ['ticket', ticket, readUploadIntakeTicket],
    ['promotion', promotion, readUploadPromotionInput],
    ['record', record, readUploadPromotionRecord],
    ['settlement', settlement, readUploadPromotionSettlement],
  ])(
    'returns an independent exact %s snapshot and refuses non-data records',
    (_name, create, read) => {
      const input = create();
      const result = read(input);
      expect(result).toEqual(input);
      expect(result).not.toBe(input);
      expect(read(Object.assign(Object.create(null), input))).toEqual(input);
      for (const invalid of [
        null,
        [],
        { ...input, extra: true },
        Object.create(input),
        { ...input, [Symbol('hidden')]: true },
      ])
        expect(read(invalid)).toBeNull();
      const getter = jest.fn(() => 'private');
      const accessor = { ...input };
      Object.defineProperty(accessor, Object.keys(input)[0], { enumerable: true, get: getter });
      expect(read(accessor)).toBeNull();
      expect(getter).not.toHaveBeenCalled();
      const hidden = { ...input };
      Object.defineProperty(hidden, 'hidden', { value: true });
      expect(read(hidden)).toBeNull();
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(read(revoked.proxy)).toBeNull();
    },
  );
  it.each([
    { authVersion: -1 },
    { authVersion: 0.5 },
    { policyVersion: 0 },
    { policyVersion: Number.MAX_SAFE_INTEGER + 1 },
    { sessionId: 'B'.repeat(24) },
    { sessionId: 'b'.repeat(25) },
    { expiresAt: '2026-02-30T00:00:00.000Z' },
    { expiresAt: '2026-10-17T04:20:00Z' },
    { principal: { authentication: 'guest', tenantId: null, userId } },
    { principal: { authentication: 'verified-email', tenantId: null, userId } },
    { principal: { authentication: 'verified-email', tenantId: '__SYSTEM__', userId } },
    { principal: { authentication: 'verified-email', tenantId: 'tenant', userId: 'user' } },
  ])('rejects invalid grant fields %j', (patch) =>
    expect(readUploadIntakeGrant({ ...grant(), ...patch })).toBeNull(),
  );
  it('keeps structural time validation independent of current authorization and does not mutate a grant', () => {
    const input = grant();
    input.expiresAt = '2000-01-01T00:00:00.000Z';
    const result = readUploadIntakeGrant(input)!;
    input.principal.userId = 'c'.repeat(24);
    expect(result.principal.userId).toBe(userId);
    expect(result.expiresAt).toBe('2000-01-01T00:00:00.000Z');
  });
  it.each([
    '',
    'A'.repeat(42),
    'A'.repeat(44),
    `${'A'.repeat(42)}=`,
    `${'A'.repeat(42)}B`,
    `${'A'.repeat(42)}-`,
    `${'A'.repeat(42)}\n`,
  ])('rejects a noncanonical 32-byte capability %j', (capability) =>
    expect(readUploadIntakeTicket({ ...ticket(), capability })).toBeNull(),
  );
  it.each(['A', 'E', 'I', 'M', 'Q', 'U', 'Y', 'c', 'g', 'k', 'o', 's', 'w', '0', '4', '8'])(
    'accepts canonical final base64url sextet %s',
    (last) =>
      expect(
        readUploadIntakeTicket({ ...ticket(), capability: `${'A'.repeat(42)}${last}` }),
      ).not.toBeNull(),
  );
  it.each([
    (value: ReturnType<typeof promotion>) => {
      value.promotionId = operationId.toUpperCase().replace('1111', 'AAAA');
    },
    (value: ReturnType<typeof promotion>) => {
      value.lease.kind = 'processing';
    },
    (value: ReturnType<typeof promotion>) => {
      value.lease.generation = 0;
    },
    (value: ReturnType<typeof promotion>) => {
      value.lease.userId = 'c'.repeat(24);
    },
    (value: ReturnType<typeof promotion>) => {
      value.approval.subject.operationId = 'other';
    },
    (value: ReturnType<typeof promotion>) => {
      value.approval.subject.transferGeneration = 2;
    },
    (value: ReturnType<typeof promotion>) => {
      value.approval.subject.sha256 = 'c'.repeat(64);
    },
    (value: ReturnType<typeof promotion>) => {
      value.integrity.chunkSha256 = [];
    },
    (value: ReturnType<typeof promotion>) => {
      value.approval.coverage.complete = false;
    },
    (value: ReturnType<typeof promotion>) => {
      value.worker.hostId = 'x'.repeat(129);
    },
    (value: ReturnType<typeof promotion>) => {
      value.metadata.filename = '../secret';
    },
  ])('rejects malformed or internally unbound promotion data %#', (change) => {
    const input = promotion();
    change(input);
    expect(readUploadPromotionInput(input)).toBeNull();
  });
  it('deeply snapshots approval, lease, worker, metadata and block integrity without invoking nested getters', () => {
    const input = promotion();
    const result = readUploadPromotionInput(input)!;
    input.approval.subject.sha256 = 'c'.repeat(64);
    input.integrity.chunkSha256[0] = 'd'.repeat(64);
    input.lease.instanceId = 'other';
    input.worker.instanceId = 'other';
    input.metadata.filename = 'other';
    expect(result).toEqual(promotion());
    const getter = jest.fn(() => 'b'.repeat(64));
    Object.defineProperty(input.integrity.chunkSha256, '0', { enumerable: true, get: getter });
    expect(readUploadPromotionInput(input)).toBeNull();
    expect(getter).not.toHaveBeenCalled();
    const sparse = promotion();
    sparse.integrity.chunkSha256 = new Array(1);
    expect(readUploadPromotionInput(sparse)).toBeNull();
    const cyclic = promotion();
    Object.assign(cyclic.metadata, { cycle: cyclic });
    expect(readUploadPromotionInput(cyclic)).toBeNull();
  });
  it.each([
    { state: 'prepared', writerStopped: true },
    { state: 'writing', writerStopped: false },
    { state: 'writing', writerStopped: false, receipt: { ...receipt(), outcome: 'unknown' } },
    { state: 'settled', writerStopped: true },
    { state: 'settled', writerStopped: true, receipt: receipt() },
  ])('preserves valid promotion lifecycle data %j', (state) =>
    expect(readUploadPromotionRecord({ ...promotion(), ...state })).not.toBeNull(),
  );
  it.each([
    { state: 'prepared', writerStopped: false },
    { state: 'prepared', writerStopped: true, receipt: receipt() },
    { state: 'writing', writerStopped: true },
    { state: 'settled', writerStopped: false },
    { state: 'settled', writerStopped: true, receipt: { ...receipt(), outcome: 'unknown' } },
    { state: 'settled', writerStopped: true, receipt: { ...receipt(), bytes: 6 } },
    {
      state: 'settled',
      writerStopped: true,
      receipt: { ...receipt(), integrity: { ...receipt().integrity, sha256: 'c'.repeat(64) } },
    },
  ])('rejects contradictory promotion lifecycle data %j', (state) =>
    expect(readUploadPromotionRecord({ ...promotion(), ...state })).toBeNull(),
  );
  it('retains uncertainty and rejects malformed settlement receipts without authenticating a writer', () => {
    expect(
      readUploadPromotionSettlement({
        ...settlement(),
        writerStopped: false,
        receipt: { ...receipt(), outcome: 'unknown' },
      }),
    ).not.toBeNull();
    expect(
      readUploadPromotionSettlement({
        ...settlement(),
        receipt: { ...receipt(), outcome: 'unknown' },
      }),
    ).toBeNull();
    expect(readUploadPromotionSettlement({ ...settlement(), transferGeneration: 0 })).toBeNull();
    expect(
      readUploadPromotionSettlement({
        ...settlement(),
        receipt: { ...receipt(), storageKey: 'x'.repeat(4097) },
      }),
    ).toBeNull();
    const input = settlement();
    const result = readUploadPromotionSettlement(input)!;
    input.receipt.integrity.chunkSha256[0] = 'c'.repeat(64);
    expect(result.receipt?.integrity?.chunkSha256).toEqual(['b'.repeat(64)]);
  });
});

it('retains explicit historical promotion custody without admitting a legacy current dispatch', () => {
  const value = promotion();
  const { antivirus: _oldAntivirus, ...legacy } = value.approval;
  const input = { ...value, approval: { ...legacy, version: 1 } };
  expect(readUploadPromotionInput(input)).toBeNull();
  const retained = { ...input, state: 'settled', writerStopped: true, receipt: receipt() };
  expect(readUploadPromotionRecord(retained)).toBeNull();
  expect(readUploadPromotionRecord(retained, true)).toEqual(retained);
});
