import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { DocumentStructure } from 'librechat-data-provider';
import DocumentSourceView from '../DocumentSourceView';

let mockLanguage = 'de';
jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, options: Record<string, unknown> = {}) => {
      const locale =
        mockLanguage === 'de'
          ? jest.requireActual('~/locales/de/translation.json')
          : jest.requireActual('~/locales/en/translation.json');
      return Object.entries(options).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        locale[key] as string,
      );
    },
}));

const structure = (text: string): DocumentStructure => ({
  version: 1,
  source: { sha256: 'a'.repeat(64), bytes: Math.max(1, text.length), mediaType: 'text/plain' },
  extractor: { name: 'fixture', version: '1' },
  pages: [],
  elements: [
    { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
  ],
  quality: { status: 'complete', warnings: [] },
});
const paged = (kind: 'page' | 'slide' = 'page') => {
  const text = 'Erster Text\nZweiter Text';
  const document = structure(text);
  document.pages = [
    { number: 1, kind },
    { number: 2, kind },
  ];
  document.elements = [
    { ...document.elements[0], end: 11, page: 1 },
    { ...document.elements[0], id: 'e2', start: 12, page: 2 },
  ];
  return { text, structure: document };
};
beforeEach(() => {
  mockLanguage = 'de';
});

it('navigates actual pages using native keyboard-accessible controls and current-position labels', async () => {
  const user = userEvent.setup();
  render(<DocumentSourceView {...paged()} />);
  const page = screen.getByRole('navigation', { name: 'Seite' });
  expect(within(page).getByRole('status')).toHaveTextContent('Seite 1 von 2');
  expect(screen.getByLabelText('Extrahierter Text')).toHaveTextContent('Erster Text');
  const next = within(page).getByRole('button', { name: 'Weiter (Seite)' });
  next.focus();
  await user.keyboard('{Enter}');
  expect(within(page).getByRole('status')).toHaveTextContent('Seite 2 von 2');
  expect(screen.getByLabelText('Extrahierter Text')).toHaveTextContent('Zweiter Text');
  expect(screen.getByLabelText('Extrahierter Text')).not.toHaveTextContent('Erster Text');
  expect(next).toBeDisabled();
});

it('uses source sections and stable element anchors without inventing pages for pageless text', async () => {
  const input = paged();
  input.structure.pages = [];
  input.structure.elements.forEach((element) => {
    element.page = null;
  });
  render(<DocumentSourceView {...input} initialElementId="e2" />);
  expect(screen.queryByRole('navigation', { name: 'Seite' })).not.toBeInTheDocument();
  expect(screen.queryByRole('navigation', { name: 'Folie' })).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Abschnitt 2 von 2');
  expect(document.getElementById(`document-${'a'.repeat(64)}-fixture-1-e2`)).toHaveTextContent(
    'Zweiter Text',
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Zurück (Abschnitt)' }));
  expect(screen.getByRole('status')).toHaveTextContent('Abschnitt 1 von 2');
});

it('labels real slides and respects an initial page reference', () => {
  render(<DocumentSourceView {...paged('slide')} initialPage={2} />);
  expect(screen.getByRole('navigation', { name: 'Folie' })).toHaveTextContent('Folie 2 von 2');
  expect(screen.getByLabelText('Extrahierter Text')).toHaveTextContent('Zweiter Text');
  expect(screen.queryByRole('navigation', { name: 'Seite' })).not.toBeInTheDocument();
});

it('shows explicit partial extraction limitations in German and English fallback copy', () => {
  const text = 'Verfügbarer Text';
  const document = structure(text);
  document.quality = {
    status: 'partial',
    warnings: [
      'layout_unavailable',
      'visual_content_not_extracted',
      'table_structure_unavailable',
      'unsupported_content',
    ],
  };
  const view = render(<DocumentSourceView text={text} structure={document} />);
  expect(screen.getByRole('note')).toHaveTextContent('Die Extraktion ist unvollständig.');
  expect(within(screen.getByRole('note')).getAllByRole('listitem')).toHaveLength(4);
  expect(screen.getByRole('note')).toHaveTextContent(
    'Bilder und andere visuelle Inhalte wurden nicht als Text erfasst.',
  );
  mockLanguage = 'en';
  view.rerender(<DocumentSourceView text={text} structure={document} />);
  expect(screen.getByRole('note')).toHaveTextContent('This extraction is incomplete.');
  expect(screen.getByRole('region', { name: 'Document source' })).toBeInTheDocument();
});

it('renders source markup and URL-like content solely as inert text', () => {
  const text =
    '<img src=x onerror=alert(1)><script>danger()</script> [open](javascript:danger()) https://example.invalid';
  const view = render(<DocumentSourceView text={text} structure={structure(text)} />);
  expect(screen.getByLabelText('Extrahierter Text').textContent).toBe(text);
  expect(view.container.querySelector('img,script,iframe,a')).toBeNull();
});

it('keeps every large text range reachable without splitting surrogate pairs or retaining a huge DOM', async () => {
  const text = 'a'.repeat(16_383) + '😀' + 'Ende';
  render(<DocumentSourceView text={text} structure={structure(text)} />);
  const first = screen.getByLabelText('Extrahierter Text').textContent!;
  expect(first).toBe('a'.repeat(16_383));
  expect(screen.getByRole('navigation', { name: 'Textausschnitt' })).toHaveTextContent(
    'Textausschnitt 1 von 2',
  );
  await userEvent.setup().click(screen.getByRole('button', { name: 'Weiter (Textausschnitt)' }));
  expect(first + screen.getByLabelText('Extrahierter Text').textContent).toBe(text);
});

it('bounds DOM size at the independent 20000-element ceiling and permits direct section navigation', () => {
  const text = 'x\n'.repeat(20_000);
  const document = structure(text);
  // Cardinality stress fixture; no claim that its serialized structure fits the narrower wire limit.
  document.elements = Array.from({ length: 20_000 }, (_, i) => ({
    id: `e${i + 1}`,
    kind: 'paragraph',
    start: i * 2,
    end: i * 2 + 1,
    page: null,
    parentId: null,
  }));
  const view = render(<DocumentSourceView text={text} structure={document} />);
  expect(view.container.querySelectorAll('*').length).toBeLessThan(100);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Gehe zu: Abschnitt' }), {
    target: { value: '20000' },
  });
  expect(screen.getByRole('status')).toHaveTextContent('Abschnitt 20000 von 20000');
  expect(view.container.querySelectorAll('*').length).toBeLessThan(100);
});

