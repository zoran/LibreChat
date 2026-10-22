import { createFallbackRetentionDate } from '@librechat/data-schemas';
import {
  isAllDataRetention,
  isForcedTemporaryRetention,
  isNativelyReadableText,
  documentParserMimeTypes,
  quoteSourceRefSchema,
  UPLOAD_DERIVED_MAX_SOURCES,
} from 'librechat-data-provider';
import type {
  AppConfig,
  FileOwnerScope,
  CheckpointSourceBinding,
  FileRetentionAdmission,
  SourceRetentionContext,
  ResolvedQuoteRetention,
} from '@librechat/data-schemas';
import type { QuoteSourceRef } from 'librechat-data-provider';

type InterfaceConfig = AppConfig['interfaceConfig'];

const retentionExpiryCache = new WeakMap<
  RetentionRequest,
  {
    key: string;
    promise: Promise<RetentionExpiry>;
  }
>();

export type RetentionConversation = {
  isTemporary?: boolean | null;
  expiredAt?: Date | string | number | null;
};

export type RetentionRequest = {
  /** Owner-authenticated source row for operations attached to an existing message. */
  fileRetentionSource?: RetentionConversation;
  user?: {
    id?: string;
    tenantId?: string;
  };
  body?: {
    conversationId?: string;
    isTemporary?: boolean | string | null;
  };
  file?: { mimetype?: string };
  config?: {
    fileConfig?: { retentionHours?: number };
    interfaceConfig?: InterfaceConfig;
  };
};

export type RetentionExpiry = {
  retention?: FileRetentionAdmission;
  expiredAt?: Date | null;
};

const documentAdmissions = new WeakMap<RetentionRequest, FileRetentionAdmission>();

/** Capture once before parsing/storage; subsequent calls cannot renew an original's clock. */
export async function getDocumentFileRetention(
  req: RetentionRequest | null | undefined,
  inherited: RetentionExpiry | Promise<RetentionExpiry>,
): Promise<RetentionExpiry> {
  const hours = req?.config?.fileConfig?.retentionHours;
  const mime = req?.file?.mimetype;
  if (
    !req ||
    hours == null ||
    !mime ||
    !(isNativelyReadableText(mime) || documentParserMimeTypes.some((pattern) => pattern.test(mime)))
  ) {
    return inherited;
  }
  if (!Number.isFinite(hours) || hours <= 0) throw new Error('Invalid document retention');
  let admission = documentAdmissions.get(req);
  if (!admission) {
    const acceptedAt = new Date();
    const expiredAt = new Date(acceptedAt.getTime() + hours * 3600000);
    if (!Number.isFinite(expiredAt.getTime())) throw new Error('Invalid document deadline');
    admission = { acceptedAt, expiredAt };
    documentAdmissions.set(req, admission);
  }
  const previous = await inherited;
  const earlier = previous.expiredAt == null ? undefined : new Date(previous.expiredAt.getTime());
  if (earlier && !Number.isFinite(earlier.getTime())) throw new Error('Invalid inherited deadline');
  const captured = documentAdmissions.get(req) ?? admission;
  const deadline =
    captured.expiredAt < admission.expiredAt ? captured.expiredAt : admission.expiredAt;
  const expiredAt = earlier && earlier < deadline ? earlier : deadline;
  admission = { acceptedAt: admission.acceptedAt, expiredAt };
  documentAdmissions.set(req, admission);
  return { ...previous, expiredAt, retention: admission };
}

/** Decode only a server-owned context (job wire dates are epoch milliseconds). */
export function readFileSourceRetention(value: unknown): SourceRetentionContext | undefined {
  if (value == null) return undefined;
  const data = value as { sourceFileIds?: unknown; sourceExpiresAt?: unknown };
  if (
    !Array.isArray(data.sourceFileIds) ||
    data.sourceFileIds.length === 0 ||
    data.sourceFileIds.some((id) => typeof id !== 'string' || id.length === 0) ||
    !(data.sourceExpiresAt instanceof Date || typeof data.sourceExpiresAt === 'number')
  ) {
    throw new Error('Invalid server source retention');
  }
  const sourceExpiresAt = new Date(
    data.sourceExpiresAt instanceof Date ? data.sourceExpiresAt.getTime() : data.sourceExpiresAt,
  );
  if (!Number.isFinite(sourceExpiresAt.getTime())) throw new Error('Invalid source deadline');
  return { sourceFileIds: [...new Set(data.sourceFileIds as string[])], sourceExpiresAt };
}

