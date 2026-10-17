/** Server filters are submitted together; changing them starts a new cursor/selection scope. */
import { useId, useState } from 'react';
import { Button, Input } from '@librechat/client';
import { readFileLibraryQuery } from 'librechat-data-provider';
import type { FileLibraryQuery } from 'librechat-data-provider';
import useLocalize from '~/hooks/useLocalize';

export function LibraryFilters({
  disabled,
  onApply,
}: {
  disabled: boolean;
  onApply: (query: FileLibraryQuery) => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [type, setType] = useState('');
  const [archive, setArchive] = useState<'active' | 'archived' | 'all'>('active');
  const [invalid, setInvalid] = useState(false);
  const types = [
    ['application/pdf', 'PDF'],
    ['text/plain', localize('com_library_type_text')],
    ['text/markdown', 'Markdown'],
    ['text/csv', 'CSV'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint'],
    ['image/png', 'PNG'],
    ['image/jpeg', 'JPEG'],
  ];
  return (
    <form
      className="grid grid-cols-2 items-end gap-3 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        const query = readFileLibraryQuery({
          search,
          archive,
          ...(tag.trim() ? { tag } : {}),
          ...(type ? { type } : {}),
        });
        setInvalid(!query);
        if (query) onApply(query);
      }}
    >
      <div className="col-span-2 space-y-1">
        <label htmlFor={`${id}-search`} className="text-sm">
          {localize('com_library_search')}
        </label>
        <Input
          id={`${id}-search`}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-tag`} className="text-sm">
          {localize('com_library_tag_filter')}
        </label>
        <Input
          id={`${id}-tag`}
          value={tag}
          onChange={(event) => setTag(event.target.value)}
          disabled={disabled}
        />
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-type`} className="text-sm">
          {localize('com_library_type')}
        </label>
        <select
          id={`${id}-type`}
          value={type}
          onChange={(event) => setType(event.target.value)}
          disabled={disabled}
          className="border-border-light bg-surface-dialog h-10 w-full rounded-md border px-2 text-sm"
        >
          <option value="">{localize('com_library_all_types')}</option>
          {types.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-archive`} className="text-sm">
          {localize('com_library_view')}
        </label>
        <select
          id={`${id}-archive`}
          value={archive}
          onChange={(event) => setArchive(event.target.value as typeof archive)}
          disabled={disabled}
          className="border-border-light bg-surface-dialog h-10 w-full rounded-md border px-2 text-sm"
        >
          <option value="active">{localize('com_library_active')}</option>
          <option value="archived">{localize('com_library_archived')}</option>
          <option value="all">{localize('com_library_all')}</option>
        </select>
      </div>
      <Button type="submit" variant="outline" disabled={disabled}>
        {localize('com_library_apply')}
      </Button>
      {invalid && (
        <p role="alert" className="col-span-2 text-sm sm:col-span-4">
          {localize('com_library_filter_invalid')}
        </p>
      )}
    </form>
  );
}
