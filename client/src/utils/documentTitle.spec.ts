import { setDocumentTitle } from './documentTitle';

describe('configured document presentation', () => {
  afterEach(() => {
    delete window.__LIBRECHAT_CONFIG__;
    localStorage.clear();
  });

  it('uses the document configuration instead of a previous deployment title', () => {
    Object.assign(window, {
      __LIBRECHAT_CONFIG__: { appTitle: 'Example Workspace', appVersion: 'v0.8.8+example.1' },
    });
    localStorage.setItem('appTitle', 'Previous deployment');
    setDocumentTitle(undefined, false);
    expect(document.title).toBe('Example Workspace');
  });

  it('preserves user conversation titles containing the upstream name', () => {
    Object.assign(window, { __LIBRECHAT_CONFIG__: { appTitle: 'Example Workspace' } });
    setDocumentTitle('My LibreChat comparison', true);
    expect(document.title).toBe('My LibreChat comparison');
  });

  it('retains the upstream default without deployment configuration', () => {
    setDocumentTitle(undefined, false);
    expect(document.title).toBe('LibreChat');
  });
});
