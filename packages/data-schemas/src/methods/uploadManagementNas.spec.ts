import { antivirusFixture } from '../../../data-provider/src/__fixtures__/upload-antivirus';
/** Real NAS repository transitions through an isolated persistence port; no Mongo/NAS/AV claim. */
import { createUploadNasMethods } from './uploadManagementNas';
import { mongo } from 'mongoose';
import { createUploadCleanupTransitions } from './uploadManagementCleanup';
import { validateNasUploadState, assertNasOriginalPublication } from './uploadManagementNasState';
import type { StoredUpload } from './uploadManagementState';
import type { UploadManagementContext } from './uploadManagementContext';
import type { NasOriginalObserver } from './uploadManagementNasTypes';

const now = Date.UTC(2026, 9, 30, 21, 0);
const lease = {
  tenantId: 'tenant',
  userId: 'user',
  operationId: 'operation',
  generation: 2,
  kind: 'transfer' as const,
  hostId: 'host',
  instanceId: 'instance',
  expiresAt: new Date(now + 45000).toISOString(),
};
const backend = {
  kind: 'nas-s3' as const,
  uid: 'nas-1',
  configurationSha256: 'c'.repeat(64),
  protocol: 'acknowledged-only-v1' as const,
};
const input = {
  backend,
  bucket: 'cortex-files',
  operationId: 'operation',
  generation: '2',
  bytes: 5,
  wholeSHA256: 'a'.repeat(64),
  mediaType: 'text/plain',
};
const integrity = {
  version: 1 as const,
  algorithm: 'sha256' as const,
  sha256: input.wholeSHA256,
  chunkBytes: 262144 as const,
  chunkSha256: ['b'.repeat(64)],
};
const antivirus = antivirusFixture(
  {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: 5,
    sha256: input.wholeSHA256,
  },
  now,
);
const execution = {
  version: 3 as const,
  antivirus: antivirus.custody,
  custody: { kind: 'none' as const },
  attemptId: 'operation.2',
  instanceId: '11111111-1111-4111-8111-111111111111',
  executionId: '22222222-2222-4222-8222-222222222222',
  expiresAt: new Date(now + 60000).toISOString(),
};
const policy = 'c'.repeat(64);
const approval = {
  version: 2 as const,
  antivirus: antivirus.approval,
  decision: 'approved' as const,
  policySha256: policy,
  subject: {
    tenantId: 'tenant',
    userId: 'user',
    operationId: 'operation',
    transferGeneration: 2,
    mediaType: 'text/plain',
    bytes: 5,
    sha256: input.wholeSHA256,
  },
  scannerVersion: 'fixture',
  checkedAt: new Date(now).toISOString(),
  coverage: { complete: true as const, pages: 1, parts: 1 },
};
const principal = { tenantId: 'tenant', userId: 'user', authentication: 'verified-email' as const };
const ack = {
  status: 200 as const,
  requestId: 'owned-request',
  etag: 'opaque',
  versionId: null,
  observedAt: now + 10,
};