/** Private job/steer wire representation; never accept this from an HTTP body. */
export type SerializedQuoteRetention = Omit<ResolvedQuoteRetention, 'quoteSourceRetention'> & {
  quoteSourceRetention: Array<
    Omit<ResolvedQuoteRetention['quoteSourceRetention'][number], 'sourceExpiresAt'> & {
      sourceExpiresAt: number;
    }
  >;
  quoteSourceRefs?: Array<QuoteSourceRef | null>;
};

export function serializeQuoteRetention(
  value: ResolvedQuoteRetention,
  quoteSourceRefs?: readonly (QuoteSourceRef | null)[],
): SerializedQuoteRetention {
  if (quoteSourceRefs && quoteSourceRefs.length !== value.quotes.length) {
    throw new Error('Misaligned quote source references');
  }
  return {
    quotes: [...value.quotes],
    quoteSourceRetention: value.quoteSourceRetention.map((entry) => ({
      ...entry,
      sourceRef: { ...entry.sourceRef },
      sourceFileIds: [...entry.sourceFileIds],
      sourceExpiresAt: entry.sourceExpiresAt.getTime(),
    })),
    sourceMessageConditions: value.sourceMessageConditions.map((condition) => ({ ...condition })),
    ...(quoteSourceRefs && {
      quoteSourceRefs: quoteSourceRefs.map((ref) => (ref == null ? null : { ...ref })),
    }),
  };
}

export function deserializeQuoteRetention(value: unknown): ResolvedQuoteRetention {
  const raw = value as SerializedQuoteRetention | null;
  // Redis Lua cjson represents an empty JSON array as an empty object after encoding.
  // Normalize only these private wire array fields; nonempty objects remain invalid.
  const array = (entry: unknown) =>
    entry != null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    Object.keys(entry).length === 0
      ? []
      : entry;
  const data =
    raw &&
    ({
      ...raw,
      quotes: array(raw.quotes),
      quoteSourceRetention: array(raw.quoteSourceRetention),
      sourceMessageConditions: array(raw.sourceMessageConditions),
      ...(raw.quoteSourceRefs != null && { quoteSourceRefs: array(raw.quoteSourceRefs) }),
    } as SerializedQuoteRetention | null);
  if (
    !data ||
    !Array.isArray(data.quotes) ||
    data.quotes.length > 10 ||
    data.quotes.some((text) => typeof text !== 'string' || !text.trim() || text.length > 1500) ||
    !Array.isArray(data.quoteSourceRetention) ||
    !Array.isArray(data.sourceMessageConditions)
  ) {
    throw new Error('Invalid server quote retention');
  }
  if (
    data.quoteSourceRefs != null &&
    (!Array.isArray(data.quoteSourceRefs) || data.quoteSourceRefs.length !== data.quotes.length)
  ) {
    throw new Error('Misaligned server quote references');
  }
  data.quoteSourceRefs?.forEach((ref) => {
    if (ref != null) quoteSourceRefSchema.parse(ref);
  });
  const indices = new Set<number>();
  return {
    quotes: [...data.quotes],
    quoteSourceRetention: data.quoteSourceRetention.map((entry) => {
      if (
        !entry ||
        !Number.isInteger(entry.index) ||
        entry.index < 0 ||
        entry.index >= data.quotes.length ||
        indices.has(entry.index)
      ) {
        throw new Error('Invalid server quote index');
      }
      indices.add(entry.index);
      const context = readFileSourceRetention(entry)!;
      return {
        index: entry.index,
        sourceRef: quoteSourceRefSchema.parse(entry.sourceRef),
        sourceFileIds: [...context.sourceFileIds],
        sourceExpiresAt: context.sourceExpiresAt,
      };
    }),
    sourceMessageConditions: data.sourceMessageConditions.map((condition) => {
      if (
        !condition ||
        typeof condition.messageId !== 'string' ||
        !condition.messageId ||
        (condition.messageVersion !== null &&
          (!Number.isInteger(condition.messageVersion) || condition.messageVersion < 0))
      ) {
        throw new Error('Invalid server quote source version');
      }
      return { ...condition };
    }),
  };
}

export function quoteRetentionContext(
  value: ResolvedQuoteRetention,
): SourceRetentionContext | undefined {
  if (value.quoteSourceRetention.length === 0) return undefined;
  return {
    sourceFileIds: [...new Set(value.quoteSourceRetention.flatMap((entry) => entry.sourceFileIds))],
    sourceExpiresAt: new Date(
      Math.min(...value.quoteSourceRetention.map((entry) => entry.sourceExpiresAt.getTime())),
    ),
  };
}

