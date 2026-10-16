/** Owns bootstrap cache classification for served paths, independent of compression. */
import path from 'node:path';

export function isStaticBootstrapFile(filePath?: string): boolean {
  // express-static-gzip passes the selected on-disk representation to setHeaders.
  const fileName = filePath ? path.basename(filePath).replace(/\.(?:gz|br)$/, '') : '';

  return (
    fileName === 'index.html' ||
    fileName.endsWith('.webmanifest') ||
    fileName === 'manifest.json' ||
    fileName === 'sw.js' ||
    fileName === 'sw-heal.js' ||
    fileName === 'registerSW.js'
  );
}