it('keeps unassigned source text reachable without adding a fictitious page', async () => {
  const input = paged();
  input.text += '\nUnzugeordnet';
  const user = userEvent.setup();
  render(<DocumentSourceView {...input} />);
  expect(screen.getByRole('navigation', { name: 'Seite' })).toHaveTextContent('Seite 1 von 2');
  await user.click(
    screen.getByRole('button', { name: 'Text ohne Seiten- oder Abschnittszuordnung' }),
  );
  expect(screen.getByLabelText('Extrahierter Text')).toHaveTextContent('Unzugeordnet');
  expect(screen.queryByRole('navigation', { name: 'Seite' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Seite 1' }));
  expect(screen.getByRole('navigation', { name: 'Seite' })).toHaveTextContent('Seite 1 von 2');
});

it('renders only actual bounded cells as a table and falls back to exact text for sparse grids', () => {
  const text = 'A\tB';
  const document = structure(text);
  document.elements = [
    { ...document.elements[0], kind: 'table' },
    {
      id: 'e2',
      kind: 'cell',
      start: 0,
      end: 1,
      page: null,
      parentId: 'e1',
      cell: { row: 0, column: 0, rowSpan: 1, columnSpan: 1 },
    },
    {
      id: 'e3',
      kind: 'cell',
      start: 2,
      end: 3,
      page: null,
      parentId: 'e1',
      cell: { row: 0, column: 1, rowSpan: 1, columnSpan: 1 },
    },
  ];
  const view = render(
    <DocumentSourceView text={text} structure={document} initialElementId="e3" />,
  );
  expect(screen.getByRole('table', { name: 'Extrahierte Tabelle' })).toBeInTheDocument();
  expect(screen.getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['A', 'B']);
  const sparse = {
    ...document,
    elements: document.elements.map((element) =>
      element.id === 'e3' ? { ...element, cell: { ...element.cell!, column: 2 } } : element,
    ),
  };
  view.rerender(<DocumentSourceView text={text} structure={sparse} initialElementId="e3" />);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Extrahierter Text').textContent).toBe(text);
  expect(
    window.document.getElementById(`document-${'a'.repeat(64)}-fixture-1-e3`),
  ).toHaveTextContent('B');
});

it('shows a real empty page without borrowing text from a different page', () => {
  const input = paged();
  input.structure.pages.push({ number: 3, kind: 'page' });
  render(<DocumentSourceView {...input} initialPage={3} />);
  expect(screen.getByRole('navigation', { name: 'Seite' })).toHaveTextContent('Seite 3 von 3');
  expect(
    screen.getByText('Für diesen Quellenbereich ist kein extrahierter Text vorhanden.'),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText('Extrahierter Text')).not.toBeInTheDocument();
});
