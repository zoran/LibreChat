/** Private process observations; never document approval, cleanup proof or metric labels. */
export const UPLOAD_OCR_DISPATCH_STAGES = ['prepare', 'page', 'settle', 'close', 'cancel'] as const;
export const UPLOAD_OCR_DISPATCH_OUTCOMES = [
  'started',
  'http_1xx',
  'http_2xx',
  'http_3xx',
  'http_4xx',
  'http_5xx',
  'completed',
  'timeout',
  'aborted',
  'tls_error',
  'connection_error',
  'error',
] as const;
export type UploadOcrDispatchStage = (typeof UPLOAD_OCR_DISPATCH_STAGES)[number];
export type UploadOcrDispatchOutcome = (typeof UPLOAD_OCR_DISPATCH_OUTCOMES)[number];
export type UploadOcrDispatchCounts = Record<
  UploadOcrDispatchStage,
  Record<UploadOcrDispatchOutcome, number>
>;
export type UploadOcrDispatchObservation = {
  version: 1;
  source: { instanceId: string; pid: number; startedAt: number };
  observedAt: number;
  counts: UploadOcrDispatchCounts;
};

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !('value' in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}

export function createUploadOcrDispatchCounts(): UploadOcrDispatchCounts {
  return Object.fromEntries(
    UPLOAD_OCR_DISPATCH_STAGES.map((stage) => [
      stage,
      Object.fromEntries(UPLOAD_OCR_DISPATCH_OUTCOMES.map((outcome) => [outcome, 0])),
    ]),
  ) as UploadOcrDispatchCounts;
}

export function readUploadOcrDispatchCounts(value: unknown): UploadOcrDispatchCounts | null {
  try {
    const stages = closed(value, UPLOAD_OCR_DISPATCH_STAGES);
    if (!stages) return null;
    const result = createUploadOcrDispatchCounts();
    for (const stage of UPLOAD_OCR_DISPATCH_STAGES) {
      const outcomes = closed(stages[stage], UPLOAD_OCR_DISPATCH_OUTCOMES);
      if (!outcomes) return null;
      for (const outcome of UPLOAD_OCR_DISPATCH_OUTCOMES) {
        const count = outcomes[outcome];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
        result[stage][outcome] = count;
      }
      const row = result[stage];
      if (
        row.completed +
          row.timeout +
          row.aborted +
          row.tls_error +
          row.connection_error +
          row.error >
          row.started ||
        row.http_1xx + row.http_2xx + row.http_3xx + row.http_4xx + row.http_5xx > row.started
      )
        return null;
    }
    return result;
  } catch {
    return null;
  }
}

export function readUploadOcrDispatchObservation(
  value: unknown,
): UploadOcrDispatchObservation | null {
  try {
    const record = closed(value, ['version', 'source', 'observedAt', 'counts']);
    if (!record || record.version !== 1) return null;
    const source = closed(record.source, ['instanceId', 'pid', 'startedAt']);
    if (
      !source ||
      typeof source.instanceId !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(source.instanceId) ||
      typeof source.pid !== 'number' ||
      !Number.isSafeInteger(source.pid) ||
      source.pid < 1 ||
      typeof source.startedAt !== 'number' ||
      !Number.isFinite(source.startedAt) ||
      source.startedAt <= 0 ||
      typeof record.observedAt !== 'number' ||
      !Number.isFinite(record.observedAt) ||
      record.observedAt < source.startedAt
    )
      return null;
    const counts = readUploadOcrDispatchCounts(record.counts);
    if (!counts) return null;
    return {
      version: 1,
      source: { instanceId: source.instanceId, pid: source.pid, startedAt: source.startedAt },
      observedAt: record.observedAt,
      counts,
    };
  } catch {
    return null;
  }
}
