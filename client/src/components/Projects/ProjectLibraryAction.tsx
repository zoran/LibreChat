/** Native project membership composition; the library owns selection and original metadata. */
import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@librechat/client';
import { useQueryClient } from '@tanstack/react-query';
import { dataService, QueryKeys, FILE_LIBRARY_MAX_LIMIT } from 'librechat-data-provider';
import type { FileLibraryItem } from 'librechat-data-provider';
import { useAddProjectFileMutation, useProjectsInfiniteQuery } from '~/data-provider/Projects';
import { getSessionPrincipal } from '~/utils/session';
import { useAuthContext } from '~/hooks/AuthContext';
import { fileLibraryKey } from '~/features/library';
import useLocalize from '~/hooks/useLocalize';

type Props = {
  files: readonly FileLibraryItem[];
  projectId?: string;
  disabled?: boolean;
  clearSelection: (confirmedFileIds: readonly string[]) => void;
};
type Target = Pick<FileLibraryItem, 'file_id' | 'filename'>;
type Outcome = 'added' | 'failed' | 'unknown' | 'pending';
const outcomeLabels = {
  added: 'com_library_project_added',
  failed: 'com_library_project_failed',
  unknown: 'com_library_project_unknown',
  pending: 'com_library_project_adding',
} as const;
type Batch = { projectId: string; targets: readonly Target[]; outcomes: Record<string, Outcome> };

export default function ProjectLibraryAction(props: Props) {
  const { user } = useAuthContext();
  if (!user?.id) return null;
  return (
    <MembershipAction
      key={JSON.stringify([user.id, user.tenantId ?? null, props.projectId ?? null])}
      {...props}
      ownerId={user.id}
      tenantId={user.tenantId ?? null}
    />
  );
}

