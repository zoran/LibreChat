import * as mockReact from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import mockGerman from '~/locales/de/translation.json';
import { WorkspaceSurface, WorkspaceToggle } from './WorkspaceSurface';

let mockUser = { id: 'owner', tenantId: null as string | null };
let mockConfig = { documentWorkspace: { enabled: true, eligible: true } };
let mockMobile = false;
let mockUnmounts = 0;
const mockResize = jest.fn();
const mockPanelRef = { current: { resize: mockResize } };
jest.mock('recoil', () => ({ useRecoilValue: () => mockUser }));
jest.mock('~/store', () => ({ __esModule: true, default: { user: 'user' } }));
jest.mock('~/data-provider', () => ({ useGetStartupConfig: () => ({ data: mockConfig }) }));
jest.mock('~/hooks/Nav/useDrawerViewport', () => () => mockMobile);
jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => (mockGerman as Record<string, string>)[key] ?? key,
}));
jest.mock('~/lib/assets/lazy', () => ({ lazyWithRecovery: mockReact.lazy }));
jest.mock('react-resizable-panels', () => ({ usePanelRef: () => mockPanelRef }));
/** Layout port double; the browser acceptance exercises actual sizing and Monaco. */
jest.mock('@librechat/client', () => ({
  Button: ({ variant: _variant, size: _size, ...props }: Record<string, unknown>) => (
    <button {...props} />
  ),
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="resize-group">{children}</div>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandleAlt: () => <div role="separator" />,
}));
jest.mock('./WorkspacePanel', () => ({
  WorkspacePanel: function PrivateEditor() {
    const [text, setText] = mockReact.useState('');
    mockReact.useEffect(
      () => () => {
        mockUnmounts++;
      },
      [],
    );
    return (
      <textarea
        aria-label="Lokaler Entwurf"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  },
}));

const view = () => (
  <WorkspaceSurface>
    <WorkspaceToggle />
    <p>{'Chat bleibt erhalten'}</p>
  </WorkspaceSurface>
);

describe('workspace chat integration', () => {
  beforeEach(() => {
    mockUser = { id: 'owner', tenantId: null };
    mockConfig = { documentWorkspace: { enabled: true, eligible: true } };
    mockMobile = false;
    mockUnmounts = 0;
    mockResize.mockClear();
  });
  it.each(['enabled', 'eligible'] as const)(
    'leaves native chat layout unchanged without %s',
    (flag) => {
      mockConfig.documentWorkspace[flag] = false;
      render(view());
      expect(screen.getByText('Chat bleibt erhalten')).toBeVisible();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('resize-group')).not.toBeInTheDocument();
    },
  );
  it('preserves the same editor and local text when hidden, reopened and moved to mobile', async () => {
    const component = render(view());
    const toggle = screen.getByRole('button', { name: 'Dokumentenarbeitsbereich' });
    fireEvent.click(toggle);
    const editor = await screen.findByRole('textbox');
    fireEvent.change(editor, { target: { value: 'Ungespeicherter Entwurf' } });
    expect(mockResize).toHaveBeenLastCalledWith('50');
    fireEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich ausblenden' }));
    expect(editor).not.toBeVisible();
    await waitFor(() => expect(toggle).toHaveFocus());
    expect(mockResize).toHaveBeenLastCalledWith('0');
    fireEvent.click(toggle);
    mockMobile = true;
    component.rerender(view());
    expect(editor).toBeVisible();
    expect(editor).toHaveValue('Ungespeicherter Entwurf');
    expect(screen.getByText('Chat bleibt erhalten')).not.toBeVisible();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect(mockResize).toHaveBeenLastCalledWith('100');
    expect(mockUnmounts).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Arbeitsbereich ausblenden' }));
    expect(screen.getByText('Chat bleibt erhalten')).toBeVisible();
  });
  it('disposes private editor state on identity change and on disabled capability', async () => {
    const component = render(view());
    fireEvent.click(screen.getByRole('button', { name: 'Dokumentenarbeitsbereich' }));
    await screen.findByRole('textbox');
    mockUser = { id: 'another', tenantId: 'other' };
    component.rerender(view());
    expect(mockUnmounts).toBe(1);
    expect(screen.queryByRole('textbox', { hidden: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dokumentenarbeitsbereich' }));
    await screen.findByRole('textbox');
    mockConfig.documentWorkspace.enabled = false;
    component.rerender(view());
    expect(mockUnmounts).toBe(2);
    expect(screen.queryByRole('textbox', { hidden: true })).not.toBeInTheDocument();
  });
});
