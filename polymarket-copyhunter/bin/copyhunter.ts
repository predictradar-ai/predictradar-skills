#!/usr/bin/env node
/**
 * CopyHunter CLI Entry Point
 */

import { fileURLToPath } from 'url';

process.env.COPYHUNTER_CLI_ENTRY ??= fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  const { program } = await import('../src/cli/index.js');
  await program.parseAsync(process.argv);
}

await main();
