import React from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { fireEvent, render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { ShareContext } from '~/Providers/ShareContext';
import de from '~/locales/de/translation.json';
import en from '~/locales/en/translation.json';
import SourceCoverage from '../SourceCoverage';

jest.unmock('react-i18next');

const i18n = createInstance();
const entry = (file_id = 'file-one', end = 8, total = 8) => ({
  file_id,
  source: { kind: 'message', id: 'user-one' },
  coverage: { unit: 'utf16', start: 0, end, total, complete: end === total },
  extraction: 'not_assessed',
});
const receipt = (entries: unknown[] = [entry()]) => ({
  version: 1,
  stage: 'prepared',
  scope: 'retained_sources',
  entries,
});
const message = (sourceCoverage: unknown = receipt(), overrides = {}) =>
  ({
    messageId: 'answer-one',
    conversationId: 'conversation-one',
    parentMessageId: 'user-one',
    isCreatedByUser: false,
    text: 'Answer',
    metadata: { sourceCoverage },
    ...overrides,
  }) as TMessage;

function view(value: TMessage | undefined, shared = {}) {
  return (
    <I18nextProvider i18n={i18n}>
      <ShareContext.Provider value={shared}>
        <SourceCoverage message={value} />
      </ShareContext.Provider>
    </I18nextProvider>
  );
}

beforeAll(async () => {
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    resources: { de: { translation: de }, en: { translation: en } },
    interpolation: { escapeValue: false },
  });
});
beforeEach(async () => {
  await i18n.changeLanguage('de');
});

