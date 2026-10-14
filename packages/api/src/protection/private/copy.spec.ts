import { saveCopiedMessage, saveNativeCopyMessages, transferNativeCopyProvenance } from './copy';

describe('native source-copy provenance', () => {
  const source = {
    user: 'owner',
    messageId: 'source',
    __v: 7,
    text: 'answer',
    sourceFileIds: ['file'],
  };
  const builder = { saveMessage: <T extends object>(value: T) => value };
  it('passes only server-loaded native identities and preserves them through builder replacement', async () => {
    const clone = { ...source, messageId: 'new' };
    saveCopiedMessage(builder, source, clone, true);
    const replacement = transferNativeCopyProvenance(clone, { ...clone });
    const save = jest.fn().mockResolvedValue(undefined);
    await saveNativeCopyMessages(save, [replacement]);
    expect(save.mock.calls[0][2].nativeSources.get('new')).toEqual({
      messageId: 'source',
      messageVersion: 7,
    });
  });
  it('does not trust imported source fields or copied allocation receipts', async () => {
    const clone = {
      ...source,
      messageId: 'new',
      retainedTextAllocations: [{ fileId: 'file', bytes: 0 }],
    };
    saveCopiedMessage(builder, source, clone, false);
    const save = jest.fn().mockResolvedValue(undefined);
    await saveNativeCopyMessages(save, [clone]);
    expect(save).toHaveBeenCalledWith([clone], true);
  });
  it('rejects known document-dependent copies across owners while preserving ordinary shared copies', async () => {
    expect(() => saveCopiedMessage(builder, source, { ...source, user: 'other' }, true)).toThrow(
      'another owner',
    );
    const ordinary = { user: 'owner', messageId: 'source', text: 'ordinary chat' };
    const clone = { ...ordinary, user: 'other', messageId: 'new' };
    saveCopiedMessage(builder, ordinary, clone, true);
    const save = jest.fn().mockResolvedValue(undefined);
    await saveNativeCopyMessages(save, [clone]);
    expect(save).toHaveBeenCalledWith([clone], true);
  });
});
