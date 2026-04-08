/**
 * CopyHunter - TUI App Entry
 */

import React from 'react';
import { render } from 'ink';
import { Dashboard } from './components/Dashboard.js';

export interface TuiOptions {
  refreshInterval?: number;
}

export function startTui(options: TuiOptions = {}): void {
  const { waitUntilExit } = render(
    <Dashboard refreshInterval={options.refreshInterval ?? 5000} />
  );

  waitUntilExit().then(() => {
    process.exit(0);
  });
}
