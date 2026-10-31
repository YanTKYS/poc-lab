import { runCli } from './cli.mjs';
import { runStatusOnly } from './poc.mjs';

await runCli(runStatusOnly, 'status-only');
