import test from 'node:test';
import assert from 'node:assert/strict';
import { FloviaClient, FloviaError, EXPECTED_CONTRACT_VERSION } from '@flovialabs/sdk';
import { runPoc, safeError, summarizeStatus } from '../poc.mjs';

const ready = () => ({
  ok: true, contract_version: EXPECTED_CONTRACT_VERSION, stage: 'alpha',
  five_hour: { used_pct: 10, resets_at: '2026-10-31T12:00:00Z' },
  week: { used_pct: 20, resets_at: '2026-11-01T12:00:00Z' },
  services_off: [], data_consent: { answer: 'y', needed: false },
  purchased_balance_display: '$3.50',
});
function fake(status = ready(), tools = [{ name: 'flovia_x', inputSchema: {} }]) {
  const calls = [];
  return {
    calls,
    async status() { calls.push('status'); return structuredClone(status); },
    async listTools() { calls.push('list'); return tools; },
    async call() { assert.fail('No data, consent, catalog or paid calls are permitted'); },
  };
}

test('remaining free allowance and paid balance never enable a search', async () => {
  const client = fake();
  const r = await runPoc(client);
  assert.equal(r.outcome, 'checked_search_skipped');
  assert.equal(r.stop_reason, 'free_only_not_guaranteed');
  assert.equal(r.search.executed, false);
  assert.equal(r.search.count, null); // unrun is not zero results
  assert.equal(r.search.quality, 'unverified');
  assert.deepEqual(client.calls, ['status', 'list', 'status']);
  assert.deepEqual(r.before, r.after);
  assert.equal(r.before.purchased_balance_usd, 3.5);
  assert.equal(r.calls.length, 3);
  assert.ok(r.calls.every((c) => Number.isFinite(c.elapsed_ms)));
});

for (const [name, change, reason] of [
  ['pending', { free_pending: { next_step: 'private text' } }, 'free_pending'],
  ['pending stage', { stage: 'free_pending' }, 'free_pending'],
  ['stopped', { stopped: { message: 'private' } }, 'stopped'],
  ['stopped stage', { stage: 'stopped' }, 'stopped'],
  ['withdrawn', { consent: { sharing: 'withdrawn' } }, 'stopped'],
  ['declined', { data_consent: { answer: 'n' } }, 'stopped'],
  ['needs consent', { data_consent: { answer: 'y', needed: true } }, 'consent_unconfirmed'],
  ['unknown consent', { data_consent: {} }, 'consent_unconfirmed'],
  ['five-hour exhausted', { five_hour: { used_pct: 100 } }, 'allowance_exhausted'],
  ['week exhausted', { week: { used_pct: 100 } }, 'allowance_exhausted'],
  ['missing window', { week: null }, 'allowance_unknown'],
  ['invalid numeric percent', { week: { used_pct: -1 } }, 'allowance_unknown'],
  ['string percent', { week: { used_pct: '0' } }, 'allowance_unknown'],
  ['contract change', { contract_version: 'future' }, 'contract_mismatch'],
  ['X off', { services_off: ['x'] }, 'x_unavailable_or_unknown'],
  ['missing availability', { services_off: null }, 'x_unavailable_or_unknown'],
]) {
  test(`${name} stops immediately after first status`, async () => {
    const c = fake({ ...ready(), ...change });
    const r = await runPoc(c);
    assert.equal(r.stop_reason, reason);
    assert.equal(r.search.executed, false);
    assert.deepEqual(c.calls, ['status']);
    assert.equal(r.after, null);
    assert.ok(r.finished_at);
  });
}

test('X not offered stops before any subsequent call', async () => {
  const c = fake(ready(), [{ name: 'flovia_other' }]);
  const r = await runPoc(c);
  assert.equal(r.stop_reason, 'x_not_offered');
  assert.deepEqual(c.calls, ['status', 'list']);
});

