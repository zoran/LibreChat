import { useEffect } from 'react';
import { useToastContext } from '@librechat/client';
import { EToolResources } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { ManagedUploadPanel, ManagedUploadCard } from '~/features/uploads/ManagedUploadPanel';
import { useManagedUploads } from '~/features/uploads/useManagedUploads';
import { useDeleteFilesMutation } from '~/data-provider';
import { logger, getCachedPreview } from '~/utils';
import { useFileDeletion } from '~/hooks/Files';
import FileContainer from './FileContainer';
import { useLocalize } from '~/hooks';
import Image from './Image';

/**
 * Shared wrapper with a stable module-scope identity. Passing an inline arrow as
 * `Wrapper` makes it a new component type on every render, so React remounts the
 * whole row and any focused control inside it loses focus.
 */
export const FileRowWrapper = ({ children }: { children: React.ReactNode }) => (
  <div className="flex flex-wrap gap-2">{children}</div>
);

export default function FileRow({
  files: _files,
  setFiles,
  abortUpload,
  setFilesLoading,
  assistant_id,
  agent_id,
  tool_resource,
  index,
  fileFilter,
  isRTL = false,
  Wrapper,
  isPastedTextFile,
  isPasteActionPending,
  onEditPastedText,
  onMovePastedTextInline,
}: {
  files: Map<string, ExtendedFile> | undefined;
  abortUpload?: (fileId?: string) => void;
  setFiles: React.Dispatch<React.SetStateAction<Map<string, ExtendedFile>>>;
  setFilesLoading?: React.Dispatch<React.SetStateAction<boolean>>;
  fileFilter?: (file: ExtendedFile) => boolean;
  assistant_id?: string;
  agent_id?: string;
  tool_resource?: EToolResources;
  index?: number;
  isRTL?: boolean;
  Wrapper?: React.FC<{ children: React.ReactNode }>;
  /** Marks chips the composer generated from a long paste. Provenance comes from the caller's
   * marker registry rather than the filename, which a deliberate upload can share. */
  isPastedTextFile?: (file: ExtendedFile) => boolean;
  /** Hides the paste actions while a replacement upload or inline move is in flight for the
   * chip, so the same original cannot be acted on twice. */
  isPasteActionPending?: (file: ExtendedFile) => boolean;
  /** Opens the paste editor. Only the composer passes it, so other rows stay inert chips. */
  onEditPastedText?: (file: ExtendedFile) => void;
  /** Returns a paste to the composer, offered from the chip's subtitle line. */
  onMovePastedTextInline?: (file: ExtendedFile) => void;
}) {
  const localize = useLocalize();
  const managed = useManagedUploads();
  const { showToast } = useToastContext();
  const files = Array.from(_files?.values() ?? []).filter((file) =>
    fileFilter ? fileFilter(file) : true,
  );

  const { mutateAsync } = useDeleteFilesMutation({
    onMutate: async () =>
      logger.log(
        'agents',
        'Deleting files: agent_id, assistant_id, tool_resource',
        agent_id,
        assistant_id,
        tool_resource,
      ),
    onSuccess: () => {
      console.log('Files deleted');
    },
    onError: (error) => {
      console.log('Error deleting files:', error);
    },
  });

  const { deleteFile } = useFileDeletion({
    mutateAsync,
    agent_id,
    assistant_id,
    tool_resource,
    index,
  });

  useEffect(() => {
    if (!setFilesLoading) return;
    if (files.length === 0) {
      setFilesLoading(false);
      return;
    }

    if (
      files.some((file) =>
        file.managedUpload ? !file.managedUpload.operation?.canUseInComposer : file.progress < 1,
      )
    ) {
      setFilesLoading(true);
      return;
    }

    if (
      files.every((file) =>
        file.managedUpload ? file.managedUpload.operation?.canUseInComposer : file.progress === 1,
      )
    ) {
      setFilesLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  useEffect(() => {
    if (!managed.data) return;
    setFiles((previous) => {
      let changed = false;
      const next = new Map(previous);
      for (const [key, file] of previous) {
        const old = file.managedUpload?.operation;
        const operation = old && managed.data.operations.find((row) => row.id === old.id);
        if (
          !operation ||
          (operation.revision === old?.revision &&
            operation.canUseInComposer === old?.canUseInComposer)
        )
          continue;
        changed = true;
        next.set(key, {
          ...file,
          ...(operation.attachment ?? {}),
          managedUpload: { ...file.managedUpload!, operation },
        });
      }
      return changed ? next : previous;
    });
  }, [managed.data, setFiles]);

  const quotaPanel = !assistant_id && !agent_id ? <ManagedUploadPanel /> : null;
  if (files.length === 0) return quotaPanel;

  const renderFiles = () => {
    const rowStyle = isRTL
      ? {
          display: 'flex',
          flexDirection: 'row-reverse',
          flexWrap: 'wrap',
          gap: '6px',
          width: '100%',
          maxWidth: '100%',
        }
      : {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          width: '100%',
          maxWidth: '100%',
        };

    return (
      /* `items-center` so a card and a thumbnail of different heights share
         one baseline instead of hanging from the top of the tallest row. */
      <div className="items-center" style={rowStyle as React.CSSProperties}>
        {files
          .reduce(
            (acc, current) => {
              if (!acc.map.has(current.file_id)) {
                acc.map.set(current.file_id, true);
                acc.uniqueFiles.push(current);
              }
              return acc;
            },
            { map: new Map(), uniqueFiles: [] as ExtendedFile[] },
          )
          .uniqueFiles.map((file: ExtendedFile, fileIndex: number) => {
            if (file.managedUpload) {
              return (
                <ManagedUploadCard
                  key={file.temp_file_id ?? file.file_id}
                  file={file}
                  onRemove={() => {
                    setFiles((previous) => {
                      const next = new Map(previous);
                      for (const [key, value] of next)
                        if (value === file || value.file_id === file.file_id) next.delete(key);
                      return next;
                    });
                  }}
                />
              );
            }
            const handleDelete = () => {
              if (abortUpload && file.progress < 1) {
                abortUpload(file.file_id);
              }
              if (file.progress >= 1 && !file.attached) {
                showToast({
                  message: localize('com_ui_deleting_file'),
                  status: 'info',
                });
              }
              deleteFile({ file, setFiles });
            };
            const isImage = file.type?.startsWith('image') ?? false;
            /** An upload still in flight has no stored text to open yet, and without a paste
             * marker the chip is an ordinary attachment however it is named. An action already
             * in flight against the chip hides both affordances until it settles. */
            const isEditablePaste =
              onEditPastedText != null &&
              isPastedTextFile != null &&
              file.progress >= 1 &&
              isPastedTextFile(file) &&
              !isPasteActionPending?.(file);

            return (
              /* Sized by its content, not parked in a fixed 70px slot: a 56px
                 thumbnail in a 70px slot left 14px of dead space beside it, so
                 the gap between two images read as far wider than the gap
                 beside a file card, which overflowed the same slot. */
              /* `flex`, not the default block: `Image`'s root is inline-block,
                 which sits on a text baseline and adds descender space under
                 the thumbnail, floating it above the cards beside it. */
              <div key={fileIndex} className="flex shrink-0">
                {isImage ? (
                  <Image
                    url={getCachedPreview(file.file_id) ?? file.preview ?? file.filepath}
                    onDelete={handleDelete}
                    progress={file.progress}
                    source={file.source}
                  />
                ) : (
                  /* `ImagePreview`'s `size-14` plus the 1px border its wrapper
                     adds, so a card and a thumbnail are exactly the same height
                     in a mixed row. */
                  <FileContainer
                    file={file}
                    onDelete={handleDelete}
                    buttonClassName="h-[58px]"
                    onClick={isEditablePaste ? () => onEditPastedText(file) : undefined}
                    ariaLabel={
                      isEditablePaste
                        ? localize('com_ui_pasted_text_edit_chip', { 0: file.filename ?? '' })
                        : undefined
                    }
                    subtitleAction={
                      isEditablePaste && onMovePastedTextInline != null
                        ? {
                            label: localize('com_ui_pasted_text_move_inline'),
                            onClick: () => onMovePastedTextInline(file),
                          }
                        : undefined
                    }
                  />
                )}
              </div>
            );
          })}
      </div>
    );
  };

  if (Wrapper) {
    return (
      <>
        {quotaPanel}
        <Wrapper>{renderFiles()}</Wrapper>
      </>
    );
  }

  return (
    <>
      {quotaPanel}
      {renderFiles()}
    </>
  );
}
