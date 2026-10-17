const { isUploadPrincipal } = require('librechat-data-provider');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');
const {
  isCortexFileMode,
  rejectUnmanagedFileWrites,
} = require('~/server/middleware/requireManagedIntake');
const { runAsSystem } = require('@librechat/data-schemas');
const { getContentDisposition } = require('~/server/utils/files');

const MAX_BYTES = 30 * 1024 * 1024;
const MAX_CHUNK = 64 * 1024;
const FILE_FIELDS =
  'file_id uploadOperationId tenantId user filename type source bytes embedded llmDeliveryPath status expiredAt retentionAcceptedAt deletionRequestedAt deletionCompletedAt storageKey';
const unavailable = (code = 'not_found') => Object.assign(new Error(code), { code });
const runtime = () => require('~/server/services/Uploads').getUploadRuntime();

function publicFile(file) {
  return {
    file_id: file.file_id,
    filename: file.filename,
    type: file.type,
    source: file.source,
    bytes: file.bytes,
    embedded: file.embedded,
    llmDeliveryPath: file.llmDeliveryPath,
    filepath: `/api/files/managed/${encodeURIComponent(file.file_id)}`,
    status: 'ready',
    expiredAt: file.expiredAt,
  };
}

function sendFailure(res, error) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const header of ['Content-Disposition', 'Content-Type', 'Content-Length', 'X-File-Metadata'])
    res.removeHeader(header);
  res.setHeader('Cache-Control', 'private, no-store');
  const code = error?.code;
  let status = 503;
  let publicCode = 'unavailable';
  if (code === 'unauthorized') {
    status = 401;
    publicCode = 'unauthorized';
  } else if (code === 'invalid_request') {
    status = 400;
    publicCode = 'invalid_request';
  } else if (['not_found', 'forbidden', 'expired', 'not_ready'].includes(code)) {
    status = 404;
    publicCode = 'not_found';
  }
  res.status(status).json({ code: publicCode });
}

