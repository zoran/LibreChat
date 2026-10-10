import type { FilterQuery, Model } from 'mongoose';
import type { IConversation, IMessage } from '~/types';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { refreshChatProjectStatsForUser } from './chatProject';

export interface ConversationImportCleanupScope {
  user: string;
  conversationIds: readonly string[];
  tenantId?: string;
}

export interface ConversationImportMethods {
  deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void>;
  deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void>;
}

/** Keeps generated UUID arrays well below MongoDB's 16 MiB command limit. */
export const CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE = 10_000;

function createImportCleanupFilter<T>(
  scope: ConversationImportCleanupScope,
  conversationIds: readonly string[],
): FilterQuery<T> {
  return {
    user: scope.user,
    conversationId: { $in: conversationIds },
    ...(scope.tenantId == null ? { tenantId: { $exists: false } } : { tenantId: scope.tenantId }),
  };
}

function chunkConversationIds(conversationIds: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (
    let index = 0;
    index < conversationIds.length;
    index += CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE
  ) {
    chunks.push(conversationIds.slice(index, index + CONVERSATION_IMPORT_CLEANUP_CHUNK_SIZE));
  }
  return chunks;
}

export function createConversationImportMethods(
  mongoose: typeof import('mongoose'),
): ConversationImportMethods {
  async function deleteImportedMessages(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Message = mongoose.models.Message as Model<IMessage>;
    await runAsSystem(async () => {
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        const result = await Message.deleteMany(
          createImportCleanupFilter<IMessage>(scope, conversationIds),
        );
        if (result?.acknowledged !== true)
          throw new Error('Imported message cleanup was not acknowledged');
      }
    });
  }

  async function deleteImportedConversations(scope: ConversationImportCleanupScope): Promise<void> {
    if (scope.conversationIds.length === 0) {
      return;
    }
    const Conversation = mongoose.models.Conversation as Model<IConversation>;
    const projectIds = await runAsSystem(async () => {
      const affectedProjectIds = new Set<string>();
      for (const conversationIds of chunkConversationIds(scope.conversationIds)) {
        const filter = createImportCleanupFilter<IConversation>(scope, conversationIds);
        const affectedProjects = await Conversation.distinct('chatProjectId', filter);
        for (const projectId of affectedProjects) {
          if (projectId) {
            affectedProjectIds.add(String(projectId));
          }
        }
        const result = await Conversation.deleteMany(filter);
        if (result?.acknowledged !== true)
          throw new Error('Imported conversation cleanup was not acknowledged');
      }
      return [...affectedProjectIds];
    });
    const context = tenantStorage.getStore();
    await tenantStorage.run(
      { ...context, tenantId: scope.tenantId, userId: scope.user },
      async () => {
        const results = await Promise.allSettled(
          projectIds.map((projectId) =>
            refreshChatProjectStatsForUser(mongoose, scope.user, projectId),
          ),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed?.status === 'rejected') throw failed.reason;
      },
    );
  }

  return { deleteImportedMessages, deleteImportedConversations };
}
