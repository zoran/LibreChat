/** useFileHandling owns shared upload queues, lifecycle callbacks and composer state. */
import React, { useCallback, useEffect, useRef, useMemo, useState } from 'react';
import debounce from 'lodash/debounce';
import { useSetRecoilState } from 'recoil';
import { useToastContext } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import {
  megabyte,
  QueryKeys,
  Constants,
  EToolResources,
  mergeFileConfig,
  isAssistantsEndpoint,
  defaultAssistantsVersion,
} from 'librechat-data-provider';
import type {
  TError,
  EModelEndpoint,
  TEndpointsConfig,
  EndpointFileConfig,
} from 'librechat-data-provider';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import type { SkippedUpload } from '~/utils';
import { logger, cachePreview, getCachedPreview, removePreviewEntry } from '~/utils';
import { useGetFileConfig, useUploadFileMutation } from '~/data-provider';
import { useManagedUploads } from '~/features/uploads/useManagedUploads';
import useAgentUploadTarget from '~/hooks/Agents/useAgentUploadTarget';
import useLocalize, { TranslationKeys } from '~/hooks/useLocalize';
import { useChatSettings } from '~/Providers/ChatSettingsContext';
import { useDelayedUploadToast } from './useDelayedUploadToast';
import { processUploadBatch } from './processUploadBatch';
import { useChatContext } from '~/Providers/ChatContext';
import { ephemeralAgentByConvoId } from '~/store';
import useClientResize from './useClientResize';
import useUpdateFiles from './useUpdateFiles';

type UseFileHandling = {
  fileSetter?: FileSetter;
  fileFilter?: (file: File) => boolean;
  additionalMetadata?: Record<string, string | undefined>;
  /** Overrides `endpoint` for upload routing; also used as `endpointType` fallback when `endpointTypeOverride` is not set */
  endpointOverride?: EModelEndpoint | string;
  /** Overrides `endpointType` independently from `endpointOverride` */
  endpointTypeOverride?: EModelEndpoint | string;
};

export type FileHandlingState = {
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  conversation?: TConversation | null;
};

export type UploadLifecycleCallbacks = {
  /** Preassigned id so callers can persist recovery before the shared upload queue waits. */
  fileId?: string;
  /** An attachment being replaced remains in state until the replacement succeeds, but should not
   * count against this upload's file and total-size limits. */
  replacesFileId?: string;
  /** Read once the queue and config waits are over, immediately before the batch is written into
   * the shared file state. A `false` return abandons the batch so a delayed upload cannot land in
   * a composer the user has since navigated away from. */
  shouldCommit?: () => boolean;
  onStart?: (fileId: string) => void;
  onSuccess?: (fileId: string) => void;
  onError?: (fileId: string) => void;
  onAbort?: (fileId: string) => void;
};

const noop = () => {};
const uploadErrorCallbacks = new Map<string, UploadLifecycleCallbacks>();

const takeUploadRecovery = (fileId: string): UploadLifecycleCallbacks | undefined => {
  const callbacks = uploadErrorCallbacks.get(fileId);
  uploadErrorCallbacks.delete(fileId);
  return callbacks;
};

export const clearUploadRecovery = (fileId: string) => {
  takeUploadRecovery(fileId)?.onAbort?.(fileId);
};

export const hasInFlightUpload = (fileId: string): boolean => uploadErrorCallbacks.has(fileId);

type UploadScope = {
  queue: Promise<void>;
  /** Accepted uploads that have not been observed in the shared file state yet */
  recent: Map<string, ExtendedFile>;
};

/**
 * Upload batches are validated against the file map they write to, so every hook instance
 * sharing a setter (attachment menu, paste routing, SharePoint) must share one queue.
 */
const uploadScopes = new WeakMap<FileSetter, UploadScope>();

const getUploadScope = (fileSetter: FileSetter): UploadScope => {
  const scope = uploadScopes.get(fileSetter);
  if (scope != null) {
    return scope;
  }

  const created: UploadScope = { queue: Promise.resolve(), recent: new Map() };
  uploadScopes.set(fileSetter, created);
  return created;
};

