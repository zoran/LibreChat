import { documentResultFixture } from './processing/result.helper';
/** Public authorization and retry boundaries; persistence has its own real Mongo suite. */
import { UPLOAD_MAX_FILE_BYTES } from 'librechat-data-provider';
import type {
  UploadOperation,
  UploadPrincipal,
  UploadRequest,
  UploadLease,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { UploadRepository, TelemetryPort } from './contract';
import { isUploadManagementError, UploadManagementError } from './errors';
import { createUploadManagement } from './management';

const principal: UploadPrincipal = {
  tenantId: 'tenant',
  userId: 'user',
  authentication: 'verified-email',
};
const request: UploadRequest = {
  mediaType: 'text/plain',
  declaredBytes: 8,
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
};
const operation: UploadOperation = {
  version: 1,
  id: 'operation',
  revision: 1,
  scope: { kind: 'personal' },
  mediaType: request.mediaType,
  declaredBytes: 8,
  state: 'waiting',
  createdAt: new Date(1000).toISOString(),
  cleanupPending: false,
  canUseInComposer: false,
  canRetryProcessing: false,
};

function fixture(telemetry?: TelemetryPort) {
  const reserve = jest.fn().mockResolvedValue(operation);
  const findReservation = jest.fn().mockResolvedValue(null);
  const get = jest.fn().mockResolvedValue(operation);
  const renew = jest.fn();
  const accept = jest.fn().mockResolvedValue({ ...operation, state: 'queued_processing' });
  const retryProcessing = jest
    .fn()
    .mockResolvedValue({ ...operation, state: 'queued_processing', revision: 3 });
  const publish = jest.fn().mockResolvedValue({ ...operation, state: 'ready', revision: 5 });
  const methods: Partial<UploadRepository> = {
    reserve,
    findReservation,
    get,
    renew,
    accept,
    retryProcessing,
    publish,
  };
  const repository = new Proxy({} as UploadRepository, {
    get: (_target, key) =>
      methods[key as keyof UploadRepository] ??
      (() => {
        throw new Error(`Unexpected repository method ${String(key)}`);
      }),
  });
  const authorize = jest.fn().mockResolvedValue(true);
  const assertSafe = jest.fn().mockResolvedValue(undefined);
  const management = createUploadManagement({
    repository,
    identity: { authorize },
    resources: { assertSafe },
    telemetry,
    now: () => 1000,
    newId: () => 'operation',
  });
  return {
    management,
    reserve,
    findReservation,
    get,
    renew,
    accept,
    retryProcessing,
    publish,
    authorize,
    assertSafe,
  };
}

describe('managed upload public boundary', () => {
  it('does not reuse read permission for a state-changing retry', async () => {
    const f = fixture();
    f.authorize.mockImplementation(
      async (_actor, target) => target.resourceId === operation.id && target.action === 'read',
    );
    await expect(f.management.get(principal, operation.id)).resolves.toEqual(operation);
    await expect(f.management.retryProcessing(principal, operation.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(f.retryProcessing).not.toHaveBeenCalled();
  });
  it('rechecks bound action after the repository read and denies revoked transfer authority', async () => {
    const f = fixture();
    let active = true;
    f.authorize.mockImplementation(
      async (_actor, target) =>
        active && target.resourceId === operation.id && target.action === 'upload',
    );
    f.get.mockImplementation(async () => {
      active = false;
      return operation;
    });
    await expect(
      f.management.claimTransfer(principal, operation.id, { hostId: 'cpu-1', instanceId: 'test' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.assertSafe).not.toHaveBeenCalled();
  });
  it('denies workspace operation reads even with a permissive identity adapter', async () => {
    const f = fixture();
    f.get.mockResolvedValue({
      ...operation,
      scope: { kind: 'workspace', workspaceId: '0123456789abcdef01234567' },
    });
    await expect(f.management.get(principal, operation.id)).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
  it('reserves canonical CSV without changing its MIME fingerprint or admission guards', async () => {
    const f = fixture();
    const csv = { ...request, mediaType: 'text/csv' };
    f.reserve.mockResolvedValue({ ...operation, mediaType: csv.mediaType });
    await expect(f.management.reserve(principal, csv)).resolves.toMatchObject({
      mediaType: 'text/csv',
      state: 'waiting',
      canUseInComposer: false,
    });
    expect(f.authorize).toHaveBeenCalledWith(principal, {
      owner: {
        tenantId: principal.tenantId,
        scope: { kind: 'personal' },
        ownerUserId: principal.userId,
      },
      resourceType: 'upload',
      resourceId: null,
      action: 'upload',
    });
    expect(f.assertSafe).toHaveBeenCalledWith({ phase: 'admission' });
    const fingerprint = JSON.stringify([{ kind: 'personal' }, 'text/csv', csv.declaredBytes]);
    expect(f.findReservation).toHaveBeenCalledWith(
      principal,
      csv.idempotencyKey,
      fingerprint,
      1000,
    );
    expect(f.reserve).toHaveBeenCalledWith(
      principal,
      {
        ...csv,
        scope: { kind: 'personal' },
        operationId: 'operation',
        fingerprint,
      },
      1000,
    );
    expect(f.accept).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each([
    'text/csv; charset=utf-8',
    'text/markdown',
    'text/x-csv',
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ])('does not admit the CSV alias or unrelated MIME %s', async (mediaType) => {
    const f = fixture();
    await expect(f.management.reserve(principal, { ...request, mediaType })).rejects.toMatchObject({
      code: 'unsupported_type',
    });
    expect(f.findReservation).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('does not let CSV bypass ownership or paused admission', async () => {
    const f = fixture();
    const csv = { ...request, mediaType: 'text/csv' };
    f.authorize.mockResolvedValueOnce(false);
    await expect(f.management.reserve(principal, csv)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.assertSafe).not.toHaveBeenCalled();
    f.assertSafe.mockRejectedValue(new UploadManagementError('admission_paused'));
    await expect(f.management.reserve(principal, csv)).rejects.toMatchObject({
      code: 'admission_paused',
    });
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('admits the explicit null guest namespace only through the existing identity policy', async () => {
    const f = fixture();
    const guest = { tenantId: null, userId: 'guest-a', authentication: 'guest' } as const;
    await expect(f.management.reserve(guest, request)).resolves.toEqual(operation);
    expect(f.authorize).toHaveBeenCalledWith(guest, {
      owner: { tenantId: null, scope: { kind: 'personal' }, ownerUserId: guest.userId },
      resourceType: 'upload',
      resourceId: null,
      action: 'upload',
    });
    f.authorize.mockResolvedValue(false);
    await expect(f.management.reserve(guest, request)).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rejects a guest carrying a tenant before identity, storage or capacity access', async () => {
    const f = fixture();
    // Deliberately malformed JavaScript input outside the typed principal contract.
    await expect(
      Reflect.apply(f.management.reserve, f.management, [
        { ...principal, authentication: 'guest' },
        request,
      ]),
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('keeps workspace admission closed even if an identity adapter recognizes it', async () => {
    const f = fixture();
    await expect(
      f.management.reserve(principal, {
        ...request,
        scope: { kind: 'workspace', workspaceId: 'future' },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, UPLOAD_MAX_FILE_BYTES + 1])(
    'rejects declared size %s',
    async (declaredBytes) => {
      const f = fixture();
      await expect(
        f.management.reserve(principal, { ...request, declaredBytes }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(f.assertSafe).not.toHaveBeenCalled();
    },
  );
  it('preserves exact safe metadata and guards a new admission', async () => {
    const f = fixture();
    expect(await f.management.reserve(principal, request)).toEqual(operation);
    expect(f.assertSafe).toHaveBeenCalledWith({ phase: 'admission' });
    expect(f.reserve).toHaveBeenCalledWith(
      principal,
      {
        ...request,
        operationId: 'operation',
        scope: { kind: 'personal' },
        fingerprint: JSON.stringify([
          { kind: 'personal' },
          request.mediaType,
          request.declaredBytes,
        ]),
      },
      1000,
    );
  });
  it.each([
    { filename: 'private-title.txt' },
    { filename: undefined },
    { idempotencyKey: 'private-title.txt' },
    { idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { idempotencyKey: '11111111-1111-1111-8111-111111111111' },
    { idempotencyKey: '11111111-1111-4111-1111-111111111111' },
  ])('refuses legacy metadata and noncanonical replay identities: %j', async (extra) => {
    const f = fixture();
    await expect(f.management.reserve(principal, { ...request, ...extra })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.findReservation).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('snapshots technical metadata before asynchronous authorization without invoking getters', async () => {
    const f = fixture();
    const input = { ...request };
    f.authorize.mockImplementationOnce(async () => {
      input.idempotencyKey = 'private-title.txt';
      input.mediaType = 'application/pdf';
      return true;
    });
    await f.management.reserve(principal, input);
    expect(f.reserve).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        ...request,
        fingerprint: JSON.stringify([{ kind: 'personal' }, 'text/plain', 8]),
      }),
      1000,
    );
    const getter = jest.fn(() => 'text/plain');
    Object.defineProperty(input, 'mediaType', { enumerable: true, get: getter });
    await expect(f.management.reserve(principal, input)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(f.reserve).toHaveBeenCalledTimes(1);
  });
  it('snapshots accepted filename metadata before awaits and rejects invalid names before repository access', async () => {
    const f = fixture();
    const lease: UploadLease = {
      ...principal,
      operationId: operation.id,
      generation: 1,
      kind: 'transfer',
      hostId: 'host',
      instanceId: 'app',
      expiresAt: new Date(46_000).toISOString(),
    };
    const receipt = {
      outcome: 'durable' as const,
      bytes: 8,
      source: 's3',
      filepath: 'private',
      storageKey: 'private',
    };
    const securityApproval: UploadSecurityApproval = {
      version: 1,
      decision: 'approved',
      policySha256: 'a'.repeat(64),
      scannerVersion: 'test/1',
      checkedAt: new Date(1000).toISOString(),
      coverage: { complete: true, pages: 1, parts: 1 },
      subject: {
        tenantId: principal.tenantId,
        userId: principal.userId,
        operationId: operation.id,
        transferGeneration: 1,
        mediaType: 'text/plain',
        bytes: 8,
        sha256: 'b'.repeat(64),
      },
    };
    const metadata = { filename: ' Grüße 📄.txt ' };
    f.authorize.mockImplementationOnce(async () => {
      metadata.filename = 'changed.txt';
      return true;
    });
    await f.management.accept(principal, operation.id, lease, receipt, securityApproval, metadata);
    expect(f.accept).toHaveBeenCalledWith(
      principal,
      lease,
      receipt,
      securityApproval,
      { filename: ' Grüße 📄.txt ' },
      1000,
    );
    await expect(
      f.management.accept(principal, operation.id, lease, receipt, securityApproval, {
        filename: '../private.txt',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.accept).toHaveBeenCalledTimes(1);
    expect(f.get).toHaveBeenCalledTimes(1);
  });
  it('returns an authorized durable replay during a resource outage without another reservation', async () => {
    const f = fixture();
    f.findReservation.mockResolvedValue({ ...operation, state: 'queued_processing' });
    f.assertSafe.mockRejectedValue(new UploadManagementError('unavailable'));
    expect((await f.management.reserve(principal, request)).state).toBe('queued_processing');
    expect(f.authorize).toHaveBeenCalled();
    expect(f.assertSafe).not.toHaveBeenCalled();
    expect(f.reserve).not.toHaveBeenCalled();
  });
  it('denies transfer before a resource guard when current ownership denies access', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    await expect(
      f.management.claimTransfer(principal, 'operation', { hostId: 'host', instanceId: 'app' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.assertSafe).not.toHaveBeenCalled();
  });
  it('does not classify arbitrary driver details as a safe upload error', () => {
    expect(
      isUploadManagementError(
        Object.assign(new Error('sensitive details'), {
          name: 'UploadManagementError',
          code: 'query-secret',
        }),
      ),
    ).toBe(false);
    expect(isUploadManagementError(new UploadManagementError('quota_exceeded'))).toBe(true);
  });
  it.each(['transfer', 'processing'] as const)(
    'stops %s renewal at a hard resource failure before extending its lease',
    async (kind) => {
      const f = fixture();
      const lease: UploadLease = {
        ...principal,
        operationId: 'operation',
        generation: 1,
        kind,
        hostId: 'host',
        instanceId: 'app',
        expiresAt: new Date(46_000).toISOString(),
      };
      f.assertSafe.mockRejectedValueOnce(new UploadManagementError('unavailable'));
      await expect(f.management.renew(lease)).rejects.toMatchObject({ code: 'unavailable' });
      expect(f.assertSafe).toHaveBeenCalledWith({ phase: kind, hostId: 'host', lease });
      expect(f.renew).not.toHaveBeenCalled();
      f.renew.mockResolvedValueOnce(lease);
      expect(await f.management.renew(lease)).toEqual(lease);
      expect(f.renew).toHaveBeenCalledWith(lease, 1000);
    },
  );

  it.each(['sync', 'async'])(
    'keeps %s telemetry failures from hiding committed results or budget errors',
    async (mode) => {
      const broken = jest.fn(() => {
        if (mode === 'sync') throw new Error('telemetry unavailable');
        return Promise.reject(new Error('telemetry unavailable'));
      });
      const f = fixture({ transition: broken, retry: broken, rejectQuota: broken });
      await expect(f.management.reserve(principal, request)).resolves.toEqual(operation);
      const lease: UploadLease = {
        ...principal,
        operationId: 'operation',
        generation: 1,
        kind: 'processing',
        hostId: 'host',
        instanceId: 'app',
        expiresAt: new Date(46_000).toISOString(),
      };
      await expect(
        f.management.publish(lease, {
          ...documentResultFixture('ready content'),
          writerStopped: true,
        }),
      ).resolves.toMatchObject({ state: 'ready' });
      const failure = new UploadManagementError('quota_exceeded');
      f.reserve.mockRejectedValueOnce(failure);
      await expect(f.management.reserve(principal, request)).rejects.toBe(failure);
      expect(broken).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    ['quota_exceeded', 'window'],
    ['capacity_exceeded', 'capacity'],
    ['queue_full', 'queue'],
  ] as const)(
    'reports only the known %s budget category without replacing its error',
    async (code, reason) => {
      const telemetry = { transition: jest.fn(), retry: jest.fn(), rejectQuota: jest.fn() };
      const f = fixture(telemetry);
      const error = new UploadManagementError(code);
      f.reserve.mockRejectedValueOnce(error);
      await expect(f.management.reserve(principal, request)).rejects.toBe(error);
      expect(telemetry.rejectQuota).toHaveBeenCalledWith(reason);
      expect(telemetry.transition).not.toHaveBeenCalled();
      f.reserve.mockRejectedValueOnce(new UploadManagementError('unavailable'));
      await expect(f.management.reserve(principal, request)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(telemetry.rejectQuota).toHaveBeenCalledTimes(1);
    },
  );

  it('reports an acknowledged processing requeue without counting ordinary idempotent retries', async () => {
    const telemetry = { transition: jest.fn(), retry: jest.fn(), rejectQuota: jest.fn() };
    const f = fixture(telemetry);
    f.get.mockResolvedValue({
      ...operation,
      state: 'failed',
      revision: 2,
      canRetryProcessing: true,
    });
    await f.management.retryProcessing(principal, operation.id);
    expect(telemetry.retry).toHaveBeenCalledWith('processing');
    f.get.mockResolvedValue({ ...operation, state: 'queued_processing', revision: 3 });
    await f.management.retryProcessing(principal, operation.id);
    expect(telemetry.retry).toHaveBeenCalledTimes(1);
    f.get.mockResolvedValue({ ...operation, state: 'failed', revision: 2 });
    f.retryProcessing.mockRejectedValueOnce(new UploadManagementError('queue_full'));
    await expect(f.management.retryProcessing(principal, operation.id)).rejects.toMatchObject({
      code: 'queue_full',
    });
    expect(telemetry.retry).toHaveBeenCalledTimes(1);
    expect(telemetry.rejectQuota).toHaveBeenCalledWith('queue');
  });

  it('does not emit or recount a replayed admission', async () => {
    const telemetry = { transition: jest.fn(), retry: jest.fn(), rejectQuota: jest.fn() };
    const f = fixture(telemetry);
    f.findReservation.mockResolvedValue(operation);
    await expect(f.management.reserve(principal, request)).resolves.toEqual(operation);
    for (const callback of Object.values(telemetry)) expect(callback).not.toHaveBeenCalled();
  });
});
