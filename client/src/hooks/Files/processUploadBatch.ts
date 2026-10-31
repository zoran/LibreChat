/** processUploadBatch owns queued file admission, preparation and dispatch for every upload source. */
import { v4 } from 'uuid';
import {
  UPLOAD_MAX_FILE_BYTES,
  getEndpointFileConfig,
  mergeFileConfig,
} from 'librechat-data-provider';
import type { EndpointFileConfig } from 'librechat-data-provider';
import type { useToastContext } from '@librechat/client';
import type React from 'react';
import type { useManagedUploads } from '~/features/uploads/useManagedUploads';
import type { UploadLifecycleCallbacks } from './useFileHandling';
import type { SkippedUpload, UploadPartition } from '~/utils';
import type useClientResize from './useClientResize';
import type useLocalize from '~/hooks/useLocalize';
import type useUpdateFiles from './useUpdateFiles';
import type { ExtendedFile } from '~/common';
import {
  validateFiles,
  cachePreview,
  partitionUploads,
  validateFileSizes,
  validateFileLimit,
  removePreviewEntry,
  validateFileDuplicates,
} from '~/utils';
import { runManagedSelection } from '~/features/uploads/transfer';
import { importWithRecovery } from '~/lib/assets/lazy';

type ProcessedUpload = {
  extendedFile: ExtendedFile;
  preview: string;
  resizeDetails?: {
    originalSize: number;
    newSize: number;
    compressionRatio: number;
  };
};

/** Current render dependencies; mutable admission is reread after the shared queue wait. */
type UploadBatchContext = {
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  managedUploads: ReturnType<typeof useManagedUploads>;
  setError: (error: string) => void;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  isConversationUpload: boolean;
  managedEpochRef: React.MutableRefObject<number>;
  managedEndingRef: React.MutableRefObject<boolean>;
  managedIdentityRef: React.MutableRefObject<string>;
  addFile: ReturnType<typeof useUpdateFiles>['addFile'];
  updateFileById: ReturnType<typeof useUpdateFiles>['updateFileById'];
  replaceFile: ReturnType<typeof useUpdateFiles>['replaceFile'];
  deleteFileById: ReturnType<typeof useUpdateFiles>['deleteFileById'];
  filesRef: React.MutableRefObject<Map<string, ExtendedFile>>;
  tracksReservations: boolean;
  uploadScope: { recent: Map<string, ExtendedFile> };
  fileConfigRef: React.MutableRefObject<ReturnType<typeof mergeFileConfig> | null>;
  agentProvider: string | null | undefined;
  endpoint: string;
  agentEndpointType: string | null | undefined;
  endpointType: string | null | undefined;
  showToast: ReturnType<typeof useToastContext>['showToast'];
  localize: ReturnType<typeof useLocalize>;
  resizeImageIfNeeded: ReturnType<typeof useClientResize>['resizeImageIfNeeded'];
  reportSkippedUploads: (skipped: SkippedUpload[], config: EndpointFileConfig) => void;
  loadImage: (file: ExtendedFile, preview: string, lifecycle?: UploadLifecycleCallbacks) => void;
  startUpload: (file: ExtendedFile, lifecycle?: UploadLifecycleCallbacks) => Promise<unknown>;
};

export const mergeRecentUploads = (
  files: Map<string, ExtendedFile>,
  recent: Map<string, ExtendedFile>,
): Map<string, ExtendedFile> => {
  if (recent.size === 0) {
    return files;
  }

  const merged = new Map(files);
  for (const [file_id, extendedFile] of recent) {
    if (!merged.has(file_id)) {
      merged.set(file_id, extendedFile);
    }
  }
  return merged;
};

