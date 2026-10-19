/** Small SVG role symbols stay independent of severity colors and require no raster assets. */
export default function StatusResourceIcon({ kind }: { kind: string }) {
  if (kind === 'cpu-server')
    return (
      <g data-role-icon="cpu" aria-hidden="true" transform="translate(13 13)">
        <rect x="3" y="3" width="12" height="12" rx="2" />
        <path d="M6 0v3m6-3v3M6 15v3m6-3v3M0 6h3m-3 6h3m12-6h3m-3 6h3M7 7h4v4H7z" />
      </g>
    );
  if (kind === 'gpu-server')
    return (
      <g data-role-icon="gpu" aria-hidden="true" transform="translate(12 13)">
        <path d="M1 2h17v12H1zM4 14v3m4-3v3m4-3v3M18 5h2m-2 5h2" />
        <circle cx="10" cy="8" r="4" />
        <path d="M10 4v8M6 8h8" />
      </g>
    );
  if (kind.startsWith('kubernetes-'))
    return (
      <g data-role-icon="kubernetes" aria-hidden="true" transform="translate(13 12)">
        <path d="M9 1l8 4v9l-8 4-8-4V5zM9 5v9M5 7l8 5m-8 0l8-5" />
      </g>
    );
  return null;
}

/** One non-color symbol for each existing availability state; legend and graph share the artwork. */
export const STATUS_STATE_SYMBOLS: Record<string, string> = {
  healthy: 'M1.5 5.2 4 7.7 8.5 2.3',
  degraded: 'M5 1 9 9H1ZM5 3.4v2.4m0 1.7v.2',
  unknown: 'M3 3.1a2 2 0 1 1 3.2 1.6C5 5.1 5 5.4 5 6.2M5 8v.2',
  stale: 'M9 5a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM5 2.4V5l2 1.3',
  disabled: 'M1.5 5h7',
  unavailable: 'M2 2l6 6M8 2 2 8',
  disagreement: 'M1 3h7M6 1l2 2-2 2M9 7H2m2-2L2 7l2 2',
};
export function StatusStateIcon({ state }: { state: string }) {
  return (
    <g data-screen-state={state} aria-hidden="true">
      <rect width="10" height="10" rx="2" />
      <path d={STATUS_STATE_SYMBOLS[state] ?? STATUS_STATE_SYMBOLS.unknown} />
    </g>
  );
}
