import { request } from 'node:http';
import { TextDecoder } from 'node:util';
import type { UploadParserExecution } from 'librechat-data-provider';
import type { DocumentFailureCode } from '../../files/documents/managed';
import type { DocumentPort } from '../contract';
import { DocumentProcessingError, MANAGED_DOCUMENT_LIMITS } from '../../files/documents/managed';
import { attemptOriginalPath } from './paths';

export class IsolatedDocumentError extends DocumentProcessingError {
  constructor(
    code: DocumentFailureCode,
    readonly writerStopped: boolean,
  ) {
    super(code);
  }
}
const codes: DocumentFailureCode[] = [
  'unsupported_format',
  'resource_limit',
  'invalid_document',
  'no_text',
  'cancelled',
  'processing_timeout',
  'parser_unavailable',
];

/** Losing a Unix connection never proves the matching parser process stopped. */
export function createUnixDocumentPort(options: {
  socketPath: string;
  stagingRoot: string;
}): DocumentPort {
  function validateExecution(execution: UploadParserExecution) {
    attemptOriginalPath(options.stagingRoot, execution.attemptId);
    if (
      !/^[a-f0-9-]{36}$/.test(execution.instanceId) ||
      !Number.isFinite(Date.parse(execution.expiresAt))
    ) {
      throw new IsolatedDocumentError('invalid_document', false);
    }
  }
  function rpc(
    route: string,
    input: unknown,
    signal: AbortSignal,
    binary = false,
  ): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new IsolatedDocumentError('cancelled', false));
    return new Promise((resolve, reject) => {
      const body = JSON.stringify(input);
      let settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };
      const req = request(
        {
          socketPath: options.socketPath,
          method: 'POST',
          path: route,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          const cap = binary && res.statusCode === 200 ? MANAGED_DOCUMENT_LIMITS.outputBytes : 1024;
          res.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > cap) {
              finish(new IsolatedDocumentError('resource_limit', false));
              req.destroy();
            } else chunks.push(chunk);
          });
          res.once('error', () => finish(new IsolatedDocumentError('parser_unavailable', false)));
          res.once('end', () => {
            if (settled) return;
            try {
              const text = new TextDecoder('utf-8', { fatal: true }).decode(
                Buffer.concat(chunks, bytes),
              );
              if (binary && res.statusCode === 200) {
                if (res.headers['x-parser-joined'] !== '1' || !text.trim())
                  throw new Error('Invalid parser reply');
                finish(undefined, { text, writerStopped: true });
                return;
              }
              const value = JSON.parse(text) as Record<string, unknown>;
              if (res.statusCode === 200) finish(undefined, value);
              else
                finish(
                  new IsolatedDocumentError(
                    codes.includes(value.code as DocumentFailureCode)
                      ? (value.code as DocumentFailureCode)
                      : 'parser_unavailable',
                    value.joined === true,
                  ),
                );
            } catch {
              finish(new IsolatedDocumentError('parser_unavailable', false));
            }
          });
        },
      );
      const abort = () => {
        finish(new IsolatedDocumentError('cancelled', false));
        req.destroy();
      };
      const timer = setTimeout(
        () => {
          finish(
            new IsolatedDocumentError(binary ? 'processing_timeout' : 'parser_unavailable', false),
          );
          req.destroy();
        },
        binary ? MANAGED_DOCUMENT_LIMITS.wallMs + 5_000 : 5_000,
      );
      timer.unref();
      signal.addEventListener('abort', abort, { once: true });
      req.once('error', () => finish(new IsolatedDocumentError('parser_unavailable', false)));
      if (signal.aborted) abort();
      else req.end(body);
    });
  }
  return {
    async prepare({ attemptId, mediaType, signal }) {
      attemptOriginalPath(options.stagingRoot, attemptId);
      const execution = (await rpc(
        '/prepare',
        { attemptId, mediaType },
        signal,
      )) as UploadParserExecution;
      validateExecution(execution);
      if (
        execution.attemptId !== attemptId ||
        Date.parse(execution.expiresAt) <= Date.now() ||
        Date.parse(execution.expiresAt) > Date.now() + MANAGED_DOCUMENT_LIMITS.wallMs
      ) {
        throw new IsolatedDocumentError('invalid_document', false);
      }
      return execution;
    },
    async extract({ execution, signal }) {
      validateExecution(execution);
      return (await rpc('/extract', execution, signal, true)) as {
        text: string;
        writerStopped: true;
      };
    },
    async cancel({ execution, signal }) {
      validateExecution(execution);
      try {
        const reply = (await rpc('/cancel', execution, signal)) as { writerStopped: boolean };
        return { writerStopped: reply.writerStopped === true };
      } catch {
        return { writerStopped: false };
      }
    },
  };
}
