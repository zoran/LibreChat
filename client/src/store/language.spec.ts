import { snapshot_UNSTABLE } from 'recoil';
import language from './language';

describe('deployment language policy', () => {
  afterEach(() => {
    delete window.__LIBRECHAT_CONFIG__;
    localStorage.removeItem('lang');
    document.cookie = 'lang=; Max-Age=0; path=/';
  });

  it.each(['en', '"en"'])(
    'overrides stored English (%s) and refuses a later language change',
    (saved) => {
      Object.assign(window, { __LIBRECHAT_CONFIG__: { fixedLocale: 'de-DE' } });
      document.cookie = 'lang=en; path=/';
      localStorage.setItem('lang', saved);
      const snapshot = snapshot_UNSTABLE();
      expect(snapshot.getLoadable(language.lang).getValue()).toBe('de-DE');
      const changed = snapshot.map(({ set }) => set(language.lang, 'fr-FR'));
      expect(changed.getLoadable(language.lang).getValue()).toBe('de-DE');
    },
  );

  it('preserves manual language changes without a fixed deployment policy', () => {
    const snapshot = snapshot_UNSTABLE(({ set }) => set(language.lang, 'fr-FR'));
    expect(snapshot.getLoadable(language.lang).getValue()).toBe('fr-FR');
  });
});
