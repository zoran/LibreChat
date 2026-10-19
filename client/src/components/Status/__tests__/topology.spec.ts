import { renderHook, act } from '@testing-library/react';
import { readStatusSnapshot } from 'librechat-data-provider';
import {
  layoutTopology,
  focusNodes,
  presetNodes,
  graphBounds,
  nodeState,
  compactRoleAnchor,
  compactRoleAnchors,
  compactRoleMinimumHeight,
} from '../topology';
import fixture from '../../../../../packages/data-provider/src/status-fixtures/representative.json';
import inventory from '../../../../../e2e/presentation/status.inventory.fixture.json';
import useStatusCamera, { fitCamera } from '../useStatusCamera';
const snapshot = () => {
  const value = readStatusSnapshot(fixture);
  if (!value) throw new Error('invalid owner fixture');
  return value;
};
describe('one Status topology', () => {
  it('preserves unique physical GPU positions across all presets', () => {
    const s = snapshot();
    const positions = layoutTopology(s);
    expect(positions.size).toBe(s.nodes.length);
    for (const p of ['overview', 'infrastructure', 'processing'] as const) {
      expect(presetNodes(s.nodes, p).every((n) => positions.has(n.id))).toBe(true);
    }
    expect(s.nodes.filter((n) => n.identity.kind === 'gpu')).toHaveLength(3);
  });
  it('retains four runtime allocations of one physical GPU', () => {
    const s = snapshot();
    const gpu = s.nodes.find((n) => n.identity.key.endsWith('0002'))!;
    const neighbors = focusNodes(s, gpu.id);
    expect(neighbors.filter((n) => n.identity.scope === 'runtime')).toHaveLength(4);
  });
  it('frames exactly the existing focus without inventing nodes', () => {
    const s = snapshot();
    const nodes = focusNodes(s, 'runtime:pod:ds-b');
    expect(nodes.filter((n) => n.identity.kind === 'gpu')).toHaveLength(2);
    const camera = fitCamera(graphBounds(nodes, layoutTopology(s)));
    expect(Number.isFinite(camera.scale)).toBe(true);
    expect(camera.scale).toBeGreaterThanOrEqual(0.12);
  });
  it('expires originally healthy availability using evidence age', () => {
    const s = snapshot();
    const n = s.nodes[0];
    n.assessments[0] = {
      dimension: 'availability',
      state: 'healthy',
      reason: 'observed',
      evidence: s.edges[0].evidence,
    };
    expect(nodeState(n, s.generatedAt)).toBe('healthy');
    expect(nodeState(n, s.generatedAt + 100)).toBe('stale');
  });
  it('keeps unavailable and unknown separate', () => {
    const n = snapshot().nodes[0];
    expect(nodeState(n, 0)).toBe('unknown');
    n.assessments[0].state = 'unavailable';
    expect(nodeState(n, 0)).toBe('unavailable');
  });
});

it('restores camera, selection and preset together on Back', () => {
  const { result } = renderHook(() => useStatusCamera());
  act(() =>
    result.current.focus({ x: 10, y: 10, width: 200, height: 100 }, true, {
      selection: { kind: 'node', id: 'physical:host:gpu-a' },
      preset: 'infrastructure',
    }),
  );
  const original = result.current.camera;
  act(() =>
    result.current.focus({ x: 50, y: 50, width: 100, height: 100 }, true, {
      selection: { kind: 'node', id: 'runtime:pod:ds-a' },
      preset: 'processing',
    }),
  );
  act(() => result.current.back());
  expect(result.current.selection).toEqual({ kind: 'node', id: 'physical:host:gpu-a' });
  expect(result.current.preset).toBe('infrastructure');
  expect(result.current.camera).toEqual(original);
});

