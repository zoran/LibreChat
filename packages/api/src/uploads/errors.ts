import { UPLOAD_ERROR_CODES } from 'librechat-data-provider';
import type { UploadErrorCode } from 'librechat-data-provider';

/** Finite safe errors; storage locators, identifiers and driver messages never reach the wire. */
export class UploadManagementError extends Error {
  readonly code: UploadErrorCode;
  constructor(code: UploadErrorCode) {
    super(code);
    this.name = 'UploadManagementError';
    this.code = code;
  }
}

export function isUploadManagementError(
  error: unknown,
): error is Error & { code: UploadErrorCode } {
  return (
    error instanceof Error &&
    error.name === 'UploadManagementError' &&
    'code' in error &&
    typeof error.code === 'string' &&
    UPLOAD_ERROR_CODES.some((code) => code === error.code)
  );
}
