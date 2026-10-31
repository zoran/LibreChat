import { json, Router } from 'express';
import {
  UPLOAD_ERROR_CODES,
  isUploadPrincipal,
  readUploadAcceptedMetadata,
  readUploadIntakeTicket,
  readUploadStorageAvailability,
} from 'librechat-data-provider';
import type {
  ManagedUploadSnapshot,
  ManagedUploadView,
  UploadErrorCode,
  UploadOperation,
  UploadPrincipal,
  UploadRequest,
  UploadUsage,
  UploadIntakeTicket,
} from 'librechat-data-provider';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { UploadLiveHub, UploadRequestPrincipal } from './live';
import type { UploadManagement } from './management';
import { isUploadManagementError, UploadManagementError } from './errors';

type Attachment = NonNullable<ManagedUploadView['attachment']>;
type AuthorityOptions = { principal: UploadRequestPrincipal; allowedOrigins: readonly string[] };
export interface UploadHttpOptions extends AuthorityOptions {
  /** Existing Upload/File owner holds the original operation through all repository effects. */
  runFileOperation<T>(work: () => Promise<T>): Promise<T>;
  management: Pick<
    UploadManagement,
    'list' | 'usage' | 'reserve' | 'cancel' | 'delete' | 'retryProcessing' | 'assertAdmissionSafe'
  >;
  /** Existing File owner rechecks availability and supplies browser-safe attachment paths. */
  projectAttachments(
    principal: UploadPrincipal,
    operations: readonly UploadOperation[],
  ): Promise<ReadonlyMap<string, Attachment>>;
  status(): Pick<
    ManagedUploadSnapshot,
    'throttled' | 'waitingReason' | 'admissionsPaused' | 'storageAvailability'
  >;
  live: Pick<UploadLiveHub, 'open'>;
  /** A private native grant is retained server-side; only this bounded capability is returned. */
  issueIntake?(
    request: Request,
    principal: UploadPrincipal,
    id: string,
  ): Promise<UploadIntakeTicket>;
}
const safeStatuses: Partial<Record<UploadErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  unsupported_type: 415,
  idempotency_conflict: 409,
  quota_exceeded: 429,
  capacity_exceeded: 429,
  queue_full: 429,
  admission_paused: 503,
  not_ready: 409,
  lease_lost: 409,
  size_mismatch: 400,
  security_rejected: 422,
  security_uninspectable: 422,
  expired: 410,
  cancelled: 409,
};
function failure(response: Response, error: unknown) {
  if (response.headersSent || response.destroyed || response.writableEnded) return;
  const code = isUploadManagementError(error) ? error.code : 'unavailable';
  response.setHeader('Cache-Control', 'no-store');
  response.status(safeStatuses[code] ?? 503).json({ code });
}
function invalid(): never {
  throw new UploadManagementError('invalid_request');
}
function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
function exact(
  value: unknown,
  allowed: readonly string[],
): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !allowed.includes(key))) invalid();
}
function operationId(request: Request): string {
  const id = request.params.id;
  if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)) invalid();
  return id;
}
function publicOperation(row: UploadOperation): UploadOperation {
  if (row.scope.kind !== 'personal') throw new UploadManagementError('forbidden');
  const metadata = row.acceptedAt ? readUploadAcceptedMetadata({ filename: row.filename }) : null;
  return {
    version: 1,
    id: row.id,
    revision: row.revision,
    scope: { kind: 'personal' },
    ...(metadata ?? {}),
    mediaType: row.mediaType,
    declaredBytes: row.declaredBytes,
    actualBytes: row.actualBytes,
    state: row.state,
    createdAt: row.createdAt,
    acceptedAt: row.acceptedAt,
    expiresAt: row.expiresAt,
    fileId: row.fileId,
    error: row.error && UPLOAD_ERROR_CODES.includes(row.error) ? row.error : undefined,
    cleanupPending: row.cleanupPending,
    canUseInComposer: row.canUseInComposer,
    canRetryProcessing: row.canRetryProcessing,
  };
}
function publicUsage(row: UploadUsage): UploadUsage {
  return {
    limitBytes: row.limitBytes,
    usedBytes: row.usedBytes,
    reservedBytes: row.reservedBytes,
    availableBytes: row.availableBytes,
    retainedBytes: row.retainedBytes,
    nextReleaseAt: row.nextReleaseAt,
    nextReleaseBytes: row.nextReleaseBytes,
  };
}
function publicAttachment(row: Attachment): Attachment {
  return {
    file_id: row.file_id,
    filename: row.filename,
    filepath: row.filepath,
    type: row.type,
    source: row.source,
    bytes: row.bytes,
    embedded: row.embedded,
    llmDeliveryPath: row.llmDeliveryPath,
  };
}
function authority(options: AuthorityOptions) {
  if (!options.allowedOrigins.length || options.allowedOrigins.length > 8)
    throw new Error('invalid_upload_origins');
  const origins = new Set(
    options.allowedOrigins.map((origin) => {
      const parsed = new URL(origin);
      if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== origin)
        throw new Error('invalid_upload_origin');
      return origin;
    }),
  );
  return async (request: Request, expected?: UploadPrincipal): Promise<UploadPrincipal> => {
    if (request.url.includes('?')) invalid();
    const origin = request.headers.origin;
    if (
      origin
        ? !origins.has(origin)
        : request.method !== 'GET' || request.headers['sec-fetch-site'] !== 'same-origin'
    ) {
      throw new UploadManagementError('forbidden');
    }
    const principal = await options.principal(request);
    if (
      !isUploadPrincipal(principal) ||
      (expected &&
        (expected.authentication !== principal.authentication ||
          expected.tenantId !== principal.tenantId ||
          expected.userId !== principal.userId))
    ) {
      throw new UploadManagementError('unauthorized');
    }
    return principal;
  };
}
const wrap =
  (work: (request: Request, response: Response) => Promise<void>): RequestHandler =>
  (request, response) => {
    void work(request, response).catch((error) => failure(response, error));
  };
