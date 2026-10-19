import { renderHook, act } from '@testing-library/react';
import { readStatusSnapshot } from 'librechat-data-provider';
import fixture from '../../../../../packages/data-provider/src/status-fixtures/representative.json';
import { layoutTopology, focusNodes, presetNodes, graphBounds, nodeState } from '../topology';
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
