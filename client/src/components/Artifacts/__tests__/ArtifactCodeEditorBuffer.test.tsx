import React, { useEffect } from 'react';
import { ThemeContext } from '@librechat/client';
import { QueryKeys } from 'librechat-data-provider';
import { render, act, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { editor } from 'monaco-editor';
import type { Artifact } from '~/common';
import { EditorProvider, useCodeState } from '~/Providers/EditorContext';
import { ArtifactCodeEditor } from '../ArtifactCodeEditor';
import en from '~/locales/en/translation.json';

interface MonacoEditorProps {
  onChange?: (value: string | undefined) => void;
}

const editorProps: MonacoEditorProps = {};
const mockGetMessages = jest.fn();
const savedMessage = (content: string, version: number) => ({
  messageId: 'msg-a',
  conversationId: 'conversation',
  __v: version,
  text: `:::artifact{identifier="example" type="text/plain" title="Example"}\n${content}\n:::`,
});

/** One save at a time, settled by the test the way the server would. */
let inFlight: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null = null;
const mockEditArtifact = jest.fn(
  (vars: unknown) =>
    new Promise((resolve, reject) => {
      inFlight = {
        resolve: (value: unknown) =>
          resolve({
            ...(vars as object),
            content: '',
            text: '',
            conversationId: null,
            __v: 2,
            ...(value as object),
          }),
        reject,
      };
    }),
);

jest.mock('../monaco', () => ({
  __esModule: true,
  DiffEditor: () => null,
  default: (props: MonacoEditorProps) => {
    Object.assign(editorProps, props);
    return null;
  },
}));

jest.mock('~/Providers', () => ({
  useArtifactsContext: () => ({ isSubmitting: false, conversationId: 'conversation' }),
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    editArtifact: (vars: unknown) => mockEditArtifact(vars),
    getMessagesByConvoId: (...args: unknown[]) => mockGetMessages(...args),
  },
}));

const artifactA: Artifact = {
  id: 'artifact-a',
  lastUpdateTime: 0,
  index: 0,
  messageId: 'msg-a',
  content: 'CONTENT-A',
  type: 'text/plain',
};

const artifactB: Artifact = {
  id: 'artifact-b',
  lastUpdateTime: 0,
  index: 1,
  messageId: 'msg-b',
  content: 'CONTENT-B',
  type: 'text/plain',
};

/**
 * Monaco reports a programmatic `setValue` through `onChange` exactly like a
 * keystroke, which is the behaviour these cases turn on.
 */
const createModel = (initial: string) => {
  let value = initial;
  const model = {
    getValue: () => value,
    setValue: (next: string) => {
      value = next;
      editorProps.onChange?.(next);
    },
    getLineCount: () => 1,
    getValueLength: () => value.length,
    getPositionAt: () => ({ lineNumber: 1, column: value.length + 1 }),
    applyEdits: jest.fn(),
  };
  const ed = {
    getModel: () => model,
    revealLine: jest.fn(),
    focus: jest.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
  return { ed, read: () => value };
};

type Session = {
  endCodeSession: () => void;
  buffer: { code?: string; artifactId?: string };
};

const session: Session = { endCodeSession: () => {}, buffer: {} };

/** Publishes the shared editing state the pane's hosts drive. */
function SessionProbe() {
  const { currentCode, codeArtifactId, endCodeSession } = useCodeState();
  useEffect(() => {
    session.endCodeSession = endCodeSession;
    session.buffer = { code: currentCode, artifactId: codeArtifactId };
  });
  return null;
}

/**
 * The provider sits above the pane's hosts, so closing the pane unmounts the
 * editor while the session state and any running save stay where they are.
 */
const renderEditor = (initial: Artifact, monacoRef: React.MutableRefObject<any>) => {
  let current = initial;
  let paneOpen = true;
  let readOnly = false;
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  client.setQueryData(
    [QueryKeys.messages, 'conversation'],
    [
      savedMessage('CONTENT-A', 1),
      {
        ...savedMessage('CONTENT-B', 1),
        messageId: 'msg-b',
        text: savedMessage('IGNORED', 1).text + '\n' + savedMessage('CONTENT-B', 1).text,
      },
    ],
  );
  const tree = () => (
    <QueryClientProvider client={client}>
      <ThemeContext.Provider
        value={
          { resolvedMode: 'dark', highContrast: false } as React.ContextType<typeof ThemeContext>
        }
      >
        <EditorProvider>
          <SessionProbe />
          {paneOpen ? (
            <ArtifactCodeEditor artifact={current} monacoRef={monacoRef} readOnly={readOnly} />
          ) : null}
        </EditorProvider>
      </ThemeContext.Provider>
    </QueryClientProvider>
  );
  const utils = render(tree());
  const rerender = () =>
    act(() => {
      utils.rerender(tree());
    });
  return {
    ...utils,
    client,
    select: (next: Artifact) => {
      current = next;
      rerender();
    },
    closePane: () => {
      paneOpen = false;
      rerender();
    },
    reopenPane: () => {
      paneOpen = true;
      rerender();
    },
    setReadOnly: (next: boolean) => {
      readOnly = next;
      rerender();
    },
  };
};

const type = (value: string) => {
  act(() => {
    editorProps.onChange?.(value);
  });
};

const settleDebounce = () => {
  act(() => {
    jest.advanceTimersByTime(500);
  });
};

/** Let the mutation's own promise chain and React Query's notify batch run. */
const flush = async () => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    jest.advanceTimersByTime(1);
    await Promise.resolve();
  });
};

