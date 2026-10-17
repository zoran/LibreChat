import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, waitFor } from '@testing-library/react';
import { MyFilesModal } from './MyFilesModal';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
const mockProjectAction = jest.fn();
jest.mock('~/components/Projects/ProjectLibraryAction', () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockProjectAction(props);
    return <div>{'project-library-action'}</div>;
  },
}));
jest.mock('~/features/library', () => ({
  FileLibrary: ({
    renderSelectionActions,
  }: {
    renderSelectionActions: (selection: object) => React.ReactNode;
  }) => (
    <div>
      {'native-library'}
      {renderSelectionActions({ files: [], disabled: true, clearSelection: jest.fn() })}
    </div>
  ),
}));

function Harness({ trigger }: { trigger: HTMLElement }) {
  const [open, setOpen] = useState(true);
  return <MyFilesModal open={open} onOpenChange={setOpen} triggerRef={{ current: trigger }} />;
}

describe('MyFilesModal focus restoration', () => {
  it('returns focus to the shortcut invoker instead of the account button', async () => {
    const user = userEvent.setup();
    const invoker = document.createElement('button');
    const inertSidebar = document.createElement('div');
    const accountButton = document.createElement('button');
    inertSidebar.setAttribute('inert', '');
    inertSidebar.append(accountButton);
    document.body.append(invoker, inertSidebar);
    invoker.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(invoker).toHaveFocus());
  });

  it('falls back to the account button when the dialog opens from its menu', async () => {
    const user = userEvent.setup();
    const menu = document.createElement('div');
    const menuItem = document.createElement('button');
    const accountButton = document.createElement('button');
    menu.setAttribute('role', 'menu');
    menu.append(menuItem);
    document.body.append(menu, accountButton);
    menuItem.focus();

    render(<Harness trigger={accountButton} />);
    await user.click(await screen.findByRole('button', { name: 'Close' }));

    await waitFor(() => expect(accountButton).toHaveFocus());
  });
});

it('mounts the library only while the existing dialog is open', async () => {
  const view = render(<MyFilesModal open={false} onOpenChange={jest.fn()} />);
  expect(screen.queryByText('native-library')).toBeNull();
  view.rerender(<MyFilesModal open onOpenChange={jest.fn()} />);
  expect(await screen.findByText('native-library')).toBeVisible();
  expect(screen.getByText('project-library-action')).toBeVisible();
  expect(mockProjectAction).toHaveBeenCalledWith(
    expect.objectContaining({ files: [], disabled: true, clearSelection: expect.any(Function) }),
  );
  view.rerender(<MyFilesModal open={false} onOpenChange={jest.fn()} />);
  expect(screen.queryByText('native-library')).toBeNull();
});

it('supports Escape and returns keyboard focus to the original invoker', async () => {
  const trigger = document.createElement('button');
  document.body.append(trigger);
  trigger.focus();
  render(<Harness trigger={trigger} />);
  await screen.findByText('native-library');
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
});