describe('answer source coverage', () => {
  it('shows only prepared extracted-text coverage and its limits, without source identities', () => {
    const { container } = render(view(message(receipt([entry(), entry('file-two', 3, 20)]))));
    const summary = screen.getByText(de.com_ui_source_coverage_title);
    expect(summary.tagName).toBe('SUMMARY');
    const details = summary.closest('details')!;
    expect(details).not.toHaveAttribute('open');
    summary.focus();
    expect(summary).toHaveFocus();
    fireEvent.click(summary);
    expect(details).toHaveAttribute('open');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Gesamter verfügbarer Text vorbereitet.')).toBeInTheDocument();
    expect(screen.getByText('Teil des verfügbaren Textes vorbereitet (15 %).')).toBeInTheDocument();
    expect(screen.getByText(de.com_ui_source_coverage_scope)).toBeInTheDocument();
    expect(screen.getByText(de.com_ui_source_coverage_limits)).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/file-one|file-two|user-one|utf16|not_assessed/);
    expect(container.querySelector('a')).toBeNull();
  });

  it('uses the current answer after rerender and resets the disclosure on sibling changes', () => {
    const { rerender } = render(view(message()));
    fireEvent.click(screen.getByText(de.com_ui_source_coverage_title));
    rerender(view(message(receipt([entry('file-next', 2, 50)]), { messageId: 'answer-two' })));
    expect(
      screen.getByText(de.com_ui_source_coverage_title).closest('details'),
    ).not.toHaveAttribute('open');
    expect(screen.queryByText('Gesamter verfügbarer Text vorbereitet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(de.com_ui_source_coverage_title));
    expect(screen.getByText('Teil des verfügbaren Textes vorbereitet (4 %).')).toBeInTheDocument();
    rerender(view(message(undefined, { messageId: 'answer-three', metadata: {} })));
    expect(screen.queryByText(de.com_ui_source_coverage_title)).not.toBeInTheDocument();
  });

  it('renders the same persisted receipt after an ordinary reload', () => {
    const saved = message(receipt([entry('file-reload', 0, 12)]));
    const first = render(view(saved));
    fireEvent.click(screen.getByText(de.com_ui_source_coverage_title));
    const previous = first.container.textContent;
    first.unmount();
    const second = render(view(JSON.parse(JSON.stringify(saved))));
    expect(second.container.textContent).toBe(previous);
    expect(
      screen.getByText(de.com_ui_source_coverage_title).closest('details'),
    ).not.toHaveAttribute('open');
  });

  it.each([
    { isCreatedByUser: true },
    { isCreatedByUser: undefined },
    { isUserSubmitted: true },
    { isEdited: true },
    { sourceContentRemovedAt: '2026-10-17T00:00:00Z' },
    { sourceContentRemovedAt: '' },
  ])('suppresses untrusted or removed answer metadata: %j', (overrides) => {
    const { container } = render(view(message(receipt(), overrides)));
    expect(container).toBeEmptyDOMElement();
  });

  it.each([{ isSharedConvo: true }, { shareId: 'shared-one' }])(
    'suppresses metadata in either native share-context shape: %j',
    (shared) => {
      const { container } = render(view(message(), shared));
      expect(container).toBeEmptyDOMElement();
    },
  );

  it.each([
    null,
    {},
    { ...receipt(), version: 2 },
    { ...receipt(), stage: 'delivered' },
    { ...receipt(), scope: 'all_sources' },
    receipt([]),
    receipt([{ ...entry(), filename: 'private-name.txt' }]),
    receipt([{ ...entry(), coverage: { ...entry().coverage, end: 9 } }]),
    receipt([{ ...entry(), coverage: { ...entry().coverage, end: -1 } }]),
    receipt([
      { ...entry(), coverage: { ...entry().coverage, total: Number.MAX_SAFE_INTEGER + 1 } },
    ]),
    receipt([{ ...entry(), coverage: { ...entry().coverage, complete: false } }]),
    receipt([{ ...entry(), extraction: 'complete' }]),
    receipt(Array.from({ length: 65 }, (_, i) => entry(`file-${i}`))),
  ])('hides unknown or malformed coverage using the real reader: %j', (value) => {
    const { container } = render(view(message(value)));
    expect(container).toBeEmptyDOMElement();
  });

  it('never invokes a getter inside untrusted coverage', () => {
    const get = jest.fn(() => 1);
    const value = Object.defineProperty(receipt(), 'version', { get, enumerable: true });
    const { container } = render(view(message(value)));
    expect(container).toBeEmptyDOMElement();
    expect(get).not.toHaveBeenCalled();
  });

  it('shows every admitted entry without truncating the 64-entry bound', () => {
    render(view(message(receipt(Array.from({ length: 64 }, (_, i) => entry(`file-${i}`, 0, 1))))));
    fireEvent.click(screen.getByText(de.com_ui_source_coverage_title));
    expect(screen.getAllByRole('listitem')).toHaveLength(64);
    expect(screen.getByText('Quelle 64:')).toBeInTheDocument();
  });

  it('rounds partial coverage down without ever displaying it as complete', () => {
    render(
      view(
        message(
          receipt([entry('almost', 999, 1000), entry('tiny', 1, 1001), entry('none', 0, 100)]),
        ),
      ),
    );
    fireEvent.click(screen.getByText(de.com_ui_source_coverage_title));
    expect(screen.getByText('Teil des verfügbaren Textes vorbereitet (99 %).')).toBeInTheDocument();
    expect(screen.getByText('Teil des verfügbaren Textes vorbereitet (<1 %).')).toBeInTheDocument();
    expect(screen.getByText('Teil des verfügbaren Textes vorbereitet (0 %).')).toBeInTheDocument();
    expect(screen.queryByText('Gesamter verfügbarer Text vorbereitet.')).not.toBeInTheDocument();
  });

  it('uses the English translation when that locale is selected', async () => {
    await i18n.changeLanguage('en');
    render(view(message()));
    fireEvent.click(screen.getByText(en.com_ui_source_coverage_title));
    expect(screen.getByText('All available text prepared.')).toBeInTheDocument();
    expect(screen.getByText(en.com_ui_source_coverage_limits)).toBeInTheDocument();
  });
});
