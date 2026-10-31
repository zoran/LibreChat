/** UploadAvailabilityHint verifies the real accessible primitive without browser or backend claims. */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { UploadAvailabilityHint } from './UploadAvailabilityHint';

const attachmentLabel = 'Datei hochladen';
const reason = 'Uploads sind vorübergehend nicht möglich, weil der Speicher nicht erreichbar ist.';
const view = (blocked = true) =>
  render(
    <UploadAvailabilityHint label="Datei hochladen" reason={blocked ? reason : null}>
      <button disabled={blocked} onClick={jest.fn()}>
        {attachmentLabel}
      </button>
    </UploadAvailabilityHint>,
  );
const anchor = () => screen.getByRole('group', { name: 'Datei hochladen' });

describe('visible disabled upload explanation', () => {
  it('keeps the native button visible/disabled and exposes its reason to keyboard focus', async () => {
    const user = userEvent.setup();
    view();
    expect(
      screen.getAllByRole('button').find((element) => element.tagName === 'BUTTON'),
    ).toBeDisabled();
    await user.tab();
    expect(anchor()).toHaveFocus();
    fireEvent.keyDown(anchor(), { key: 'Enter' });
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(reason));
    expect(screen.getByRole('button', { name: 'Datei hochladen' })).toBeDisabled();
  });
  it('exposes the same reason on touch activation without activating a disabled upload', async () => {
    view();
    fireEvent.pointerDown(anchor(), { pointerType: 'touch' });
    fireEvent.click(anchor());
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent(reason));
  });
  it('removes only the explanatory wrapper after recovery', () => {
    view(false);
    expect(screen.getByRole('button', { name: 'Datei hochladen' })).toBeEnabled();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
