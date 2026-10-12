import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

import MessageQuotes from '../MessageQuotes';

describe('MessageQuotes', () => {
  it('exposes exact quote indices and the server message version without changing text', () => {
    const { rerender } = render(
      <MessageQuotes quotes={['independent', 'derived']} messageVersion={7} />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveAttribute('data-quote-index', '0');
    expect(items[1]).toHaveAttribute('data-quote-index', '1');
    expect(items[1]).toHaveAttribute('data-quote-message-version', '7');
    rerender(<MessageQuotes quotes={['independent']} messageVersion={8} />);
    expect(screen.getByRole('listitem')).toHaveTextContent('independent');
    expect(screen.getByRole('listitem')).toHaveAttribute('data-quote-message-version', '8');
  });

  it('renders nothing when quotes is undefined', () => {
    const { container } = render(<MessageQuotes />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when quotes is empty', () => {
    const { container } = render(<MessageQuotes quotes={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders one reference block per quote, preserving text', () => {
    render(<MessageQuotes quotes={['first excerpt', 'second excerpt']} />);
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('first excerpt');
    expect(items[1]).toHaveTextContent('second excerpt');
  });

  it('localizes the list aria-label', () => {
    render(<MessageQuotes quotes={['excerpt']} />);
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', 'com_ui_referenced_quotes');
  });

  it('renders duplicate quote strings as separate blocks', () => {
    render(<MessageQuotes quotes={['same', 'same']} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});
