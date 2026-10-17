import * as artifacts from './artifact-source';

type Snapshot = {
  content: string;
  header: string;
  source: 'content' | 'text';
  partIndex?: number;
};
const source = (message: Parameters<typeof artifacts.findAllArtifacts>[0], index: number) => {
  const reader = (
    artifacts as typeof artifacts & {
      readArtifactSource?: (
        message: Parameters<typeof artifacts.findAllArtifacts>[0],
        index: number,
      ) => Snapshot | null;
    }
  ).readArtifactSource;
  expect(reader).toEqual(expect.any(Function));
  return reader!(message, index);
};
const block = (name: string, content: string) =>
  `:::artifact{identifier="${name}" type="text/plain" title="${name}"}\n${content}\n:::`;

describe('shared native artifact source', () => {
  it('returns exact unfenced content and opening identity without outside message text', () => {
    const text = `Before\n${block('first', '  text\n  indented')}\nAfter`;
    expect(source({ text }, 0)).toEqual({
      content: '  text\n  indented\n',
      header: ':::artifact{identifier="first" type="text/plain" title="first"}',
      source: 'text',
    });
  });

  it('uses the same code fence bounds for reading and replacement', () => {
    const text = block('code', '```text\nline one\nline two\n```');
    const read = source({ text }, 0)!;
    expect(read.content).toBe('line one\nline two');
    const replaced = artifacts.replaceArtifactContent(
      text,
      artifacts.findAllArtifacts({ text })[0],
      read.content,
      'changed',
    );
    expect(source({ text: replaced! }, 0)?.content).toBe('changed');
  });

  it('retains native content-part ordering and does not also select fallback text', () => {
    const message = {
      text: block('fallback', 'ignored'),
      content: [
        { type: 'think', text: block('thought', 'ignored') },
        { type: 'text', text: `${block('one', 'first')}\n${block('two', 'second')}` },
        { type: 'text', text: block('three', 'third') },
      ],
    };
    expect(source(message, 1)).toMatchObject({
      content: 'second\n',
      source: 'content',
      partIndex: 1,
    });
    expect(source(message, 2)).toMatchObject({
      content: 'third\n',
      source: 'content',
      partIndex: 2,
    });
    expect(source(message, 3)).toBeNull();
  });

  it('ignores native non-string text parts without coercing them into source content', () => {
    expect(
      source(
        {
          content: [
            { type: 'text', text: { value: block('structured', 'not a string') } },
            { type: 'text', text: block('plain', 'visible source') },
          ],
        },
        0,
      ),
    ).toMatchObject({ content: 'visible source\n', source: 'content', partIndex: 1 });
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe selection %s',
    (index) => {
      expect(source({ text: block('one', 'first') }, index)).toBeNull();
    },
  );

  it('does not invent a source from an absent or header-only artifact', () => {
    expect(source({ text: 'ordinary message' }, 0)).toBeNull();
    expect(source({ text: ':::artifact{title="unfinished"}' }, 0)).toBeNull();
  });
});
