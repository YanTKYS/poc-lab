import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, symlink, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { EXPECTED_CONTRACT_VERSION } from '@flovialabs/sdk';
import { runStatusOnly } from '../poc.mjs';

const ready = () => ({
  ok: true, contract_version: EXPECTED_CONTRACT_VERSION, stage: 'alpha',
  five_hour: { used_pct: 0 }, week: { used_pct: 0 }, services_off: [],
  data_consent: { answer: 'y', needed: false }, purchased_balance_display: '$8734.56',
});
for (const [name, change, outcome, reason] of [
  ['matching', {}, 'checked_status_only', null],
  ['different', { contract_version: '2026-10-31.152' }, 'stopped', 'contract_mismatch'],
  ['pending', { free_pending: { next_step: 'private' } }, 'stopped', 'free_pending'],
]) {
  test(`status-only ${name}: exactly one status and no list or data call`, async () => {
    let calls = 0;
    const report = await runStatusOnly({
      async status() { calls++; return { ...ready(), ...change }; },
      async listTools() { assert.fail('status-only must never list tools'); },
      async call() { assert.fail('status-only must never call data or consent tools'); },
    }, { statusOnly: false }); // wrapper must not permit disabling status-only
    assert.equal(calls, 1);
    assert.equal(report.mode, 'status-only');
    assert.equal(report.outcome, outcome);
    assert.equal(report.stop_reason, reason);
    assert.equal(report.after, null);
    assert.equal(report.x_offered, null);
    assert.equal(report.search.executed, false);
    assert.equal(report.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /purchased_balance|8734\.56|private/);
  });
}

// Exercise the actual entry points and actual SDK. Mock fetch is installed in a
// child process before the entry point loads; no test contacts Flovia.
for (const [entry, scenario, expectedCalls, outcome, exit] of [
  ['status-only.mjs', 'matching', ['flovia_status'], 'checked_status_only', 0],
  ['status-only.mjs', 'different', ['flovia_status'], 'stopped', 0],
  ['status-only.mjs', 'invalid', ['flovia_status'], 'stopped', 0],
  ['status-only.mjs', 'missing-key', [], 'error', 1],
  ['status-only.mjs', '401', ['flovia_status'], 'error', 1],
  ['status-only.mjs', '429', ['flovia_status'], 'error', 1],
  ['run.mjs', 'matching', ['flovia_status', 'tools/list', 'flovia_status'], 'checked_search_skipped', 0],
]) {
  test(`CLI ${entry}, ${scenario}: private sanitized artifact and bounded calls`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'flovia-cli-'));
    try {
      for (const file of ['cli.mjs', 'poc.mjs', 'run.mjs', 'status-only.mjs']) {
        await copyFile(new URL('../' + file, import.meta.url), path.join(dir, file));
      }
      await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(dir, 'node_modules'), 'dir');
      const preload = path.join(dir, 'mock.mjs');
      await writeFile(preload, `
import { writeFileSync } from 'node:fs';
import { EXPECTED_CONTRACT_VERSION } from '@flovialabs/sdk';
const calls = [];
process.on('exit', () => writeFileSync(new URL('./calls.json', import.meta.url), JSON.stringify(calls)));
globalThis.fetch = async (request) => {
  const body = await request.json();
  const name = body.method === 'tools/list' ? body.method : body.params?.name;
  calls.push(name);
  const scenario = process.env.FLOVIA_MOCK_SCENARIO;
  if (scenario === '401') return Response.json({error:'flv_MOCK_SECRET'}, {status:401});
  if (scenario === '429') return Response.json({jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({ok:false,explanation:{by:'flovia',code:'rate_limited',executed:'no',meaning:'flv_MOCK_SECRET',next_step:'private'},retry_after_seconds:1})}]}}, {status:429});
  const status = {
    ok:true,stage:'alpha',five_hour:{used_pct:0},week:{used_pct:0},services_off:[],data_consent:{answer:'y',needed:false},
    contract_version:scenario==='different' ? '2026-10-31.152' : scenario==='invalid' ? 'flv_MOCK_SECRET' : EXPECTED_CONTRACT_VERSION,
    purchased_balance_display:'$8734.56',private:'flv_MOCK_SECRET',
  };
  const result = name==='tools/list' ? {tools:[{name:'flovia_x',inputSchema:{}}]} : {content:[{type:'text',text:JSON.stringify(status)}]};
  return Response.json({jsonrpc:'2.0',id:body.id,result});
};
`);
      const env = { ...process.env, FLOVIA_KEY: 'flv_MOCK_SECRET', FLOVIA_MOCK_SCENARIO: scenario };
      if (scenario === 'missing-key') delete env.FLOVIA_KEY;
      const child = spawnSync(process.execPath, ['--import', preload, path.join(dir, entry)], { cwd: dir, env, encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.status, exit, child.stderr);
      assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'calls.json'), 'utf8')), expectedCalls);
      const reportFile = path.join(dir, 'results/report.json');
      const output = await readFile(reportFile, 'utf8');
      const report = JSON.parse(output);
      assert.equal(report.outcome, outcome);
      assert.equal(report.mode, entry === 'status-only.mjs' ? 'status-only' : 'check');
      assert.doesNotMatch(output + child.stdout + child.stderr, /flv_MOCK_SECRET|Authorization|purchased_balance|8734\.56|private/);
      assert.equal((await stat(reportFile)).mode & 0o777, 0o600);
      if (report.search) assert.equal(report.search.executed, false);
      if (scenario === 'different') assert.equal(report.stop_reason, 'contract_mismatch');
      if (scenario === 'invalid') assert.equal(report.before.contract_version_state, 'invalid_format');
      if (scenario === 'missing-key') assert.equal(report.error.code, 'missing_key');
      if (scenario === '401') assert.equal(report.error.category, 'authentication');
      if (scenario === '429') assert.equal(report.error.category, 'rate_limit');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
