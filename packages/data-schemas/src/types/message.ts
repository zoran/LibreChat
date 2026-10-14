import type {
  QuoteSourceRef,
  TFeedbackRating,
  TFeedbackTag,
  TReasoningOverride,
  UserSubmittedMessageFieldPath,
} from 'librechat-data-provider';
import type { Document } from 'mongoose';
import type { IAgentEventActorContextMeta } from './convo';

export type SubagentTaskControlAction =
  | 'steer'
  | 'queue'
  | 'interrupt'
  | 'cancel'
  | 'cancel_message';

export type SubagentTaskControlReceiptStatus =
  | 'reserved'
  | 'accepted'
  | 'applied'
  | 'rejected'
  | 'failed';

export type SubagentTriggerProjection = {
  version: 1;
  eventType: string;
  sourceType: string;
  occurredAt: Date;
  expectedActionToolName?: string;
};

/** Server-private durable receipt for one parent-to-child control invocation. */
export interface ISubagentTaskControlReceipt {
  invocationId: string;
  fingerprint: string;
  controlId?: string;
  action: SubagentTaskControlAction;
  status: SubagentTaskControlReceiptStatus;
  createdAt: Date;
  updatedAt: Date;
  boundary?: 'preempt' | 'tool' | 'turn';
  reason?: string;
  message?: string;
  messageTruncated?: boolean;
}

/** Server-derived body dependencies, never accepted from message request fields. */
export type SourceRetentionContext = Readonly<{
  sourceFileIds: readonly string[];
  sourceExpiresAt: Date;
}>;

/** Server-private field lineage; an empty persisted array remains a no-revival fence. */
export type QuoteSourceRetention = {
  index: number;
  sourceRef: QuoteSourceRef;
  sourceFileIds: string[];
  sourceExpiresAt: Date;
};

/** Prepared by the owned resolver, never accepted from HTTP metadata. Dates stay Dates. */
export type ResolvedQuoteRetention = {
  quotes: string[];
  quoteSourceRetention: QuoteSourceRetention[];
  /** Transient exact snapshots touched in the same transaction as first materialization. */
  sourceMessageConditions: Array<{ messageId: string; messageVersion: number | null }>;
};

export type RetainedTextAllocation = { fileId: string; bytes: number };

// @ts-ignore
export interface IMessage extends Document {
  __v?: number;
  /** Derived public references to this saved quote snapshot; not a persistence authority. */
  quoteSourceRefs?: Array<QuoteSourceRef | null>;
  quoteSourceRetention?: QuoteSourceRetention[];
  sourceFileIds?: string[];
  sourceExpiresAt?: Date;
  sourceContentRemovedAt?: Date;
  /** Private receipts; only the transactional Message/File owners may resize these. */
  retainedTextAllocations?: RetainedTextAllocation[];
  messageId: string;
  conversationId: string;
  user: string;
  model?: string;
  endpoint?: string;
  conversationSignature?: string;
  clientId?: string;
  invocationId?: number;
  parentMessageId?: string | null;
  tokenCount?: number;
  summaryTokenCount?: number;
  sender?: string;
  text?: string;
  summary?: string;
  /** Authenticated ciphertext, available only through the owner-view read. */
  privateText?: string;
  privacyRevision?: string;
  privateTextTokens?: string[];
  isCreatedByUser: boolean;
  /** True when the complete stored row came from outside the model. */
  isUserSubmitted?: boolean;
  /** JSON pointers to caller-authored fields in an otherwise mixed model response. */
  userSubmittedPaths?: string[];
  /** Exact HITL message fields stored at caller-authored paths in a mixed response. */
  userSubmittedMessageFieldPaths?: UserSubmittedMessageFieldPath[];
  isTemporary?: boolean;
  unfinished?: boolean;
  error?: boolean;
  finish_reason?: string;
  feedback?: {
    rating: TFeedbackRating;
    tag: TFeedbackTag | undefined;
    text?: string;
  };
  langfuseSampled?: boolean;
  langfuseDestinationIds?: string[];
  /** The run whose trace this response reports, when that run's id is not the message's own (a failed turn's error row). */
  langfuseRunId?: string;
  _meiliIndex?: boolean;
  files?: unknown[];
  plugin?: {
    latest?: string;
    inputs?: unknown[];
    outputs?: string;
  };
  plugins?: unknown[];
  content?: unknown[];
  thread_id?: string;
  iconURL?: string;
  addedConvo?: boolean;
  metadata?: Record<string, unknown>;
  /** Server-private canonical message delta for durable subagent-thread continuation. */
  subagentTranscript?: {
    taskId: string;
    mode: 'append' | 'replace';
    messagesJson: string;
  };
  /** Server-private bounded rendering projection derived once at child settlement. */
  subagentActivityProjection?: {
    taskId: string;
    version: 1;
    activityJson: string;
    truncated: boolean;
  };
  /** Server-private durable idempotency marker for one detached subagent turn. */
  subagentTask?: {
    attemptKey: string;
    /** Parent response that initiated this exact child task. */
    parentRunId?: string;
    requestFingerprint?: string;
    status: 'running' | 'completed' | 'error' | 'cancelled';
    resultClaim?: {
      kind: 'manual' | 'wakeup';
      claimId: string;
      claimedAt: Date;
      /** Response generation that owns a manual delivery claim. */
      generationId?: string;
    };
    controlReceipts?: ISubagentTaskControlReceipt[];
  };
  subagentTriggerProjection?: SubagentTriggerProjection;
  contextMeta?: Partial<IAgentEventActorContextMeta>;
  attachments?: unknown[];
  /** Skills the user invoked manually via the `$` popover on this turn. UI-only metadata for `SkillPills`. */
  manualSkills?: string[];
  /**
   * Skills auto-primed on this turn via `always-apply` frontmatter. Persisted
   * at turn time so pinned badges survive later flips of the skill's
   * `alwaysApply` flag — the audit trail follows what actually ran, not what
   * the current catalog says.
   */
  alwaysAppliedSkills?: string[];
  /** Verbatim excerpts the user quoted to reference on this turn. UI-only metadata for `MessageQuotes`. */
  quotes?: string[];
  /** Request-scoped reasoning selection that produced this user turn. */
  reasoningOverride?: TReasoningOverride;
  expiredAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
  tenantId?: string;
}
