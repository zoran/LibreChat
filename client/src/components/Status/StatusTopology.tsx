/** One SVG scene for every semantic zoom level. No metric-derived link traffic is invented. */
import { useEffect, useId, useRef, useState } from 'react';
import type { StatusSnapshot } from 'librechat-data-provider';
import type { Point, Selection } from './topology';
import type { Camera } from './useStatusCamera';
import {
  NODE_WIDTH,
  NODE_HEIGHT,
  nodeState,
  edgeState,
  compactRoleAnchors,
  compactRoleMinimumHeight,
} from './topology';
import StatusResourceIcon, { StatusStateIcon } from './StatusResourceIcon';
import { resourceKind, roleLabel } from './classification';
import { useLocalize } from '~/hooks';
type Props = {
  snapshot: StatusSnapshot;
  positions: Map<string, Point>;
  visible: Set<string>;
  selection: Selection;
  camera: Camera;
  now: number;
  onSelect: (value: Selection) => void;
  onPan: (x: number, y: number) => void;
  onZoom: (factor: number, x?: number, y?: number) => void;
};
export default function StatusTopology({
  snapshot,
  positions,
  visible,
  selection,
  camera,
  now,
  onSelect,
  onPan,
  onZoom,
}: Props) {
  const t = useLocalize();
  const scene = useRef<SVGSVGElement>(null);
  const [viewport, setViewport] = useState({ width: 1600, height: 900 });
  useEffect(() => {
    const element = scene.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) setViewport({ width: box.width, height: box.height });
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  const pixelScale = Math.max(
    0.001,
    camera.scale * Math.min(viewport.width / 1600, viewport.height / 900),
  );
  const compact = pixelScale < 1;
  const activeNodes = snapshot.nodes.filter((n) => visible.has(n.id));
  const compactRoleIds = new Set(
    activeNodes
      .filter(
        (node) =>
          compact && (node.identity.kind === 'host' || node.classification?.kind === 'kubernetes'),
      )
      .map((node) => node.id),
  );
  // SVG paint order must keep semantic foreground labels above context cards.
  const nodeLayer = (node: StatusSnapshot['nodes'][number]) => {
    if (!visible.has(node.id)) return 0;
    return compactRoleIds.has(node.id) ? 2 : 1;
  };
  const orderedNodes = [...snapshot.nodes].sort((a, b) => nodeLayer(a) - nodeLayer(b));
  const badges = compactRoleAnchors(activeNodes, positions, camera, viewport);
  const marker = useId().replace(/:/g, '');
  const pointers = useRef(new Map<number, Point>());
  const moved = useRef(false);
  const travel = useRef(0);
  const local = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = Math.max(0.001, Math.min(rect.width / 1600, rect.height / 900));
    return {
      x: (e.clientX - rect.left - (rect.width - 1600 * scale) / 2) / scale,
      y: (e.clientY - rect.top - (rect.height - 900 * scale) / 2) / scale,
    };
  };
  return (
    <div
      className="cortex-status-canvas"
      style={{ minHeight: compactRoleMinimumHeight(activeNodes, viewport.width) }}
    >
      <svg
        ref={scene}
        className="cortex-status-scene"
        data-pixel-scale={pixelScale}
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={t('com_status_topology')}
        tabIndex={0}
        onPointerDown={(e) => {
          moved.current = false;
          travel.current = 0;
          pointers.current.set(e.pointerId, local(e));
          if (!(e.target instanceof Element) || !e.target.closest('[role=button]'))
            e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const old = pointers.current.get(e.pointerId);
          if (!old) return;
          const next = local(e);
          const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId);
          travel.current += Math.hypot(next.x - old.x, next.y - old.y);
          if (travel.current > 3) moved.current = true;
          if (others.length) {
            const other = others[0][1];
            const before = Math.hypot(old.x - other.x, old.y - other.y);
            if (before > 5)
              onZoom(
                Math.hypot(next.x - other.x, next.y - other.y) / before,
                (next.x + other.x) / 2,
                (next.y + other.y) / 2,
              );
          } else if (moved.current) onPan(next.x - old.x, next.y - old.y);
          pointers.current.set(e.pointerId, next);
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
        }}
        onPointerCancel={(e) => pointers.current.delete(e.pointerId)}
        onLostPointerCapture={(e) => pointers.current.delete(e.pointerId)}
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            onZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1);
          }
        }}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const moves: Record<string, Point> = {
            ArrowLeft: { x: 60, y: 0 },
            ArrowRight: { x: -60, y: 0 },
            ArrowUp: { x: 0, y: 60 },
            ArrowDown: { x: 0, y: -60 },
          };
          if (moves[e.key]) {
            e.preventDefault();
            onPan(moves[e.key].x, moves[e.key].y);
          }
          if (e.key === '+' || e.key === '=') {
            e.preventDefault();
            onZoom(1.2);
          }
          if (e.key === '-') {
            e.preventDefault();
            onZoom(1 / 1.2);
          }
        }}
      >
        <defs>
          <marker
            id={marker}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
          {snapshot.edges.map((edge) => {
            const a = positions.get(edge.from);
            const b = positions.get(edge.to);
            if (!a || !b) return null;
            const active = visible.has(edge.from) && visible.has(edge.to);
            const from = snapshot.nodes.find((n) => n.id === edge.from)?.label ?? edge.from;
            const to = snapshot.nodes.find((n) => n.id === edge.to)?.label ?? edge.to;
            const select = () => {
              if (!moved.current) onSelect({ kind: 'edge', id: edge.id });
            };
            return (
              <g
                key={edge.id}
                className={`cortex-status-edge ${active ? '' : 'is-context'} ${selection?.id === edge.id ? 'is-selected' : ''}`}
                data-state={edgeState(edge, now)}
              >
                <path
                  d={`M ${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT} C ${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT + 70}, ${b.x + NODE_WIDTH / 2} ${b.y - 70}, ${b.x + NODE_WIDTH / 2} ${b.y}`}
                  markerEnd={`url(#${marker})`}
                />
                <path
                  className="cortex-status-edge-hit"
                  d={`M ${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT} C ${a.x + NODE_WIDTH / 2} ${a.y + NODE_HEIGHT + 70}, ${b.x + NODE_WIDTH / 2} ${b.y - 70}, ${b.x + NODE_WIDTH / 2} ${b.y}`}
                  role="button"
                  tabIndex={active ? 0 : -1}
                  aria-label={`${from} → ${to}`}
                  onClick={select}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect({ kind: 'edge', id: edge.id });
                    }
                  }}
                />
              </g>
            );
          })}
          {activeNodes.map((node) => {
            if (!compactRoleIds.has(node.id)) return null;
            const p = positions.get(node.id);
            const badge = badges.get(node.id);
            if (
              !p ||
              !badge ||
              (Math.abs(badge.x - NODE_WIDTH / 2) <= 0.001 &&
                Math.abs(badge.y - NODE_HEIGHT / 2) <= 0.001)
            )
              return null;
            return (
              <path
                key={`leader:${node.id}`}
                data-role-leader-for={node.id}
                aria-hidden="true"
                pointerEvents="none"
                transform={`translate(${p.x} ${p.y})`}
                vectorEffect="non-scaling-stroke"
                d={`M ${NODE_WIDTH / 2} ${NODE_HEIGHT / 2} L ${badge.x} ${badge.y}`}
              />
            );
          })}
          {orderedNodes.map((node) => {
            const p = positions.get(node.id);
            if (!p) return null;
            const active = visible.has(node.id);
            const state = nodeState(node, now);
            const kind = resourceKind(node);
            const role = roleLabel(node, t);
            const isKubernetes = node.classification?.kind === 'kubernetes';
            const compactRole = compactRoleIds.has(node.id);
            const badge = badges.get(node.id) ?? { x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 };
            let compactIcon = 'unknown';
            let compactLabel = '?';
            if (kind === 'cpu-server' || kind === 'gpu-server') {
              compactIcon = kind === 'cpu-server' ? 'cpu' : 'gpu';
              compactLabel = compactIcon.toUpperCase();
            } else if (isKubernetes) {
              compactIcon = 'kubernetes';
              compactLabel = role;
            }
            return (
              <g
                key={node.id}
                transform={`translate(${p.x} ${p.y})`}
                className={`cortex-status-node ${active ? '' : 'is-context'} ${selection?.id === node.id ? 'is-selected' : ''}`}
                data-state={state}
                data-resource={kind}
                data-node-id={node.id}
                role="button"
                tabIndex={active ? 0 : -1}
                aria-label={`${node.label}: ${t(`com_status_state_${state}` as never)}${role ? ` · ${role}` : ''}`}
                aria-pressed={selection?.id === node.id}
                onClick={() => {
                  if (!moved.current) onSelect({ kind: 'node', id: node.id });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect({ kind: 'node', id: node.id });
                  }
                }}
              >
                {compactRole ? (
                  <g
                    data-compact-role="true"
                    transform={`translate(${badge.x} ${badge.y}) scale(${1 / pixelScale})`}
                  >
                    <g data-role-icon={compactIcon}>
                      {isKubernetes && (
                        <path
                          data-frame={kind === 'kubernetes-cluster' ? 'cluster' : 'kubernetes'}
                          d="M-72-14H72L82-4V4L72 14H-72L-82 4V-4Z"
                        />
                      )}
                      {kind === 'gpu-server' && (
                        <path data-frame="gpu" d="M-14-11H14V8H-14ZM-10 8v3h3V8m6 0v3h3V8" />
                      )}
                      {!isKubernetes && kind !== 'gpu-server' && (
                        <>
                          <rect
                            data-frame={kind}
                            x="-13"
                            y="-11"
                            width="26"
                            height="22"
                            rx={kind === 'cpu-server' ? 3 : 9}
                          />
                          {kind === 'cpu-server' && (
                            <path data-frame="pins" d="M-15-5h2m-2 10h2m26-10h2m-2 10h2" />
                          )}
                        </>
                      )}
                    </g>
                    <text
                      data-screen-label="true"
                      textAnchor="middle"
                      x={isKubernetes ? 0 : -1}
                      y={isKubernetes ? -2 : 3}
                    >
                      {compactLabel}
                    </text>
                    <g transform={`translate(${isKubernetes ? 69 : 4} ${isKubernetes ? 3 : 4})`}>
                      <StatusStateIcon state={state} />
                    </g>
                  </g>
                ) : (
                  <>
                    {kind === 'kubernetes-cluster' ? (
                      <path
                        data-frame="cluster"
                        d={`M14 0H${NODE_WIDTH - 14}L${NODE_WIDTH} 14V${NODE_HEIGHT - 14}L${NODE_WIDTH - 14} ${NODE_HEIGHT}H14L0 ${NODE_HEIGHT - 14}V14Z`}
                      />
                    ) : (
                      <rect
                        width={NODE_WIDTH}
                        height={NODE_HEIGHT}
                        rx={kind === 'gpu-server' ? 5 : 16}
                      />
                    )}
                    <StatusResourceIcon kind={kind} />
                    <text
                      x={kind === 'resource' || kind === 'server-unknown' ? 18 : 38}
                      y="25"
                      className="cortex-status-node-title"
                    >
                      {node.label.length > 22 ? `${node.label.slice(0, 20)}…` : node.label}
                    </text>
                    <text x="18" y="48" data-role-label="true">
                      {role}
                      {node.classification
                        ? ` · ${t(`com_status_basis_short_${node.classification.basis}` as never)}`
                        : ''}
                    </text>
                    <circle cx="18" cy="69" r="4" />
                    <text x="30" y="74">
                      {t(`com_status_state_${state}` as never)}
                    </text>
                  </>
                )}
                <title>
                  {node.label}
                  {role ? ` · ${role}` : ''}
                </title>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
