import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { encodeStatusSnapshot, readStatusSnapshot } from 'librechat-data-provider';
import fixture from '../../../../../packages/data-provider/src/status-fixtures/representative.json';
import StatusView, { StatusPresentation } from '../StatusView';
import german from '../../../locales/de/translation.json';
jest.mock('@librechat/client', () => ({ useTheme: () => ({ resolvedMode: 'dark' }) }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: {
      appTitle: 'Cortex',
      interface: {
        appLogo: {
          light: '/configured/light.png',
          dark: '/configured/dark.png',
          mark: '/configured/mark.png',
          markDark: '/configured/mark-dark.png',
        },
      },
    },
  }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: keyof typeof german) =>
    jest.requireActual<typeof german>('../../../locales/de/translation.json')[key] ?? key,
  useAuthContext: () => ({ user: { id: 'test' }, isAuthenticated: true }),
  useDocumentTitle: () => {},
}));
jest.mock('~/hooks/Nav/useSidebarState', () => () => ({ isSmallScreen: false }));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);
jest.mock('~/utils/presentation', () => ({ getAppTitle: () => 'Cortex' }));
jest.mock('~/data-provider/Status', () => ({
  useStatusAccessQuery: () => ({ data: { allowed: false }, refetch: jest.fn() }),
  useStatusSnapshotQuery: () => ({ denied: true, refetch: jest.fn() }),
  statusCode: () => undefined,
}));
const snapshot = () => {
  const s = readStatusSnapshot(fixture);
  if (!s) throw new Error('invalid fixture');
  return s;
};
it('keeps nine readable Infrastructure roles and decorative leaders outside stable focus groups', () => {
  const measurement = jest.spyOn(SVGElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 390,
    bottom: 288,
    width: 390,
    height: 288,
    toJSON: () => ({}),
  });
  try {
    const s = snapshot();
    const view = render(
      <StatusPresentation
        snapshot={s}
        now={s.generatedAt}
        refreshing={false}
        onRefresh={jest.fn()}
      />,
    );
    const cpu = screen.getByRole('button', { name: /Diensteserver A:.*CPU-Server/ });
    fireEvent.click(cpu);
    fireEvent.click(screen.getByRole('button', { name: german.com_status_preset_infrastructure }));
    expect(screen.getByRole('button', { name: /Diensteserver A:.*CPU-Server/ })).toBe(cpu);
    expect(cpu).toHaveAttribute('aria-pressed', 'true');
    const pane = view.container.querySelector('.cortex-status-graph-pane')!;
    const canvas = pane.querySelector('.cortex-status-canvas')!;
    expect(pane.querySelector('.cortex-status-search')?.parentElement).toBe(pane);
    expect(pane.querySelector('.cortex-status-controls')?.parentElement).toBe(pane);
    expect(canvas.querySelector('.cortex-status-search, .cortex-status-controls')).toBeNull();
    expect(canvas.querySelectorAll('.cortex-status-scene')).toHaveLength(1);
    expect(canvas).toHaveStyle({ minHeight: '288px' });
    expect((canvas.querySelector('.cortex-status-scene') as SVGElement).style.minHeight).toBe('');
    const roles = [...canvas.querySelectorAll('[data-resource^="kubernetes-"]')];
    expect(roles).toHaveLength(9);
    for (const node of roles) {
      const role = node.getAttribute('data-resource')!.slice('kubernetes-'.length);
      expect(node).not.toHaveClass('is-context');
      expect(node).toHaveAttribute('tabindex', '0');
      expect(node.querySelector('[data-screen-label]')).toHaveTextContent(
        german[`com_status_role_${role}` as keyof typeof german],
      );
      expect(node.querySelector('[data-screen-state]')).toBeInTheDocument();
      expect(node.querySelector('[data-role-leader-for]')).toBeNull();
    }
    // Context cards may overlap projected labels, so active badges must paint last.
    const semanticNodes = [...canvas.querySelectorAll('[data-node-id]')];
    for (const badge of semanticNodes.filter((node) => node.querySelector('[data-compact-role]'))) {
      for (const card of semanticNodes.filter((node) => !node.querySelector('[data-compact-role]')))
        expect(card.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const leaders = [...canvas.querySelectorAll('[data-role-leader-for]')];
    expect(leaders.length).toBeGreaterThan(0);
    for (const leader of leaders) {
      expect(leader.closest('[data-node-id]')).toBeNull();
      expect(leader).toHaveAttribute('aria-hidden', 'true');
      expect(leader).not.toHaveAttribute('tabindex');
      expect(leader).not.toHaveAttribute('role');
      expect(leader).toHaveAttribute('pointer-events', 'none');
      const id = leader.getAttribute('data-role-leader-for');
      expect(canvas.querySelector(`[data-node-id="${id}"]`)).toBeInTheDocument();
      for (const node of canvas.querySelectorAll('[data-node-id]'))
        expect(
          leader.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    }
  } finally {
    measurement.mockRestore();
  }
});
it('keeps one graph and the selected server across semantic presets', () => {
  const s = snapshot();
  render(
    <StatusPresentation
      snapshot={s}
      now={s.generatedAt}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  expect(screen.getAllByRole('group', { name: german.com_status_topology })).toHaveLength(1);
  expect(screen.getByRole('img', { name: 'Cortex' })).toHaveAttribute(
    'src',
    '/configured/mark-dark.png',
  );
  fireEvent.click(screen.getByRole('button', { name: /GPU-Server A:/ }));
  expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: german.com_status_preset_infrastructure }));
  expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: german.com_status_back }));
  expect(screen.getByRole('button', { name: german.com_status_preset_overview })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
});
it('does not invent a replacement for a selected resource missing after refresh', () => {
  const s = snapshot();
  const { rerender } = render(
    <StatusPresentation
      snapshot={s}
      now={s.generatedAt}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /GPU-Server A:/ }));
  const next = {
    ...s,
    nodes: s.nodes.filter((n) => n.id !== 'physical:host:gpu-a'),
    edges: s.edges.filter(
      (e) => e.from !== 'physical:host:gpu-a' && e.to !== 'physical:host:gpu-a',
    ),
    measurements: s.measurements.filter((m) => m.target.id !== 'physical:host:gpu-a'),
  };
  rerender(
    <StatusPresentation
      snapshot={next}
      now={s.generatedAt + 30}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  expect(screen.getByText(german.com_status_missing_selection)).toBeInTheDocument();
});
it('renders platform denial without resource data or a Demo fallback', () => {
  render(<StatusView />);
  expect(screen.getByText(german.com_status_forbidden)).toBeInTheDocument();
  expect(screen.queryByRole('group', { name: german.com_status_topology })).not.toBeInTheDocument();
  expect(screen.queryByText('Demo')).not.toBeInTheDocument();
});

