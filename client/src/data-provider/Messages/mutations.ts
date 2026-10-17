import { useCallback, useRef } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  dataService,
  QueryKeys,
  MutationKeys,
  Constants,
  readArtifactSource,
} from 'librechat-data-provider';
import type { UseMutationResult, UseMutationOptions } from '@tanstack/react-query';
import type * as t from 'librechat-data-provider';
import type { Artifact, ArtifactRevision, ArtifactSourceIdentity } from '~/common/artifacts';
import { fetchConversationMessages } from './queries';

type EditArtifactContext = {
  previousMessages: Record<string, t.TMessage[] | undefined>;
  updatedConversationId: string | null;
};

export const useEditArtifact = (
  _options?: t.EditArtifactOptions,
): UseMutationResult<
  t.TEditArtifactResponse,
  Error,
  t.TEditArtifactRequest,
  EditArtifactContext
> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, onMutate: userOnMutate, ...options } = _options ?? {};

  const mutationOptions: UseMutationOptions<
    t.TEditArtifactResponse,
    Error,
    t.TEditArtifactRequest,
    EditArtifactContext
  > = {
    mutationKey: [MutationKeys.editArtifact],
    mutationFn: (variables: t.TEditArtifactRequest) => dataService.editArtifact(variables),
    /**
     * onMutate: No optimistic updates for artifact editing
     * The code editor shows changes instantly via local Sandpack state
     * Optimistic updates cause "original content not found" errors because:
     * 1. First edit optimistically updates cache
     * 2. Artifact.content reflects the updated cache
     * 3. Next edit sends updated content as "original" → doesn't match DB → error
     */
    onMutate: async (vars) => {
      // Call user's onMutate if provided
      if (userOnMutate) {
        await userOnMutate(vars);
      }
      return { previousMessages: {}, updatedConversationId: null };
    },
    onError: (error, vars, context) => {
      onError?.(error, vars, context);
    },
    /**
     * On success: Update with server response to ensure consistency
     */
    onSuccess: (data, vars, context) => {
      let targetNotFound = true;
      const setMessageData = (conversationId?: string | null) => {
        if (!conversationId) {
          return;
        }
        queryClient.setQueryData<t.TMessage[]>([QueryKeys.messages, conversationId], (prev) => {
          if (!prev) {
            return prev;
          }

          const newArray = [...prev];
          let targetIndex: number | undefined;

          for (let i = newArray.length - 1; i >= 0; i--) {
            if (newArray[i].messageId === vars.messageId) {
              targetIndex = i;
              targetNotFound = false;
              break;
            }
          }

          if (targetIndex == null) {
            return prev;
          }

          const previous = newArray[targetIndex];
          const previousVersion = (previous as t.TMessage & { __v?: number }).__v;
          // A refresh that already observed a newer revision must not be rolled back by a late save reply.
          if (typeof previousVersion === 'number' && previousVersion > data.__v) return prev;
          const metadata = { ...previous.metadata };
          delete metadata.sourceCoverage;
          newArray[targetIndex] = {
            ...newArray[targetIndex],
            content: data.content,
            text: data.text,
            __v: data.__v,
            metadata: previous.metadata == null ? previous.metadata : metadata,
          };

          return newArray;
        });
      };
      setMessageData(data.conversationId);
      if (targetNotFound) {
        console.warn(
          'Edited Artifact Message not found in cache, trying `new` as `conversationId`',
        );
        setMessageData(Constants.NEW_CONVO as string);
      }

      onSuccess?.(data, vars, context);
    },
    ...options,
    // A stale revision needs a user decision; mutation defaults must never retry it.
    retry: false,
  };

  return useMutation(mutationOptions);
};