/** Processes one selection without replacing existing ownership, recovery or validation rules. */
export async function processUploadBatch(
  context: UploadBatchContext,
  fileList: File[],
  _toolResource?: string,
  uploadLifecycle?: UploadLifecycleCallbacks,
): Promise<boolean> {
  const {
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
  } = context;
  abortControllerRef.current = new AbortController();

  if (managedUploads.enabled) {
    if (!managedUploads.eligible) {
      setError('com_upload_login_needed');
      setFilesLoading(false);
      return false;
    }
    // This runs after queue/config waits. A local recovery id is not an admitted reservation.
    const admissionsPaused = managedUploads.getAdmissionsPaused();
    if (admissionsPaused !== false) {
      let admissionError: Parameters<typeof setError>[0] = 'com_upload_status_unavailable';
      if (admissionsPaused === true) admissionError = 'com_upload_admission_paused';
      else if (managedUploads.storageAvailability?.available === false) {
        admissionError = 'com_upload_storage_unavailable';
        if (managedUploads.storageAvailability.reason === 'storage-stale')
          admissionError = 'com_upload_storage_stale';
      }
      setError(admissionError);
      setFilesLoading(false);
      return false;
    }
    const formats: Record<string, string> = {
      txt: 'text/plain',
      csv: 'text/csv',
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    if (
      !isConversationUpload ||
      _toolResource ||
      fileList.length > 20 ||
      fileList.some(
        (file) =>
          file.size < 1 ||
          file.size > UPLOAD_MAX_FILE_BYTES ||
          !formats[file.name.split('.').pop()?.toLowerCase() ?? ''],
      )
    ) {
      setError('com_upload_unsupported');
      setFilesLoading(false);
      return false;
    }
    const selected = fileList.map(
      (file, index): ExtendedFile => ({
        file,
        file_id: index === 0 && uploadLifecycle?.fileId ? uploadLifecycle.fileId : v4(),
        filename: file.name,
        type: formats[file.name.split('.').pop()!.toLowerCase()],
        size: file.size,
        progress: 0,
        managedUpload: { phase: 'selected' },
      }),
    );
    for (const file of selected) addFile(file);
    const signal = abortControllerRef.current.signal;
    const identity = managedUploads.sessionKey;
    const epoch = managedEpochRef.current;
    const current = () =>
      !managedEndingRef.current &&
      managedEpochRef.current === epoch &&
      managedIdentityRef.current === identity &&
      uploadLifecycle?.shouldCommit?.() !== false;
    await runManagedSelection(selected, {
      signal,
      current,
      update: updateFileById,
      refresh: managedUploads.refresh,
      ready: managedUploads.waitForReady,
      onStart: uploadLifecycle?.onStart,
      onSuccess: uploadLifecycle?.onSuccess,
      onError: uploadLifecycle?.onError,
      onAbort: uploadLifecycle?.onAbort,
    });
    if (current()) setFilesLoading(false);
    return selected.length > 0;
  }

  const existingFiles = tracksReservations
    ? mergeRecentUploads(filesRef.current, uploadScope.recent)
    : filesRef.current;
  const currentFileConfig = fileConfigRef.current;
  const endpointFileConfig = getEndpointFileConfig({
    endpoint: agentProvider ?? endpoint,
    fileConfig: currentFileConfig,
    endpointType: agentProvider != null ? agentEndpointType : endpointType,
  });
  /** The source remains visible until success, so exclude only its matching entry from this
   * upload's validation tallies. All other callers validate against the complete file map. */
  const filesForValidation = (() => {
    const replacesFileId = uploadLifecycle?.replacesFileId;
    if (replacesFileId == null || replacesFileId === '') {
      return existingFiles;
    }
    const withoutSource = new Map(existingFiles);
    for (const [key, existingFile] of existingFiles) {
      if (
        key === replacesFileId ||
        existingFile.file_id === replacesFileId ||
        existingFile.temp_file_id === replacesFileId
      ) {
        withoutSource.delete(key);
        break;
      }
    }
    return withoutSource;
  })();

  /** Drop duplicates one by one rather than rejecting everything picked alongside them, and hand
   * the survivors to `validateFiles`. Sizes wait for the partition below, once processing has
   * settled each file's final bytes, which is also where the file count is finally applied: a
   * file still headed for the discard pile must not spend a `fileLimit` slot. */
  const selection = partitionUploads({
    files: filesForValidation,
    fileList,
    endpointFileConfig,
    skipSizeValidation: true,
  });
  /** Nothing survived, so the whole selection is rejected and the untouched list reports it
   * through the usual checks in their usual order. */
  const acceptedFileList =
    selection.keptIndices.length > 0
      ? selection.keptIndices.map((index) => fileList[index])
      : fileList;

  /* Validate files */
  let filesAreValid: boolean;
  try {
    filesAreValid = validateFiles({
      files: filesForValidation,
      fileList: acceptedFileList,
      setError,
      fileConfig: currentFileConfig,
      endpointFileConfig,
      toolResource: _toolResource,
      skipSizeValidation: true,
      skipBatchRules: selection.keptIndices.length > 0,
    });
  } catch (error) {
    console.error('file validation error', error);
    setError('com_error_files_validation');
    setFilesLoading(false);
    return false;
  }
  if (!filesAreValid) {
    setFilesLoading(false);
    return false;
  }

  /* Process files */
  const processedUploads: ProcessedUpload[] = [];
  for (const [fileIndex, originalFile] of acceptedFileList.entries()) {
    const file_id =
      fileIndex === 0 && uploadLifecycle?.fileId != null && uploadLifecycle.fileId !== ''
        ? uploadLifecycle.fileId
        : v4();
    try {
      // Create initial preview with original file
      const initialPreview = URL.createObjectURL(originalFile);
      cachePreview(file_id, initialPreview);

      // Create initial ExtendedFile to show immediately
      const initialExtendedFile: ExtendedFile = {
        file_id,
        file: originalFile,
        type: originalFile.type,
        preview: initialPreview,
        progress: 0.1, // Show as processing
        size: originalFile.size,
      };

      if (_toolResource != null && _toolResource !== '') {
        initialExtendedFile.tool_resource = _toolResource;
      }

      // Add file immediately to show in UI
      addFile(initialExtendedFile);

      const originalFileName = originalFile.name.toLowerCase();

      // Check if HEIC conversion is needed and show toast
      const isHEIC =
        originalFile.type === 'image/heic' ||
        originalFile.type === 'image/heif' ||
        /\.(heic|heif)$/.test(originalFileName);

      if (isHEIC) {
        showToast({
          message: localize('com_info_heic_converting'),
          status: 'info',
          duration: 3000,
        });
      }

      const heicProcessedFile = isHEIC
        ? await importWithRecovery(() => import('~/utils/heicConverter')).then(
            ({ processFileForUpload }) =>
              processFileForUpload(originalFile, 0.9, (conversionProgress) => {
                const adjustedProgress = 0.1 + conversionProgress * 0.4;
                replaceFile({
                  ...initialExtendedFile,
                  progress: adjustedProgress,
                });
              }),
          )
        : originalFile;

      let finalProcessedFile = heicProcessedFile;
      let resizeDetails: ProcessedUpload['resizeDetails'];

      // Apply client-side resizing if available and appropriate
      if (heicProcessedFile.type.startsWith('image/')) {
        try {
          const resizeResult = await resizeImageIfNeeded(heicProcessedFile);
          finalProcessedFile = resizeResult.file;

          if (resizeResult.resized && resizeResult.result) {
            const { originalSize, newSize, compressionRatio } = resizeResult.result;
            resizeDetails = { originalSize, newSize, compressionRatio };
          }
        } catch (resizeError) {
          console.warn('Image resize failed, using original:', resizeError);
          // Continue with HEIC processed file if resizing fails
        }
      }

      // If file was processed (HEIC converted or resized), update with new file and preview
      if (finalProcessedFile !== originalFile) {
        URL.revokeObjectURL(initialPreview); // Clean up original preview
        const newPreview = URL.createObjectURL(finalProcessedFile);
        cachePreview(file_id, newPreview);

        const updatedExtendedFile: ExtendedFile = {
          ...initialExtendedFile,
          file: finalProcessedFile,
          type: finalProcessedFile.type,
          preview: newPreview,
          progress: 0.5, // Processing complete, ready for upload
          size: finalProcessedFile.size,
        };

        replaceFile(updatedExtendedFile);
        processedUploads.push({
          extendedFile: updatedExtendedFile,
          preview: newPreview,
          resizeDetails,
        });
      } else {
        // Update progress to show ready for upload
        const readyExtendedFile = {
          ...initialExtendedFile,
          progress: 0.2,
        };
        replaceFile(readyExtendedFile);
        processedUploads.push({
          extendedFile: readyExtendedFile,
          preview: initialPreview,
          resizeDetails,
        });
      }
    } catch (error) {
      deleteFileById(file_id);
      console.log('file handling error', error);
      if (error instanceof Error && error.message.includes('HEIC')) {
        setError('com_error_heic_conversion');
      } else {
        setError('com_error_files_process');
      }
    }
  }

  const discardProcessedUpload = ({ extendedFile, preview }: ProcessedUpload) => {
    deleteFileById(extendedFile.file_id);
    removePreviewEntry(extendedFile.file_id);
    URL.revokeObjectURL(preview);
  };

  const discardProcessedUploads = () => {
    for (const upload of processedUploads) {
      discardProcessedUpload(upload);
    }
    filesRef.current = existingFiles;
  };

  const processedFileList = processedUploads.map(({ extendedFile }) => extendedFile.file as File);

  let batch: UploadPartition;
  let acceptedUploads: ProcessedUpload[];
  try {
    batch = partitionUploads({
      files: filesForValidation,
      fileList: processedFileList,
      endpointFileConfig,
    });
    acceptedUploads = batch.keptIndices.map((index) => processedUploads[index]);
    const acceptedFiles = acceptedUploads.map(({ extendedFile }) => extendedFile.file as File);
    /** `fileLimit` and `totalSizeLimit` describe the batch rather than any one file, so both are
     * applied to whatever survived the per-file partition above. */
    const batchIsValid =
      acceptedUploads.length > 0 &&
      validateFileLimit({
        files: filesForValidation,
        fileList: acceptedFiles,
        setError,
        endpointFileConfig,
      }) &&
      validateFileSizes({
        files: filesForValidation,
        fileList: acceptedFiles,
        setError,
        endpointFileConfig,
      });
    if (!batchIsValid) {
      /** Nothing is left to upload, so this is the pre-existing all-or-nothing rejection and it
       * keeps reporting itself that way instead of as per-file skip notices. */
      if (acceptedUploads.length === 0) {
        const noDuplicates = validateFileDuplicates({
          files: filesForValidation,
          fileList: processedFileList,
          setError,
        });
        if (noDuplicates) {
          validateFileSizes({
            files: filesForValidation,
            fileList: processedFileList,
            setError,
            endpointFileConfig,
          });
        }
      }
      discardProcessedUploads();
      setFilesLoading(false);
      return false;
    }
  } catch (error) {
    console.error('file validation error', error);
    setError('com_error_files_validation');
    discardProcessedUploads();
    setFilesLoading(false);
    return false;
  }

  for (const { index } of batch.skipped) {
    discardProcessedUpload(processedUploads[index]);
  }
  /** Held until the batch is known to be uploading: a selection that is rejected in full reports
   * itself through the batch-level errors alone, never alongside a partial-success notice. */
  reportSkippedUploads([...selection.skipped, ...batch.skipped], endpointFileConfig);

  const filesWithProcessedUploads = new Map(existingFiles);
  for (const { extendedFile } of acceptedUploads) {
    filesWithProcessedUploads.set(extendedFile.file_id, extendedFile);
    if (tracksReservations) {
      uploadScope.recent.set(extendedFile.file_id, extendedFile);
    }
  }
  filesRef.current = filesWithProcessedUploads;

  for (const { extendedFile, preview, resizeDetails } of acceptedUploads) {
    if (resizeDetails) {
      const { originalSize, newSize, compressionRatio } = resizeDetails;
      showToast({
        message: localize('com_info_image_resized', {
          0: (originalSize / (1024 * 1024)).toFixed(1),
          1: (newSize / (1024 * 1024)).toFixed(1),
          2: Math.round((1 - compressionRatio) * 100),
        }),
        status: 'success',
        duration: 3000,
      });
    }

    if (extendedFile.file?.type.startsWith('image/') === true) {
      loadImage(extendedFile, preview, uploadLifecycle);
      continue;
    }

    await startUpload(extendedFile, uploadLifecycle);
  }

  return acceptedUploads.length > 0;
}
