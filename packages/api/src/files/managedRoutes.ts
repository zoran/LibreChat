/** Managed File HTTP handlers. File/source owners retain authorization, storage and activity state. */
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { serializeManagedFileReadPreview } from 'librechat-data-provider';
import type {
  ManagedFileReadReference,
  ManagedFileReadRepresentation,
  UploadPrincipal,
  UploadWorker,
} from 'librechat-data-provider';
import type { UploadManagementRepository } from '@librechat/data-schemas';
import type { IncomingMessage } from 'node:http';
import type { Response } from 'express';
import type {
  ManagedSourceAccess,
  ManagedSourceRecord,
  ManagedSourceResolver,
} from './managedSource';
import { managedSourceExpiry, MANAGED_SOURCE_FILE_FIELDS } from './managedSource';

type FileReads = UploadManagementRepository['fileReads'];
type ReadClaim = Awaited<ReturnType<FileReads['claimManagedFileRead']>>;
type ReadOutcome =
  | Awaited<ReturnType<FileReads['completeManagedFileRead']>>
  | Awaited<ReturnType<FileReads['inspectManagedFileRead']>>;
type Operation = Parameters<typeof managedSourceExpiry>[0];

/** Plain request data and lifecycle events; no framework or database singleton is acquired here. */
export type ManagedFileRouteRequest = Parameters<ManagedSourceResolver['authorize']>[0] & {
  headers: IncomingMessage['headers'];
  rawHeaders?: readonly string[];
  params: Readonly<Record<string, string>>;
  query: Readonly<Record<string, unknown>>;
  user?: { id?: string; tenantId?: string | null; provider?: string };
  once: IncomingMessage['once'];
  off: IncomingMessage['off'];
};

/** Runtime projects existing owners; read claims and receipts are never reimplemented by HTTP. */
export type ManagedFileRouteRuntime = {
  sources: ManagedSourceResolver;
  management: { list(principal: UploadPrincipal): Promise<Operation[]> };
  /** The Upload/File owner retains the whole operation, including writable GET continuations. */
  runFileOperation<T>(work: () => Promise<T>): Promise<T>;
  fileReads?: FileReads;
  fileReadWorker?: Readonly<UploadWorker>;
};

export type ManagedFileRouteDependencies = {
  getRuntime(): ManagedFileRouteRuntime | null | undefined;
  getFiles(
    filter: {
      tenantId: string | null;
      user: string;
      file_id: { $in: (string | undefined)[] };
      uploadOperationId: { $in: (string | undefined)[] };
    },
    sort: null,
    fields: string,
    limit: number,
  ): Promise<ManagedSourceRecord[] | null>;
  runAsSystem<T>(work: () => Promise<T>): Promise<T>;
  getContentDisposition(filename: string): string;
};
export type ManagedFileRouteOptions = Partial<ManagedFileRouteDependencies> & {
  now?: () => number;
  monotonic?: () => number;
  deadlineMs?: number;
};
export type ManagedFileHandlers = {
  download(req: ManagedFileRouteRequest, res: Response): Promise<void>;
  downloadURL(req: ManagedFileRouteRequest, res: Response): Promise<Response | void>;
  preview(req: ManagedFileRouteRequest, res: Response): Promise<Response | void>;
  list(req: ManagedFileRouteRequest, res: Response): Promise<Response | void>;
  authorize(req: ManagedFileRouteRequest): Promise<UploadPrincipal>;
  failure(res: Response, error: unknown): void;
};
type ReadBody = { bytes: number; sha256: string; release(): Promise<void> };

const MAX_CHUNK = 64 * 1024;
const FILE_FIELDS = MANAGED_SOURCE_FILE_FIELDS;
const unavailable = (code = 'not_found') => Object.assign(new Error(code), { code });

