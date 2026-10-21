import React from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { createUnknownStatusUsage, readStatusSnapshot } from 'librechat-data-provider';
import type { StatusComparisonReference, StatusUsageGroups } from 'librechat-data-provider';
import fixture from '../../../../../packages/data-provider/src/status-fixtures/representative.json';
import StatusUsageSummary, { StatusUsageDetails, usageValue, usageQuality } from '../StatusUsage';
import german from '../../../locales/de/translation.json';
import { StatusPresentation } from '../StatusView';

type MutableUsageGroups = {
  -readonly [K in keyof StatusUsageGroups]: StatusUsageGroups[K];
};
jest.mock('~/components/ui/AppLogo', () => () => <img alt="Cortex" />);
jest.mock('~/hooks/Nav/useSidebarState', () => () => ({ isSmallScreen: false }));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);
jest.mock('~/utils/presentation', () => ({ getAppTitle: () => 'Cortex' }));
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: {} }) }));
jest.mock('~/data-provider/Status', () => ({
  useStatusAccessQuery: jest.fn(),
  useStatusSnapshotQuery: jest.fn(),
  statusCode: jest.fn(),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'synthetic' }, isAuthenticated: true }),
  useDocumentTitle: () => {},
  useLocalize: () => (key: keyof typeof german) =>
    jest.requireActual('../../../locales/de/translation.json')[key] ?? key,
}));
const now = 1792436400;
const observed = <T,>(values: T, quality = 'complete') => ({
  quality,
  reason: quality === 'partial' ? 'partial_coverage' : 'observed',
  sourceId: 'usage-observer',
  observedAt: now,
  maxAgeSeconds: 90,
  coverage: {
    expected: 3600,
    observed: quality === 'partial' ? 1800 : 3600,
    basis: 'scheduled_seconds',
  },
  values,
});
it('keeps all168 UTC hours unknown without inventing zero bars, including keyboard hour selection', () => {
  const usage = createUnknownStatusUsage(now);
  const view = render(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  expect(usage.history.rows).toHaveLength(168);
  expect(view.container.querySelectorAll('svg rect')).toHaveLength(0);
  expect(screen.getByRole('slider')).toHaveAttribute('max', '167');
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(view.container.querySelector('output')).toHaveTextContent('nicht gemessen');
  expect(view.container.querySelector('output')).toHaveTextContent('UTC');
});
it('distinguishes a true zero, a partial observation, missing data and expired source capture', () => {
  const zero = observed({ active: 0 });
  expect(usageValue(zero as never, 'active', now)).toBe(0);
  expect(usageValue({ ...zero, quality: 'unknown' } as never, 'active', now)).toBeNull();
  expect(usageValue(zero as never, 'active', now + 91)).toBeNull();
  expect(usageQuality(zero as never, now + 91)).toBe('stale');
  const usage = createUnknownStatusUsage(now);
  (usage.history.rows[0].groups as MutableUsageGroups).users = observed({
    active: 0,
    concurrentMeanMicros: 0,
    concurrentPeak: 0,
  }) as never;
  (usage.history.rows[167].groups as MutableUsageGroups).users = observed(
    { active: 12, concurrentMeanMicros: 4e6, concurrentPeak: 8 },
    'partial',
  ) as never;
  const view = render(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  expect(view.container.querySelectorAll('svg rect')).toHaveLength(2);
  expect(view.container.querySelector('[data-quality="partial"]')).toBeInTheDocument();
  expect(view.container.querySelector('output')).toHaveTextContent('12 (beobachteter Teilwert)');
  expect(view.container.querySelector('output')).toHaveTextContent('1800/3600');
});
it('converts microseconds only for display and ages capture, never the historical hour', () => {
  const usage = createUnknownStatusUsage(now);
  (usage.history.rows[0].groups as MutableUsageGroups).latency = observed({
    p50Micros: 1250000,
    p95Micros: 2000000,
    sampleCount: 1,
    eligibleStarts: 1,
    missing: 0,
    aborted: 0,
    hidden: 0,
    replayed: 0,
  }) as never;
  const view = render(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p50' } });
  fireEvent.change(screen.getByRole('slider'), { target: { value: '0' } });
  expect(view.container.querySelector('output')).toHaveTextContent('1,25 s');
  expect(view.container.querySelectorAll('svg rect')).toHaveLength(1);
});
it('shows source, eligibility gaps, missing reference and closes the actual details pane', () => {
  const close = jest.fn();
  const usage = createUnknownStatusUsage(now);
  render(<StatusUsageDetails usage={usage} now={now} onClose={close} />);
  expect(screen.getByText(german.com_status_usage_missing_reference)).toBeInTheDocument();
  expect(screen.getByText(german.com_status_usage_eligibleStarts)).toBeInTheDocument();
  expect(screen.getByText(german.com_status_usage_missingUsage)).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
  expect(close).toHaveBeenCalledTimes(1);
});
it('preserves valid USD and explicit absent FX without inventing EUR or arbitrary reference links', () => {
  const usage = createUnknownStatusUsage(now);
  (usage.lastHour.groups as MutableUsageGroups).valuation = observed({
    model1UsdMicros: 2500000,
    model2UsdMicros: 2500000,
    model3UsdMicros: 500000,
    model1EurMicros: null,
    model2EurMicros: null,
    model3EurMicros: null,
    meanEurMicros: null,
  }) as never;
  usage.comparisonReference = {
    id: 'verified-reference',
    observedAt: now,
    valuationDate: '2026-10-19',
    reviewBefore: '2026-12-01',
    scenario: 'uncached_nominal',
    weighting: 'equal',
    models: ['gpt-6-astra', 'claude-fable-5-1', 'gemini-4-argon'].map((modelId, i) => ({
      modelId,
      sourceKey: ['openai_api_pricing', 'anthropic_api_pricing', 'google_api_pricing'][i],
      tiers: [
        {
          upperInputTokens: null,
          inputUsdMicrosPerMillion: 10000000,
          outputUsdMicrosPerMillion: 50000000,
        },
      ],
    })),
    fx: null,
  } as never;
  const view = render(<StatusUsageDetails usage={usage} now={now} onClose={jest.fn()} />);
  expect(view.container).toHaveTextContent('2,5 USD');
  expect(view.container).toHaveTextContent(german.com_status_usage_missing_fx);
  expect(screen.getByRole('link', { name: 'OpenAI' })).toHaveAttribute(
    'href',
    'https://developers.openai.com/api/docs/pricing',
  );
  expect(view.container).not.toHaveTextContent('0 EUR');
});
it('opens real integrated usage details by keyboard, closes with Escape and retains topology selection', async () => {
  const user = userEvent.setup();
  const snapshot = readStatusSnapshot(fixture);
  if (!snapshot) throw Error('Invalid frozen v3 fixture');
  render(
    <StatusPresentation
      snapshot={snapshot}
      now={snapshot.generatedAt}
      refreshing={false}
      onRefresh={jest.fn()}
    />,
  );
  const node = screen
    .getAllByRole('button')
    .find((element) => element.hasAttribute('data-node-id'))!;
  node.focus();
  await user.keyboard('{Enter}');
  expect(node).toHaveAttribute('aria-pressed', 'true');
  const opener = screen.getByRole('button', { name: german.com_status_usage_details });
  expect(opener).toHaveAttribute('aria-expanded', 'false');
  opener.focus();
  await user.keyboard('{Enter}');
  const pane = screen.getByRole('complementary', { name: german.com_status_usage_details });
  expect(opener).toHaveAttribute('aria-expanded', 'true');
  expect(opener).toHaveAttribute('aria-controls', pane.id);
  expect(screen.getByRole('heading', { name: german.com_status_usage_title })).toHaveFocus();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(opener).toHaveFocus());
  expect(opener).toHaveAttribute('aria-expanded', 'false');
  expect(
    screen.queryByRole('complementary', { name: german.com_status_usage_details }),
  ).not.toBeInTheDocument();
  expect(node).toHaveAttribute('aria-pressed', 'true');
});
it('announces UTC, zero/partial/unknown value quality through keyboard hour selection and associated output', async () => {
  const user = userEvent.setup();
  const usage = createUnknownStatusUsage(now);
  (usage.history.rows[0].groups as MutableUsageGroups).users = observed({
    active: 0,
    concurrentMeanMicros: 0,
    concurrentPeak: 0,
  }) as never;
  (usage.history.rows[1].groups as MutableUsageGroups).users = observed(
    { active: 12, concurrentMeanMicros: 4e6, concurrentPeak: 8 },
    'partial',
  ) as never;
  const view = render(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  const slider = screen.getByRole('slider');
  const output = view.container.querySelector('output')!;
  expect(slider).toHaveAttribute('aria-describedby', output.id);
  expect(output).toHaveAttribute('for', slider.id);
  slider.focus();
  await user.keyboard('{Home}');
  expect(slider).toHaveValue('0');
  expect(slider.getAttribute('aria-valuetext')).toMatch(/UTC.*: 0 · vollständig/);
  await user.keyboard('{ArrowRight}');
  expect(slider).toHaveValue('1');
  expect(slider.getAttribute('aria-valuetext')).toMatch(
    /UTC.*12.*teilweise erfasst.*beobachteter Teilwert/,
  );
  await user.keyboard('{End}');
  expect(slider).toHaveValue('167');
  expect(slider.getAttribute('aria-valuetext')).toMatch(/UTC.*—.*unbekannt/);
  await user.keyboard('{ArrowRight}');
  expect(slider).toHaveValue('167');
});
it('labels the Euro graph with its one price date, carried FX date and stale state without opening details', async () => {
  const user = userEvent.setup();
  const usage = createUnknownStatusUsage(now);
  usage.comparisonReference = {
    id: 'dated-reference',
    observedAt: now,
    valuationDate: '2026-10-19',
    reviewBefore: '2026-12-01',
    scenario: 'uncached_nominal',
    weighting: 'equal',
    models: [] as never,
    fx: {
      usdPerEurMicros: 1122500,
      rateDate: '2026-10-16',
      observedAt: now - 3600,
      sourceKey: 'ecb_euro_reference_usd',
      carriedForward: true,
      stale: true,
    },
  } as StatusComparisonReference;
  const view = render(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  await user.selectOptions(screen.getByRole('combobox'), 'euro');
  const reference = view.container.querySelector('[data-euro-reference]')!;
  expect(reference).toHaveTextContent('Preisreferenz vom 2026-10-19');
  expect(reference).toHaveTextContent('2026-10-16');
  expect(reference).toHaveTextContent(german.com_status_usage_carried);
  expect(reference).toHaveTextContent('Wechselkurs veraltet');
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  usage.comparisonReference!.fx!.carriedForward = false;
  usage.comparisonReference!.fx!.stale = false;
  usage.comparisonReference!.fx!.rateDate = '2026-10-19';
  view.rerender(<StatusUsageSummary usage={usage} now={now} onDetails={jest.fn()} />);
  expect(reference).toHaveTextContent(german.com_status_usage_same_day);
  expect(reference).not.toHaveTextContent('Wechselkurs veraltet');
});
