import React from 'react';
import { render, screen } from '@testing-library/react';
import type { SandpackProviderProps } from '@codesandbox/sandpack-react/unstyled';
import { ArtifactPreview } from '../ArtifactPreview';

const mockProvider = jest.fn();
const mockPreview = jest.fn();

// Observe the actual mounting boundary without starting the external sandbox runtime.
jest.mock('@codesandbox/sandpack-react/unstyled', () => {
  const React = jest.requireActual('react');
  return {
    SandpackProvider: (props: SandpackProviderProps) => {
      mockProvider(props);
      return <div data-testid="sandbox-provider">{props.children}</div>;
    },
    SandpackPreview: React.forwardRef((props: unknown, _ref: unknown) => {
      mockPreview(props);
      return <div data-testid="sandbox-preview" />;
    }),
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const de = jest.requireActual('~/locales/de/translation.json');
    return de[key];
  },
}));

const unavailable = 'Vorschau ist für diesen Dateityp nicht verfügbar';
const props: React.ComponentProps<typeof ArtifactPreview> = {
  files: { '/index.html': '<p>original</p>' },
  fileKey: '/index.html',
  template: 'static',
  sharedProps: {},
  previewRef: { current: null! },
};

describe('ArtifactPreview configured sandbox boundary', () => {
  beforeEach(() => {
    mockProvider.mockClear();
    mockPreview.mockClear();
  });

  it.each(['static', 'react-ts'] as const)(
    'does not mount either sandbox component without configuration for %s',
    (template) => {
      render(<ArtifactPreview {...props} template={template} />);
      expect(screen.getByText(unavailable)).toBeInTheDocument();
      expect(mockProvider).not.toHaveBeenCalled();
      expect(mockPreview).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['static', {}],
    ['static', { bundlerURL: 'https://preview.local/react' }],
    ['static', { staticBundlerURL: '' }],
    ['static', { staticBundlerURL: ' \t\n' }],
    ['react-ts', { staticBundlerURL: 'https://preview.local/static' }],
    ['react-ts', { bundlerURL: '' }],
    ['react-ts', { bundlerURL: ' \t\n' }],
  ] as const)(
    'closes %s when its selected URL is absent or blank (%j)',
    (template, startupConfig) => {
      render(<ArtifactPreview {...props} template={template} startupConfig={startupConfig} />);
      expect(screen.getByText(unavailable)).toBeInTheDocument();
      expect(mockProvider).not.toHaveBeenCalled();
      expect(mockPreview).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['static', 'https://preview.local/static'],
    ['react-ts', 'https://preview.local/react'],
  ] as const)(
    'keeps the configured %s sandbox and current editor content',
    (template, selected) => {
      render(
        <ArtifactPreview
          {...props}
          template={template}
          currentCode="<p>edited</p>"
          startupConfig={{
            staticBundlerURL: 'https://preview.local/static',
            bundlerURL: 'https://preview.local/react',
          }}
        />,
      );
      expect(screen.queryByText(unavailable)).not.toBeInTheDocument();
      expect(screen.getByTestId('sandbox-preview')).toBeInTheDocument();
      expect(mockProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          template,
          options: expect.objectContaining({ bundlerURL: selected }),
          files: expect.objectContaining({ '/index.html': { code: '<p>edited</p>' } }),
        }),
      );
    },
  );

  it('does not let shared provider props replace the selected startup options', () => {
    render(
      <ArtifactPreview
        {...props}
        sharedProps={{ options: {} }}
        startupConfig={{ staticBundlerURL: 'https://preview.local/static' }}
      />,
    );
    expect(mockProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ bundlerURL: 'https://preview.local/static' }),
      }),
    );
  });

  it('unmounts an existing sandbox when its configuration is withdrawn', () => {
    const { rerender } = render(
      <ArtifactPreview
        {...props}
        startupConfig={{ staticBundlerURL: 'https://preview.local/static' }}
      />,
    );
    expect(screen.getByTestId('sandbox-preview')).toBeInTheDocument();
    mockProvider.mockClear();
    mockPreview.mockClear();
    rerender(<ArtifactPreview {...props} startupConfig={{}} />);
    expect(screen.queryByTestId('sandbox-provider')).not.toBeInTheDocument();
    expect(screen.getByText(unavailable)).toBeInTheDocument();
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('does not reuse a static endpoint after switching to a React template', () => {
    const startupConfig = { staticBundlerURL: 'https://preview.local/static' };
    const { rerender } = render(<ArtifactPreview {...props} startupConfig={startupConfig} />);
    mockProvider.mockClear();
    mockPreview.mockClear();
    rerender(<ArtifactPreview {...props} template="react-ts" startupConfig={startupConfig} />);
    expect(screen.queryByTestId('sandbox-provider')).not.toBeInTheDocument();
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });

  it('preserves the empty-file result without mounting a sandbox', () => {
    const { container } = render(<ArtifactPreview {...props} files={{}} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockProvider).not.toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
  });
});
