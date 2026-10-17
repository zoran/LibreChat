/** Message owns artifact capture; File owns source approval and its transactional retention fences. */
import { readArtifactSource } from 'librechat-data-provider';
import type { ClientSession } from 'mongoose';
import type { MessageArtifactSourceInput, CapturedMessageArtifactSource } from '~/types/message';
import type { FileOwnerScope } from './file';
import { FileSourceUnavailableError, fileSourceScope, touchFileSources } from './fileRetention';
import { approvedFileFilter } from './fileSecurity';
import {
  readCompleteMessageSource,
  touchCompleteMessageSource,
  liveSourceDeadline,
} from './messageSource';

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
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
    const sourceMessage = await readCompleteMessageSource(mongoose, owner, input, session);
    const { row, sourceFileIds } = sourceMessage;
    const now = Date.now();
    const deadlines = [sourceMessage.sourceExpiresAt.getTime()];
    const artifact = readArtifactSource(
      row as Parameters<typeof readArtifactSource>[0],
      input.artifactIndex,
    );
    if (!artifact) throw new FileSourceUnavailableError();
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
    await touchCompleteMessageSource(mongoose, owner, sourceMessage, session);
    const context = await touchFileSources(mongoose, owner, sourceFileIds, session);
    if (!context || context.sourceFileIds.length !== sourceFileIds.length)
      throw new FileSourceUnavailableError();
    deadlines.push(context.sourceExpiresAt.getTime());
    const sourceExpiresAt = new Date(Math.min(...deadlines));
    liveSourceDeadline(sourceExpiresAt, Date.now());
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
