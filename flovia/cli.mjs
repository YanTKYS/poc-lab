import { mkdir, writeFile } from 'node:fs/promises';
import { FloviaClient } from '@flovialabs/sdk';
import { safeError } from './poc.mjs';

// No CLI key arguments, key-file fallback, raw error logs, or response dumps.
export async function runCli(run, mode) {
  try {
    let report;
    if (!process.env.FLOVIA_KEY?.trim()) {
      report = { mode, outcome: 'error', stop_reason: 'missing_key', error: safeError({ code: 'missing_key', executed: 'no' }) };
    } else {
      const client = new FloviaClient({
        apiKey: process.env.FLOVIA_KEY,
        retryRateLimited: false, timeoutMs: 30_000,
        onContractMismatch: () => {}, // report only validated diagnostics; no raw SDK warning
      });
      report = await run(client);
    }
    await mkdir(new URL('./results/', import.meta.url), { recursive: true, mode: 0o700 });
    await writeFile(new URL('./results/report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`Flovia PoC: ${report.outcome}; ${report.stop_reason}. See sanitized report.json.`);
    if (report.outcome === 'error') process.exitCode = 1;
  } catch {
    console.error('Flovia PoC could not initialize or save its sanitized report. No retry was attempted.');
    process.exitCode = 1;
  }
}
