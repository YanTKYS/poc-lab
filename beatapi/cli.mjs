import { mkdir, writeFile } from 'node:fs/promises';
import { runPoc } from './poc.mjs';

async function saveReport(report) {
  const directory = new URL('./results/', import.meta.url);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('report.json', directory), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

export async function runCli({ args = process.argv.slice(2), env = process.env,
  run = runPoc, save = saveReport, log = console.log } = {}) {
  try {
    // No arbitrary text, file, endpoint, key or batch-model CLI inputs.
    const model = args.length === 2 && args[0] === '--model' ? args[1] : null;
    const report = await run({ model, apiKey: env.BEAT_API_KEY });
    await save(report);
    log('BeatAPI PoC: sanitized report saved to beatapi/results/report.json.');
    return report.outcome === 'passed' ? 0 : 1;
  } catch {
    // Never print a raw exception, even for local filesystem failures.
    log('BeatAPI PoC: failed; raw error details are withheld.');
    return 1;
  }
}
