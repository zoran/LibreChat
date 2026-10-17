import { createContext, useRef, useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
  OGDialog,
  OGDialogContent,
  OGDialogDescription,
  OGDialogTitle,
} from '@librechat/client';
import type { ReactNode } from 'react';
import { DRAWER_UNPAINTED, MOBILE_DRAWER_ID } from '../constants';
import UnifiedSidebar from '../UnifiedSidebar';

/**
 * A closed drawer is translated off the viewport, which hides it without taking
 * it out of the paint: iOS Safari composites the scroller inside it separately
 * and can leave that layer behind at the position it held while open, so the
 * Projects and Pinned rows keep painting over the conversation. These pin the
 * one state that cannot happen — a settled, closed drawer still being painted —
 * and the two windows where painting it is exactly the point.
 *
 * React owns the resting value here; the slide's release in useDrawerSwipe hands
 * this same value back rather than clearing the property, because React will not
 * re-assert a prop whose value it has not changed. Both sides read one constant
 * so they cannot drift apart.
 */

const mockSidebarState = { isSmallScreen: true, expanded: false, setExpanded: jest.fn() };
const mockSidebarContext = createContext(mockSidebarState);
const mockSetSidebarOpen = jest.fn();
let mockMobileContent: ReactNode = null;

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useMediaQuery: () => false,
  useRemScale: () => 1,
}));

jest.mock('~/hooks/Nav/useSidebarState', () => {
  const React = jest.requireActual('react');
  return {
    __esModule: true,
    default: function useSidebarState() {
      return React.useContext(mockSidebarContext);
    },
  };
});

jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: mockSetSidebarOpen, toggleSidebar: jest.fn() }),
}));

jest.mock('~/hooks/Nav/useUnifiedSidebarLinks', () => ({
  __esModule: true,
  default: () => [],
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useChatHelpers: () => ({}),
  useShowMarketplace: () => false,
}));

jest.mock('~/Providers', () => ({
  ChatContext: { Provider: ({ children }: { children: ReactNode }) => <>{children}</> },
  ChatFormProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  ActivePanelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('~/components/SidePanel/Nav', () => ({
  __esModule: true,
  default: () => <div data-testid="side-panel-nav" />,
}));

jest.mock('../mobile', () => ({
  MobileHeader: () => <div data-testid="mobile-header" />,
  MobileBottomBar: () => <div data-testid="mobile-bottom-bar">{mockMobileContent}</div>,
  MobileShortcutTargets: () => <div data-testid="mobile-shortcut-targets" />,
}));

beforeEach(() => {
  mockSetSidebarOpen.mockReset();
  mockMobileContent = null;
});

function InteractiveSidebar() {
  const [expanded, setExpanded] = useState(true);
  mockSetSidebarOpen.mockImplementation(setExpanded);
  return (
    <mockSidebarContext.Provider value={{ ...mockSidebarState, expanded }}>
      <MemoryRouter>
        <UnifiedSidebar switchToHistory={true} />
      </MemoryRouter>
    </mockSidebarContext.Provider>
  );
}

function AccountModal({ alert }: { alert: boolean }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const title = 'Account modal';
  const description = 'Return to the open drawer after dismissal.';
  const accountLabel = 'Account';
  const dismissLabel = 'Dismiss';
  const account = (
    <button ref={trigger} data-testid="nav-user" onClick={() => setOpen(true)}>
      {accountLabel}
    </button>
  );
  if (alert) {
    return (
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger asChild>{account}</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
          <AlertDialogCancel>{dismissLabel}</AlertDialogCancel>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <>
      {account}
      <OGDialog open={open} onOpenChange={setOpen} triggerRef={trigger}>
        <OGDialogContent>
          <OGDialogTitle>{title}</OGDialogTitle>
          <OGDialogDescription>{description}</OGDialogDescription>
        </OGDialogContent>
      </OGDialog>
    </>
  );
}

jest.mock('../Sidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="desktop-sidebar" />,
}));

const drawerVisibility = (expanded: boolean, isSliding: boolean): string => {
  mockSidebarState.expanded = expanded;
  const { unmount } = render(
    <MemoryRouter>
      <UnifiedSidebar isSliding={isSliding} switchToHistory={true} />
    </MemoryRouter>,
  );
  const drawer = document.getElementById(MOBILE_DRAWER_ID);
  if (drawer == null) {
    throw new Error('the mobile drawer did not render');
  }
  const { visibility } = drawer.style;
  unmount();
  return visibility;
};

describe('mobile drawer painting', () => {
  it('is not painted once closed and settled', () => {
    expect(drawerVisibility(false, false)).toBe(DRAWER_UNPAINTED);
  });

  /** Recoil's flip is deferred past the opening frames and the closing
   *  transition outlives it at the other end, so the committed state brackets
   *  the wrong window; `isSliding` is what covers the travel. */
  it('is painted while a slide is still travelling', () => {
    expect(drawerVisibility(false, true)).toBe('');
  });

  it('is painted while open', () => {
    expect(drawerVisibility(true, false)).toBe('');
  });
});

describe('mobile drawer Escape ownership', () => {
  it.each(['dialog', 'alertdialog'] as const)(
    'dismisses the native %s alone, restores account focus, and closes the drawer on the next Escape',
    async (role) => {
      const user = userEvent.setup();
      mockMobileContent = <AccountModal alert={role === 'alertdialog'} />;
      render(<InteractiveSidebar />);
      const drawer = document.getElementById(MOBILE_DRAWER_ID)!;
      const account = screen.getByTestId('nav-user');
      await user.click(account);
      const modal = await screen.findByRole(role, { name: 'Account modal' });
      expect(drawer).not.toHaveAttribute('inert');
      await waitFor(() => expect(modal.contains(document.activeElement)).toBe(true));
      await user.keyboard('{Escape}');
      await waitFor(() => expect(modal).not.toBeInTheDocument());
      await waitFor(() => expect(account).toHaveFocus());
      expect(drawer).not.toHaveAttribute('inert');
      expect(mockSetSidebarOpen).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(mockSetSidebarOpen).toHaveBeenCalledTimes(1);
      expect(mockSetSidebarOpen).toHaveBeenCalledWith(false, undefined);
      await waitFor(() => expect(drawer).toHaveAttribute('inert', ''));
      expect(drawer.style.visibility).toBe(DRAWER_UNPAINTED);
    },
  );

  it('leaves an already handled Escape with its control and still accepts the next unhandled Escape', async () => {
    const user = userEvent.setup();
    let preventDismissal = true;
    const label = 'Drawer control';
    mockMobileContent = (
      <button
        onKeyDown={(event) => {
          if (event.key === 'Escape' && preventDismissal) event.preventDefault();
        }}
      >
        {label}
      </button>
    );
    render(<InteractiveSidebar />);
    const drawer = document.getElementById(MOBILE_DRAWER_ID)!;
    await user.click(screen.getByRole('button', { name: label }));
    await user.keyboard('{Escape}');
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
    expect(drawer).not.toHaveAttribute('inert');
    preventDismissal = false;
    await user.keyboard('{Escape}');
    await waitFor(() => expect(drawer).toHaveAttribute('inert', ''));
  });
});
