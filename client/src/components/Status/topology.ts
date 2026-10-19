/** Presentation geometry only. Resource identity and all observations remain in the public DTO. */
import { STATUS_KUBERNETES_ROLES } from 'librechat-data-provider';
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
export const NODE_HEIGHT = 88;
export function layoutTopology(snapshot: StatusSnapshot): Map<string, Point> {
  const result = new Map<string, Point>();
  const sorted = [...snapshot.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const clusters = sorted.filter(
    (n) => n.classification?.kind === 'kubernetes' && n.classification.role === 'cluster',
  );
  const components = sorted.filter(
    (n) =>
      n.identity.scope === 'logical' &&
      n.classification?.kind === 'kubernetes' &&
      n.classification.role !== 'cluster',
  );
  clusters.forEach((n, i) => result.set(n.id, { x: 880 + i * 260, y: 20 }));
  components.forEach((n, i) =>
    result.set(n.id, { x: 100 + (i % 7) * 260, y: 160 + Math.floor(i / 7) * 130 }),
  );
  const logicalY = clusters.length ? 180 + Math.ceil(components.length / 7) * 130 : 80;
  const logical = sorted.filter((n) => n.identity.scope === 'logical' && !result.has(n.id));
  const runtimes = sorted.filter((n) => n.identity.scope === 'runtime');
  const hosts = sorted.filter((n) => n.identity.scope === 'physical' && n.identity.kind === 'host');
  logical.forEach((n, i) =>
    result.set(n.id, { x: 100 + (i % 7) * 260, y: logicalY + Math.floor(i / 7) * 130 }),
  );
  const runtimeY = logicalY + 20 + Math.ceil(logical.length / 7) * 130;
  runtimes.forEach((n, i) =>
    result.set(n.id, { x: 100 + (i % 7) * 260, y: runtimeY + Math.floor(i / 7) * 130 }),
  );
  const hardwareY = runtimeY + Math.ceil(runtimes.length / 7) * 130 + 100;
  // A compact host band keeps the fleet/cluster overview legible before drilling into devices.
  // These positions stay identical across presets; observed device banks remain separate.
  const devicesY = hardwareY + Math.ceil(hosts.length / 7) * 360 + 30;
  let deviceBank = 0;
  hosts.forEach((host, i) => {
    result.set(host.id, { x: 100 + (i % 7) * 400, y: hardwareY + Math.floor(i / 7) * 360 });
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
    const x = 100 + (deviceBank % 3) * 680;
    const y = devicesY + Math.floor(deviceBank / 3) * 500;
    if (children.length) deviceBank++;
    children.forEach((n, j) => {
      if (!result.has(n.id))
        result.set(n.id, { x: x + (j % 3) * 210, y: y + Math.floor(j / 3) * 100 });
    });
  });
  sorted
    .filter((n) => !result.has(n.id))
    .forEach((n, i) =>
      result.set(n.id, {
        x: 100 + (i % 7) * 260,
        y: devicesY + Math.ceil(deviceBank / 3) * 500 + Math.floor(i / 7) * 110,
      }),
    );
  return result;
}
export function presetNodes(nodes: StatusNode[], preset: Preset): StatusNode[] {
  if (preset === 'infrastructure')
    return nodes.filter((n) => n.identity.kind === 'host' || n.layer === 'orchestration');
  if (preset === 'processing')
    return nodes.filter((n) => n.identity.scope !== 'physical' || n.identity.kind === 'host');
  return nodes.filter(
    (n) =>
      (n.identity.scope === 'logical' &&
        (n.layer !== 'orchestration' || n.classification?.role === 'cluster')) ||
      n.identity.kind === 'host',
  );
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
  // A shared cluster/component is context, not a request to expand every other host.
  // Only runtime/GPU neighbors need a second hop to expose their actual structural links.
  const adjacent = new Set(
    snapshot.nodes
      .filter((n) => ids.has(n.id) && (n.identity.scope === 'runtime' || n.identity.kind === 'gpu'))
      .map((n) => n.id),
  );
  snapshot.edges.forEach((e) => {
    if (!['contains', 'deployment', 'allocation'].includes(e.kind)) return;
    if (adjacent.has(e.from) || adjacent.has(e.to)) {
      ids.add(e.from);
      ids.add(e.to);
    }
  });
  snapshot.nodes.forEach((n) => {
    if (
      n.classification?.kind === 'kubernetes' &&
      (preset === 'infrastructure' || n.classification.role === 'cluster')
    )
      ids.add(n.id);
  });
  const layer = new Set(presetNodes(snapshot.nodes, preset).map((n) => n.id));
  // The selected resource remains visible as the context anchor in every semantic layer.
  return snapshot.nodes.filter(
    (n) =>
      ids.has(n.id) &&
      (n.id === nodeId ||
        layer.has(n.id) ||
        (preset === 'infrastructure' && n.identity.scope === 'physical')),
  );
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
/** Keep a screen-space badge and its focus outline inside the measured SVG without moving its node. */
export function compactRoleAnchor(
  point: Point,
  camera: Point & { scale: number },
  viewport: { width: number; height: number },
  halfWidth: number,
  halfHeight: number,
  avoid?: { point: Point; halfWidth: number; halfHeight: number },
): Point {
  const center = { x: NODE_WIDTH / 2, y: NODE_HEIGHT / 2 };
  if (viewport.width <= 0 || viewport.height <= 0) return center;
  const scale = Math.min(viewport.width / 1600, viewport.height / 900);
  const pixelScale = Math.max(0.001, camera.scale * scale);
  const project = (p: Point) => ({
    x: (camera.x + p.x * camera.scale) * scale + (viewport.width - 1600 * scale) / 2,
    y: (camera.y + p.y * camera.scale) * scale + (viewport.height - 900 * scale) / 2,
  });
  const screen = project({ x: point.x + center.x, y: point.y + center.y });
  // Deliberate panning may move resources off-screen; do not pin those resources to the edge.
  if (
    screen.x < -halfWidth ||
    screen.x > viewport.width + halfWidth ||
    screen.y < -halfHeight ||
    screen.y > viewport.height + halfHeight
  )
    return center;
  // Reserve the shared inset for a conservative decorated-box and focus envelope.
  let x = Math.max(
    halfWidth + LABEL_INSET,
    Math.min(viewport.width - halfWidth - LABEL_INSET, screen.x),
  );
  let y = Math.max(
    halfHeight + LABEL_INSET,
    Math.min(viewport.height - halfHeight - LABEL_INSET, screen.y),
  );
  if (avoid) {
    const other = project(avoid.point);
    const separationX = halfWidth + avoid.halfWidth + 6;
    const separationY = halfHeight + avoid.halfHeight + 6;
    if (Math.abs(x - other.x) < separationX && Math.abs(y - other.y) < separationY) {
      const candidates = [
        { x, y: other.y + separationY },
        { x, y: other.y - separationY },
        { x: other.x + separationX, y },
        { x: other.x - separationX, y },
      ].filter(
        (p) =>
          p.x >= halfWidth + LABEL_INSET &&
          p.x <= viewport.width - halfWidth - LABEL_INSET &&
          p.y >= halfHeight + LABEL_INSET &&
          p.y <= viewport.height - halfHeight - LABEL_INSET,
      );
      candidates.sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y));
      if (candidates[0]) ({ x, y } = candidates[0]);
    }
  }
  return { x: center.x + (x - screen.x) / pixelScale, y: center.y + (y - screen.y) / pixelScale };
}
const ROLE_WIDTH = 164;
const ROLE_HEIGHT = 28;
const LABEL_GAP = 8;
const LABEL_INSET = 12;
function roleColumns(width: number): number {
  return Math.max(
    1,
    Math.min(3, Math.floor((width - 2 * LABEL_INSET + LABEL_GAP) / (ROLE_WIDTH + LABEL_GAP))),
  );
}
/** A short viewport scrolls its workspace instead of shrinking required role labels. */
export function compactRoleMinimumHeight(nodes: StatusNode[], width: number): number {
  const roles = nodes.filter((n) => n.classification?.kind === 'kubernetes').length;
  const hosts = nodes.filter((n) => n.identity.kind === 'host').length;
  const hostColumns = Math.max(1, Math.floor((width - 2 * LABEL_INSET + LABEL_GAP) / 40));
  return Math.max(
    288,
    24 + (Math.ceil(roles / roleColumns(width)) + Math.ceil(hosts / hostColumns)) * 36,
  );
}
/** Screen-space labels share the original node anchors and edges; no second topology is created. */
export function compactRoleAnchors(
  nodes: StatusNode[],
  positions: Map<string, Point>,
  camera: Point & { scale: number },
  viewport: { width: number; height: number },
): Map<string, Point> {
  const anchors = new Map<string, Point>();
  if (viewport.width <= 0 || viewport.height <= 0) return anchors;
  const scale = Math.min(viewport.width / 1600, viewport.height / 900);
  const pixelScale = Math.max(0.001, camera.scale * scale);
  const project = (p: Point): Point => ({
    x:
      (camera.x + (p.x + NODE_WIDTH / 2) * camera.scale) * scale +
      (viewport.width - 1600 * scale) / 2,
    y:
      (camera.y + (p.y + NODE_HEIGHT / 2) * camera.scale) * scale +
      (viewport.height - 900 * scale) / 2,
  });
  const local = (p: Point, screen: Point): Point => {
    const origin = project(p);
    return {
      x: NODE_WIDTH / 2 + (screen.x - origin.x) / pixelScale,
      y: NODE_HEIGHT / 2 + (screen.y - origin.y) / pixelScale,
    };
  };
  const occupied: Bounds[] = [];
  const roles = nodes
    .filter((n) => n.classification?.kind === 'kubernetes')
    .sort(
      (a, b) =>
        STATUS_KUBERNETES_ROLES.indexOf(
          a.classification!.role as (typeof STATUS_KUBERNETES_ROLES)[number],
        ) -
          STATUS_KUBERNETES_ROLES.indexOf(
            b.classification!.role as (typeof STATUS_KUBERNETES_ROLES)[number],
          ) || a.id.localeCompare(b.id),
    );
  const columns = Math.min(roleColumns(viewport.width), roles.length);
  const bandWidth = columns * (ROLE_WIDTH + LABEL_GAP) - LABEL_GAP;
  roles.forEach((node, i) => {
    const position = positions.get(node.id);
    if (!position) return;
    const origin = project(position);
    // Deliberate panning still moves the resource off-screen; labels are not a pinned dashboard.
    if (
      origin.x < -ROLE_WIDTH / 2 ||
      origin.x > viewport.width + ROLE_WIDTH / 2 ||
      origin.y < -ROLE_HEIGHT / 2 ||
      origin.y > viewport.height + ROLE_HEIGHT / 2
    )
      return;
    const anchor =
      roles.length === 1
        ? compactRoleAnchor(position, camera, viewport, 82, 14)
        : local(position, {
            x:
              (viewport.width - bandWidth) / 2 +
              ROLE_WIDTH / 2 +
              (i % columns) * (ROLE_WIDTH + LABEL_GAP),
            y: LABEL_INSET + ROLE_HEIGHT / 2 + Math.floor(i / columns) * (ROLE_HEIGHT + LABEL_GAP),
          });
    anchors.set(node.id, anchor);
    const screen = {
      x: origin.x + (anchor.x - NODE_WIDTH / 2) * pixelScale,
      y: origin.y + (anchor.y - NODE_HEIGHT / 2) * pixelScale,
    };
    occupied.push({
      x: screen.x - ROLE_WIDTH / 2,
      y: screen.y - ROLE_HEIGHT / 2,
      width: ROLE_WIDTH,
      height: ROLE_HEIGHT,
    });
  });
  nodes
    .filter((n) => n.identity.kind === 'host')
    .sort((a, b) => a.id.localeCompare(b.id))
    .forEach((node) => {
      const position = positions.get(node.id);
      if (!position) return;
      const origin = project(position);
      if (
        origin.x < -16 ||
        origin.x > viewport.width + 16 ||
        origin.y < -14 ||
        origin.y > viewport.height + 14
      )
        return;
      const initial = compactRoleAnchor(position, camera, viewport, 16, 14);
      const screen = {
        x: origin.x + (initial.x - NODE_WIDTH / 2) * pixelScale,
        y: origin.y + (initial.y - NODE_HEIGHT / 2) * pixelScale,
      };
      const available = (p: Point) =>
        occupied.every(
          (b) =>
            p.x + 16 + LABEL_GAP <= b.x ||
            p.x - 16 - LABEL_GAP >= b.x + b.width ||
            p.y + 14 + LABEL_GAP <= b.y ||
            p.y - 14 - LABEL_GAP >= b.y + b.height,
        );
      let placed = screen;
      if (!available(screen)) {
        const candidates: Point[] = [];
        for (let y = LABEL_INSET + 14; y <= viewport.height - LABEL_INSET - 14; y += 36)
          for (let x = LABEL_INSET + 16; x <= viewport.width - LABEL_INSET - 16; x += 40)
            if (available({ x, y })) candidates.push({ x, y });
        candidates.sort(
          (a, b) =>
            Math.hypot(a.x - screen.x, a.y - screen.y) - Math.hypot(b.x - screen.x, b.y - screen.y),
        );
        if (candidates[0]) placed = candidates[0];
      }
      anchors.set(node.id, local(position, placed));
      occupied.push({ x: placed.x - 16, y: placed.y - 14, width: 32, height: 28 });
    });
  return anchors;
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