/** Redact authoritative unavailable IDs; captured File expiry never grants or revokes a new read. */
export function redactQuoteRetention(
  value: SerializedQuoteRetention,
  revokedFileIds: readonly string[],
): SerializedQuoteRetention {
  const decoded = deserializeQuoteRetention(value);
  const revoked = new Set(revokedFileIds);
  const byIndex = new Map(decoded.quoteSourceRetention.map((entry) => [entry.index, entry]));
  const retained: ResolvedQuoteRetention = {
    quotes: [],
    quoteSourceRetention: [],
    sourceMessageConditions: [],
  };
  const refs: Array<QuoteSourceRef | null> | undefined = value.quoteSourceRefs && [];
  decoded.quotes.forEach((text, index) => {
    const binding = byIndex.get(index);
    if (binding && binding.sourceFileIds.some((id) => revoked.has(id))) return;
    if (binding) retained.quoteSourceRetention.push({ ...binding, index: retained.quotes.length });
    retained.quotes.push(text);
    refs?.push(value.quoteSourceRefs![index]);
  });
  const sourceIds = refs && new Set(refs.flatMap((ref) => (ref ? [ref.messageId] : [])));
  retained.sourceMessageConditions = decoded.sourceMessageConditions.filter(
    (condition) => retained.quotes.length > 0 && (!sourceIds || sourceIds.has(condition.messageId)),
  );
  return serializeQuoteRetention(retained, refs);
}

export type AgentFileRetentionRequest = {
  req: RetentionRequest | null | undefined;
  messageAttachment?: boolean | null;
  toolResource?: string | null;
};

export type RetentionLogger = {
  error: (message: string, error?: unknown) => void;
};

export type RetentionDependencies = {
  getConvo: (
    userId: string,
    conversationId: string,
  ) => Promise<RetentionConversation | null | undefined>;
  createExpirationDate: (interfaceConfig?: InterfaceConfig, isTemporary?: boolean) => Date;
  logger?: RetentionLogger;
};

export type SharedLinkRetentionDependencies = {
  getConvo: (
    userId: string,
    conversationId: string,
  ) => Promise<RetentionConversation | null | undefined>;
  createExpirationDate: (interfaceConfig?: InterfaceConfig, isTemporary?: boolean) => Date;
  logger?: RetentionLogger;
};

export const isBooleanOrStringTrue = (value: unknown): boolean =>
  value === true || value === 'true';

export const getConversationExpirationDate = (
  convo?: RetentionConversation | null,
): Date | null => {
  if (convo?.expiredAt == null) {
    return null;
  }

  const expiredAt = convo.expiredAt instanceof Date ? convo.expiredAt : new Date(convo.expiredAt);
  return Number.isNaN(expiredAt.getTime()) ? null : expiredAt;
};

export const isActiveExpirationDate = (expiredAt: Date, now: Date = new Date()): boolean =>
  expiredAt > now;

const createRetentionExpiry = (
  req: RetentionRequest | null | undefined,
  { createExpirationDate, logger }: RetentionDependencies,
  isTemporary = isBooleanOrStringTrue(req?.body?.isTemporary),
): RetentionExpiry => {
  try {
    return { expiredAt: createExpirationDate(req?.config?.interfaceConfig, isTemporary) };
  } catch (err) {
    logger?.error('[getRetentionExpiry] Error creating file expiration date:', err);
    return { expiredAt: createFallbackRetentionDate() };
  }
};

const getRetentionCacheKey = (req: RetentionRequest): string =>
  [
    req.config?.interfaceConfig?.retentionMode ?? '',
    req.config?.interfaceConfig?.temporaryChatRetention ?? '',
    req.config?.interfaceConfig?.generalChatRetention ?? '',
    req.user?.id ?? '',
    req.body?.conversationId ?? '',
    String(req.body?.isTemporary ?? ''),
    String(req.fileRetentionSource?.expiredAt ?? ''),
    String(req.fileRetentionSource?.isTemporary ?? ''),
    String(req.fileRetentionSource != null),
  ].join('|');

