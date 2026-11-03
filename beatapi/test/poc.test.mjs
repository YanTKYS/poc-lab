import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_MODELS, DUMMY_TEXT, ENDPOINT, TIMEOUT_MS, runPoc } from '../poc.mjs';

// All transports are in memory. An accidental use of the real fetch fails closed.
globalThis.fetch = () => { throw new Error('Live HTTP is forbidden in offline tests'); };
const KEY = 'sk-MOCK-PRIVATE-KEY';
const SUMMARY = '11月15日、中央公園で防災訓練を実施。参加無料、事前申込不要。';
const answer = (overrides = {}) => ({
  model: ALLOWED_MODELS[0],
  choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ summary: SUMMARY, category: '防災' }) } }],
  usage: { prompt_tokens: 110, completion_tokens: 42, total_tokens: 152 },
  ...overrides,
});
function transport(response = () => Response.json(answer())) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (...args) => {
      calls.push(args);
      return response(...args);
    },
  };
}
const run = (fake, options = {}) => runPoc({ model: ALLOWED_MODELS[0], apiKey: KEY, fetchImpl: fake.fetchImpl, ...options });
const withContent = (content, finish_reason = 'stop') => answer({ choices: [{ finish_reason, message: { content } }] });

for (const model of ALLOWED_MODELS) {
  test(`${model}: one fixed Chat Completions request and useful sanitized metrics`, async () => {
    const fake = transport(() => Response.json(answer({ model })));
    let ticks = 10;
    const report = await run(fake, { model, now: () => new Date('2026-11-03T03:00:00Z'), clock: () => (ticks += 25) });
    assert.equal(fake.calls.length, 1);
    const [url, options] = fake.calls[0];
    assert.equal(url, ENDPOINT);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(options.body);
    assert.equal(body.model, model);
    assert.equal(body.stream, false);
    assert.equal(body.max_tokens, 512);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, 'user');
    assert.ok(body.messages[0].content.endsWith(DUMMY_TEXT));
    assert.equal(body.response_format, undefined); // No assumed JSON-mode support.
    assert.equal(report.outcome, 'passed');
    assert.equal(report.reason, null);
    assert.equal(report.selected_model, model);
    assert.equal(report.response_model, model);
    assert.equal(report.response_model_state, 'matches');
    assert.equal(report.requested_at, '2026-11-03T03:00:00.000Z');
    assert.equal(report.elapsed_ms, 25);
    assert.equal(report.http_status, 200);
    assert.equal(report.requests_sent, 1);
    assert.equal(report.output.json_parseable, true);
    assert.equal(report.output.schema_valid, true);
    assert.equal(report.output.category, '防災');
    assert.equal(report.output.quality, 'heuristic_pass');
    assert.ok(Object.values(report.output.checks).every(Boolean));
    assert.equal(report.output.summary_characters, [...SUMMARY].length);
    assert.deepEqual(report.usage, { prompt_tokens: 110, completion_tokens: 42, total_tokens: 152 });
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK|Authorization|中央公園|架空の青空市/);
  });
}

for (const model of [undefined, null, '', 'unknown', 'deepseek-v4.1-flash', 'glm-5.3-flash',
  'MiniMax-M3.1-Flash', 'gemini-3.8-flash-free', 'DEEPSEEK-V4.1-FLASH-FREE',
  'deepseek-v4.1-flash-free\n', ' deepseek-v4.1-flash-free', ['glm-5.3-flash-free'], KEY]) {
  test(`invalid model ${JSON.stringify(model)} is rejected before HTTP`, async () => {
    const fake = transport();
    const report = await run(fake, { model });
    assert.equal(fake.calls.length, 0);
    assert.equal(report.reason, 'invalid_model');
    assert.equal(report.selected_model, null);
    assert.equal(report.requests_sent, 0);
    assert.equal(report.requested_at, null);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
  });
}

