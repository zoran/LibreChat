import { Constants, LocalStorageKeys } from 'librechat-data-provider';

export const DEFAULT_APP_TITLE = 'LibreChat';

/** Public presentation belongs to the document, before asynchronous startup queries. */
function configuredText(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function getAppTitle(fallback?: string | null): string {
  const configured =
    typeof window === 'undefined' ? undefined : window.__LIBRECHAT_CONFIG__?.appTitle;
  const title = configuredText(configured) ?? configuredText(fallback);
  if (title) {
    return title;
  }
  try {
    return configuredText(localStorage.getItem(LocalStorageKeys.APP_TITLE)) ?? DEFAULT_APP_TITLE;
  } catch {
    return DEFAULT_APP_TITLE;
  }
}

export function getAppVersion(fallback?: string | null): string {
  const configured =
    typeof window === 'undefined' ? undefined : window.__LIBRECHAT_CONFIG__?.appVersion;
  return configuredText(configured) ?? configuredText(fallback) ?? Constants.VERSION;
}

export function getFixedLocale(): string | undefined {
  return typeof window === 'undefined'
    ? undefined
    : configuredText(window.__LIBRECHAT_CONFIG__?.fixedLocale);
}