function fixture(av = true) {
  let stored = {
    _id: 'operation',
    tenantId: 'tenant',
    userId: 'user',
    generation: 2,
    attemptGeneration: 2,
    workerGeneration: 2,
    slot: 'transfer',
    state: 'transferring',
    worker: { hostId: 'host', instanceId: 'instance' },
    leaseExpiresAt: now + 45000,
    declaredBytes: 5,
    mediaType: 'text/plain',
    securityExecution: execution,
    securitySettlement: {
      execution,
      writerStopped: true,
      transientDataRemoved: true,
      antivirusReceipt: antivirus.receipt,
    },
    writerStopped: true,
    stagingHeld: false,
    cleanupPending: true,
    originalBytes: 5,
    textBytes: 0,
    recordBytes: 65536,
    pendingBytes: 5,
    revision: 1,
    cleanupCustody: { version: 1 },
  } as StoredUpload;
  const copy = <T>(x: T): T => JSON.parse(JSON.stringify(x));
  const query = (value: () => unknown) => {
    const q = {
      session: () => q,
      maxTimeMS: () => q,
      lean: async () => copy(value()),
      then: (resolve: (x: unknown) => unknown) => Promise.resolve(copy(value())).then(resolve),
    };
    return q;
  };
  let lock = Promise.resolve();
  const global = { originalBytes: 5, objectBytes: 5, textBytes: 0, revision: 1 };
  const store = {
    Operation: {
      findById: () => query(() => stored),
      findOne: (where: Record<string, unknown>) =>
        query(() =>
          where.tenantId === stored.tenantId && where.userId === stored.userId ? stored : null,
        ),
    },
    save: jest.fn(async (row: StoredUpload) => {
      validateNasUploadState(row);
      stored = copy(row);
    }),
    transaction: async <T>(run: (s: unknown, g: unknown) => Promise<T>): Promise<T> => {
      const before = lock;
      let release!: () => void;
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await before;
      try {
        return await run({ fixture: true }, global);
      } finally {
        release();
      }
    },
    releaseQueue: jest.fn(),
  };
  const context = {
    store,
    securityPolicySha256: policy,
    ...(av ? { nasAntivirusAdmission: () => true } : {}),
    mongoose: { mongo, models: { File: { exists: () => query(() => null) } } },
  } as unknown as UploadManagementContext;
  const transitions = createUploadCleanupTransitions(store as never);
  context.applyCleanup = transitions.applyCleanup;
  const owner = () => createUploadNasMethods(context);
  const write = (dispatch: Parameters<ReturnType<typeof owner>['dispatchNasOriginalWrite']>[5]) =>
    owner().dispatchNasOriginalWrite(lease, input, integrity, approval, now, dispatch);
  return {
    owner,
    write,
    row: () => stored,
    global,
    store,
    cancel: () => transitions.terminal(stored, global as never, 'cancelled', 'cancelled'),
  };
}

it('persists intent before a single dispatch and prevents a concurrent/restarted second PUT', async () => {
  const f = fixture();
  let calls = 0;
  const run = async () =>
    f.write(async (binding, observed) => {
      calls++;
      expect(f.row().originalWrite?.state).toBe('intended');
      expect(binding.key).toMatch(/__original\.[a-f0-9-]{36}$/);
      await observed.acknowledge200(ack);
      await observed.verified(integrity);
    });
  const results = await Promise.all([run(), run()]);
  expect(calls).toBe(1);
  expect(results.map((r) => r.state).sort()).toEqual(['already-dispatched', 'verified']);
  await f.owner().dispatchNasOriginalWrite(lease, input, integrity, approval, now + 1, async () => {
    throw Error('must-not-dispatch');
  });
  expect(f.row().originalWrite?.state).toBe('verified');
});

it('keeps the genuine original recorder alive after cancel/lease expiry without granting replacement', async () => {
  const f = fixture();
  await f.write(async (_binding, observed) => {
    f.row().state = 'cancelled';
    f.row().generation++;
    f.row().leaseExpiresAt = now;
    await observed.acknowledge200(ack);
    await observed.verified(integrity);
  });
  expect(f.row().originalWrite?.response).toEqual(ack);
  await expect(f.write(async () => undefined)).rejects.toThrow('lease_lost');
});

it('retains lost ACK/crashed original as charged pending and never retries or deletes it', async () => {
  const f = fixture();
  await expect(
    f.write(async () => {
      throw Error('fixture-lost-ack');
    }),
  ).rejects.toThrow('fixture-lost-ack');
  expect(f.row().originalWrite?.state).toBe('unknown');
  const second = await f.write(async () => {
    throw Error('no-retry');
  });
  expect(second.state).toBe('already-dispatched');
  f.cancel();
  expect(f.row().pendingBytes).toBe(5);
  expect(
    await f.owner().dispatchNasCleanup(principal, 'operation', async () => {
      throw Error('no-delete');
    }),
  ).toBeNull();
  expect(f.row().originalBytes).toBe(5);
  expect(f.global.objectBytes).toBe(5);
});

