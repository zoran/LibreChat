/** Bounded native table presentation. Selection always addresses canonical File IDs. */
import { useTranslation } from 'react-i18next';
import {
  Checkbox,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@librechat/client';
import type { FileLibraryItem } from 'librechat-data-provider';
import FileSourceButton from '~/components/Chat/Input/Files/Table/FileSourceButton';
import useLocalize from '~/hooks/useLocalize';

export function LibraryTable({
  files,
  selected,
  onSelectionChange,
  disabled,
}: {
  files: FileLibraryItem[];
  selected: ReadonlySet<string>;
  onSelectionChange: (ids: Set<string>) => void;
  disabled: boolean;
}) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language;
  const count = files.filter((file) => selected.has(file.file_id)).length;
  return (
    <div className="max-h-[45dvh] min-h-24 overflow-auto rounded-md">
      <Table unwrapped>
        <TableHeader sticky>
          <TableRow>
            <TableHead size="compact" className="w-10">
              <Checkbox
                aria-label={localize('com_library_select_page')}
                checked={count > 0 && (count === files.length || 'indeterminate')}
                disabled={disabled || files.length === 0}
                onCheckedChange={(checked) =>
                  onSelectionChange(new Set(checked ? files.map((file) => file.file_id) : []))
                }
              />
            </TableHead>
            <TableHead size="compact">{localize('com_ui_name')}</TableHead>
            <TableHead size="compact">{localize('com_library_tags')}</TableHead>
            <TableHead size="compact" className="hidden md:table-cell">
              {localize('com_ui_date')}
            </TableHead>
            <TableHead size="compact" className="hidden sm:table-cell">
              {localize('com_ui_size')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {files.map((file) => (
            <TableRow key={file.file_id} data-state={selected.has(file.file_id) && 'selected'}>
              <TableCell size="compact">
                <Checkbox
                  aria-label={localize('com_library_select_file', { 0: file.filename })}
                  disabled={disabled}
                  checked={selected.has(file.file_id)}
                  onCheckedChange={(checked) => {
                    const next = new Set(selected);
                    if (checked) next.add(file.file_id);
                    else next.delete(file.file_id);
                    onSelectionChange(next);
                  }}
                />
              </TableCell>
              <TableCell size="compact" className="max-w-48 sm:max-w-80">
                <FileSourceButton file={file} className="block max-w-full" />
                {file.library.archivedAt && (
                  <p className="text-text-secondary text-xs">{localize('com_library_archived')}</p>
                )}
                {file.status === 'pending' && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_library_preview_pending')}
                  </p>
                )}
                {file.status === 'failed' && (
                  <p className="text-text-secondary text-xs">
                    {localize('com_library_preview_failed')}
                  </p>
                )}
              </TableCell>
              <TableCell size="compact" className="max-w-36 break-words">
                {file.library.tags.join(', ') || '—'}
              </TableCell>
              <TableCell size="compact" className="hidden md:table-cell">
                {file.updatedAt ? new Date(file.updatedAt).toLocaleDateString(locale) : '—'}
              </TableCell>
              <TableCell size="compact" className="hidden whitespace-nowrap sm:table-cell">
                {localize('com_library_size_kb', {
                  0: Math.ceil(file.bytes / 1024).toLocaleString(locale),
                })}
              </TableCell>
            </TableRow>
          ))}
          {!files.length && (
            <TableRow>
              <TableCell colSpan={5} className="h-24 text-center">
                {localize('com_files_no_results')}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
