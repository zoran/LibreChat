import { useRef, useState } from 'react';
import type { TFile } from 'librechat-data-provider';
import FilePreviewDialog from '~/components/Chat/Messages/Content/FilePreviewDialog';
import { useLocalize } from '~/hooks';

/** Opens the existing preview using only metadata from the authorized native file list. */
export default function FileSourceButton({ file }: { file: TFile }) {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="focus-visible:ring-text-primary min-w-0 self-center truncate rounded-sm text-left underline-offset-2 hover:underline focus-visible:ring-2"
        aria-label={localize('com_ui_composer_preview_file', { 0: file.filename })}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {file.filename}
      </button>
      <FilePreviewDialog
        open={open}
        onOpenChange={setOpen}
        fileId={file.file_id}
        fileName={file.filename}
        fileType={file.type}
        fileSource={file.source}
        fileSize={file.bytes}
        deliveryPath={file.llmDeliveryPath}
        triggerRef={triggerRef}
      />
    </>
  );
}