for (const apiKey of [undefined, null, '', ' \n ', 123]) {
  test(`missing key ${JSON.stringify(apiKey)} is rejected before HTTP`, async () => {
    const fake = transport();
    const report = await run(fake, { apiKey });
    assert.equal(fake.calls.length, 0);
    assert.equal(report.reason, 'missing_key');
    assert.equal(report.requests_sent, 0);
  });
}

for (const timeoutMs of [0, -1, Infinity, TIMEOUT_MS + 1]) {
  test(`invalid timeout ${timeoutMs} is rejected before HTTP`, async () => {
    const fake = transport();
    assert.equal((await run(fake, { timeoutMs })).reason, 'invalid_timeout');
    assert.equal(fake.calls.length, 0);
  });
}

for (const [status, reason] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limited'],
  [402, 'http_error'], [500, 'http_error'], [302, 'http_error'], [307, 'http_error']]) {
  test(`HTTP ${status}: no retry, fallback, body or header disclosure`, async () => {
    let read = false;
    const fake = transport(() => {
      const response = new Response(`private account balance $9876 ${KEY}`, {
        status, headers: { 'Retry-After': '0', Location: 'https://other.invalid', 'X-Private': KEY },
      });
      response.json = response.text = () => { read = true; throw new Error(KEY); };
      return response;
    });
    const report = await run(fake);
    assert.equal(fake.calls.length, 1);
    assert.equal(read, false);
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.reason, reason);
    assert.equal(report.http_status, status);
    assert.doesNotMatch(JSON.stringify(report), /9876|sk-MOCK|X-Private|other\.invalid|Retry-After|Location/);
  });
}

test('transport error (including redirect refusal) is sanitized and never retried', async () => {
  const fake = transport(() => { throw new Error(`Authorization Bearer ${KEY}`); });
  const report = await run(fake);
  assert.equal(report.reason, 'network_error');
  assert.equal(report.requests_sent, 1);
  assert.equal(fake.calls.length, 1);
  assert.equal(report.http_status, null);
  assert.doesNotMatch(JSON.stringify(report), /sk-MOCK|Authorization|Bearer/);
});

test('timeout aborts a stalled request once without retry', async () => {
  let signal;
  const fake = transport((_, options) => {
    signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error(KEY)), { once: true }));
  });
  const report = await run(fake, { timeoutMs: 10 });
  assert.equal(report.reason, 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal(fake.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
});

