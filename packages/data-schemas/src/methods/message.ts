import {
  backgroundResultMetadata,
  HITL_MESSAGE_FILTER_FIELDS,
  isForcedTemporaryRetention,
  readSourceCoverage,
  RetentionMode,
} from 'librechat-data-provider';
import type { DeleteResult, FilterQuery, Model, Types, UpdateQuery } from 'mongoose';
import type { UserSubmittedMessageFieldPath } from 'librechat-data-provider';
import type { SourceCoverage } from 'librechat-data-provider';
import type { QuoteSourceRef } from 'librechat-data-provider';
import type { SearchParams } from 'meilisearch';
import type { ClientSession } from 'mongoose';
import type {
  SourceRetentionContext,
  QuoteSourceRetention,
  ResolvedQuoteRetention,
  RetainedTextAllocation,
  MessageArtifactSourceInput,
  CapturedMessageArtifactSource,
} from '~/types/message';
import type { SchemaWithMeiliMethods } from '~/models/plugins/mongoMeili';
import type { AppConfig, IConversation, IMessage } from '~/types';
import type { FileOwnerScope } from './file';
import {
  FileSourceUnavailableError,
  fileSourceScope,
  liveFileFilter,
  resolveFileSources,
  touchFileSources,
  resizeMessageDerivatives,
  unreconciledDocumentStorage,
} from './fileRetention';
import { createChatExpirationDate, createTempChatExpirationDate } from '~/utils/tempChatRetention';
import { activeExpirationFilter, createFallbackRetentionDate } from '~/utils/retention';
import { fitBoundAppSnapshots, hasBoundAppSnapshots } from './appSnapshots';
import { tenantSafeBulkWrite } from '~/utils/tenantBulkWrite';
import { publicMessageProjection } from '~/schema/message';
import { createMessageArtifactSourceMethods } from './messageArtifactSource';
import { tenantStorage } from '~/config/tenantContext';
import logger from '~/config/winston';

/** Simple UUID v4 regex to replace zod validation */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_STORED_USER_SUBMITTED_PATHS = 256;
const MAX_NORMALIZED_USER_SUBMITTED_PATHS = MAX_STORED_USER_SUBMITTED_PATHS + 1;
const MAX_STORED_USER_SUBMITTED_FIELD_PATHS = MAX_NORMALIZED_USER_SUBMITTED_PATHS;
const MAX_USER_SUBMITTED_PATH_LENGTH = 2048;
const MAX_PROVENANCE_CAS_ATTEMPTS = 8;
const MAX_SUBAGENT_CONTROL_RECEIPTS = 64;
const MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH = 4 * 1024;
/** One owner admits at most 64 terminal control invocations. The optimistic
 * writer therefore has enough rounds for every admitted receipt to converge. */
const MAX_SUBAGENT_CONTROL_RECEIPT_CAS_ATTEMPTS = 64;
const HITL_MESSAGE_FILTER_FIELD_SET = new Set<string>(HITL_MESSAGE_FILTER_FIELDS);

/** An expected existing revision no longer identifies a writable message. */
export class MessageVersionConflictError extends Error {
  readonly code = 'MESSAGE_VERSION_CONFLICT';

  constructor() {
    super('The message version has changed.');
    this.name = 'MessageVersionConflictError';
  }
}

/** Null denotes a legacy row without a native version, never a missing row. */
function expectedMessageVersionFilter(
  expectedVersion: number | null | undefined,
): FilterQuery<IMessage> {
  if (expectedVersion === undefined) return {};
  return { __v: expectedVersion === null ? { $exists: false } : expectedVersion };
}

function normalizeUserSubmittedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    return [];
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
      seen.has(path)
    ) {
      continue;
    }
    seen.add(path);
    normalized.push(path);
    if (normalized.length >= MAX_NORMALIZED_USER_SUBMITTED_PATHS) {
      break;
    }
  }
  return normalized;
}

