/** AttachFile keeps the upload action visible and explains independent disabled causes. */
import React, { useRef } from 'react';
import { FileUpload, TooltipAnchor, AttachmentIcon } from '@librechat/client';
import type { TConversation } from 'librechat-data-provider';
import type { ExtendedFile, FileSetter } from '~/common';
import { useShortcutAriaKey, useShortcutHint } from '~/hooks/useKeyboardShortcuts';
import { UploadAvailabilityHint } from '~/features/uploads/UploadAvailabilityHint';
import { useManagedUploads } from '~/features/uploads/useManagedUploads';
import { useFileHandlingNoChatContext, useLocalize } from '~/hooks';
import { cn } from '~/utils';

const AttachFile = ({
  disabled,
  files,
  setFiles,
  setFilesLoading,
  conversation,
}: {
  disabled?: boolean | null;
  files: Map<string, ExtendedFile>;
  setFiles: FileSetter;
  setFilesLoading: React.Dispatch<React.SetStateAction<boolean>>;
  conversation: TConversation | null;
}) => {
  const localize = useLocalize();
  const inputRef = useRef<HTMLInputElement>(null);
  const uploads = useManagedUploads();
  let reason: string | null = null;
  if (uploads.newUploadError) reason = localize(uploads.newUploadError);
  else if (disabled) reason = localize('com_ui_attach_error_disabled');
  const isUploadDisabled = !!reason;
  const blockedNow = () => !!disabled || (uploads.enabled && !!uploads.getNewUploadError());
  const tooltipDescription = useShortcutHint('uploadFile', localize('com_sidepanel_attach_files'));
  const ariaKey = useShortcutAriaKey('uploadFile');

  const { handleFileChange } = useFileHandlingNoChatContext(undefined, {
    files,
    setFiles,
    setFilesLoading,
    conversation,
  });

  return (
    <FileUpload ref={inputRef} handleFileChange={handleFileChange}>
      <UploadAvailabilityHint label={localize('com_sidepanel_attach_files')} reason={reason}>
        <TooltipAnchor
          description={tooltipDescription}
          id="attach-file"
          disabled={isUploadDisabled}
          render={
            <button
              type="button"
              aria-label={localize('com_sidepanel_attach_files')}
              aria-keyshortcuts={ariaKey}
              disabled={isUploadDisabled}
              className={cn(
                isUploadDisabled &&
                  'text-text-tertiary pointer-events-none cursor-not-allowed opacity-50',
                'size-theme-control rounded-theme-control-round duration-theme-fast hover:bg-surface-composer-hover focus-visible:ring-text-primary/50 flex items-center justify-center p-1 transition-colors focus-visible:ring-2 focus-visible:outline-hidden',
              )}
              onKeyDownCapture={(e) => {
                if (blockedNow() || !inputRef.current) {
                  return;
                }
                if (e.key === 'Enter' || e.key === ' ') {
                  inputRef.current.value = '';
                  inputRef.current.click();
                }
              }}
              onClick={() => {
                if (blockedNow() || !inputRef.current) {
                  return;
                }
                inputRef.current.value = '';
                inputRef.current.click();
              }}
            >
              <div className="flex w-full items-center justify-center gap-2">
                <AttachmentIcon />
              </div>
            </button>
          }
        />
      </UploadAvailabilityHint>
    </FileUpload>
  );
};

export default React.memo(AttachFile);