async function computeRetentionExpiry(
  req: RetentionRequest | null | undefined,
  dependencies: RetentionDependencies,
): Promise<RetentionExpiry> {
  const interfaceConfig = req?.config?.interfaceConfig;
  const isForcedTemporary = isForcedTemporaryRetention(interfaceConfig?.retentionMode);
  const isRetentionAll = isAllDataRetention(interfaceConfig?.retentionMode);
  const conversationId = req?.body?.conversationId;
  const userId = req?.user?.id;
  /** A source message's stored deadline wins in every mode, so a file attached late in a
   *  chat never outlives the message and conversation that reference it. */
  if (req?.fileRetentionSource != null) {
    const source = req.fileRetentionSource;
    const expiredAt = getConversationExpirationDate(source);
    if (expiredAt != null) {
      return { expiredAt };
    }
    const isTemporary = isForcedTemporary || source.isTemporary === true;
    return isRetentionAll || isTemporary
      ? createRetentionExpiry(req, dependencies, isTemporary)
      : {};
  }
  if (isForcedTemporary) {
    return createRetentionExpiry(req, dependencies, true);
  }
  if (
    isRetentionAll &&
    (interfaceConfig?.generalChatRetention === undefined ||
      (req?.body?.isTemporary != null && !(conversationId && userId)))
  ) {
    return createRetentionExpiry(req, dependencies);
  }

  if (conversationId && userId) {
    try {
      const convo = await dependencies.getConvo(userId, conversationId);
      if (convo) {
        const expiredAt = getConversationExpirationDate(convo);
        if (expiredAt == null) {
          if (isRetentionAll || isBooleanOrStringTrue(req?.body?.isTemporary)) {
            return createRetentionExpiry(req, dependencies, convo.isTemporary === true);
          }
          return {};
        }

        if (!isActiveExpirationDate(expiredAt)) {
          return { expiredAt };
        }

        return createRetentionExpiry(req, dependencies, convo.isTemporary !== false);
      }
    } catch (err) {
      dependencies.logger?.error(
        '[getRetentionExpiry] Error checking conversation retention:',
        err,
      );
      if (isRetentionAll) {
        const temporaryExpiry = createRetentionExpiry(req, dependencies, true).expiredAt;
        const generalExpiry = createRetentionExpiry(req, dependencies, false).expiredAt;
        if (temporaryExpiry && generalExpiry) {
          return { expiredAt: temporaryExpiry < generalExpiry ? temporaryExpiry : generalExpiry };
        }
        return { expiredAt: temporaryExpiry ?? generalExpiry };
      }
      if (isBooleanOrStringTrue(req?.body?.isTemporary)) {
        return createRetentionExpiry(req, dependencies, true);
      }
      return {};
    }
  }

  if (!isRetentionAll && !isBooleanOrStringTrue(req?.body?.isTemporary)) {
    return {};
  }

  return createRetentionExpiry(req, dependencies);
}

export async function getRetentionExpiry(
  req: RetentionRequest | null | undefined,
  dependencies: RetentionDependencies,
): Promise<RetentionExpiry> {
  if (!req) {
    return {};
  }

  const key = getRetentionCacheKey(req);
  const cached = retentionExpiryCache.get(req);
  if (cached?.key === key) {
    return cached.promise;
  }

  const promise = computeRetentionExpiry(req, dependencies);
  retentionExpiryCache.set(req, { key, promise });
  return promise;
}

const isPersistentAgentResourceUpload = ({
  messageAttachment,
  toolResource,
}: Omit<AgentFileRetentionRequest, 'req'>): boolean => !messageAttachment && !!toolResource;

const shouldRetainPersistentAgentFile = ({
  req,
  messageAttachment,
  toolResource,
}: AgentFileRetentionRequest): boolean => {
  const interfaceConfig = req?.config?.interfaceConfig;
  return (
    isPersistentAgentResourceUpload({ messageAttachment, toolResource }) &&
    (!isAllDataRetention(interfaceConfig?.retentionMode) ||
      interfaceConfig?.retainAgentFiles === true)
  );
};

export async function getAgentFileRetentionExpiry(
  params: AgentFileRetentionRequest,
  dependencies: RetentionDependencies,
): Promise<RetentionExpiry> {
  if (shouldRetainPersistentAgentFile(params)) {
    return {};
  }

  const inherited = getRetentionExpiry(params.req, dependencies);
  return params.messageAttachment ? getDocumentFileRetention(params.req, inherited) : inherited;
}

