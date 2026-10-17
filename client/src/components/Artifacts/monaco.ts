import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import MonacoEditor, { DiffEditor, loader } from '@monaco-editor/react';
import CssWorker from 'monaco-editor/languages/features/css/css.worker?worker';
import JsonWorker from 'monaco-editor/languages/features/json/json.worker?worker';
import HtmlWorker from 'monaco-editor/languages/features/html/html.worker?worker';
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';

// Vite emits the installed editor and workers as local assets. Configure both
// React editor variants before their loader can select its default CDN.
self.MonacoEnvironment = {
  getWorker(_moduleId, label) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TypeScriptWorker();
      default:
        return new EditorWorker();
    }
  },
};

loader.config({ monaco });

export { DiffEditor };
export default MonacoEditor;