const useFileHandlingCore = (params: UseFileHandling | undefined, fileState: FileHandlingState) => {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const { showToast } = useToastContext();
  const [errors, setErrors] = useState<string[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { startUploadTimer, clearUploadTimer } = useDelayedUploadToast();
  const { files, setFiles, conversation } = fileState;
  const filesRef = useRef(files);
  filesRef.current = files;
  const fileSetter = params?.fileSetter ?? setFiles;
  const uploadScope = getUploadScope(fileSetter);
  /** Reservations are only observable when the rendered state is the state being written */
  const tracksReservations = fileSetter === setFiles;
  if (tracksReservations) {
    for (const file_id of uploadScope.recent.keys()) {
      if (files.has(file_id)) {
        uploadScope.recent.delete(file_id);
      }
    }
  }
  const setFilesLoading = fileState.setFilesLoading ?? noop;
  const setEphemeralAgent = useSetRecoilState(
    ephemeralAgentByConvoId(conversation?.conversationId ?? Constants.NEW_CONVO),
  );
  const { isTemporary } = useChatSettings();
  const setError = (error: string) => setErrors((prevErrors) => [...prevErrors, error]);

  /** Names the files left out of a batch that is otherwise still uploading. Callers report a batch
   * rejected in full through the existing all-or-nothing errors instead. */
  const reportSkippedUploads = (
    skipped: SkippedUpload[],
    endpointFileConfig: EndpointFileConfig,
  ) => {
    if (skipped.length === 0) {
      return;
    }
    const duplicates: string[] = [];
    const oversized: string[] = [];
    for (const { file, reason } of skipped) {
      if (reason === 'duplicate') {
        duplicates.push(file.name);
        continue;
      }
      oversized.push(file.name);
    }
    if (duplicates.length > 0) {
      setError(localize('com_error_files_skipped_dupe', { 0: duplicates.join(', ') }));
    }
    if (oversized.length > 0) {
      setError(
        localize('com_error_files_skipped_size', {
          0: `${(endpointFileConfig.fileSizeLimit ?? 0) / megabyte}`,
          1: oversized.join(', '),
        }),
      );
    }
  };
  const { addFile, replaceFile, updateFileById, deleteFileById } = useUpdateFiles(fileSetter);
  const managedUploads = useManagedUploads();
  const managedIdentityRef = useRef(managedUploads.sessionKey);
  managedIdentityRef.current = managedUploads.sessionKey;
  const managedEndingRef = useRef(false);
  const managedEpochRef = useRef(0);
  useEffect(() => {
    managedEndingRef.current = false;
    const end = () => {
      managedEndingRef.current = true;
      managedEpochRef.current++;
      abortControllerRef.current?.abort();
    };
    const resume = () => {
      managedEndingRef.current = false;
    };
    window.addEventListener('librechat:auth-session-ending', end);
    window.addEventListener('librechat:auth-session-continued', resume);
    return () => {
      end();
      window.removeEventListener('librechat:auth-session-ending', end);
      window.removeEventListener('librechat:auth-session-continued', resume);
    };
  }, [managedUploads.sessionKey]);
  const { isConfigPending, waitForConfig, resizeImageIfNeeded } = useClientResize();

  const agent_id = params?.additionalMetadata?.agent_id ?? '';
  const assistant_id = params?.additionalMetadata?.assistant_id ?? '';
  const isConversationUpload = !agent_id && !assistant_id;
  const endpointOverride = params?.endpointOverride;
  const endpointTypeOverride = params?.endpointTypeOverride;
  const endpointType = useMemo(
    () => endpointTypeOverride ?? endpointOverride ?? conversation?.endpointType,
    [endpointTypeOverride, endpointOverride, conversation?.endpointType],
  );
  const endpoint = useMemo(
    () => endpointOverride ?? conversation?.endpoint ?? 'default',
    [endpointOverride, conversation?.endpoint],
  );
  const uploadTarget = useAgentUploadTarget(conversation);
  /** An agent's file policy lives under its provider, which is the entry the server
   *  validates against. An explicit override names its own endpoint and keeps it. */
  const agentProvider = endpointOverride != null ? undefined : uploadTarget.agentProvider;
  const agentEndpointType = endpointOverride != null ? undefined : uploadTarget.endpointType;
  const usesResponsesApi = uploadTarget.useResponsesApi;

  const { data: fileConfig = null } = useGetFileConfig({
    select: (data) => mergeFileConfig(data),
  });
  const fileConfigRef = useRef(fileConfig);
  fileConfigRef.current = fileConfig;

  const displayToast = useCallback(() => {
    if (errors.length > 1) {
      // TODO: this should not be a dynamic localize input!!
      const errorList = Array.from(new Set(errors))
        .map((e, i) => `${i > 0 ? '• ' : ''}${localize(e as TranslationKeys) || e}\n`)
        .join('');
      showToast({
        message: errorList,
        status: 'error',
        duration: 5000,
      });
    } else if (errors.length === 1) {
      // TODO: this should not be a dynamic localize input!!
      const message = localize(errors[0] as TranslationKeys) || errors[0];
      showToast({
        message,
        status: 'error',
        duration: 5000,
      });
    }

    setErrors([]);
  }, [errors, showToast, localize]);

  const debouncedDisplayToast = useMemo(() => debounce(displayToast, 250), [displayToast]);

  useEffect(() => {
    if (errors.length > 0) {
      debouncedDisplayToast();
    }

    return () => debouncedDisplayToast.cancel();
  }, [errors, debouncedDisplayToast]);

  const uploadFile = useUploadFileMutation(
    {
      onSuccess: (data, body) => {
        /** Every client-side handle for this upload — the file map key, the delayed
         * toast timer, the recovery callbacks — is the id the request was sent with.
         * `temp_file_id` is the server's echo of it, so trusting the echo turns any
         * mismatch into a completion update applied to a key that does not exist:
         * the attachment stays below `progress: 1` and the send button never
         * re-enables. Reconcile against the id we own. */
        const fileId = (body.get('file_id') as string | null) ?? data.temp_file_id;
        takeUploadRecovery(fileId)?.onSuccess?.(fileId);
        clearUploadTimer(fileId);
        if (agent_id) {
          queryClient.refetchQueries([QueryKeys.agent, agent_id]);
          return;
        }
        updateFileById(
          fileId,
          {
            progress: 0.9,
            filepath: data.filepath,
          },
          assistant_id ? true : false,
        );

        setTimeout(() => {
          const cachedBlob = getCachedPreview(fileId);
          if (cachedBlob && data.file_id !== fileId) {
            cachePreview(data.file_id, cachedBlob);
            removePreviewEntry(fileId);
          }
          updateFileById(
            fileId,
            {
              progress: 1,
              file_id: data.file_id,
              /** The stored temporary id has to stay the one this entry is keyed
               * by: removal reads `file_id` and `temp_file_id` off the value and
               * deletes those keys, and the draft restore correlates the cached
               * record by the key it saved. Keeping the server's echo here would
               * leave a chip that Remove deletes server-side but cannot clear. */
              temp_file_id: fileId,
              filepath: data.filepath,
              type: data.type,
              height: data.height,
              width: data.width,
              filename: data.filename,
              source: data.source,
              embedded: data.embedded,
              llmDeliveryPath: data.llmDeliveryPath,
            },
            assistant_id ? true : false,
          );
        }, 300);
      },
      onError: (_error, body) => {
        const error = _error as TError | undefined;
        console.log('upload error', error);
        const file_id = body.get('file_id') as string;
        const uploadLifecycle = takeUploadRecovery(file_id);
        const tool_resource = body.get('tool_resource');
        if (tool_resource === EToolResources.execute_code) {
          setEphemeralAgent((prev) => ({
            ...prev,
            [EToolResources.execute_code]: false,
          }));
        }
        clearUploadTimer(file_id);
        deleteFileById(file_id);

        let errorMessage = 'com_error_files_upload';

        if (error?.code === 'ERR_CANCELED') {
          errorMessage = 'com_error_files_upload_canceled';
        } else if (error?.response?.data?.message) {
          errorMessage = error.response.data.message;
        }
        setError(errorMessage);
        uploadLifecycle?.onError?.(file_id);
      },
    },
    abortControllerRef.current?.signal,
  );

  const uploadWithRecovery = (
    formData: FormData,
    file_id: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ) => {
    if (uploadLifecycle) {
      uploadErrorCallbacks.set(file_id, uploadLifecycle);
      uploadLifecycle.onStart?.(file_id);
    }
    uploadFile.mutate(formData);
  };

  const startUpload = async (
    extendedFile: ExtendedFile,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ) => {
    const filename = extendedFile.file?.name ?? 'File';
    startUploadTimer(extendedFile.file_id, filename, extendedFile.size);

    const formData = new FormData();
    formData.append('endpoint', endpoint);
    formData.append('endpointType', endpointType ?? '');
    /* Azure carries native documents only through the Responses API, so routing needs to
     * know which one this conversation uses. A saved agent holds the setting on its own
     * record when the conversation does not carry one, which is the same fallback the
     * attach menu and the drop handler resolve. */
    if (usesResponsesApi === true) {
      formData.append('useResponsesApi', 'true');
    }
    formData.append('file', extendedFile.file as File, encodeURIComponent(filename));
    formData.append('file_id', extendedFile.file_id);
    if (
      isConversationUpload &&
      conversation?.conversationId &&
      conversation.conversationId !== Constants.NEW_CONVO
    ) {
      formData.append('conversationId', conversation.conversationId);
    }
    if (isTemporary && isConversationUpload) {
      formData.append('isTemporary', 'true');
    }

    const width = extendedFile.width ?? 0;
    const height = extendedFile.height ?? 0;
    if (width) {
      formData.append('width', width.toString());
    }
    if (height) {
      formData.append('height', height.toString());
    }

    const metadata = params?.additionalMetadata ?? {};
    if (params?.additionalMetadata) {
      for (const [key, value = ''] of Object.entries(metadata)) {
        if (value) {
          formData.append(key, value);
        }
      }
    }

    if (!isAssistantsEndpoint(endpointType ?? endpoint)) {
      if (!agent_id) {
        formData.append('message_file', 'true');
      }
      const tool_resource = extendedFile.tool_resource;
      if (tool_resource != null) {
        formData.append('tool_resource', tool_resource);
      }
      if (conversation?.agent_id != null && formData.get('agent_id') == null) {
        formData.append('agent_id', conversation.agent_id);
      }

      uploadWithRecovery(formData, extendedFile.file_id, uploadLifecycle);
      return;
    }

    const convoModel = conversation?.model ?? '';
    const convoAssistantId = conversation?.assistant_id ?? '';

    if (!assistant_id) {
      formData.append('message_file', 'true');
    }

    const endpointsConfig = queryClient.getQueryData<TEndpointsConfig>([QueryKeys.endpoints]);
    const version = endpointsConfig?.[endpoint]?.version ?? defaultAssistantsVersion[endpoint];

    if (!assistant_id && convoAssistantId) {
      formData.append('version', version);
      formData.append('model', convoModel);
      formData.append('assistant_id', convoAssistantId);
    }

    const formVersion = (formData.get('version') ?? '') as string;
    if (!formVersion) {
      formData.append('version', version);
    }

    const formModel = (formData.get('model') ?? '') as string;
    if (!formModel) {
      formData.append('model', convoModel);
    }

    uploadWithRecovery(formData, extendedFile.file_id, uploadLifecycle);
  };

  const loadImage = (
    extendedFile: ExtendedFile,
    preview: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ) => {
    const img = new Image();
    img.onload = async () => {
      const measuredFile: ExtendedFile = {
        ...extendedFile,
        width: img.width,
        height: img.height,
        progress: 0.6,
      };
      replaceFile(measuredFile);

      await startUpload(measuredFile, uploadLifecycle);
    };
    /** The upload only starts once the browser has decoded the image, so a decode
     * it refuses (unsupported codec, truncated bytes, a revoked object URL) would
     * otherwise strand the attachment below `progress: 1` — which reads as "still
     * uploading" and keeps the composer's send button disabled for the rest of the
     * session, with nothing to click and no error to explain it. Drop the file and
     * say so instead. */
    img.onerror = () => {
      clearUploadTimer(extendedFile.file_id);
      takeUploadRecovery(extendedFile.file_id)?.onError?.(extendedFile.file_id);
      deleteFileById(extendedFile.file_id);
      /** Reservations are released by the render that observes the file in the
       * shared state, which a decode failing before that render never reaches —
       * and once the file is gone no later render can either. A leaked one is
       * merged into every subsequent batch's validation, so re-picking the same
       * file reads as a duplicate and its size keeps counting against the limit. */
      uploadScope.recent.delete(extendedFile.file_id);
      removePreviewEntry(extendedFile.file_id);
      URL.revokeObjectURL(preview);
      setError('com_error_files_process');
    };
    img.src = preview;
  };

  /** Resolves to whether the files passed validation and were accepted for upload. */
  const processFiles = (
    fileList: File[],
    _toolResource?: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ) =>
    processUploadBatch(
      {
        abortControllerRef,
        managedUploads,
        setError,
        setFilesLoading,
        isConversationUpload,
        managedEpochRef,
        managedEndingRef,
        managedIdentityRef,
        addFile,
        updateFileById,
        replaceFile,
        deleteFileById,
        filesRef,
        tracksReservations,
        uploadScope,
        fileConfigRef,
        agentProvider,
        endpoint,
        agentEndpointType,
        endpointType,
        showToast,
        localize,
        resizeImageIfNeeded,
        reportSkippedUploads,
        loadImage,
        startUpload,
      },
      fileList,
      _toolResource,
      uploadLifecycle,
    );

  const handleFiles = async (
    _files: FileList | File[],
    _toolResource?: string,
    uploadLifecycle?: UploadLifecycleCallbacks,
  ): Promise<boolean> => {
    /** `FileList` is live: copy it before yielding, as callers reset the input synchronously */
    const fileList = Array.from(_files);
    const assignedFileId = uploadLifecycle?.fileId;
    if (assignedFileId) {
      uploadErrorCallbacks.set(assignedFileId, uploadLifecycle);
    }
    /** Started before queueing so every waiting batch shares one bounded config window */
    const configReady = isConfigPending ? waitForConfig() : undefined;
    const previousProcessing = uploadScope.queue;
    let releaseProcessing: () => void = () => undefined;
    uploadScope.queue = new Promise<void>((resolve) => {
      releaseProcessing = resolve;
    });

    try {
      await previousProcessing;
      await configReady;
      if (uploadLifecycle?.shouldCommit?.() === false) {
        if (assignedFileId) {
          takeUploadRecovery(assignedFileId);
        }
        setFilesLoading(false);
        return false;
      }
      const accepted = await processFiles(fileList, _toolResource, uploadLifecycle);
      if (!accepted && assignedFileId) {
        takeUploadRecovery(assignedFileId);
      }
      return accepted;
    } catch (error) {
      if (assignedFileId) {
        takeUploadRecovery(assignedFileId);
      }
      throw error;
    } finally {
      releaseProcessing();
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>, _toolResource?: string) => {
    event.stopPropagation();
    if (event.target.files) {
      setFilesLoading(true);
      handleFiles(event.target.files, _toolResource);
      // reset the input
      event.target.value = '';
    }
  };

  const abortUpload = (fileId?: string) => {
    if (abortControllerRef.current) {
      logger.log('files', 'Aborting upload');
      abortControllerRef.current.abort('User aborted upload');
      abortControllerRef.current = null;
    }
    if (fileId) {
      clearUploadRecovery(fileId);
      return;
    }
    for (const uploadId of Array.from(uploadErrorCallbacks.keys())) {
      clearUploadRecovery(uploadId);
    }
  };

  return {
    handleFileChange,
    handleFiles,
    abortUpload,
    setFiles,
    files,
  };
};

export const useFileHandlingNoChatContext = (
  params: UseFileHandling | undefined,
  fileState: FileHandlingState,
) => useFileHandlingCore(params, fileState);

const useFileHandling = (params?: UseFileHandling) => {
  const { files, setFiles, setFilesLoading, conversation } = useChatContext();

  return useFileHandlingCore(params, {
    files,
    setFiles,
    conversation,
    setFilesLoading,
  });
};

export default useFileHandling;
