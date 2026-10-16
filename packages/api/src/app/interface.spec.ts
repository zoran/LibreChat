// Exercise the current schema source while shared package builds remain independent.
jest.mock('librechat-data-provider', () => jest.requireActual('../../../data-provider/src/config'));

import { buildPreLoginInterface } from './interface';

describe('buildPreLoginInterface', () => {
  it('omits the interface when nothing public is configured', () => {
    expect(buildPreLoginInterface(undefined)).toBeUndefined();
    expect(buildPreLoginInterface({ modelSelect: true, buildInfo: true })).toBeUndefined();
  });

  it('keeps only the legal links and a disabled build-info flag', () => {
    expect(
      buildPreLoginInterface({
        privacyPolicy: { externalUrl: 'https://example.com/privacy' },
        termsOfService: { externalUrl: 'https://example.com/tos' },
        buildInfo: false,
        modelSelect: true,
        parameters: false,
      }),
    ).toEqual({
      privacyPolicy: { externalUrl: 'https://example.com/privacy' },
      termsOfService: { externalUrl: 'https://example.com/tos' },
      buildInfo: false,
    });
  });

  it('carries a bundled theme name', () => {
    expect(buildPreLoginInterface({ theme: 'clickhouse', modelSelect: true })).toEqual({
      theme: 'clickhouse',
    });
  });

  it('carries an inline theme definition unchanged', () => {
    const theme = {
      version: 1 as const,
      name: 'acme',
      modes: { light: { colors: { 'rgb-surface-primary': '255 255 255' } } },
    };
    expect(buildPreLoginInterface({ theme })).toEqual({ theme });
  });
});

it('projects only a validated public application logo before login', () => {
  const appLogo = {
    light: '/assets/logo.svg',
    dark: '/assets/logo-dark.svg',
    mark: '/assets/mark.svg',
    markDark: '/assets/mark-dark.svg',
  };
  expect(buildPreLoginInterface({ appLogo, modelSelect: true })).toEqual({ appLogo });
  for (const invalid of [
    { light: 'https://outside.example/logo.svg' },
    { light: '//outside.example/logo.svg' },
    { light: 'assets/%2e%2e/private.svg' },
    { light: '/assets/logo.svg', privateIdentity: 'not-public' },
  ]) {
    expect(buildPreLoginInterface({ appLogo: invalid })).toBeUndefined();
  }
});