/**
 * Resolves the retention deadline for a shared link derived from a conversation.
 *
 * Return values are intentionally tri-state:
 * - `undefined`: no decision can be made because the conversation id or row is missing.
 * - `null`: the share should be stored without an expiration.
 * - `Date`: the share should expire at that date; callers reject already-expired dates.
 */
export async function getSharedLinkExpiration(
  {
    req,
    conversationId,
  }: {
    req: RetentionRequest | null | undefined;
    conversationId?: string | null;
  },
  dependencies: SharedLinkRetentionDependencies,
): Promise<Date | null | undefined> {
  const userId = req?.user?.id;
  if (!conversationId || !userId) {
    return undefined;
  }

  const isRetentionAll = isAllDataRetention(req?.config?.interfaceConfig?.retentionMode);
  const convo = await dependencies.getConvo(userId, conversationId);
  if (!convo) {
    return undefined;
  }

  const conversationExpiredAt = getConversationExpirationDate(convo);
  if (conversationExpiredAt == null) {
    if (!isRetentionAll) {
      return null;
    }
  } else if (!isActiveExpirationDate(conversationExpiredAt)) {
    return conversationExpiredAt;
  }

  try {
    return dependencies.createExpirationDate(
      req?.config?.interfaceConfig,
      convo.isTemporary === true || (convo.isTemporary == null && conversationExpiredAt != null),
    );
  } catch (err) {
    dependencies.logger?.error('[getSharedLinkExpiration] Error creating expiration date:', err);
    return null;
  }
}

export const createMinimalRetentionRequest = (
  req?: RetentionRequest | null,
): RetentionRequest | undefined => {
  if (!req) {
    return undefined;
  }

  return {
    fileRetentionSource: req.fileRetentionSource,
    user: req.user
      ? {
          id: req.user.id,
          tenantId: req.user.tenantId,
        }
      : undefined,
    body: {
      conversationId: req.body?.conversationId,
      isTemporary: req.body?.isTemporary,
    },
    config: {
      interfaceConfig: req.config?.interfaceConfig,
    },
  };
};

/** Private, authenticated request state shared by overlapping model/steer admissions. */
export type SourceRetentionRequest = {
  user: { id: string; tenantId?: string | null };
  _fileSourceRetention?: SourceRetentionContext;
  _quoteRetention?: ResolvedQuoteRetention;
  _quoteRetentionMessageId?: string;
  _resumableStreamId?: string;
};

type SourceRetentionSelection = {
  fileIds: readonly string[];
  historyMessageIds: readonly string[];
  checkpointSourceBinding?: CheckpointSourceBinding;
  historyQuoteSnapshots?: readonly {
    messageId: string;
    messageVersion: number | null;
    quotes: readonly string[];
  }[];
};
export type ResolveSourceRetention = (
  owner: FileOwnerScope,
  selection: SourceRetentionSelection,
) => Promise<SourceRetentionContext | undefined>;

type ModelSourceMessage = (
  | { messageId: string; id?: string }
  | { messageId?: null; id: string }
) & { sourceFileIds?: readonly string[]; quotes?: readonly string[]; __v?: number | null };

type ModelSourceRetentionInput = {
  request: SourceRetentionRequest;
  fileIds: readonly string[];
  sourceMessageIds: readonly string[];
  storedMessages?: readonly ModelSourceMessage[];
  getJobCreatedAt: () => number | null | undefined;
  getCheckpointOptions: () => Pick<SourceRetentionSelection, 'checkpointSourceBinding'> | undefined;
};
type ModelSourceRetentionPorts = {
  resolve: ResolveSourceRetention;
  bind: (streamId: string, createdAt: number, context: SourceRetentionContext) => Promise<boolean>;
  revoke: (owner: FileOwnerScope, fileIds: readonly string[]) => Promise<unknown>;
};

/** Re-resolve the bounded union before effects; an unquoted steer starts immediately. */
export async function applySteerSourceRetention(
  req: SourceRetentionRequest,
  quoteRetention: SerializedQuoteRetention | undefined,
  resolve: ResolveSourceRetention,
  apply: () => Promise<void>,
): Promise<void> {
  const context =
    quoteRetention && quoteRetentionContext(deserializeQuoteRetention(quoteRetention));
  if (!context) return apply();
  const owner = { userId: req.user.id, tenantId: req.user.tenantId };
  let current = context;
  // Each overlap can add only a previously unseen member of the bounded union.
  for (let attempt = 0; ; attempt++) {
    const previous = readFileSourceRetention(req._fileSourceRetention);
    const fileIds = [...new Set([...(previous?.sourceFileIds ?? []), ...current.sourceFileIds])];
    if (attempt > UPLOAD_DERIVED_MAX_SOURCES || fileIds.length > UPLOAD_DERIVED_MAX_SOURCES)
      throw new Error('Source union exceeded admission bounds');
    const resolved = await resolve(owner, { fileIds, historyMessageIds: [] });
    if (!resolved) throw new Error('Source binding disappeared');
    const latest = readFileSourceRetention(req._fileSourceRetention);
    if (latest?.sourceFileIds.some((id) => !resolved.sourceFileIds.includes(id))) {
      current = resolved;
      continue;
    }
    req._fileSourceRetention = resolved;
    break;
  }
  await apply();
}

