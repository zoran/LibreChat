/** Managed File source access shared by previews and normal chat context. No retrieval index. */
import { createHash } from 'node:crypto';
import {
  isUploadPrincipal,
  isUploadOriginalIntegrity,
  isUploadSecurityApproval,
  isUploadStorageReceipt,
  readManagedDocumentResult,
  matchesUploadSecurityApproval,
} from 'librechat-data-provider';
import type {
  ManagedDocumentResult,
  UploadCleanupTask,
  UploadOperation,
  UploadPrincipal,
  UploadStorageReceipt,
  UploadSecurityApproval,
} from 'librechat-data-provider';
import type { StoragePort } from '~/uploads/contract';

export const MANAGED_SOURCE_FILE_FIELDS =
  'file_id uploadOperationId tenantId user filename type source bytes embedded llmDeliveryPath status expiredAt retentionAcceptedAt deletionRequestedAt deletionCompletedAt storageKey';

/** Repository adapter input; database-specific identity/date objects do not escape the resolver. */
export type ManagedSourceRecord = {
  file_id: string;
  uploadOperationId?: string;
  tenantId?: string | null;
  user?: unknown;
  filename?: string;
  type: string;
  source: string;
  bytes: number;
  embedded?: boolean;
  llmDeliveryPath?: string;
  status?: string;
  expiredAt?: Date | string | null;
  retentionAcceptedAt?: Date | string | null;
  deletionRequestedAt?: Date | string | null;
  deletionCompletedAt?: Date | string | null;
  storageKey?: string;
  text?: string;
  documentStructure?: unknown;
  securityApproval?: unknown;
};
type SourceRequest = {
  method?: string;
  headers: { origin?: string; 'sec-fetch-site'?: string | string[] };
  user?: { id?: string; tenantId?: string | null };
};
type Operation = Pick<
  UploadOperation,
  'id' | 'fileId' | 'scope' | 'state' | 'canUseInComposer' | 'actualBytes' | 'expiresAt'
>;
type Options = {
  allowedOrigins: readonly string[];
  principal(request: SourceRequest): Promise<UploadPrincipal>;
  operation(principal: UploadPrincipal, id: string): Promise<Operation>;
  file(principal: UploadPrincipal, id: string, text: boolean): Promise<ManagedSourceRecord | null>;
  original(principal: UploadPrincipal, id: string): Promise<UploadCleanupTask | null>;
  policySha256(): string | undefined;
  storage: Pick<StoragePort, 'read'>;
  now?: () => number;
};
type ReadOptions = { text?: boolean; original?: boolean; signal?: AbortSignal };

export type ManagedSourceAccess = Readonly<{
  file: Readonly<{
    file_id: string;
    filename: string;
    type: string;
    source: string;
    bytes: number;
    embedded: true;
    llmDeliveryPath?: string;
    expiredAt: string;
    text?: string;
  }>;
  document?: ManagedDocumentResult;
  receipt?: UploadStorageReceipt;
  expiresAt: number;
  storage: Pick<StoragePort, 'read'>;
}>;

export type ManagedSourceResolver = {
  authorize(request: SourceRequest, expected?: UploadPrincipal): Promise<UploadPrincipal>;
  resolve(request: SourceRequest, id: string, input?: ReadOptions): Promise<ManagedSourceAccess>;
  revalidate(request: SourceRequest, access: ManagedSourceAccess): Promise<void>;
};

const unavailable = (code = 'not_found') => Object.assign(new Error(code), { code });

/** Validated document/receipt trees contain data only; freeze the complete detached tree. */
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** Same ready/personal operation rule for source reads and the existing library projection. */
export function managedSourceExpiry(operation: Operation, id: string, now: number): number {
  const expiry = Date.parse(operation?.expiresAt ?? '');
  if (
    operation?.id !== id ||
    operation.fileId !== id ||
    operation.scope?.kind !== 'personal' ||
    operation.state !== 'ready' ||
    operation.canUseInComposer !== true ||
    !Number.isFinite(expiry) ||
    expiry <= now
  )
    throw unavailable();
  return expiry;
}