it('never treats HEAD/expected digest or a serializable receipt as publication authority', async () => {
  const f = fixture();
  await f.write(async (_binding, observed) => {
    await observed.acknowledge200(ack);
  });
  const binding = f.row().writeBinding!;
  const receipt = {
    outcome: 'durable' as const,
    bytes: 5,
    source: 'nas-s3',
    filepath: '/owned',
    storageKey: binding.key,
    backend,
    integrity,
  };
  expect(() => assertNasOriginalPublication(f.row(), receipt)).toThrow('storage_uncertain');
  await expect(f.write(async () => undefined)).resolves.toMatchObject({
    state: 'already-dispatched',
  });
});

it('requires current AV authority and exact current worker before creating any NAS journal', async () => {
  const f = fixture(false);
  await expect(f.write(async () => undefined)).rejects.toThrow('security_uninspectable');
  expect(f.row().writeBinding).toBeUndefined();
  const g = fixture();
  await expect(
    g
      .owner()
      .dispatchNasOriginalWrite(
        { ...lease, instanceId: 'stale' },
        input,
        integrity,
        approval,
        now,
        async () => undefined,
      ),
  ).rejects.toThrow('lease_lost');
  expect(g.row().writeBinding).toBeUndefined();
});

it('retains an unexpected version ACK but refuses full verification/publication and cleanup', async () => {
  const f = fixture();
  await expect(
    f.write(async (_binding, observed) => {
      await observed.acknowledge200({ ...ack, versionId: 'unexpected-version' });
      await observed.verified(integrity);
    }),
  ).rejects.toThrow('storage_uncertain');
  expect(f.row().originalWrite?.state).toBe('acknowledged');
  f.row().state = 'cancelled';
  expect(
    await f.owner().dispatchNasCleanup(principal, 'operation', async () => undefined),
  ).toBeNull();
});

it('allows known terminal DELETE then absence and consumes only the repository-owned receipt', async () => {
  const f = fixture();
  await f.write(async (_binding, observed) => {
    await observed.acknowledge200(ack);
    await observed.verified(integrity);
  });
  f.row().state = 'cancelled';
  const receipt = await f
    .owner()
    .dispatchNasCleanup(principal, 'operation', async (_binding, observed) => {
      await observed.deleted(204);
      await observed.absent404();
    });
  expect(receipt).toMatchObject({
    protocol: 'nas-acknowledged-delete-v1',
    scope: 'nas-live-key-absent',
  });
  expect(f.row().originalBytes).toBe(5);
  expect(await f.owner().consumeNasCleanup(principal, 'operation')).toMatch(/^[a-f0-9-]{36}$/);
  expect(f.row().originalBytes).toBe(0);
  expect(f.global.objectBytes).toBe(0);
});

it('never consumes unknown DELETE from absence alone and does not remint its DELETE callback', async () => {
  const f = fixture();
  await f.write(async (_binding, observed) => {
    await observed.acknowledge200(ack);
  });
  f.row().state = 'cancelled';
  await expect(
    f.owner().dispatchNasCleanup(principal, 'operation', async (_binding, observed) => {
      await observed.absent404();
    }),
  ).rejects.toThrow('storage_uncertain');
  expect(f.row().cleanupCustody?.nas?.state).toBe('unknown');
  expect(
    await f.owner().dispatchNasCleanup(principal, 'operation', async () => {
      throw Error('no-retry');
    }),
  ).toBeNull();
  expect(await f.owner().consumeNasCleanup(principal, 'operation')).toBeNull();
  expect(f.global.objectBytes).toBe(5);
});