function MembershipAction({
  files,
  projectId,
  disabled,
  clearSelection,
  ownerId,
  tenantId,
}: Props & { ownerId: string; tenantId: string | null }) {
  const localize = useLocalize();
  const queryClient = useQueryClient();
  const add = useAddProjectFileMutation();
  const [search, setSearch] = useState('');
  const [chosenProject, setChosenProject] = useState('');
  const [batch, setBatch] = useState<Batch | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const mountedPrincipal = useRef(getSessionPrincipal());
  const lifetime = useRef({ active: true });
  useEffect(() => {
    const scope = { active: true };
    lifetime.current = scope;
    return () => {
      scope.active = false;
    };
  }, []);
  const projects = useProjectsInfiniteQuery(
    { search: search || undefined, limit: 25 },
    {
      enabled: !projectId,
      queryKey: [QueryKeys.projects, ownerId, tenantId, { search, limit: 25 }],
      cacheTime: 0,
      staleTime: 0,
      keepPreviousData: false,
      retry: false,
      refetchOnMount: 'always',
    },
  );
  const projectOptions =
    projects.isError || !projects.isFetchedAfterMount
      ? []
      : (projects.data?.pages.flatMap((page) => page.projects) ?? []);
  const targetProject = projectId ?? chosenProject;
  const unknown = batch?.targets.filter((file) => batch.outcomes[file.file_id] === 'unknown') ?? [];
  const failed = batch?.targets.filter((file) => batch.outcomes[file.file_id] === 'failed') ?? [];

  async function execute(targets: readonly Target[], targetId: string, previous?: Batch) {
    if (
      running.current ||
      disabled ||
      !targetId ||
      !targets.length ||
      targets.length > FILE_LIBRARY_MAX_LIMIT
    )
      return;
    const scope = lifetime.current;
    const current = () => scope.active && getSessionPrincipal() === mountedPrincipal.current;
    if (!current()) return;
    const next: Batch = previous
      ? { ...previous, outcomes: { ...previous.outcomes } }
      : {
          projectId: targetId,
          targets: targets.map(({ file_id, filename }) => ({ file_id, filename })),
          outcomes: Object.fromEntries(targets.map((file) => [file.file_id, 'pending'])),
        };
    running.current = true;
    setBusy(true);
    setBatch(next);
    let reconciled = false;
    try {
      if (!previous) {
        for (const file of next.targets) {
          if (!current()) return;
          try {
            const result = await add.mutateAsync({ projectId: targetId, file_id: file.file_id });
            if (!current()) return;
            next.outcomes[file.file_id] =
              result._id === targetId && result.file_ids?.includes(file.file_id)
                ? 'added'
                : 'unknown';
          } catch (error) {
            if (!current()) return;
            const status = (error as { response?: { status?: number } })?.response?.status;
            next.outcomes[file.file_id] =
              status && [400, 403, 404, 409].includes(status) ? 'failed' : 'unknown';
          }
          setBatch({ ...next, outcomes: { ...next.outcomes } });
        }
      }
      if (!current()) return;
      if (Object.values(next.outcomes).includes('unknown')) {
        try {
          // Read the native project and current member availability, never a cached ID guess.
          const [project, members] = await Promise.all([
            dataService.getProjectById(targetId),
            dataService.getProjectFiles(targetId),
          ]);
          if (!current()) return;
          if (project._id !== targetId) throw new Error('Project unavailable');
          reconciled = true;
          const ready = new Set(
            members.filter((file) => file.availability === 'ready').map((file) => file.file_id),
          );
          for (const file of next.targets) {
            if (next.outcomes[file.file_id] !== 'unknown') continue;
            next.outcomes[file.file_id] =
              project.file_ids?.includes(file.file_id) && ready.has(file.file_id)
                ? 'added'
                : 'failed';
          }
        } catch {
          // An unknown write stays unknown until a fresh native read can resolve it.
        }
      }
      if (!current()) return;
      setBatch({ ...next, outcomes: { ...next.outcomes } });
      clearSelection(
        next.targets
          .filter((file) => next.outcomes[file.file_id] === 'added')
          .map((file) => file.file_id),
      );
      await Promise.all([
        queryClient.invalidateQueries(fileLibraryKey(ownerId, tenantId)),
        ...(reconciled
          ? [
              queryClient.invalidateQueries([QueryKeys.project, targetId], { refetchType: 'all' }),
              queryClient.invalidateQueries([QueryKeys.projectFiles, targetId]),
              queryClient.invalidateQueries([QueryKeys.projectAvailableFiles, targetId]),
              queryClient.invalidateQueries([QueryKeys.projects]),
            ]
          : []),
      ]);
    } finally {
      running.current = false;
      if (scope.active) setBusy(false);
    }
  }

  return (
    <div className="flex w-full flex-col gap-2">
      {!projectId && (
        <>
          <Input
            type="search"
            aria-label={localize('com_ui_search_projects')}
            placeholder={localize('com_ui_search_projects')}
            value={search}
            disabled={busy}
            onChange={(event) => {
              setSearch(event.target.value);
              setChosenProject('');
              setBatch(null);
            }}
          />
          <select
            aria-label={localize('com_library_project_choose')}
            className="border-border-light bg-surface-secondary rounded-md border p-2 text-sm"
            disabled={busy || projects.isFetching || projects.isError}
            value={chosenProject}
            onChange={(event) => {
              setChosenProject(event.target.value);
              setBatch(null);
            }}
          >
            <option value="">{localize('com_library_project_choose')}</option>
            {projectOptions.map((project) => (
              <option key={project._id} value={project._id}>
                {project.name}
              </option>
            ))}
          </select>
          {projects.isError && (
            <Button variant="outline" onClick={() => void projects.refetch()}>
              {localize('com_ui_retry')}
            </Button>
          )}
          {projects.hasNextPage && (
            <Button
              variant="outline"
              disabled={busy || projects.isFetching}
              onClick={() => void projects.fetchNextPage()}
            >
              {localize('com_ui_load_more')}
            </Button>
          )}
        </>
      )}
      <Button
        variant="outline"
        disabled={
          disabled ||
          busy ||
          !files.length ||
          files.length > FILE_LIBRARY_MAX_LIMIT ||
          !targetProject ||
          unknown.length > 0
        }
        onClick={() =>
          void execute(
            [...new Map(files.map((file) => [file.file_id, file])).values()],
            targetProject,
          )
        }
      >
        {localize(busy ? 'com_library_project_adding' : 'com_library_project_add')}
      </Button>
      {batch && (
        <div role="status" className="space-y-1 text-sm break-words">
          <p>
            {localize('com_library_project_results', {
              count: Object.values(batch.outcomes).filter((value) => value === 'added').length,
              total: batch.targets.length,
            })}
          </p>
          <ul>
            {batch.targets.map((file) => (
              <li key={file.file_id}>
                {file.filename}: {localize(outcomeLabels[batch.outcomes[file.file_id]])}
              </li>
            ))}
          </ul>
        </div>
      )}
      {unknown.length > 0 && batch && (
        <Button
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void execute(unknown, batch.projectId, batch)}
        >
          {localize('com_library_project_reconcile')}
        </Button>
      )}
      {failed.length > 0 && unknown.length === 0 && batch && (
        <Button
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void execute(failed, batch.projectId)}
        >
          {localize('com_library_project_retry')}
        </Button>
      )}
    </div>
  );
}
