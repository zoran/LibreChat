import { logger } from '@librechat/data-schemas';

/** Token count function that can be sync or async */
export type TokenCountFn = (text: string) => number | Promise<number>;

export function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Safety buffer multiplier applied to character position estimates during truncation.
 *
 * We use 98% (0.98) rather than 100% to intentionally undershoot the target on the first attempt.
 * This is necessary because:
 * - Token density varies across text (some regions may have more tokens per character than the average)
 * - The ratio-based estimate assumes uniform token distribution, which is rarely true
 * - Undershooting is safer than overshooting: exceeding the limit requires another iteration,
 *   while being slightly under is acceptable
 * - In practice, this buffer reduces refinement iterations from 2-3 down to 0-1 in most cases
 *
 * @example
 * // If text has 1000 chars and 250 tokens (4 chars/token average), targeting 100 tokens:
 * // Without buffer: estimate = 1000 * (100/250) = 400 chars → might yield 105 tokens (over!)
 * // With 0.98 buffer: estimate = 400 * 0.98 = 392 chars → likely yields 97-99 tokens (safe)
 */
const TRUNCATION_SAFETY_BUFFER = 0.98;

/**
 * Processes text content by counting tokens and truncating if it exceeds the specified limit.
 * Uses ratio-based estimation to minimize expensive tokenCountFn calls.
 *
 * @param text - The text content to process
 * @param tokenLimit - The maximum number of tokens allowed
 * @param tokenCountFn - Function to count tokens (can be sync or async)
 * @returns Promise resolving to object with processed text, token count, and truncation status
 *
 * @remarks
 * Ratios estimate positions only: every returned result has a validated measured count.
 * Refinement is bounded; a measured empty fallback is used if it cannot converge.
 * Invalid limits/counts or an empty result still over the limit throw instead of succeeding.
 */
export async function processTextWithTokenLimit({
  text,
  tokenLimit,
  tokenCountFn,
  preserve = 'start',
}: {
  text: string;
  tokenLimit: number;
  tokenCountFn: TokenCountFn;
  preserve?: 'start' | 'end';
}): Promise<{ text: string; tokenCount: number; wasTruncated: boolean }> {
  if (!Number.isSafeInteger(tokenLimit) || tokenLimit < 0) {
    throw new RangeError('tokenLimit must be a non-negative safe integer');
  }
  const measure = async (value: string): Promise<number> => {
    const count = await tokenCountFn(value);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError('Token counter must return a non-negative safe integer');
    }
    return count;
  };
  const originalTokenCount = await measure(text);

  if (originalTokenCount <= tokenLimit) {
    return {
      text,
      tokenCount: originalTokenCount,
      wasTruncated: false,
    };
  }

  logger.debug(
    `[textTokenLimiter] Text content exceeds token limit: ${originalTokenCount} > ${tokenLimit}, truncating...`,
  );

  const ratio = tokenLimit / originalTokenCount;
  let charPosition = Math.floor(text.length * ratio * TRUNCATION_SAFETY_BUFFER);

  const sliceText = (position: number) => {
    if (position <= 0) {
      return '';
    }
    let boundary = preserve === 'end' ? text.length - position : position;
    const before = text.charCodeAt(boundary - 1);
    const after = text.charCodeAt(boundary);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
      // Shrink inward rather than separating a UTF-16 surrogate pair at either edge.
      boundary += preserve === 'end' ? 1 : -1;
    }
    return preserve === 'end' ? text.slice(boundary) : text.slice(0, boundary);
  };

  let truncatedText = sliceText(charPosition);
  let tokenCount = await measure(truncatedText);

  const maxIterations = 5;
  let iterations = 0;

  while (tokenCount > tokenLimit && iterations < maxIterations && charPosition > 0) {
    const overageRatio = tokenLimit / tokenCount;
    charPosition = Math.floor(charPosition * overageRatio * TRUNCATION_SAFETY_BUFFER);
    truncatedText = sliceText(charPosition);
    tokenCount = await measure(truncatedText);
    iterations++;
  }

  if (tokenCount > tokenLimit && truncatedText !== '') {
    truncatedText = '';
    tokenCount = await measure(truncatedText);
  }
  if (tokenCount > tokenLimit) {
    throw new RangeError('Token count exceeds the limit even for empty text');
  }

  logger.warn(
    `[textTokenLimiter] Text truncated from ${originalTokenCount} to ${tokenCount} tokens (limit: ${tokenLimit})`,
  );

  return {
    text: truncatedText,
    tokenCount,
    wasTruncated: true,
  };
}

/**
 * Truncates to `maxChars` keeping head and tail around an explicit marker, so
 * the consumer (usually a model) can tell the content was cut and by how much.
 */
export function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const indicator = `\n\n... [truncated: ${value.length} chars exceeded ${maxChars} limit] ...\n\n`;
  const available = maxChars - indicator.length;
  if (available <= 0) {
    return value.slice(0, maxChars);
  }

  const headSize = Math.ceil(available * 0.7);
  const tailSize = available - headSize;
  return value.slice(0, headSize) + indicator + value.slice(value.length - tailSize);
}