it('changes selected-server detail and camera, and restores both on Back', () => {
  const s = snapshot();
  const v = render(
    <StatusPresentation
      snapshot={s}
      now={s.generatedAt}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /GPU-Server A:/ }));
  const active = () =>
    [...v.container.querySelectorAll('.cortex-status-node:not(.is-context)')].map((n) =>
      n.getAttribute('aria-label'),
    );
  const camera = () =>
    v.container.querySelector('.cortex-status-scene > g')?.getAttribute('transform');
  const isActive = (id: string) =>
    active().some((label) => label?.startsWith(s.nodes.find((n) => n.id === id)!.label + ':'));
  const overview = { active: active(), camera: camera() };
  fireEvent.click(screen.getByRole('button', { name: german.com_status_preset_infrastructure }));
  const hardware = { active: active(), camera: camera() };
  expect(hardware.active).not.toEqual(overview.active);
  expect(hardware.camera).not.toEqual(overview.camera);
  expect(isActive('physical:gpu:GPU-00000000-0000-0000-0000-000000000001')).toBe(true);
  expect(isActive('runtime:pod:ds-a')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: german.com_status_preset_processing }));
  expect(active()).not.toEqual(hardware.active);
  expect(camera()).not.toEqual(hardware.camera);
  expect(isActive('runtime:pod:ds-a')).toBe(true);
  expect(isActive('logical:service:deepseek')).toBe(true);
  expect(isActive('physical:gpu:GPU-00000000-0000-0000-0000-000000000001')).toBe(false);
  expect(isActive('physical:host:gpu-a')).toBe(true);
  expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: german.com_status_back }));
  expect(active()).toEqual(hardware.active);
  expect(camera()).toEqual(hardware.camera);
  expect(
    screen.getByRole('button', { name: german.com_status_preset_infrastructure }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
});

