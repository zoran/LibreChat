import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { readUploadPromotionRecord } from 'librechat-data-provider';
import type { UploadPromotionRecord, UploadPrincipal, UploadLease } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { UploadSecurityPort } from '../contract';
import type { IntakeChannel } from './channel';
import { createRemoteIntakeBodyHandler } from './remote';
import { createUploadAttemptJournal } from '../attempts';
import { UploadManagementError } from '../errors';

const now = Date.parse('2026-10-17T04:25:00.000Z');
const worker = { hostId: 'intake-host', instanceId: 'intake-instance' };
const appWorker = { hostId: 'app-host', instanceId: 'app-instance' };
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const capability = 'A'.repeat(43);
const expiresAt = '2026-10-17T04:30:00.000Z';
const principal: UploadPrincipal = {
  authentication: 'verified-email',
  tenantId: 'tenant',
  userId: 'a'.repeat(24),
};
const operation = (id: string) => ({
  version: 1,
  id,
  revision: 1,
  scope: { kind: 'personal' },
  mediaType: 'text/plain',
  declaredBytes: 5,
  state: 'transferring',
  createdAt: '2026-10-17T04:24:00.000Z',
  cleanupPending: true,
  canUseInComposer: false,
  canRetryProcessing: false,
});

describe('remote intake adapters with the real Raw lifecycle and controlled App/scanner doubles', () => {
  let root: string;
  beforeEach(async () => {
    if (!process.env.UPLOAD_TEST_TMPDIR) throw new Error('Explicit upload test directory required');
    await mkdir(process.env.UPLOAD_TEST_TMPDIR, { recursive: true });
    root = await mkdtemp(join(process.env.UPLOAD_TEST_TMPDIR, 'remote-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fixture() {
    const records = new Map<string, UploadPromotionRecord>();
    const events: string[] = [];
    const transmitted: Buffer[] = [];
    const control = jest.fn(
      async (input: Parameters<IntakeChannel['control']>[0]): Promise<unknown> => {
        const command = input.command as Record<string, unknown>;
        const action = command.action;
        events.push(String(action));
        if (action === 'authorize') return principal;
        if (action === 'claim')
          return {
            ...worker,
            tenantId: principal.tenantId,
            userId: principal.userId,
            operationId: input.operationId,
            generation: 1,
            kind: 'transfer',
            expiresAt,
          };
        if (action === 'claim-bytes')
          return { bytes: command.requestedBytes, generation: 1, expiresAt };
        if (
          action === 'complete-bytes' ||
          action === 'bind-security' ||
          action === 'settle-security'
        )
          return null;
        if (action === 'renew') return command.lease;
        if (action === 'prepare-promotion') {
          const record = readUploadPromotionRecord({
            ...(command.input as object),
            worker: appWorker,
            state: 'prepared',
            writerStopped: true,
          });
          if (!record) throw new Error('Invalid synthetic App input');
          records.set(input.operationId, record);
          return record;
        }
        if (action === 'get-promotion') return records.get(input.operationId);
        return operation(input.operationId);
      },
    );
    const promote = jest.fn(
      async (input: Parameters<IntakeChannel['promote']>[0]): Promise<unknown> => {
        events.push('promote');
        for await (const chunk of input.body) transmitted.push(Buffer.from(chunk));
        const prepared = records.get(input.operationId)!;
        const record = readUploadPromotionRecord({
          ...prepared,
          state: 'settled',
          writerStopped: true,
          receipt: {
            outcome: 'durable',
            bytes: 5,
            source: 's3',
            filepath: 'approved-original',
            storageKey: 'approved-original',
            integrity: prepared.integrity,
          },
        });
        if (!record) throw new Error('Invalid synthetic App settlement');
        records.set(input.operationId, record);
        return record;
      },
    );
    const security: UploadSecurityPort = {
      policySha256: 'a'.repeat(64),
      prepare: async ({ attemptId }) => ({
        version: 2,
        custody: { kind: 'none' as const },
        attemptId,
        instanceId: firstId,
        executionId: secondId,
        expiresAt,
      }),
      inspect: async ({ execution, subject, body }) => {
        for await (const _chunk of body) {
          /* Controlled scanner consumes every staged byte. */
        }
        return {
          decision: {
            version: 1,
            decision: 'approved',
            subject,
            policySha256: 'a'.repeat(64),
            scannerVersion: 'test-scanner/1',
            checkedAt: new Date(now).toISOString(),
            coverage: { complete: true, pages: 1, parts: 1 },
          },
          settlement: { execution, writerStopped: true, transientDataRemoved: true },
        };
      },
      cancel: async ({ execution }) => ({
        execution,
        writerStopped: true,
        transientDataRemoved: true,
      }),
    };
    const journal = createUploadAttemptJournal(worker);
    const handler = createRemoteIntakeBodyHandler({
      channel: { control, promote },
      worker,
      security,
      attempts: journal.attempts,
      stagingRoot: root,
      now: () => now,
      deadlineMs: 3000,
    });
    const request = (id = firstId, token = capability) => {
      const response = Object.assign(new EventEmitter(), {
        writableEnded: false,
        destroyed: false,
        headersSent: false,
        statusCode: 0,
        value: undefined as unknown,
        setHeader: jest.fn(),
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        json(value: unknown) {
          this.value = value;
          this.writableEnded = true;
          this.headersSent = true;
          return this;
        },
      });
      const req = Object.assign(new PassThrough(), {
        params: { id },
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '5',
          'x-upload-filename': 'note.txt',
          'x-upload-capability': token,
        },
        rawHeaders: [] as string[],
        body: undefined,
        res: response,
      });
      return {
        req,
        response,
        run: () =>
          Promise.resolve(
            handler(req as unknown as Request, response as unknown as Response, jest.fn()),
          ),
      };
    };
    return { handler, control, promote, records, events, transmitted, journal, security, request };
  }

  it('prepares before transmitting, forwards real approval, and accepts only the retrieved App promotion ID', async () => {
    const f = fixture();
    const test = f.request();
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.statusCode).toBe(202);
    expect(Buffer.concat(f.transmitted).toString()).toBe('hello');
    expect(f.events.indexOf('settle-security')).toBeLessThan(f.events.indexOf('prepare-promotion'));
    expect(f.events.indexOf('prepare-promotion')).toBeLessThan(f.events.indexOf('promote'));
    expect(f.events.indexOf('promote')).toBeLessThan(f.events.indexOf('get-promotion'));
    const commands = f.control.mock.calls.map(
      ([input]) => input.command as Record<string, unknown>,
    );
    const prepared = commands.find((command) => command.action === 'prepare-promotion')!;
    expect(prepared.input).not.toHaveProperty('worker');
    expect(prepared.input).toHaveProperty('approval.decision', 'approved');
    expect(prepared.input).toHaveProperty('metadata.filename', 'note.txt');
    const accepted = commands.find((command) => command.action === 'accept')!;
    expect(Object.keys(accepted).sort()).toEqual(['action', 'dispatch', 'lease', 'promotionId']);
    expect(accepted.dispatch).toBeNull();
    expect(accepted.promotionId).toBe(f.records.get(firstId)?.promotionId);
    expect(await readdir(root)).toEqual([]);
    expect(await f.journal.close()).toEqual({ complete: true });
  });
  it.each(['duplicate', 'cookie', 'authorization', 'malformed'])(
    'rejects %s request credentials before any Channel call',
    async (kind) => {
      const f = fixture();
      const test = f.request();
      if (kind === 'duplicate')
        test.req.rawHeaders = [
          'X-Upload-Capability',
          capability,
          'x-upload-capability',
          capability,
        ];
      if (kind === 'cookie' || kind === 'authorization')
        Object.assign(test.req.headers, { [kind]: 'private-credential' });
      if (kind === 'malformed') test.req.headers['x-upload-capability'] = 'wrong';
      await expect(f.handler.principal(test.req as unknown as Request)).rejects.toBeInstanceOf(
        UploadManagementError,
      );
      expect(f.control).not.toHaveBeenCalled();
      expect(f.promote).not.toHaveBeenCalled();
      test.req.destroy();
      expect(await f.journal.close()).toEqual({ complete: true });
    },
  );
  it('retains separate frozen operation/capability contexts for concurrent requests', async () => {
    const f = fixture();
    const one = f.request();
    const two = f.request(secondId, 'E'.repeat(42) + 'A');
    await Promise.all([
      f.handler.principal(one.req as unknown as Request),
      f.handler.principal(two.req as unknown as Request),
    ]);
    one.req.headers['x-upload-capability'] = 'corrupted';
    const pending = [one.run(), two.run()];
    one.req.end('hello');
    two.req.end('hello');
    await Promise.all(pending);
    expect(one.response.statusCode).toBe(202);
    expect(two.response.statusCode).toBe(202);
    for (const [input] of f.control.mock.calls)
      expect(input.capability).toBe(
        input.operationId === firstId ? capability : 'E'.repeat(42) + 'A',
      );
    expect(f.records.size).toBe(2);
    expect(await f.journal.close()).toEqual({ complete: true });
  });
  it.each(['prepare-denied', 'wrong-record', 'unknown-promotion', 'missing-record'])(
    'never accepts after %s',
    async (kind) => {
      const f = fixture();
      const test = f.request();
      const control = f.control.getMockImplementation()!;
      f.control.mockImplementation(async (input) => {
        const command = input.command as Record<string, unknown>;
        if (kind === 'prepare-denied' && command.action === 'prepare-promotion')
          throw new UploadManagementError('security_uninspectable');
        if (kind === 'missing-record' && command.action === 'get-promotion') return null;
        const result = await control(input);
        if (kind === 'wrong-record' && command.action === 'prepare-promotion')
          return { ...(result as object), promotionId: secondId };
        return result;
      });
      if (kind === 'unknown-promotion')
        f.promote.mockRejectedValueOnce(new UploadManagementError('unavailable'));
      const done = test.run();
      test.req.end('hello');
      await done;
      expect(test.response.statusCode).not.toBe(202);
      expect(
        f.control.mock.calls.some(
          ([input]) => (input.command as { action: string }).action === 'accept',
        ),
      ).toBe(false);
      if (kind === 'prepare-denied' || kind === 'wrong-record')
        expect(f.promote).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
      expect(await f.journal.close()).toEqual({ complete: kind === 'missing-record' });
    },
  );
  it('rejects a foreign claimed worker before staging or scanner input', async () => {
    const f = fixture();
    const test = f.request();
    const original = f.control.getMockImplementation()!;
    f.control.mockImplementation(async (input) => {
      const result = await original(input);
      return (input.command as { action: string }).action === 'claim'
        ? { ...(result as UploadLease), instanceId: 'foreign' }
        : result;
    });
    const done = test.run();
    test.req.end('hello');
    await done;
    expect(test.response.value).toEqual({ code: 'lease_lost' });
    expect(f.promote).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    // A foreign reply cannot prove that the dispatched remote claim never acquired a lease.
    expect(await f.journal.maintenance.getMaintenanceCensus(null)).toMatchObject({
      queuedContinuations: 0,
      pendingWrites: 0,
      complete: false,
    });
    expect(await f.journal.close()).toEqual({ complete: false });
  });
  it('does not revive a disconnected request after a late authorization response', async () => {
    const f = fixture();
    const test = f.request();
    let finish!: (value: unknown) => void;
    f.control.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.handler.principal(test.req as unknown as Request);
    test.req.emit('aborted');
    finish(principal);
    await expect(pending).rejects.toBeDefined();
    expect(f.promote).not.toHaveBeenCalled();
    test.req.destroy();
    expect(await f.journal.close()).toEqual({ complete: true });
  });
  it('piggybacks the last real process observation on existing App commands without another request', async () => {
    const f = fixture();
    const { createUploadOcrDispatchCounts } = await import('librechat-data-provider');
    const observation = {
      version: 1 as const,
      source: { instanceId: firstId, pid: 10, startedAt: now - 1000 },
      observedAt: now,
      counts: createUploadOcrDispatchCounts(),
    };
    f.security.dispatchObservation = () => observation;
    const test = f.request();
    const pending = test.run();
    test.req.end('hello');
    await pending;
    expect(test.response.statusCode).toBe(202);
    expect(
      f.control.mock.calls.every(
        ([input]) =>
          typeof input.command === 'object' &&
          input.command !== null &&
          'dispatch' in input.command &&
          JSON.stringify(input.command.dispatch) === JSON.stringify(observation),
      ),
    ).toBe(true);
    expect(f.events).not.toContain('security-dispatch');
    expect(await f.journal.close()).toEqual({ complete: true });
  });
});
