/** Regression: native Editor and DiffEditor must share local Monaco, without CDN bootstrap.
 * Run the installed React loader; only the browser ESM/Worker boundaries are controlled here.
 * Vite asset URLs and real worker execution are qualified separately in the browser.
 */
type ReactMonaco = typeof import('@monaco-editor/react');
type Bootstrap = typeof import('../monaco');
type WorkerFamily = 'editor' | 'json' | 'css' | 'html' | 'typescript';
type WorkerEnvironment = {
  getWorker(moduleId: string, label: string): Worker;
  getWorkerUrl?(moduleId: string, label: string): string;
};

const workerModules: Record<WorkerFamily, string> = {
  editor: 'monaco-editor/editor/editor.worker?worker',
  json: 'monaco-editor/languages/features/json/json.worker?worker',
  css: 'monaco-editor/languages/features/css/css.worker?worker',
  html: 'monaco-editor/languages/features/html/html.worker?worker',
  typescript: 'monaco-editor/languages/features/typescript/ts.worker?worker',
};
const originalEnvironment = Object.getOwnPropertyDescriptor(self, 'MonacoEnvironment');
const originalLocation = window.location.href;
const environment = () => {
  const value = Reflect.get(self, 'MonacoEnvironment') as WorkerEnvironment | undefined;
  if (typeof value?.getWorker !== 'function') throw new Error('Local worker factory missing');
  return value;
};

function loadBootstrap() {
  const localModule = Object.freeze({ __esModule: true, editor: Object.freeze({}), languages: {} });
  const constructors = Object.fromEntries(
    Object.keys(workerModules).map((family) => [
      family,
      jest.fn<Worker, []>(() => ({ family }) as unknown as Worker),
    ]),
  ) as Record<WorkerFamily, jest.Mock<Worker, []>>;
  jest.doMock('monaco-editor', () => localModule);
  for (const family of Object.keys(workerModules) as WorkerFamily[]) {
    jest.doMock(
      workerModules[family],
      () => ({ __esModule: true, default: constructors[family] }),
      { virtual: true },
    );
  }
  let native!: ReactMonaco;
  let bootstrap!: Bootstrap;
  let duplicate!: Bootstrap;
  let workerBeforeConfig: WorkerEnvironment | undefined;
  let configure!: jest.SpyInstance;
  jest.isolateModules(() => {
    native = jest.requireActual<ReactMonaco>('@monaco-editor/react');
    const actualConfig = native.loader.config;
    configure = jest.spyOn(native.loader, 'config').mockImplementation((config) => {
      workerBeforeConfig = environment();
      return actualConfig(config);
    });
    bootstrap = jest.requireActual<Bootstrap>('../monaco');
    duplicate = jest.requireActual<Bootstrap>('../monaco');
  });
  return { native, bootstrap, duplicate, localModule, constructors, configure, workerBeforeConfig };
}

beforeEach(() => {
  jest.spyOn(document.body, 'appendChild').mockImplementation(() => {
    throw new Error('Loader script injection is forbidden in this local-only fixture');
  });
});
afterEach(() => {
  if (originalEnvironment) Object.defineProperty(self, 'MonacoEnvironment', originalEnvironment);
  else Reflect.deleteProperty(self, 'MonacoEnvironment');
  window.history.replaceState(null, '', originalLocation);
  jest.restoreAllMocks();
});

it.each(['/', '/nested/cortex/'])(
  'configures the actual shared loader before either native component mounts at %s',
  async (basePath) => {
    window.history.replaceState(null, '', basePath);
    const baseURI = document.baseURI;
    const fixture = loadBootstrap();
    expect(fixture.configure).toHaveBeenCalledTimes(1);
    expect(fixture.configure).toHaveBeenCalledWith({ monaco: fixture.localModule });
    expect(fixture.workerBeforeConfig?.getWorker).toBe(environment().getWorker);
    expect(fixture.bootstrap.default).toBe(fixture.native.default);
    expect(fixture.bootstrap.DiffEditor).toBe(fixture.native.DiffEditor);
    expect(fixture.duplicate).toBe(fixture.bootstrap);
    expect(Object.keys(fixture.bootstrap).sort()).toEqual(['DiffEditor', 'default']);
    for (const constructor of Object.values(fixture.constructors)) {
      expect(constructor).not.toHaveBeenCalled();
    }
    // This is the real loader's promise, not a mocked successful init().
    await expect(fixture.native.loader.init()).resolves.toBe(fixture.localModule);
    await expect(fixture.native.loader.init()).resolves.toBe(fixture.localModule);
    expect(document.body.appendChild).not.toHaveBeenCalled();
    expect(document.baseURI).toBe(baseURI);
  },
);

it.each<[string, WorkerFamily]>([
  ['json', 'json'],
  ['css', 'css'],
  ['scss', 'css'],
  ['less', 'css'],
  ['html', 'html'],
  ['handlebars', 'html'],
  ['razor', 'html'],
  ['typescript', 'typescript'],
  ['javascript', 'typescript'],
  ['editorWorkerService', 'editor'],
  ['unknown-language', 'editor'],
])('creates a dedicated local %s worker with the native %s constructor', (label, family) => {
  const fixture = loadBootstrap();
  const first = environment().getWorker('untrusted-module-id', label);
  const second = environment().getWorker('https://external.invalid/ignored.js', label);
  expect(fixture.constructors[family]).toHaveBeenCalledTimes(2);
  expect(first).toBe(fixture.constructors[family].mock.results[0].value);
  expect(second).toBe(fixture.constructors[family].mock.results[1].value);
  expect(second).not.toBe(first);
  expect(fixture.constructors[family]).toHaveBeenNthCalledWith(1);
  expect(fixture.constructors[family]).toHaveBeenNthCalledWith(2);
  for (const other of Object.keys(workerModules) as WorkerFamily[]) {
    if (other !== family) expect(fixture.constructors[other]).not.toHaveBeenCalled();
  }
  expect(document.body.appendChild).not.toHaveBeenCalled();
});

it('does not recover a failed local worker through a previous external worker URL or another worker', () => {
  const oldExternalFactory = jest.fn(() => 'https://external.invalid/worker.js');
  Reflect.set(self, 'MonacoEnvironment', { getWorkerUrl: oldExternalFactory });
  const fixture = loadBootstrap();
  const failure = new Error('Controlled local worker construction failure');
  fixture.constructors.json.mockImplementationOnce(() => {
    throw failure;
  });
  expect(() => environment().getWorker('external-module', 'json')).toThrow(failure);
  expect(oldExternalFactory).not.toHaveBeenCalled();
  expect(fixture.constructors.editor).not.toHaveBeenCalled();
  expect(document.body.appendChild).not.toHaveBeenCalled();
});
