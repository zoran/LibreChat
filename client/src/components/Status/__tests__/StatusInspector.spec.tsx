import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { encodeStatusSnapshot, readStatusSnapshot } from 'librechat-data-provider';
import type { StatusMeasurement } from 'librechat-data-provider';
import fixture from '../../../../../packages/data-provider/src/status-fixtures/representative.json';
import StatusInspector, { formatMeasurement } from '../StatusInspector';
import german from '../../../locales/de/translation.json';
import StatusTopology from '../StatusTopology';
import { layoutTopology } from '../topology';
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof german) =>
    jest.requireActual<typeof german>('../../../locales/de/translation.json')[key] ?? key,
}));
const snapshot = () => {
  const value = readStatusSnapshot(fixture);
  if (!value) throw new Error('invalid fixture');
  return value;
};
describe('actual Status inspector', () => {
  it('never formats unknown as zero', () => {
    const m = snapshot().measurements[0];
    expect(formatMeasurement({ ...m, value: null })).toBe('—');
    expect(formatMeasurement({ ...m, value: 0 })).toMatch(/^0\s%$/);
  });
  it('shows configured, unknown effective values and actual decision evidence', () => {
    const s = snapshot();
    const nodeId = s.parameters[0].nodeId;
    render(
      <StatusInspector
        snapshot={s}
        selection={{ kind: 'node', id: nodeId }}
        now={s.generatedAt}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText(german.com_status_parameters)).toBeInTheDocument();
    const params = s.parameters.filter((p) => p.nodeId === nodeId);
    for (const p of params.filter((p) => p.reason.state === 'known'))
      expect(screen.getByText(p.reason.text!)).toBeInTheDocument();
    expect(screen.getAllByText(german.com_status_state_unknown).length).toBeGreaterThan(0);
  });
  it('selects actual directed connections without manufactured rates', () => {
    const s = snapshot();
    const e = s.edges[0];
    const select = jest.fn();
    render(
      <StatusInspector
        snapshot={s}
        selection={{ kind: 'node', id: e.from }}
        now={s.generatedAt}
        onSelect={select}
        onClose={jest.fn()}
      />,
    );
    const button = screen.getAllByRole('button').find((b) => b.textContent?.includes('→'))!;
    fireEvent.click(button);
    expect(select).toHaveBeenCalledWith({ kind: 'edge', id: e.id });
  });
  it('renders edge purpose, direction and source evidence', () => {
    const s = snapshot();
    render(
      <StatusInspector
        snapshot={s}
        selection={{ kind: 'edge', id: s.edges[0].id }}
        now={s.generatedAt}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />,
    );
    expect(screen.getByText(german.com_status_direction)).toBeInTheDocument();
    expect(screen.getByText(german.com_status_purpose_physical_containment)).toBeInTheDocument();
  });
});

it('selects the actual SVG resource by keyboard', () => {
  const s = snapshot();
  const onSelect = jest.fn();
  render(
    <StatusTopology
      snapshot={s}
      positions={layoutTopology(s)}
      visible={new Set(s.nodes.map((n) => n.id))}
      selection={null}
      camera={{ x: 0, y: 0, scale: 1 }}
      now={s.generatedAt}
      onSelect={onSelect}
      onPan={jest.fn()}
      onZoom={jest.fn()}
    />,
  );
  fireEvent.keyDown(screen.getByRole('button', { name: /GPU-Server A:/ }), { key: 'Enter' });
  expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: 'physical:host:gpu-a' });
});

// Actual DTO/React regressions for STATUS-REACT-R1: dimensions must never collapse.
const scopeCases: Array<{
  firstScope: StatusMeasurement['scope'];
  nextScope: StatusMeasurement['scope'];
  firstLabels: string[];
  nextLabels: string[];
}> = [
  {
    firstScope: { kind: 'cpu', cpuId: '100' },
    nextScope: { kind: 'cpu', cpuId: '200' },
    firstLabels: ['Logischer Prozessor: 100'],
    nextLabels: ['Logischer Prozessor: 200'],
  },
  {
    firstScope: { kind: 'interface', interfaceId: 'eno1' },
    nextScope: { kind: 'interface', interfaceId: 'eno2' },
    firstLabels: ['Netzwerkschnittstelle: eno1'],
    nextLabels: ['Netzwerkschnittstelle: eno2'],
  },
  {
    firstScope: { kind: 'filesystem', deviceId: 'nvme0n1', mountId: 'root', fsType: 'ext4' },
    nextScope: { kind: 'filesystem', deviceId: 'nvme1n1', mountId: 'data', fsType: 'xfs' },
    firstLabels: ['Gerät: nvme0n1', 'Einhängepunkt: root', 'Typ: ext4'],
    nextLabels: ['Gerät: nvme1n1', 'Einhängepunkt: data', 'Typ: xfs'],
  },
  {
    firstScope: {
      kind: 'http',
      method: 'POST',
      routeKey: 'ask',
      statusCode: 200,
      instanceId: 'app-1',
    },
    nextScope: {
      kind: 'http',
      method: 'GET',
      routeKey: 'query',
      statusCode: 503,
      instanceId: 'app-1',
    },
    firstLabels: ['Methode: POST', 'Route: ask', 'Statuscode: 200', 'Instanz: app-1'],
    nextLabels: ['Methode: GET', 'Route: query', 'Statuscode: 503', 'Instanz: app-1'],
  },
];
it.each(scopeCases)(
  'distinguishes validated $firstScope.kind measurement identities',
  ({ firstScope, nextScope, firstLabels, nextLabels }) => {
    const raw = snapshot();
    if (firstScope.kind === 'filesystem') {
      const memory = raw.measurements.find((m) => m.key === 'memory.available');
      if (!memory) throw new Error('missing host memory fixture');
      raw.measurements.push({
        ...memory,
        id: 'measurement:filesystem-test',
        key: 'filesystem.available',
        scope: firstScope,
      });
    }
    const measurement = raw.measurements.find((m) => m.scope.kind === firstScope.kind);
    if (!measurement) throw new Error('missing scoped fixture');
    measurement.scope = firstScope;
    const initial = readStatusSnapshot(encodeStatusSnapshot(raw));
    if (!initial) throw new Error('invalid initial fixture');
    const show = (s: NonNullable<typeof initial>) => (
      <StatusInspector
        snapshot={s}
        selection={{ kind: 'node', id: measurement.target.id }}
        now={s.generatedAt}
        onSelect={jest.fn()}
        onClose={jest.fn()}
      />
    );
    const view = render(show(initial));
    for (const label of firstLabels) expect(view.container.textContent).toContain(label);
    const before = view.container.textContent;
    measurement.scope = nextScope;
    const next = readStatusSnapshot(encodeStatusSnapshot(raw));
    if (!next) throw new Error('invalid next fixture');
    view.rerender(show(next));
    for (const label of nextLabels) expect(view.container.textContent).toContain(label);
    expect(view.container.textContent).not.toBe(before);
  },
);