const parseSmallJson = json({
  limit: 4096,
  strict: true,
  inflate: false,
  type: 'application/json',
});

/** Mount at /api/uploads before global body parsers so the 4 KiB metadata cap is effective. */
export function createUploadHttpRouter(options: UploadHttpOptions): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const owned = (work: (request: Request, response: Response) => Promise<void>): RequestHandler =>
    wrap((request, response) => options.runFileOperation(() => work(request, response)));
  const authenticate = authority(options);
  const principals = new WeakMap<Request, UploadPrincipal>();
  router.use((request, response, next) => {
    if (!['GET', 'POST', 'DELETE'].includes(request.method)) {
      response.status(405).json({ code: 'invalid_request' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    void authenticate(request).then(
      (principal) => {
        principals.set(request, principal);
        next();
      },
      (error) => failure(response, error),
    );
  });
  const principal = (request: Request) => principals.get(request)!;
  const sendOperation = async (request: Request, response: Response, result: UploadOperation) => {
    await authenticate(request, principal(request));
    response.status(202).json(publicOperation(result));
  };
  const metadata: RequestHandler = (request, response, next) => {
    // A preceding global parser makes the raw limit unverifiable; fail closed on bad composition.
    if (
      request.body !== undefined ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')
    ) {
      failure(response, new UploadManagementError('invalid_request'));
      return;
    }
    parseSmallJson(request, response, (error?: unknown) => {
      if (error) failure(response, new UploadManagementError('invalid_request'));
      else next();
    });
  };
  router.get(
    '/',
    owned(async (request, response) => {
      if (
        request.body !== undefined ||
        request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0')
      )
        invalid();
      const owner = principal(request);
      // A rejected list cannot release custody while its sibling usage query is still original.
      const [listed, measured] = await Promise.allSettled([
        options.management.list(owner),
        options.management.usage(owner),
      ]);
      if (listed.status === 'rejected') throw listed.reason;
      if (measured.status === 'rejected') throw measured.reason;
      const rows = listed.value;
      const usage = measured.value;
      if (rows.length > 100) throw new UploadManagementError('unavailable');
      const operations = rows.map(publicOperation);
      const attachments = await options.projectAttachments(
        owner,
        operations.filter((row) => row.canUseInComposer),
      );
      const view: ManagedUploadView[] = operations.map((row) => {
        const attachment =
          row.fileId && row.canUseInComposer ? attachments.get(row.fileId) : undefined;
        if (!attachment || attachment.file_id !== row.fileId)
          return { ...row, canUseInComposer: false };
        return { ...row, attachment: publicAttachment(attachment) };
      });
      await authenticate(request, owner);
      const status = options.status();
      const snapshot: ManagedUploadSnapshot = {
        version: 1,
        operations: view,
        usage: publicUsage(usage),
        throttled: status.throttled,
        waitingReason: status.waitingReason,
        admissionsPaused:
          typeof status.admissionsPaused === 'boolean' ? status.admissionsPaused : null,
        ...('storageAvailability' in status
          ? {
              storageAvailability: readUploadStorageAvailability(status.storageAvailability) ?? {
                available: false,
                reason: 'storage-unavailable',
              },
            }
          : {}),
      };
      response.json(snapshot);
    }),
  );
  router.get(
    '/events',
    wrap(async (request, response) => {
      await options.live.open(request, response, principal(request));
    }),
  );
  router.post(
    '/operations',
    metadata,
    owned(async (request, response) => {
      const body: unknown = request.body;
      exact(body, ['mediaType', 'declaredBytes', 'idempotencyKey', 'scope']);
      if (
        typeof body.mediaType !== 'string' ||
        typeof body.declaredBytes !== 'number' ||
        typeof body.idempotencyKey !== 'string' ||
        body.idempotencyKey.length !== 36 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          body.idempotencyKey,
        )
      )
        invalid();
      if (body.scope !== undefined) {
        exact(body.scope, ['kind']);
        if (body.scope.kind !== 'personal') throw new UploadManagementError('forbidden');
      }
      const input: UploadRequest = {
        mediaType: body.mediaType,
        declaredBytes: body.declaredBytes,
        idempotencyKey: body.idempotencyKey,
        ...(body.scope === undefined ? {} : { scope: { kind: 'personal' } as const }),
      };
      await sendOperation(
        request,
        response,
        await options.management.reserve(principal(request), input),
      );
    }),
  );
  for (const action of ['cancel', 'retry'] as const) {
    router.post(
      `/operations/:id/${action}`,
      metadata,
      owned(async (request, response) => {
        exact(request.body, []);
        const method = action === 'cancel' ? 'cancel' : 'retryProcessing';
        await sendOperation(
          request,
          response,
          await options.management[method](principal(request), operationId(request)),
        );
      }),
    );
  }
  router.post(
    '/operations/:id/intake',
    metadata,
    owned(async (request, response) => {
      exact(request.body, []);
      if (!options.issueIntake) throw new UploadManagementError('unavailable');
      await options.management.assertAdmissionSafe();
      const id = operationId(request);
      const ticket = readUploadIntakeTicket(
        await options.issueIntake(request, principal(request), id),
      );
      if (!ticket || ticket.operationId !== id || Date.parse(ticket.expiresAt) <= Date.now())
        throw new UploadManagementError('unavailable');
      await authenticate(request, principal(request));
      response.json(ticket);
    }),
  );
  router.delete(
    '/operations/:id',
    owned(async (request, response) => {
      if (
        request.body !== undefined ||
        request.headers['transfer-encoding'] ||
        (request.headers['content-length'] && request.headers['content-length'] !== '0')
      )
        invalid();
      await sendOperation(
        request,
        response,
        await options.management.delete(principal(request), operationId(request)),
      );
    }),
  );
  router.use((_request, response) => {
    failure(response, new UploadManagementError('not_found'));
  });
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    failure(response, error);
  });
  return router;
}

/** Mount this separate PUT router before every global parser; it never installs a body parser. */
export function createUploadBodyRouter(
  options: AuthorityOptions & { body: RequestHandler },
): Router {
  const router = Router({ caseSensitive: true, strict: true });
  const authenticate = authority(options);
  router.put(
    '/operations/:id/body',
    wrap(async (request, response) => {
      request.pause();
      await authenticate(request);
      operationId(request);
      if (request.body !== undefined) invalid();
      await options.body(request, response, (error?: unknown) =>
        failure(response, error ?? new UploadManagementError('unavailable')),
      );
    }),
  );
  router.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    failure(response, error);
  });
  return router;
}
