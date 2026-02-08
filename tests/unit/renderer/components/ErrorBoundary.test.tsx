// @vitest-environment jsdom

import { ErrorBoundary } from '@renderer/components/ErrorBoundary';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('ErrorBoundary', () => {
  it('renders children normally when no error', () => {
    render(
      <ErrorBoundary>
        <div>Hello World</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Hello World')).toBeDefined();
  });

  it('renders fallback UI when child throws during render', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function ThrowingChild(): never {
      throw new Error('render crash');
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText(/something went wrong/i)).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('displays the error message in fallback', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function ThrowingChild(): never {
      throw new Error('test error message');
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(screen.getByText('test error message')).toBeDefined();
    consoleSpy.mockRestore();
  });

  it('logs error details via componentDidCatch', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function ThrowingChild(): never {
      throw new Error('test error');
    }

    render(
      <ErrorBoundary>
        <ThrowingChild />
      </ErrorBoundary>,
    );

    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});
