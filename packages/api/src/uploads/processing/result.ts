import { TextDecoder } from 'node:util';
import {
  MANAGED_DOCUMENT_WIRE_MAX_BYTES,
  MANAGED_STRUCTURE_MAX_BYTES,
  readManagedDocumentResult,
} from 'librechat-data-provider';
import type { ManagedDocumentResult } from 'librechat-data-provider';
import { DocumentProcessingError } from '../../files/documents/managed';

/** One bounded IPC frame. JSON metadata never duplicates or escapes the plain-text payload. */
export function encodeDocumentResult(input: ManagedDocumentResult): Buffer {
  const result = readManagedDocumentResult({ text: input.text, structure: input.structure });
  if (!result) throw new DocumentProcessingError('invalid_document');
  const metadata = Buffer.from(JSON.stringify(result.structure), 'utf8');
  const text = Buffer.from(result.text, 'utf8');
  const frame = Buffer.allocUnsafe(4 + metadata.length + text.length);
  frame.writeUInt32BE(metadata.length, 0);
  metadata.copy(frame, 4);
  text.copy(frame, 4 + metadata.length);
  return frame;
}

export function decodeDocumentResult(frame: Buffer): ManagedDocumentResult {
  if (frame.length < 6 || frame.length > MANAGED_DOCUMENT_WIRE_MAX_BYTES)
    throw new DocumentProcessingError('resource_limit');
  const length = frame.readUInt32BE(0);
  if (length < 2 || length > MANAGED_STRUCTURE_MAX_BYTES || length + 4 >= frame.length)
    throw new DocumentProcessingError('invalid_document');
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const structure: unknown = JSON.parse(decoder.decode(frame.subarray(4, 4 + length)));
    const text = decoder.decode(frame.subarray(4 + length));
    const result = readManagedDocumentResult({ text, structure });
    if (result) return result;
  } catch {
    // An invalid frame is data, never a parser diagnostic or a compatibility fallback.
  }
  throw new DocumentProcessingError('invalid_document');
}