/** Private handles bind the exact source snapshot; request/JSON objects cannot manufacture one. */
export function createManagedSourceResolver(options: Options): ManagedSourceResolver {
  const now = options.now ?? Date.now;
  const allowedOrigins = Object.freeze([...options.allowedOrigins]);
  const bindings = new WeakMap<
    ManagedSourceAccess,
    {
      user: UploadPrincipal;
      id: string;
      read: ReadOptions;
      fingerprint: string;
      expiresAt: number;
    }
  >();

  async function authorize(request: SourceRequest, expected?: UploadPrincipal) {
    const origin = request.headers.origin;
    if (!allowedOrigins.length) throw unavailable();
    if (
      origin
        ? !allowedOrigins.includes(origin)
        : request.method !== 'GET' || request.headers['sec-fetch-site'] !== 'same-origin'
    )
      throw unavailable('forbidden');
    const result = await options.principal(request);
    if (
      !isUploadPrincipal(result) ||
      (expected &&
        (result.authentication !== expected.authentication ||
          result.tenantId !== expected.tenantId ||
          result.userId !== expected.userId))
    )
      throw unavailable('unauthorized');
    if (request.user?.id && request.user.id !== result.userId) throw unavailable('unauthorized');
    if (request.user?.tenantId !== undefined && request.user.tenantId !== result.tenantId)
      throw unavailable('unauthorized');
    return Object.freeze({ ...result });
  }

  async function read(user: UploadPrincipal, id: string, input: ReadOptions) {
    input.signal?.throwIfAborted();
    const raw = await options.file(user, id, input.text === true);
    input.signal?.throwIfAborted();
    const expiry = new Date(raw?.expiredAt ?? '').getTime();
    if (
      !raw ||
      raw.file_id !== id ||
      raw.uploadOperationId !== id ||
      raw.user?.toString() !== user.userId ||
      raw.tenantId !== user.tenantId ||
      raw.status !== 'ready' ||
      raw.embedded !== true ||
      !raw.retentionAcceptedAt ||
      raw.deletionRequestedAt ||
      raw.deletionCompletedAt ||
      !Number.isFinite(expiry) ||
      expiry <= now() ||
      !Number.isSafeInteger(raw.bytes) ||
      raw.bytes < 1 ||
      raw.bytes > 30 * 1024 * 1024
    )
      throw unavailable();

    // Detach every value consumed after the next await, including private approval and source data.
    const file = Object.freeze({
      file_id: id,
      filename: raw.filename ?? '',
      type: raw.type,
      source: raw.source,
      bytes: raw.bytes,
      embedded: true as const,
      llmDeliveryPath: raw.llmDeliveryPath,
      expiredAt: new Date(expiry).toISOString(),
      ...(input.text && { text: raw.text }),
    });
    const storageKey = raw.storageKey;
    let approval: UploadSecurityApproval | undefined;
    if (raw.securityApproval !== undefined) {
      if (!isUploadSecurityApproval(raw.securityApproval)) throw unavailable();
      approval = {
        ...raw.securityApproval,
        subject: { ...raw.securityApproval.subject },
        coverage: { ...raw.securityApproval.coverage },
      };
    }
    let document: ManagedDocumentResult | undefined;
    if (input.text && Object.prototype.hasOwnProperty.call(raw, 'documentStructure')) {
      document =
        readManagedDocumentResult({ text: file.text, structure: raw.documentStructure }) ??
        undefined;
      if (!document) throw unavailable();
    }
    if (
      input.text &&
      (typeof file.text !== 'string' || Buffer.byteLength(file.text) > 15 * 1024 * 1024)
    )
      throw unavailable();
    let receipt: UploadStorageReceipt | undefined;
    let generation: number | undefined;
    const policy = options.policySha256();
    if (input.original || document) {
      const task = await options.original(user, id);
      input.signal?.throwIfAborted();
      if (!isUploadStorageReceipt(task?.original)) throw unavailable();
      receipt = {
        ...task.original,
        ...(task.original.integrity && {
          integrity: {
            ...task.original.integrity,
            chunkSha256: [...task.original.integrity.chunkSha256],
          },
        }),
      };
      generation = task?.attemptGeneration;
      if (
        task?.operationId !== id ||
        task.fileId !== id ||
        task.state !== 'ready' ||
        task.principal?.tenantId !== user.tenantId ||
        task.principal?.userId !== user.userId ||
        receipt?.outcome !== 'durable' ||
        receipt.source !== 's3' ||
        !receipt.storageKey ||
        receipt.storageKey !== storageKey ||
        receipt.bytes !== file.bytes
      )
        throw unavailable();
      if (document) {
        if (generation === undefined || typeof policy !== 'string') throw unavailable();
        const source = document.structure.source;
        if (
          !isUploadOriginalIntegrity(receipt.integrity, receipt.bytes) ||
          source.sha256 !== receipt.integrity.sha256 ||
          source.bytes !== file.bytes ||
          source.mediaType !== file.type ||
          !matchesUploadSecurityApproval(
            approval,
            {
              tenantId: user.tenantId,
              userId: user.userId,
              operationId: id,
              transferGeneration: generation,
              mediaType: file.type,
              bytes: file.bytes,
              sha256: source.sha256,
            },
            policy,
            now(),
          )
        )
          throw unavailable();
      }
    }
    // get() includes the native live-File availability query. Keep this last, after the
    // original receipt await, so revocation during that read cannot disclose a stale source.
    const operation = await options.operation(user, id);
    input.signal?.throwIfAborted();
    const operationExpiry = managedSourceExpiry(operation, id, now());
    if (operation.actualBytes !== file.bytes) throw unavailable();
    if (policy !== options.policySha256() || Math.min(operationExpiry, expiry) <= now())
      throw unavailable();
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          file,
          document,
          receipt,
          generation,
          approval,
          storageKey,
          policy,
        }),
      )
      .digest('hex');
    return { file, document, receipt, expiresAt: Math.min(operationExpiry, expiry), fingerprint };
  }

  async function resolve(request: SourceRequest, id: string, input: ReadOptions = {}) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(id)) throw unavailable();
    const selected = {
      text: input.text === true,
      original: input.original === true,
      signal: input.signal,
    };
    const user = await authorize(request);
    const value = await read(user, id, selected);
    const binding = {
      user,
      id,
      read: selected,
      fingerprint: value.fingerprint,
      expiresAt: value.expiresAt,
    };
    const access: ManagedSourceAccess = Object.freeze({
      file: value.file,
      document: freezeData(value.document),
      receipt: freezeData(value.receipt),
      get expiresAt() {
        return binding.expiresAt;
      },
      storage: options.storage,
    });
    bindings.set(access, binding);
    return access;
  }

  async function revalidate(request: SourceRequest, access: ManagedSourceAccess) {
    const binding = bindings.get(access);
    if (!binding) throw unavailable();
    binding.read.signal?.throwIfAborted();
    const user = await authorize(request, binding.user);
    if (binding.read.text) {
      const current = await read(user, binding.id, binding.read);
      if (current.fingerprint !== binding.fingerprint) throw unavailable();
      binding.expiresAt = Math.min(binding.expiresAt, current.expiresAt);
    } else {
      const operation = await options.operation(user, binding.id);
      binding.expiresAt = Math.min(
        binding.expiresAt,
        managedSourceExpiry(operation, binding.id, now()),
      );
      if (operation.actualBytes !== access.file.bytes) throw unavailable();
    }
    binding.read.signal?.throwIfAborted();
    if (access.expiresAt <= now()) throw unavailable();
  }
  return { authorize, resolve, revalidate };
}

export type ManagedContextSources = {
  resolve(id: string): Promise<ManagedSourceAccess>;
  revalidate(access: ManagedSourceAccess): Promise<void>;
};

/** Trusted composition only; no request field selects or replaces this capability. */
export function bindManagedContextSources(
  request: SourceRequest,
  resolver: ManagedSourceResolver | undefined,
  required: boolean,
): ManagedContextSources | undefined {
  if (!required) return undefined;
  const requireResolver = () => {
    if (!resolver) throw unavailable('unavailable');
    return resolver;
  };
  return {
    resolve: (id) => requireResolver().resolve(request, id, { text: true }),
    revalidate: (access) => requireResolver().revalidate(request, access),
  };
}
