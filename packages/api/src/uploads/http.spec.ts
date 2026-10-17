import express from 'express';
import { createServer, request } from 'node:http';
import type { UploadOperation, UploadPrincipal } from 'librechat-data-provider';
import type { Request, RequestHandler, Response } from 'express';
import type { Server } from 'node:http';
import { createUploadBodyRouter, createUploadHttpRouter } from './http';
import { UploadManagementError } from './errors';

const origin = 'https://uploads.example.test';
const user: UploadPrincipal = {
  tenantId: 'tenant',
  userId: 'user',
  authentication: 'verified-email',
};
const operation: UploadOperation = {
  version: 1,
  id: 'operation',
  revision: 1,
  scope: { kind: 'personal' },
  mediaType: 'text/plain',
  declaredBytes: 5,
  state: 'waiting',
  createdAt: new Date(0).toISOString(),
  cleanupPending: false,
  canUseInComposer: false,
  canRetryProcessing: false,
};
const usage = {
  limitBytes: 100,
  usedBytes: 0,
  reservedBytes: 5,
  availableBytes: 95,
  retainedBytes: 0,
  nextReleaseAt: null,
  nextReleaseBytes: 0,
};

describe('upload HTTP boundary', () => {
  let server: Server;
  let port: number;
  let strongPrincipal: jest.Mock;
  let management: Record<string, jest.Mock>;
  let projectAttachments: jest.Mock;
  let live: { open: jest.Mock };
  let body: jest.Mock;
  let admissionsPaused: boolean | null;
  let issueIntake: jest.Mock;

  beforeEach(async () => {
    admissionsPaused = false;
    issueIntake = jest.fn(async () => ({
      version: 1,
      operationId: 'operation',
      capability: 'A'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    strongPrincipal = jest.fn(async (req: Request) => {
      if (req.headers.authorization !== 'Bearer verified')
        throw new UploadManagementError('unauthorized');
      return user;
    });
    management = {
      list: jest.fn(async () => [operation]),
      usage: jest.fn(async () => usage),
      reserve: jest.fn(async () => operation),
      cancel: jest.fn(async () => operation),
      delete: jest.fn(async () => operation),
      retryProcessing: jest.fn(async () => operation),
    };
    projectAttachments = jest.fn(async () => new Map());
    live = {
      open: jest.fn(async (_req: Request, res: Response) => {
        res.status(200).end();
      }),
    };
    body = jest.fn(async (req: Request, res: Response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      res.status(202).json({ bytes: Buffer.concat(chunks).length, parsed: req.body !== undefined });
    });
    const options = {
      management: management as never,
      principal: strongPrincipal,
      allowedOrigins: [origin],
      projectAttachments,
      live,
      issueIntake,
      status: () => ({ throttled: false, waitingReason: null, admissionsPaused }),
    };
    const app = express();
    app.use(
      '/api/uploads',
      createUploadBodyRouter({
        principal: strongPrincipal,
        allowedOrigins: [origin],
        body: body as RequestHandler,
      }),
    );
    app.use('/api/uploads', createUploadHttpRouter(options));
    app.use(express.json({ limit: '1mb' }));
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('issues an operation-scoped ticket only through the authenticated same-origin metadata path', async () => {
    const response = await call('POST', '/api/uploads/operations/operation/intake', {});
    expect(response.status).toBe(200);
    expect(response.data).toMatchObject({ operationId: 'operation', capability: 'A'.repeat(43) });
    expect(issueIntake).toHaveBeenCalledWith(expect.anything(), user, 'operation');
  });

  it('rejects document metadata and a forged ticket operation before exposing a capability', async () => {
    expect(
      (await call('POST', '/api/uploads/operations/operation/intake', { filename: 'secret.txt' }))
        .status,
    ).toBe(400);
    expect(issueIntake).not.toHaveBeenCalled();
    issueIntake.mockResolvedValueOnce({
      version: 1,
      operationId: 'foreign',
      capability: 'A'.repeat(43),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect((await call('POST', '/api/uploads/operations/operation/intake', {})).status).toBe(503);
  });

  it('does not issue a ticket after session revocation while the issuer is awaiting storage', async () => {
    issueIntake.mockImplementationOnce(async () => {
      strongPrincipal.mockRejectedValueOnce(new UploadManagementError('unauthorized'));
      return {
        version: 1,
        operationId: 'operation',
        capability: 'A'.repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    });
    expect((await call('POST', '/api/uploads/operations/operation/intake', {})).status).toBe(401);
  });

  function call(
    method: string,
    path = '/api/uploads',
    payload?: unknown,
    headers: Record<string, string> = {},
  ) {
    let bytes: string | undefined;
    if (typeof payload === 'string') bytes = payload;
    else if (payload !== undefined) bytes = JSON.stringify(payload);
    return new Promise<{ status: number; data: unknown }>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            Origin: origin,
            Authorization: 'Bearer verified',
            ...(bytes === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes) }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('error', reject);
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            resolve({ status: res.statusCode!, data: text ? JSON.parse(text) : null });
          });
        },
      );
      req.on('error', reject);
      req.end(bytes);
    });
  }

  it('serves the same private snapshot for an admitted explicit-null guest and refuses identity drift', async () => {
    const guest = { authentication: 'guest', tenantId: null, userId: 'guest' } as const;
    strongPrincipal.mockResolvedValue(guest);
    expect((await call('GET')).status).toBe(200);
    expect(management.list).toHaveBeenCalledWith(guest);
    strongPrincipal
      .mockResolvedValueOnce(guest)
      .mockResolvedValueOnce({ ...guest, userId: 'other-guest' });
    expect((await call('GET')).status).toBe(401);
  });

  it('serves only the authenticated snapshot and strips private adapter fields', async () => {
    management.list.mockResolvedValue([
      { ...operation, storageKey: 'private/key', tenantId: 'private' },
    ]);
    management.usage.mockResolvedValue({ ...usage, privateCounter: 'hidden' });
    const result = await call('GET');
    expect(result.status).toBe(200);
    expect(result.data).toEqual({
      version: 1,
      operations: [operation],
      usage,
      throttled: false,
      waitingReason: null,
      admissionsPaused: false,
    });
    expect(strongPrincipal).toHaveBeenCalledTimes(2);
    expect(management.list).toHaveBeenCalledWith(user);
  });

  it('keeps retained operations and accepted actions available while admission is paused or unknown', async () => {
    for (const value of [true, null]) {
      admissionsPaused = value;
      const result = await call('GET');
      expect(result).toMatchObject({
        status: 200,
        data: { admissionsPaused: value, operations: [operation] },
      });
      expect((await call('POST', '/api/uploads/operations/operation/retry', {})).status).toBe(202);
      expect((await call('POST', '/api/uploads/operations/operation/cancel', {})).status).toBe(202);
      expect((await call('DELETE', '/api/uploads/operations/operation')).status).toBe(202);
    }
    management.reserve.mockRejectedValueOnce(new UploadManagementError('admission_paused'));
    expect(
      await call('POST', '/api/uploads/operations', {
        mediaType: 'text/plain',
        declaredBytes: 5,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual({ status: 503, data: { code: 'admission_paused' } });
  });
  it('discloses an exact filename only after acceptance, including when an adapter returns legacy metadata', async () => {
    const filename = ' Grüße 📄.txt ';
    management.list.mockResolvedValue([{ ...operation, filename }]);
    expect((await call('GET')).data).not.toHaveProperty('operations.0.filename');
    management.list.mockResolvedValue([
      { ...operation, filename, acceptedAt: new Date(1000).toISOString() },
    ]);
    expect((await call('GET')).data).toHaveProperty('operations.0.filename', filename);
    management.list.mockResolvedValue([
      { ...operation, filename: '../private', acceptedAt: new Date(1000).toISOString() },
    ]);
    expect((await call('GET')).data).not.toHaveProperty('operations.0.filename');
  });

  it('rechecks the current grant after asynchronous projection and before disclosure', async () => {
    projectAttachments.mockImplementationOnce(async () => {
      strongPrincipal.mockRejectedValueOnce(new UploadManagementError('unauthorized'));
      return new Map();
    });
    const result = await call('GET');
    expect(result).toEqual({ status: 401, data: { code: 'unauthorized' } });
  });

  it('requires File-authority projection before allowing composer use', async () => {
    management.list.mockResolvedValue([
      { ...operation, state: 'ready', fileId: 'file', canUseInComposer: true },
    ]);
    expect((await call('GET')).data).toHaveProperty('operations.0.canUseInComposer', false);
    const attachment = {
      file_id: 'file',
      filename: 'note.txt',
      filepath: '/api/files/file',
      type: 'text/plain',
      bytes: 5,
      source: 's3',
      privateKey: 'secret',
    };
    projectAttachments.mockResolvedValue(new Map([['file', attachment]]));
    const result = (await call('GET')).data;
    expect(result).toHaveProperty('operations.0.canUseInComposer', true);
    expect(result).toHaveProperty('operations.0.attachment.file_id', 'file');
    expect(result).not.toHaveProperty('operations.0.attachment.privateKey');
  });

  it('rejects guests, forged authority fields, queries, unknown metadata and oversized JSON', async () => {
    const input = {
      mediaType: 'text/plain',
      declaredBytes: 5,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };
    strongPrincipal.mockResolvedValueOnce({ ...user, authentication: 'guest' });
    expect((await call('GET')).status).toBe(401);
    for (const extra of [
      { tenantId: 'other' },
      { userId: 'other' },
      { generation: 9 },
      { unknown: true },
      { filename: 'private-title.txt' },
      { idempotencyKey: 'private-title.txt' },
      { idempotencyKey: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { idempotencyKey: '11111111-1111-1111-8111-111111111111' },
      {
        integrity: {
          version: 1,
          algorithm: 'sha256',
          sha256: '0'.repeat(64),
          chunkBytes: 262144,
          chunkSha256: ['0'.repeat(64)],
        },
      },
    ]) {
      expect((await call('POST', '/api/uploads/operations', { ...input, ...extra })).status).toBe(
        400,
      );
    }
    expect((await call('GET', '/api/uploads?userId=other')).status).toBe(400);
    expect(
      (await call('POST', '/api/uploads/operations', { ...input, filename: 'x'.repeat(5000) }))
        .status,
    ).toBe(400);
    expect(management.reserve).not.toHaveBeenCalled();
    expect((await call('POST', '/api/uploads/operations', input)).status).toBe(202);
    expect(management.reserve).toHaveBeenCalledWith(user, input);
  });

  it('applies exact origins and same-origin fetch metadata only to reads', async () => {
    expect(
      (await call('GET', '/api/uploads', undefined, { Origin: 'https://attacker.test' })).status,
    ).toBe(403);
    expect(
      (
        await call('GET', '/api/uploads', undefined, {
          Origin: '',
          'Sec-Fetch-Site': 'same-origin',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call('GET', '/api/uploads', undefined, { Origin: '', 'Sec-Fetch-Site': 'cross-site' }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          'POST',
          '/api/uploads/operations/operation/cancel',
          {},
          { Origin: '', 'Sec-Fetch-Site': 'same-origin' },
        )
      ).status,
    ).toBe(403);
    expect((await call('HEAD')).status).toBe(405);
  });

  it('maps actions to their existing owner with no supplied principal and sanitizes failure codes', async () => {
    expect((await call('POST', '/api/uploads/operations/operation/cancel', {})).status).toBe(202);
    expect((await call('POST', '/api/uploads/operations/operation/retry', {})).status).toBe(202);
    expect((await call('DELETE', '/api/uploads/operations/operation')).status).toBe(202);
    expect(management.cancel).toHaveBeenCalledWith(user, 'operation');
    expect(management.retryProcessing).toHaveBeenCalledWith(user, 'operation');
    expect(management.delete).toHaveBeenCalledWith(user, 'operation');
    management.list.mockRejectedValueOnce(new Error('mongodb://private-credential'));
    expect(await call('GET')).toEqual({ status: 503, data: { code: 'unavailable' } });
  });

  it.each(['security_rejected', 'security_uninspectable'] as const)(
    'returns safe HTTP 422 for %s from metadata admission and processing retry',
    async (code) => {
      const failure = Object.assign(new UploadManagementError(code), {
        reason: 'private-scanner-reason',
        scannerVersion: 'internal-revision',
        sha256: 'a'.repeat(64),
      });
      management.reserve.mockRejectedValueOnce(failure);
      expect(
        await call('POST', '/api/uploads/operations', {
          mediaType: 'text/plain',
          declaredBytes: 5,
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
        }),
      ).toEqual({ status: 422, data: { code } });
      management.retryProcessing.mockRejectedValueOnce(failure);
      expect(await call('POST', '/api/uploads/operations/operation/retry', {})).toEqual({
        status: 422,
        data: { code },
      });
    },
  );

  it.each(['security_rejected', 'security_uninspectable'] as const)(
    'preserves %s and pending cleanup on reload without disclosing scanner evidence',
    async (error) => {
      const publicRow = { ...operation, state: 'failed', error, cleanupPending: true };
      management.list.mockResolvedValue([
        {
          ...publicRow,
          securityApproval: { policySha256: 'a'.repeat(64), scannerVersion: 'internal-revision' },
          reason: 'private-scanner-reason',
        },
      ]);
      const result = await call('GET');
      expect(result.status).toBe(200);
      expect(result.data).toHaveProperty('operations', [publicRow]);
    },
  );

  it('uses the separate raw body router before a global parser and authenticates before reading', async () => {
    const payload = 'x'.repeat(5000);
    expect(
      await call('PUT', '/api/uploads/operations/operation/body', payload, {
        'Content-Type': 'application/octet-stream',
      }),
    ).toEqual({ status: 202, data: { bytes: 5000, parsed: false } });
    expect(
      (
        await call('PUT', '/api/uploads/operations/operation/body', payload, {
          Authorization: 'Bearer forged',
        })
      ).status,
    ).toBe(401);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it('routes events through the shared authenticated hub without projecting a per-connection snapshot', async () => {
    expect((await call('GET', '/api/uploads/events')).status).toBe(200);
    expect(live.open).toHaveBeenCalledWith(expect.anything(), expect.anything(), user);
    expect(management.list).not.toHaveBeenCalled();
  });
});