it('keeps one physical GPU across focused processing and infrastructure layers', () => {
  const s = snapshot();
  const gpuId = s.nodes.find((n) => n.identity.key.endsWith('0002'))!.id;
  const processing = focusNodes(s, gpuId, 'processing');
  expect(processing.filter((n) => n.identity.scope === 'runtime')).toHaveLength(4);
  expect(processing.filter((n) => n.id === gpuId)).toHaveLength(1);
  const hardware = focusNodes(s, 'runtime:pod:ds-b', 'infrastructure');
  expect(hardware.filter((n) => n.identity.kind === 'gpu')).toHaveLength(2);
  expect(hardware.filter((n) => n.id === 'runtime:pod:ds-b')).toHaveLength(1);
  expect(new Set(hardware.map((n) => n.id)).size).toBe(hardware.length);
});

it('keeps logical stack components and membership explicit without changing stable positions', () => {
  const s = snapshot();
  const positions = layoutTopology(s);
  const cluster = s.nodes.find(
    (n) => n.classification?.kind === 'kubernetes' && n.classification.role === 'cluster',
  )!;
  for (const preset of ['overview', 'infrastructure', 'processing'] as const) {
    expect(presetNodes(s.nodes, preset)).toContain(cluster);
    expect(focusNodes(s, 'physical:host:control-a', preset)).toContain(cluster);
    expect(layoutTopology(s)).toEqual(positions);
  }
  expect(
    presetNodes(s.nodes, 'overview').filter((n) => n.classification?.kind === 'kubernetes'),
  ).toHaveLength(1);
  expect(
    presetNodes(s.nodes, 'infrastructure').filter((n) => n.classification?.kind === 'kubernetes'),
  ).toHaveLength(9);
  expect(
    presetNodes(s.nodes, 'processing').filter((n) => n.classification?.kind === 'kubernetes'),
  ).toHaveLength(9);
});

// Membership is shared context; selecting one host must not expand every other member's hardware.
it('keeps shared cluster membership out of the second structural focus hop', () => {
  const s = snapshot();
  const initial = presetNodes(s.nodes, 'infrastructure');
  expect(initial.some((n) => n.identity.kind === 'gpu')).toBe(false);
  const focused = focusNodes(s, 'physical:host:gpu-a', 'infrastructure');
  expect(focused.some((n) => n.identity.kind === 'gpu')).toBe(true);
  expect(focused.filter((n) => n.identity.kind === 'host').map((n) => n.id)).toEqual([
    'physical:host:gpu-a',
  ]);
  expect(focused.some((n) => n.classification?.role === 'cluster')).toBe(true);
  expect(focused.filter((n) => n.classification?.kind === 'kubernetes')).toHaveLength(9);
  const cluster = s.nodes.find((n) => n.classification?.role === 'cluster')!;
  expect(focusNodes(s, cluster.id, 'infrastructure').some((n) => n.identity.kind === 'gpu')).toBe(
    false,
  );
});

describe('readable inventory roles within the actual graph surface', () => {
  it.each([320, 390, 768, 1280])(
    'separates all roles and hosts at %ipx without moving world anchors',
    (width) => {
      const s = readStatusSnapshot(inventory);
      if (!s) throw new Error('invalid recorded inventory fixture');
      const positions = layoutTopology(s);
      const original = new Map(positions);
      const cpu = s.nodes.find(
        (n) => n.classification?.kind === 'server' && n.classification.role === 'cpu',
      )!;
      for (const nodes of [
        presetNodes(s.nodes, 'infrastructure'),
        focusNodes(s, cpu.id, 'infrastructure'),
      ]) {
        const viewport = { width, height: compactRoleMinimumHeight(nodes, width) };
        const camera = fitCamera(graphBounds(nodes, positions));
        const anchors = compactRoleAnchors(nodes, positions, camera, viewport);
        const scale = Math.min(width / 1600, viewport.height / 900);
        const boxes = nodes
          .filter((n) => n.identity.kind === 'host' || n.classification?.kind === 'kubernetes')
          .map((node) => {
            const anchor = anchors.get(node.id);
            expect(anchor).toBeDefined();
            const p = positions.get(node.id)!;
            const x =
              (camera.x + (p.x + anchor!.x) * camera.scale) * scale + (width - 1600 * scale) / 2;
            const y =
              (camera.y + (p.y + anchor!.y) * camera.scale) * scale +
              (viewport.height - 900 * scale) / 2;
            const halfWidth = node.classification?.kind === 'kubernetes' ? 82 : 16;
            expect(x - halfWidth).toBeGreaterThanOrEqual(5.99);
            expect(x + halfWidth).toBeLessThanOrEqual(width - 5.99);
            expect(y - 14).toBeGreaterThanOrEqual(5.99);
            expect(y + 14).toBeLessThanOrEqual(viewport.height - 5.99);
            return { x, y, halfWidth };
          });
        expect(nodes.filter((n) => n.classification?.kind === 'kubernetes')).toHaveLength(9);
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i],
              b = boxes[j];
            const gap = Math.max(
              Math.abs(a.x - b.x) - a.halfWidth - b.halfWidth,
              Math.abs(a.y - b.y) - 28,
            );
            expect(gap).toBeGreaterThanOrEqual(7.99);
          }
        expect(positions).toEqual(original);
      }
    },
  );
});

