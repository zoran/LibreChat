import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppMaintenance, ApplicationWorkPort } from './maintenance';
import { createUploadAttemptJournal } from '../uploads/attempts';
import { createWorkloadMaintenance } from './maintenance';
import { createMaintenanceIdentity } from './identity';

const env = {
  LIBRECHAT_MAINTENANCE_TOKEN: 'w'.repeat(32),
  POD_UID: '12345678-1234-1234-1234-123456789012',
  BUILD_COMMIT: 'b'.repeat(40),
};
const identity = createMaintenanceIdentity(env, true);
const worker = { hostId: 'intake-host', instanceId: identity.incarnation };
const request = (app: AppMaintenance, expectedRevision = 0) => ({
  requestId: 'rotation',
  expectedRevision,
  identity: app.identity,
});
const stopped = { writerStopped: true, localCopiesAbsent: true, storageOutcome: 'absent' as const };

/** Controllable census port only for malformed/late observation cases, not a DB/provider fake. */
function observedOwner(): ApplicationWorkPort & {
  getMaintenanceCensus: jest.MockedFunction<ApplicationWorkPort['getMaintenanceCensus']>;
} {
  let paused: string | null = null;
  return {
    pauseAdmissions: (id) => {
      paused = id;
      return true;
    },
    resumeAdmissions: () => {
      paused = null;
      return true;
    },
    getMaintenanceCensus: jest.fn(async (id) => ({
      admissionClosed: id !== null && id === paused,
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: true,
    })),
  };
}
function options(owner = observedOwner()) {
  return { env, identity, workOwners: { owner }, startupReady: () => true };
}
async function http(
  app: AppMaintenance,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  remoteAddress = '127.0.0.1',
) {
  const req = Object.assign(
    Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
    {
      method,
      url,
      headers: {
        authorization: `Bearer ${env.LIBRECHAT_MAINTENANCE_TOKEN}`,
        'content-type': 'application/json',
        ...headers,
      },
      socket: { remoteAddress },
    },
  );
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    let status = 0;
    const res = {
      headersSent: false,
      writeHead: (code: number) => {
        status = code;
      },
      end: (value: string) => resolve({ status, body: JSON.parse(value) }),
    };
    app.handler(req as unknown as IncomingMessage, res as unknown as ServerResponse);
  });
}

