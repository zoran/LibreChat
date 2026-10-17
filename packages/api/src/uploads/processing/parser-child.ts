import { once } from 'node:events';
import { extractManagedDocument, DocumentProcessingError } from '../../files/documents/managed';
import { existingAttemptOriginal } from './paths';
import { encodeDocumentResult } from './result';

/** Dedicated entry: no credentials, storage, HTTP, DB or lifecycle imports. */
async function main(): Promise<void> {
  // Parser library diagnostics cannot contaminate the bounded UTF-8 result stream.
  console.log = console.info = console.warn = console.error = () => undefined;
  const [stagingRoot, attemptId, mediaType] = process.argv.slice(2);
  const filePath = await existingAttemptOriginal(stagingRoot, attemptId);
  const result = await extractManagedDocument({ filePath, mediaType });
  if (!process.stdout.write(encodeDocumentResult(result))) {
    await once(process.stdout, 'drain');
  }
}

void main().then(
  () =>
    process.stdout.end(() => {
      process.exitCode = 0;
    }),
  (error: unknown) => {
    const code = error instanceof DocumentProcessingError ? error.code : 'invalid_document';
    // Finite code only; never return input, local paths, library stacks or document contents.
    process.stderr.write(code);
    process.exitCode = 1;
  },
);
