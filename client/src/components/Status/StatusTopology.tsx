/** One SVG scene for every semantic zoom level. No metric-derived link traffic is invented. */
import { useId, useRef } from 'react';
import type { StatusSnapshot } from 'librechat-data-provider';
import type { Point, Selection } from './topology';
import type { Camera } from './useStatusCamera';
import { NODE_WIDTH, NODE_HEIGHT, nodeState, edgeState } from './topology';
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
    <svg
      className="cortex-status-scene"
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
        {snapshot.nodes.map((node) => {
          const p = positions.get(node.id);
          if (!p) return null;
          const active = visible.has(node.id);
          const state = nodeState(node, now);
          return (
            <g
              key={node.id}
              transform={`translate(${p.x} ${p.y})`}
              className={`cortex-status-node ${active ? '' : 'is-context'} ${selection?.id === node.id ? 'is-selected' : ''}`}
              data-state={state}
              role="button"
              tabIndex={active ? 0 : -1}
              aria-label={`${node.label}: ${t(`com_status_state_${state}` as never)}`}
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
              <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="16" />
              <circle cx="18" cy="20" r="4" />
              <text x="30" y="25" className="cortex-status-node-title">
                {node.label.length > 23 ? `${node.label.slice(0, 21)}…` : node.label}
              </text>
              <text x="18" y="53">
                {t(`com_status_state_${state}` as never)}
              </text>
              <title>{node.label}</title>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
