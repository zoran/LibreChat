import { createTransferProgress, uploadPhase } from './progress';

describe('measured upload progress', () => {
  it('reports real bytes and withholds an ETA until enough time and samples exist', () => {
    const sample = createTransferProgress(10_000);
    expect(sample(0, 0).remainingSeconds).toBeNull();
    expect(sample(1_000, 500)).toMatchObject({
      loaded: 1_000,
      percent: 10,
      remainingSeconds: null,
    });
    expect(sample(2_000, 1_000).remainingSeconds).toBeNull();
    expect(sample(4_000, 2_000)).toMatchObject({ bytesPerSecond: 2_000, remainingSeconds: 3 });
  });
  it('does not equate fully sent bytes with a usable document', () => {
    const progress = createTransferProgress(10)(10, 0);
    expect(uploadPhase('transferring', progress)).toBe('storing');
    expect(uploadPhase('queued_processing', progress)).toBe('queued_processing');
    expect(uploadPhase('processing', progress)).toBe('processing');
    expect(uploadPhase('ready', progress)).toBe('ready');
  });
  it('drops the estimate during a stall and refuses backwards byte counters', () => {
    const sample = createTransferProgress(10_000);
    sample(0, 0);
    sample(1_000, 500);
    sample(2_000, 1_000);
    sample(4_000, 2_000);
    expect(sample(4_000, 7_000).remainingSeconds).toBeNull();
    expect(sample(3_000, 8_000).loaded).toBe(4_000);
    expect(sample(50_000, 9_000)).toMatchObject({
      loaded: 10_000,
      percent: 100,
      remainingSeconds: null,
    });
  });
});
