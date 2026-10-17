import React from 'react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ArtifactConflict } from '../ArtifactConflict';
import de from '~/locales/de/translation.json';
import en from '~/locales/en/translation.json';

jest.unmock('react-i18next');
jest.mock('../monaco', () => ({
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div>
      <pre aria-label="saved">{original}</pre>
      <pre aria-label="draft">{modified}</pre>
    </div>
  ),
}));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'de',
    fallbackLng: 'en',
    resources: { de: { translation: de }, en: { translation: en } },
  });
});
const revision = { messageId: 'message', index: 0, content: 'SAVED', version: 4 };
const setup = (load = jest.fn().mockResolvedValue(revision)) => {
  const resolve = jest.fn();
  const tree = (draft: string) => (
    <I18nextProvider i18n={i18n}>
      <ArtifactConflict
        draft={draft}
        language="plaintext"
        theme="light"
        disabled={false}
        load={load}
        onResolve={resolve}
      />
    </I18nextProvider>
  );
  const view = render(tree('LOCAL'));
  return { ...view, load, resolve, changeDraft: (draft: string) => view.rerender(tree(draft)) };
};
it('requires an explicit fresh comparison before either deliberate choice and keeps later draft changes visible', async () => {
  const view = setup();
  expect(screen.getByRole('alert')).toHaveTextContent('Automatisches Speichern ist pausiert');
  expect(
    screen.queryByRole('button', { name: de.com_ui_artifact_conflict_apply }),
  ).not.toBeInTheDocument();
  expect(view.load).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: de.com_ui_artifact_conflict_compare }));
  await screen.findByLabelText('saved');
  view.changeDraft('LATEST');
  expect(screen.getByLabelText('draft')).toHaveTextContent('LATEST');
  expect(view.resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: de.com_ui_artifact_conflict_apply }));
  expect(view.resolve).toHaveBeenCalledWith(revision, true);
});
it('offers adopting the saved version without a write', async () => {
  const view = setup();
  fireEvent.click(screen.getByRole('button', { name: de.com_ui_artifact_conflict_compare }));
  fireEvent.click(await screen.findByRole('button', { name: de.com_ui_artifact_conflict_adopt }));
  expect(view.resolve).toHaveBeenCalledWith(revision, false);
});
it('keeps a failed refresh blocked and permits only another explicit refresh', async () => {
  const view = setup(jest.fn().mockRejectedValue(new Error('private transport detail')));
  fireEvent.click(screen.getByRole('button', { name: de.com_ui_artifact_conflict_compare }));
  await screen.findByText(de.com_ui_artifact_conflict_load_error);
  expect(screen.queryByText('private transport detail')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: de.com_ui_artifact_conflict_apply }),
  ).not.toBeInTheDocument();
  expect(view.load).toHaveBeenCalledTimes(1);
  expect(view.resolve).not.toHaveBeenCalled();
});
it('does not reconcile a late refresh after the pane is gone', async () => {
  let done!: (value: typeof revision) => void;
  const view = setup(
    jest.fn(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: de.com_ui_artifact_conflict_compare }));
  expect(screen.getByRole('status')).toBeInTheDocument();
  view.unmount();
  await act(async () => done(revision));
  expect(view.resolve).not.toHaveBeenCalled();
});
