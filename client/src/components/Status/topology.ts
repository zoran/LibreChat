/** Presentation geometry only. Resource identity and all observations remain in the public DTO. */
import type {
  StatusSnapshot,
  StatusNode,
  StatusEdge,
  STATUS_ZOOM_PRESETS,
} from 'librechat-data-provider';
export type Preset = (typeof STATUS_ZOOM_PRESETS)[number];
export type Selection = { kind: 'node' | 'edge'; id: string } | null;
export type Point = { x: number; y: number };
export type Bounds = { x: number; y: number; width: number; height: number };
export const NODE_WIDTH = 184;
export const NODE_HEIGHT = 76;
export function layoutTopology(snapshot: StatusSnapshot): Map<string, Point> {
  const result = new Map<string, Point>();
  const sorted = [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const logical = sorted.filter((n) => n.identity.scope === 'logical');
  const runtimes = sorted.filter((n) => n.identity.scope === 'runtime');
  const hosts = sorted.filter((n) => n.identity.scope === 'physical' && n.identity.kind === 'host');
  logical.forEach((n, i) =>
    result.set(n.id, { x: 100 + (i % 7) * 260, y: 80 + Math.floor(i / 7) * 130 }),
  );
  const runtimeY = 100 + Math.ceil(logical.length / 7) * 130;
  runtimes.forEach((n, i) =>
    result.set(n.id, { x: 100 + (i % 7) * 260, y: runtimeY + Math.floor(i / 7) * 130 }),
  );
  const hardwareY = runtimeY + Math.ceil(runtimes.length / 7) * 130 + 100;
  hosts.forEach((host, i) => {
    const x = 100 + (i % 3) * 680;
    const y = hardwareY + Math.floor(i / 3) * 500;
    result.set(host.id, { x, y });
    const children = sorted.filter((n) =>
      snapshot.edges.some(
        (e) =>
          e.kind === 'contains' &&
          e.basis === 'observed' &&
          (e.state === 'healthy' || e.state === 'degraded') &&
          e.from === host.id &&
          e.to === n.id,
      ),
    );
    children.forEach((n, j) => {
      if (!result.has(n.id))
        result.set(n.id, { x: x + (j % 3) * 210, y: y + 120 + Math.floor(j / 3) * 100 });
    });
  });
  sorted
    .filter((n) => !result.has(n.id))
    .forEach((n, i) =>
      result.set(n.id, {
        x: 100 + (i % 7) * 260,
        y: hardwareY + Math.ceil(hosts.length / 3) * 500 + Math.floor(i / 7) * 110,
      }),
    );
  return result;
}
export function presetNodes(nodes: StatusNode[], preset: Preset): StatusNode[] {
  if (preset === 'infrastructure') return nodes.filter((n) => n.identity.scope === 'physical');
  if (preset === 'processing') return nodes.filter((n) => n.identity.scope !== 'physical');
  return nodes.filter((n) => n.identity.scope === 'logical' || n.identity.kind === 'host');
}
export function focusNodes(
  snapshot: StatusSnapshot,
  nodeId: string,
  preset?: Preset,
): StatusNode[] {
  const ids = new Set([nodeId]);
  snapshot.edges.forEach((e) => {
    if (e.from === nodeId || e.to === nodeId) {
      ids.add(e.from);
      ids.add(e.to);
    }
  });
  if (!preset) return snapshot.nodes.filter((n) => ids.has(n.id));
  // One additional structural hop exposes host -> runtime -> service and runtime -> GPU -> host.
  // Keep existing relationship evidence/basis untouched; this is presentation context, not placement proof.
  const adjacent = new Set(ids);
  snapshot.edges.forEach((e) => {
    if (!['contains', 'deployment', 'allocation'].includes(e.kind)) return;
    if (adjacent.has(e.from) || adjacent.has(e.to)) {
      ids.add(e.from);
      ids.add(e.to);
    }
  });
  const layer = new Set(presetNodes(snapshot.nodes, preset).map((n) => n.id));
  // The selected resource remains visible as the context anchor in every semantic layer.
  return snapshot.nodes.filter((n) => ids.has(n.id) && (n.id === nodeId || layer.has(n.id)));
}
export function graphBounds(nodes: StatusNode[], positions: Map<string, Point>): Bounds {
  const points = nodes.map((n) => positions.get(n.id)).filter((p): p is Point => p != null);
  if (!points.length) return { x: 0, y: 0, width: 1600, height: 900 };
  const x = Math.min(...points.map((p) => p.x)) - 50;
  const y = Math.min(...points.map((p) => p.y)) - 50;
  return {
    x,
    y,
    width: Math.max(...points.map((p) => p.x)) - x + NODE_WIDTH + 50,
    height: Math.max(...points.map((p) => p.y)) - y + NODE_HEIGHT + 50,
  };
}
export function nodeState(node: StatusNode, now: number): string {
  const assessment = node.assessments.find((a) => a.dimension === 'availability');
  if (!assessment) return 'unknown';
  if (
    assessment.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds) &&
    ['healthy', 'degraded'].includes(assessment.state)
  )
    return 'stale';
  return assessment.state;
}
export function edgeState(edge: StatusEdge, now: number): string {
  return edge.evidence.some((e) => now - e.observedAt > e.maxAgeSeconds) &&
    ['healthy', 'degraded'].includes(edge.state)
    ? 'stale'
    : edge.state;
}