it('keeps a clipped compact badge inside the canvas without pinning deliberately panned resources', () => {
  const viewport = { width: 390, height: 155.52 };
  const camera = { x: -500, y: 0, scale: 0.5 };
  const nearEdge = compactRoleAnchor({ x: 300, y: 0 }, camera, viewport, 77, 11);
  expect(nearEdge).not.toEqual({ x: 92, y: 44 });
  expect(compactRoleAnchor({ x: -10000, y: 0 }, camera, viewport, 77, 11)).toEqual({
    x: 92,
    y: 44,
  });
});

it.each([
  { width: 445.453125, height: 472.078125 },
  { width: 390, height: 288 },
])('keeps the conservative decorated focus envelope within $width × $height', (viewport) => {
  const camera = { x: -800.969861520382, y: 67.80415430267067, scale: 0.5934718100890207 };
  const scale = Math.min(viewport.width / 1600, viewport.height / 900);
  const offset = { x: (viewport.width - 1600 * scale) / 2, y: (viewport.height - 900 * scale) / 2 };
  const pointFor = (x: number, y: number) => ({
    x: ((x - offset.x) / scale - camera.x) / camera.scale - 92,
    y: ((y - offset.y) / scale - camera.y) / camera.scale - 44,
  });
  for (const edge of [
    { x: 7, y: viewport.height / 2 },
    { x: viewport.width - 7, y: viewport.height / 2 },
    { x: viewport.width / 2, y: 7 },
    { x: viewport.width / 2, y: viewport.height - 7 },
  ]) {
    const point = pointFor(edge.x, edge.y);
    for (const avoid of [
      undefined,
      { point: { x: point.x + 92, y: point.y + 44 }, halfWidth: 16, halfHeight: 14 },
    ]) {
      const anchor = compactRoleAnchor(point, camera, viewport, 16, 14, avoid);
      const x = offset.x + (camera.x + (point.x + anchor.x) * camera.scale) * scale;
      const y = offset.y + (camera.y + (point.y + anchor.y) * camera.scale) * scale;
      // CPU pins span±15; state artwork extends to y14. Reserve a conservative4px
      // native box expansion plus the unchanged2px outline and3px offset.
      expect(x - 15 - 4 - 5).toBeGreaterThanOrEqual(-1);
      expect(x + 15 + 4 + 5).toBeLessThanOrEqual(viewport.width + 1);
      expect(y - 11 - 4 - 5).toBeGreaterThanOrEqual(-1);
      expect(y + 14 + 4 + 5).toBeLessThanOrEqual(viewport.height + 1);
    }
  }
  expect(compactRoleAnchor(pointFor(-100, viewport.height / 2), camera, viewport, 16, 14)).toEqual({
    x: 92,
    y: 44,
  });
});
