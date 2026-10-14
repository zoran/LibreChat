/** Owns deployment presentation shared by startup JSON, the HTML shell and the PWA manifest. */
import { Constants, presentationSchema } from 'librechat-data-provider';
import type { TInterfaceConfig, TStartupConfig } from 'librechat-data-provider';
import type { RequestHandler } from 'express';
import { escapeHtmlAttribute } from '~/security/html';
import { injectBootstrapConfig } from './bootstrap';

type PresentationSource = {
  appTitle?: string | null;
  interfaceConfig?: Partial<TInterfaceConfig> | null;
};
type PublicPresentation = Pick<TStartupConfig, 'appTitle' | 'fixedLocale'> & { appVersion: string };

/** Resolve only public display values from the caller's already loaded configuration. */
export function resolvePresentation(source: PresentationSource): PublicPresentation {
  const config = presentationSchema.parse(source.interfaceConfig ?? {});
  return {
    appTitle: source.appTitle || 'LibreChat',
    appVersion: config.appVersion ?? Constants.VERSION,
    ...(config.fixedLocale ? { fixedLocale: config.fixedLocale } : {}),
  };
}

/**
 * Construct once from the existing built artifacts. Requests only choose the legacy language
 * when no fixed locale exists; no request performs filesystem or configuration/database reads.
 */
export function createPresentation(
  source: PresentationSource & { html: string; manifestRaw: string },
): {
  render: (language?: string) => string;
  manifestHandler: RequestHandler;
} {
  const presentation = resolvePresentation(source);
  if (Buffer.byteLength(source.manifestRaw, 'utf8') > 65536) {
    throw new Error('Built PWA manifest exceeds the presentation limit');
  }
  const manifest: unknown = JSON.parse(source.manifestRaw);
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Expected a built PWA manifest object');
  }
  const runtimeManifest: Record<string, unknown> = { ...manifest };
  let html = source.html;
  if (source.appTitle) {
    const title = escapeHtmlAttribute(presentation.appTitle);
    html = html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`);
    html = html.replace(
      /<meta\b[^>]*\bname=(["'])description\1[^>]*>/i,
      () => `<meta name="description" content="${title}" />`,
    );
    runtimeManifest.name = presentation.appTitle;
    runtimeManifest.short_name = presentation.appTitle;
    if ('description' in runtimeManifest) runtimeManifest.description = presentation.appTitle;
  }
  if (presentation.fixedLocale) runtimeManifest.lang = presentation.fixedLocale;
  if (source.interfaceConfig?.pwaIcons) runtimeManifest.icons = source.interfaceConfig.pwaIcons;
  const manifestBody = JSON.stringify(runtimeManifest);
  html = injectBootstrapConfig(html, {
    sentinel: 'data-librechat-presentation="true"',
    values: {
      appTitle: presentation.appTitle,
      appVersion: presentation.appVersion,
      ...(presentation.fixedLocale ? { fixedLocale: presentation.fixedLocale } : {}),
    },
  });
  return {
    render: (language) => {
      const locale = escapeHtmlAttribute(presentation.fixedLocale || language || 'en-US');
      return html.replace(
        /<html\b([^>]*)>/i,
        (_tag, attributes: string) =>
          `<html${attributes.replace(/\s+lang=(["'])[^"']*\1/i, '')} lang="${locale}">`,
      );
    },
    manifestHandler: (_req, res) => {
      res.set('Cache-Control', 'no-store');
      res.type('application/manifest+json').send(manifestBody);
    },
  };
}
