/** Message owns artifact capture; File owns source approval and its transactional retention fences. */
import { readArtifactSource, UPLOAD_DERIVED_MAX_SOURCES } from 'librechat-data-provider';
import type { ClientSession, Model } from 'mongoose';
import type {
  IMessage,
  MessageArtifactSourceInput,
  CapturedMessageArtifactSource,
} from '~/types/message';
import type { FileOwnerScope } from './file';
import { FileSourceUnavailableError, fileSourceScope, touchFileSources } from './fileRetention';
import { approvedFileFilter } from './fileSecurity';
import { activeExpirationFilter } from '~/utils/retention';

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function sourceIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > UPLOAD_DERIVED_MAX_SOURCES ||
    !value.every(identifier) ||
    new Set(value).size !== value.length
  )
    throw new FileSourceUnavailableError();
  return [...value];
}

function liveDeadline(value: unknown, now: number): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= now)
    throw new FileSourceUnavailableError();
  return value.getTime();
}

function snapshotInput(value: MessageArtifactSourceInput): MessageArtifactSourceInput {
  if (value == null || typeof value !== 'object') throw new FileSourceUnavailableError();
  const fields = Object.getOwnPropertyDescriptors(value);
  const keys = ['conversationId', 'messageId', 'expectedVersion', 'artifactIndex'] as const;
  if (keys.some((key) => !fields[key] || !('value' in fields[key])))
    throw new FileSourceUnavailableError();
  const input: Record<string, unknown> = Object.fromEntries(
    keys.map((key) => [key, fields[key].value]),
  );
  if (
    !identifier(input.conversationId) ||
    !identifier(input.messageId) ||
    (input.expectedVersion !== null &&
      (typeof input.expectedVersion !== 'number' ||
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 0)) ||
    typeof input.artifactIndex !== 'number' ||
    !Number.isSafeInteger(input.artifactIndex) ||
    input.artifactIndex < 0
  )
    throw new FileSourceUnavailableError();
  return input as MessageArtifactSourceInput;
}

export function createMessageArtifactSourceMethods(mongoose: typeof import('mongoose')): {
  captureMessageArtifactSource(
    owner: FileOwnerScope,
    input: MessageArtifactSourceInput,
    session: ClientSession,
  ): Promise<CapturedMessageArtifactSource>;
} {
  async function captureMessageArtifactSource(
    ownerValue: FileOwnerScope,
    value: MessageArtifactSourceInput,
    session: ClientSession,
  ): Promise<CapturedMessageArtifactSource> {
    const input = snapshotInput(value);
    const owner = { userId: ownerValue.userId, tenantId: ownerValue.tenantId };
    const scope = fileSourceScope(owner);
    if (!session?.inTransaction() || session.hasEnded) throw new FileSourceUnavailableError();
    const Message = mongoose.models.Message as Model<IMessage>;
    const filter = {
      ...scope,
      conversationId: input.conversationId,
      messageId: input.messageId,
      __v: input.expectedVersion === null ? { $exists: false } : input.expectedVersion,
      sourceContentRemovedAt: null,
      ...activeExpirationFilter<IMessage>(),
    };
    // The Mongo driver rejects sessions belonging to another client before this query can run.
    const row = await Message.findOne(filter)
      .select(
        'messageId conversationId __v text content unfinished error sourceFileIds sourceExpiresAt quotes files attachments +quoteSourceRetention +privateText',
      )
      .session(session)
      .lean<IMessage>();
    if (!row || row.unfinished === true || row.error === true || row.privateText != null)
      throw new FileSourceUnavailableError();
    const now = Date.now();
    const ids = new Set(sourceIds(row.sourceFileIds));
    const deadlines = [liveDeadline(row.sourceExpiresAt, now)];
    const quotes = row.quotes ?? [];
    const bindings = row.quoteSourceRetention ?? [];
    if (!Array.isArray(quotes) || !Array.isArray(bindings) || bindings.length !== quotes.length)
      throw new FileSourceUnavailableError();
    const indices = new Set<number>();
    for (const binding of bindings) {
      if (
        !binding ||
        !Number.isSafeInteger(binding.index) ||
        binding.index < 0 ||
        binding.index >= quotes.length ||
        typeof quotes[binding.index] !== 'string' ||
        indices.has(binding.index) ||
        !identifier(binding.sourceRef?.messageId) ||
        (binding.sourceRef.quoteIndex != null &&
          (!Number.isSafeInteger(binding.sourceRef.quoteIndex) ||
            binding.sourceRef.quoteIndex < 0 ||
            !Number.isSafeInteger(binding.sourceRef.messageVersion) ||
            binding.sourceRef.messageVersion! < 0))
      )
        throw new FileSourceUnavailableError();
      indices.add(binding.index);
      for (const id of sourceIds(binding.sourceFileIds)) ids.add(id);
      deadlines.push(liveDeadline(binding.sourceExpiresAt, now));
    }
    for (const references of [row.files, row.attachments]) {
      if (references == null) continue;
      if (!Array.isArray(references) || references.length > UPLOAD_DERIVED_MAX_SOURCES)
        throw new FileSourceUnavailableError();
      for (const reference of references) {
        const id = (reference as { file_id?: unknown } | null)?.file_id;
        if (!identifier(id)) throw new FileSourceUnavailableError();
        ids.add(id);
      }
    }
    if (ids.size > UPLOAD_DERIVED_MAX_SOURCES) throw new FileSourceUnavailableError();
    const artifact = readArtifactSource(
      row as Parameters<typeof readArtifactSource>[0],
      input.artifactIndex,
    );
    if (!artifact) throw new FileSourceUnavailableError();
    const sourceFileIds = [...ids].sort();
    // Approval is mandatory even when ordinary upload-management feature flags are disabled.
    const approved = await mongoose.models.File.find({
      ...scope,
      file_id: { $in: sourceFileIds },
      retentionAcceptedAt: { $ne: null },
      status: 'ready',
      ...approvedFileFilter(undefined, now),
    })
      .select('file_id')
      .session(session)
      .lean();
    if (approved.length !== sourceFileIds.length) throw new FileSourceUnavailableError();
    const touched = await Message.updateOne(
      { ...filter, ...activeExpirationFilter<IMessage>() },
      { $inc: { __v: 1 } },
      {
        session,
        timestamps: false,
      },
    );
    if (touched.matchedCount !== 1) throw new FileSourceUnavailableError();
    const context = await touchFileSources(mongoose, owner, sourceFileIds, session);
    if (!context || context.sourceFileIds.length !== sourceFileIds.length)
      throw new FileSourceUnavailableError();
    deadlines.push(context.sourceExpiresAt.getTime());
    const sourceExpiresAt = new Date(Math.min(...deadlines));
    liveDeadline(sourceExpiresAt, Date.now());
    const { source, partIndex, content, header } = artifact;
    return {
      anchor: {
        conversationId: input.conversationId,
        messageId: input.messageId,
        messageVersion: input.expectedVersion,
        artifactIndex: input.artifactIndex,
        source,
        ...(partIndex === undefined ? {} : { partIndex }),
      },
      artifact: { content, header },
      sourceFileIds,
      sourceExpiresAt,
    };
  }
  return { captureMessageArtifactSource };
}