/** Refresh only through the native authenticated messages query; never infer an artifact from its title. */
export function useRefreshArtifact(
  artifact: Artifact,
  conversationId: string | null | undefined,
  expectedSource?: ArtifactSourceIdentity | null,
) {
  const queryClient = useQueryClient();
  const key = `${conversationId ?? ''}/${artifact.id}/${artifact.messageId ?? ''}/${artifact.index ?? ''}`;
  const initial = useRef<{
    key: string;
    source: ArtifactSourceIdentity | null;
    version?: number | null;
  } | null>(null);
  if (initial.current?.key !== key) {
    const message = queryClient
      .getQueryData<t.TMessage[]>([QueryKeys.messages, conversationId])
      ?.find((item) => item.messageId === artifact.messageId);
    const captured =
      message && artifact.index != null ? readArtifactSource(message, artifact.index) : null;
    const version = (message as (t.TMessage & { __v?: unknown }) | undefined)?.__v;
    initial.current = {
      key,
      version:
        message != null &&
        captured != null &&
        (version == null ||
          (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0))
          ? (version ?? null)
          : undefined,
      source:
        captured == null
          ? null
          : { header: captured.header, source: captured.source, partIndex: captured.partIndex },
    };
  }
  const found = initial.current.source;
  const source = expectedSource === undefined ? found : expectedSource;
  const load = useCallback(async (): Promise<ArtifactRevision> => {
    if (
      source == null ||
      !conversationId ||
      conversationId === Constants.NEW_CONVO ||
      artifact.index == null ||
      !artifact.messageId
    ) {
      throw new Error('Artifact revision unavailable');
    }
    let refreshed: t.TMessage[] | undefined;
    const queryKey = [QueryKeys.messages, conversationId];
    await queryClient.fetchQuery<t.TMessage[]>(
      queryKey,
      async () => {
        const before = queryClient.getQueryData<t.TMessage[]>(queryKey);
        const result = await fetchConversationMessages(conversationId);
        refreshed = result;
        const current = queryClient.getQueryData<t.TMessage[]>(queryKey);
        // Match the native messages query: an overlapping stream/update owns its newer cache.
        return current != null && current !== before ? current : result;
      },
      { staleTime: 0 },
    );
    // A deduplicated unrelated query is not this explicit comparison's authenticated snapshot.
    if (refreshed == null) throw new Error('Artifact revision unavailable');
    const message = refreshed.find((item) => item.messageId === artifact.messageId);
    const fresh = message == null ? null : readArtifactSource(message, artifact.index);
    const version = (message as (t.TMessage & { __v?: unknown }) | undefined)?.__v;
    if (
      !fresh ||
      fresh.header !== source.header ||
      fresh.source !== source.source ||
      fresh.partIndex !== source.partIndex ||
      !(
        version === undefined ||
        version === null ||
        (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)
      )
    ) {
      throw new Error('Artifact revision unavailable');
    }
    return {
      messageId: artifact.messageId,
      index: artifact.index,
      content: fresh.content,
      version: version ?? null,
    };
  }, [artifact.index, artifact.messageId, conversationId, queryClient, source]);
  const readCurrent = useCallback(() => {
    const message = queryClient
      .getQueryData<t.TMessage[]>([QueryKeys.messages, conversationId])
      ?.find((item) => item.messageId === artifact.messageId);
    const current =
      message != null && artifact.index != null
        ? readArtifactSource(message, artifact.index)
        : null;
    const version = (message as (t.TMessage & { __v?: unknown }) | undefined)?.__v;
    if (
      current == null ||
      !(
        version == null ||
        (typeof version === 'number' && Number.isSafeInteger(version) && version >= 0)
      )
    )
      return null;
    return { ...current, version: version ?? null };
  }, [artifact.index, artifact.messageId, conversationId, queryClient]);
  return {
    load,
    readCurrent,
    version: initial.current.version,
    source:
      source == null
        ? null
        : { header: source.header, source: source.source, partIndex: source.partIndex },
  };
}

type BranchMessageContext = {
  previousMessages: t.TMessage[] | undefined;
  conversationId: string | null;
};

export const useBranchMessageMutation = (
  conversationId: string | null,
  _options?: t.BranchMessageOptions,
): UseMutationResult<
  t.TBranchMessageResponse,
  Error,
  t.TBranchMessageRequest,
  BranchMessageContext
> => {
  const queryClient = useQueryClient();
  const { onSuccess, onError, onMutate: userOnMutate, ...options } = _options ?? {};

  const mutationOptions: UseMutationOptions<
    t.TBranchMessageResponse,
    Error,
    t.TBranchMessageRequest,
    BranchMessageContext
  > = {
    mutationFn: (variables: t.TBranchMessageRequest) => dataService.branchMessage(variables),
    onMutate: async (vars) => {
      // Call user's onMutate if provided
      if (userOnMutate) {
        await userOnMutate(vars);
      }

      // Cancel any outgoing queries for messages
      if (conversationId) {
        await queryClient.cancelQueries([QueryKeys.messages, conversationId]);
      }

      // Get the previous messages for rollback
      const previousMessages = conversationId
        ? queryClient.getQueryData<t.TMessage[]>([QueryKeys.messages, conversationId])
        : undefined;

      return { previousMessages, conversationId };
    },
    onError: (error, vars, context) => {
      // Rollback to previous messages on error
      if (context?.conversationId && context?.previousMessages) {
        queryClient.setQueryData(
          [QueryKeys.messages, context.conversationId],
          context.previousMessages,
        );
      }
      onError?.(error, vars, context);
    },
    onSuccess: (data, vars, context) => {
      // Add the new message to the cache
      const targetConversationId = data.conversationId || context?.conversationId;
      if (targetConversationId) {
        queryClient.setQueryData<t.TMessage[]>(
          [QueryKeys.messages, targetConversationId],
          (prev) => {
            if (!prev) {
              return [data];
            }
            return [...prev, data];
          },
        );
      }

      onSuccess?.(data, vars, context);
    },
    ...options,
  };

  return useMutation(mutationOptions);
};
