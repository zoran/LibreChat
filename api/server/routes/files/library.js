/** Personal-library HTTP boundary; File owns lifecycle/CAS and Upload owns managed approval. */
const { runAsSystem } = require('@librechat/data-schemas');
const {
  FILE_LIBRARY_ITEM_FIELDS,
  readFileLibraryQuery,
  readFileLibraryUpdate,
  readFileLibraryMetadata,
  readFileLibraryItem,
  readFileLibraryPage,
} = require('librechat-data-provider');
const { isCortexFileMode, createManagedFileHandlers } = require('./managed');

const failure = (code) => Object.assign(new Error(code), { code });
const runtime = () => require('~/server/services/Uploads').getUploadRuntime();

function sendFailure(res, error) {
  const statuses = {
    invalid_request: 400,
    unauthorized: 401,
    forbidden: 404,
    not_found: 404,
    expired: 404,
    not_ready: 404,
    principal_unavailable: 404,
    revision_conflict: 409,
  };
  const code = Object.hasOwn(statuses, error?.code) ? error.code : 'unavailable';
  res.status(statuses[code] ?? 503).json({
    code: statuses[code] === 404 ? 'not_found' : code,
  });
}

function createFileLibraryHandlers(options = {}) {
  const methods = options.methods ?? require('~/models');
  const getRuntime = options.getRuntime ?? runtime;
  const isManaged = options.isManaged ?? isCortexFileMode;
  const system = options.runAsSystem ?? runAsSystem;
  const now = options.now ?? Date.now;
  const managed = createManagedFileHandlers({ getRuntime });

  async function authorize(req, expected) {
    const userId = req.user?.id?.toString();
    if (!userId) throw failure('unauthorized');
    const owner = { userId, tenantId: req.user.tenantId };
    const managedMode = isManaged();
    const current = managedMode ? getRuntime() : undefined;
    let principal;
    if (managedMode) {
      principal = await managed.authorize(req);
      if (
        principal.userId !== userId ||
        principal.tenantId !== owner.tenantId ||
        principal.authentication !== 'verified-email' ||
        current !== getRuntime()
      )
        throw failure('not_found');
    }
    if (
      expected &&
      (expected.owner.userId !== owner.userId ||
        expected.owner.tenantId !== owner.tenantId ||
        expected.managedMode !== managedMode ||
        expected.runtime !== current)
    )
      throw failure('not_found');
    return { owner, principal, runtime: current, managedMode };
  }

  /** Re-read the current operation through its owner; never infer approval from a File DTO. */
  async function approve(access, fileId) {
    if (!access.managedMode) return;
    const operation = await access.runtime.management.get(access.principal, fileId);
    const expiry = Date.parse(operation?.expiresAt);
    if (
      operation?.id !== fileId ||
      operation.fileId !== fileId ||
      operation.scope?.kind !== 'personal' ||
      operation.state !== 'ready' ||
      operation.canUseInComposer !== true ||
      !Number.isFinite(expiry) ||
      expiry <= now()
    )
      throw failure('not_found');
  }

  function project(file, access) {
    const library = readFileLibraryMetadata(file.library);
    if (!library || typeof file.file_id !== 'string') throw failure('unavailable');
    const item = {};
    for (const key of FILE_LIBRARY_ITEM_FIELDS) {
      if (file[key] !== undefined) item[key] = file[key];
    }
    item.filepath = access.managedMode
      ? `/api/files/managed/${encodeURIComponent(file.file_id)}`
      : `/api/files/download/${encodeURIComponent(access.owner.userId)}/${encodeURIComponent(file.file_id)}`;
    item.library = library;
    const result = readFileLibraryItem(item);
    if (!result) throw failure('unavailable');
    return result;
  }

  const wrap = (action) => async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      await action(req, res);
    } catch (error) {
      sendFailure(res, error);
    }
  };

  return {
    list: wrap(async (req, res) => {
      const access = await authorize(req);
      const query = readFileLibraryQuery(req.query);
      if (!query) throw failure('invalid_request');
      const page = await system(() => methods.getFileLibraryPage(access.owner, query));
      const current = await authorize(req, access);
      const files = [];
      // Storage bounds this page. Preserve its cursor even when approval hides a row.
      for (const file of page.files) {
        try {
          await approve(current, file.file_id);
        } catch (error) {
          if (['not_found', 'forbidden', 'expired', 'not_ready'].includes(error?.code)) continue;
          throw error;
        }
        files.push(project(file, current));
      }
      await authorize(req, access);
      const result = readFileLibraryPage({ files, nextCursor: page.nextCursor });
      if (!result) throw failure('unavailable');
      res.json(result);
    }),
    update: wrap(async (req, res) => {
      const access = await authorize(req);
      const update = readFileLibraryUpdate(req.body);
      if (!update) throw failure('invalid_request');
      const fileId = req.params.file_id;
      if (typeof fileId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(fileId))
        throw failure('not_found');
      await approve(access, fileId);
      const result = await system(() => methods.updateFileLibrary(access.owner, fileId, update));
      const current = await authorize(req, access);
      await approve(current, fileId);
      if (result.kind === 'unavailable') throw failure('not_found');
      if (result.kind === 'conflict') throw failure('revision_conflict');
      const library = result.kind === 'updated' && readFileLibraryMetadata(result.library);
      if (!library) throw failure('unavailable');
      res.json(library);
    }),
  };
}

module.exports = { createFileLibraryHandlers };
