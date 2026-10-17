const { isDeepStrictEqual } = require('node:util');
const { performance } = require('node:perf_hooks');
const { runAsSystem } = require('@librechat/data-schemas');
const { managedOriginalKey } = require('@librechat/api');
const {
  isUploadStorageReceipt,
  isUploadOriginalIntegrity,
  matchesUploadSecurityApproval,
  readUploadDerivedOrigin,
  uploadDerivedExpiresAt,
} = require('librechat-data-provider');
const { createManagedFileHandlers } = require('~/server/routes/files/managed');

const MAX_BYTES = 65_536;
const snapshot = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));
const unavailable = (code = 'not_found') => Object.assign(new Error(code), { code });
const samePrincipal = (left, right) =>
  left?.userId === right.userId &&
  left?.tenantId === right.tenantId &&
  left?.authentication === right.authentication;

/** Workspace owns the revision; File and Upload retain all content and security authority. */
function createWorkspaceOriginalReader(options = {}) {
  const getRuntime =
    options.getRuntime ?? (() => require('~/server/services/Uploads').getUploadRuntime());
  const getVersionFile =
    options.getDocumentWorkspaceVersionFile ??
    ((...args) => require('~/models').getDocumentWorkspaceVersionFile(...args));
  const system = options.runAsSystem ?? runAsSystem;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? 30_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000)
    throw new Error('Invalid workspace original deadline');

  async function read(req, workspaceId, revision) {
    if (
      typeof workspaceId !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(workspaceId) ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw unavailable('invalid_request');

    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, deadlineMs);
    timer.unref();
    req.once('aborted', abort);
    const started = monotonic();
    let runtime;
    let authorize;
    function live() {
      if (
        req.aborted ||
        controller.signal.aborted ||
        monotonic() - started >= deadlineMs ||
        getRuntime() !== runtime
      )
        throw unavailable('unavailable');
    }

    async function lookup(expected) {
      live();
      const authenticated = await authorize(req);
      if (expected && !samePrincipal(authenticated, expected.principal))
        throw unavailable('unauthorized');
      const principal = {
        userId: authenticated.userId,
        tenantId: authenticated.tenantId,
        authentication: authenticated.authentication,
      };
      const loadFile = async () =>
        snapshot(
          await system(() =>
            getVersionFile(
              { userId: principal.userId, tenantId: principal.tenantId },
              workspaceId,
              revision,
            ),
          ),
        );
      const file = expected ? expected.file : await loadFile();
      live();
      const origin = readUploadDerivedOrigin(file?.derivedOrigin);
      const acceptedAt = new Date(file?.retentionAcceptedAt).getTime();
      const expiresAt = new Date(file?.expiredAt).getTime();
      if (
        !file ||
        typeof file.file_id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(file.file_id) ||
        file.uploadOperationId !== file.file_id ||
        file.user !== principal.userId ||
        file.tenantId !== principal.tenantId ||
        file.status !== 'ready' ||
        file.source !== 's3' ||
        (file.type !== 'text/plain' && file.type !== 'text/csv') ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > MAX_BYTES ||
        file.filepath !== `/api/files/managed/${file.file_id}` ||
        !origin ||
        origin.binding.purpose !== 'workspace-draft' ||
        origin.binding.sourceId !== workspaceId ||
        origin.binding.sourceRevision !== revision - 1 ||
        !Number.isSafeInteger(acceptedAt) ||
        acceptedAt < 0 ||
        acceptedAt > now() ||
        expiresAt !== uploadDerivedExpiresAt(acceptedAt, origin) ||
        expiresAt <= now()
      )
        throw unavailable();

      const operation = snapshot(await runtime.management.get(principal, file.file_id));
      const task = snapshot(
        await system(() => runtime.repository.cleanupForFile(principal, file.file_id)),
      );
      live();
      const receipt = task?.original;
      if (
        operation?.id !== file.file_id ||
        operation.fileId !== file.file_id ||
        operation.scope?.kind !== 'personal' ||
        operation.state !== 'ready' ||
        operation.canUseInComposer !== false ||
        operation.cleanupPending !== false ||
        operation.mediaType !== file.type ||
        operation.actualBytes !== file.bytes ||
        Date.parse(operation.acceptedAt) !== acceptedAt ||
        Date.parse(operation.expiresAt) !== expiresAt ||
        task?.operationId !== file.file_id ||
        task.fileId !== file.file_id ||
        task.state !== 'ready' ||
        !samePrincipal(task.principal, principal) ||
        !Number.isSafeInteger(task.attemptGeneration) ||
        task.attemptGeneration < 1 ||
        !isUploadStorageReceipt(receipt) ||
        receipt.outcome !== 'durable' ||
        receipt.source !== 's3' ||
        receipt.bytes !== file.bytes ||
        receipt.filepath !== file.filepath ||
        receipt.storageKey !== file.storageKey ||
        receipt.storageKey !==
          managedOriginalKey({
            ...principal,
            operationId: file.file_id,
            generation: task.attemptGeneration,
          }) ||
        !isUploadOriginalIntegrity(receipt.integrity, file.bytes) ||
        !matchesUploadSecurityApproval(
          file.securityApproval,
          {
            tenantId: principal.tenantId,
            userId: principal.userId,
            operationId: file.file_id,
            transferGeneration: task.attemptGeneration,
            mediaType: file.type,
            bytes: file.bytes,
            sha256: receipt.integrity.sha256,
          },
          options.securityPolicySha256 ?? process.env.UPLOAD_SECURITY_POLICY_SHA256,
          now(),
        ) ||
        expiresAt <= now()
      )
        throw unavailable();
      if (expected) {
        // Finish with current authorization and the native File/User transaction fence, after
        // awaiting Upload metadata. No earlier File read can authorize this final return.
        if (!samePrincipal(await authorize(req), principal)) throw unavailable('unauthorized');
        const currentFile = await loadFile();
        live();
        if (!isDeepStrictEqual(file, currentFile) || expiresAt <= now()) throw unavailable();
      }
      return { principal, file, receipt, operationRevision: operation.revision };
    }

    try {
      runtime = getRuntime();
      authorize =
        options.authorize ?? createManagedFileHandlers({ getRuntime: () => runtime }).authorize;
      const access = await lookup();
      const chunks = [];
      let length = 0;
      // The existing storage owner verifies block hashes, full digest, size and EOF before yield.
      for await (const chunk of runtime.storage.read({
        original: access.receipt,
        signal: controller.signal,
      })) {
        live();
        if (!(chunk instanceof Uint8Array) || length + chunk.byteLength > access.file.bytes)
          throw unavailable('unavailable');
        length += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
      if (length !== access.file.bytes) throw unavailable('unavailable');
      const current = await lookup(access);
      live();
      if (!isDeepStrictEqual(access, current)) throw unavailable();
      return { bytes: Buffer.concat(chunks, length), mediaType: access.file.type };
    } catch (error) {
      const code = ['unauthorized', 'forbidden', 'not_found', 'invalid_request'].includes(
        error?.code,
      )
        ? error.code
        : 'unavailable';
      throw unavailable(code);
    } finally {
      clearTimeout(timer);
      req.off('aborted', abort);
      controller.abort();
    }
  }

  return { read };
}

module.exports = { createWorkspaceOriginalReader };
