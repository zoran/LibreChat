/** Synthetic source/result fixture; no security approval or production parser replacement. */
import { createHash } from 'node:crypto';
import type { ManagedDocumentResult } from 'librechat-data-provider';

export function documentResultFixture(text = 'useful content'): ManagedDocumentResult {
  return {
    text,
    structure: {
      version: 1,
      source: {
        sha256: createHash('sha256').update('hello').digest('hex'),
        bytes: 5,
        mediaType: 'text/plain',
      },
      extractor: { name: 'synthetic-test', version: '1' },
      pages: [],
      elements: [
        { id: 'e1', kind: 'paragraph', start: 0, end: text.length, page: null, parentId: null },
      ],
      quality: { status: 'complete', warnings: [] },
    },
  };
}
