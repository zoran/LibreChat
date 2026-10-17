/** Complete Message/quote custody shared by native artifact and checkpoint capture. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { UPLOAD_DERIVED_MAX_SOURCES } from 'librechat-data-provider';
import type { ClientSession, Model } from 'mongoose';
import type { IMessage } from '~/types/message';
import type { FileOwnerScope } from '~/types/file';
import type { CapturedCheckpointMessage } from '~/types/checkpointSource';
import { FileSourceUnavailableError, fileSourceScope } from './fileRetention';
import { activeExpirationFilter } from '~/utils/retention';

export const MESSAGE_SOURCE_BYTES: number = 4 * 1024 * 1024;

/** Bounded JSON data only; accessors, proxies, custom serializers and sparse arrays fail closed. */
export function encodeSourceValue(
  input: unknown,
  maximum: number = MESSAGE_SOURCE_BYTES,
): { json: string; bytes: number; value: unknown } {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  function token(value: string): string {
    bytes += Buffer.byteLength(value);
    if (bytes > maximum) throw new FileSourceUnavailableError();
    return value;
  }
  function visit(value: unknown, depth: number): string {
    if (++nodes > 100000 || depth > 64) throw new FileSourceUnavailableError();
    if (value === null || typeof value === 'boolean' || typeof value === 'string')
      return token(JSON.stringify(value));
    if (typeof value === 'number' && Number.isFinite(value)) return token(JSON.stringify(value));
    if (!value || typeof value !== 'object' || types.isProxy(value) || ancestors.has(value))
      throw new FileSourceUnavailableError();
    const array = Array.isArray(value);
    if (
      !array &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new FileSourceUnavailableError();
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(fields).some((key) => typeof key !== 'string'))
      throw new FileSourceUnavailableError();
    const keys = Object.keys(fields).filter((key) => !(array && key === 'length'));
    if (keys.some((key) => !('value' in fields[key]) || !fields[key].enumerable))
      throw new FileSourceUnavailableError();
    if (array && (keys.length !== value.length || keys.some((key, i) => key !== String(i))))
      throw new FileSourceUnavailableError();
    ancestors.add(value);
    const open = token(array ? '[' : '{');
    const entries = (array ? keys : keys.sort()).map(
      (key, index) =>
        (index ? token(',') : '') +
        (array ? '' : token(JSON.stringify(key)) + token(':')) +
        visit(fields[key].value, depth + 1),
    );
    ancestors.delete(value);
    return open + entries.join('') + token(array ? ']' : '}');
  }
  const json = visit(input, 0);
  bytes = Buffer.byteLength(json);
  if (bytes > maximum) throw new FileSourceUnavailableError();
  return { json, bytes, value: JSON.parse(json) };
}

export function sourceSha256(value: unknown, maximum: number = MESSAGE_SOURCE_BYTES): string {
  return createHash('sha256').update(encodeSourceValue(value, maximum).json).digest('hex');
}

export function sourceIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

export function messageSourceIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > UPLOAD_DERIVED_MAX_SOURCES ||
    !value.every(sourceIdentifier) ||
    new Set(value).size !== value.length
  )
    throw new FileSourceUnavailableError();
  return [...value].sort();
}

export function liveSourceDeadline(value: unknown, now: number = Date.now()): number {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() <= now)
    throw new FileSourceUnavailableError();
  return value.getTime();
}

export type CompleteMessageSource = {
  row: IMessage;
  snapshot: CapturedCheckpointMessage;
  sourceFileIds: string[];
  sourceExpiresAt: Date;
  bodySha256: string;
  bytes: number;
};

