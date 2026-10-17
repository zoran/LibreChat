const express = require('express');
const { runAsSystem } = require('@librechat/data-schemas');
const { createManagedFileHandlers } = require('./files/managed');
const { createWorkspaceOriginalReader } = require('~/server/services/Workspace/original');
const { createWorkspaceLimiters } = require('~/server/middleware/limiters/workspaceLimiters');

const failure = (code) => Object.assign(new Error(code), { code });
const enabled = () => process.env.CORTEX_DOCUMENT_WORKSPACE_ENABLED === 'true';
const runtime = () => require('~/server/services/Uploads').getUploadRuntime();
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const revision = (value) => Number.isSafeInteger(value) && value >= 0;
const exact = (value, keys) => {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw failure('invalid_request');
};

/** Only bounded metadata reaches this router; document bytes use the native isolated intake. */
function createWorkspaceRouter(options = {}) {
  const router = express.Router();
  const isEnabled = options.enabled ?? enabled;
  const getRuntime = options.getRuntime ?? runtime;
  const methods = options.methods ?? require('~/models');
  const system = options.runAsSystem ?? runAsSystem;
  const authorization = createManagedFileHandlers({ getRuntime });
  const original =
    options.original ??
    createWorkspaceOriginalReader({
      getRuntime,
      authorize,
      getDocumentWorkspaceVersionFile: methods.getDocumentWorkspaceVersionFile,
      runAsSystem: system,
    });
  const identities = new WeakMap();
  const parse = express.json({ limit: 4096, strict: true, inflate: false });
  const owner = (principal) => ({ userId: principal.userId, tenantId: principal.tenantId });

  function sendFailure(res, error) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const code = error?.code;
    const statuses = {
      invalid_request: 400,
      unauthorized: 401,
      forbidden: 404,
      not_found: 404,
      source_unavailable: 404,
      principal_unavailable: 404,
      revision_conflict: 409,
      security_rejected: 422,
      security_uninspectable: 422,
      quota_exceeded: 429,
      queue_full: 429,
      capacity_exceeded: 429,
      admission_paused: 503,
    };
    const safe = Object.hasOwn(statuses, code) ? code : 'unavailable';
    res
      .status(statuses[safe] ?? 503)
      .json({ code: ['forbidden', 'principal_unavailable'].includes(safe) ? 'not_found' : safe });
  }
  async function authorize(req) {
    if (!isEnabled() || !getRuntime()) throw failure('unavailable');
    const user = await authorization.authorize(req);
    if (user.authentication !== 'verified-email') throw failure('not_found');
    const previous = identities.get(req);
    if (
      previous &&
      (previous.userId !== user.userId ||
        previous.tenantId !== user.tenantId ||
        previous.authentication !== user.authentication)
    )
      throw failure('not_found');
    const captured = Object.freeze({
      userId: user.userId,
      tenantId: user.tenantId,
      authentication: user.authentication,
    });
    identities.set(req, captured);
    return captured;
  }
  const wrap = (action) => (req, res) =>
    Promise.resolve()
      .then(async () => {
        const user = await authorize(req);
        await action(req, res, user);
      })
      .catch((error) => sendFailure(res, error));
  async function json(req, res, value, status = 200) {
    await authorize(req);
    res.status(status).json(value);
  }
  const metadata = (req, res, next) => {
    if (
      req.body !== undefined ||
      !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')
    ) {
      sendFailure(res, failure('invalid_request'));
      return;
    }
    parse(req, res, (error) => (error ? sendFailure(res, failure('invalid_request')) : next()));
  };
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (
      req.method === 'GET' &&
      (req.body !== undefined ||
        req.headers['transfer-encoding'] ||
        (req.headers['content-length'] && req.headers['content-length'] !== '0'))
    ) {
      sendFailure(res, failure('invalid_request'));
      return;
    }
    authorize(req).then(
      () => next(),
      (error) => sendFailure(res, error),
    );
  });
  const limits = createWorkspaceLimiters((req) => identities.get(req));
  router.use(limits.read, limits.write);
  router.get(
    '/',
    wrap(async (req, res, user) => {
      exact(req.query, ['before']);
      if (req.query.before !== undefined && !id(req.query.before)) throw failure('invalid_request');
      await json(
        req,
        res,
        await system(() => methods.listDocumentWorkspaces(owner(user), req.query.before)),
      );
    }),
  );
  router.post(
    '/',
    metadata,
    wrap(async (req, res, user) => {
      exact(req.query, []);
      exact(req.body, ['format']);
      if (!['markdown', 'text'].includes(req.body.format)) throw failure('invalid_request');
      await json(
        req,
        res,
        await system(() => methods.createDocumentWorkspace(owner(user), req.body.format)),
        201,
      );
    }),
  );
  router.param('workspaceId', (req, res, next, value) =>
    id(value) ? next() : sendFailure(res, failure('invalid_request')),
  );
  router.get(
    '/:workspaceId',
    wrap(async (req, res, user) => {
      exact(req.query, []);
      await json(
        req,
        res,
        await system(() => methods.getDocumentWorkspace(owner(user), req.params.workspaceId)),
      );
    }),
  );
  router.get(
    '/:workspaceId/revisions/:revision/content',
    wrap(async (req, res) => {
      exact(req.query, []);
      if (!/^[1-9][0-9]*$/.test(req.params.revision) || !revision(Number(req.params.revision)))
        throw failure('invalid_request');
      const result = await original.read(req, req.params.workspaceId, Number(req.params.revision));
      if (!isEnabled() || !getRuntime()) throw failure('unavailable');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', 'attachment; filename="entwurf.txt"');
      res.send(result.bytes);
    }),
  );
  router.post(
    '/:workspaceId/saves',
    metadata,
    wrap(async (req, res, user) => {
      exact(req.query, []);
      exact(req.body, ['baseRevision', 'declaredBytes', 'idempotencyKey']);
      const { baseRevision, declaredBytes, idempotencyKey } = req.body;
      if (
        !revision(baseRevision) ||
        !Number.isSafeInteger(declaredBytes) ||
        declaredBytes < 1 ||
        declaredBytes > 65536 ||
        typeof idempotencyKey !== 'string' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          idempotencyKey,
        )
      )
        throw failure('invalid_request');
      const derived = await system(() =>
        methods.getDocumentWorkspaceSaveIntent(owner(user), req.params.workspaceId, baseRevision),
      );
      const result = await getRuntime().management.reserveDerived(user, {
        mediaType: 'text/plain',
        declaredBytes,
        idempotencyKey,
        derived,
      });
      await json(req, res, result, 202);
    }),
  );
  router.get(
    '/:workspaceId/saves/:operationId',
    wrap(async (req, res, user) => {
      exact(req.query, ['baseRevision']);
      if (
        typeof req.query.baseRevision !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(req.query.baseRevision) ||
        !revision(Number(req.query.baseRevision)) ||
        !id(req.params.operationId)
      )
        throw failure('invalid_request');
      const derived = await system(() =>
        methods.getDocumentWorkspaceSaveIntent(
          owner(user),
          req.params.workspaceId,
          Number(req.query.baseRevision),
        ),
      );
      const result = await system(() =>
        getRuntime().repository.getDerivedOperation(
          user,
          req.params.operationId,
          derived.binding,
          Date.now(),
        ),
      );
      await json(req, res, result);
    }),
  );
  router.post(
    '/:workspaceId/revisions',
    metadata,
    wrap(async (req, res, user) => {
      exact(req.query, []);
      exact(req.body, ['baseRevision', 'fileId']);
      const { baseRevision, fileId } = req.body;
      if (!revision(baseRevision) || !id(fileId)) throw failure('invalid_request');
      const result = await system(() =>
        methods.commitDocumentWorkspaceVersion(
          owner(user),
          req.params.workspaceId,
          baseRevision,
          fileId,
        ),
      );
      const workspace = await system(() =>
        methods.getDocumentWorkspace(owner(user), req.params.workspaceId),
      );
      if (workspace.revision !== result.revision || workspace.headFileId !== result.fileId)
        throw failure('revision_conflict');
      await json(req, res, workspace);
    }),
  );
  return router;
}

module.exports = { createWorkspaceRouter };
