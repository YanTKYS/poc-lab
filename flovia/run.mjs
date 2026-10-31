import { runCli } from './cli.mjs';
import { runPoc } from './poc.mjs';

await runCli(runPoc, 'check');
