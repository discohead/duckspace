// @vitest-environment jsdom

import { WelcomeView } from '@renderer/components/WelcomeView';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('WelcomeView', () => {
  it('renders "Datspace" heading', () => {
    render(<WelcomeView />);
    expect(screen.getByText('Datspace')).toBeDefined();
  });

  it('renders subtitle "Embedded Analytics Workbench"', () => {
    render(<WelcomeView />);
    expect(screen.getByText('Embedded Analytics Workbench')).toBeDefined();
  });

  it('renders the "Get Started" section header', () => {
    render(<WelcomeView />);
    expect(screen.getByText('Get Started')).toBeDefined();
  });

  it('renders all 3 step items', () => {
    render(<WelcomeView />);
    expect(screen.getByText('Open a new query tab to write and execute SQL')).toBeDefined();
    expect(
      screen.getByText('Browse your data catalog to explore tables and schemas'),
    ).toBeDefined();
    expect(
      screen.getByText('Use keyboard shortcuts: Cmd+T (new tab), Cmd+W (close tab)'),
    ).toBeDefined();
  });

  it('displays step numbers 1, 2, and 3', () => {
    render(<WelcomeView />);
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });
});