it('closes the original observer when its joined invocation finishes', async () => {
  const f = fixture();
  let captured!: NasOriginalObserver;
  await f.write(async (_binding, observed) => {
    captured = observed;
  });
  await expect(captured.acknowledge200(ack)).rejects.toThrow('NAS_ORIGINAL_CLOSED');
  expect(f.row().originalWrite?.state).toBe('unknown');
});

it('read-only absence can settle a known DELETE acknowledgement without another DELETE', async () => {
  const f = fixture();
  await f.write(async (_binding, observed) => {
    await observed.acknowledge200(ack);
  });
  f.cancel();
  await expect(
    f.owner().dispatchNasCleanup(principal, 'operation', async (_binding, observed) => {
      await observed.deleted(204);
      throw Error('fixture-lost-head');
    }),
  ).rejects.toThrow('fixture-lost-head');
  expect(f.row().cleanupCustody?.nas?.state).toBe('deleted');
  const head = jest.fn(async () => 404 as const);
  expect(await f.owner().observeNasCleanup(principal, 'operation', head)).not.toBeNull();
  expect(head).toHaveBeenCalledTimes(1);
  expect(await f.owner().consumeNasCleanup(principal, 'operation')).not.toBeNull();
  expect(f.row().pendingBytes).toBe(0);
});
it('unknown database commit before dispatch never forwards or retries the original', async () => {
  const f = fixture();
  const originalTransaction = f.store.transaction;
  let first = true;
  f.store.transaction = async (run) => {
    const result = await originalTransaction(run);
    if (first) {
      first = false;
      throw Error('fixture-commit-ack-lost');
    }
    return result;
  };
  const dispatch = jest.fn(async () => undefined);
  await expect(f.write(dispatch)).rejects.toThrow('fixture-commit-ack-lost');
  expect(dispatch).not.toHaveBeenCalled();
  expect(f.row().originalWrite?.state).toBe('intended');
  expect(await f.write(dispatch)).toMatchObject({ state: 'already-dispatched' });
  expect(dispatch).not.toHaveBeenCalled();
});

it('reserves maximum-file metadata growth before dispatch without a third integrity-vector copy', async () => {
  const f = fixture();
  const bytes = 31_457_280;
  f.row().declaredBytes = bytes;
  const full = { ...integrity, chunkSha256: Array(120).fill('b'.repeat(64)) };
  const fullAv = antivirusFixture({ ...approval.subject, bytes }, now);
  fullAv.custody.slot = 's'.repeat(128);
  fullAv.custody.podUid = 'p'.repeat(128);
  fullAv.custody.runtimeImage = `${'r'.repeat(952)}@sha256:${'1'.repeat(64)}`;
  fullAv.custody.original.pid = 2147483647;
  fullAv.custody.original.startTicks = '9'.repeat(20);
  fullAv.approval.engineVersion = 'v'.repeat(128);
  f.row().securityExecution = { ...execution, antivirus: fullAv.custody };
  f.row().securitySettlement = {
    execution: f.row().securityExecution!,
    writerStopped: true,
    transientDataRemoved: true,
    antivirusReceipt: fullAv.receipt,
  };
  const approved = {
    ...approval,
    scannerVersion: 'v'.repeat(128),
    subject: { ...approval.subject, bytes },
    antivirus: fullAv.approval,
  };
  f.row().promotion = {
    version: 1,
    promotionId: '77777777-7777-4777-8777-777777777777',
    lease: { ...lease },
    worker: { hostId: 'host', instanceId: 'instance' },
    metadata: { filename: '\u0800'.repeat(255) },
    approval: approved,
    integrity: full,
    state: 'prepared',
    writerStopped: true,
  };
  const dispatch = jest.fn(async (_binding, observed: NasOriginalObserver) => {
    await observed.notDispatched();
  });
  await f
    .owner()
    .dispatchNasOriginalWrite(lease, { ...input, bytes }, full, approved, now, dispatch);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(f.row().originalWrite?.state).toBe('not-dispatched');
  expect(f.row().originalWrite).not.toHaveProperty('integrity');
});
