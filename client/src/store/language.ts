import Cookies from 'js-cookie';
import { atom, selector } from 'recoil';
import { getFixedLocale } from '~/utils/presentation';
import { atomWithLocalStorage } from './utils';

const readStoredLang = () => {
  if (typeof localStorage === 'undefined') {
    return undefined;
  }

  const storedLang = localStorage.getItem('lang');
  if (!storedLang) {
    return undefined;
  }

  try {
    const parsedLang = JSON.parse(storedLang);
    return typeof parsedLang === 'string' ? parsedLang : storedLang;
  } catch {
    return storedLang;
  }
};

const defaultLang = () => {
  const userLang =
    (typeof navigator !== 'undefined' ? navigator.language || navigator.languages?.[0] : null) ??
    'en';
  return Cookies.get('lang') || readStoredLang() || userLang;
};

const preferredLang = atomWithLocalStorage('lang', defaultLang());
/** Preserve the preference while this document's fixed policy owns the effective language. */
const lang = selector<string>({
  key: 'effectiveLanguage',
  get: ({ get }) => {
    const preferred = get(preferredLang);
    return getFixedLocale() ?? preferred;
  },
  set: ({ set }, value) => {
    if (!getFixedLocale()) {
      set(preferredLang, value);
    }
  },
});
const languageLoading = atom<boolean>({
  key: 'languageLoading',
  default: false,
});

export default { lang, languageLoading };