describe('generation-free native workload maintenance', () => {
  it('drains the actual attempt owner while reporting absent generation work as zero', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(() => {});
    registration.bind({ ...worker, operationId: 'upload', generation: 1 });
    const app = createWorkloadMaintenance({
      env,
      identity,
      workOwners: { attempts: journal.maintenance },
      startupReady: () => true,
    });
    try {
      expect(app.identity).toEqual(identity);
      expect(await app.ready()).toBe(true);
      expect(await app.status()).toMatchObject({
        known: true,
        phase: 'running',
        census: {
          initializing: 0,
          providerExecutions: 0,
          activeStreams: 0,
          unresolved: 0,
          queuedContinuations: 0,
          pendingWrites: 1,
        },
      });
      expect(app.operation('begin', request(app))).toBe(200);
      expect(() => journal.attempts.begin(() => {})).toThrow();
      expect(await app.ready()).toBe(false);
      expect(await app.status()).toMatchObject({ known: true, phase: 'quiescing' });
      registration.settle(stopped);
      expect(await app.status()).toMatchObject({ known: true, phase: 'drained' });
      expect(app.operation('cancel', request(app, 1))).toBe(200);
      expect(app.operation('cancel', request(app, 1))).toBe(200);
      expect(app.operation('begin', request(app))).toBe(409);
      expect(await app.ready()).toBe(true);
    } finally {
      registration.settle(stopped);
      expect(await journal.close()).toEqual({ complete: true });
      await app.close();
    }
  });

  it('keeps actual unresolved writer evidence unknown without treating busy census as liveness', async () => {
    const journal = createUploadAttemptJournal(worker);
    const registration = journal.attempts.begin(() => {});
    registration.bind({ ...worker, operationId: 'unknown', generation: 1 });
    registration.settle({ writerStopped: false, localCopiesAbsent: false });
    const app = createWorkloadMaintenance({
      ...options(),
      workOwners: { attempts: journal.maintenance },
    });
    expect(await app.ready()).toBe(true);
    expect(await app.status()).toMatchObject({ known: false, census: null });
    expect(app.operation('begin', request(app))).toBe(200);
    expect(await app.status()).toMatchObject({ known: false, phase: 'quiescing' });
    expect(app.operation('cancel', request(app, 1))).toBe(503);
    expect(await app.ready()).toBe(false);
    expect(await journal.close(AbortSignal.abort())).toEqual({ complete: false });
    await app.close();
  });

  it.each([
    { env: { ...env, LIBRECHAT_MAINTENANCE_TOKEN: undefined } },
    { env: { ...env, LIBRECHAT_MAINTENANCE_TOKEN: '' } },
    { env: { ...env, LIBRECHAT_MAINTENANCE_PORT: '0' } },
    { env: { ...env, POD_UID: 'different' } },
    { env: { ...env, BUILD_COMMIT: 'c'.repeat(40) } },
    { identity: { ...identity, incarnation: '' } },
    { identity: { ...identity, unexpected: true } },
    { workOwners: {} },
    { workOwners: { incomplete: { pauseAdmissions: () => true } } },
  ])('rejects incomplete or inconsistent native composition %j', (change) => {
    expect(() => createWorkloadMaintenance({ ...options(), ...change } as never)).toThrow(
      /Invalid (workload|private) maintenance configuration/,
    );
  });

  it('snapshots the supplied identity and owner set without generating a second incarnation', async () => {
    const inputIdentity = { ...identity };
    const owner = observedOwner();
    const workOwners = { owner };
    const app = createWorkloadMaintenance({
      ...options(owner),
      identity: inputIdentity,
      workOwners,
    });
    inputIdentity.incarnation = 'changed';
    Reflect.deleteProperty(workOwners, 'owner');
    expect(app.identity).toEqual(identity);
    expect(Object.isFrozen(app.identity)).toBe(true);
    expect(app.operation('begin', request(app))).toBe(200);
    expect(await app.status()).toMatchObject({ known: true, phase: 'drained' });
    expect(owner.getMaintenanceCensus).toHaveBeenCalledWith('rotation');
    await app.close();
  });

  it('retains uncertainty after a failed pause and attempts all actual work owners', async () => {
    const a = observedOwner();
    const b = observedOwner();
    a.pauseAdmissions = () => {
      throw new Error('owner unavailable');
    };
    const paused = jest.spyOn(b, 'pauseAdmissions');
    const app = createWorkloadMaintenance({ ...options(), workOwners: { a, b } });
    expect(app.operation('begin', request(app))).toBe(503);
    expect(paused).toHaveBeenCalledWith('rotation');
    expect(await app.status()).toMatchObject({ known: false, phase: 'quiescing' });
    expect(app.operation('cancel', request(app, 1))).toBe(409);
    expect(await app.ready()).toBe(false);
    await app.close();
  });

  it('rejects a late census across cancellation and bounds an unresponsive owner', async () => {
    const owner = observedOwner();
    const app = createWorkloadMaintenance(options(owner));
    app.operation('begin', request(app));
    let finish!: (value: Awaited<ReturnType<ApplicationWorkPort['getMaintenanceCensus']>>) => void;
    owner.getMaintenanceCensus.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = app.status();
    await Promise.resolve();
    expect(app.operation('cancel', request(app, 1))).toBe(200);
    finish({ admissionClosed: true, queuedContinuations: 0, pendingWrites: 0, complete: true });
    expect(await pending).toMatchObject({ known: false, phase: 'running', census: null });
    jest.useFakeTimers();
    try {
      owner.getMaintenanceCensus.mockImplementationOnce(() => new Promise(() => {}));
      const status = app.status();
      await jest.advanceTimersByTimeAsync(2100);
      expect(await status).toMatchObject({ known: false, census: null });
      expect(await app.ready()).toBe(true);
    } finally {
      jest.useRealTimers();
      await app.close();
    }
  });

  it('reuses private HTTP authentication, exact identity and startup readiness', async () => {
    let started = false;
    const app = createWorkloadMaintenance({ ...options(), startupReady: () => started });
    expect((await http(app, 'GET', '/readyz')).status).toBe(503);
    started = true;
    expect((await http(app, 'GET', '/readyz', undefined, { authorization: '' })).status).toBe(200);
    expect((await http(app, 'GET', '/status', undefined, {}, '10.0.0.1')).status).toBe(403);
    expect(
      (await http(app, 'GET', '/status', undefined, { authorization: 'Bearer wrong' })).status,
    ).toBe(403);
    expect(
      (await http(app, 'POST', '/begin', request(app), { cookie: 'session=browser' })).status,
    ).toBe(403);
    expect(
      (
        await http(app, 'POST', '/begin', {
          ...request(app),
          identity: { ...identity, incarnation: 'foreign' },
        })
      ).status,
    ).toBe(400);
    expect((await http(app, 'GET', '/status')).body.identity).toEqual(identity);
    expect((await http(app, 'POST', '/begin', request(app))).body.phase).toBe('drained');
    expect((await http(app, 'POST', '/cancel', request(app, 1))).body.phase).toBe('running');
    await app.close();
  });
});