test('timeout also covers reading the response body, not only receiving headers', async () => {
  const fake = transport(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
  const report = await run(fake, { timeoutMs: 10 });
  assert.equal(report.reason, 'timeout');
  assert.equal(report.http_status, 200);
  assert.equal(fake.calls.length, 1);
});

test('a response arriving after timeout cannot mutate the report', async () => {
  let deliver;
  const fake = transport(() => new Promise((resolve) => { deliver = resolve; }));
  const report = await run(fake, { timeoutMs: 10 });
  assert.equal(report.reason, 'timeout');
  const snapshot = structuredClone(report);
  deliver(Response.json(answer()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(report, snapshot);
  assert.equal(fake.calls.length, 1);
});

for (const [model, state, observed] of [
  [ALLOWED_MODELS[1], 'different_allowed_model', ALLOWED_MODELS[1]],
  ['deepseek-v4.1-flash', 'unrecognized', null], [KEY, 'unrecognized', null],
  [undefined, 'missing', null], [null, 'missing', null], [{ private: KEY }, 'unrecognized', null],
]) {
  test(`response model ${JSON.stringify(model)} never passes or triggers a fallback`, async () => {
    const fake = transport(() => Response.json(answer({ model })));
    const report = await run(fake);
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.reason, 'model_mismatch');
    assert.equal(report.response_model_state, state);
    assert.equal(report.response_model, observed);
    assert.equal(report.output, null);
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
  });
}

for (const [body, reason] of [[`not JSON ${KEY}`, 'invalid_response'], ['null', 'invalid_response'],
  ['[]', 'invalid_response'], ['x'.repeat(65_537), 'invalid_response']]) {
  test(`invalid or oversized response (${body.length} bytes) stops safely`, async () => {
    const fake = transport(() => new Response(body));
    const report = await run(fake);
    assert.equal(report.reason, reason);
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
  });
}

for (const content of [undefined, null, '', '   ', { private: KEY }]) {
  test(`empty/non-text answer ${JSON.stringify(content)} stops`, async () => {
    const fake = transport(() => Response.json(withContent(content)));
    const report = await run(fake);
    assert.equal(report.reason, 'empty_answer');
    assert.equal(fake.calls.length, 1);
    assert.equal(report.output, null);
  });
}

for (const content of [`not JSON ${KEY}`, '```json\n{"summary":"説明","category":"防災"}\n```']) {
  test('invalid output JSON is not repaired or retried', async () => {
    const fake = transport(() => Response.json(withContent(content)));
    const report = await run(fake);
    assert.equal(report.reason, 'invalid_output_json');
    assert.equal(report.output.json_parseable, false);
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK|説明/);
  });
}

for (const parsed of [null, [], {}, { summary: 5, category: '防災' }, { summary: '', category: '防災' },
  { summary: SUMMARY, category: KEY }, { summary: SUMMARY, category: '防災', extra: KEY }]) {
  test(`invalid schema ${JSON.stringify(parsed)} cannot pass`, async () => {
    const fake = transport(() => Response.json(withContent(JSON.stringify(parsed))));
    const report = await run(fake);
    assert.equal(report.reason, 'invalid_output_schema');
    assert.equal(report.output.json_parseable, true);
    assert.equal(report.output.schema_valid, false);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
  });
}

for (const parsed of [{ summary: SUMMARY, category: '観光' },
  { summary: '防災訓練を実施します。', category: '防災' },
  { summary: `${SUMMARY}${'あ'.repeat(81)}`, category: '防災' }]) {
  test('wrong category, missing facts or overly long summary fails simple quality checks', async () => {
    const fake = transport(() => Response.json(withContent(JSON.stringify(parsed))));
    const report = await run(fake);
    assert.equal(report.reason, 'quality_check_failed');
    assert.equal(report.output.schema_valid, true);
    assert.equal(report.output.quality, 'fail');
  });
}

for (const finish of ['length', 'content_filter', 'tool_calls', undefined, KEY]) {
  test(`finish reason ${String(finish)} cannot be reported as success`, async () => {
    const response = withContent(JSON.stringify({ summary: SUMMARY, category: '防災' }), finish);
    if (finish === undefined) delete response.choices[0].finish_reason;
    const fake = transport(() => Response.json(response));
    const report = await run(fake);
    assert.equal(report.outcome, 'stopped');
    assert.equal(report.reason, 'incomplete_answer');
    assert.equal(fake.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(report), /sk-MOCK/);
  });
}

test('poisoned successful response only yields enums, numbers and booleans', async () => {
  const privateText = `Authorization: Bearer ${KEY}; balance $9876; person@example.invalid`;
  const fake = transport(() => Response.json(answer({
    id: privateText, private: privateText, model: ALLOWED_MODELS[0],
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      summary: `${SUMMARY}${privateText}`, category: '防災',
    }), reasoning_content: privateText } }],
    usage: { prompt_tokens: 110, completion_tokens: privateText, total_tokens: -1,
      balance: 9876, arbitrary: privateText, prompt_tokens_details: { secret: privateText } },
  }), { headers: { 'X-Private': privateText } }));
  const report = await run(fake);
  assert.deepEqual(report.usage, { prompt_tokens: 110 });
  assert.doesNotMatch(JSON.stringify(report), /sk-MOCK|9876|Authorization|Bearer|person@|reasoning_content|X-Private|中央公園/);
});

for (const value of ['42', null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
  test(`non-count usage ${JSON.stringify(value)} is dropped`, async () => {
    const fake = transport(() => Response.json(answer({ usage: { prompt_tokens: value } })));
    assert.deepEqual((await run(fake)).usage, {});
  });
}
