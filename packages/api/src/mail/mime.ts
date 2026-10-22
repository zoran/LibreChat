/** Shared local MIME and logo adapter; purpose policy and SMTP bounds remain with submission. */
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { Readable, Transform, Writable } from 'node:stream';
import type { MailDependencies, MailMessage } from './submission';

type MimeStream = Readable | Writable;
type CompiledMime = {
  transform(stream: Transform): void;
  processFunc(handler: <T extends MimeStream>(stream: T) => T): void;
  createReadStream(): Readable;
};

/** The existing composition supplies its installed MIME encoder and transport factory. */
export type OutboundMailAdapterDependencies = {
  getDist(): string;
  compileMime(message: MailMessage & { newline: 'windows' }): CompiledMime;
  createTransport: MailDependencies['createTransport'];
};

/** Login and retention keep the same logo reader and shared bounded-submission dependencies. */
export function createOutboundMailAdapter(dependencies: OutboundMailAdapterDependencies): {
  readLogo(name?: string | null): Buffer | undefined;
  createOutboundMailDependencies(): MailDependencies;
} {
  /** Only a bounded static PNG basename under the existing deployment assets mount. */
  function readLogo(name?: string | null): Buffer | undefined {
    if (name == null || name === '') return undefined;
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(name)) throw new Error('Invalid email logo asset');
    const fd = fs.openSync(
      path.join(dependencies.getDist(), 'assets', name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 33 || stat.size > 65536)
        throw new Error('Invalid email logo asset');
      const content = Buffer.alloc(stat.size);
      if (fs.readSync(fd, content, 0, content.length, 0) !== content.length)
        throw new Error('Invalid email logo asset');
      return content;
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Track public pipe relationships before encoding starts so abort also stops upstream encoders. */
  function createMimeStream(message: MailMessage): Readable {
    const owned = new Set<MimeStream>();
    let cancelled = false;
    const own = <T extends MimeStream>(stream: T): T => {
      if (owned.has(stream)) return stream;
      owned.add(stream);
      stream.on('pipe', own);
      if (cancelled) stream.destroy();
      return stream;
    };
    const compiled = dependencies.compileMime({ ...message, newline: 'windows' });
    compiled.transform(own(new PassThrough()));
    compiled.processFunc(own);
    const output = own(compiled.createReadStream());
    output.once('close', () => {
      cancelled = true;
      for (const stream of owned) stream.destroy();
    });
    return output;
  }

  function createOutboundMailDependencies(): MailDependencies {
    return {
      createMimeStream,
      createTransport: (options) => dependencies.createTransport(options),
    };
  }
  return { readLogo, createOutboundMailDependencies };
}