function normalizeUserSubmittedMessageFieldPaths(values: unknown): UserSubmittedMessageFieldPath[] {
  if (!Array.isArray(values)) {
    return [];
  }
  const normalized: UserSubmittedMessageFieldPath[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (value == null || typeof value !== 'object') {
      continue;
    }
    const { path, field } = value as { path?: unknown; field?: unknown };
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > MAX_USER_SUBMITTED_PATH_LENGTH ||
      typeof field !== 'string' ||
      !HITL_MESSAGE_FILTER_FIELD_SET.has(field)
    ) {
      continue;
    }
    const key = `${field}:${path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ path, field: field as UserSubmittedMessageFieldPath['field'] });
    if (normalized.length >= MAX_NORMALIZED_USER_SUBMITTED_PATHS) {
      break;
    }
  }
  return normalized;
}

function capNormalizedProvenance(
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
): {
  userSubmittedPaths: string[];
  userSubmittedMessageFieldPaths: UserSubmittedMessageFieldPath[];
  promoteWholeMessage: boolean;
} {
  return {
    userSubmittedPaths: userSubmittedPaths.slice(0, MAX_STORED_USER_SUBMITTED_PATHS),
    userSubmittedMessageFieldPaths: userSubmittedMessageFieldPaths.slice(
      0,
      MAX_STORED_USER_SUBMITTED_FIELD_PATHS,
    ),
    promoteWholeMessage: userSubmittedPaths.length > MAX_STORED_USER_SUBMITTED_PATHS,
  };
}

type StoredSubagentControlReceipt = NonNullable<
  NonNullable<IMessage['subagentTask']>['controlReceipts']
>[number];

const terminalControlReceipt = (receipt: StoredSubagentControlReceipt): boolean =>
  receipt.status === 'applied' || receipt.status === 'rejected' || receipt.status === 'failed';

function retainSubagentControlReceipts(
  current: StoredSubagentControlReceipt[],
  receipt: StoredSubagentControlReceipt,
): {
  status: 'updated' | 'unchanged' | 'conflict' | 'capacity';
  receipts: StoredSubagentControlReceipt[];
} {
  const existingIndex = current.findIndex(
    (candidate) => candidate.invocationId === receipt.invocationId,
  );
  let merged: StoredSubagentControlReceipt[];
  if (existingIndex < 0) {
    merged = [...current, receipt];
  } else {
    const existing = current[existingIndex];
    if (existing.fingerprint !== receipt.fingerprint) {
      return { status: 'conflict', receipts: current };
    }
    if (
      terminalControlReceipt(existing) ||
      existing.status === receipt.status ||
      (existing.status === 'accepted' && receipt.status === 'reserved')
    ) {
      return { status: 'unchanged', receipts: current };
    }
    merged = current.map((candidate, index) => (index === existingIndex ? receipt : candidate));
  }
  const accepted = merged.filter(
    (candidate) => candidate.status === 'reserved' || candidate.status === 'accepted',
  );
  /** Reserved and accepted receipts are idempotency fences for commands that can
   * still take effect. Never evict one to admit another receipt: report capacity
   * so the caller refuses the command before mutating the live task. */
  if (accepted.length > MAX_SUBAGENT_CONTROL_RECEIPTS) {
    return { status: 'capacity', receipts: current };
  }
  const terminalAllowance = Math.max(0, MAX_SUBAGENT_CONTROL_RECEIPTS - accepted.length);
  let terminal =
    terminalAllowance === 0
      ? []
      : merged
          .filter((candidate) => candidate.status !== 'reserved' && candidate.status !== 'accepted')
          .sort(
            (left, right) =>
              left.createdAt.getTime() - right.createdAt.getTime() ||
              left.invocationId.localeCompare(right.invocationId),
          )
          .slice(-terminalAllowance);
  const advancesActiveFence =
    existingIndex >= 0 &&
    !terminalControlReceipt(current[existingIndex]) &&
    terminalControlReceipt(receipt);
  if (
    advancesActiveFence &&
    !terminal.some((candidate) => candidate.invocationId === receipt.invocationId)
  ) {
    /** A terminal transition for an active fence must outrank unrelated terminal
     * history even though it retains the command's older occurrence timestamp. */
    const otherAllowance = Math.max(0, terminalAllowance - 1);
    terminal = [
      ...(otherAllowance === 0
        ? []
        : terminal
            .filter((candidate) => candidate.invocationId !== receipt.invocationId)
            .slice(-otherAllowance)),
      receipt,
    ].sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.invocationId.localeCompare(right.invocationId),
    );
  }
  const receipts = [...accepted, ...terminal];
  if (!receipts.some((candidate) => candidate.invocationId === receipt.invocationId)) {
    return { status: 'capacity', receipts: current };
  }
  return { status: 'updated', receipts };
}

type MessageProvenance = Pick<
  IMessage,
  'isUserSubmitted' | 'userSubmittedPaths' | 'userSubmittedMessageFieldPaths'
>;

function mergeMessageProvenance(
  current: MessageProvenance | null,
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
  stampModelOutputOnInsert = false,
  explicitIsUserSubmitted?: boolean,
  preserveStoredIsUserSubmitted = true,
): MessageProvenance {
  const provenance = capNormalizedProvenance(
    normalizeUserSubmittedPaths([...(current?.userSubmittedPaths ?? []), ...userSubmittedPaths]),
    normalizeUserSubmittedMessageFieldPaths([
      ...(current?.userSubmittedMessageFieldPaths ?? []),
      ...userSubmittedMessageFieldPaths,
    ]),
  );

  let isUserSubmitted = preserveStoredIsUserSubmitted ? current?.isUserSubmitted : undefined;
  if (typeof explicitIsUserSubmitted === 'boolean') {
    isUserSubmitted = explicitIsUserSubmitted;
  } else if (stampModelOutputOnInsert && isUserSubmitted == null) {
    isUserSubmitted = false;
  }
  if (provenance.promoteWholeMessage) {
    isUserSubmitted = true;
  }

  return {
    userSubmittedPaths: provenance.userSubmittedPaths,
    userSubmittedMessageFieldPaths: provenance.userSubmittedMessageFieldPaths,
    ...(typeof isUserSubmitted === 'boolean' && { isUserSubmitted }),
  };
}

function getProvenanceSnapshotFilter(current: MessageProvenance): Record<string, unknown> {
  return {
    userSubmittedPaths: !Object.prototype.hasOwnProperty.call(current, 'userSubmittedPaths')
      ? { $exists: false }
      : current.userSubmittedPaths,
    userSubmittedMessageFieldPaths: !Object.prototype.hasOwnProperty.call(
      current,
      'userSubmittedMessageFieldPaths',
    )
      ? { $exists: false }
      : current.userSubmittedMessageFieldPaths,
    isUserSubmitted: !Object.prototype.hasOwnProperty.call(current, 'isUserSubmitted')
      ? { $exists: false }
      : current.isUserSubmitted,
  };
}

function getMissingProvenanceFilter(): Record<string, unknown> {
  return {
    userSubmittedPaths: { $exists: false },
    userSubmittedMessageFieldPaths: { $exists: false },
    isUserSubmitted: { $exists: false },
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (err as { code?: number }).code === 11000;
}

function getSteerUserSubmittedPaths(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const paths: string[] = [];
  for (let index = 0; index < content.length; index++) {
    const part = content[index] as { type?: unknown } | null | undefined;
    if (part?.type === 'steer') {
      paths.push(`/content/${index}`);
    }
  }
  return paths;
}

/** Mongoose omits undefined $set values. Strip identity/version inputs before any sizing callback. */
function sanitizeMessageUpdate(
  update: Record<string, unknown>,
  trustedRetention = false,
  sourceCoverage?: SourceCoverage,
): Record<string, unknown> {
  const sanitized = Object.fromEntries(
    Object.entries(update).filter(
      ([key, value]) =>
        value !== undefined &&
        key !== 'metadata.sourceCoverage' &&
        !key.startsWith('metadata.sourceCoverage.') &&
        ![
          '_id',
          'tenantId',
          '__v',
          'quoteSourceRefs',
          'retainedTextAllocations',
          ...(!trustedRetention
            ? ['sourceFileIds', 'sourceExpiresAt', 'sourceContentRemovedAt', 'quoteSourceRetention']
            : []),
        ].includes(key.split('.')[0]),
    ),
  );
  if (sanitized.metadata != null && typeof sanitized.metadata === 'object') {
    sanitized.metadata = Object.fromEntries(
      Object.entries(sanitized.metadata).filter(([key]) => key.split('.')[0] !== 'sourceCoverage'),
    );
  }
  // Only the separately validated server option may insert this namespace.
  if (sourceCoverage) {
    sanitized.metadata = {
      ...(sanitized.metadata != null && typeof sanitized.metadata === 'object'
        ? sanitized.metadata
        : {}),
      sourceCoverage,
    };
  }
  return sanitized;
}

/** Whole metadata replacement already drops the receipt; avoid conflicting Mongo paths. */
function sourceCoverageUnset(update: Record<string, unknown>, unset = false) {
  return unset && !Object.prototype.hasOwnProperty.call(update, 'metadata')
    ? { 'metadata.sourceCoverage': 1 as const }
    : {};
}

/** Conservatively admit any server-bound resource to the slow path, including legacy MIME forms. */
const NO_BOUND_APPS = { 'attachments.ui_resources.serverBinding': { $exists: false } };
const NO_SOURCE_BODY = {
  quoteSourceRetention: { $exists: false },
  'sourceFileIds.0': { $exists: false },
  sourceContentRemovedAt: { $exists: false },
};

/**
 * A terminal save that must drop a stored `contextMeta` unsets it in the same
 * update that persists the response, so no failure between two writes can
 * leave a completed row carrying a disconnect snapshot's state.
 */
function buildMessageSaveUpdate(
  update: Record<string, unknown>,
  options: {
    stampModelOutputOnInsert: boolean;
    unsetContextMeta: boolean;
    unsetPrivateText?: boolean;
    unsetSourceCoverage?: boolean;
    retentionOnInsert?: { expiredAt: Date; isTemporary: false };
  },
): UpdateQuery<IMessage> {
  return {
    $set: update,
    $inc: { __v: 1 },
    ...((options.stampModelOutputOnInsert || options.retentionOnInsert != null) && {
      $setOnInsert: {
        ...(options.stampModelOutputOnInsert && { isUserSubmitted: false }),
        ...options.retentionOnInsert,
      },
    }),
    ...((options.unsetContextMeta || options.unsetPrivateText || options.unsetSourceCoverage) && {
      $unset: {
        ...sourceCoverageUnset(update, options.unsetSourceCoverage),
        ...(options.unsetContextMeta && { contextMeta: 1 }),
        ...(options.unsetPrivateText && {
          privateText: 1,
          privacyRevision: 1,
          ...(update.privateTextTokens === undefined && { privateTextTokens: 1 }),
        }),
      },
    }),
  };
}

async function findOneAndMergeMessageProvenance(
  Message: Model<IMessage>,
  identity: FilterQuery<IMessage>,
  update: Record<string, unknown>,
  userSubmittedPaths: readonly string[],
  userSubmittedMessageFieldPaths: readonly UserSubmittedMessageFieldPath[],
  options: {
    upsert: boolean;
    expectedVersion?: number | null;
    stampModelOutputOnInsert?: boolean;
    unsetContextMeta?: boolean;
    unsetPrivateText?: boolean;
    unsetSourceCoverage?: boolean;
    sourceCoverage?: SourceCoverage;
    retentionOnInsert?: { expiredAt: Date; isTemporary: false };
    prepareAppUpdate?: (
      current: Record<string, unknown> | null,
      update: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    timestamps?: boolean;
    privateMessagePaths?: string;
    session?: ClientSession;
    onWrite?: (inserted: boolean, id: unknown) => void;
  },
) {
  const safeUpdate = sanitizeMessageUpdate(update, true, options.sourceCoverage);
  const preservesStoredIsUserSubmitted = !Object.prototype.hasOwnProperty.call(
    safeUpdate,
    'isUserSubmitted',
  );

  /** A small optimistic loop keeps the merge atomic while using only classic update operators. */
  const attempts = options.expectedVersion === undefined ? MAX_PROVENANCE_CAS_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const current = await Message.findOne(identity)
      .session(options.session ?? null)
      .select(
        options.prepareAppUpdate
          ? (options.privateMessagePaths ?? '')
          : {
              isUserSubmitted: 1,
              userSubmittedPaths: 1,
              userSubmittedMessageFieldPaths: 1,
              _id: 0,
            },
      )
      .lean<
        | (MessageProvenance & {
            _id?: Types.ObjectId;
            attachments?: unknown[];
            content?: unknown[];
            __v?: number;
          })
        | null
      >();
    if (current == null && !options.upsert) {
      if (options.expectedVersion !== undefined) throw new MessageVersionConflictError();
      return null;
    }

    const provenance = mergeMessageProvenance(
      current,
      userSubmittedPaths,
      userSubmittedMessageFieldPaths,
      options.stampModelOutputOnInsert,
      typeof safeUpdate.isUserSubmitted === 'boolean' ? safeUpdate.isUserSubmitted : undefined,
      preservesStoredIsUserSubmitted,
    );
    const filter = {
      ...identity,
      ...(current == null ? getMissingProvenanceFilter() : getProvenanceSnapshotFilter(current)),
      ...(options.prepareAppUpdate &&
        (current != null
          ? {
              _id: current._id,
              __v: current.__v ?? null,
            }
          : { _id: new Message.base.Types.ObjectId() })),
      ...expectedMessageVersionFilter(options.expectedVersion),
    };
    const admittedUpdate = options.prepareAppUpdate
      ? await options.prepareAppUpdate(current, { ...safeUpdate, ...provenance })
      : { ...safeUpdate, ...provenance };

    try {
      const message = await Message.findOneAndUpdate(
        filter,
        {
          $set: admittedUpdate,
          $inc: { __v: 1 },
          ...(current == null &&
            options.retentionOnInsert != null && { $setOnInsert: options.retentionOnInsert }),
          ...((options.unsetContextMeta ||
            options.unsetPrivateText ||
            options.unsetSourceCoverage) && {
            $unset: {
              ...sourceCoverageUnset(admittedUpdate, options.unsetSourceCoverage),
              ...(options.unsetContextMeta && { contextMeta: 1 }),
              ...(options.unsetPrivateText && {
                privateText: 1,
                privacyRevision: 1,
                ...(update.privateTextTokens === undefined && { privateTextTokens: 1 }),
              }),
            },
          }),
        },
        {
          upsert: options.upsert && current == null,
          new: true,
          timestamps: options.timestamps,
          session: options.session,
        },
      );
      if (message != null) {
        options.onWrite?.(current == null, message._id);
        return message;
      }
    } catch (err) {
      if (options.expectedVersion !== undefined && isDuplicateKeyError(err)) {
        throw new MessageVersionConflictError();
      }
      if (options.session || !isDuplicateKeyError(err) || !options.upsert) {
        throw err;
      }
    }
  }

  if (options.expectedVersion !== undefined) throw new MessageVersionConflictError();
  throw new Error('Message provenance write contention exceeded its retry bound.');
}

/**
 * Maximum private transcript JSON that may cross the MongoDB projection seam
 * for the bounded public subagent-activity view. This gives the sanitizer
 * enough source headroom while preventing multi-megabyte transcripts from
 * being materialized merely to produce a 64 KiB public activity response.
 */
export const SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT: number = 256 * 1024;
const SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT = 64 * 1024;

/**
 * Maximum activity sources materialized for one child-view poll. New writers
 * supply at most four 64 KiB public projections; legacy rows fall back to at
 * most four 256 KiB private transcripts during a rolling deployment.
 */
export const SUBAGENT_TRANSCRIPT_PAGE_LIMIT: number = 4;
const SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT = SUBAGENT_TRANSCRIPT_PAGE_LIMIT * 2;

/**
 * Ordinary persisted message content is the authoritative refresh source when
 * an execution did not write a private subagent transcript. Project only the
 * visible activity vocabulary and bound it before MongoDB returns the row.
 */
/**
 * Per-item bounds mirror `SUBAGENT_ACTIVITY_LIMITS` in `packages/api`
 * (`src/agents/activity.ts`) at worst-case 4-byte UTF-8, so activity projected
 * from ordinary message content is clipped no harder than activity projected
 * from a private transcript. The whole view stays bounded downstream by the
 * 64KB serialized-activity budget and the 256KB response trim.
 */
export const SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT: number = 100;
const SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT = 8192;
const SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT = 2048;
const SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT = 4096;
const SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT = 128;
const SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT = 512;
const SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT = 8;
const SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT = 64 * 1024;
const SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT = 32;
const SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT = 128;

/**
 * Exclusion projection for message reads that feed the chat client (the
 * conversation GET and shared-link reads). Every excluded field is either
 * server-internal (ids, replay signatures, legacy summarization state) or a
 * web_search SERP vertical no citation marker or UI can address: markers
 * resolve `search|image|news|video|ref|file` through organic/images/
 * topStories/videos/references (all kept — `news` markers read topStories,
 * never the `news` collection). The JSON export mirrors this cache, so
 * fields removed here also leave user exports.
 */
/**
 * A response the server generated and sampled into a trace. Its trace fields are
 * an ownership claim, so rows a client authored (the message-create route and
 * imports stamp `isUserSubmitted: true`) never count, even if one was persisted
 * with forged fields before those writes stripped them.
 */
/** A response's position in trace order: its creation time, then its `_id`. */
function traceOrderKey(createdAt: Date, id: Types.ObjectId): string {
  return `${createdAt.getTime().toString(36)}.${id.toString()}`;
}

function parseTraceOrderKey(key: string): { createdAt: Date; id: string } | undefined {
  const [time, hex] = key.split('.');
  const createdAt = new Date(Number.parseInt(time ?? '', 36));
  if (Number.isNaN(createdAt.getTime()) || hex == null || !/^[0-9a-f]{24}$/.test(hex)) {
    return undefined;
  }
  return { createdAt, id: hex };
}

/** An explicit tenant scope, so a read without request tenant context still cannot span tenants. */
const traceTenantScope = (tenantId?: string) =>
  tenantId == null ? { tenantId: { $exists: false } } : { tenantId };

const SERVER_AUTHORED_SAMPLED_RESPONSE = {
  langfuseSampled: true,
  isCreatedByUser: false,
  isUserSubmitted: { $ne: true },
} as const;

export const CLIENT_MESSAGE_SELECT: string = [
  '-_id',
  '-user',
  '-clientId',
  '-invocationId',
  '-conversationSignature',
  '-summary',
  '-summaryTokenCount',
  '-privateText',
  '-privateTextTokens',
  '-contextMeta',
  '-langfuseSampled',
  '-langfuseDestinationIds',
  '-langfuseRunId',
  '-metadata.thoughtSignatures',
  '-content.tool_call.backgroundTask.resultClaim',
  '-content.tool_call.backgroundTask.completionWakeup',
  '-attachments.web_search.knowledgeGraph',
  '-attachments.web_search.peopleAlsoAsk',
  '-attachments.web_search.relatedSearches',
  '-attachments.web_search.shopping',
  '-attachments.web_search.places',
  '-attachments.web_search.news',
  '-attachments.web_search.organic.sitelinks',
  '-attachments.web_search.organic.highlights',
  '-attachments.web_search.topStories.highlights',
].join(' ');

interface MessageQueryOptions {
  limit?: number;
  sort?: Record<string, 1 | -1> | false;
}

export type SubagentTaskResultClaim =
  | { status: 'not_found' }
  | { status: 'claimed'; message: IMessage }
  | { status: 'acquired'; message: IMessage };

export interface BackgroundToolResultRecord {
  taskId: string;
  toolCallId: string;
  toolName: string;
  status: 'completed' | 'error' | 'cancelled';
  output: string;
  agentId?: string;
  /** When the task reached this terminal status. Absent on rows written before
   * the stamp existed, so a consumer must treat it as optional. */
  settledAt?: Date;
}

export type BackgroundToolResultClaim =
  | { status: 'not_found' | 'not_ready' }
  | { status: 'outcome_unknown'; toolName: string }
  | {
      status: 'claimed';
      claim?: {
        kind: 'manual' | 'wakeup';
        claimId: string;
        generationId?: string;
        batchId?: string;
        receiptReconciled?: true;
      };
      messageId?: string;
    }
  | { status: 'acquired'; results: BackgroundToolResultRecord[]; messageId?: string };

export type SubagentThreadViewMessageRecord = Pick<
  IMessage,
  | 'messageId'
  | 'parentMessageId'
  | 'isCreatedByUser'
  | 'text'
  | 'createdAt'
  | 'error'
  | 'unfinished'
  | 'subagentTranscript'
  | 'subagentTriggerProjection'
> & {
  textProjectionTruncated?: boolean;
  subagentTranscriptProjectionTruncated?: boolean;
  /** Storage-bounded visible content; validated into the public activity type by the API. */
  subagentActivity?: unknown[];
  subagentActivityProjectionJson?: string;
  subagentActivityProjectionTruncated?: boolean;
  /** Storage-bounded task state; private replay and execution fields never cross this seam. */
  subagentTask?: {
    status?: NonNullable<IMessage['subagentTask']>['status'];
    controlReceipts?: Array<
      Omit<StoredSubagentControlReceipt, 'fingerprint'> & { fingerprint?: never }
    >;
    controlReceiptsProjectionTruncated?: boolean;
  };
};

/** Amazon DocumentDB does not support `$$REMOVE`, so the bounded thread-view
 * projections emit `null` where they mean "omit this key". This is the shape as
 * it leaves the aggregation, before those sentinels are pruned back to absent. */
/** Widens the given keys to admit the projection's `null` sentinel. */
type WithNullSentinels<T, K extends keyof T> = Omit<T, K> & {
  [P in K]?: NonNullable<T[P]> | null;
};

type ThreadViewRecord = SubagentThreadViewMessageRecord;
export type ProjectedSubagentThreadViewMessage = WithNullSentinels<
  Omit<ThreadViewRecord, 'subagentTask' | 'subagentTriggerProjection'>,
  'subagentTranscriptProjectionTruncated'
> & {
  subagentTriggerProjection?: WithNullSentinels<
    NonNullable<ThreadViewRecord['subagentTriggerProjection']>,
    'expectedActionToolName'
  > | null;
  subagentTask?:
    | (Omit<NonNullable<ThreadViewRecord['subagentTask']>, 'controlReceipts'> & {
        controlReceipts?: Array<
          WithNullSentinels<
            NonNullable<NonNullable<ThreadViewRecord['subagentTask']>['controlReceipts']>[number],
            'controlId' | 'reason' | 'message'
          >
        >;
      })
    | null;
};

/** Restores the absent-vs-present contract by dropping the `null` sentinels the
 * projection emitted. Bounded by the projection's own row, receipt, and byte
 * limits, and folded into the pass that already materializes each record. */
function pruneProjectedThreadViewMessage(
  message: ProjectedSubagentThreadViewMessage,
): SubagentThreadViewMessageRecord {
  if (message.subagentTranscriptProjectionTruncated === null) {
    delete message.subagentTranscriptProjectionTruncated;
  }
  if (message.subagentTriggerProjection === null) {
    delete message.subagentTriggerProjection;
  } else if (message.subagentTriggerProjection?.expectedActionToolName === null) {
    delete message.subagentTriggerProjection.expectedActionToolName;
  }
  if (message.subagentTask === null) {
    delete message.subagentTask;
  } else {
    for (const receipt of message.subagentTask?.controlReceipts ?? []) {
      if (receipt.controlId === null) delete receipt.controlId;
      if (receipt.reason === null) delete receipt.reason;
      if (receipt.message === null) delete receipt.message;
    }
  }
  return message as SubagentThreadViewMessageRecord;
}

export type ParentSubagentTaskRecord = {
  conversationId: string;
  /** The shared bounded source window filled, so this child's history may be incomplete. */
  sourceTruncated?: boolean;
  tasks: Array<
    Pick<IMessage, 'messageId' | 'createdAt'> & {
      status: NonNullable<IMessage['subagentTask']>['status'];
      /** True when status was inferred from an ordinary event-turn row. */
      statusDerived?: boolean;
      /** Private ordering token used only while merging bounded storage reads. */
      occurrenceId?: Types.ObjectId;
    }
  >;
};

/** A response message whose run was sampled into a trace. */
export interface SampledTraceMessage {
  messageId: string;
  createdAt?: Date;
  /** Opaque ids of the tracing destinations eligible to hold the trace, when recorded. */
  langfuseDestinationIds?: string[];
  /** The run whose trace this response reports, when it is not the message's own id. */
  langfuseRunId?: string;
  /** Opaque position in the conversation's response order, which a later read can resume from. */
  orderKey?: string;
}

export interface ConversationTraceRefs {
  /** Creation time of the user's earliest message in the conversation. */
  firstMessageAt?: Date;
  /** Sampled response messages, oldest first. */
  sampledMessages: SampledTraceMessage[];
}

/**
 * Reads a stored terminal stamp defensively: rows written before the stamp existed
 * omit it, and a document can reach here from a raw read where the date is still a
 * string, so an unusable value is reported as absent rather than as `Invalid Date`.
 */
function toSettledAt(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }
  return undefined;
}

export interface PrivateTextWrite {
  readonly envelope: string;
  readonly revision: string;
}

export interface PrivateTextRead {
  readonly _id?: unknown;
  readonly messageId: string;
  readonly text: string;
  readonly privacyRevision: string;
  readonly privateText: string;
}

export interface MessageMethods {
  captureMessageArtifactSource(
    owner: FileOwnerScope,
    input: MessageArtifactSourceInput,
    session: ClientSession,
  ): Promise<CapturedMessageArtifactSource>;
  resolveQuoteRetention(
    owner: FileOwnerScope,
    entries: readonly { text: string; sourceRef?: QuoteSourceRef | null }[],
  ): Promise<ResolvedQuoteRetention>;
  resolveFileRetentionContext(
    owner: FileOwnerScope,
    input: {
      fileIds: readonly string[];
      historyMessageIds: readonly string[];
      /** Server-read quote bytes actually selected for this model call. */
      historyQuoteSnapshots?: readonly {
        messageId: string;
        messageVersion: number | null;
        quotes: readonly string[];
      }[];
    },
  ): Promise<SourceRetentionContext | undefined>;
  redactFileSourceContent(
    owner: FileOwnerScope,
    fileIds: readonly string[],
  ): Promise<{ redactedMessages: number; detachedMessages: number }>;
  getPersistedPrivateTextId(
    input: Parameters<MessageMethods['hasPersistedPrivateText']>[0],
  ): Promise<string | null>;
  hasPersistedPrivateText(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
    privacyRevision: string;
    text: string;
  }): Promise<boolean>;
  getPrivateMessageTexts(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<PrivateTextRead[]>;
  saveMessage(
    ctx: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    params: Omit<Partial<IMessage>, 'contextMeta'> & {
      newMessageId?: string;
      contextMeta?: IMessage['contextMeta'] | null;
    },
    metadata?: {
      context?: string;
      /** Existing-row CAS only; null binds a legacy row with no native __v. */
      expectedVersion?: number | null;
      privateText?: PrivateTextWrite;
      insertOnly?: boolean;
      sourceRetention?: SourceRetentionContext;
      /** Server-produced preparation receipt; never read from message.metadata. */
      sourceCoverage?: SourceCoverage;
      quoteRetention?: ResolvedQuoteRetention;
    },
  ): Promise<IMessage | null | undefined>;
  /**
   * Reads the references a trace viewer needs for one of the user's
   * conversations: when it began and which responses were sampled into traces.
   */
  getConversationTraceRefs(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    /** Only this response, when it is a sampled one. */
    messageId?: string;
    /** The newest response to include, by the `orderKey` a previous read returned for it. */
    through?: { messageId: string; orderKey: string };
    /** The most responses to return, newest first from `through`; all of them when absent. */
    limit?: number;
  }): Promise<ConversationTraceRefs>;
  /**
   * Whether any of the user's responses in the conversation was sampled into a
   * trace that one of `destinationIds` can hold. A response with no recorded
   * destinations predates the record and counts for every destination.
   */
  hasSampledTraceMessage(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    destinationIds: string[];
  }): Promise<boolean>;
  recordSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    tenantId?: string;
    receipt: NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number];
  }): Promise<boolean | 'unchanged' | 'conflict'>;
  getSubagentTaskControlReceipt(input: {
    userId: string;
    conversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number] | null>;
  getSubagentTaskControlReplay(input: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<{
    receipt: NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number];
    task: {
      taskId: string;
      threadId: string;
      subagentType: string;
      status: NonNullable<IMessage['subagentTask']>['status'];
      resultAvailable: boolean;
      resultClaimed: boolean;
      pendingControls: number;
      createdAt: Date;
      updatedAt: Date;
    };
  } | null>;
  bulkSaveMessages(
    messages: Array<Partial<IMessage>>,
    overrideTimestamp?: boolean,
    provenance?: {
      privateTextTokens: ReadonlyMap<string, readonly string[]>;
      nativeSources?: ReadonlyMap<string, { messageId: string; messageVersion: number | null }>;
    },
  ): Promise<unknown>;
  recordMessage(params: {
    user: string;
    endpoint?: string;
    messageId: string;
    conversationId?: string;
    parentMessageId?: string;
    [key: string]: unknown;
  }): Promise<IMessage | null>;
  updateMessageText(userId: string, params: { messageId: string; text: string }): Promise<void>;
  updateToolCallResult(params: {
    userId: string;
    messageId: string;
    conversationId: string;
    toolCallId: string;
    stepId?: string;
    agentId?: string;
    output?: string;
    attachments?: unknown[];
    markBackgrounded?: boolean;
    backgroundTask?: {
      taskId: string;
      toolName: string;
      status: 'completed' | 'error';
      cancelled?: true;
      settledAt: Date;
      completionWakeup?: true;
      completionReceipt?: true;
      resultClaim?: {
        kind: 'manual' | 'wakeup';
        claimId: string;
        claimedAt: Date;
        generationId?: string;
        receiptReconciled?: true;
      };
    };
  }): Promise<{ matched: boolean; unfinished: boolean }>;
  claimBackgroundToolResults(params: {
    userId: string;
    conversationId: string;
    /** Optional on recovery polls after the process-local task registry was lost. */
    messageId?: string;
    taskId: string;
    agentId?: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
    /** Physical receipt-batch identity, independent of its logical request. */
    batchId?: string;
    /** Response generation that owns this manual result delivery. */
    generationId?: string;
    /** Manual owner-process takeover after automatic delivery was retired. */
    allowUnfinished?: boolean;
    limit?: number;
    /** Includes JSON escaping, delimiters, and empty result fields. */
    maxMetadataChars?: number;
  }): Promise<BackgroundToolResultClaim>;
  confirmBackgroundToolResultClaim(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    taskId: string;
    claimId: string;
  }): Promise<boolean>;
  releaseBackgroundToolResultClaims(params: {
    userId: string;
    conversationId: string;
    messageId: string;
    /** Omit to release every sibling owned by this exact batch claim. */
    taskIds?: string[];
    /** Receipt-backed results can precede the message projection. */
    allowMissingMessage?: true;
    /** Manual rollback must not erase a committed receipt handoff. */
    onlyIfUnreconciled?: true;
    batchId?: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean>;
  updateMessage(
    userId: string,
    message: Partial<IMessage> & { newMessageId?: string },
    metadata?: { context?: string },
  ): Promise<Partial<IMessage>>;
  claimSubagentTaskResult(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<SubagentTaskResultClaim>;
  releaseSubagentTaskResultClaim(params: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean>;
  deleteMessagesSince(
    userId: string,
    params: { messageId: string; conversationId: string },
  ): Promise<DeleteResult>;
  getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options?: MessageQueryOptions,
  ): Promise<IMessage[]>;
  getMessagesForSubagentThreadView(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    selectedTaskId?: string;
    beforeMessageId?: string;
    limit: number;
    textCodePointLimit: number;
  }): Promise<SubagentThreadViewMessageRecord[]>;
  listSubagentTasksForThreads(input: {
    user: string;
    conversationIds: string[];
    tenantId?: string;
    limitPerThread: number;
  }): Promise<ParentSubagentTaskRecord[]>;
  getMessage(params: { user: string; messageId: string }): Promise<IMessage | null>;
  getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options?: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
      select?: string;
    },
  ): Promise<{ messages: IMessage[]; nextCursor: string | null }>;
  searchMessages(
    query: string,
    searchOptions: SearchParams,
    hydrate?: boolean,
  ): Promise<Awaited<ReturnType<SchemaWithMeiliMethods['meiliSearch']>>>;
  deleteMessages(filter: FilterQuery<IMessage>): Promise<DeleteResult>;
}

/** The agent-ownership rule shared by background-tool settling and claiming:
 * `agentId` on the part wins, then `tool_call.agentId`, and a part without
 * agent identity belongs to any caller (single-agent runs). `field: null`
 * matches both a missing field and a stored null. The settle and claim paths
 * MUST apply the identical rule, or a settled part becomes unclaimable. */
function agentOwnershipFilter(prefix: string, agentId: string): Record<string, unknown> {
  return {
    $or: [
      { [`${prefix}agentId`]: agentId },
      { [`${prefix}agentId`]: null, [`${prefix}tool_call.agentId`]: agentId },
      { [`${prefix}agentId`]: null, [`${prefix}tool_call.agentId`]: null },
    ],
  };
}

type UpdateToolCallResultInput = {
  userId: string;
  messageId: string;
  conversationId: string;
  toolCallId: string;
  stepId?: string;
  /** Scopes the part match when provider tool-call ids repeat across
   *  agents in one response message (e.g. `call_0` per response); a part
   *  without agent identity matches any caller (single-agent runs). */
  agentId?: string;
  output?: string;
  attachments?: unknown[];
  /**
   * Stamps `backgrounded: true` onto the patched tool call. Replacing the
   * dispatch-handle output with the settled task's stdout destroys the only
   * signal renderers had that this call ran detached (the handle JSON and
   * the live status-marker attachment are both transient), so the patch
   * that erases it must persist a durable one alongside.
   */
  markBackgrounded?: boolean;
  backgroundTask?: {
    taskId: string;
    toolName: string;
    status: 'completed' | 'error';
    cancelled?: true;
    settledAt: Date;
    completionWakeup?: true;
    completionReceipt?: true;
    resultClaim?: {
      kind: 'manual' | 'wakeup';
      claimId: string;
      claimedAt: Date;
      generationId?: string;
    };
  };
};

type SteplessToolCallFallback = {
  content: NonNullable<IMessage['content']>;
  hasResultClaim: boolean;
};

export interface MessageDependencies {
  /** Read from deployment config, never from a message/request or a principal override. */
  getMCPAppMessageBudget?: () => Promise<number | undefined>;
}

export function createMessageMethods(
  mongoose: typeof import('mongoose'),
  deps: MessageDependencies = {},
): MessageMethods {
  const bodyKeep = new Set([
    '_id',
    '__v',
    'messageId',
    'conversationId',
    'parentMessageId',
    'user',
    'tenantId',
    'sender',
    'isCreatedByUser',
    'createdAt',
    'updatedAt',
    'expiredAt',
    'isTemporary',
    'sourceFileIds',
    'sourceExpiresAt',
    'sourceContentRemovedAt',
    'quotes',
    'quoteSourceRetention',
  ]);
  function removedBody(row: Record<string, unknown>, at = new Date()) {
    return {
      ...Object.fromEntries(Object.entries(row).filter(([key]) => bodyKeep.has(key))),
      text: '',
      content: [],
      sourceContentRemovedAt: row.sourceContentRemovedAt ?? at,
    };
  }

  /** Charge components once; operational claim receipts carry no document text. */
  function retainedAllocations(row: IMessage): RetainedTextAllocation[] {
    const allocations = new Map<string, number>();
    const charge = (ids: readonly string[], payload: Record<string, unknown>) => {
      const fileId = [...new Set(ids)].sort()[0];
      if (!fileId) throw new FileSourceUnavailableError();
      allocations.set(
        fileId,
        (allocations.get(fileId) ?? 0) + mongoose.mongo.BSON.calculateObjectSize(payload),
      );
    };
    if (row.sourceFileIds?.length && !row.sourceContentRemovedAt) {
      const body = Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !bodyKeep.has(key) && !['retainedTextAllocations', 'subagentTask'].includes(key),
        ),
      );
      if (Array.isArray(body.content))
        body.content = body.content.map((part) => {
          if (!part?.tool_call) return part;
          const { backgroundTask: _claims, ...tool_call } = part.tool_call;
          return { ...part, tool_call };
        });
      charge(row.sourceFileIds, body);
    }
    for (const binding of row.quoteSourceRetention ?? []) {
      const quote = row.quotes?.[binding.index];
      if (typeof quote !== 'string') throw new FileSourceUnavailableError();
      charge(binding.sourceFileIds, { quote });
    }
    return [...allocations]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fileId, bytes]) => ({ fileId, bytes }));
  }

  async function accountRetainedMessage(
    owner: FileOwnerScope,
    previous: IMessage | null,
    id: unknown,
    session: ClientSession,
  ): Promise<void> {
    const Message = mongoose.models.Message as Model<IMessage>;
    if (
      previous &&
      retainedAllocations(previous).length &&
      previous.retainedTextAllocations == null
    )
      unreconciledDocumentStorage();
    const next = await Message.findOne({ _id: id, ...fileSourceScope(owner) })
      .select(privateMessagePaths())
      .session(session)
      .lean<IMessage>();
    if (!next) throw new FileSourceUnavailableError();
    const allocations = retainedAllocations(next);
    await resizeMessageDerivatives(
      mongoose,
      owner,
      previous?.retainedTextAllocations ?? [],
      allocations,
      session,
    );
    await Message.updateOne(
      { _id: id, ...fileSourceScope(owner) },
      { $set: { retainedTextAllocations: allocations } },
      { session, timestamps: false },
    );
  }

  /** Selective pair filtering is shared by reads, late writes and physical redaction. */
  function filterQuotes(
    row: { quotes?: string[]; quoteSourceRetention?: QuoteSourceRetention[] },
    unavailable: (binding: QuoteSourceRetention) => boolean,
  ) {
    const bindings = new Map((row.quoteSourceRetention ?? []).map((item) => [item.index, item]));
    const quotes: string[] = [];
    const quoteSourceRetention: QuoteSourceRetention[] = [];
    for (const [index, quote] of (row.quotes ?? []).entries()) {
      const binding = bindings.get(index);
      if (binding && unavailable(binding)) continue;
      if (binding) quoteSourceRetention.push({ ...binding, index: quotes.length });
      quotes.push(quote);
    }
    return { quotes, quoteSourceRetention };
  }

  async function liveQuoteIds(
    owner: FileOwnerScope,
    bindings: readonly QuoteSourceRetention[],
    session?: ClientSession,
  ): Promise<Set<string>> {
    const ids = [...new Set(bindings.flatMap((binding) => binding.sourceFileIds))];
    if (!ids.length) return new Set();
    const files = await mongoose.models.File.find({
      $and: [
        fileSourceScope(owner),
        { file_id: { $in: ids }, retentionAcceptedAt: { $ne: null } },
        liveFileFilter(),
      ],
    })
      .session(session ?? null)
      .select('file_id')
      .lean();
    return new Set(files.map((file) => file.file_id));
  }

  async function resolveQuoteRetention(
    owner: FileOwnerScope,
    entries: readonly { text: string; sourceRef?: QuoteSourceRef | null }[],
  ): Promise<ResolvedQuoteRetention> {
    const scope = fileSourceScope(owner);
    if (
      entries.length > 10 ||
      entries.some(
        (entry) => typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 1500,
      )
    )
      throw new FileSourceUnavailableError();
    const ids = [
      ...new Set(entries.flatMap(({ sourceRef }) => (sourceRef ? [sourceRef.messageId] : []))),
    ];
    const rows = ids.length
      ? await mongoose.models.Message.find({ ...scope, messageId: { $in: ids } })
          .select(
            'messageId __v quotes sourceFileIds sourceExpiresAt sourceContentRemovedAt +quoteSourceRetention',
          )
          .lean<IMessage[]>()
      : [];
    if (rows.length !== ids.length) throw new FileSourceUnavailableError();
    const byId = new Map(rows.map((row) => [row.messageId, row]));
    const selected: Array<{
      index: number;
      ref: QuoteSourceRef;
      context?: SourceRetentionContext;
    }> = [];
    const conditions = new Map<string, { messageId: string; messageVersion: number | null }>();
    const now = new Date();
    // Check the full quote shape for index refs: a read-only mask can already have reindexed it.
    const shapeIds: string[] = [];
    entries.forEach(({ sourceRef: ref }, index) => {
      if (!ref) return;
      if (
        typeof ref.messageId !== 'string' ||
        !ref.messageId ||
        ref.messageId.length > 512 ||
        (ref.messageVersion != null &&
          (!Number.isInteger(ref.messageVersion) || ref.messageVersion < 0))
      )
        throw new FileSourceUnavailableError();
      const row = byId.get(ref.messageId);
      if (!row) throw new FileSourceUnavailableError();
      let context: SourceRetentionContext | undefined;
      if (ref.quoteIndex != null) {
        if (
          !Number.isInteger(ref.quoteIndex) ||
          ref.quoteIndex < 0 ||
          !Number.isInteger(ref.messageVersion) ||
          ref.messageVersion !== (row.__v ?? 0) ||
          row.quotes?.[ref.quoteIndex] == null
        )
          throw new FileSourceUnavailableError();
        for (const binding of row.quoteSourceRetention ?? []) {
          if (binding.sourceExpiresAt <= now) throw new FileSourceUnavailableError();
          shapeIds.push(...binding.sourceFileIds);
        }
        context = row.quoteSourceRetention?.find((item) => item.index === ref.quoteIndex);
      } else {
        if (row.sourceContentRemovedAt || (row.sourceExpiresAt && row.sourceExpiresAt <= now))
          throw new FileSourceUnavailableError();
        if (row.sourceFileIds?.length)
          context = {
            sourceFileIds: row.sourceFileIds,
            sourceExpiresAt: row.sourceExpiresAt!,
          };
      }
      conditions.set(row.messageId, { messageId: row.messageId, messageVersion: row.__v ?? null });
      selected.push({ index, ref: { ...ref }, context });
    });
    const fileIds = [
      ...new Set([...shapeIds, ...selected.flatMap((item) => item.context?.sourceFileIds ?? [])]),
    ];
    const live = await resolveFileSources(mongoose, owner, fileIds);
    if (fileIds.some((id) => !live?.sourceFileIds.includes(id)))
      throw new FileSourceUnavailableError();
    return {
      quotes: entries.map((entry) => entry.text),
      quoteSourceRetention: selected.flatMap(({ index, ref, context }) =>
        context
          ? [
              {
                index,
                sourceRef: ref,
                sourceFileIds: [...context.sourceFileIds],
                sourceExpiresAt: new Date(context.sourceExpiresAt.getTime()),
              },
            ]
          : [],
      ),
      sourceMessageConditions: [...conditions.values()],
    };
  }

  async function resolveFileRetentionContext(
    owner: FileOwnerScope,
    input: Parameters<MessageMethods['resolveFileRetentionContext']>[1],
  ): Promise<SourceRetentionContext | undefined> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const ids = [...new Set(input.historyMessageIds)];
    const history = ids.length
      ? await Message.find({ ...fileSourceScope(owner), messageId: { $in: ids } })
          .select(
            'messageId __v sourceFileIds sourceExpiresAt sourceContentRemovedAt quotes +quoteSourceRetention',
          )
          .lean<IMessage[]>()
      : [];
    if (
      history.length !== ids.length ||
      history.some(
        (row) =>
          row.sourceContentRemovedAt || (row.sourceExpiresAt && row.sourceExpiresAt <= new Date()),
      )
    )
      throw new FileSourceUnavailableError();
    const quoteLive = await liveQuoteIds(
      owner,
      history.flatMap((row) => row.quoteSourceRetention ?? []),
    );
    const snapshots = new Map(
      (input.historyQuoteSnapshots ?? []).map((snapshot) => [snapshot.messageId, snapshot]),
    );
    const inherited = history.flatMap((row) => {
      const visible = filterQuotes(
        row,
        (binding) =>
          binding.sourceExpiresAt <= new Date() ||
          binding.sourceFileIds.some((id) => !quoteLive.has(id)),
      );
      const snapshot = snapshots.get(row.messageId);
      if (
        snapshot &&
        ((row.__v ?? null) !== snapshot.messageVersion ||
          JSON.stringify(visible.quotes) !== JSON.stringify(snapshot.quotes))
      ) {
        throw new FileSourceUnavailableError();
      }
      return [
        ...(row.sourceFileIds ?? []),
        ...visible.quoteSourceRetention.flatMap((binding) => binding.sourceFileIds),
      ];
    });
    const resolved = await resolveFileSources(mongoose, owner, [...input.fileIds, ...inherited]);
    if (inherited.some((id) => !resolved?.sourceFileIds.includes(id)))
      throw new FileSourceUnavailableError();
    return resolved;
  }

  async function writeRetainedMessage(
    identity: FilterQuery<IMessage>,
    input: Record<string, unknown>,
    options: Parameters<typeof writeMessage>[2],
  ): Promise<IMessage | null> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const owner = {
      userId: String(identity.user ?? ''),
      tenantId: tenantStorage.getStore()?.tenantId,
    };
    const session = await mongoose.startSession();
    let result: IMessage | null = null;
    const commitState: { write?: [boolean, unknown] } = {};
    try {
      await session.withTransaction(
        async () => {
          commitState.write = undefined;
          const current = await Message.findOne({ ...identity, ...fileSourceScope(owner) })
            .session(session)
            .select(privateMessagePaths())
            .lean<IMessage & { isEdited?: boolean }>();
          if (options.expectedVersion !== undefined && current == null) {
            throw new MessageVersionConflictError();
          }
          if (current?.sourceContentRemovedAt) throw new FileSourceUnavailableError();
          if (
            options.sourceCoverage &&
            (current?.isCreatedByUser === true ||
              current?.isUserSubmitted === true ||
              current?.isEdited === true)
          )
            throw new FileSourceUnavailableError();
          let prepared = options.quoteRetention;
          let sourceRetention = options.sourceRetention;
          if (options.nativeSource) {
            const source = await Message.findOne({
              ...fileSourceScope(owner),
              messageId: options.nativeSource.messageId,
              __v: options.nativeSource.messageVersion,
            })
              .select(privateMessagePaths())
              .session(session)
              .lean<IMessage>();
            if (
              !source ||
              source.sourceContentRemovedAt ||
              (source.sourceExpiresAt && source.sourceExpiresAt <= new Date())
            )
              throw new FileSourceUnavailableError();
            await Message.updateOne(
              { _id: source._id, ...fileSourceScope(owner), __v: source.__v ?? null },
              { $inc: { __v: 1 } },
              { session, timestamps: false },
            );
            if (source.sourceFileIds?.length)
              sourceRetention = {
                sourceFileIds: source.sourceFileIds,
                sourceExpiresAt: source.sourceExpiresAt!,
              };
            if (source.quoteSourceRetention != null) {
              if (JSON.stringify(input.quotes ?? []) !== JSON.stringify(source.quotes ?? []))
                throw new FileSourceUnavailableError();
              prepared = {
                quotes: source.quotes ?? [],
                quoteSourceRetention: source.quoteSourceRetention,
                sourceMessageConditions: [],
              };
            }
          }
          const sameCommitted =
            current?.quoteSourceRetention != null &&
            prepared != null &&
            JSON.stringify(current.quotes ?? []) === JSON.stringify(prepared.quotes) &&
            JSON.stringify(current.quoteSourceRetention) ===
              JSON.stringify(prepared.quoteSourceRetention);
          let quoteFields:
            | { quotes: string[]; quoteSourceRetention: QuoteSourceRetention[] }
            | undefined;
          if (prepared && !sameCommitted) {
            for (const condition of prepared.sourceMessageConditions) {
              const touched = await Message.updateOne(
                {
                  ...fileSourceScope(owner),
                  messageId: condition.messageId,
                  __v: condition.messageVersion,
                },
                { $inc: { __v: 1 } },
                { session, timestamps: false },
              );
              if (touched.matchedCount !== 1) throw new FileSourceUnavailableError();
            }
            quoteFields = {
              quotes: [...prepared.quotes],
              quoteSourceRetention: prepared.quoteSourceRetention,
            };
          } else if (current?.quoteSourceRetention != null) {
            const allowed = await liveQuoteIds(owner, current.quoteSourceRetention, session);
            quoteFields = filterQuotes(
              current,
              (binding) =>
                binding.sourceExpiresAt <= new Date() ||
                binding.sourceFileIds.some((id) => !allowed.has(id)),
            );
          }
          if (
            quoteFields?.quoteSourceRetention.some(
              (binding) => binding.sourceExpiresAt <= new Date(),
            )
          )
            throw new FileSourceUnavailableError();
          const ids = [
            ...new Set([
              ...(current?.sourceFileIds ?? []),
              ...(sourceRetention?.sourceFileIds ?? []),
            ]),
          ];
          await touchFileSources(
            mongoose,
            owner,
            [
              ...ids,
              ...(options.attachmentSourceFileIds ?? []),
              ...(quoteFields?.quoteSourceRetention ?? []).flatMap(
                (binding) => binding.sourceFileIds,
              ),
            ],
            session,
          );
          const context = await resolveFileSources(mongoose, owner, ids, session);
          if (ids.length && context?.sourceFileIds.length !== ids.length)
            throw new FileSourceUnavailableError();
          const deadline =
            context &&
            new Date(
              Math.min(
                context.sourceExpiresAt.getTime(),
                current?.sourceExpiresAt?.getTime() ?? Infinity,
              ),
            );
          if (deadline && deadline <= new Date()) throw new FileSourceUnavailableError();
          if (options.insertOnly && current) {
            result = quoteFields
              ? await Message.findOneAndUpdate(
                  { ...identity, ...fileSourceScope(owner) },
                  { $set: quoteFields, $inc: { __v: 1 } },
                  { new: true, session },
                )
              : await Message.findOne({ ...identity, ...fileSourceScope(owner) }).session(session);
            if (result) await accountRetainedMessage(owner, current, result._id, session);
            return;
          }
          result = await writeMessage(
            { ...identity, ...fileSourceScope(owner) },
            {
              ...input,
              ...quoteFields,
              ...(context && {
                sourceFileIds: [...context.sourceFileIds],
                sourceExpiresAt: deadline,
              }),
            },
            {
              ...options,
              sourceRetention: undefined,
              quoteRetention: undefined,
              session,
              onWrite: (inserted, id) => {
                commitState.write = [inserted, id];
              },
            },
          );
          if (result) await accountRetainedMessage(owner, current, result._id, session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
      if (commitState.write) options.onWrite?.(...commitState.write);
      return result;
    } finally {
      await session.endSession();
    }
  }

  const sourceMetadataFields = new Set([
    '_id',
    '__v',
    'user',
    'tenantId',
    'sourceFileIds',
    'sourceExpiresAt',
    'sourceContentRemovedAt',
    'files',
    'attachments',
    'quotes',
    'quoteSourceRetention',
  ]);

  function hasSourceMetadata(select?: string): boolean {
    if (!select) return true;
    return select
      .trim()
      .split(/\s+/)
      .every(
        (field) =>
          field.startsWith('+') ||
          (field.startsWith('-') && !sourceMetadataFields.has(field.slice(1))),
      );
  }

  /** Evaluate retention before removing the caller's private metadata exclusions. */
  function messageReadProjection(select?: string) {
    const fields = select?.trim().split(/\s+/).filter(Boolean) ?? [];
    const exclusion = fields.every((field) => field.startsWith('-') || field.startsWith('+'));
    const omitted = fields
      .filter(
        (field) =>
          field === '-_id' ||
          (exclusion && field.startsWith('-') && sourceMetadataFields.has(field.slice(1))),
      )
      .map((field) => field.slice(1));
    return {
      select: fields.filter((field) => !omitted.some((name) => field === `-${name}`)).join(' '),
      omitted,
    };
  }

  async function maskProjectedMessages(
    rows: IMessage[],
    projection: ReturnType<typeof messageReadProjection>,
  ) {
    const visible = await maskFileSourceMessages(rows, hasSourceMetadata(projection.select));
    for (const row of visible) {
      for (const field of projection.omitted)
        delete (row as unknown as Record<string, unknown>)[field];
    }
    return visible;
  }

  /** Resolve all projected history rows and source files in batches, never one query per message. */
  async function maskFileSourceMessages(
    rows: IMessage[],
    completeMetadata = true,
  ): Promise<IMessage[]> {
    if (!rows.length) return rows;
    const Message = mongoose.models.Message as Model<IMessage>;
    if (!completeMetadata && rows.some((row) => row._id == null))
      throw new FileSourceUnavailableError();
    const metadata = completeMetadata
      ? rows
      : await Message.find({ _id: { $in: rows.map((row) => row._id) } })
          .select(
            'user tenantId __v sourceFileIds sourceExpiresAt sourceContentRemovedAt files attachments quotes +quoteSourceRetention',
          )
          .lean<IMessage[]>();
    if (metadata.length !== rows.length) throw new FileSourceUnavailableError();
    const byId = new Map(metadata.map((row) => [String(row._id), row]));
    // A projected read may precede physical redaction. Never combine its old arrays with newer bindings.
    const projectedRows = completeMetadata
      ? rows
      : rows.map((row) => {
          const meta = byId.get(String(row._id));
          if (!meta) throw new FileSourceUnavailableError();
          return Object.assign({}, row, {
            ...(Array.isArray(row.quotes) && { quotes: meta.quotes ?? [], __v: meta.__v }),
            ...(Array.isArray(row.files) && { files: meta.files ?? [] }),
            ...(Array.isArray(row.attachments) && { attachments: meta.attachments ?? [] }),
          });
        });
    const refs = (row: IMessage) =>
      [...(row.files ?? []), ...(row.attachments ?? [])]
        .map((value) => (value as { file_id?: string } | null)?.file_id)
        .filter((id): id is string => typeof id === 'string');
    const ids = [
      ...new Set(
        metadata.flatMap((row) => [
          ...(row.sourceFileIds ?? []),
          ...refs(row),
          ...(row.quoteSourceRetention ?? []).flatMap((binding) => binding.sourceFileIds),
        ]),
      ),
    ];
    const publicRow = (row: IMessage): IMessage => {
      return publicMessageProjection(Object.assign({}, row));
    };
    if (!ids.length && !metadata.some((row) => row.sourceContentRemovedAt))
      return projectedRows.map(publicRow);
    const File = mongoose.models.File;
    const files = ids.length
      ? await File.find({ file_id: { $in: ids } })
          .select(
            'user tenantId file_id retentionAcceptedAt expiredAt deletionRequestedAt deletionCompletedAt',
          )
          .lean()
      : [];
    const key = (user: unknown, tenant: unknown, id: string) =>
      JSON.stringify([String(user), tenant || null, id]);
    const lookup = new Map(
      files.map((file) => [key(file.user, file.tenantId, file.file_id), file]),
    );
    const now = new Date();
    return projectedRows.map((row) => {
      const meta = byId.get(String(row._id));
      if (!meta) throw new FileSourceUnavailableError();
      const unavailable = (id: string, required: boolean) => {
        const file = lookup.get(key(meta.user, meta.tenantId, id));
        return file == null
          ? required
          : Boolean(
              file.retentionAcceptedAt &&
                (file.deletionRequestedAt ||
                  file.deletionCompletedAt ||
                  !file.expiredAt ||
                  file.expiredAt <= now),
            );
      };
      const visibleQuotes =
        meta.quoteSourceRetention != null && Array.isArray(row.quotes)
          ? filterQuotes(
              { quotes: row.quotes, quoteSourceRetention: meta.quoteSourceRetention },
              (binding) =>
                binding.sourceExpiresAt <= now ||
                binding.sourceFileIds.some((id) => unavailable(id, true)),
            )
          : undefined;
      const visible = Object.assign({}, row, visibleQuotes && { quotes: visibleQuotes.quotes });
      if (
        meta.sourceContentRemovedAt ||
        (meta.sourceExpiresAt && meta.sourceExpiresAt <= now) ||
        meta.sourceFileIds?.some((id) => unavailable(id, true))
      ) {
        return publicRow(
          removedBody(visible as unknown as Record<string, unknown>) as unknown as IMessage,
        );
      }
      const copy = publicRow(visible);
      for (const field of ['files', 'attachments'] as const) {
        if (Array.isArray(copy[field]))
          copy[field] = copy[field]!.filter((ref) => {
            const id = (ref as { file_id?: string } | null)?.file_id;
            return typeof id !== 'string' || !unavailable(id, false);
          });
      }
      return copy;
    });
  }

  async function redactFileSourceContent(owner: FileOwnerScope, fileIds: readonly string[]) {
    const Message = mongoose.models.Message as Model<IMessage>;
    const ids = [...new Set(fileIds)];
    if (!ids.length) return { redactedMessages: 0, detachedMessages: 0 };
    const scope = fileSourceScope(owner);
    // File revoke precedes this operation, so admitted source-body commits cannot race past it.
    const files = await mongoose.models.File.find({
      ...scope,
      file_id: { $in: ids },
      retentionAcceptedAt: { $ne: null },
      deletionRequestedAt: { $ne: null },
    })
      .select('file_id')
      .lean();
    if (files.length !== ids.length) throw new FileSourceUnavailableError();
    let redactedMessages = 0;
    const affected = {
      ...scope,
      $or: [
        { sourceFileIds: { $in: ids }, sourceContentRemovedAt: null },
        { 'quoteSourceRetention.sourceFileIds': { $in: ids } },
      ],
    };
    const cursor = Message.find(affected).select(privateMessagePaths()).lean().cursor();
    for await (const initial of cursor) {
      let row: IMessage | null = initial as IMessage;
      let settled = false;
      for (let attempt = 0; attempt < MAX_PROVENANCE_CAS_ATTEMPTS; attempt++) {
        if (!row) {
          settled = true;
          break;
        }
        const removeBody =
          !row.sourceContentRemovedAt && row.sourceFileIds?.some((id) => ids.includes(id));
        const removeQuotes = row.quoteSourceRetention?.some((binding) =>
          binding.sourceFileIds.some((id) => ids.includes(id)),
        );
        if (!removeBody && !removeQuotes) {
          settled = true;
          break;
        }
        const quoteFields =
          row.quoteSourceRetention != null
            ? filterQuotes(row, (binding) => binding.sourceFileIds.some((id) => ids.includes(id)))
            : undefined;
        const replacement: Record<string, unknown> = {
          ...(removeBody ? removedBody(row as unknown as Record<string, unknown>) : row),
          ...quoteFields,
          __v: (row.__v ?? 0) + 1,
        };
        // Preserve the existing tenant replacement guard's canonical absence representation.
        if (replacement.tenantId == null) delete replacement.tenantId;
        let result = { matchedCount: 0, modifiedCount: 0 };
        const session = await mongoose.startSession();
        try {
          await session.withTransaction(
            async () => {
              result = await Message.replaceOne(
                { _id: row!._id, ...scope, __v: row!.__v ?? null },
                replacement,
                { timestamps: false, session },
              );
              // Unknown legacy copies can still be physically redacted, but yield no credit.
              if (result.matchedCount && row!.retainedTextAllocations != null)
                await accountRetainedMessage(owner, row, row!._id, session);
            },
            { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
          );
        } finally {
          await session.endSession();
        }
        if (result.matchedCount === 1) {
          redactedMessages += result.modifiedCount;
          settled = true;
          break;
        }
        row = await Message.findOne({ _id: row._id, ...scope })
          .select(privateMessagePaths())
          .lean<IMessage>();
      }
      if (!settled) throw new FileSourceUnavailableError();
    }
    const detached = await Message.updateMany(
      {
        ...scope,
        $or: [{ 'files.file_id': { $in: ids } }, { 'attachments.file_id': { $in: ids } }],
      },
      {
        $pull: { files: { file_id: { $in: ids } }, attachments: { file_id: { $in: ids } } },
        $inc: { __v: 1 },
      },
      { timestamps: false },
    );
    return { redactedMessages, detachedMessages: detached.modifiedCount };
  }

  /** The API constructs method adapters before it necessarily registers every model. */
  function privateMessagePaths(): string {
    const Message = mongoose.models.Message as Model<IMessage>;
    return Object.entries(Message.schema.paths)
      .filter(([, path]) => path.options.select === false)
      .map(([name]) => `+${name}`)
      .join(' ');
  }

  async function prepareAppUpdate(
    update: Record<string, unknown>,
    current: Record<string, unknown> | null,
    unsetContextMeta = false,
    retentionOnInsert?: { expiredAt: Date; isTemporary: false },
    sourceCoverage?: SourceCoverage,
    unsetSourceCoverage = false,
  ): Promise<Record<string, unknown>> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const safeUpdate = sanitizeMessageUpdate(update, true, sourceCoverage);
    // Omission retains the attachments of THIS fenced row; null/[] explicitly clears them.
    const attachments = Object.prototype.hasOwnProperty.call(safeUpdate, 'attachments')
      ? safeUpdate.attachments
      : current?.attachments;
    if (!hasBoundAppSnapshots(attachments)) return safeUpdate;
    const maxBytes = await deps.getMCPAppMessageBudget?.();
    const admitted = fitBoundAppSnapshots(
      attachments as unknown[],
      (candidateAttachments) => {
        const fields = {
          ...current,
          ...(current == null ? retentionOnInsert : {}),
          ...safeUpdate,
          attachments: candidateAttachments,
          ...(unsetContextMeta ? { contextMeta: undefined } : {}),
          createdAt: current?.createdAt ?? safeUpdate.createdAt ?? new Date(),
          updatedAt: new Date(),
          __v: (Number(current?.__v) || 0) + 1,
        };
        const next = new Message(fields).toObject({ depopulate: true, minimize: false });
        // Keep unknown fields already stored by a newer producer, even if this schema drops them.
        const candidate = { ...current, ...next };
        if (unsetContextMeta) delete candidate.contextMeta;
        if (unsetSourceCoverage && candidate.metadata != null) {
          candidate.metadata = { ...candidate.metadata };
          delete candidate.metadata.sourceCoverage;
        }
        return mongoose.mongo.BSON.calculateObjectSize(candidate);
      },
      maxBytes,
    );
    if (admitted !== attachments) {
      logger.warn('[saveMessage] Optional MCP App documents exceeded the message BSON budget');
    }
    return admitted === attachments ? safeUpdate : { ...safeUpdate, attachments: admitted };
  }

  /** One admission owner for save, edit, record and import. No size heuristics or stale closures. */
  async function writeMessage(
    identity: FilterQuery<IMessage>,
    input: Record<string, unknown>,
    options: {
      upsert: boolean;
      expectedVersion?: number | null;
      stampModelOutputOnInsert?: boolean;
      unsetContextMeta?: boolean;
      retentionOnInsert?: { expiredAt: Date; isTemporary: false };
      unsetPrivateText?: boolean;
      unsetSourceCoverage?: boolean;
      timestamps?: boolean;
      session?: ClientSession;
      sourceRetention?: SourceRetentionContext;
      sourceCoverage?: SourceCoverage;
      quoteRetention?: ResolvedQuoteRetention;
      nativeSource?: { messageId: string; messageVersion: number | null };
      attachmentSourceFileIds?: readonly string[];
      insertOnly?: boolean;
      onWrite?: (inserted: boolean, id: unknown) => void;
    },
  ): Promise<IMessage | null> {
    const Message = mongoose.models.Message as Model<IMessage>;
    if (options.expectedVersion !== undefined) {
      identity = { ...identity, ...expectedMessageVersionFilter(options.expectedVersion) };
      options = { ...options, upsert: false };
    }
    const update = sanitizeMessageUpdate(input, options.session != null, options.sourceCoverage);
    options = {
      ...options,
      unsetSourceCoverage:
        !options.sourceCoverage &&
        (options.unsetSourceCoverage === true ||
          Object.keys(update).some((key) => ['text', 'content'].includes(key.split('.')[0])) ||
          update.isEdited === true ||
          update.isUserSubmitted === true ||
          update.isCreatedByUser === true),
    };
    const paths = normalizeUserSubmittedPaths(update.userSubmittedPaths);
    const fields = normalizeUserSubmittedMessageFieldPaths(update.userSubmittedMessageFieldPaths);
    delete update.userSubmittedPaths;
    delete update.userSubmittedMessageFieldPaths;
    if (!options.session) {
      const refs = [
        ...(Array.isArray(update.files) ? update.files : []),
        ...(Array.isArray(update.attachments) ? update.attachments : []),
      ]
        .map((value) => (value as { file_id?: string } | null)?.file_id)
        .filter((id): id is string => typeof id === 'string');
      // Only actual managed references enter a transaction; attaching a file does not taint user text.
      const managed = refs.length
        ? await mongoose.models.File.find({
            file_id: { $in: refs },
            retentionAcceptedAt: { $ne: null },
          })
            .select('file_id')
            .lean()
        : [];
      if (managed.length) {
        const managedIds = new Set(managed.map((file) => file.file_id));
        for (const key of ['files', 'attachments']) {
          if (!Array.isArray(update[key])) continue;
          update[key] = update[key].map((file: Record<string, unknown> | null) => {
            if (!file || !managedIds.has(file.file_id)) return file;
            const { text: _canonicalText, ...reference } = file;
            return reference;
          });
        }
      }
      if (
        options.nativeSource ||
        options.quoteRetention ||
        options.sourceRetention?.sourceFileIds.length ||
        managed.length
      )
        return writeRetainedMessage(
          identity,
          { ...update, userSubmittedPaths: paths, userSubmittedMessageFieldPaths: fields },
          { ...options, attachmentSourceFileIds: managed.map((file) => file.file_id) },
        );
    }
    if (options.insertOnly && options.session) {
      return Message.findOneAndUpdate(
        identity,
        { $setOnInsert: update },
        { upsert: true, new: true, session: options.session },
      );
    }
    if (
      !options.insertOnly &&
      !hasBoundAppSnapshots(update.attachments) &&
      paths.length === 0 &&
      fields.length === 0
    ) {
      try {
        // Preserve the single-write common path. If an App row is excluded, its existing
        // unique (messageId, user, tenantId) index rejects the upsert; budget that row below.
        const fast = await Message.findOneAndUpdate(
          { ...identity, ...NO_BOUND_APPS, ...(!options.session ? NO_SOURCE_BODY : {}) },
          buildMessageSaveUpdate(update, {
            stampModelOutputOnInsert: options.stampModelOutputOnInsert ?? false,
            unsetContextMeta: options.unsetContextMeta ?? false,
            retentionOnInsert: options.retentionOnInsert,
            unsetPrivateText: options.unsetPrivateText,
            unsetSourceCoverage: options.unsetSourceCoverage,
          }),
          {
            upsert: options.upsert,
            new: true,
            timestamps: options.timestamps,
            includeResultMetadata: true,
            session: options.session,
          },
        );
        if (fast.value) {
          options.onWrite?.(fast.lastErrorObject?.updatedExisting === false, fast.value._id);
          return fast.value;
        }
      } catch (error) {
        if (options.expectedVersion !== undefined && isDuplicateKeyError(error)) {
          throw new MessageVersionConflictError();
        }
        if (options.session || !isDuplicateKeyError(error)) throw error;
      }
    }
    if (!options.session) {
      const current = await Message.findOne(identity)
        .select('sourceFileIds sourceContentRemovedAt +quoteSourceRetention')
        .lean<IMessage>();
      if (
        current?.quoteSourceRetention != null ||
        current?.sourceFileIds?.length ||
        current?.sourceContentRemovedAt
      ) {
        return writeRetainedMessage(
          identity,
          { ...update, userSubmittedPaths: paths, userSubmittedMessageFieldPaths: fields },
          options,
        );
      }
    }
    if (options.insertOnly) {
      return Message.findOneAndUpdate(
        { ...identity, ...NO_SOURCE_BODY },
        { $setOnInsert: update },
        { upsert: true, new: true },
      );
    }
    return findOneAndMergeMessageProvenance(
      Message,
      options.session ? identity : { ...identity, ...NO_SOURCE_BODY },
      update,
      paths,
      fields,
      {
        ...options,
        privateMessagePaths: privateMessagePaths(),
        prepareAppUpdate: (current, sanitized) =>
          prepareAppUpdate(
            sanitized,
            current,
            options.unsetContextMeta,
            options.retentionOnInsert,
            options.sourceCoverage,
            options.unsetSourceCoverage,
          ),
      },
    );
  }

  /**
   * Saves a message in the database.
   */
  async function saveMessage(
    {
      userId,
      isTemporary,
      expiredAt,
      interfaceConfig,
    }: {
      userId: string;
      isTemporary?: boolean;
      expiredAt?: Date;
      interfaceConfig?: AppConfig['interfaceConfig'];
    },
    params: Omit<Partial<IMessage>, 'contextMeta'> & {
      newMessageId?: string;
      /** `null` unsets a previously stored value; omission leaves it in place. */
      contextMeta?: IMessage['contextMeta'] | null;
    },
    metadata?: {
      context?: string;
      expectedVersion?: number | null;
      privateText?: PrivateTextWrite;
      insertOnly?: boolean;
      sourceRetention?: SourceRetentionContext;
      sourceCoverage?: SourceCoverage;
      quoteRetention?: ResolvedQuoteRetention;
    },
  ) {
    if (!userId) {
      throw new Error('User not authenticated');
    }

    const hasExpectedVersion = Object.prototype.hasOwnProperty.call(
      metadata ?? {},
      'expectedVersion',
    );
    const expectedVersion = metadata?.expectedVersion;
    if (hasExpectedVersion) {
      if (
        expectedVersion !== null &&
        (typeof expectedVersion !== 'number' ||
          !Number.isSafeInteger(expectedVersion) ||
          expectedVersion < 0)
      ) {
        throw new TypeError('Invalid expected message version.');
      }
      if (
        params.newMessageId !== undefined ||
        Object.prototype.hasOwnProperty.call(params, 'newMessageId') ||
        metadata?.insertOnly === true
      ) {
        throw new TypeError('Expected message versions require an existing-row update.');
      }
    }

    const conversationId = params.conversationId as string | undefined;
    if (!conversationId || !UUID_REGEX.test(conversationId)) {
      logger.warn(
        `Invalid conversation ID: ${conversationId} (context: ${metadata?.context ?? 'n/a'})`,
      );
      return;
    }

    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const update = sanitizeMessageUpdate({
        ...params,
        user: userId,
        messageId: params.newMessageId || params.messageId,
      });
      const sourceCoverage =
        metadata?.sourceCoverage === undefined
          ? undefined
          : readSourceCoverage(metadata.sourceCoverage);
      if (metadata?.sourceCoverage !== undefined) {
        const retention = metadata.sourceRetention;
        if (
          !sourceCoverage ||
          params.isCreatedByUser !== false ||
          params.isUserSubmitted === true ||
          update.isEdited === true ||
          params.newMessageId != null ||
          metadata.insertOnly === true ||
          !(retention?.sourceExpiresAt instanceof Date) ||
          !Number.isFinite(retention.sourceExpiresAt.getTime()) ||
          retention.sourceExpiresAt <= new Date() ||
          !Array.isArray(retention.sourceFileIds) ||
          !retention.sourceFileIds.length ||
          sourceCoverage.entries.some((entry) => !retention.sourceFileIds.includes(entry.file_id))
        )
          throw new FileSourceUnavailableError();
      }
      delete update.sourceFileIds;
      delete update.sourceExpiresAt;
      delete update.sourceContentRemovedAt;
      delete update.quoteSourceRetention;
      delete update.quoteSourceRefs;
      delete update.privateText;
      delete update.privacyRevision;
      delete update.privateTextTokens;
      for (const key of Object.keys(update)) {
        if (
          [
            'retainedTextAllocations',
            'sourceFileIds',
            'sourceExpiresAt',
            'sourceContentRemovedAt',
            'quoteSourceRetention',
            'quoteSourceRefs',
          ].includes(key.split('.')[0])
        )
          delete update[key];
      }
      if (metadata?.privateText != null) {
        if (params.isCreatedByUser !== true || typeof params.text !== 'string') {
          throw new Error('Private text requires a user message.');
        }
        update.privateText = metadata.privateText.envelope;
        update.privacyRevision = metadata.privateText.revision;
      }
      delete update.isTemporary;
      delete update.expiredAt;
      let retentionOnInsert: { expiredAt: Date; isTemporary: false } | undefined;

      const forcedTemporary = isForcedTemporaryRetention(interfaceConfig?.retentionMode);
      if (expiredAt instanceof Date && !Number.isNaN(expiredAt.getTime())) {
        if (forcedTemporary) {
          update.isTemporary = true;
        } else if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        update.expiredAt = expiredAt;
      } else if (forcedTemporary) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (interfaceConfig?.retentionMode === RetentionMode.ALL) {
        if (typeof isTemporary === 'boolean') {
          update.isTemporary = isTemporary;
        }
        if (
          typeof isTemporary === 'boolean' ||
          interfaceConfig.generalChatRetention === undefined
        ) {
          try {
            update.expiredAt = createChatExpirationDate(interfaceConfig, isTemporary);
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
            update.expiredAt = createFallbackRetentionDate();
          }
        } else {
          try {
            retentionOnInsert = {
              expiredAt: createChatExpirationDate(interfaceConfig, false),
              isTemporary: false,
            };
          } catch (err) {
            logger.error('Error creating chat expiration date:', err);
            logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
            retentionOnInsert = {
              expiredAt: createFallbackRetentionDate(),
              isTemporary: false,
            };
          }
        }
      } else if (isTemporary === true) {
        update.isTemporary = true;
        try {
          update.expiredAt = createTempChatExpirationDate(interfaceConfig);
        } catch (err) {
          logger.error('Error creating temporary chat expiration date:', err);
          logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
          update.expiredAt = createFallbackRetentionDate();
        }
      } else if (isTemporary === false) {
        update.isTemporary = false;
        update.expiredAt = null;
      }

      /** A response that ends with nothing to carry must drop what an earlier
       * partial save (a disconnect snapshot) stored, or the next turn would seed
       * from stale state; omission never unsets, and the unset rides the same
       * update as the response. */
      const unsetContextMeta = update.contextMeta === null;
      if (unsetContextMeta) {
        delete update.contextMeta;
      }
      if (update.tokenCount != null && isNaN(update.tokenCount as number)) {
        logger.warn(
          `Resetting invalid \`tokenCount\` for message \`${params.messageId}\`: ${update.tokenCount}`,
        );
        logger.info(`---\`saveMessage\` context: ${metadata?.context}`);
        update.tokenCount = 0;
      }
      const userSubmittedPaths = normalizeUserSubmittedPaths([
        ...(Array.isArray(params.userSubmittedPaths) ? params.userSubmittedPaths : []),
        ...getSteerUserSubmittedPaths(params.content),
      ]);
      const userSubmittedMessageFieldPaths = normalizeUserSubmittedMessageFieldPaths(
        params.userSubmittedMessageFieldPaths,
      );
      delete update.userSubmittedPaths;
      delete update.userSubmittedMessageFieldPaths;
      delete update.__v;
      const stampModelOutputOnInsert =
        params.isCreatedByUser === false && params.isUserSubmitted === undefined;
      if (metadata?.insertOnly === true) {
        if (metadata.privateText != null) {
          throw new Error('A private message cannot use the ordinary insert-only writer.');
        }
        if (
          metadata.quoteRetention ||
          metadata.sourceRetention ||
          (Array.isArray(update.files) && update.files.length) ||
          (Array.isArray(update.attachments) && update.attachments.length)
        ) {
          const saved = await writeMessage({ messageId: params.messageId, user: userId }, update, {
            upsert: true,
            insertOnly: true,
            sourceRetention: metadata.sourceRetention,
            quoteRetention: metadata.quoteRetention,
          });
          return saved?.toObject();
        }
        const now = new Date();
        const existingOrInserted = await Message.findOneAndUpdate(
          { messageId: params.messageId, user: userId, ...NO_SOURCE_BODY },
          {
            $setOnInsert: {
              ...update,
              ...(userSubmittedPaths.length > 0 && { userSubmittedPaths }),
              ...(userSubmittedMessageFieldPaths.length > 0 && { userSubmittedMessageFieldPaths }),
              ...retentionOnInsert,
              createdAt: now,
              updatedAt: now,
            },
          },
          { upsert: true, new: true, timestamps: false },
        );
        return existingOrInserted?.toObject();
      }
      const message = await writeMessage(
        { messageId: params.messageId, user: userId },
        { ...update, userSubmittedPaths, userSubmittedMessageFieldPaths },
        {
          upsert: !hasExpectedVersion,
          ...(hasExpectedVersion && { expectedVersion }),
          sourceRetention: metadata?.sourceRetention,
          sourceCoverage: sourceCoverage ?? undefined,
          quoteRetention: metadata?.quoteRetention,
          stampModelOutputOnInsert,
          unsetContextMeta,
          retentionOnInsert,
          unsetPrivateText:
            metadata?.privateText == null && Object.prototype.hasOwnProperty.call(update, 'text'),
        },
      );

      if (message == null) {
        return message;
      }

      /** Reuse the saved row's chat type when callers omit it, preserving existing deadlines. */
      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        interfaceConfig.generalChatRetention !== undefined &&
        typeof isTemporary !== 'boolean' &&
        message.expiredAt == null
      ) {
        const deadline = createChatExpirationDate(interfaceConfig, message.isTemporary === true);
        const result = await Message.updateOne(
          {
            _id: message._id,
            ...(hasExpectedVersion && { __v: message.__v }),
            expiredAt: null,
            isTemporary: message.isTemporary === true ? true : { $ne: true },
          },
          { $set: { expiredAt: deadline } },
          { timestamps: false },
        );
        if (result.modifiedCount > 0) {
          message.expiredAt = deadline;
        }
      }

      if (
        interfaceConfig?.retentionMode === RetentionMode.ALL &&
        typeof isTemporary !== 'boolean' &&
        (message.isTemporary == null ||
          (message.isTemporary === false && message.$isDefault('isTemporary')))
      ) {
        await Message.updateOne(
          {
            _id: message._id,
            ...(hasExpectedVersion && { __v: message.__v }),
            isTemporary: { $ne: false },
          },
          { $set: { isTemporary: false } },
        );
        message.isTemporary = false;
      }

      return message.toObject();
    } catch (err: unknown) {
      if (err instanceof MessageVersionConflictError) throw err;
      if (hasExpectedVersion && isDuplicateKeyError(err)) throw new MessageVersionConflictError();
      logger.error('Error saving message:', err);
      logger.info(`---\`saveMessage\` context: ${metadata?.context}`);

      const mongoErr = err as { code?: number; message?: string };
      if (mongoErr.code === 11000 && mongoErr.message?.includes('duplicate key error')) {
        logger.warn(`Duplicate messageId detected: ${params.messageId}. Continuing execution.`);

        try {
          const Message = mongoose.models.Message as Model<IMessage>;
          const existingMessage = await Message.findOne({
            messageId: params.messageId,
            user: userId,
          }).select('+quoteSourceRetention');

          if (existingMessage) {
            if (
              existingMessage.quoteSourceRetention != null ||
              existingMessage.sourceFileIds?.length ||
              existingMessage.sourceContentRemovedAt
            ) {
              if (metadata?.insertOnly && !existingMessage.sourceContentRemovedAt) {
                const retained = await writeMessage(
                  { messageId: params.messageId, user: userId },
                  { ...params, user: userId },
                  { upsert: true, insertOnly: true },
                );
                return retained?.toObject();
              }
              throw new FileSourceUnavailableError();
            }
            return existingMessage.toObject();
          }

          return undefined;
        } catch (findError) {
          if (findError instanceof FileSourceUnavailableError) throw findError;
          logger.warn(
            `Could not retrieve existing message with ID ${params.messageId}: ${(findError as Error).message}`,
          );
          return undefined;
        }
      }

      throw err;
    }
  }

  /**
   * Saves multiple messages in bulk.
   */
  async function bulkSaveMessages(
    messages: Array<Record<string, unknown>>,
    overrideTimestamp = false,
    provenance?: {
      privateTextTokens: ReadonlyMap<string, readonly string[]>;
      nativeSources?: ReadonlyMap<string, { messageId: string; messageVersion: number | null }>;
    },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const bulkOps = messages.map((message) => {
        const normalizedMessage = sanitizeMessageUpdate(message);
        delete normalizedMessage.privateText;
        delete normalizedMessage.privacyRevision;
        delete normalizedMessage.privateTextTokens;
        const tokens = provenance?.privateTextTokens.get(String(message.messageId));
        const text = message.text;
        if (
          tokens?.length &&
          tokens.length <= 4096 &&
          message.isCreatedByUser === true &&
          typeof text === 'string'
        ) {
          normalizedMessage.privateTextTokens = tokens.filter(
            (token) =>
              /^\[(?:EMAIL|PHONE|NAME|CREDENTIAL|CUSTOM)_\d+_[a-f0-9]{32}\]$/.test(token) &&
              text.includes(token),
          );
        }
        const submittedProvenance = capNormalizedProvenance(
          normalizeUserSubmittedPaths(message.userSubmittedPaths),
          normalizeUserSubmittedMessageFieldPaths(message.userSubmittedMessageFieldPaths),
        );
        if (submittedProvenance.userSubmittedPaths.length > 0) {
          normalizedMessage.userSubmittedPaths = submittedProvenance.userSubmittedPaths;
        } else {
          delete normalizedMessage.userSubmittedPaths;
        }
        if (submittedProvenance.userSubmittedMessageFieldPaths.length > 0) {
          normalizedMessage.userSubmittedMessageFieldPaths =
            submittedProvenance.userSubmittedMessageFieldPaths;
        } else {
          delete normalizedMessage.userSubmittedMessageFieldPaths;
        }
        if (submittedProvenance.promoteWholeMessage) {
          normalizedMessage.isUserSubmitted = true;
        }
        return {
          updateOne: {
            filter: {
              messageId: message.messageId,
              ...(message.user != null ? { user: message.user } : {}),
            },
            update: {
              $set: normalizedMessage,
              $inc: { __v: 1 },
              $unset: {
                ...sourceCoverageUnset(normalizedMessage, true),
                privateText: 1,
                privacyRevision: 1,
                ...(normalizedMessage.privateTextTokens == null && { privateTextTokens: 1 }),
              },
            },
            timestamps: !overrideTimestamp,
            upsert: true,
          },
        };
      });
      // Keep no-App imports batched. The atomic predicate makes a race with App attachment
      // creation collide on the unique key, at which point only that row uses guarded admission.
      const guarded: typeof bulkOps = [];
      const ordinary = bulkOps.filter((op) => {
        if (
          provenance?.nativeSources?.has(String(op.updateOne.filter.messageId)) ||
          hasBoundAppSnapshots(op.updateOne.update.$set.attachments) ||
          (Array.isArray(op.updateOne.update.$set.files) &&
            op.updateOne.update.$set.files.length > 0) ||
          (Array.isArray(op.updateOne.update.$set.attachments) &&
            op.updateOne.update.$set.attachments.length > 0)
        ) {
          guarded.push(op);
          return false;
        }
        return true;
      });
      let result:
        | {
            matchedCount: number;
            modifiedCount: number;
            upsertedCount: number;
            upsertedIds: Record<number, unknown>;
          }
        | undefined;
      const repaired = {
        matchedCount: 0,
        modifiedCount: 0,
        upsertedCount: 0,
        upsertedIds: {} as Record<number, unknown>,
      };
      if (ordinary.length) {
        try {
          result = await tenantSafeBulkWrite(
            Message,
            ordinary.map((op) => ({
              updateOne: {
                ...op.updateOne,
                filter: { ...op.updateOne.filter, ...NO_BOUND_APPS, ...NO_SOURCE_BODY },
              },
            })),
            { ordered: false },
          );
        } catch (error) {
          const failure = error as {
            writeErrors?: Array<{ code: number; index: number }>;
            result?: typeof result;
          };
          if (
            !failure.writeErrors?.length ||
            failure.writeErrors.some((item) => item.code !== 11000)
          )
            throw error;
          result = failure.result;
          for (const { index } of failure.writeErrors) guarded.push(ordinary[index]);
        }
      }
      // Ordinary imports stay batched; exceptional App rows are admitted one at a time.
      for (const op of guarded) {
        await writeMessage(op.updateOne.filter, op.updateOne.update.$set, {
          upsert: true,
          nativeSource: provenance?.nativeSources?.get(String(op.updateOne.filter.messageId)),
          unsetPrivateText: true,
          unsetSourceCoverage: true,
          timestamps: !overrideTimestamp,
          onWrite: (inserted, id) => {
            if (inserted) {
              repaired.upsertedCount++;
              repaired.upsertedIds[bulkOps.indexOf(op)] = id;
            } else {
              repaired.matchedCount++;
              repaired.modifiedCount++;
            }
          },
        });
      }
      if (!guarded.length) return result;
      const upsertedIds: Record<number, unknown> = { ...repaired.upsertedIds };
      for (const [index, id] of Object.entries(result?.upsertedIds ?? {})) {
        upsertedIds[bulkOps.indexOf(ordinary[Number(index)])] = id;
      }
      return {
        insertedCount: 0,
        deletedCount: 0,
        insertedIds: {},
        upsertedIds,
        matchedCount: (result?.matchedCount ?? 0) + repaired.matchedCount,
        modifiedCount: (result?.modifiedCount ?? 0) + repaired.modifiedCount,
        upsertedCount: (result?.upsertedCount ?? 0) + repaired.upsertedCount,
      };
    } catch (err) {
      logger.error('Error saving messages in bulk:', err);
      throw err;
    }
  }

  /**
   * Records a message in the database (no UUID validation).
   */
  async function recordMessage({
    user,
    endpoint,
    messageId,
    conversationId,
    parentMessageId,
    ...rest
  }: {
    user: string;
    endpoint?: string;
    messageId: string;
    conversationId?: string;
    parentMessageId?: string;
    [key: string]: unknown;
  }) {
    try {
      const provenance = capNormalizedProvenance(
        normalizeUserSubmittedPaths(rest.userSubmittedPaths),
        normalizeUserSubmittedMessageFieldPaths(rest.userSubmittedMessageFieldPaths),
      );
      const {
        userSubmittedPaths: _userSubmittedPaths,
        userSubmittedMessageFieldPaths: _userSubmittedMessageFieldPaths,
        ...safeRest
      } = rest;
      delete safeRest.privateText;
      delete safeRest.privacyRevision;
      delete safeRest.privateTextTokens;
      const message = {
        user,
        endpoint,
        messageId,
        conversationId,
        parentMessageId,
        ...safeRest,
        ...(provenance.userSubmittedPaths.length > 0 && {
          userSubmittedPaths: provenance.userSubmittedPaths,
        }),
        ...(provenance.userSubmittedMessageFieldPaths.length > 0 && {
          userSubmittedMessageFieldPaths: provenance.userSubmittedMessageFieldPaths,
        }),
        ...(provenance.promoteWholeMessage && { isUserSubmitted: true }),
      };
      return await writeMessage({ user, messageId }, message, {
        upsert: true,
        unsetPrivateText: Object.prototype.hasOwnProperty.call(safeRest, 'text'),
        stampModelOutputOnInsert:
          rest.isCreatedByUser === false && rest.isUserSubmitted === undefined,
      });
    } catch (err) {
      logger.error('Error recording message:', err);
      throw err;
    }
  }

  /**
   * Updates the text of a message.
   */
  async function updateMessageText(
    userId: string,
    { messageId, text }: { messageId: string; text: string },
  ) {
    try {
      await writeMessage(
        { messageId, user: userId },
        { text },
        { upsert: false, unsetPrivateText: true },
      );
    } catch (err) {
      logger.error('Error updating message text:', err);
      throw err;
    }
  }

  /**
   * Patches a persisted tool_call content part in place and appends attachments,
   * for results that settle after the turn's message was finalized (background
   * tool calls). Atomic single update so two tasks completing concurrently on
   * the same message cannot lose each other's attachments, and IDEMPOTENT
   * (attachments dedupe by `file_id ?? filepath`, scoped to this tool call so
   * sibling calls sharing a filename keep their own entries) so it can be
   * re-applied to heal a later full-row save that reverted the patch.
   *
   * Returns `matched: false` when the message row does not exist yet (the
   * dispatch turn has not finalized) and surfaces `unfinished` when the
   * matched row is a mid-turn partial save (client disconnect) — the eventual
   * finalize will overwrite the patch with in-memory content, so callers
   * should keep re-applying until a finalized row is patched.
   */
  async function updateToolCallResult(
    input: UpdateToolCallResultInput,
  ): Promise<{ matched: boolean; unfinished: boolean }> {
    const exact = await settleToolCallResult(input, input.stepId);
    if (exact.matched || input.stepId == null) {
      return exact;
    }
    /** A turn resumed after an approval pause persists the tool calls it made
     * before the pause without their step ids, so an exact step match can never
     * land and the settled result would be given up. On a finished row, fall back
     * to the one part with this call id (and agent scope) that has no stored step.
     * An unfinished row may not hold the real part yet, and more than one
     * candidate means a repeated provider id: both stay unmatched rather than
     * patching the wrong part. */
    const fallback = await getSteplessToolCallFallback(input);
    if (fallback == null) {
      return exact;
    }
    return settleToolCallResult(input, null, fallback);
  }

  async function getSteplessToolCallFallback({
    userId,
    messageId,
    conversationId,
    toolCallId,
    stepId,
    agentId,
  }: UpdateToolCallResultInput): Promise<SteplessToolCallFallback | undefined> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const row = await Message.findOne({ messageId, user: userId, conversationId })
      .select({ content: 1, unfinished: 1 })
      .lean<Pick<IMessage, 'content' | 'unfinished'> | null>();
    if (row == null || row.unfinished === true) {
      return;
    }
    let candidates = 0;
    let hasResultClaim = false;
    const content = row.content ?? [];
    for (const part of content) {
      const entry = part as {
        type?: unknown;
        agentId?: unknown;
        tool_call?: {
          id?: unknown;
          stepId?: unknown;
          agentId?: unknown;
          backgroundTask?: { resultClaim?: unknown };
        };
      } | null;
      if (entry?.type !== 'tool_call' || entry.tool_call?.id !== toolCallId) {
        continue;
      }
      const owner = entry.agentId ?? entry.tool_call.agentId;
      if (agentId != null && owner != null && owner !== agentId) {
        continue;
      }
      /** An unmatched write can mean attachment contention, not a missing
       * identity. Never substitute a sibling for an existing exact part. */
      if (entry.tool_call.stepId === stepId) {
        return;
      }
      if (entry.tool_call.stepId != null) {
        continue;
      }
      candidates += 1;
      if (candidates > 1) {
        return;
      }
      hasResultClaim = entry.tool_call.backgroundTask?.resultClaim != null;
    }
    return candidates === 1 ? { content, hasResultClaim } : undefined;
  }

  async function settleToolCallResult(
    {
      userId,
      messageId,
      conversationId,
      toolCallId,
      stepId,
      agentId,
      output,
      attachments,
      markBackgrounded,
      backgroundTask,
    }: UpdateToolCallResultInput,
    /** A step id to match exactly, `null` to match a part with no stored step,
     * or `undefined` to ignore steps. */
    stepMatch: string | null | undefined,
    fallback?: SteplessToolCallFallback,
    session?: ClientSession,
  ): Promise<{ matched: boolean; unfinished: boolean }> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const owner = { userId, tenantId: tenantStorage.getStore()?.tenantId };
    const identity = { messageId, conversationId, ...fileSourceScope(owner) };
    if (
      !session &&
      (await Message.exists({
        ...identity,
        $or: [
          { 'sourceFileIds.0': { $exists: true } },
          { quoteSourceRetention: { $exists: true } },
          { sourceContentRemovedAt: { $exists: true } },
        ],
      }))
    ) {
      const transaction = await mongoose.startSession();
      let result = { matched: false, unfinished: false };
      try {
        await transaction.withTransaction(
          async () => {
            const current = await Message.findOne(identity)
              .select(privateMessagePaths())
              .session(transaction)
              .lean<IMessage>();
            if (!current || current.sourceContentRemovedAt) throw new FileSourceUnavailableError();
            await touchFileSources(
              mongoose,
              owner,
              [
                ...(current.sourceFileIds ?? []),
                ...(current.quoteSourceRetention ?? []).flatMap((binding) => binding.sourceFileIds),
              ],
              transaction,
            );
            result = await settleToolCallResult(
              {
                userId,
                messageId,
                conversationId,
                toolCallId,
                stepId,
                agentId,
                output,
                attachments,
                markBackgrounded,
                backgroundTask,
              },
              stepMatch,
              fallback,
              transaction,
            );
            if (result.matched)
              await accountRetainedMessage(owner, current, current._id, transaction);
          },
          { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
        );
        return result;
      } finally {
        await transaction.endSession();
      }
    }
    /** One source of truth for which content part this settle may touch:
     * `prefix: ''` yields the `$elemMatch` document filter, `prefix: 'part.'`
     * the arrayFilters element filter — the same predicate in one dialect,
     * where the old code kept an aggregation `$expr` twin of it. `field: null`
     * matches both a missing field and a stored null, mirroring the previous
     * `$ifNull` chains. */
    const partScope = (prefix: string): Record<string, unknown> => ({
      [`${prefix}type`]: 'tool_call',
      [`${prefix}tool_call.id`]: toolCallId,
      ...(stepMatch !== undefined ? { [`${prefix}tool_call.stepId`]: stepMatch } : {}),
      ...(agentId != null ? agentOwnershipFilter(prefix, agentId) : {}),
    });
    const messageFilter = {
      messageId,
      user: userId,
      conversationId,
      ...(!session && NO_SOURCE_BODY),
      ...(fallback == null
        ? { content: { $elemMatch: partScope('') } }
        : { content: fallback.content, unfinished: { $ne: true } }),
    };
    const partIdentityFilter = partScope('part.');
    /** Amazon DocumentDB rejects aggregation-pipeline updates, so the part
     * patch addresses the matching tool-call parts with the filtered positional
     * operator and plain `$set`/`$unset`. Setting `backgroundTask` subfields
     * individually preserves an existing `resultClaim` without the per-part
     * branching the old pipeline needed, and clearing `completionWakeup` keeps
     * the old whole-object replacement's disarm semantics. */
    const partPatch: Record<string, string | number | boolean | Date> = {};
    let disarmWakeup = false;
    if (output !== undefined || backgroundTask != null) {
      if (output !== undefined) {
        partPatch['content.$[part].tool_call.output'] = output;
      }
      if (markBackgrounded === true) {
        partPatch['content.$[part].tool_call.backgrounded'] = true;
      }
      if (backgroundTask != null) {
        partPatch['content.$[part].tool_call.backgroundTask.version'] = 1;
        partPatch['content.$[part].tool_call.backgroundTask.taskId'] = backgroundTask.taskId;
        partPatch['content.$[part].tool_call.backgroundTask.toolName'] = backgroundTask.toolName;
        partPatch['content.$[part].tool_call.backgroundTask.status'] = backgroundTask.status;
        partPatch['content.$[part].tool_call.backgroundTask.cancelled'] =
          backgroundTask.cancelled === true;
        partPatch['content.$[part].tool_call.backgroundTask.settledAt'] = backgroundTask.settledAt;
        if (backgroundTask.completionReceipt === true) {
          partPatch['content.$[part].tool_call.backgroundTask.completionReceipt'] = true;
        }
        if (backgroundTask.completionWakeup === true) {
          partPatch['content.$[part].tool_call.backgroundTask.completionWakeup'] = true;
        } else {
          disarmWakeup = true;
        }
      }
    }
    const incomingAttachments = attachments ?? [];
    const mergingAttachments = incomingAttachments.length > 0;
    if (Object.keys(partPatch).length === 0 && !mergingAttachments) {
      return { matched: false, unfinished: false };
    }
    /** Fence the fallback on the content used to establish its unique identity.
     * A concurrent save or claim must invalidate the whole write, including any
     * supplied claim. The snapshot lets us preserve an existing claim and stamp
     * a missing one atomically with settlement, rather than before this fence. */
    const settlePatch = {
      ...partPatch,
      ...(fallback != null && !fallback.hasResultClaim && backgroundTask?.resultClaim != null
        ? { 'content.$[part].tool_call.backgroundTask.resultClaim': backgroundTask.resultClaim }
        : {}),
    };
    const settleUpdate = {
      $inc: { __v: 1 },
      ...(Object.keys(settlePatch).length > 0 ? { $set: settlePatch } : {}),
      ...(disarmWakeup
        ? { $unset: { 'content.$[part].tool_call.backgroundTask.completionWakeup': 1 } }
        : {}),
    };
    const settleOptions = {
      new: true,
      session,
      projection: { unfinished: 1 },
      ...(Object.keys(partPatch).length > 0 || disarmWakeup
        ? { arrayFilters: [partIdentityFilter] }
        : {}),
    };
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      /** A supplied claim is stamped BEFORE the settle write, on parts that
       * carry none (`resultClaim: null` also admits a stored null, as the old
       * `$ifNull` did). Ordering is what keeps the split safe: until the settle
       * write lands, the part is not terminal, so a concurrent wakeup or manual
       * poll sees `not_ready` and stands down; the old single pipeline wrote
       * claim and receipt atomically, and a claim-after-settle order would
       * instead expose a claimable terminal part that lets a second consumer
       * deliver the same result. A crash between the writes is healed by the
       * settle retry, whose claim write no-ops against its own stamp. */
      if (fallback == null && backgroundTask?.resultClaim != null) {
        await Message.updateOne(
          messageFilter,
          {
            $set: {
              'content.$[part].tool_call.backgroundTask.resultClaim': backgroundTask.resultClaim,
            },
          },
          {
            session,
            arrayFilters: [
              { ...partIdentityFilter, 'part.tool_call.backgroundTask.resultClaim': null },
            ],
          },
        );
      }
      if (!mergingAttachments) {
        const fast = await Message.findOneAndUpdate(
          { ...messageFilter, ...NO_BOUND_APPS },
          settleUpdate,
          settleOptions,
        ).lean<{ unfinished?: boolean } | null>();
        if (fast) return { matched: true, unfinished: fast.unfinished === true };
        // Either absent, or a bound-App row needs an exact candidate even for tiny results.
      }
      /** Dedupe key mirrors the resume merge: `file_id ?? filepath`, so
       * download-fallback attachments (no `file_id`, only a filepath) stay
       * idempotent across re-applications instead of duplicating per poll.
       * Replace only THIS tool call's prior entries: sibling calls can
       * legitimately share a `file_id` (the filename claim is per-conversation),
       * and the client anchors attachments to cards by `toolCallId`. Provider
       * tool-call ids repeat across agents in handoff messages, so a sibling
       * agent's attachment under the same id/key must survive (missing agent
       * identity = legacy wildcard). */
      const attachmentKeys = new Set(
        incomingAttachments
          .map((attachment) => {
            const { file_id, filepath } = attachment as { file_id?: unknown; filepath?: unknown };
            return typeof file_id === 'string' ? file_id : filepath;
          })
          .filter((key): key is string => typeof key === 'string'),
      );
      const replacesEntry = (existing: unknown): boolean => {
        if (existing == null || typeof existing !== 'object') return false;
        const entry = existing as {
          file_id?: unknown;
          filepath?: unknown;
          toolCallId?: unknown;
          agentId?: unknown;
          stepId?: unknown;
        };
        const key = entry.file_id ?? entry.filepath;
        if (typeof key !== 'string' || !attachmentKeys.has(key)) return false;
        if (entry.toolCallId !== toolCallId) return false;
        const entryAgent = entry.agentId ?? null;
        if (agentId != null && entryAgent !== null && entryAgent !== agentId) return false;
        const entryStep = entry.stepId ?? null;
        if (stepId != null && entryStep !== null && entryStep !== stepId) return false;
        return true;
      };
      /** Classic `$pull` and `$push` conflict on the same field. Keep merge and
       * part patch in one update; ordinary attachments retain the preexisting
       * array compare-and-swap. For bound Apps, a large array in BOTH the filter
       * and update exceeds MongoDB's 16 MiB command limit even when the resulting
       * document fits. Use the small `__v` fence instead: every save with
       * attachments and every background settle increments it. A lost fence is
       * re-read and re-budgeted before retrying the combined write. */
      const incomingApp = hasBoundAppSnapshots(incomingAttachments);
      for (let attempt = 0; attempt < ATTACHMENT_MERGE_CAS_ATTEMPTS; attempt += 1) {
        const row = await Message.findOne(messageFilter)
          .session(session ?? null)
          .select(incomingApp ? privateMessagePaths() : { _id: 1, attachments: 1, __v: 1 })
          .lean<
            | (Record<string, unknown> & {
                _id: Types.ObjectId;
                attachments?: unknown[];
                __v?: number;
              })
            | null
          >();
        if (row == null) {
          return { matched: false, unfinished: false };
        }
        const hasApps = incomingApp || hasBoundAppSnapshots(row.attachments);
        /** Avoid materializing the whole message for ordinary file attachments. */
        const current =
          hasApps && !incomingApp
            ? await Message.findOne({
                ...messageFilter,
                _id: row._id,
                __v: row.__v ?? null,
              })
                .session(session ?? null)
                .select(privateMessagePaths())
                .lean<
                  | (Record<string, unknown> & { _id: Types.ObjectId; attachments?: unknown[] })
                  | null
                >()
            : row;
        if (current == null) continue;
        const prior = Array.isArray(current.attachments) ? current.attachments : [];
        const merged = [...prior.filter((entry) => !replacesEntry(entry)), ...incomingAttachments];
        let admitted = merged;
        if (hasApps) {
          const content = Array.isArray(current.content) ? current.content : [];
          const nextContent = content.map((entry) => {
            if (entry == null || typeof entry !== 'object') return entry;
            const part = entry as {
              type?: unknown;
              agentId?: unknown;
              tool_call?: {
                id?: unknown;
                stepId?: unknown;
                agentId?: unknown;
                backgroundTask?: Record<string, unknown>;
              };
            };
            // Exactly the agentOwnershipFilter precedence: part agent, then call agent, then wildcard.
            const owner = part.agentId ?? part.tool_call?.agentId;
            if (
              part.type !== 'tool_call' ||
              part.tool_call?.id !== toolCallId ||
              (stepId != null && part.tool_call.stepId !== stepId) ||
              (agentId != null && owner != null && owner !== agentId)
            )
              return entry;
            const task = { ...part.tool_call.backgroundTask };
            if (backgroundTask) {
              Object.assign(task, {
                version: 1,
                taskId: backgroundTask.taskId,
                toolName: backgroundTask.toolName,
                status: backgroundTask.status,
                cancelled: backgroundTask.cancelled === true,
                settledAt: backgroundTask.settledAt,
              });
              if (backgroundTask.completionReceipt) task.completionReceipt = true;
              if (backgroundTask.completionWakeup) task.completionWakeup = true;
              else delete task.completionWakeup;
            }
            return {
              ...part,
              tool_call: {
                ...part.tool_call,
                ...(output !== undefined && { output }),
                ...((output !== undefined || backgroundTask != null) &&
                  markBackgrounded && { backgrounded: true }),
                ...(backgroundTask && { backgroundTask: task }),
              },
            };
          });
          admitted = (
            await prepareAppUpdate({ attachments: merged, content: nextContent }, current)
          ).attachments as unknown[];
        }
        const result = await Message.findOneAndUpdate(
          {
            ...messageFilter,
            _id: current._id,
            ...(hasApps
              ? { __v: current.__v ?? null }
              : { attachments: current.attachments == null ? null : current.attachments }),
          },
          {
            ...settleUpdate,
            $set: { ...settlePatch, attachments: admitted },
          },
          settleOptions,
        ).lean<{ unfinished?: boolean } | null>();
        if (result != null) {
          return { matched: true, unfinished: result.unfinished === true };
        }
      }
      /** Losing every fence round means concurrent writers kept advancing the
       * array — the document exists and is healthy, so persistence must stay
       * retryable ABOVE this bounded loop. The settle retry treats an
       * unmatched result as retry-then-heal-later; a throw would land on
       * ambiguous-failure handling that can retire the completion outright,
       * losing a completed tool result to mere attachment contention. */
      logger.warn(
        `[updateToolCallResult] Attachment merge for tool call ${toolCallId} lost ` +
          `${ATTACHMENT_MERGE_CAS_ATTEMPTS} fence rounds; leaving the retry to the caller`,
      );
      return { matched: false, unfinished: false };
    } catch (err) {
      logger.error('Error updating tool call result:', err);
      throw err;
    }
  }

  const MAX_BACKGROUND_TOOL_RESULT_BATCH = 16;
  /** Bounds the attachments-merge fence retries. Each lost round means a
   * concurrent writer changed the array, so re-reading converges. */
  const ATTACHMENT_MERGE_CAS_ATTEMPTS = 8;

  function readBackgroundToolResultClaim(
    row: Pick<IMessage, 'content'>,
    taskId: string,
  ):
    | {
        kind: 'manual' | 'wakeup';
        claimId: string;
        generationId?: string;
        batchId?: string;
        receiptReconciled?: true;
      }
    | undefined {
    for (const part of row.content ?? []) {
      if (part == null || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const backgroundTask = (
        part as {
          tool_call?: {
            backgroundTask?: {
              taskId?: unknown;
              resultClaim?: {
                kind?: unknown;
                claimId?: unknown;
                generationId?: unknown;
                batchId?: unknown;
                receiptReconciled?: unknown;
              };
            };
          };
        }
      ).tool_call?.backgroundTask;
      if (backgroundTask?.taskId !== taskId) {
        continue;
      }
      const claim = backgroundTask.resultClaim;
      if (
        (claim?.kind === 'manual' || claim?.kind === 'wakeup') &&
        typeof claim.claimId === 'string' &&
        claim.claimId.length > 0
      ) {
        return {
          kind: claim.kind,
          claimId: claim.claimId,
          ...(typeof claim.batchId === 'string' && { batchId: claim.batchId }),
          ...(claim.receiptReconciled === true && { receiptReconciled: true }),
          ...(typeof claim.generationId === 'string' && claim.generationId.length > 0
            ? { generationId: claim.generationId }
            : {}),
        };
      }
      return;
    }
  }

  function parseBackgroundToolResults(
    message: IMessage,
    claim: { kind: 'manual' | 'wakeup'; claimId: string; batchId?: string },
  ): BackgroundToolResultRecord[] {
    const results: BackgroundToolResultRecord[] = [];
    for (const part of message.content ?? []) {
      if (part == null || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const record = part as {
        agentId?: unknown;
        tool_call?: {
          id?: unknown;
          agentId?: unknown;
          output?: unknown;
          backgroundTask?: {
            taskId?: unknown;
            toolName?: unknown;
            status?: unknown;
            cancelled?: unknown;
            settledAt?: unknown;
            resultClaim?: { kind?: unknown; claimId?: unknown; batchId?: unknown };
          };
        };
      };
      const toolCall = record.tool_call;
      const task = toolCall?.backgroundTask;
      if (
        typeof toolCall?.id !== 'string' ||
        typeof task?.taskId !== 'string' ||
        typeof task.toolName !== 'string' ||
        (task.status !== 'completed' && task.status !== 'error') ||
        task.resultClaim?.kind !== claim.kind ||
        task.resultClaim.claimId !== claim.claimId ||
        task.resultClaim.batchId !== claim.batchId
      ) {
        continue;
      }
      let resultAgentId: string | undefined;
      if (typeof record.agentId === 'string') {
        resultAgentId = record.agentId;
      } else if (typeof toolCall.agentId === 'string') {
        resultAgentId = toolCall.agentId;
      }
      const settledAt = toSettledAt(task.settledAt);
      results.push({
        taskId: task.taskId,
        toolCallId: toolCall.id,
        toolName: task.toolName,
        status: task.cancelled === true ? 'cancelled' : task.status,
        output: typeof toolCall.output === 'string' ? toolCall.output : '',
        ...(resultAgentId == null ? {} : { agentId: resultAgentId }),
        ...(settledAt == null ? {} : { settledAt }),
      });
    }
    return results;
  }

  function readBackgroundToolHandle(
    message: IMessage,
    taskId: string,
    agentId?: string,
  ): string | undefined {
    for (const part of message.content ?? []) {
      if (part == null || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const record = part as {
        agentId?: unknown;
        tool_call?: { agentId?: unknown; output?: unknown };
      };
      const partAgentId = record.agentId ?? record.tool_call?.agentId;
      const sameAgent =
        agentId == null ||
        partAgentId == null ||
        (typeof partAgentId === 'string' && partAgentId === agentId);
      const output = record.tool_call?.output;
      if (!sameAgent || typeof output !== 'string' || !output.includes(taskId)) {
        continue;
      }
      try {
        const handle = JSON.parse(output) as {
          background_task_id?: unknown;
          subagent_type?: unknown;
          tool?: unknown;
          status?: unknown;
        };
        if (
          handle.background_task_id === taskId &&
          handle.status === 'running' &&
          typeof handle.subagent_type !== 'string' &&
          typeof handle.tool === 'string' &&
          handle.tool.length > 0
        ) {
          return handle.tool;
        }
      } catch {
        continue;
      }
    }
    return;
  }

  /** Atomically elects manual polling or one automatic continuation. Wakeups
   * also claim a bounded set of already-settled siblings from the same parent
   * response, avoiding one paid continuation per concurrently completed tool. */
  async function claimBackgroundToolResults({
    userId,
    conversationId,
    messageId,
    taskId,
    agentId,
    kind,
    claimId,
    generationId,
    batchId,
    allowUnfinished = false,
    limit = kind === 'wakeup' ? 8 : 1,
    maxMetadataChars,
  }: Parameters<
    MessageMethods['claimBackgroundToolResults']
  >[0]): Promise<BackgroundToolResultClaim> {
    const requestedMessageId = messageId?.trim();
    const requestedGenerationId = generationId?.trim();
    if (
      (requestedMessageId != null &&
        (requestedMessageId.length === 0 || requestedMessageId.length > 256)) ||
      (batchId != null && (batchId.length === 0 || batchId.length > 128 || kind !== 'wakeup')) ||
      taskId.length === 0 ||
      taskId.length > 256 ||
      claimId.length === 0 ||
      claimId.length > 128 ||
      (requestedGenerationId != null &&
        (requestedGenerationId.length === 0 || requestedGenerationId.length > 256)) ||
      (requestedGenerationId != null && kind !== 'manual') ||
      (allowUnfinished && kind !== 'manual') ||
      (kind !== 'manual' && kind !== 'wakeup') ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      (maxMetadataChars != null &&
        (!Number.isSafeInteger(maxMetadataChars) || maxMetadataChars < 1))
    ) {
      throw new TypeError('Invalid background tool result claim');
    }
    const boundedLimit = Math.max(1, Math.min(MAX_BACKGROUND_TOOL_RESULT_BATCH, limit));
    const Message = mongoose.models.Message as Model<IMessage>;
    const row = await Message.findOne({
      user: userId,
      conversationId,
      ...(requestedMessageId != null
        ? { messageId: requestedMessageId }
        : {
            content: {
              $elemMatch: { 'tool_call.backgroundTask.taskId': taskId },
            },
          }),
    })
      .select({ content: 1, unfinished: 1, messageId: 1 })
      .sort({ createdAt: -1, _id: -1 })
      .lean<IMessage | null>();
    if (row == null) {
      if (requestedMessageId == null) {
        const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const handleRow = await Message.findOne({
          user: userId,
          conversationId,
          content: {
            $elemMatch: {
              type: 'tool_call',
              'tool_call.output': new RegExp(`"background_task_id"\\s*:\\s*"${escapedTaskId}"`),
              ...(agentId == null ? {} : agentOwnershipFilter('', agentId)),
            },
          },
        })
          .select({ content: 1 })
          .sort({ createdAt: -1, _id: -1 })
          .lean<IMessage | null>();
        const toolName =
          handleRow == null ? undefined : readBackgroundToolHandle(handleRow, taskId, agentId);
        if (toolName != null) {
          return { status: 'outcome_unknown', toolName };
        }
      }
      return { status: 'not_found' };
    }
    /** Only an owner-process manual poll that already retired automatic
     * delivery may consume a terminal receipt on an unfinished response.
     * Every other claimant waits for finalization, preventing a poll from
     * racing the automatic continuation while the parent generation runs. */
    if (row.unfinished === true && !(kind === 'manual' && allowUnfinished)) {
      return { status: 'not_ready' };
    }
    const resolvedMessageId = row.messageId;
    if (typeof resolvedMessageId !== 'string' || resolvedMessageId.length === 0) {
      return { status: 'not_found' };
    }
    const recoveredSource = requestedMessageId == null ? { messageId: resolvedMessageId } : {};
    const requestedClaim = readBackgroundToolResultClaim(row, taskId);
    const replaying =
      requestedClaim?.kind === kind &&
      requestedClaim.claimId === claimId &&
      requestedClaim.batchId === batchId;
    const candidates: string[] = [];
    const costs = new Map<string, number>();
    let receiptBacked = false;
    let requestedState: 'ready' | 'claimed' | 'missing' = 'missing';
    for (const part of row.content ?? []) {
      if (part == null || typeof part !== 'object' || Array.isArray(part)) {
        continue;
      }
      const task = (part as { tool_call?: { backgroundTask?: Record<string, unknown> } }).tool_call
        ?.backgroundTask;
      const partRecord = part as { agentId?: unknown; tool_call?: { agentId?: unknown } };
      const partAgentId = partRecord.agentId ?? partRecord.tool_call?.agentId;
      const candidateId = task?.taskId;
      if (typeof candidateId !== 'string') {
        continue;
      }
      const terminal = task?.status === 'completed' || task?.status === 'error';
      const wakeupEligible = kind !== 'wakeup' || task?.completionWakeup === true;
      const resultClaim = task?.resultClaim as
        | { kind?: unknown; claimId?: unknown; batchId?: unknown }
        | undefined;
      const replay =
        resultClaim?.kind === kind &&
        resultClaim.claimId === claimId &&
        resultClaim.batchId === batchId;
      const sameAgent =
        agentId == null ||
        partAgentId == null ||
        (typeof partAgentId === 'string' && partAgentId === agentId);
      /** A lost-receipt retry replays exactly its original assignment. It must
       * not absorb siblings that completed after the already-admitted input
       * was constructed, or those results would be claimed but never shown. */
      const claimable =
        terminal && wakeupEligible && sameAgent && (replaying ? replay : resultClaim == null);
      if (candidateId === taskId) {
        receiptBacked = task?.completionReceipt === true;
        if (claimable) {
          requestedState = 'ready';
        } else if (resultClaim != null) {
          requestedState = 'claimed';
        }
      }
      if (
        claimable &&
        (candidateId === taskId || task?.completionReceipt !== true) &&
        (candidateId === taskId || kind === 'wakeup') &&
        candidates.length < boundedLimit
      ) {
        candidates.push(candidateId);
      }
      if (claimable && (candidateId === taskId || candidates.includes(candidateId))) {
        const call = (part as { tool_call?: { id?: string } }).tool_call;
        if (typeof call?.id === 'string' && typeof task?.toolName === 'string') {
          const terminalStatus = task.status === 'error' ? 'error' : 'completed';
          costs.set(
            candidateId,
            JSON.stringify(
              backgroundResultMetadata({
                taskId: candidateId,
                toolCallId: call.id,
                toolName: task.toolName,
                status: task.cancelled === true ? 'cancelled' : terminalStatus,
              }),
            ).length + 1,
          );
        }
      }
    }
    if (requestedState === 'missing') {
      return { status: 'not_ready' };
    }
    if (requestedState === 'claimed') {
      return {
        status: 'claimed',
        ...(requestedClaim == null ? {} : { claim: requestedClaim }),
        ...recoveredSource,
      };
    }
    if (!candidates.includes(taskId)) {
      candidates.unshift(taskId);
      candidates.splice(boundedLimit);
    }
    if (!replaying) {
      /** A receipt lives on another document, so it cannot join this atomic
       * message-row batch. Keep its delivery task-local in both directions. */
      if (receiptBacked) candidates.splice(0, candidates.length, taskId);
      if (maxMetadataChars != null) {
        let remaining = maxMetadataChars - 1 - (costs.get(taskId) ?? maxMetadataChars);
        if (remaining < 0)
          throw new TypeError('Background result metadata exceeds its input budget');
        const admitted = candidates.filter((id) => {
          if (id === taskId) return true;
          const cost = costs.get(id) ?? maxMetadataChars;
          if (cost > remaining) return false;
          remaining -= cost;
          return true;
        });
        candidates.splice(0, candidates.length, ...admitted);
      }
    }
    const claimedAt = new Date();
    const claimStamp = {
      kind,
      claimId,
      claimedAt,
      ...(batchId != null && { batchId }),
      ...(kind === 'manual' && requestedGenerationId != null
        ? { generationId: requestedGenerationId }
        : {}),
    };
    const claimFilter: FilterQuery<IMessage> = {
      user: userId,
      conversationId,
      messageId: resolvedMessageId,
      ...(kind === 'manual' && allowUnfinished ? {} : { unfinished: { $ne: true } }),
      content: {
        $elemMatch: {
          type: 'tool_call',
          'tool_call.backgroundTask.taskId': taskId,
          'tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
          ...(kind === 'wakeup' ? { 'tool_call.backgroundTask.completionWakeup': true } : {}),
          ...(replaying
            ? {
                'tool_call.backgroundTask.resultClaim.kind': kind,
                'tool_call.backgroundTask.resultClaim.claimId': claimId,
                'tool_call.backgroundTask.resultClaim.batchId': batchId ?? null,
              }
            : /** Missing OR stored null: the in-memory claimable scan, the
               * claim arrayFilters, and the settle stamp all treat a null
               * claim as unclaimed, and the subfield-preserving settle write
               * keeps a persisted null a whole-object rewrite used to drop.
               * `$exists: false` here would strand such a part as terminal
               * but permanently unclaimable. */
              { 'tool_call.backgroundTask.resultClaim': null }),
        },
      },
      ...(agentId != null
        ? {
            $expr: {
              $anyElementTrue: {
                $map: {
                  input: { $ifNull: ['$content', []] },
                  as: 'candidate',
                  in: {
                    $and: [
                      { $eq: ['$$candidate.tool_call.backgroundTask.taskId', taskId] },
                      {
                        $in: [
                          {
                            $ifNull: [
                              {
                                $ifNull: ['$$candidate.agentId', '$$candidate.tool_call.agentId'],
                              },
                              null,
                            ],
                          },
                          [null, agentId],
                        ],
                      },
                    ],
                  },
                },
              },
            },
          }
        : {}),
    };
    const updated = replaying
      ? await Message.findOne(claimFilter).select({ content: 1 }).lean<IMessage | null>()
      : await Message.findOneAndUpdate(
          claimFilter,
          /** Stamps the claim onto every part this pass admitted. The filtered
           * positional operator selects those parts by predicate, so the write
           * touches only them instead of re-emitting the whole content array, and
           * needs no read-modify-write. Amazon DocumentDB rejects the
           * aggregation-pipeline form this replaces. */
          { $set: { 'content.$[part].tool_call.backgroundTask.resultClaim': claimStamp } },
          {
            new: true,
            projection: { content: 1 },
            arrayFilters: [
              {
                'part.type': 'tool_call',
                'part.tool_call.backgroundTask.taskId': { $in: candidates },
                'part.tool_call.backgroundTask.status': { $in: ['completed', 'error'] },
                ...(kind === 'wakeup'
                  ? { 'part.tool_call.backgroundTask.completionWakeup': true }
                  : {}),
                $and: [
                  {
                    'part.tool_call.backgroundTask.resultClaim': null,
                  },
                  ...(agentId == null ? [] : [agentOwnershipFilter('part.', agentId)]),
                ],
              },
            ],
          },
        ).lean<IMessage | null>();
    if (updated == null) {
      return { status: 'not_ready' };
    }
    const results = parseBackgroundToolResults(updated, { kind, claimId, batchId });
    const competingClaim = readBackgroundToolResultClaim(updated, taskId);
    return results.some((result) => result.taskId === taskId)
      ? { status: 'acquired', results, ...recoveredSource }
      : {
          status: 'claimed',
          ...(competingClaim == null ? {} : { claim: competingClaim }),
          ...recoveredSource,
        };
  }

  /** Manual ownership is committed only after receipt arbitration completes. */
  async function confirmBackgroundToolResultClaim(
    input: Parameters<MessageMethods['confirmBackgroundToolResultClaim']>[0],
  ): Promise<boolean> {
    const Message = mongoose.models.Message as Model<IMessage>;
    const identity = {
      'tool_call.backgroundTask.taskId': input.taskId,
      'tool_call.backgroundTask.resultClaim.kind': 'manual',
      'tool_call.backgroundTask.resultClaim.claimId': input.claimId,
    };
    try {
      const confirmed = await Message.updateOne(
        {
          user: input.userId,
          conversationId: input.conversationId,
          messageId: input.messageId,
          content: { $elemMatch: identity },
        },
        {
          $set: { 'content.$[part].tool_call.backgroundTask.resultClaim.receiptReconciled': true },
        },
        {
          arrayFilters: [
            {
              'part.tool_call.backgroundTask.taskId': input.taskId,
              'part.tool_call.backgroundTask.resultClaim.kind': 'manual',
              'part.tool_call.backgroundTask.resultClaim.claimId': input.claimId,
            },
          ],
        },
      );
      return confirmed.matchedCount === 1;
    } catch (error) {
      // A lost write reply is not an uncommitted handoff. Read only the exact
      // manual claim, never manufacture success from another claimant.
      const committed = await Message.exists({
        user: input.userId,
        conversationId: input.conversationId,
        messageId: input.messageId,
        content: {
          $elemMatch: {
            ...identity,
            'tool_call.backgroundTask.resultClaim.receiptReconciled': true,
          },
        },
      });
      if (committed != null) return true;
      throw error;
    }
  }

  async function releaseBackgroundToolResultClaims({
    userId,
    conversationId,
    messageId,
    taskIds,
    allowMissingMessage,
    onlyIfUnreconciled,
    kind,
    claimId,
    batchId,
  }: {
    userId: string;
    conversationId: string;
    messageId: string;
    taskIds?: string[];
    /** Receipt-backed results can precede the message projection. */
    allowMissingMessage?: true;
    /** Manual rollback must not erase a committed receipt handoff. */
    onlyIfUnreconciled?: true;
    batchId?: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean> {
    if (onlyIfUnreconciled === true && kind !== 'manual')
      throw new TypeError('Unreconciled rollback requires a manual claim');
    if (taskIds?.length === 0) {
      return true;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    /** Drops the claim stamp from every content part this claimant owns. The
     * filtered positional operator addresses those parts by predicate in one
     * atomic write, so no read-modify-write and no rewrite of untouched parts;
     * Amazon DocumentDB rejects the aggregation-pipeline form this replaces.
     * The filter requires a `content` array because the filtered positional
     * operator errors on a row without one, where the old pipeline's
     * `$ifNull` no-op'd — a legacy row with no array simply has no claims. */
    const updated = await Message.findOneAndUpdate(
      { user: userId, conversationId, messageId, content: { $type: 'array' } },
      { $unset: { 'content.$[part].tool_call.backgroundTask.resultClaim': 1 } },
      {
        new: true,
        projection: { content: 1 },
        arrayFilters: [
          {
            'part.tool_call.backgroundTask.resultClaim.kind': kind,
            'part.tool_call.backgroundTask.resultClaim.claimId': claimId,
            'part.tool_call.backgroundTask.resultClaim.batchId': batchId ?? null,
            ...(onlyIfUnreconciled === true && {
              'part.tool_call.backgroundTask.resultClaim.receiptReconciled': { $ne: true },
            }),
            ...(taskIds == null
              ? {}
              : { 'part.tool_call.backgroundTask.taskId': { $in: taskIds } }),
          },
        ],
      },
    ).lean<IMessage | null>();
    if (updated == null) {
      const arraylessRow = await Message.exists({
        user: userId,
        conversationId,
        messageId,
        content: { $not: { $type: 'array' } },
      });
      if (arraylessRow != null) return true;
      return (
        allowMissingMessage === true &&
        (await Message.exists({ user: userId, conversationId, messageId })) == null
      );
    }
    const remaining = parseBackgroundToolResults(updated, { kind, claimId, batchId });
    return taskIds == null
      ? remaining.length === 0
      : !remaining.some((result) => taskIds.includes(result.taskId));
  }

  /**
   * Updates a message and returns sanitized fields.
   */
  async function updateMessage(
    userId: string,
    message: { messageId: string; [key: string]: unknown },
    metadata?: { context?: string },
  ) {
    try {
      const { messageId, ...update } = message;
      delete update.privateText;
      delete update.privacyRevision;
      delete update.privateTextTokens;
      const updatedMessage = await writeMessage({ messageId, user: userId }, update, {
        upsert: false,
        unsetPrivateText: Object.prototype.hasOwnProperty.call(update, 'text'),
      });

      if (!updatedMessage) {
        throw new Error('Message not found or user not authorized.');
      }

      return {
        messageId: updatedMessage.messageId,
        conversationId: updatedMessage.conversationId,
        parentMessageId: updatedMessage.parentMessageId,
        sender: updatedMessage.sender,
        text: updatedMessage.text,
        isCreatedByUser: updatedMessage.isCreatedByUser,
        isUserSubmitted: updatedMessage.isUserSubmitted,
        userSubmittedPaths: updatedMessage.userSubmittedPaths,
        userSubmittedMessageFieldPaths: updatedMessage.userSubmittedMessageFieldPaths,
        tokenCount: updatedMessage.tokenCount,
        feedback: updatedMessage.feedback,
        endpoint: updatedMessage.endpoint,
        langfuseSampled: updatedMessage.langfuseSampled,
        langfuseDestinationIds: updatedMessage.langfuseDestinationIds,
        langfuseRunId: updatedMessage.langfuseRunId,
      };
    } catch (err) {
      logger.error('Error updating message:', err);
      if (metadata?.context) {
        logger.info(`---\`updateMessage\` context: ${metadata.context}`);
      }
      throw err;
    }
  }

  /**
   * Atomically records one bounded parent-to-child control receipt on the
   * durable task input. Terminal receipt states are monotonic, and accepted
   * receipts are retained ahead of older terminal history when the bound fills.
   */
  async function recordSubagentTaskControlReceipt({
    userId,
    conversationId,
    taskId,
    tenantId,
    receipt,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    tenantId?: string;
    receipt: NonNullable<NonNullable<IMessage['subagentTask']>['controlReceipts']>[number];
  }): Promise<boolean | 'unchanged' | 'conflict'> {
    const validActions = new Set(['steer', 'queue', 'interrupt', 'cancel', 'cancel_message']);
    const validStatuses = new Set(['reserved', 'accepted', 'applied', 'rejected', 'failed']);
    if (
      userId.length === 0 ||
      conversationId.length === 0 ||
      conversationId.length > 256 ||
      taskId.length === 0 ||
      taskId.length > 256 ||
      receipt.invocationId.length === 0 ||
      receipt.invocationId.length > 128 ||
      receipt.fingerprint.length === 0 ||
      receipt.fingerprint.length > 128 ||
      !validActions.has(receipt.action) ||
      !validStatuses.has(receipt.status) ||
      (receipt.controlId != null && receipt.controlId.length > 256) ||
      (receipt.message != null && receipt.message.length > MAX_SUBAGENT_CONTROL_MESSAGE_LENGTH) ||
      !Number.isFinite(receipt.createdAt.getTime()) ||
      !Number.isFinite(receipt.updatedAt.getTime())
    ) {
      throw new TypeError('Invalid subagent task control receipt');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const recordsTerminalRejection =
      receipt.status === 'rejected' && receipt.reason === 'task_not_running';
    const identity = {
      user: userId,
      conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:user`,
      /** A genuinely new command can arrive after its task settles or its final
       * lease expires. Persist that authoritative rejection for retries; every
       * command that could still be applied remains fenced to a running task. */
      ...(recordsTerminalRejection
        ? { 'subagentTask.status': { $in: ['running', 'completed', 'error', 'cancelled'] } }
        : { 'subagentTask.status': 'running' }),
    };
    /** Amazon DocumentDB does not support aggregation-pipeline updates. Use a
     * bounded optimistic compare-and-swap: the read is small, the write uses
     * only plain operators, and concurrent writers retry rather than overwrite. */
    for (let attempt = 0; attempt < MAX_SUBAGENT_CONTROL_RECEIPT_CAS_ATTEMPTS; attempt += 1) {
      const currentMessage = await Message.findOne(identity)
        .select({ 'subagentTask.controlReceipts': 1, _id: 0 })
        .lean<Pick<IMessage, 'subagentTask'> | null>();
      if (currentMessage == null) return false;
      const current = currentMessage.subagentTask?.controlReceipts ?? [];
      const retained = retainSubagentControlReceipts(current, receipt);
      if (retained.status === 'conflict') return 'conflict';
      if (retained.status === 'unchanged') return 'unchanged';
      if (retained.status === 'capacity') return false;
      const next = retained.receipts;
      const currentFilter =
        currentMessage.subagentTask?.controlReceipts == null
          ? { 'subagentTask.controlReceipts': { $exists: false } }
          : { 'subagentTask.controlReceipts': current };
      const updated = await Message.findOneAndUpdate(
        { ...identity, ...currentFilter },
        { $set: { 'subagentTask.controlReceipts': next } },
        { new: false, projection: { messageId: 1 } },
      ).lean<{ messageId: string } | null>();
      if (updated != null) return true;
    }
    throw new Error('Subagent control receipt write contention exceeded its retry bound.');
  }

  /** Reads one bounded authoritative receipt by its exact durable task identity.
   * The stored projection is already capped, and no task/runtime metadata leaves
   * this method. Authorization remains part of the Mongo identity. */
  async function getSubagentTaskControlReceipt({
    userId,
    conversationId,
    taskId,
    invocationId,
    tenantId,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<StoredSubagentControlReceipt | null> {
    if (
      userId.length === 0 ||
      conversationId.length === 0 ||
      conversationId.length > 256 ||
      taskId.length === 0 ||
      taskId.length > 256 ||
      invocationId.length === 0 ||
      invocationId.length > 128
    ) {
      throw new TypeError('Invalid subagent task control receipt identity');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const input = await Message.findOne({
      user: userId,
      conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:user`,
      'subagentTask.controlReceipts.invocationId': invocationId,
    })
      .select({ 'subagentTask.controlReceipts': 1, _id: 0 })
      .lean<Pick<IMessage, 'subagentTask'> | null>();
    const receipt = input?.subagentTask?.controlReceipts?.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    /** Reservations are a server-private at-most-once fence, not proof that a
     * control was applied. Public HTTP callers retry through the owning store. */
    return receipt?.status === 'reserved' ? null : (receipt ?? null);
  }

  /** Resolves one authoritative receipt after its live owner disappears. The
   * child conversation must still belong to the caller's parent thread, so a
   * task id learned in another chat cannot cross orchestration scopes. */
  async function getSubagentTaskControlReplay({
    userId,
    parentConversationId,
    taskId,
    invocationId,
    tenantId,
  }: {
    userId: string;
    parentConversationId: string;
    taskId: string;
    invocationId: string;
    tenantId?: string;
  }): Promise<{
    receipt: StoredSubagentControlReceipt;
    task: {
      taskId: string;
      threadId: string;
      subagentType: string;
      status: 'running' | 'completed' | 'error' | 'cancelled';
      resultAvailable: boolean;
      resultClaimed: boolean;
      pendingControls: number;
      createdAt: Date;
      updatedAt: Date;
    };
  } | null> {
    if (
      userId.length === 0 ||
      parentConversationId.length === 0 ||
      parentConversationId.length > 256 ||
      taskId.length === 0 ||
      taskId.length > 256 ||
      invocationId.length === 0 ||
      invocationId.length > 128
    ) {
      throw new TypeError('Invalid subagent task control replay identity');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const input = await Message.findOne({
      user: userId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:user`,
      'subagentTask.controlReceipts.invocationId': invocationId,
    })
      .select({
        conversationId: 1,
        createdAt: 1,
        updatedAt: 1,
        'subagentTask.status': 1,
        'subagentTask.controlReceipts': 1,
        _id: 0,
      })
      .lean<Pick<IMessage, 'conversationId' | 'createdAt' | 'updatedAt' | 'subagentTask'> | null>();
    const receipt = input?.subagentTask?.controlReceipts?.find(
      (candidate) => candidate.invocationId === invocationId,
    );
    const status = input?.subagentTask?.status;
    if (
      input == null ||
      receipt == null ||
      status == null ||
      input.createdAt == null ||
      input.updatedAt == null
    ) {
      return null;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const conversationQuery = Conversation.findOne({
      user: userId,
      conversationId: input.conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      'subagentThread.parentConversationId': parentConversationId,
      ...activeExpirationFilter<IConversation>(),
    })
      .select({ 'subagentThread.subagentType': 1, _id: 0 })
      .lean<Pick<IConversation, 'subagentThread'> | null>();
    const terminalQuery = Message.findOne({
      user: userId,
      conversationId: input.conversationId,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
      messageId: `${taskId}:assistant`,
      'subagentTask.status': { $in: ['completed', 'error', 'cancelled'] },
    })
      .select({ updatedAt: 1, 'subagentTask.status': 1, 'subagentTask.resultClaim': 1, _id: 0 })
      .lean<Pick<IMessage, 'updatedAt' | 'subagentTask'> | null>();
    const [conversation, terminal] = await Promise.all([conversationQuery, terminalQuery]);
    const subagentType = conversation?.subagentThread?.subagentType;
    if (subagentType == null || subagentType === '') return null;
    /** A committed cancel receipt is itself the authoritative cancellation
     * boundary. The terminal row is written asynchronously and may not exist if
     * the owner exits between those two durable commits. */
    const replayStatus =
      terminal?.subagentTask?.status ??
      (receipt.action === 'cancel' && receipt.status === 'applied' ? 'cancelled' : status);
    return {
      receipt,
      task: {
        taskId,
        threadId: input.conversationId,
        subagentType,
        status: replayStatus,
        resultAvailable: terminal != null,
        resultClaimed: terminal?.subagentTask?.resultClaim != null,
        pendingControls:
          input.subagentTask?.controlReceipts?.filter(
            (candidate) => candidate.status === 'accepted',
          ).length ?? 0,
        createdAt: input.createdAt,
        updatedAt:
          terminal?.updatedAt ??
          (receipt.action === 'cancel' && receipt.status === 'applied'
            ? receipt.updatedAt
            : input.updatedAt),
      },
    };
  }

  /** Atomically assigns one durable terminal child result to either its
   * explicit poller or one idempotent automatic wakeup delivery. */
  async function claimSubagentTaskResult({
    userId,
    conversationId,
    taskId,
    kind,
    claimId,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<SubagentTaskResultClaim> {
    if (
      taskId.length === 0 ||
      taskId.length > 256 ||
      conversationId.length === 0 ||
      conversationId.length > 256 ||
      (kind !== 'manual' && kind !== 'wakeup') ||
      claimId.length === 0 ||
      claimId.length > 128
    ) {
      throw new TypeError('Invalid subagent task result claim');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const messageId = `${taskId}:assistant`;
    const terminal = ['completed', 'error', 'cancelled'];
    const claim = {
      kind,
      claimId,
      claimedAt: new Date(),
    };
    const claimable = {
      $or: [
        { 'subagentTask.resultClaim': { $exists: false } },
        {
          'subagentTask.resultClaim.kind': kind,
          'subagentTask.resultClaim.claimId': claimId,
        },
        ...(kind === 'manual'
          ? [
              {
                'subagentTask.resultClaim.kind': { $exists: false },
                'subagentTask.resultClaim.claimId': claimId,
              },
            ]
          : []),
      ],
    };
    const projection = {
      messageId: 1,
      conversationId: 1,
      parentMessageId: 1,
      sender: 1,
      text: 1,
      error: 1,
      createdAt: 1,
      updatedAt: 1,
      subagentTask: 1,
    };
    const acquired = await Message.findOneAndUpdate(
      {
        user: userId,
        conversationId,
        messageId,
        'subagentTask.status': { $in: terminal },
        ...claimable,
      },
      { $set: { 'subagentTask.resultClaim': claim } },
      { new: true, projection },
    ).lean<IMessage | null>();
    if (acquired != null) {
      return { status: 'acquired', message: acquired };
    }
    const existing = await Message.findOne({
      user: userId,
      conversationId,
      messageId,
      'subagentTask.status': { $in: terminal },
    })
      .select(projection)
      .lean<IMessage | null>();
    return existing == null ? { status: 'not_found' } : { status: 'claimed', message: existing };
  }

  /** Releases only the exact consumer assignment. This is used when a
   * pre-admission automatic continuation is definitively rejected, allowing a
   * later manual poll (or the same delivery retry) to claim the durable result. */
  async function releaseSubagentTaskResultClaim({
    userId,
    conversationId,
    taskId,
    kind,
    claimId,
  }: {
    userId: string;
    conversationId: string;
    taskId: string;
    kind: 'manual' | 'wakeup';
    claimId: string;
  }): Promise<boolean> {
    if (
      taskId.length === 0 ||
      taskId.length > 256 ||
      conversationId.length === 0 ||
      conversationId.length > 256 ||
      (kind !== 'manual' && kind !== 'wakeup') ||
      claimId.length === 0 ||
      claimId.length > 128
    ) {
      throw new TypeError('Invalid subagent task result claim release');
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const result = await Message.updateOne(
      {
        user: userId,
        conversationId,
        messageId: `${taskId}:assistant`,
        'subagentTask.resultClaim.kind': kind,
        'subagentTask.resultClaim.claimId': claimId,
      },
      { $unset: { 'subagentTask.resultClaim': 1 } },
    );
    return result.modifiedCount === 1;
  }

  /**
   * Deletes messages in a conversation since a specific message.
   */
  async function deleteMessagesSince(
    userId: string,
    { messageId, conversationId }: { messageId: string; conversationId: string },
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const message = await Message.findOne({ messageId, user: userId }).lean<IMessage>();

      if (message) {
        const query = Message.find({ conversationId, user: userId });
        return await query.deleteMany({
          createdAt: { $gt: message.createdAt },
        });
      }
      return undefined;
    } catch (err) {
      logger.error('Error deleting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves messages from the database.
   */
  async function getMessages(
    filter: FilterQuery<IMessage>,
    select?: string,
    options: MessageQueryOptions = {},
  ) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const projection = messageReadProjection(select);
      const query = Message.find(filter).select('+quoteSourceRetention');
      if (projection.select) {
        query.select(projection.select);
      }
      if (options.sort !== false) {
        query.sort(options.sort ?? { createdAt: 1 });
      }
      if (options.limit != null && options.limit > 0) {
        query.limit(options.limit);
      }

      return maskProjectedMessages(await query.lean<IMessage[]>(), projection);
    } catch (err) {
      logger.error('Error getting messages:', err);
      throw err;
    }
  }

  /**
   * Reads the fixed public child-thread projection and truncates text inside
   * MongoDB so oversized persisted messages are never materialized by the API.
   */
  async function getMessagesForSubagentThreadView(input: {
    user: string;
    conversationId: string;
    tenantId?: string;
    selectedTaskId?: string;
    beforeMessageId?: string;
    limit: number;
    textCodePointLimit: number;
  }): Promise<SubagentThreadViewMessageRecord[]> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const transcriptJsonBytes = {
        $strLenBytes: {
          $convert: {
            input: '$subagentTranscript.messagesJson',
            to: 'string',
            onError: '',
            onNull: '',
          },
        },
      };
      const transcriptIsString = {
        $eq: [{ $type: '$subagentTranscript.messagesJson' }, 'string'],
      };
      const activityProjectionJsonBytes = {
        $strLenBytes: {
          $convert: {
            input: '$subagentActivityProjection.activityJson',
            to: 'string',
            onError: '',
            onNull: '',
          },
        },
      };
      const activityProjectionIsString = {
        $eq: [{ $type: '$subagentActivityProjection.activityJson' }, 'string'],
      };
      const activityProjectionAvailable = {
        $and: [
          { $eq: ['$subagentActivityProjection.version', 1] },
          '$_subagentActivityProjectionSourceIsString',
          {
            $lte: [
              '$_subagentActivityProjectionSourceBytes',
              SUBAGENT_ACTIVITY_PROJECTION_SOURCE_BYTE_LIMIT,
            ],
          },
        ],
      };
      const transcriptAvailable = {
        $and: [
          '$_subagentTranscriptSourceIsString',
          {
            $lte: ['$_subagentTranscriptSourceBytes', SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT],
          },
        ],
      };
      const boundedString = (path: string, codePointLimit: number) => ({
        $substrCP: [
          {
            $cond: [{ $eq: [{ $type: path }, 'string'] }, path, ''],
          },
          0,
          codePointLimit,
        ],
      });
      const stringProjectionTruncated = (path: string, codePointLimit: number) => ({
        $gt: [
          {
            $strLenCP: {
              $cond: [{ $eq: [{ $type: path }, 'string'] }, path, ''],
            },
          },
          codePointLimit,
        ],
      });
      const boundedStringArray = (path: string) => ({
        $map: {
          input: {
            $slice: [
              { $cond: [{ $isArray: path }, path, []] },
              SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
            ],
          },
          as: 'value',
          in: boundedString('$$value', SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT),
        },
      });
      const boundedControlReceipt = {
        invocationId: boundedString(
          '$$receipt.invocationId',
          SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
        ),
        controlId: {
          $cond: [
            { $eq: [{ $type: '$$receipt.controlId' }, 'string'] },
            boundedString('$$receipt.controlId', SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT),
            null,
          ],
        },
        action: '$$receipt.action',
        status: '$$receipt.status',
        createdAt: '$$receipt.createdAt',
        updatedAt: '$$receipt.updatedAt',
        boundary: '$$receipt.boundary',
        reason: {
          $cond: [
            { $eq: [{ $type: '$$receipt.reason' }, 'string'] },
            boundedString('$$receipt.reason', SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT),
            null,
          ],
        },
        message: {
          $cond: [
            { $eq: [{ $type: '$$receipt.message' }, 'string'] },
            boundedString('$$receipt.message', SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT),
            null,
          ],
        },
        messageTruncated: {
          $or: [
            { $eq: ['$$receipt.messageTruncated', true] },
            stringProjectionTruncated(
              '$$receipt.message',
              SUBAGENT_VIEW_CONTROL_STRING_CODE_POINT_LIMIT,
            ),
          ],
        },
      };
      const boundedSubagentTask = {
        $cond: [
          { $eq: [{ $type: '$subagentTask' }, 'object'] },
          {
            status: '$subagentTask.status',
            controlReceipts: {
              $let: {
                vars: {
                  visible: {
                    $filter: {
                      input: {
                        $cond: [
                          { $isArray: '$subagentTask.controlReceipts' },
                          '$subagentTask.controlReceipts',
                          [],
                        ],
                      },
                      as: 'receipt',
                      cond: { $ne: ['$$receipt.status', 'reserved'] },
                    },
                  },
                },
                in: {
                  $let: {
                    vars: {
                      accepted: {
                        $slice: [
                          {
                            $filter: {
                              input: '$$visible',
                              as: 'receipt',
                              cond: { $eq: ['$$receipt.status', 'accepted'] },
                            },
                          },
                          SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
                        ],
                      },
                      terminal: {
                        $filter: {
                          input: '$$visible',
                          as: 'receipt',
                          cond: { $ne: ['$$receipt.status', 'accepted'] },
                        },
                      },
                    },
                    in: {
                      $map: {
                        input: {
                          $concatArrays: [
                            '$$accepted',
                            {
                              $let: {
                                vars: {
                                  allowance: {
                                    $subtract: [
                                      SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
                                      { $size: '$$accepted' },
                                    ],
                                  },
                                },
                                in: {
                                  $cond: [
                                    { $gt: ['$$allowance', 0] },
                                    { $slice: ['$$terminal', { $multiply: [-1, '$$allowance'] }] },
                                    [],
                                  ],
                                },
                              },
                            },
                          ],
                        },
                        as: 'receipt',
                        in: boundedControlReceipt,
                      },
                    },
                  },
                },
              },
            },
            controlReceiptsProjectionTruncated: {
              $gt: [
                {
                  $size: {
                    $filter: {
                      input: {
                        $cond: [
                          { $isArray: '$subagentTask.controlReceipts' },
                          '$subagentTask.controlReceipts',
                          [],
                        ],
                      },
                      as: 'receipt',
                      cond: { $ne: ['$$receipt.status', 'reserved'] },
                    },
                  },
                },
                SUBAGENT_VIEW_CONTROL_RECEIPT_LIMIT,
              ],
            },
          },
          null,
        ],
      };
      /** Mixed-typed content metadata must be type-gated before projection, or a
       *  malformed part could tunnel arbitrarily large values past the byte cap
       *  through a passthrough field. `$type`-based checks stay DocumentDB-safe. */
      const boundedNumber = (path: string) => ({
        $cond: [{ $in: [{ $type: path }, ['int', 'long', 'double', 'decimal']] }, path, null],
      });
      const boundedBoolean = (path: string) => ({
        $cond: [{ $eq: [{ $type: path }, 'bool'] }, path, null],
      });
      const boundedEnum = (path: string, allowed: string[]) => ({
        $cond: [{ $in: [path, allowed] }, path, null],
      });
      /** Estimated serialized bytes for one already-clipped activity item; the
       *  constants cover the non-string JSON envelope per item type. This is a
       *  BSON-transfer budget: `$strLenBytes` measures exactly what MongoDB
       *  ships to the API. JSON escaping can expand strings after transfer,
       *  which the API bounds precisely — `boundActivity` in
       *  `packages/api/src/agents/activity.ts` re-fits the same array to 64KB
       *  of `JSON.stringify` output before anything reaches a response. */
      const activityItemBytes = (item: string) => ({
        $switch: {
          branches: [
            {
              case: { $eq: [`${item}.type`, 'writing'] },
              then: { $add: [{ $strLenBytes: `${item}.text` }, 64] },
            },
            {
              case: { $eq: [`${item}.type`, 'activity_label'] },
              then: {
                $add: [
                  { $strLenBytes: `${item}.label` },
                  {
                    $reduce: {
                      input: {
                        $concatArrays: [
                          {
                            $cond: [{ $isArray: `${item}.toolCallIds` }, `${item}.toolCallIds`, []],
                          },
                          { $cond: [{ $isArray: `${item}.agentIds` }, `${item}.agentIds`, []] },
                        ],
                      },
                      initialValue: 0,
                      in: { $add: ['$$value', { $strLenBytes: '$$this' }, 8] },
                    },
                  },
                  512,
                ],
              },
            },
            {
              case: { $eq: [`${item}.type`, 'tool'] },
              then: {
                $add: [
                  { $strLenBytes: `${item}.input` },
                  { $strLenBytes: `${item}.output` },
                  { $strLenBytes: `${item}.name` },
                  { $strLenBytes: `${item}.toolCallId` },
                  192,
                ],
              },
            },
          ],
          default: 32,
        },
      });
      /** Newest-first fit into the aggregate budget, so raising per-item limits
       *  cannot multiply into megabytes per row before the API's own trims run. */
      const budgetedActivity = (clipped: Record<string, unknown>) => ({
        $reverseArray: {
          $let: {
            vars: {
              fitted: {
                $reduce: {
                  input: { $reverseArray: clipped },
                  initialValue: { items: [] as never[], bytes: 0, done: false },
                  in: {
                    $let: {
                      vars: { size: activityItemBytes('$$this') },
                      in: {
                        $cond: [
                          {
                            $or: [
                              '$$value.done',
                              {
                                $gt: [
                                  { $add: ['$$value.bytes', '$$size'] },
                                  SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
                                ],
                              },
                            ],
                          },
                          /* The retained timeline must be a contiguous newest
                             suffix: once one entry does not fit, older entries
                             are not allowed to fill the gap around it. */
                          { items: '$$value.items', bytes: '$$value.bytes', done: true },
                          {
                            items: { $concatArrays: ['$$value.items', ['$$this']] },
                            bytes: { $add: ['$$value.bytes', '$$size'] },
                            done: false,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            in: '$$fitted.items',
          },
        },
      });
      const activityBytesOverBudget = (clipped: Record<string, unknown>) => ({
        $gt: [
          {
            $reduce: {
              input: clipped,
              initialValue: 0,
              in: { $add: ['$$value', activityItemBytes('$$this')] },
            },
          },
          SUBAGENT_MESSAGE_ACTIVITY_TOTAL_BYTE_LIMIT,
        ],
      });
      const clippedActivityContent = {
        $filter: {
          input: {
            $map: {
              input: {
                $slice: [
                  { $cond: [{ $isArray: '$content' }, '$content', []] },
                  -SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
                ],
              },
              as: 'part',
              in: {
                $switch: {
                  branches: [
                    {
                      case: { $eq: ['$$part.type', 'text'] },
                      then: {
                        type: 'writing',
                        text: boundedString(
                          '$$part.text',
                          SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
                        ),
                        textTruncated: stringProjectionTruncated(
                          '$$part.text',
                          SUBAGENT_MESSAGE_ACTIVITY_TEXT_CODE_POINT_LIMIT,
                        ),
                      },
                    },
                    {
                      case: { $in: ['$$part.type', ['think', 'reasoning']] },
                      then: { type: 'reasoning' },
                    },
                    {
                      case: { $eq: ['$$part.type', 'activity_label'] },
                      then: {
                        type: 'activity_label',
                        label: boundedString(
                          '$$part.activity_label',
                          SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
                        ),
                        labelType: boundedEnum('$$part.activity_label_type', ['phase']),
                        toolCallIds: boundedStringArray('$$part.tool_call_ids'),
                        activityStartIndex: boundedNumber('$$part.activity_start_index'),
                        activityEndIndex: boundedNumber('$$part.activity_end_index'),
                        activityCount: boundedNumber('$$part.activity_count'),
                        agentIds: boundedStringArray('$$part.agent_ids'),
                        status: boundedEnum('$$part.status', ['ok', 'partial', 'failed']),
                        pending: boundedBoolean('$$part.pending'),
                        labelTruncated: {
                          $or: [
                            stringProjectionTruncated(
                              '$$part.activity_label',
                              SUBAGENT_MESSAGE_ACTIVITY_LABEL_CODE_POINT_LIMIT,
                            ),
                            {
                              $gt: [
                                {
                                  $size: {
                                    $cond: [
                                      { $isArray: '$$part.tool_call_ids' },
                                      '$$part.tool_call_ids',
                                      [],
                                    ],
                                  },
                                },
                                SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
                              ],
                            },
                            {
                              $gt: [
                                {
                                  $size: {
                                    $cond: [
                                      { $isArray: '$$part.agent_ids' },
                                      '$$part.agent_ids',
                                      [],
                                    ],
                                  },
                                },
                                SUBAGENT_MESSAGE_ACTIVITY_LABEL_IDS_LIMIT,
                              ],
                            },
                          ],
                        },
                      },
                    },
                    {
                      case: { $eq: ['$$part.type', 'tool_call'] },
                      then: {
                        type: 'tool',
                        toolCallId: boundedString(
                          '$$part.tool_call.id',
                          SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                        ),
                        name: boundedString(
                          '$$part.tool_call.name',
                          SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                        ),
                        input: boundedString(
                          '$$part.tool_call.args',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
                        ),
                        output: boundedString(
                          '$$part.tool_call.output',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
                        ),
                        progress: boundedNumber('$$part.tool_call.progress'),
                        runStepStatus: boundedEnum('$$part.tool_call.runStepStatus', [
                          'running',
                          'completed',
                          'failed',
                          'cancelled',
                        ]),
                        inputValidationError: boundedBoolean(
                          '$$part.tool_call.inputValidationError',
                        ),
                        inputTruncated: stringProjectionTruncated(
                          '$$part.tool_call.args',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_INPUT_CODE_POINT_LIMIT,
                        ),
                        outputTruncated: stringProjectionTruncated(
                          '$$part.tool_call.output',
                          SUBAGENT_MESSAGE_ACTIVITY_TOOL_OUTPUT_CODE_POINT_LIMIT,
                        ),
                      },
                    },
                  ],
                  default: null,
                },
              },
            },
          },
          as: 'activity',
          cond: { $ne: ['$$activity', null] },
        },
      };
      const boundedActivityContent = budgetedActivity(clippedActivityContent);
      type ActivitySourceProjection = WithNullSentinels<
        Pick<
          SubagentThreadViewMessageRecord,
          | 'messageId'
          | 'subagentTranscript'
          | 'subagentActivityProjectionJson'
          | 'subagentActivityProjectionTruncated'
        >,
        | 'subagentTranscript'
        | 'subagentActivityProjectionJson'
        | 'subagentActivityProjectionTruncated'
      >;
      const boundedMessageProjection = {
        _id: 0,
        messageId: 1,
        parentMessageId: 1,
        isCreatedByUser: 1,
        text: {
          $substrCP: [{ $ifNull: ['$text', ''] }, 0, input.textCodePointLimit],
        },
        textProjectionTruncated: {
          $gt: [{ $strLenCP: { $ifNull: ['$text', ''] } }, input.textCodePointLimit],
        },
        createdAt: 1,
        error: 1,
        unfinished: 1,
        subagentTranscriptProjectionTruncated: {
          $cond: [{ $ne: [{ $type: '$subagentTranscript.messagesJson' }, 'missing'] }, true, null],
        },
        subagentActivity: boundedActivityContent,
        subagentActivityProjectionTruncated: {
          $or: [
            {
              $gt: [
                {
                  $size: { $cond: [{ $isArray: '$content' }, '$content', []] },
                },
                SUBAGENT_MESSAGE_ACTIVITY_ITEM_LIMIT,
              ],
            },
            activityBytesOverBudget(clippedActivityContent),
          ],
        },
        subagentTask: boundedSubagentTask,
        subagentTriggerProjection: {
          $cond: [
            { $eq: ['$subagentTriggerProjection.version', 1] },
            {
              version: 1,
              eventType: boundedString(
                '$subagentTriggerProjection.eventType',
                SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
              ),
              sourceType: boundedString(
                '$subagentTriggerProjection.sourceType',
                SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
              ),
              occurredAt: '$subagentTriggerProjection.occurredAt',
              expectedActionToolName: {
                $cond: [
                  {
                    $eq: [{ $type: '$subagentTriggerProjection.expectedActionToolName' }, 'string'],
                  },
                  boundedString(
                    '$subagentTriggerProjection.expectedActionToolName',
                    SUBAGENT_MESSAGE_ACTIVITY_ID_CODE_POINT_LIMIT,
                  ),
                  null,
                ],
              },
            },
            null,
          ],
        },
      };
      const sourceMetadataProjection = {
        _subagentTranscriptSourceBytes: transcriptJsonBytes,
        _subagentTranscriptSourceIsString: transcriptIsString,
        _subagentActivityProjectionSourceBytes: activityProjectionJsonBytes,
        _subagentActivityProjectionSourceIsString: activityProjectionIsString,
      };
      const activitySourcePayload = {
        subagentActivityProjectionJson: {
          $cond: [activityProjectionAvailable, '$subagentActivityProjection.activityJson', null],
        },
        subagentActivityProjectionTruncated: {
          $cond: [activityProjectionAvailable, '$subagentActivityProjection.truncated', null],
        },
        subagentTranscript: {
          $cond: [
            activityProjectionAvailable,
            null,
            {
              taskId: '$subagentTranscript.taskId',
              mode: '$subagentTranscript.mode',
              messagesJson: '$subagentTranscript.messagesJson',
            },
          ],
        },
      };
      const activitySourceProjection = {
        _id: 0,
        messageId: 1,
        ...activitySourcePayload,
      };
      const baseMatch = {
        user: input.user,
        conversationId: input.conversationId,
        ...(input.tenantId == null
          ? { tenantId: { $exists: false } }
          : { tenantId: input.tenantId }),
      };
      const anchor =
        input.beforeMessageId == null
          ? null
          : await Message.findOne({ ...baseMatch, messageId: input.beforeMessageId })
              .select('_id createdAt')
              .lean<Pick<IMessage, '_id' | 'createdAt'>>();
      if (input.beforeMessageId != null && anchor == null) return [];
      const pageMatch =
        anchor == null
          ? baseMatch
          : {
              ...baseMatch,
              $or: [
                { createdAt: { $lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, _id: { $lte: anchor._id } },
              ],
            };
      /** Keep rows as independent MongoDB results. A `$facet` would combine the
       * complete page into one BSON document and could exceed MongoDB's 16 MiB
       * document limit before the API applies its smaller public byte budget. */
      const messagesPromise = Message.aggregate<ProjectedSubagentThreadViewMessage>([
        { $match: pageMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: input.limit },
        { $project: boundedMessageProjection },
      ]);
      const recentSourcesPromise = Message.aggregate<ActivitySourceProjection>([
        { $match: pageMatch },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: SUBAGENT_ACTIVITY_SOURCE_CANDIDATE_LIMIT },
        {
          $match: {
            ...(input.selectedTaskId == null
              ? {}
              : { messageId: { $ne: `${input.selectedTaskId}:assistant` } }),
            $or: [
              { 'subagentActivityProjection.activityJson': { $exists: true } },
              { 'subagentTranscript.messagesJson': { $exists: true } },
            ],
          },
        },
        { $addFields: sourceMetadataProjection },
        {
          $match: {
            $expr: {
              $or: [
                {
                  $and: [
                    activityProjectionAvailable,
                    {
                      $eq: [
                        '$messageId',
                        { $concat: ['$subagentActivityProjection.taskId', ':assistant'] },
                      ],
                    },
                  ],
                },
                {
                  $and: [
                    transcriptAvailable,
                    {
                      $eq: [
                        '$messageId',
                        { $concat: ['$subagentTranscript.taskId', ':assistant'] },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        { $limit: SUBAGENT_TRANSCRIPT_PAGE_LIMIT - (input.selectedTaskId == null ? 0 : 1) },
        { $project: activitySourceProjection },
      ]);
      /** One read replaces the unsupported `$facet` while keeping its guarantee:
       * the bounded message fields and the source payload for each selected row
       * come from the same document version, so a transcript persisted between
       * two separate reads can never yield a message without its source. Rows
       * stay independent results, so no combined document approaches the 16 MiB
       * limit the surrounding reads already avoid. Only operators Amazon
       * DocumentDB accepts are used. */
      const selectedProjectionPromise =
        input.selectedTaskId == null
          ? Promise.resolve({
              selectedMessages: [] as ProjectedSubagentThreadViewMessage[],
              selectedSources: [] as ActivitySourceProjection[],
            })
          : Message.aggregate<
              ProjectedSubagentThreadViewMessage & {
                _selectedSource: ActivitySourceProjection | null;
              }
            >([
              {
                $match: {
                  ...baseMatch,
                  messageId: {
                    $in: [`${input.selectedTaskId}:user`, `${input.selectedTaskId}:assistant`],
                  },
                },
              },
              { $limit: 2 },
              { $addFields: sourceMetadataProjection },
              {
                $project: {
                  ...boundedMessageProjection,
                  _selectedSource: {
                    $cond: [
                      {
                        $and: [
                          { $eq: ['$messageId', `${input.selectedTaskId}:assistant`] },
                          {
                            $or: [
                              {
                                $and: [
                                  {
                                    $eq: [
                                      '$subagentActivityProjection.taskId',
                                      input.selectedTaskId,
                                    ],
                                  },
                                  activityProjectionAvailable,
                                ],
                              },
                              {
                                $and: [
                                  { $eq: ['$subagentTranscript.taskId', input.selectedTaskId] },
                                  transcriptAvailable,
                                ],
                              },
                            ],
                          },
                        ],
                      },
                      { messageId: '$messageId', ...activitySourcePayload },
                      null,
                    ],
                  },
                },
              },
            ]).then((rows) => {
              const selectedSources: ActivitySourceProjection[] = [];
              const selectedMessages = rows.map(({ _selectedSource, ...message }) => {
                if (_selectedSource != null) {
                  selectedSources.push(_selectedSource);
                }
                return message;
              });
              return { selectedMessages, selectedSources };
            });
      const [messages, recentSources, selectedProjection] = await Promise.all([
        messagesPromise,
        recentSourcesPromise,
        selectedProjectionPromise,
      ]);
      const sourcesByMessageId = new Map(
        [...selectedProjection.selectedSources, ...recentSources].map((record) => [
          record.messageId,
          record,
        ]),
      );
      /** The page rows come from an independent concurrent read; for the
       * selected task, the single-snapshot pair is authoritative — a page
       * duplicate can predate the source read and claim a transcript that
       * `selectedSources` does not carry. Replace duplicates in place (keeping
       * page order) instead of discarding the snapshot version. */
      const selectedByMessageId = new Map(
        selectedProjection.selectedMessages.map((message) => [message.messageId, message]),
      );
      for (let index = 0; index < messages.length; index += 1) {
        const snapshot = selectedByMessageId.get(messages[index].messageId);
        if (snapshot != null) {
          messages[index] = snapshot;
          selectedByMessageId.delete(snapshot.messageId);
        }
      }
      for (const message of selectedByMessageId.values()) {
        messages.push(message);
      }
      return messages.map((row) => {
        const message = pruneProjectedThreadViewMessage(row);
        const source = sourcesByMessageId.get(message.messageId);
        if (source == null) return message;
        const projected = { ...message };
        if (source.subagentActivityProjectionJson != null) {
          delete projected.subagentTranscriptProjectionTruncated;
          return {
            ...projected,
            subagentActivityProjectionJson: source.subagentActivityProjectionJson,
            ...(source.subagentActivityProjectionTruncated === true
              ? { subagentActivityProjectionTruncated: true }
              : {}),
          };
        }
        if (source.subagentTranscript == null) return message;
        delete projected.subagentTranscriptProjectionTruncated;
        return { ...projected, subagentTranscript: source.subagentTranscript };
      });
    } catch (err) {
      logger.error('Error getting bounded subagent thread messages:', err);
      throw err;
    }
  }

  /** Returns newest bounded task outcomes for every selected child in two
   * constant-size batch reads. The first read guarantees one latest task per
   * child; the second caps recent source rows before any grouping accumulator.
   * This avoids both N+1 reads and newer top-N accumulators that DocumentDB 5
   * does not support. */
  async function listSubagentTasksForThreads(input: {
    user: string;
    conversationIds: string[];
    tenantId?: string;
    limitPerThread: number;
  }): Promise<ParentSubagentTaskRecord[]> {
    if (input.conversationIds.length === 0) {
      return [];
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const match = {
      user: input.user,
      conversationId: { $in: input.conversationIds },
      ...(input.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: input.tenantId }),
      messageId: { $regex: /:(user|assistant)$/ },
    };
    const taskProjection = {
      messageId: '$messageId',
      createdAt: '$createdAt',
      occurrenceId: '$_id',
      statusDerived: {
        $eq: [{ $ifNull: ['$subagentTask.status', null] }, null],
      },
      status: {
        $ifNull: [
          '$subagentTask.status',
          {
            $cond: [
              { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
              {
                $cond: [
                  { $eq: ['$error', true] },
                  'error',
                  { $cond: [{ $eq: ['$unfinished', true] }, 'cancelled', 'completed'] },
                ],
              },
              'running',
            ],
          },
        ],
      },
    };
    const sourceLimit = Math.min(
      4096,
      Math.max(
        input.conversationIds.length,
        input.conversationIds.length * input.limitPerThread * 2,
      ),
    );
    type AggregateRecord = ParentSubagentTaskRecord & { sourceRows?: number };
    const compareOccurrenceIds = (left?: Types.ObjectId, right?: Types.ObjectId): number => {
      const leftValue = left?.toHexString() ?? '';
      const rightValue = right?.toHexString() ?? '';
      if (leftValue === rightValue) return 0;
      return leftValue > rightValue ? 1 : -1;
    };
    const taskTimestamp = (value: Date | undefined): number =>
      value == null ? Number.NEGATIVE_INFINITY : value.getTime();
    const [latestRecords, recentRecords] = await Promise.all([
      Message.aggregate<ParentSubagentTaskRecord>([
        { $match: match },
        { $sort: { conversationId: 1, createdAt: -1, _id: -1 } },
        { $group: { _id: '$conversationId', task: { $first: taskProjection } } },
        { $project: { _id: 0, conversationId: '$_id', tasks: ['$task'] } },
        { $sort: { conversationId: 1 } },
      ]),
      Message.aggregate<AggregateRecord>([
        { $match: match },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: sourceLimit + 1 },
        {
          $addFields: {
            _subagentIsAssistant: { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
            _subagentTaskId: {
              $substrBytes: [
                '$messageId',
                0,
                {
                  $subtract: [
                    { $strLenBytes: '$messageId' },
                    {
                      $cond: [
                        { $regexMatch: { input: '$messageId', regex: /:assistant$/ } },
                        10,
                        5,
                      ],
                    },
                  ],
                },
              ],
            },
          },
        },
        {
          $sort: {
            conversationId: 1,
            _subagentTaskId: 1,
            _subagentIsAssistant: -1,
            createdAt: -1,
            _id: -1,
          },
        },
        {
          $group: {
            _id: { conversationId: '$conversationId', taskId: '$_subagentTaskId' },
            task: { $first: taskProjection },
            sourceRows: { $sum: 1 },
          },
        },
        {
          $sort: {
            '_id.conversationId': 1,
            'task.createdAt': -1,
            'task.occurrenceId': -1,
            '_id.taskId': 1,
          },
        },
        {
          $group: {
            _id: '$_id.conversationId',
            tasks: { $push: '$task' },
            sourceRows: { $sum: '$sourceRows' },
          },
        },
        {
          $project: {
            _id: 0,
            conversationId: '$_id',
            tasks: { $slice: ['$tasks', input.limitPerThread] },
            sourceRows: 1,
          },
        },
        { $sort: { conversationId: 1 } },
      ]),
    ]);
    const sourceTruncated =
      recentRecords.reduce((total, record) => total + (record.sourceRows ?? 0), 0) > sourceLimit;
    const records = new Map<string, ParentSubagentTaskRecord>(
      recentRecords.map((record) => [
        record.conversationId,
        {
          conversationId: record.conversationId,
          tasks: record.tasks,
          ...(sourceTruncated ? { sourceTruncated: true } : {}),
        },
      ]),
    );
    for (const latest of latestRecords) {
      const current = records.get(latest.conversationId);
      if (current == null) {
        records.set(latest.conversationId, {
          ...latest,
          ...(sourceTruncated ? { sourceTruncated: true } : {}),
        });
        continue;
      }
      const candidates = [...current.tasks, ...latest.tasks];
      const tasksById = new Map<string, (typeof candidates)[number]>();
      for (const candidate of candidates) {
        const taskId = candidate.messageId.replace(/:(user|assistant)$/, '');
        const existing = tasksById.get(taskId);
        const candidateTime = taskTimestamp(candidate.createdAt);
        const existingTime = taskTimestamp(existing?.createdAt);
        const candidateIsAssistant = candidate.messageId.endsWith(':assistant');
        const existingIsAssistant = existing?.messageId.endsWith(':assistant') === true;
        const occurrenceDifference = compareOccurrenceIds(
          candidate.occurrenceId,
          existing?.occurrenceId,
        );
        if (
          existing == null ||
          candidateTime > existingTime ||
          (candidateTime === existingTime && occurrenceDifference > 0) ||
          (candidateTime === existingTime &&
            occurrenceDifference === 0 &&
            candidateIsAssistant &&
            !existingIsAssistant)
        ) {
          tasksById.set(taskId, candidate);
        }
      }
      current.tasks = [...tasksById.values()]
        .sort((left, right) => {
          const timeDifference = taskTimestamp(right.createdAt) - taskTimestamp(left.createdAt);
          if (timeDifference !== 0) return timeDifference;
          const occurrenceDifference = compareOccurrenceIds(right.occurrenceId, left.occurrenceId);
          if (occurrenceDifference !== 0) return occurrenceDifference;
          const assistantDifference =
            Number(right.messageId.endsWith(':assistant')) -
            Number(left.messageId.endsWith(':assistant'));
          if (assistantDifference !== 0) return assistantDifference;
          return left.messageId.localeCompare(right.messageId);
        })
        .slice(0, input.limitPerThread);
    }
    return [...records.values()].sort((left, right) =>
      left.conversationId.localeCompare(right.conversationId),
    );
  }

  async function getConversationTraceRefs({
    user,
    conversationId,
    tenantId,
    messageId,
    through,
    limit,
  }: {
    user: string;
    conversationId: string;
    tenantId?: string;
    messageId?: string;
    through?: { messageId: string; orderKey: string };
    limit?: number;
  }): Promise<ConversationTraceRefs> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const scope = { user, conversationId, ...traceTenantScope(tenantId) };
      const anchor = through != null ? parseTraceOrderKey(through.orderKey) : undefined;
      const range =
        anchor != null
          ? {
              $or: [
                { createdAt: { $lt: anchor.createdAt } },
                {
                  createdAt: anchor.createdAt,
                  _id: { $lte: new mongoose.Types.ObjectId(anchor.id) },
                },
              ],
            }
          : {};
      const query = Message.find({
        ...scope,
        ...SERVER_AUTHORED_SAMPLED_RESPONSE,
        ...(messageId != null ? { messageId } : {}),
        ...range,
      }).select('_id messageId createdAt langfuseDestinationIds langfuseRunId');
      const bounded = limit != null;
      /** `_id` breaks ties between responses saved in the same millisecond, so every page
       *  request rebuilds the same turn order its cursor was positioned in. */
      const sorted = bounded
        ? query.sort({ createdAt: -1, _id: -1 }).limit(limit)
        : query.sort({ createdAt: 1, _id: 1 });
      const [first, rows] = await Promise.all([
        Message.findOne(scope)
          .select('createdAt -_id')
          .sort({ createdAt: 1 })
          .lean<Pick<IMessage, 'createdAt'>>(),
        through != null && anchor == null
          ? []
          : sorted.lean<
              Array<
                Pick<
                  IMessage,
                  'messageId' | 'createdAt' | 'langfuseDestinationIds' | 'langfuseRunId'
                > & { _id: Types.ObjectId }
              >
            >(),
      ]);
      const sampled = bounded ? rows.reverse() : rows;
      /** A position that no longer names its response (deleted, or never issued) resumes nothing. */
      if (through != null && sampled[sampled.length - 1]?.messageId !== through.messageId) {
        return { firstMessageAt: first?.createdAt, sampledMessages: [] };
      }
      return {
        firstMessageAt: first?.createdAt,
        sampledMessages: sampled
          .filter((message) => typeof message.messageId === 'string')
          .map(({ _id, messageId: id, createdAt, langfuseDestinationIds, langfuseRunId }) => ({
            messageId: id,
            ...(createdAt != null ? { createdAt, orderKey: traceOrderKey(createdAt, _id) } : {}),
            ...(Array.isArray(langfuseDestinationIds) ? { langfuseDestinationIds } : {}),
            ...(typeof langfuseRunId === 'string' && langfuseRunId.length > 0
              ? { langfuseRunId }
              : {}),
          })),
      };
    } catch (err) {
      logger.error('Error getting conversation trace references:', err);
      throw err;
    }
  }

  async function hasSampledTraceMessage({
    user,
    conversationId,
    tenantId,
    destinationIds,
  }: {
    user: string;
    conversationId: string;
    tenantId?: string;
    destinationIds: string[];
  }): Promise<boolean> {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const match = await Message.findOne({
        user,
        conversationId,
        ...traceTenantScope(tenantId),
        ...SERVER_AUTHORED_SAMPLED_RESPONSE,
        $or: [
          { langfuseDestinationIds: null },
          { langfuseDestinationIds: { $in: destinationIds } },
        ],
      })
        .select('_id')
        .lean();
      return match != null;
    } catch (err) {
      logger.error('Error checking for a sampled trace message:', err);
      throw err;
    }
  }

  /**
   * Retrieves a single message from the database.
   */
  async function getMessage({ user, messageId }: { user: string; messageId: string }) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      const row = await Message.findOne({ user, messageId })
        .select('+quoteSourceRetention')
        .lean<IMessage>();
      return row == null ? null : (await maskFileSourceMessages([row]))[0];
    } catch (err) {
      logger.error('Error getting message:', err);
      throw err;
    }
  }

  /**
   * Deletes messages from the database.
   */
  async function deleteMessages(filter: FilterQuery<IMessage>) {
    try {
      const Message = mongoose.models.Message as Model<IMessage>;
      return await Message.deleteMany(filter);
    } catch (err) {
      logger.error('Error deleting messages:', err);
      throw err;
    }
  }

  /**
   * Retrieves paginated messages with custom sorting and cursor support.
   */
  async function getMessagesByCursor(
    filter: FilterQuery<IMessage>,
    options: {
      sortField?: string;
      sortOrder?: 1 | -1;
      limit?: number;
      cursor?: string | null;
      /** Projection for the page, e.g. `CLIENT_MESSAGE_SELECT` for client-facing reads. */
      select?: string;
    } = {},
  ) {
    const Message = mongoose.models.Message as Model<IMessage>;
    const { sortField = 'createdAt', sortOrder = -1, limit = 25, cursor, select } = options;
    const projection = messageReadProjection(select);
    const queryFilter = { ...filter };
    if (cursor) {
      queryFilter[sortField] = sortOrder === 1 ? { $gt: cursor } : { $lt: cursor };
    }
    const query = Message.find(queryFilter).select('+quoteSourceRetention');
    if (projection.select) {
      query.select(projection.select);
    }
    const messages = await query
      .sort({ [sortField]: sortOrder })
      .limit(limit + 1)
      .lean<IMessage[]>();

    let nextCursor: string | null = null;
    if (messages.length > limit) {
      messages.pop();
      const last = messages[messages.length - 1];
      const cursorValue =
        sortField === 'createdAt' ? last.createdAt : last[sortField as keyof IMessage];
      nextCursor = String(cursorValue ?? '');
    }
    return {
      messages: await maskProjectedMessages(messages, projection),
      nextCursor,
    };
  }

  /**
   * Performs a MeiliSearch query on the Message collection.
   * Requires the meilisearch plugin to be registered on the Message model.
   */
  async function searchMessages(
    query: string,
    searchOptions: SearchParams,
    hydrate?: boolean,
  ): Promise<Awaited<ReturnType<SchemaWithMeiliMethods['meiliSearch']>>> {
    const Message = mongoose.models.Message as SchemaWithMeiliMethods;
    if (typeof Message.meiliSearch !== 'function') {
      throw new Error('MeiliSearch plugin not registered on Message model');
    }
    return Message.meiliSearch(query, searchOptions, hydrate);
  }

  async function getPersistedPrivateTextId(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageId: string;
    privacyRevision: string;
    text: string;
  }): Promise<string | null> {
    if (
      !input.userId ||
      !input.messageId ||
      !input.privacyRevision ||
      !UUID_REGEX.test(input.conversationId)
    ) {
      return null;
    }
    const activeTenant = tenantStorage.getStore()?.tenantId;
    if (activeTenant != null && activeTenant !== input.tenantId) {
      return null;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const stored = await Message.exists({
      user: input.userId,
      ...traceTenantScope(input.tenantId),
      conversationId: input.conversationId,
      messageId: input.messageId,
      text: input.text,
      privacyRevision: input.privacyRevision,
      privateText: { $exists: true },
      $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
    });
    if (stored == null) return null;
    const [visible] = await maskFileSourceMessages([{ _id: stored._id } as IMessage], false);
    return visible.sourceContentRemovedAt ? null : String(stored._id);
  }

  async function hasPersistedPrivateText(
    input: Parameters<MessageMethods['hasPersistedPrivateText']>[0],
  ): Promise<boolean> {
    return (await getPersistedPrivateTextId(input)) != null;
  }

  async function getPrivateMessageTexts(input: {
    userId: string;
    tenantId?: string;
    conversationId: string;
    messageIds: readonly string[];
  }): Promise<PrivateTextRead[]> {
    if (!input.userId || !UUID_REGEX.test(input.conversationId) || input.messageIds.length > 50) {
      throw new Error('Invalid private message read.');
    }
    const activeTenant = tenantStorage.getStore()?.tenantId;
    if (activeTenant != null && activeTenant !== input.tenantId) {
      return [];
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    const rows = await Message.find({
      user: input.userId,
      ...traceTenantScope(input.tenantId),
      conversationId: input.conversationId,
      messageId: { $in: input.messageIds },
      isCreatedByUser: true,
      privateText: { $exists: true },
      $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
    })
      .select('messageId text privacyRevision +privateText')
      .limit(50)
      .lean<PrivateTextRead[]>();
    const available = await maskFileSourceMessages(rows as unknown as IMessage[], false);
    return available.filter((row) => row.privateText != null) as unknown as PrivateTextRead[];
  }

  return {
    ...createMessageArtifactSourceMethods(mongoose),
    resolveQuoteRetention,
    resolveFileRetentionContext,
    redactFileSourceContent,
    hasPersistedPrivateText,
    getPersistedPrivateTextId,
    getPrivateMessageTexts,
    saveMessage,
    bulkSaveMessages,
    recordMessage,
    updateMessageText,
    updateToolCallResult,
    claimBackgroundToolResults,
    confirmBackgroundToolResultClaim,
    releaseBackgroundToolResultClaims,
    updateMessage,
    recordSubagentTaskControlReceipt,
    getSubagentTaskControlReceipt,
    getSubagentTaskControlReplay,
    claimSubagentTaskResult,
    releaseSubagentTaskResultClaim,
    deleteMessagesSince,
    getMessages,
    getConversationTraceRefs,
    hasSampledTraceMessage,
    getMessagesForSubagentThreadView,
    listSubagentTasksForThreads,
    getMessage,
    getMessagesByCursor,
    searchMessages,
    deleteMessages,
  };
}
