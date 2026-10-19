/** Integrated Cortex Status route. The production path never falls back to Demo fixtures. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { STATUS_ZOOM_PRESETS } from 'librechat-data-provider';
import type { StatusSnapshot } from 'librechat-data-provider';
import type { Selection } from './topology';
import { useStatusAccessQuery, useStatusSnapshotQuery, statusCode } from '~/data-provider/Status';
import { layoutTopology, presetNodes, focusNodes, graphBounds } from './topology';
import { useAuthContext, useLocalize, useDocumentTitle } from '~/hooks';
import OpenSidebar from '~/components/Chat/Menus/OpenSidebar';
import useSidebarState from '~/hooks/Nav/useSidebarState';
import { useGetStartupConfig } from '~/data-provider';
import { getAppTitle } from '~/utils/presentation';
import StatusInspector from './StatusInspector';
import useStatusCamera from './useStatusCamera';
import AppLogo from '~/components/ui/AppLogo';
import StatusTopology from './StatusTopology';
import './status.css';
/** Exported presentation is also used by real React render tests; fixtures never enter the route. */
export function StatusPresentation({
  snapshot,
  now,
  refreshing,
  onRefresh,
  warning,
}: {
  snapshot: StatusSnapshot;
  now: number;
  refreshing: boolean;
  onRefresh: () => void;
  warning?: string;
}) {
  const t = useLocalize();
  const { data: startupConfig } = useGetStartupConfig();
  const [search, setSearch] = useState('');
  const camera = useStatusCamera();
  const { preset, selection, setSelection, focus } = camera;
  const { isSmallScreen } = useSidebarState();
  const positions = useMemo(() => layoutTopology(snapshot), [snapshot]);
  const initialFit = useRef(false);
  const selectedNodes =
    selection?.kind === 'node' ? focusNodes(snapshot, selection.id, preset) : [];
  const visibleNodes = selectedNodes.length ? selectedNodes : presetNodes(snapshot.nodes, preset);
  const visible = new Set(visibleNodes.map((n) => n.id));
  const resultNodes = snapshot.nodes.filter((n) =>
    n.label.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const fit = () => focus(graphBounds(visibleNodes, positions));
  useEffect(() => {
    if (!initialFit.current && snapshot.nodes.length) {
      focus(graphBounds(presetNodes(snapshot.nodes, 'overview'), positions), false);
      initialFit.current = true;
    }
  }, [snapshot, positions, focus]);
  const select = (value: Selection) => {
    if (value?.kind === 'node')
      focus(graphBounds(focusNodes(snapshot, value.id, preset), positions), true, {
        selection: value,
        preset,
      });
    else setSelection(value);
  };
  const close = () => {
    setSelection(null);
    requestAnimationFrame(() =>
      document.querySelector<SVGSVGElement>('.cortex-status-scene')?.focus(),
    );
  };
  return (
    <section className="cortex-status" aria-label={t('com_status_title')}>
      <header className="cortex-status-toolbar">
        {isSmallScreen && <OpenSidebar testId="status-open-sidebar" />}
        <AppLogo startupConfig={startupConfig} variant="mark" />
        <div>
          <h1 className="cortex-status-title">{t('com_status_title')}</h1>
          <p className="cortex-status-subtitle">
            {getAppTitle()} · {snapshot.nodes.length} {t('com_status_resources')}
          </p>
        </div>
        <nav className="cortex-status-presets" aria-label={t('com_status_zoom_levels')}>
          {STATUS_ZOOM_PRESETS.map((p) => (
            <button
              key={p}
              aria-pressed={preset === p}
              onClick={() => {
                focus(
                  graphBounds(
                    selection?.kind === 'node'
                      ? focusNodes(snapshot, selection.id, p)
                      : presetNodes(snapshot.nodes, p),
                    positions,
                  ),
                  true,
                  { selection, preset: p },
                );
              }}
            >
              {t(`com_status_preset_${p}` as never)}
            </button>
          ))}
        </nav>
        <button disabled={refreshing} onClick={onRefresh}>
          {t(refreshing ? 'com_status_loading' : 'com_status_refresh')}
        </button>
      </header>
      {warning && (
        <p role="status" className="cortex-status-notice">
          {warning}
        </p>
      )}
      <div className="cortex-status-workspace">
        <div className="cortex-status-canvas">
          <StatusTopology
            snapshot={snapshot}
            positions={positions}
            visible={visible}
            selection={selection}
            camera={camera.camera}
            now={now}
            onSelect={select}
            onPan={camera.pan}
            onZoom={camera.zoom}
          />
          <div className="cortex-status-search">
            <input
              aria-label={t('com_status_search')}
              placeholder={t('com_status_search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <div
                className="cortex-status-results"
                role="region"
                aria-label={t('com_status_search_results')}
              >
                {resultNodes.length ? (
                  resultNodes.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => {
                        select({ kind: 'node', id: n.id });
                        setSearch('');
                      }}
                    >
                      {n.label}
                    </button>
                  ))
                ) : (
                  <p>{t('com_status_no_results')}</p>
                )}
              </div>
            )}
          </div>
          <div className="cortex-status-controls">
            <button disabled={!camera.canBack} onClick={camera.back}>
              {t('com_status_back')}
            </button>
            <button onClick={fit}>{t('com_status_fit')}</button>
            <button aria-label={t('com_status_zoom_in')} onClick={() => camera.zoom(1.3)}>
              +
            </button>
            <button aria-label={t('com_status_zoom_out')} onClick={() => camera.zoom(1 / 1.3)}>
              −
            </button>
            <details>
              <summary>{t('com_status_resource_list')}</summary>
              <div className="cortex-status-results">
                {snapshot.nodes.map((n) => (
                  <button key={n.id} onClick={() => select({ kind: 'node', id: n.id })}>
                    {n.label}
                  </button>
                ))}
              </div>
            </details>
          </div>
        </div>
        <StatusInspector
          snapshot={snapshot}
          selection={selection}
          now={now}
          onSelect={select}
          onClose={close}
        />
      </div>
      <footer className="cortex-status-legend">
        <span>{t('com_status_legend')}</span>
        <span>
          {t('com_status_observer')}: {snapshot.selectedObserverId ?? '—'}
        </span>
        <span>
          {t('com_status_snapshot')}:{' '}
          {new Date(snapshot.generatedAt * 1000).toLocaleTimeString('de-DE')}
        </span>
        <span>{t('com_status_no_edge_rates')}</span>
      </footer>
    </section>
  );
}
export default function StatusView() {
  const t = useLocalize();
  const { user, isAuthenticated } = useAuthContext();
  const access = useStatusAccessQuery(user?.id, isAuthenticated);
  const query = useStatusSnapshotQuery(user?.id, access.data?.allowed === true && isAuthenticated);
  const [now, setNow] = useState(() => Date.now() / 1000);
  useDocumentTitle(`${t('com_status_title')} | ${getAppTitle()}`);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now() / 1000);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  const forbidden =
    query.denied ||
    access.data?.allowed === false ||
    statusCode(access.error) === 403 ||
    statusCode(query.error) === 403;
  const pendingMessage =
    access.isError || query.isError ? 'com_status_unavailable' : 'com_status_loading';
  if (!query.data)
    return (
      <section className="cortex-status">
        <div className="cortex-status-empty" role="status">
          <h1>{t('com_status_title')}</h1>
          <p>{t(forbidden ? 'com_status_forbidden' : pendingMessage)}</p>
          {!forbidden && (
            <button
              onClick={() => {
                void access.refetch();
                if (access.data?.allowed) void query.refetch();
              }}
            >
              {t('com_status_refresh')}
            </button>
          )}
        </div>
      </section>
    );
  return (
    <StatusPresentation
      snapshot={query.data}
      now={now}
      refreshing={query.isFetching}
      onRefresh={() => {
        void query.refetch();
      }}
      warning={query.isError ? t('com_status_refresh_failed') : undefined}
    />
  );
}
