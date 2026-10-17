import { createContext, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import { useRecoilValue } from 'recoil';
import { FilePenLine, X } from 'lucide-react';
import { usePanelRef } from 'react-resizable-panels';
import { Button, ResizableHandleAlt, ResizablePanel, ResizablePanelGroup } from '@librechat/client';
import { useGetStartupConfig } from '~/data-provider';
import useDrawerViewport from '~/hooks/Nav/useDrawerViewport';
import { lazyWithRecovery } from '~/lib/assets/lazy';
import useLocalize from '~/hooks/useLocalize';
import store from '~/store';

const Panel = lazyWithRecovery(() =>
  import('./WorkspacePanel').then((module) => ({ default: module.WorkspacePanel })),
);
const WorkspaceControl = createContext<{ open: boolean; toggle: () => void } | null>(null);

export function WorkspaceToggle() {
  const control = useContext(WorkspaceControl);
  const localize = useLocalize();
  if (!control) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={control.toggle}
      aria-label={localize('com_workspace_panel_title')}
      title={localize('com_workspace_panel_title')}
      aria-expanded={control.open}
      aria-controls="document-workspace-panel"
    >
      <FilePenLine className="size-4" aria-hidden="true" />
    </Button>
  );
}

/** The same mounted editor survives hiding and viewport changes; no document content is cached. */
export function WorkspaceSurface({ children }: { children: React.ReactNode }) {
  const user = useRecoilValue(store.user);
  const { data: config } = useGetStartupConfig();
  const enabled =
    config?.documentWorkspace?.enabled === true &&
    config.documentWorkspace.eligible === true &&
    !!user?.id;
  if (!enabled)
    return <WorkspaceControl.Provider value={null}>{children}</WorkspaceControl.Provider>;
  return (
    <WorkspaceSession
      key={JSON.stringify([user?.id, user?.tenantId ?? null])}
      owner={{ ownerId: user?.id ?? '', tenantId: user?.tenantId ?? null }}
      enabled={enabled}
    >
      {children}
    </WorkspaceSession>
  );
}

function WorkspaceSession({
  children,
  owner,
  enabled,
}: {
  children: React.ReactNode;
  owner: { ownerId: string; tenantId: string | null };
  enabled: boolean;
}) {
  const localize = useLocalize();
  const mobile = useDrawerViewport();
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState(false);
  const panel = usePanelRef();
  const visible = enabled && open;
  const control = useMemo(
    () =>
      enabled
        ? {
            open: visible,
            toggle: () => {
              setStarted(true);
              setOpen((value) => !value);
            },
          }
        : null,
    [enabled, visible],
  );
  useEffect(() => {
    if (!enabled) {
      setOpen(false);
      setStarted(false);
    }
  }, [enabled]);
  useEffect(() => {
    const openSize = mobile ? '100' : '50';
    if (started) panel.current?.resize(visible ? openSize : '0');
  }, [started, visible, mobile, panel]);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>('[aria-controls="document-workspace-panel"]')
        ?.focus(),
    );
  };
  return (
    <WorkspaceControl.Provider value={control}>
      <div className="flex h-full min-w-0 flex-1">
        <ResizablePanelGroup orientation="horizontal">
          <ResizablePanel id="workspace-chat" defaultSize="100" minSize="0">
            <div
              className={mobile && visible ? 'hidden' : 'flex h-full min-w-0'}
              hidden={mobile && visible}
            >
              {children}
            </div>
          </ResizablePanel>
          <>
            {visible && !mobile && <ResizableHandleAlt withHandle />}
            <ResizablePanel
              id="workspace-document"
              defaultSize="0"
              minSize="0"
              collapsible
              collapsedSize="0"
              panelRef={panel}
            >
              <section
                id="document-workspace-panel"
                aria-label={localize('com_workspace_panel_title')}
                hidden={!visible}
                className={visible ? 'bg-surface-primary flex h-full min-w-0 flex-col' : 'hidden'}
              >
                <div className="border-border-light flex shrink-0 items-center justify-between border-b px-3 py-2">
                  <span className="text-sm font-medium">
                    {localize('com_workspace_panel_title')}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={close}
                    aria-label={localize('com_workspace_close')}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                </div>
                <div className="min-h-0 flex-1">
                  {started && (
                    <Suspense
                      fallback={<p role="status">{localize('com_workspace_panel_loading')}</p>}
                    >
                      <Panel owner={owner} enabled={enabled} />
                    </Suspense>
                  )}
                </div>
              </section>
            </ResizablePanel>
          </>
        </ResizablePanelGroup>
      </div>
    </WorkspaceControl.Provider>
  );
}