describe('ArtifactCodeEditor unsaved text across a selection change', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEditArtifact.mockClear();
    mockGetMessages.mockReset();
    inFlight = null;
    editorProps.onChange = undefined;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it.each([true, false])(
    'reconciles only an explicitly viewed revision (apply draft: %s)',
    async (applyDraft) => {
      const { ed, read } = createModel('CONTENT-A');
      const view = renderEditor(artifactA, { current: ed });
      type('LOCAL');
      settleDebounce();
      await flush();
      await act(async () =>
        inFlight?.reject({
          isAxiosError: true,
          response: { status: 409, data: { code: 'MESSAGE_VERSION_CONFLICT' } },
        }),
      );
      await flush();
      mockGetMessages.mockResolvedValue([savedMessage('REMOTE', 7)]);
      fireEvent.click(screen.getByRole('button', { name: en.com_ui_artifact_conflict_compare }));
      await flush();
      type('LATEST');
      settleDebounce();
      expect(mockEditArtifact).toHaveBeenCalledTimes(1);
      fireEvent.click(
        screen.getByRole('button', {
          name: applyDraft ? en.com_ui_artifact_conflict_apply : en.com_ui_artifact_conflict_adopt,
        }),
      );
      await flush();
      if (applyDraft) {
        expect(mockEditArtifact).toHaveBeenCalledTimes(2);
        expect(mockEditArtifact).toHaveBeenLastCalledWith(
          expect.objectContaining({ original: 'REMOTE\n', updated: 'LATEST', expectedVersion: 7 }),
        );
      } else {
        expect(mockEditArtifact).toHaveBeenCalledTimes(1);
        expect(read()).toBe('REMOTE\n');
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        view.closePane();
        view.reopenPane();
        await flush();
        settleDebounce();
        expect(mockEditArtifact).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('fences a late conflict to the artifact that was saved while another artifact is selected', async () => {
    const { ed } = createModel('CONTENT-A');
    const view = renderEditor(artifactA, { current: ed });
    type('DRAFT-A');
    settleDebounce();
    await flush();
    view.select(artifactB);
    type('DRAFT-B');
    settleDebounce();
    await act(async () =>
      inFlight?.reject({
        isAxiosError: true,
        response: { status: 409, data: { code: 'MESSAGE_VERSION_CONFLICT' } },
      }),
    );
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-b', updated: 'DRAFT-B' }),
    );
    view.select(artifactA);
    expect(screen.getByRole('alert')).toHaveTextContent('Automatic saving is paused');
    type('NEW-A');
    settleDebounce();
    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
  });

  it('uses a freshly authorized revision after a clean saved artifact is revisited', async () => {
    const { ed } = createModel('CONTENT-A');
    const view = renderEditor(artifactA, { current: ed });
    type('LOCAL-SAVED');
    settleDebounce();
    await flush();
    await act(async () => inFlight?.resolve({ __v: 2 }));
    await flush();
    view.client.setQueryData(
      [QueryKeys.messages, 'conversation'],
      [savedMessage('OTHER-SESSION', 3)],
    );
    view.select(artifactB);
    view.select({ ...artifactA, content: 'OTHER-SESSION' });
    type('AFTER-FRESH-READ');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        original: 'OTHER-SESSION',
        updated: 'AFTER-FRESH-READ',
        expectedVersion: 3,
      }),
    );
  });

  it('normalizes only the native terminal LF when deciding whether a clean revision was viewed', async () => {
    const { ed } = createModel('CONTENT-A');
    const view = renderEditor(artifactA, { current: ed });
    type('LOCAL-SAVED');
    settleDebounce();
    await flush();
    await act(async () => inFlight?.resolve({ __v: 2 }));
    await flush();
    view.select({ ...artifactA, content: 'LOCAL-SAVED' });
    view.client.setQueryData(
      [QueryKeys.messages, 'conversation'],
      [savedMessage('LOCAL-SAVED ', 3)],
    );
    type('NEXT-DRAFT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        original: 'LOCAL-SAVED',
        updated: 'NEXT-DRAFT',
        expectedVersion: 2,
      }),
    );
  });

  it('pins the first edit to its authorized revision across a stale append and host remount', async () => {
    const { ed } = createModel('CONTENT-A');
    const view = renderEditor(artifactA, { current: ed });
    type('LOCAL-DRAFT');
    view.closePane();
    view.client.setQueryData(
      [QueryKeys.messages, 'conversation'],
      [savedMessage('CONTENT-A appended elsewhere', 2)],
    );
    view.reopenPane();
    await flush();
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(mockEditArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        original: 'CONTENT-A',
        updated: 'LOCAL-DRAFT',
        expectedVersion: 1,
      }),
    );
    await act(async () =>
      inFlight?.reject({
        isAxiosError: true,
        response: { status: 409, data: { code: 'MESSAGE_VERSION_CONFLICT' } },
      }),
    );
    await flush();
    type('LATEST-DRAFT');
    settleDebounce();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  it('blocks a conflict through further typing, a host remount and a session close', async () => {
    const { ed } = createModel('CONTENT-A');
    const view = renderEditor(artifactA, { current: ed });
    type('FIRST-DRAFT');
    settleDebounce();
    await flush();
    type('LATEST-DRAFT');
    settleDebounce();
    await act(async () => {
      inFlight?.reject({
        isAxiosError: true,
        response: { status: 409, data: { code: 'MESSAGE_VERSION_CONFLICT' } },
      });
    });
    await flush();
    type('AFTER-CONFLICT');
    settleDebounce();
    view.closePane();
    view.reopenPane();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(session.buffer.code).toBe('AFTER-CONFLICT');
    act(() => session.endCodeSession());
    view.closePane();
    view.reopenPane();
    await flush();
    settleDebounce();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(editorProps).toMatchObject({ defaultValue: 'AFTER-CONFLICT' });
  });

  it('binds a later save to the actual acknowledged message version', async () => {
    const { ed } = createModel('CONTENT-A');
    renderEditor(artifactA, { current: ed });
    type('FIRST-DRAFT');
    settleDebounce();
    await flush();
    await act(async () => inFlight?.resolve({ __v: 7 }));
    await flush();
    type('SECOND-DRAFT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        original: 'FIRST-DRAFT',
        updated: 'SECOND-DRAFT',
        expectedVersion: 7,
      }),
    );
  });

  it('keeps the unsaved text of the artifact the user left', () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);

    expect(session.buffer).toEqual({ code: 'EDITED-A', artifactId: 'artifact-a' });
    expect(mockEditArtifact).not.toHaveBeenCalled();
  });

  /* Editing the artifact the user moved to must not evict the text the one
   * they left was holding: its debounce died with the selection change, so the
   * retained copy is the only place it still lives. Reported by Codex on
   * 591ab13c96 (P1). */
  it('restores the text of the left artifact after another is edited', async () => {
    const { ed, read } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);
    type('EDITED-B');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactA);
    await flush();

    /* The restored edit queues behind the running save of the other artifact,
     * and that save's callbacks send it once it lands. */
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(read()).toBe('EDITED-A');
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ messageId: 'msg-a', original: 'CONTENT-A', updated: 'EDITED-A' }),
    );
  });

  it('restores that text and saves it when the artifact is selected again', async () => {
    const { ed, read } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDITED-A');
    view.select(artifactB);
    expect(read()).toBe('CONTENT-B');

    view.select(artifactA);
    await flush();

    expect(read()).toBe('EDITED-A');
    expect(mockEditArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-a', original: 'CONTENT-A', updated: 'EDITED-A' }),
    );
  });

  /* The save that held the lock has already replaced the content the queued
   * edit was typed against, so sending that stale `original` would have the
   * endpoint reject the newest text. */
  it('sends a queued edit against the content the finished save left', async () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    renderEditor(artifactA, monacoRef);

    type('FIRST-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* Typed while the first save is still running: queued, not sent. */
    type('SECOND-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The save lands. The registry still holds the pre-save content — it
     * catches up only when the edited message propagates — so the queued edit
     * has to be rebased on what the request wrote, not on what is on screen. */
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'msg-a',
        original: 'FIRST-EDIT',
        updated: 'SECOND-EDIT',
      }),
    );
  });

  /* The save is the request's, not the session's: a pane closed mid-save must
   * neither release it nor let the next session write over it. */
  it('waits for a save the closed session started before sending the next edit', async () => {
    const { ed } = createModel('CONTENT-A');
    const monacoRef = { current: ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-BEFORE-CLOSE');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The pane is closed and reopened while that save is still running. */
    act(() => {
      session.endCodeSession();
    });
    view.closePane();
    view.reopenPane();
    type('EDIT-AFTER-REOPEN');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'msg-a',
        original: 'EDIT-BEFORE-CLOSE',
        updated: 'EDIT-AFTER-REOPEN',
      }),
    );
  });

  it('does not resubmit rejected text when the editor remounts in the same session', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  it('saves a new edit after a rejected buffer is remounted', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-EDIT');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.closePane();
    view.reopenPane();
    type('NEW-EDIT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ updated: 'NEW-EDIT' }),
    );
  });

  /* A save answers after the user has moved on, so the refusal has to be
   * recorded against the artifact whose text was refused. Filed under the
   * artifact on screen instead, it would let the one that was rejected send
   * the same text again the moment the user came back to it. */
  it('records a refusal against the artifact whose save was refused', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-A');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactB);
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  /* A save for the artifact the user left can land while they are reading
   * another one, and the registry catches up only when the edited message
   * propagates. The edit restored on the way back replaces what that save
   * wrote, not what the registry still says, or the endpoint refuses it and
   * the text the user typed never lands. */
  it('rebases a restored edit on what the last save actually wrote', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('SAVED-A');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* A second edit whose debounce the selection change cancels. */
    type('RETAINED-A');
    view.select(artifactB);
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'SAVED-A', updated: 'RETAINED-A' }),
    );
  });

  /* The registry can also move past this session's save from the outside:
   * another tab or session edits the artifact and the messages query
   * refetches what they wrote. The local save is then the older truth, and
   * preferring it would have the endpoint refuse every further edit. */
  it('rebases on content that moved past the local save', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('LOCAL-SAVE');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The messages query brings what another session wrote. */
    view.select({ ...artifactA, content: 'FOREIGN-CONTENT' });
    await flush();

    type('AFTER-REFRESH');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'FOREIGN-CONTENT', updated: 'AFTER-REFRESH' }),
    );
  });

  /* Two artifacts can both have a refusal on file: one marker must not be
   * overwritten by the other's, or the older refusal is forgotten and its
   * text goes back on the wire when the user returns to it. */
  it('keeps a refusal for each artifact that was refused', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('REJECTED-A');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select(artifactB);
    type('REJECTED-B');
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(2);

    /* B's refusal must not make A's text eligible again. */
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
  });

  /* Clearing the editor is mid-edit, not a deletion: typing never saves an
   * empty buffer, so no path that resubmits retained text may either — a host
   * change would otherwise persist the removal of the whole artifact. */
  it('does not persist a cleared editor when the pane changes hosts', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.select(artifactB);
    view.select(artifactA);
    await flush();

    expect(mockEditArtifact).not.toHaveBeenCalled();
  });

  /* The pane changes hosts while a save is running and the user keeps typing:
   * the text they typed in the new instance is the newest thing in play, so
   * the buffer it inherited at mount must not be sent after it and put the
   * artifact back the way it was. */
  it('does not undo a newer edit with the buffer it inherited at mount', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-OLD');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    /* The host change happens while that save is still open. */
    view.closePane();
    view.reopenPane();
    await flush();

    type('EDIT-NEW');
    settleDebounce();
    await flush();

    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(2);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ updated: 'EDIT-NEW' }),
    );
  });

  /* A response starts while an edit is still waiting on its debounce, and the
   * pane changes hosts before it saves: the edit is inherited by an editor
   * that cannot save yet. It has to survive until editing returns, then be
   * saved and stay on screen rather than give way to the persisted content. */
  it('saves an inherited edit once a generation ends', async () => {
    const model = createModel('CONTENT-A');
    const monacoRef = { current: model.ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    type('EDIT-A');
    view.setReadOnly(true);
    view.closePane();
    view.reopenPane();
    settleDebounce();
    await flush();
    expect(mockEditArtifact).not.toHaveBeenCalled();

    view.setReadOnly(false);
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'EDIT-A' }),
    );
    expect(model.read()).toBe('EDIT-A');
  });

  const saveAndSettle = async (text: string) => {
    type(text);
    settleDebounce();
    await flush();
    await act(async () => {
      inFlight?.resolve(undefined);
      await Promise.resolve();
    });
    await flush();
  };

  /* Text this tab saved is not unsaved. When another session moves the
   * artifact on, a host change must not send the saved text back over it. */
  it('does not resend saved text over a newer change made elsewhere', async () => {
    const model = createModel('CONTENT-A');
    const monacoRef = { current: model.ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED-HERE');
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    view.select({ ...artifactA, content: 'SAVED-HERE' });
    view.select({ ...artifactA, content: 'CHANGED-ELSEWHERE' });
    await flush();

    view.closePane();
    view.reopenPane();
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
    expect(model.read()).toBe('CHANGED-ELSEWHERE');
  });

  /* Once the registry has shown this tab's save, a later change back to an
   * earlier value is made elsewhere, not lag, and the next edit replaces it. */
  it('rebases on an earlier value restored elsewhere after the save landed', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED-HERE');
    view.select({ ...artifactA, content: 'SAVED-HERE' });
    await flush();
    view.select({ ...artifactA, content: 'CONTENT-A' });
    await flush();

    type('AFTER-REVERT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'AFTER-REVERT' }),
    );
  });

  /* The user edits away and back to the text of a save that is still open.
   * When that save is refused, the queued copy of the same text is the refused
   * text and must not go out again. */
  it('does not retry a queued edit the running save was refused for', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    renderEditor(artifactA, monacoRef);

    type('REFUSED');
    settleDebounce();
    await flush();
    expect(mockEditArtifact).toHaveBeenCalledTimes(1);

    type('DETOUR');
    settleDebounce();
    type('REFUSED');
    settleDebounce();
    await flush();

    await act(async () => {
      inFlight?.reject({ status: 400 });
      await Promise.resolve();
    });
    await flush();

    expect(mockEditArtifact).toHaveBeenCalledTimes(1);
  });

  /* Two saves land before the registry shows either. Once it shows the first
   * one, the value before it is history: the registry going back there later
   * is a change made elsewhere, not lag. */
  it('retires lag values the registry has already passed', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('ONE');
    await saveAndSettle('TWO');
    view.select({ ...artifactA, content: 'ONE' });
    await flush();
    view.select({ ...artifactA, content: 'CONTENT-A' });
    await flush();

    type('NEXT');
    settleDebounce();
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CONTENT-A', updated: 'NEXT' }),
    );
  });

  /* Only the copy a save wrote is known to be saved. A user who edits away
   * and back to that same text has made an edit, and it is sent. */
  it('sends an edit that returns to previously saved text', async () => {
    const monacoRef = { current: createModel('CONTENT-A').ed } as React.MutableRefObject<any>;
    const view = renderEditor(artifactA, monacoRef);

    await saveAndSettle('SAVED');
    view.select({ ...artifactA, content: 'SAVED' });
    await flush();

    type('DETOUR');
    type('SAVED');
    view.select(artifactB);
    view.select({ ...artifactA, content: 'CHANGED-ELSEWHERE' });
    await flush();

    expect(mockEditArtifact).toHaveBeenLastCalledWith(
      expect.objectContaining({ original: 'CHANGED-ELSEWHERE', updated: 'SAVED' }),
    );
  });
});
