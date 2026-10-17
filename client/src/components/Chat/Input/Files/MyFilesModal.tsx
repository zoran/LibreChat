import { useCallback, useRef } from 'react';
import { FileSources, FileContext } from 'librechat-data-provider';
import {
  Button,
  OGDialog,
  OGDialogContent,
  OGDialogHeader,
  OGDialogTitle,
} from '@librechat/client';
import type { TFile } from 'librechat-data-provider';
import { useGetFiles } from '~/data-provider';
import { DataTable, columns } from './Table';
import { useLocalize } from '~/hooks';

function FileList() {
  const localize = useLocalize();
  const {
    data: files = [],
    isFetching,
    isLoading,
    isError,
    isFetchedAfterMount,
    refetch,
  } = useGetFiles<TFile[]>({
    refetchOnMount: 'always',
    staleTime: 0,
    select: (files) =>
      files.map((file) => ({
        ...file,
        context: file.context ?? FileContext.unknown,
        filterSource: file.source === FileSources.firebase ? FileSources.local : file.source,
      })),
  });

  const loading = isFetching || isLoading || !isFetchedAfterMount;
  const unavailable = loading || isError;
  return (
    <>
      {loading && (
        <p role="status" className="py-6">
          {localize('com_ui_loading')}
        </p>
      )}
      {!loading && isError && (
        <div className="space-y-3 py-6">
          <p role="alert">{localize('com_ui_table_error_description')}</p>
          <Button variant="outline" onClick={() => void refetch()}>
            {localize('com_ui_retry')}
          </Button>
        </div>
      )}
      {/* Keep native sort/filter/selection state across refreshes, without rendering cached rows. */}
      <div hidden={unavailable}>
        <DataTable columns={columns} data={unavailable ? [] : files} />
      </div>
    </>
  );
}

export function MyFilesModal({
  open,
  onOpenChange,
  triggerRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}) {
  const localize = useLocalize();
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const captureReturnFocus = useCallback(() => {
    const activeElement = document.activeElement;
    const canRestoreShortcutFocus =
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement.isConnected &&
      activeElement.closest('[inert]') == null &&
      activeElement.closest('[role="menu"]') == null;
    returnFocusRef.current = canRestoreShortcutFocus
      ? activeElement
      : (triggerRef?.current ?? null);
  }, [triggerRef]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={returnFocusRef}>
      <OGDialogContent
        title={localize('com_nav_my_files')}
        onOpenAutoFocus={captureReturnFocus}
        className="bg-surface-dialog text-text-primary w-11/12 shadow-2xl"
      >
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_nav_my_files')}</OGDialogTitle>
        </OGDialogHeader>
        {open && <FileList />}
      </OGDialogContent>
    </OGDialog>
  );
}
