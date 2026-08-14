#!/usr/bin/env node

import { main } from './PeerCli.mjs';

main().catch((error) => {
  console.error(
    '[orgx-deepseek-harness] startup failed:',
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
