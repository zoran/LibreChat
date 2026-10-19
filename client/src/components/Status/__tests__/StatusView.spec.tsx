import React from 'react';
import { readStatusSnapshot } from 'librechat-data-provider';
import { render, screen, fireEvent } from '@testing-library/react';
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
