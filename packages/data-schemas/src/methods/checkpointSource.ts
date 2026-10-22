/** Source custody joins the caller's native checkpoint transaction; no parallel store or reservation. */
import type { ClientSession } from 'mongoose';
import type {
  CapturedCheckpointSources,
  CheckpointSourceBinding,
  CheckpointSourceInput,
  CheckpointSourceMethods,
} from '~/types/checkpointSource';
import type { CompleteMessageSource } from './messageSource';
import type { FileOwnerScope } from '~/types/file';
import {
  encodeSourceValue,
  liveSourceDeadline,
  MESSAGE_SOURCE_BYTES,
  readCompleteMessageSource,
  sourceIdentifier,
  sourceSha256,
  touchCompleteMessageSource,
} from './messageSource';
import {
  FileSourceUnavailableError,
  fileSourceScope,
  inspectFileSources,
  touchFileSources,
} from './fileRetention';
import { touchActiveUserPrincipal } from './userPrincipal';

const MAX_BINDING_BYTES = 32768;
const MAX_SOURCES = 64;
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const version = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const referenceKey = (value: { conversationId: string; messageId: string }) =>
  JSON.stringify([value.conversationId, value.messageId]);

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  )
    throw new FileSourceUnavailableError();
  return value as Record<string, unknown>;
}

function ownerSnapshot(value: FileOwnerScope): { userId: string; tenantId: string | null } {
  const input = encodeSourceValue(value, 1024).value as FileOwnerScope;
  const keys = Object.keys(input);
  if (
    keys.some((key) => key !== 'userId' && key !== 'tenantId') ||
    typeof input.userId !== 'string' ||
    !/^[a-fA-F0-9]{24}$/.test(input.userId)
  )
    throw new FileSourceUnavailableError();
  const owner = { userId: input.userId, tenantId: input.tenantId ?? null };
  fileSourceScope(owner);
  return owner;
}

function transaction(mongoose: typeof import('mongoose'), session: ClientSession): void {
  // The native driver rejects a foreign client session on the first User write.
  if (
    !(session instanceof mongoose.mongo.ClientSession) ||
    session.hasEnded ||
    !session.inTransaction()
  )
    throw new FileSourceUnavailableError();
}

function identifiers(value: unknown, empty: boolean): string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_SOURCES ||
    (!empty && !value.length) ||
    !value.every(sourceIdentifier) ||
    new Set(value).size !== value.length
  )
    throw new FileSourceUnavailableError();
  return [...value];
}

function captureInput(value: CheckpointSourceInput): CheckpointSourceInput {
  const input = record(encodeSourceValue(value, MAX_BINDING_BYTES).value, ['messages', 'fileIds']);
  const fileIds = identifiers(input.fileIds, true).sort();
  if (!Array.isArray(input.messages) || input.messages.length > MAX_SOURCES)
    throw new FileSourceUnavailableError();
  const messages = input.messages
    .map((value) => {
      const reference = record(value, ['conversationId', 'messageId', 'expectedVersion']);
      if (
        !sourceIdentifier(reference.conversationId) ||
        !sourceIdentifier(reference.messageId) ||
        !version(reference.expectedVersion)
      )
        throw new FileSourceUnavailableError();
      return {
        conversationId: reference.conversationId,
        messageId: reference.messageId,
        expectedVersion: reference.expectedVersion,
      };
    })
    .sort((a, b) => compareIds(referenceKey(a), referenceKey(b)));
  if (
    (!fileIds.length && !messages.length) ||
    new Set(messages.map(referenceKey)).size !== messages.length
  )
    throw new FileSourceUnavailableError();
  return { messages, fileIds };
}

function deadline(value: unknown): number {
  if (typeof value !== 'string' || value.length !== 24) throw new FileSourceUnavailableError();
  const date = new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time) || date.toISOString() !== value)
    throw new FileSourceUnavailableError();
  return time;
}