it('keeps explicit CPU/GPU roles and the Kubernetes anchor accessible across all detail levels', () => {
  const s = snapshot();
  const view = render(
    <StatusPresentation
      snapshot={s}
      now={s.generatedAt}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  for (const key of ['overview', 'infrastructure', 'processing'] as const) {
    fireEvent.click(screen.getByRole('button', { name: german[`com_status_preset_${key}`] }));
    const cpu = screen.getByRole('button', { name: /Diensteserver A:.*CPU-Server/ });
    const gpu = screen.getByRole('button', { name: /GPU-Server A:.*GPU-Server/ });
    const cluster = screen.getByRole('button', { name: /Kubernetes-Cluster:/ });
    expect(cpu).toHaveAttribute('data-resource', 'cpu-server');
    expect(gpu).toHaveAttribute('data-resource', 'gpu-server');
    expect(cpu.querySelector('[data-role-icon="cpu"]')).toBeInTheDocument();
    expect(gpu.querySelector('[data-role-icon="gpu"]')).toBeInTheDocument();
    expect(cluster.querySelector('[data-frame="cluster"]')).toBeInTheDocument();
    expect(cpu).not.toHaveClass('is-context');
    expect(gpu).not.toHaveClass('is-context');
    expect(cluster).not.toHaveClass('is-context');
    expect(view.container.querySelectorAll('.cortex-status-scene')).toHaveLength(1);
  }
  fireEvent.change(screen.getByRole('textbox', { name: german.com_status_search }), {
    target: { value: 'CPU-Server' },
  });
  const result = within(
    screen.getByRole('region', { name: german.com_status_search_results }),
  ).getByRole('button', { name: 'Diensteserver A · CPU-Server' });
  expect(result).toBeInTheDocument();
  // Search results unmount on activation; focus must move to the stable committed node first.
  const selectedNode = screen.getByRole('button', { name: /Diensteserver A:.*CPU-Server/ });
  result.focus();
  fireEvent.click(result);
  expect(selectedNode.isConnected).toBe(true);
  expect(selectedNode).toHaveFocus();
  expect(
    screen.queryByRole('region', { name: german.com_status_search_results }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Diensteserver A' })).toBeInTheDocument();
  // Re-selecting the same resource must complete a new focus request too.
  fireEvent.change(screen.getByRole('textbox', { name: german.com_status_search }), {
    target: { value: 'CPU-Server' },
  });
  const repeatedResult = within(
    screen.getByRole('region', { name: german.com_status_search_results }),
  ).getByRole('button', { name: 'Diensteserver A · CPU-Server' });
  repeatedResult.focus();
  fireEvent.click(repeatedResult);
  expect(selectedNode).toHaveFocus();
  expect(
    screen.queryByRole('region', { name: german.com_status_search_results }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(german.com_status_classification_known)).toBeInTheDocument();
});

// The real presentation measures its SVG, keeps role glyphs readable, and retains independent state.
it('retains compact role, unknown-role and health cues when the measured canvas shrinks', () => {
  const s = snapshot();
  const unknown = s.nodes.find((n) => n.id === 'physical:host:gpu-b')!;
  unknown.classification = null;
  expect(readStatusSnapshot(encodeStatusSnapshot(s))).not.toBeNull();
  let box = {
    width: 390,
    height: 288,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 390,
    bottom: 288,
    toJSON: () => ({}),
  };
  const measurement = jest
    .spyOn(SVGElement.prototype, 'getBoundingClientRect')
    .mockImplementation(() => box);
  try {
    const view = render(
      <StatusPresentation
        snapshot={s}
        now={s.generatedAt}
        refreshing={false}
        onRefresh={jest.fn()}
      />,
    );
    const scene = screen.getByRole('group', { name: german.com_status_topology });
    const cpu = screen.getByRole('button', { name: /Diensteserver A:.*CPU-Server/ });
    const gpu = screen.getByRole('button', { name: /GPU-Server A:.*GPU-Server/ });
    const unknownNode = screen.getByRole('button', {
      name: new RegExp(`GPU-Server B:.*${german.com_status_role_unknown}`),
    });
    const cluster = screen.getByRole('button', { name: /Kubernetes-Cluster:/ });
    const states = [cpu, gpu, unknownNode, cluster].map((node) => node.getAttribute('data-state'));
    for (const [node, label] of [
      [cpu, 'CPU'],
      [gpu, 'GPU'],
      [unknownNode, '?'],
      [cluster, german.com_status_role_cluster],
    ] as const) {
      expect(node.querySelector('[data-screen-label]')).toHaveTextContent(label);
      expect(node.querySelector('[data-screen-state]')).toBeInTheDocument();
      expect(node).toHaveAttribute('tabindex', '0');
    }
    const pixelScale = Number(scene.getAttribute('data-pixel-scale'));
    expect(pixelScale).toBeLessThan(1);
    expect(cpu.querySelector('[data-compact-role]')?.getAttribute('transform')).toContain(
      `scale(${1 / pixelScale})`,
    );
    fireEvent.click(cpu);
    expect(cpu).toHaveClass('is-selected');
    expect(view.container.querySelector('[data-inspector-open="true"]')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Diensteserver A' })).toBeInTheDocument();
    box = { ...box, height: 155.52, bottom: 155.52 };
    fireEvent(window, new Event('resize'));
    const resizedScale = Number(scene.getAttribute('data-pixel-scale'));
    expect(resizedScale).toBeLessThan(pixelScale);
    expect(cpu.querySelector('[data-compact-role]')?.getAttribute('transform')).toContain(
      `scale(${1 / resizedScale})`,
    );
    expect([cpu, gpu, unknownNode, cluster].map((node) => node.getAttribute('data-state'))).toEqual(
      states,
    );
    expect(screen.getAllByRole('group', { name: german.com_status_topology })).toHaveLength(1);
    // A compact role must not erase visible state distinctions or rely on color/aria alone.
    const stateCases = [
      ['healthy', 'observed'],
      ['degraded', 'partial_coverage'],
      ['unknown', 'not_measured'],
      ['stale', 'source_stale'],
      ['disabled', 'not_configured'],
      ['unavailable', 'source_unavailable'],
      ['disagreement', 'sources_disagree'],
    ] as const;
    const symbols = new Set<string>();
    for (const [state, reason] of stateCases) {
      const next = snapshot();
      const host = next.nodes.find((n) => n.id === 'physical:host:control-a')!;
      const evidence = { ...next.edges[0].evidence[0] };
      if (state === 'stale') evidence.observedAt = next.generatedAt - evidence.maxAgeSeconds - 1;
      host.assessments = [
        {
          dimension: 'availability',
          state,
          reason,
          evidence:
            state === 'disagreement' ? [evidence, { ...evidence, sourceId: 'cpu3' }] : [evidence],
        },
      ];
      const admitted = readStatusSnapshot(encodeStatusSnapshot(next));
      expect(admitted).not.toBeNull();
      view.rerender(
        <StatusPresentation
          snapshot={admitted!}
          now={next.generatedAt}
          refreshing={false}
          onRefresh={jest.fn()}
        />,
      );
      const stateIcon = cpu.querySelector('[data-screen-state]')!;
      expect(stateIcon).toHaveAttribute('data-screen-state', state);
      expect(stateIcon.querySelector('rect')).toHaveAttribute('width', '10');
      expect(stateIcon.querySelector('rect')).toHaveAttribute('height', '10');
      const path = stateIcon.querySelector('path')!.getAttribute('d')!;
      symbols.add(path);
      const legend = view.container.querySelector(`[data-legend-state="${state}"]`)!;
      expect(legend).toHaveTextContent(german[`com_status_state_${state}`]);
      expect(legend.querySelector('path')).toHaveAttribute('d', path);
      expect(cpu).toHaveAttribute(
        'aria-label',
        expect.stringContaining(german[`com_status_state_${state}`]),
      );
      expect(cpu.querySelector('[data-screen-label]')).toHaveTextContent('CPU');
      expect(cpu.querySelector('[data-role-icon="cpu"]')).toBeInTheDocument();
    }
    expect(symbols.size).toBe(7);
    // The phone glyph keeps the native disclosure's full name and all resource choices.
    const summary = view.container.querySelector('summary')!;
    expect(summary).toHaveAccessibleName(german.com_status_resource_list);
    expect(summary.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(summary.querySelector('[data-list-label]')).toHaveTextContent(
      german.com_status_resource_list,
    );
    fireEvent.click(summary);
    const list = summary.closest('details')!;
    expect(list).toHaveAttribute('open');
    const resource = within(list).getByRole('button', { name: 'GPU-Server A · GPU-Server' });
    fireEvent.click(resource);
    expect(screen.getByRole('heading', { name: 'GPU-Server A' })).toBeInTheDocument();
    fireEvent.click(summary);
    expect(list).not.toHaveAttribute('open');
  } finally {
    measurement.mockRestore();
  }
});
