/** Real manager/reader behavior; repository and identity are explicit boundary fakes. */
import { uploadReservationFingerprint } from 'librechat-data-provider';
import type {
  UploadDerivedRequest,
  UploadOperation,
  UploadPrincipal,
} from 'librechat-data-provider';
import type { UploadRepository } from './contract';
import { createUploadManagement } from './management';

const principal: UploadPrincipal = {
  authentication: 'verified-email',
  userId: 'user',
  tenantId: 'tenant',
};
const input = (): UploadDerivedRequest => ({
  mediaType: 'text/plain',
  declaredBytes: 8,
  idempotencyKey: '11111111-1111-4111-8111-111111111111',
  derived: {
    binding: { purpose: 'workspace-draft', sourceId: 'draft', sourceRevision: 1 },
    directSourceFileIds: ['source'],
  },
});
const operation: UploadOperation = {
  version: 1,
  id: 'operation',
  revision: 1,
  scope: { kind: 'personal' },
  mediaType: 'text/plain',
  declaredBytes: 8,
  state: 'waiting',
  createdAt: new Date(1000).toISOString(),
  cleanupPending: false,
  canUseInComposer: false,
  canRetryProcessing: false,
};
function fixture() {
  const findReservation = jest.fn().mockResolvedValue(null);
  const reserve = jest.fn().mockResolvedValue(operation);
  const reserveDerived = jest.fn().mockResolvedValue(operation);
  const authorize = jest.fn().mockResolvedValue(true);
  const assertSafe = jest.fn().mockResolvedValue(undefined);
  const methods: Partial<UploadRepository> = { findReservation, reserve, reserveDerived };
  const repository = new Proxy({} as UploadRepository, {
    get: (_target, key) =>
      methods[key as keyof UploadRepository] ??
      (() => {
        throw new Error('Unexpected repository call');
      }),
  });
  const manager = createUploadManagement({
    repository,
    identity: { authorize },
    resources: { assertSafe },
    now: () => 1000,
    newId: () => 'operation',
  });
  return { manager, findReservation, reserve, reserveDerived, authorize, assertSafe };
}

describe('private derived reservation manager', () => {
  it('uses the same admission port with a canonical private intent fingerprint', async () => {
    const f = fixture();
    const request = input();
    await expect(f.manager.reserveDerived(principal, request)).resolves.toEqual(operation);
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.assertSafe).toHaveBeenCalledWith({ phase: 'admission' });
    expect(f.reserveDerived).toHaveBeenCalledWith(
      principal,
      {
        ...request,
        scope: { kind: 'personal' },
        operationId: 'operation',
        fingerprint: uploadReservationFingerprint(
          { ...request, scope: { kind: 'personal' } },
          request.derived,
        ),
      },
      1000,
    );
  });
  it('returns an existing exact reservation before capacity admission and never recaptures', async () => {
    const f = fixture();
    f.findReservation.mockResolvedValue(operation);
    await expect(f.manager.reserveDerived(principal, input())).resolves.toEqual(operation);
    expect(f.assertSafe).not.toHaveBeenCalled();
    expect(f.reserveDerived).not.toHaveBeenCalled();
  });
  it('rejects private origin injection through ordinary reserve', async () => {
    const f = fixture();
    await expect(f.manager.reserve(principal, input())).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(f.authorize).not.toHaveBeenCalled();
  });
  it('rejects a missing derived intent', async () => {
    const f = fixture();
    const request = input();
    Reflect.deleteProperty(request, 'derived');
    await expect(f.manager.reserveDerived(principal, request)).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
  it.each([{ declaredBytes: 65_537 }, { mediaType: 'application/pdf' }])(
    'rejects unqualified derived body bounds %j before admission',
    async (change) => {
      const f = fixture();
      await expect(
        f.manager.reserveDerived(principal, { ...input(), ...change }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(f.reserveDerived).not.toHaveBeenCalled();
    },
  );
  it('does not invoke an intent getter', async () => {
    const f = fixture();
    const request = input();
    const getter = jest.fn();
    Object.defineProperty(request.derived, 'binding', { get: getter, enumerable: true });
    await expect(f.manager.reserveDerived(principal, request)).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it('detaches source arrays and binding before asynchronous identity authorization', async () => {
    const f = fixture();
    let release!: (value: boolean) => void;
    f.authorize.mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
    );
    const request = input();
    const pending = f.manager.reserveDerived(principal, request);
    request.derived.binding.sourceRevision = 42;
    request.derived.directSourceFileIds[0] = 'other';
    release(true);
    await pending;
    expect(f.reserveDerived.mock.calls[0][1].derived).toEqual(input().derived);
  });
});
