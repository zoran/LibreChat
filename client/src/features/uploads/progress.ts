export type TransferProgress = {
  loaded: number;
  total: number;
  percent: number;
  bytesPerSecond: number | null;
  remainingSeconds: number | null;
};

export function createTransferProgress(total: number) {
  let loaded = 0;
  let started: number | undefined;
  let previous = 0;
  let lastMovement = 0;
  let samples = 0;
  let rate: number | null = null;
  return (value: number, now: number): TransferProgress => {
    if (started === undefined) {
      started = now;
      previous = now;
      lastMovement = now;
    }
    const next = Math.min(total, Math.max(loaded, Number.isFinite(value) ? value : loaded));
    const elapsed = now - previous;
    if (next > loaded && elapsed > 0) {
      const measured = ((next - loaded) * 1_000) / elapsed;
      rate = rate === null ? measured : 0.25 * measured + 0.75 * rate;
      lastMovement = now;
      previous = now;
      samples++;
    }
    loaded = next;
    const reliable = samples >= 3 && now - started >= 1_500 && now - lastMovement < 3_000;
    return {
      loaded,
      total,
      percent: total > 0 ? Math.floor((loaded / total) * 100) : 0,
      bytesPerSecond: reliable ? rate : null,
      remainingSeconds:
        reliable && rate && loaded < total ? Math.ceil((total - loaded) / rate) : null,
    };
  };
}

export function uploadPhase(
  state: string | undefined,
  progress: TransferProgress | undefined,
): string {
  if (state === 'transferring') {
    if (progress && progress.loaded >= progress.total) return 'storing';
    return progress && progress.loaded > 0 ? 'transferring' : 'waiting';
  }
  return state ?? 'selected';
}
