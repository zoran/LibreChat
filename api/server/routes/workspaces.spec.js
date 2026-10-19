const express = require('express');
const request = require('supertest');
const { createWorkspaceRouter } = require('./workspaces');
const { createManagedSourceResolver } = jest.requireActual('@librechat/api');

describe('Workspace metadata API on the native upload boundary', () => {
  const principal = {
    authentication: 'verified-email',
    tenantId: 'test',
    userId: '111111111111111111111111',
  };
  const workspace = {
    workspaceId: 'draft',
    title: 'Neuer Entwurf',
    format: 'markdown',
    revision: 0,
    headFileId: null,
    createdAt: '2026-10-17T00:00:00.000Z',
    updatedAt: '2026-10-17T00:00:00.000Z',
    expiresAt: null,
  };
  const binding = { purpose: 'workspace-draft', sourceId: 'draft', sourceRevision: 0 };
  const operation = {
    version: 1,
    id: 'operation',
    revision: 1,
    scope: { kind: 'personal' },
    mediaType: 'text/plain',
    declaredBytes: 8,
    state: 'reserved',
    createdAt: workspace.createdAt,
    cleanupPending: false,
    canUseInComposer: false,
    canRetryProcessing: false,
  };
  let app;
  let methods;
  let runtime;
  let original;
  let active;
  const jsonPost = (path, body) =>
    request(app)
      .post('/api/workspaces' + path)
      .set('Origin', 'https://cortex.test')
      .send(body);
  const get = (path) =>
    request(app)
      .get('/api/workspaces' + path)
      .set('Sec-Fetch-Site', 'same-origin');
  beforeEach(() => {
    active = true;
    methods = {
      createDocumentWorkspace: jest.fn().mockResolvedValue(workspace),
      listDocumentWorkspaces: jest
        .fn()
        .mockResolvedValue({ workspaces: [workspace], nextCursor: null }),
      getDocumentWorkspace: jest.fn().mockResolvedValue(workspace),
      getDocumentWorkspaceSaveIntent: jest
        .fn()
        .mockResolvedValue({ binding, directSourceFileIds: ['approved-source'] }),
      commitDocumentWorkspaceVersion: jest.fn().mockResolvedValue({
        workspaceId: 'draft',
        revision: 1,
        fileId: 'operation',
        createdAt: workspace.createdAt,
        expiresAt: '2026-11-14T00:00:00.000Z',
      }),
    };
    runtime = {
      allowedOrigins: ['https://cortex.test'],
      principal: jest.fn().mockResolvedValue(principal),
      management: { reserveDerived: jest.fn().mockResolvedValue(operation) },
      repository: { getDerivedOperation: jest.fn().mockResolvedValue(operation) },
    };
    // Use the production source authorizer for this authorization-only consumer.
    runtime.sources = createManagedSourceResolver({
      allowedOrigins: runtime.allowedOrigins,
      principal: (req) => runtime.principal(req),
    });
    original = {
      read: jest
        .fn()
        .mockResolvedValue({ bytes: Buffer.from('approved'), mediaType: 'text/plain' }),
    };
    app = express();
    app.use(
      '/api/workspaces',
      createWorkspaceRouter({
        enabled: () => active,
        methods,
        original,
        getRuntime: () => runtime,
        runAsSystem: (fn) => fn(),
      }),
    );
    app.use(express.json());
  });
  it('creates and lists private metadata without invoking any document byte path', async () => {
    expect((await jsonPost('', { format: 'markdown' })).status).toBe(201);
    expect(methods.createDocumentWorkspace).toHaveBeenCalledWith(
      { userId: principal.userId, tenantId: 'test' },
      'markdown',
    );
    const response = await get('');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toEqual({ workspaces: [workspace], nextCursor: null });
    expect(runtime.management.reserveDerived).not.toHaveBeenCalled();
    expect(original.read).not.toHaveBeenCalled();
  });
  it.each([
    ['flag', 503],
    ['guest', 404],
    ['foreign-origin', 404],
  ])('closes %s before metadata work', async (kind, status) => {
    if (kind === 'flag') active = false;
    if (kind === 'guest')
      runtime.principal.mockResolvedValue({
        authentication: 'guest',
        tenantId: null,
        userId: principal.userId,
      });
    const response =
      kind === 'foreign-origin'
        ? await request(app)
            .post('/api/workspaces')
            .set('Origin', 'https://other.test')
            .send({ format: 'text' })
        : await jsonPost('', { format: 'text' });
    expect(response.status).toBe(status);
    expect(methods.createDocumentWorkspace).not.toHaveBeenCalled();
  });
  it('rejects document content, owner overrides and oversized metadata before reservation', async () => {
    for (const extra of [
      { text: 'untrusted content' },
      { userId: 'other' },
      { derived: { directSourceFileIds: [] } },
    ]) {
      const result = await jsonPost('/draft/saves', {
        baseRevision: 0,
        declaredBytes: 8,
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        ...extra,
      });
      expect(result.status).toBe(400);
    }
    expect((await jsonPost('', { format: 'markdown', text: 'x'.repeat(5000) })).status).toBe(400);
    expect(runtime.management.reserveDerived).not.toHaveBeenCalled();
  });
  it('passes only server-captured source scope into the existing derived reservation', async () => {
    const body = {
      baseRevision: 0,
      declaredBytes: 8,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    };
    expect((await jsonPost('/draft/saves', body)).status).toBe(202);
    expect(runtime.management.reserveDerived).toHaveBeenCalledWith(principal, {
      mediaType: 'text/plain',
      declaredBytes: 8,
      idempotencyKey: body.idempotencyKey,
      derived: { binding, directSourceFileIds: ['approved-source'] },
    });
    expect(original.read).not.toHaveBeenCalled();
  });
  it('polls only an operation bound to the authorized saved revision', async () => {
    expect((await get('/draft/saves/operation?baseRevision=0')).body).toEqual(operation);
    expect(runtime.repository.getDerivedOperation).toHaveBeenCalledWith(
      principal,
      'operation',
      binding,
      expect.any(Number),
    );
    expect((await get('/draft/saves/operation?baseRevision=-1')).status).toBe(400);
    expect((await get('/draft/saves/operation?baseRevision=0&tenantId=other')).status).toBe(400);
  });
  it.each([
    ['capacity_exceeded', 429],
    ['not_found', 404],
  ])('preserves the reservation error %s as HTTP %s', async (code, status) => {
    runtime.management.reserveDerived.mockRejectedValueOnce(
      Object.assign(new Error(code), { code }),
    );
    const response = await jsonPost('/draft/saves', {
      baseRevision: 0,
      declaredBytes: 8,
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    });
    expect(response.status).toBe(status);
    expect(response.body).toEqual({ code });
    expect(methods.commitDocumentWorkspaceVersion).not.toHaveBeenCalled();
    expect(original.read).not.toHaveBeenCalled();
  });
  it('rejects a stale source before reservation', async () => {
    methods.getDocumentWorkspaceSaveIntent.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'revision_conflict' }),
    );
    expect(
      (
        await jsonPost('/draft/saves', {
          baseRevision: 0,
          declaredBytes: 8,
          idempotencyKey: '11111111-1111-4111-8111-111111111111',
        })
      ).status,
    ).toBe(409);
    expect(runtime.management.reserveDerived).not.toHaveBeenCalled();
  });
  it('acknowledges the committed immutable File and returns original bytes through the trusted reader', async () => {
    const saved = { ...workspace, revision: 1, headFileId: 'operation' };
    methods.getDocumentWorkspace.mockResolvedValue(saved);
    expect(
      (await jsonPost('/draft/revisions', { baseRevision: 0, fileId: 'operation' })).body,
    ).toEqual(await methods.commitDocumentWorkspaceVersion.mock.results[0].value);
    expect(methods.getDocumentWorkspace).not.toHaveBeenCalled();
    const response = await get('/draft/revisions/1/content');
    expect(response.status).toBe(200);
    expect(response.body).toEqual(Buffer.from('approved'));
    expect(original.read).toHaveBeenCalledWith(expect.anything(), 'draft', 1);
    expect(response.headers['content-type']).toBe('application/octet-stream');
  });
  it('acknowledges an immutable receipt even after the head advances', async () => {
    methods.getDocumentWorkspace.mockResolvedValue({
      ...workspace,
      revision: 2,
      headFileId: 'newer',
    });
    const response = await jsonPost('/draft/revisions', { baseRevision: 0, fileId: 'operation' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ workspaceId: 'draft', revision: 1, fileId: 'operation' });
    expect(response.body).not.toHaveProperty('headFileId');
    expect(methods.getDocumentWorkspace).not.toHaveBeenCalled();
  });
  it('rechecks identity after an asynchronous metadata read', async () => {
    methods.getDocumentWorkspace.mockImplementation(async () => {
      runtime.principal.mockResolvedValue({ ...principal, userId: '222222222222222222222222' });
      return workspace;
    });
    const response = await get('/draft');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'not_found' });
  });
  it('does not let an in-place principal change replace the captured request owner', async () => {
    const identity = { ...principal };
    runtime.principal.mockResolvedValue(identity);
    methods.getDocumentWorkspace.mockImplementation(async () => {
      identity.userId = '222222222222222222222222';
      return workspace;
    });
    const response = await get('/draft');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'not_found' });
  });
  it('does not accept a composition after a global body parser', async () => {
    const invalid = express();
    invalid.use(express.json());
    invalid.use(
      '/api/workspaces',
      createWorkspaceRouter({
        enabled: () => active,
        methods,
        original,
        getRuntime: () => runtime,
      }),
    );
    expect(
      (
        await request(invalid)
          .post('/api/workspaces')
          .set('Origin', 'https://cortex.test')
          .send({ format: 'text' })
      ).status,
    ).toBe(400);
    expect(methods.createDocumentWorkspace).not.toHaveBeenCalled();
  });
});
