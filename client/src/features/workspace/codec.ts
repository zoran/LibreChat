/** Workspace byte ownership: keep approved originals exact and encode only edited LF model text. */
export type WorkspaceTextEol = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';
export type WorkspaceSaveEol = 'lf' | 'crlf';

export interface WorkspaceTextSnapshot {
  readonly text: string;
  readonly bom: boolean;
  readonly eol: WorkspaceTextEol;
  /** A fresh copy; callers cannot mutate the retained saved bytes. */
  readonly originalBytes: Uint8Array;
}

export type WorkspaceTextEncoding =
  | { status: 'unchanged'; bytes: Uint8Array }
  | { status: 'changed'; bytes: Uint8Array; eol: WorkspaceSaveEol }
  | { status: 'normalization-required'; eol: 'cr' | 'mixed' };

export class WorkspaceTextError extends Error {
  constructor(
    readonly code: 'invalid-utf8' | 'invalid-unicode' | 'invalid-model-text' | 'invalid-eol',
  ) {
    super(`Workspace text: ${code}`);
    this.name = 'WorkspaceTextError';
  }
}

/** Reject invalid UTF-16 before TextEncoder could silently replace it with U+FFFD. */
export function assertWorkspaceModelText(text: string): void {
  if (typeof text !== 'string' || text.includes('\r')) {
    throw new WorkspaceTextError('invalid-model-text');
  }
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new WorkspaceTextError('invalid-unicode');
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new WorkspaceTextError('invalid-unicode');
    }
  }
}

export function decodeWorkspaceText(bytes: Uint8Array): WorkspaceTextSnapshot {
  const original = new Uint8Array(bytes);
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original);
  } catch {
    throw new WorkspaceTextError('invalid-utf8');
  }
  const bom = decoded.startsWith('\uFEFF');
  const content = bom ? decoded.slice(1) : decoded;
  const endings = new Set(content.match(/\r\n|\r|\n/g) ?? []);
  let eol: WorkspaceTextEol = 'none';
  if (endings.size > 1) eol = 'mixed';
  else if (endings.has('\r\n')) eol = 'crlf';
  else if (endings.has('\r')) eol = 'cr';
  else if (endings.has('\n')) eol = 'lf';
  return Object.freeze({
    text: content.replace(/\r\n|\r/g, '\n'),
    bom,
    eol,
    get originalBytes() {
      return new Uint8Array(original);
    },
  });
}

/** A changed result is only an intake candidate, never an approval or a saved revision. */
export function encodeWorkspaceText(
  snapshot: WorkspaceTextSnapshot,
  text: string,
  explicitEol?: WorkspaceSaveEol,
): WorkspaceTextEncoding {
  assertWorkspaceModelText(text);
  if (explicitEol !== undefined && explicitEol !== 'lf' && explicitEol !== 'crlf') {
    throw new WorkspaceTextError('invalid-eol');
  }
  if (text === snapshot.text) {
    return { status: 'unchanged', bytes: snapshot.originalBytes };
  }
  if (!explicitEol && (snapshot.eol === 'mixed' || snapshot.eol === 'cr')) {
    return { status: 'normalization-required', eol: snapshot.eol };
  }
  const eol = explicitEol ?? (snapshot.eol === 'crlf' ? 'crlf' : 'lf');
  const content = eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
  return {
    status: 'changed',
    bytes: new TextEncoder().encode((snapshot.bom ? '\uFEFF' : '') + content),
    eol,
  };
}