export async function readCompleteMessageSource(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  reference: { conversationId: string; messageId: string; expectedVersion?: number | null },
  session: ClientSession,
): Promise<CompleteMessageSource> {
  if (!session?.inTransaction() || session.hasEnded) throw new FileSourceUnavailableError();
  const Message = mongoose.models.Message as Model<IMessage>;
  const row = await Message.findOne({
    ...fileSourceScope(owner),
    conversationId: reference.conversationId,
    messageId: reference.messageId,
    ...(reference.expectedVersion === undefined
      ? {}
      : {
          __v: reference.expectedVersion === null ? { $exists: false } : reference.expectedVersion,
        }),
    sourceContentRemovedAt: null,
    ...activeExpirationFilter<IMessage>(),
  })
    .select(
      'messageId conversationId __v text content unfinished error expiredAt sourceFileIds sourceExpiresAt quotes files attachments +quoteSourceRetention +privateText',
    )
    .session(session)
    .lean<IMessage>();
  if (
    !row ||
    row.unfinished === true ||
    row.error === true ||
    row.privateText != null ||
    (row.text !== undefined && typeof row.text !== 'string') ||
    (row.content !== undefined && !Array.isArray(row.content)) ||
    (row.__v != null && (!Number.isSafeInteger(row.__v) || row.__v < 0))
  )
    throw new FileSourceUnavailableError();
  const ids = new Set(messageSourceIds(row.sourceFileIds));
  const deadlines = [liveSourceDeadline(row.sourceExpiresAt)];
  const quotes = row.quotes ?? [];
  const bindings = row.quoteSourceRetention ?? [];
  if (
    !Array.isArray(quotes) ||
    !quotes.every((quote) => typeof quote === 'string') ||
    !Array.isArray(bindings) ||
    bindings.length !== quotes.length
  )
    throw new FileSourceUnavailableError();
  const indices = new Set<number>();
  const quoteBindings = bindings
    .map((binding) => {
      if (
        !binding ||
        !Number.isSafeInteger(binding.index) ||
        binding.index < 0 ||
        binding.index >= quotes.length ||
        indices.has(binding.index) ||
        !sourceIdentifier(binding.sourceRef?.messageId) ||
        (binding.sourceRef.quoteIndex != null &&
          (!Number.isSafeInteger(binding.sourceRef.quoteIndex) ||
            binding.sourceRef.quoteIndex < 0 ||
            !Number.isSafeInteger(binding.sourceRef.messageVersion) ||
            binding.sourceRef.messageVersion! < 0))
      )
        throw new FileSourceUnavailableError();
      indices.add(binding.index);
      const sourceFileIds = messageSourceIds(binding.sourceFileIds);
      sourceFileIds.forEach((id) => ids.add(id));
      deadlines.push(liveSourceDeadline(binding.sourceExpiresAt));
      return {
        index: binding.index,
        sourceRef: binding.sourceRef,
        sourceFileIds,
        sourceExpiresAt: binding.sourceExpiresAt.toISOString(),
      };
    })
    .sort((a, b) => a.index - b.index);
  for (const references of [row.files, row.attachments]) {
    if (references == null) continue;
    if (!Array.isArray(references) || references.length > UPLOAD_DERIVED_MAX_SOURCES)
      throw new FileSourceUnavailableError();
    for (const reference of references) {
      const id = (reference as { file_id?: unknown } | null)?.file_id;
      if (!sourceIdentifier(id)) throw new FileSourceUnavailableError();
      ids.add(id);
    }
  }
  if (ids.size > UPLOAD_DERIVED_MAX_SOURCES) throw new FileSourceUnavailableError();
  const snapshot = {
    conversationId: row.conversationId,
    messageId: row.messageId,
    ...(row.text == null ? {} : { text: row.text }),
    ...(row.content == null ? {} : { content: row.content }),
    ...(row.quotes == null ? {} : { quotes: row.quotes }),
  };
  const encoded = encodeSourceValue(snapshot);
  const sourceFileIds = [...ids].sort();
  const sourceExpiresAt = new Date(Math.min(...deadlines));
  const bodySha256 = sourceSha256({
    snapshot,
    sourceFileIds,
    sourceExpiresAt: sourceExpiresAt.toISOString(),
    quoteBindings,
    files: row.files?.map((value) => (value as { file_id: string }).file_id) ?? null,
    attachments: row.attachments?.map((value) => (value as { file_id: string }).file_id) ?? null,
    expiredAt: row.expiredAt?.toISOString() ?? null,
  });
  return {
    row,
    snapshot: encoded.value as CapturedCheckpointMessage,
    sourceFileIds,
    sourceExpiresAt,
    bodySha256,
    bytes: encoded.bytes,
  };
}

/** The current actual version is a write fence, never a permanent content identity. */
export async function touchCompleteMessageSource(
  mongoose: typeof import('mongoose'),
  owner: FileOwnerScope,
  source: CompleteMessageSource,
  session: ClientSession,
): Promise<void> {
  const row = source.row;
  const result = await mongoose.models.Message.updateOne(
    {
      ...fileSourceScope(owner),
      conversationId: row.conversationId,
      messageId: row.messageId,
      __v: row.__v ?? { $exists: false },
      sourceContentRemovedAt: null,
      ...activeExpirationFilter<IMessage>(),
    },
    { $inc: { __v: 1 } },
    { session, timestamps: false },
  );
  if (result.matchedCount !== 1) throw new FileSourceUnavailableError();
}