for (const [code, status, category] of [
  ['unauthorized', 401, 'authentication'], ['http_403', 403, 'forbidden'],
  ['rate_limited', 429, 'rate_limit'], ['window_5h', undefined, 'free_allowance'],
  ['window_week', undefined, 'free_allowance'], ['service_off', undefined, 'tool_unavailable'],
  ['notice_first', undefined, 'human_action_required'], ['data_consent_needed', undefined, 'human_action_required'],
  ['network_error', undefined, 'transport'], ['timeout', undefined, 'transport'],
]) {
  test(`${code} is classified and never retried`, async () => {
    let calls = 0;
    const r = await runPoc({ async status() {
      calls++;
      throw new FloviaError({ code, status, executed: 'unknown', message: 'flv_PRIVATE Authorization Bearer KEY', reply: { secret: 'KEY' } });
    } });
    assert.equal(calls, 1);
    assert.equal(r.outcome, 'error');
    assert.equal(r.error.category, category);
    assert.equal(r.error.executed, 'unknown');
    assert.equal(r.search.executed, false);
    assert.doesNotMatch(JSON.stringify(r), /flv_PRIVATE|Authorization|Bearer|KEY/);
  });
}

test('unknown errors and status fields do not echo raw server data', () => {
  const poison = 'flv_SECRET Authorization: Bearer private';
  const r = summarizeStatus({
    ...ready(), stage: poison, contract_version: poison,
    recent_updates: [poison], purchased_balance_display: poison,
    five_hour: { used_pct: poison, resets_at: poison },
    services: { x: { state: poison } }, data_consent: { answer: poison },
  });
  assert.doesNotMatch(JSON.stringify(r), /SECRET|Authorization|Bearer|private/);
  assert.equal(r.purchased_balance_usd, null);
  assert.equal(safeError({ code: poison, message: poison }).code, 'unclassified_error');
});

test('error after first status retains before, records failed operation, no retry', async () => {
  const c = fake();
  c.listTools = async () => { throw { code: 'timeout' }; };
  const r = await runPoc(c);
  assert.equal(r.outcome, 'error');
  assert.equal(r.phase, 'tools_list');
  assert.ok(r.before);
  assert.equal(r.after, null);
  assert.equal(r.calls.length, 2);
});

test('actual SDK transport sends only status/list/status, and keeps key out of report', async () => {
  const key = 'flv_MOCK_SECRET';
  const requests = [];
  const c = new FloviaClient({ apiKey: key, retryRateLimited: false, onContractMismatch: () => {}, fetch: async (request) => {
    assert.equal(new URL(request.url).origin, 'https://api.flovia.dev');
    assert.equal(request.headers.get('Authorization'), `Bearer ${key}`);
    const body = await request.json();
    requests.push(body);
    const result = body.method === 'tools/list' ? { tools: [{ name: 'flovia_x', inputSchema: {} }] }
      : { content: [{ type: 'text', text: JSON.stringify(ready()) }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } });
  const r = await runPoc(c);
  assert.equal(r.outcome, 'checked_search_skipped');
  assert.deepEqual(requests.map((r) => r.params?.name ?? r.method), ['flovia_status', 'tools/list', 'flovia_status']);
  assert.doesNotMatch(JSON.stringify(r), /flv_MOCK_SECRET|Authorization/);
});

test('actual SDK does not retry 429 refusal', async () => {
  let count = 0;
  const c = new FloviaClient({ apiKey: 'flv_MOCK_SECRET', retryRateLimited: false, fetch: async () => {
    count++;
    return Response.json({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: JSON.stringify({ ok: false, explanation: {
      by: 'flovia', code: 'rate_limited', executed: 'no', meaning: 'private text', next_step: 'private text',
    }, retry_after_seconds: 1 }) }] } });
  } });
  const r = await runPoc(c);
  assert.equal(count, 1);
  assert.equal(r.error.category, 'rate_limit');
  assert.equal(r.error.executed, 'no');
});