/** Plain route adapter; identity, operation state, File lifecycle and storage keep their owners. */
function createManagedFileHandlers(options = {}) {
  const getRuntime = options.getRuntime ?? runtime;
  const getFiles = options.getFiles ?? ((...args) => require('~/models').getFiles(...args));
  const system = options.runAsSystem ?? runAsSystem;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000)
    throw new Error('Invalid managed download deadline');

  async function principal(req, owner, expected) {
    if (!owner || !Array.isArray(owner.allowedOrigins) || !owner.allowedOrigins.length)
      throw unavailable();
    const origin = req.headers.origin;
    // Same GET rule as the upload HTTP adapter; normal same-origin fetch omits Origin.
    if (
      origin
        ? !owner.allowedOrigins.includes(origin)
        : req.method !== 'GET' || req.headers['sec-fetch-site'] !== 'same-origin'
    ) {
      throw unavailable('forbidden');
    }
    const result = await owner.principal(req);
    if (
      !isUploadPrincipal(result) ||
      (expected &&
        (result.authentication !== expected.authentication ||
          result.tenantId !== expected.tenantId ||
          result.userId !== expected.userId))
    ) {
      throw unavailable('unauthorized');
    }
    return result;
  }

  function eligible(operation, id) {
    const expiry = Date.parse(operation?.expiresAt);
    if (
      operation?.id !== id ||
      operation.fileId !== id ||
      operation.scope?.kind !== 'personal' ||
      operation.state !== 'ready' ||
      operation.canUseInComposer !== true ||
      !Number.isFinite(expiry) ||
      expiry <= now()
    )
      throw unavailable();
    return expiry;
  }

  async function lookup(req, id, { text = false, original = false } = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw unavailable();
    const owner = getRuntime();
    const user = await principal(req, owner);
    const operation = await owner.management.get(user, id);
    const operationExpiry = eligible(operation, id);
    const [file] =
      (await system(() =>
        getFiles(
          {
            tenantId: user.tenantId,
            user: user.userId,
            file_id: id,
            uploadOperationId: id,
          },
          null,
          `${FILE_FIELDS}${text ? ' text textFormat' : ''}`,
          1,
        ),
      )) ?? [];
    const fileExpiry = new Date(file?.expiredAt).getTime();
    if (
      !file ||
      file.file_id !== id ||
      file.uploadOperationId !== id ||
      file.user?.toString() !== user.userId ||
      file.tenantId !== user.tenantId ||
      file.status !== 'ready' ||
      file.embedded !== true ||
      !file.retentionAcceptedAt ||
      file.deletionRequestedAt ||
      file.deletionCompletedAt ||
      !Number.isFinite(fileExpiry) ||
      fileExpiry <= now() ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > MAX_BYTES
    ) {
      throw unavailable();
    }
    let receipt;
    if (original) {
      const task = await system(() => owner.repository.cleanupForFile(user, id));
      receipt = task?.original;
      if (
        task?.operationId !== id ||
        task.fileId !== id ||
        task.state !== 'ready' ||
        task.principal?.tenantId !== user.tenantId ||
        task.principal?.userId !== user.userId ||
        receipt?.outcome !== 'durable' ||
        receipt.source !== 's3' ||
        !receipt.storageKey ||
        receipt.storageKey !== file.storageKey ||
        receipt.bytes !== file.bytes ||
        operation.actualBytes !== file.bytes
      )
        throw unavailable();
    }
    return {
      owner,
      user,
      operation,
      file,
      receipt,
      expiresAt: Math.min(operationExpiry, fileExpiry),
    };
  }

  async function revalidate(req, access) {
    const user = await principal(req, access.owner, access.user);
    // get() includes the existing exact-owner File lifecycle availability query.
    const operation = await access.owner.management.get(user, access.file.file_id);
    const expiry = eligible(operation, access.file.file_id);
    if (operation.actualBytes !== access.operation.actualBytes) throw unavailable();
    access.expiresAt = Math.min(access.expiresAt, expiry);
    if (access.expiresAt <= now()) throw unavailable();
  }

  async function download(req, res) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const disconnect = () => {
      if (!res.writableEnded) abort();
    };
    const timedOut = () => {
      abort();
      sendFailure(res, unavailable('unavailable'));
    };
    let timer = setTimeout(timedOut, deadlineMs);
    timer.unref();
    req.once('aborted', abort);
    res.once('close', disconnect);
    const started = monotonic();
    try {
      if (req.headers.range !== undefined) throw unavailable('invalid_request');
      const access = await lookup(req, req.params.id ?? req.params.file_id, { original: true });
      controller.signal.throwIfAborted();
      const remaining = Math.min(deadlineMs - (monotonic() - started), access.expiresAt - now());
      if (remaining <= 0) throw unavailable();
      clearTimeout(timer);
      timer = setTimeout(timedOut, remaining);
      timer.unref();
      res.setHeader('Content-Disposition', getContentDisposition(access.file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-File-Metadata', encodeURIComponent(JSON.stringify(publicFile(access.file))));
      res.setHeader('Content-Length', access.file.bytes);
      let bytes = 0;
      let recheckAt = -Infinity;
      for await (const value of access.owner.storage.read({
        original: access.receipt,
        signal: controller.signal,
      })) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > access.file.bytes) throw unavailable();
        for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK) {
          controller.signal.throwIfAborted();
          if (access.expiresAt <= now()) throw unavailable();
          if (monotonic() >= recheckAt) {
            await revalidate(req, access);
            controller.signal.throwIfAborted();
            recheckAt = monotonic() + 1_000;
          }
          if (!res.write(chunk.subarray(offset, offset + MAX_CHUNK))) {
            await once(res, 'drain', { signal: controller.signal });
          }
        }
      }
      if (bytes !== access.file.bytes) throw unavailable();
      res.end();
    } catch (error) {
      sendFailure(res, error);
    } finally {
      abort();
      clearTimeout(timer);
      req.off('aborted', abort);
      res.off('close', disconnect);
    }
  }

  async function preview(req, res) {
    try {
      const access = await lookup(req, req.params.file_id, { text: true });
      await revalidate(req, access);
      if (
        typeof access.file.text !== 'string' ||
        Buffer.byteLength(access.file.text) > 15 * 1024 * 1024
      )
        throw unavailable();
      res.setHeader('Cache-Control', 'private, no-store');
      res.json({
        file_id: access.file.file_id,
        status: 'ready',
        text: access.file.text,
        textFormat: 'text',
      });
    } catch (error) {
      sendFailure(res, error);
    }
  }

  async function downloadURL(req, res) {
    try {
      const access = await lookup(req, req.params.file_id);
      await revalidate(req, access);
      res.setHeader('Cache-Control', 'private, no-store');
      // Existing client falls back to bearer-authenticated blob fetch on this response.
      res.status(501).json({ code: 'authenticated_download_required' });
    } catch (error) {
      sendFailure(res, error);
    }
  }

  async function list(req, res) {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      // Guest chat keeps its normal bootstrap; no managed file authority is minted.
      if (req.user?.provider !== 'email_code' || !getRuntime()) return res.json([]);
      const owner = getRuntime();
      const user = await principal(req, owner);
      const operations = (await owner.management.list(user)).filter((operation) => {
        try {
          eligible(operation, operation.id);
          return true;
        } catch {
          return false;
        }
      });
      const allowed = new Map(operations.map((operation) => [operation.fileId, operation]));
      if (!allowed.size) return res.json([]);
      const requested = Number(req.query.limit);
      const limit =
        Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, 100) : 100;
      const files =
        (await system(() =>
          getFiles(
            {
              tenantId: user.tenantId,
              user: user.userId,
              file_id: { $in: [...allowed.keys()] },
              uploadOperationId: { $in: [...allowed.keys()] },
            },
            null,
            FILE_FIELDS,
            limit,
          ),
        )) ?? [];
      await principal(req, owner, user);
      return res.json(
        files
          .filter(
            (file) =>
              file.user?.toString() === user.userId &&
              file.tenantId === user.tenantId &&
              file.uploadOperationId === file.file_id &&
              allowed.has(file.file_id) &&
              file.status === 'ready' &&
              file.embedded === true &&
              !file.deletionRequestedAt &&
              !file.deletionCompletedAt &&
              new Date(file.expiredAt).getTime() > now(),
          )
          .map(publicFile),
      );
    } catch (error) {
      sendFailure(res, error);
    }
  }

  return {
    download,
    downloadURL,
    preview,
    list,
    authorize: (req) => principal(req, getRuntime()),
    failure: sendFailure,
  };
}

module.exports = { isCortexFileMode, rejectUnmanagedFileWrites, createManagedFileHandlers };
