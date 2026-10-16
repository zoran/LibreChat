import React from 'react';
import { render, screen } from '@testing-library/react';
import { ThemeContext } from '@librechat/client';
import AppLogo from './AppLogo';

const appLogo = {
  light: '/assets/light.svg',
  dark: '/assets/dark.svg',
  mark: '/assets/mark.svg',
  markDark: '/assets/mark-dark.svg',
};
const config = { appTitle: 'BWI Cortex', interface: { appLogo } } as NonNullable<
  React.ComponentProps<typeof AppLogo>['startupConfig']
>;
const withTheme = (resolvedMode: 'light' | 'dark', child: React.ReactNode) => (
  <ThemeContext.Provider
    value={{ theme: 'system', resolvedMode } as React.ContextType<typeof ThemeContext>}
  >
    {child}
  </ThemeContext.Provider>
);

afterEach(() => {
  delete window.__LIBRECHAT_CONFIG__;
  localStorage.clear();
});

it('follows the actual application resolved theme and updates both variants', () => {
  const view = render(withTheme('light', <AppLogo startupConfig={config} />));
  expect(screen.getByRole('img', { name: 'BWI Cortex' })).toHaveAttribute('src', appLogo.light);
  view.rerender(withTheme('dark', <AppLogo startupConfig={config} />));
  expect(screen.getByRole('img')).toHaveAttribute('src', appLogo.dark);
  view.rerender(withTheme('dark', <AppLogo startupConfig={config} variant="mark" />));
  expect(screen.getByRole('img')).toHaveAttribute('src', appLogo.markDark);
  view.rerender(withTheme('light', <AppLogo startupConfig={config} variant="mark" />));
  expect(screen.getByRole('img')).toHaveAttribute('src', appLogo.mark);
});

it('uses available same-variant assets, then wordmark, when optional assets are absent', () => {
  const partial = {
    ...config,
    interface: { appLogo: { light: appLogo.light, mark: appLogo.mark } },
  };
  const view = render(withTheme('dark', <AppLogo startupConfig={partial} variant="mark" />));
  expect(screen.getByRole('img')).toHaveAttribute('src', appLogo.mark);
  view.rerender(
    withTheme(
      'dark',
      <AppLogo
        startupConfig={{ ...config, interface: { appLogo: { light: appLogo.light } } }}
        variant="mark"
      />,
    ),
  );
  expect(screen.getByRole('img')).toHaveAttribute('src', appLogo.light);
});

it('preserves the auth loading/default asset and omits unconfigured optional consumers', () => {
  const view = render(
    <AppLogo fallbackSrc="assets/logo.svg" className="h-full w-full object-contain" />,
  );
  expect(screen.getByRole('img', { name: 'LibreChat' })).toHaveAttribute('src', 'assets/logo.svg');
  expect(screen.getByRole('img')).toHaveClass('h-full', 'w-full');
  view.rerender(<AppLogo />);
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
});