function publicFile(file: ManagedSourceRecord) {
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

function sendFailure(res: Response, error: unknown) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const header of ['Content-Disposition', 'Content-Type', 'Content-Length', 'X-File-Metadata'])
    res.removeHeader(header);
  res.setHeader('Cache-Control', 'private, no-store');
  const code = (error as { code?: string } | null | undefined)?.code;
  let status = 503;
  let publicCode = 'unavailable';
  if (code === 'unauthorized') {
    status = 401;
    publicCode = 'unauthorized';
  } else if (code === 'invalid_request') {
    status = 400;
    publicCode = 'invalid_request';
  } else if (code === 'method_not_allowed') {
    status = 405;
    publicCode = code;
    res.setHeader('Allow', 'GET');
  } else if (code === 'managed_read_required') {
    status = 428;
    publicCode = code;
  } else if (code === 'busy') {
    status = 409;
    publicCode = 'managed_read_busy';
    res.setHeader('Retry-After', '1');
  } else if (
    [
      'not_found',
      'forbidden',
      'expired',
      'not_ready',
      'revoked',
      'source_changed',
      'lease_lost',
    ].includes(code!)
  ) {
    status = 404;
    publicCode = 'not_found';
  }
  res.status(status).json({ code: publicCode });
}

/** Plain route adapter; identity, operation state, File lifecycle and storage keep their owners. */
export function createManagedFileHandlers(
  dependencies: ManagedFileRouteDependencies,
  options: ManagedFileRouteOptions = {},
): ManagedFileHandlers {
  const getRuntime = options.getRuntime ?? dependencies.getRuntime;
  const getFiles = options.getFiles ?? dependencies.getFiles;
  const system = options.runAsSystem ?? dependencies.runAsSystem;
  const getContentDisposition = options.getContentDisposition ?? dependencies.getContentDisposition;
  const now = options.now ?? Date.now;
  const monotonic = options.monotonic ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? 120_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 120_000)
    throw new Error('Invalid managed download deadline');

  const sources = (owner: ManagedFileRouteRuntime | null | undefined) => {
    if (!owner?.sources) throw unavailable();
    return owner.sources;
  };
  const principal = (
    req: ManagedFileRouteRequest,
    owner: ManagedFileRouteRuntime | null | undefined,
    expected?: UploadPrincipal,
  ) => sources(owner).authorize(req, expected);
  const eligible = (operation: Operation, id: string) => managedSourceExpiry(operation, id, now());
  const lookup = (
    req: ManagedFileRouteRequest,
    id: string,
    input?: Parameters<ManagedSourceResolver['resolve']>[2],
  ) => sources(getRuntime()).resolve(req, id, input);
  const revalidate = (req: ManagedFileRouteRequest, access: ManagedSourceAccess) =>
    sources(getRuntime()).revalidate(req, access);

  function readReference(
    req: ManagedFileRouteRequest,
    representation: ManagedFileReadRepresentation,
    required = true,
  ): ManagedFileReadReference | undefined {
    const raw = req.headers['x-cortex-file-read'];
    const duplicates = (req.rawHeaders ?? []).filter(
      (value, index) => index % 2 === 0 && value.toLowerCase() === 'x-cortex-file-read',
    ).length;
    if (raw === undefined && !required) return undefined;
    if (raw === undefined) throw unavailable('managed_read_required');
    if (duplicates > 1 || typeof raw !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(raw))
      throw unavailable('invalid_request');
    return { version: 1, readId: raw, fileId: req.params.id ?? req.params.file_id, representation };
  }

  async function readPrincipal(req: ManagedFileRouteRequest, owner: ManagedFileRouteRuntime) {
    const user = await principal(req, owner);
    if (req.params.userId !== undefined && req.params.userId !== user.userId)
      throw unavailable('not_found');
    return user;
  }

  /** Each response retains its original hard deadline, including auth, leases and DB resolution. */
  function readScope(req: ManagedFileRouteRequest, res: Response) {
    const controller = new AbortController();
    const started = monotonic();
    let notAfter = Infinity;
    const check = () => {
      controller.signal.throwIfAborted();
      if (monotonic() - started >= deadlineMs || now() >= notAfter) throw unavailable('expired');
    };
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
    const within = async <T>(work: Promise<T>): Promise<T> => {
      let onAbort: (() => void) | undefined;
      try {
        check();
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(unavailable('unavailable'));
            controller.signal.addEventListener('abort', onAbort, { once: true });
            if (controller.signal.aborted) onAbort();
          }),
        ]);
      } finally {
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        // Response cancellation cannot settle the original Mongo transaction or endSession.
        // Keep the enclosing File operation held until that original has actually returned.
        await work.catch(() => undefined);
      }
    };
    return {
      signal: controller.signal,
      check,
      within,
      narrow(value: string) {
        notAfter = Math.min(notAfter, Date.parse(value));
        if (!Number.isFinite(notAfter)) throw unavailable('unavailable');
        check();
        clearTimeout(timer);
        timer = setTimeout(
          timedOut,
          Math.min(deadlineMs - (monotonic() - started), notAfter - now()),
        );
        timer.unref();
      },
      close() {
        abort();
        clearTimeout(timer);
        req.off('aborted', abort);
        res.off('close', disconnect);
      },
    };
  }

  async function withManagedRead(
    req: ManagedFileRouteRequest,
    res: Response,
    representation: ManagedFileReadRepresentation,
    materialize: (
      access: ManagedSourceAccess,
      scope: ReturnType<typeof readScope>,
      recheck: (force?: boolean) => Promise<void>,
    ) => Promise<ReadBody>,
  ) {
    if (req.method !== 'GET') return sendFailure(res, unavailable('method_not_allowed'));
    const scope = readScope(req, res);
    let claim: ReadClaim | undefined;
    let user: UploadPrincipal | undefined;
    let owner: ManagedFileRouteRuntime | null | undefined;
    let access: ManagedSourceAccess | undefined;
    let renewal: Promise<void> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let completionStarted = false;
    let abandonReason: 'aborted' | 'read_failed' | undefined;
    const stopRenewal = async () => {
      clearInterval(heartbeat);
      if (renewal) await renewal;
    };
    try {
      const reference = readReference(req, representation)!;
      owner = getRuntime();
      if (!owner) throw unavailable();
      if (!owner.fileReads || !owner.fileReadWorker) throw unavailable('unavailable');
      user = await scope.within(readPrincipal(req, owner));
      claim = await scope.within<ReadClaim>(
        owner.fileReads
          .claimManagedFileRead(user, reference, owner.fileReadWorker)
          .then((value) => {
            // A claim arriving after HTTP abort still belongs to this attempt's finally cleanup.
            claim = value;
            return value;
          }),
      );
      scope.narrow(claim.notAfter);
      const renew = async () => {
        scope.check();
        if (access) await scope.within(revalidate(req, access!));
        else await scope.within(principal(req, owner, user));
        claim = await scope.within<ReadClaim>(
          owner!
            .fileReads!.claimManagedFileRead(user!, reference, owner!.fileReadWorker!, claim)
            .then((value) => {
              claim = value;
              return value;
            }),
        );
        scope.check();
      };
      // A slow storage read or response backpressure must not silently lose its five-second lease.
      heartbeat = setInterval(() => {
        if (renewal) return;
        renewal = renew()
          .catch((error) => {
            sendFailure(res, error);
            scope.close();
          })
          .finally(() => {
            renewal = undefined;
          });
      }, 1_000);
      heartbeat.unref();
      access = await scope.within(
        lookup(req, reference.fileId, {
          original: representation === 'original',
          text: representation === 'preview',
          signal: scope.signal,
        }),
      );
      scope.check();
      if (access.sourceBindingSha256 !== claim.sourceBindingSha256)
        throw unavailable('source_changed');
      let recheckAt = -Infinity;
      const recheck = async (force = false) => {
        scope.check();
        if (access!.expiresAt <= now()) throw unavailable('expired');
        if (force || monotonic() >= recheckAt) {
          if (renewal) await renewal;
          await scope.within(revalidate(req, access!));
          scope.check();
          recheckAt = monotonic() + 1_000;
        }
      };
      const body = await materialize(access, scope, recheck);
      await stopRenewal();
      await recheck(true);
      scope.check();
      completionStarted = true;
      let outcome: ReadOutcome = await scope.within(
        owner.fileReads.completeManagedFileRead(user, claim, {
          version: 1,
          representation,
          sourceBindingSha256: claim.sourceBindingSha256,
          contentSha256: body.sha256,
          verifiedBytes: body.bytes,
        }),
      );
      if (outcome.status === 'unknown') {
        // A lost commit reply is never permission to invent another logical read.
        outcome = await scope.within(owner.fileReads.inspectManagedFileRead(user, reference));
      }
      if (outcome.status !== 'completed')
        throw unavailable((outcome as { reason?: string }).reason ?? 'unavailable');
      await recheck(true);
      scope.check();
      await body.release();
    } catch (error) {
      abandonReason = scope.signal.aborted ? 'aborted' : 'read_failed';
      sendFailure(res, error);
    } finally {
      clearInterval(heartbeat);
      if (renewal) await renewal;
      // Once completion was submitted, only same-ID inspection can settle an uncertain outcome.
      if (claim && !completionStarted) {
        await owner!
          .fileReads!.abandonManagedFileRead(user!, claim, {
            reason: abandonReason ?? 'aborted',
          })
          .catch(() => undefined);
      }
      scope.close();
    }
  }

  async function download(req: ManagedFileRouteRequest, res: Response) {
    if (req.headers.range !== undefined) return sendFailure(res, unavailable('invalid_request'));
    return withManagedRead(req, res, 'original', async (access, scope, recheck) => {
      if (!access.storageAuthority) throw unavailable();
      res.setHeader('Content-Disposition', getContentDisposition(access.file.filename));
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-File-Metadata', encodeURIComponent(JSON.stringify(publicFile(access.file))));
      res.setHeader('Content-Length', access.file.bytes);
      let bytes = 0;
      let tail: Buffer | undefined;
      const digest = createHash('sha256');
      const write = async (chunk: Buffer) => {
        await recheck();
        if (!res.write(chunk)) await scope.within(once(res, 'drain', { signal: scope.signal }));
      };
      for await (const value of access.storage.read({
        ...access.storageAuthority,
        original: access.receipt!,
        signal: scope.signal,
      })) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > access.file.bytes) throw unavailable();
        digest.update(chunk);
        for (let offset = 0; offset < chunk.byteLength; offset += MAX_CHUNK) {
          await recheck();
          const slice = chunk.subarray(offset, offset + MAX_CHUNK);
          // Hold the final output slice through actual iterator EOF and durable completion.
          if (bytes === access.file.bytes && offset + MAX_CHUNK >= chunk.byteLength)
            tail = Buffer.from(slice);
          else await write(slice);
        }
      }
      if (bytes !== access.file.bytes || !tail) throw unavailable();
      const sha256 = digest.digest('hex');
      if (access.receipt!.integrity && sha256 !== access.receipt!.integrity.sha256)
        throw unavailable();
      return {
        bytes,
        sha256,
        release: async () => {
          await write(tail!);
          res.end();
        },
      };
    });
  }

  async function preview(req: ManagedFileRouteRequest, res: Response) {
    try {
      if (!readReference(req, 'preview', false)) {
        const access = await lookup(req, req.params.file_id);
        await revalidate(req, access);
        res.setHeader('Cache-Control', 'private, no-store');
        return res.json({ file_id: access.file.file_id, status: 'ready' });
      }
    } catch (error) {
      return sendFailure(res, error);
    }
    return withManagedRead(req, res, 'preview', async (access, scope, recheck) => {
      await recheck(true);
      const payload = serializeManagedFileReadPreview(access.file.file_id, {
        text: (access.document?.text ?? access.file.text)!,
        structure: access.document?.structure ?? null,
      });
      const body = Buffer.from(payload, 'utf8');
      return {
        bytes: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
        release: async () => {
          scope.check();
          res.setHeader('Cache-Control', 'private, no-store');
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', body.byteLength);
          res.end(body);
        },
      };
    });
  }

  async function downloadURL(req: ManagedFileRouteRequest, res: Response) {
    if (req.query.read !== undefined && req.method !== 'GET')
      return sendFailure(res, unavailable('method_not_allowed'));
    const scope = readScope(req, res);
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      if (req.query.read === undefined) {
        const access = await scope.within(lookup(req, req.params.file_id));
        await scope.within(revalidate(req, access!));
        return res.status(501).json({ code: 'authenticated_download_required' });
      }
      if (
        req.query.read !== '1' ||
        !['original', 'preview'].includes(req.query.representation as string) ||
        Object.keys(req.query).some((key) => !['read', 'representation'].includes(key))
      )
        throw unavailable('invalid_request');
      const owner = getRuntime();
      if (!owner?.fileReads) throw unavailable('unavailable');
      const user = await scope.within(readPrincipal(req, owner));
      const reference = readReference(
        req,
        req.query.representation as ManagedFileReadRepresentation,
        false,
      );
      if (!reference) {
        const ticket = await scope.within(
          owner.fileReads.admitManagedFileRead(user, {
            fileId: req.params.file_id,
            representation: req.query.representation as ManagedFileReadRepresentation,
          }),
        );
        scope.check();
        return res.json(ticket);
      }
      const result = await scope.within(owner.fileReads.inspectManagedFileRead(user, reference));
      scope.check();
      if (result.status === 'completed') return res.status(204).end();
      if (['admitted', 'reading'].includes(result.status)) {
        res.setHeader('Retry-After', '1');
        return res.status(202).end();
      }
      if (result.status === 'refused' && result.reason === 'expired')
        return res.status(410).json({ code: 'managed_read_expired' });
      throw unavailable((result as { reason?: string }).reason ?? 'unavailable');
    } catch (error) {
      sendFailure(res, error);
    } finally {
      scope.close();
    }
  }

  async function list(req: ManagedFileRouteRequest, res: Response) {
    try {
      res.setHeader('Cache-Control', 'private, no-store');
      // Guest chat keeps its normal bootstrap; no managed file authority is minted.
      if (req.user?.provider !== 'email_code' || !getRuntime()) return res.json([]);
      const owner = getRuntime();
      const user = await principal(req, owner);
      const operations = (await owner!.management.list(user)).filter((operation) => {
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
              new Date(file.expiredAt as string | Date).getTime() > now(),
          )
          .map(publicFile),
      );
    } catch (error) {
      sendFailure(res, error);
    }
  }

  function owned<T>(
    handler: (req: ManagedFileRouteRequest, res: Response) => Promise<T>,
  ): (req: ManagedFileRouteRequest, res: Response) => Promise<T | void> {
    return async (req, res) => {
      try {
        const owner = getRuntime();
        // Disabled bootstrap retains its existing empty/read-unavailable behavior.
        if (!owner) return await handler(req, res);
        if (typeof owner.runFileOperation !== 'function') throw unavailable('unavailable');
        return await owner.runFileOperation(() => handler(req, res));
      } catch (error) {
        sendFailure(res, error);
      }
    };
  }

  return {
    download: owned(download),
    downloadURL: owned(downloadURL),
    preview: owned(preview),
    list: owned(list),
    authorize: (req: ManagedFileRouteRequest) => principal(req, getRuntime()),
    failure: sendFailure,
  };
}