/** Bind the complete exposed union, then revalidate current File authority before provider use. */
export async function admitModelSourceRetention(
  input: ModelSourceRetentionInput,
  ports: ModelSourceRetentionPorts,
): Promise<void> {
  const { request: req, fileIds, sourceMessageIds, storedMessages } = input;
  const owner = { userId: req.user.id, tenantId: req.user.tenantId };
  const dependentHistory = new Set(
    (storedMessages ?? [])
      .filter(
        (message) => (message.sourceFileIds?.length ?? 0) > 0 || (message.quotes?.length ?? 0) > 0,
      )
      .map((message) => message.messageId ?? message.id),
  );
  // Model callbacks can overlap; a later resolver must not erase an already exposed source.
  const mergeContext = async (context: SourceRetentionContext | undefined) => {
    if (!context) return context;
    for (let attempt = 0; attempt <= UPLOAD_DERIVED_MAX_SOURCES; attempt++) {
      const current = readFileSourceRetention(req._fileSourceRetention);
      const contextIds = context.sourceFileIds;
      const ids = [...new Set([...(current?.sourceFileIds ?? []), ...contextIds])];
      if (ids.length > UPLOAD_DERIVED_MAX_SOURCES)
        throw new Error('Source union exceeded admission bounds');
      if (ids.every((id) => contextIds.includes(id))) {
        req._fileSourceRetention = context;
        return context;
      }
      context = await ports.resolve(owner, {
        fileIds: ids,
        historyMessageIds: [],
      });
      if (!context) throw new Error('Source binding disappeared');
    }
    throw new Error('Source union did not settle');
  };
  const previous = readFileSourceRetention(req._fileSourceRetention);
  const selectedIds = new Set(sourceMessageIds);
  const historyQuoteSnapshots = (storedMessages ?? [])
    .filter(
      (message) =>
        (message.quotes?.length ?? 0) > 0 &&
        selectedIds.has(message.messageId ?? message.id) &&
        (message.messageId ?? message.id) !== req._quoteRetentionMessageId,
    )
    .map((message) => ({
      messageId: message.messageId ?? message.id,
      messageVersion: message.__v ?? null,
      quotes: [...message.quotes!],
    }));
  const selectedQuotes =
    req._quoteRetention && sourceMessageIds.includes(req._quoteRetentionMessageId!)
      ? quoteRetentionContext(req._quoteRetention)
      : undefined;
  const context = await mergeContext(
    await ports.resolve(owner, {
      fileIds: [
        ...new Set([
          ...fileIds,
          ...(previous?.sourceFileIds ?? []),
          ...(selectedQuotes?.sourceFileIds ?? []),
        ]),
      ],
      historyMessageIds: sourceMessageIds.filter(
        (id) => dependentHistory.has(id) && id !== req._quoteRetentionMessageId,
      ),
      ...input.getCheckpointOptions(),
      ...(historyQuoteSnapshots.length > 0 && { historyQuoteSnapshots }),
    }),
  );
  if (!context) return;
  // The merge already kept failed admission source-bound before any further await.
  const streamId = req._resumableStreamId;
  if (
    !streamId ||
    input.getJobCreatedAt() == null ||
    !(await ports.bind(streamId, input.getJobCreatedAt()!, context))
  ) {
    throw new Error('Source generation admission failed');
  }
  try {
    const revalidated = await ports.resolve(owner, {
      fileIds: context.sourceFileIds,
      historyMessageIds: [],
    });
    if (!revalidated) throw new Error('Source binding disappeared');
    await mergeContext(revalidated);
  } catch (error) {
    // Compensate through the revoke owner if deletion raced generation binding.
    await ports.revoke(owner, context.sourceFileIds);
    throw error;
  }
}