/** Canonical immutable data only, including expired bindings for cleanup; never authorization. */
export function snapshotCheckpointSourceBinding(
  ownerValue: FileOwnerScope,
  value: CheckpointSourceBinding,
): CheckpointSourceBinding {
  const owner = ownerSnapshot(ownerValue);
  const binding = record(encodeSourceValue(value, MAX_BINDING_BYTES).value, [
    'version',
    'owner',
    'files',
    'messages',
    'expiresAt',
    'bindingSha256',
  ]);
  const principal = record(binding.owner, ['userId', 'tenantId']);
  if (
    binding.version !== 2 ||
    principal.userId !== owner.userId ||
    principal.tenantId !== owner.tenantId ||
    !hash(binding.bindingSha256) ||
    !Array.isArray(binding.files) ||
    !binding.files.length ||
    binding.files.length > MAX_SOURCES ||
    !Array.isArray(binding.messages) ||
    binding.messages.length > MAX_SOURCES
  )
    throw new FileSourceUnavailableError();
  const files = binding.files.map((value) => {
    const file = record(value, ['fileId', 'bindingSha256', 'expiresAt']);
    if (!sourceIdentifier(file.fileId) || !hash(file.bindingSha256))
      throw new FileSourceUnavailableError();
    deadline(file.expiresAt);
    return file as CheckpointSourceBinding['files'][number];
  });
  const fileIds = files.map((file) => file.fileId);
  if (
    new Set(fileIds).size !== fileIds.length ||
    fileIds.some((id, index) => id !== [...fileIds].sort()[index])
  )
    throw new FileSourceUnavailableError();
  const messages = binding.messages.map((value) => {
    const message = record(value, [
      'conversationId',
      'messageId',
      'capturedVersion',
      'bodySha256',
      'sourceFileIds',
      'expiresAt',
    ]);
    if (
      !sourceIdentifier(message.conversationId) ||
      !sourceIdentifier(message.messageId) ||
      !version(message.capturedVersion) ||
      !hash(message.bodySha256)
    )
      throw new FileSourceUnavailableError();
    const ids = identifiers(message.sourceFileIds, false);
    if (
      ids.some((id) => !fileIds.includes(id)) ||
      ids.some((id, index) => id !== [...ids].sort()[index])
    )
      throw new FileSourceUnavailableError();
    deadline(message.expiresAt);
    return message as CheckpointSourceBinding['messages'][number];
  });
  const messageKeys = messages.map(referenceKey);
  if (
    new Set(messageKeys).size !== messageKeys.length ||
    messageKeys.some((key, index) => index > 0 && messageKeys[index - 1] >= key)
  )
    throw new FileSourceUnavailableError();
  const earliest = Math.min(
    ...files.map((file) => deadline(file.expiresAt)),
    ...messages.map((message) => deadline(message.expiresAt)),
  );
  if (deadline(binding.expiresAt) !== earliest) throw new FileSourceUnavailableError();
  const { bindingSha256, ...payload } = binding;
  if (sourceSha256(payload, MAX_BINDING_BYTES) !== bindingSha256)
    throw new FileSourceUnavailableError();
  return freeze(binding as CheckpointSourceBinding);
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function messageWitness(
  source: CompleteMessageSource,
): CheckpointSourceBinding['messages'][number] {
  const expiresAt = new Date(
    Math.min(
      source.sourceExpiresAt.getTime(),
      source.row.expiredAt == null ? Infinity : liveSourceDeadline(source.row.expiredAt),
    ),
  ).toISOString();
  return {
    conversationId: source.row.conversationId,
    messageId: source.row.messageId,
    capturedVersion: source.row.__v ?? null,
    bodySha256: source.bodySha256,
    sourceFileIds: source.sourceFileIds,
    expiresAt,
  };
}

export function createCheckpointSourceMethods(
  mongoose: typeof import('mongoose'),
): CheckpointSourceMethods {
  async function filesFor(
    owner: FileOwnerScope,
    ids: readonly string[],
    session: ClientSession,
  ): Promise<CheckpointSourceBinding['files']> {
    if (!ids.length || ids.length > MAX_SOURCES) throw new FileSourceUnavailableError();
    const observed = await inspectFileSources(mongoose, owner, ids, session);
    if (observed.length !== ids.length) throw new FileSourceUnavailableError();
    return observed
      .map((file) => {
        if (file.state !== 'managed') throw new FileSourceUnavailableError();
        return {
          fileId: file.fileId,
          bindingSha256: file.sourceBindingSha256,
          expiresAt: new Date(liveSourceDeadline(file.sourceExpiresAt)).toISOString(),
        };
      })
      .sort((a, b) => compareIds(a.fileId, b.fileId));
  }

  async function captureCheckpointSources(
    ownerValue: FileOwnerScope,
    value: CheckpointSourceInput,
    session: ClientSession,
  ): Promise<CapturedCheckpointSources> {
    const owner = ownerSnapshot(ownerValue);
    const input = captureInput(value);
    transaction(mongoose, session);
    await touchActiveUserPrincipal(mongoose, owner, session);
    const sources: CompleteMessageSource[] = [];
    const ids = new Set(input.fileIds);
    let bytes = 0;
    for (const reference of input.messages) {
      const source = await readCompleteMessageSource(mongoose, owner, reference, session);
      bytes += source.bytes;
      if (bytes > MESSAGE_SOURCE_BYTES) throw new FileSourceUnavailableError();
      source.sourceFileIds.forEach((id) => ids.add(id));
      if (ids.size > MAX_SOURCES) throw new FileSourceUnavailableError();
      sources.push(source);
    }
    const files = await filesFor(owner, [...ids].sort(), session);
    const messages = sources.map(messageWitness);
    const payload = {
      version: 2 as const,
      owner,
      files,
      messages,
      expiresAt: new Date(
        Math.min(
          ...files.map((file) => deadline(file.expiresAt)),
          ...messages.map((message) => deadline(message.expiresAt)),
        ),
      ).toISOString(),
    };
    const binding = snapshotCheckpointSourceBinding(owner, {
      ...payload,
      bindingSha256: sourceSha256(payload, MAX_BINDING_BYTES),
    });
    liveSourceDeadline(new Date(binding.expiresAt));
    for (const source of sources)
      await touchCompleteMessageSource(mongoose, owner, source, session);
    const context = await touchFileSources(mongoose, owner, [...ids], session);
    if (!context || context.sourceFileIds.length !== ids.size)
      throw new FileSourceUnavailableError();
    liveSourceDeadline(new Date(binding.expiresAt));
    return { binding, messages: sources.map((source) => source.snapshot) };
  }

  async function fenceCheckpointSources(
    ownerValue: FileOwnerScope,
    value: CheckpointSourceBinding,
    session: ClientSession,
  ): Promise<void> {
    const owner = ownerSnapshot(ownerValue);
    const binding = snapshotCheckpointSourceBinding(owner, value);
    liveSourceDeadline(new Date(binding.expiresAt));
    transaction(mongoose, session);
    await touchActiveUserPrincipal(mongoose, owner, session);
    const sources: CompleteMessageSource[] = [];
    let bytes = 0;
    for (const reference of binding.messages) {
      const source = await readCompleteMessageSource(mongoose, owner, reference, session);
      bytes += source.bytes;
      if (bytes > MESSAGE_SOURCE_BYTES) throw new FileSourceUnavailableError();
      const current = messageWitness(source);
      if (
        current.bodySha256 !== reference.bodySha256 ||
        JSON.stringify(current.sourceFileIds) !== JSON.stringify(reference.sourceFileIds)
      )
        throw new FileSourceUnavailableError();
      sources.push(source);
    }
    const ids = binding.files.map((file) => file.fileId);
    const files = await filesFor(owner, ids, session);
    // Current liveness was checked by the owner; captured dates never become identity.
    if (
      files.some(
        (file, index) =>
          file.fileId !== binding.files[index].fileId ||
          file.bindingSha256 !== binding.files[index].bindingSha256,
      )
    )
      throw new FileSourceUnavailableError();
    for (const source of sources)
      await touchCompleteMessageSource(mongoose, owner, source, session);
    const context = await touchFileSources(mongoose, owner, ids, session);
    if (!context || context.sourceFileIds.length !== ids.length)
      throw new FileSourceUnavailableError();
    liveSourceDeadline(new Date(binding.expiresAt));
  }
  return { captureCheckpointSources, fenceCheckpointSources };
}
