import { performance } from 'node:perf_hooks';

export const ALLOWED_MODELS = Object.freeze([
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
  'minimax-m3.1-flash-free',
]);
export const ENDPOINT = 'https://direct.beatapi.io/v1/chat/completions';
export const TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 65_536;
const CATEGORIES = Object.freeze(['防災', '子育て', '観光', 'その他']);
export const DUMMY_TEXT = '架空の青空市は11月15日午前10時から中央公園で防災訓練を開きます。参加者は避難経路の確認と消火器の使い方を学びます。参加費は無料で、事前申込は不要です。';
const INSTRUCTION = '次の架空のお知らせを日本語80文字以内で要約し、カテゴリを防災・子育て・観光・その他から1つ選んでください。日付・場所・防災訓練を要約に含めてください。出力は {"summary":"要約","category":"カテゴリ"} のJSONオブジェクトだけとし、追加キー、Markdown、説明は付けないでください。';

export const isAllowedModel = (model) => ALLOWED_MODELS.includes(model);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function usageSummary(usage) {
  return Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens']
    .map((key) => [key, count(usage?.[key])]).filter(([, value]) => value !== null));
}

// No generated text is copied to the report, including text inside valid JSON.
function evaluate(content) {
  const result = {
    json_parseable: false, schema_valid: false, category: null,
    summary_characters: null, checks: null, quality: 'fail',
  };
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { return result; }
  result.json_parseable = true;
  if (!object(parsed)) return result;
  const summary = parsed.summary;
  result.category = CATEGORIES.includes(parsed.category) ? parsed.category : null;
  result.schema_valid = Object.keys(parsed).length === 2
    && Object.hasOwn(parsed, 'summary') && Object.hasOwn(parsed, 'category')
    && typeof summary === 'string' && summary.trim().length > 0 && result.category !== null;
  if (typeof summary !== 'string') return result;
  result.summary_characters = [...summary].length;
  result.checks = {
    within_80_characters: result.summary_characters > 0 && result.summary_characters <= 80,
    contains_japanese: /[ぁ-んァ-ヶ一-龠]/u.test(summary),
    contains_date: /11月15日/u.test(summary),
    contains_place: summary.includes('中央公園'),
    contains_event: summary.includes('防災訓練'),
    expected_category: result.category === '防災',
  };
  if (result.schema_valid && Object.values(result.checks).every(Boolean)) result.quality = 'heuristic_pass';
  return result;
}

async function readJson(response) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error('invalid_response');
      chunks.push(value);
    }
  } finally {
    // Cancel even on a local size limit. Never log cancellation errors.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// The only HTTP call is here; the test transport is injected explicitly.
// All report strings are local constants or members of closed allowlists.
export async function runPoc({ model, apiKey, fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS, now = () => new Date(), clock = () => performance.now() } = {}) {
  const report = {
    format_version: 1, fixture: 'municipal-disaster-v1', requested_at: null,
    selected_model: isAllowedModel(model) ? model : null,
    response_model: null, response_model_state: 'not_checked',
    http_status: null, elapsed_ms: null, requests_sent: 0,
    outcome: 'stopped', reason: null, finish_reason: null,
    output: null, usage: {},
  };
  if (!isAllowedModel(model)) return { ...report, reason: 'invalid_model' };
  if (typeof apiKey !== 'string' || !apiKey.trim()) return { ...report, reason: 'missing_key' };
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > TIMEOUT_MS) {
    return { ...report, reason: 'invalid_timeout' };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  let phase = 'request';
  const start = clock();
  report.requested_at = now().toISOString();
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('timeout'));
      }, timeoutMs);
    });
    const request = async () => {
      report.requests_sent = 1;
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, max_tokens: 512,
          messages: [{ role: 'user', content: `${INSTRUCTION}\n\n${DUMMY_TEXT}` }],
        }),
      });
      // An injected transport may ignore abort. A late response cannot alter
      // the timeout report or start any follow-up work.
      if (timedOut) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      report.http_status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599
        ? response.status : null;
      if (!response.ok) {
        // Error bodies and headers may contain keys, balances and arbitrary text.
        void response.body?.cancel().catch(() => {});
        report.reason = ({ 401: 'unauthorized', 403: 'forbidden', 429: 'rate_limited' })[response.status] ?? 'http_error';
        return null;
      }
      phase = 'response';
      return readJson(response);
    };
    const data = await Promise.race([request(), deadline]);
    if (report.reason) return report;
    if (!object(data)) { report.reason = 'invalid_response'; return report; }
    report.response_model = isAllowedModel(data.model) ? data.model : null;
    report.response_model_state = data.model === model ? 'matches'
      : isAllowedModel(data.model) ? 'different_allowed_model'
        : data.model === undefined || data.model === null ? 'missing' : 'unrecognized';
    if (report.response_model_state !== 'matches') {
      report.reason = 'model_mismatch';
      return report;
    }
    report.usage = usageSummary(data.usage);
    const choice = data.choices?.[0];
    report.finish_reason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice?.finish_reason)
      ? choice.finish_reason : null;
    const content = choice?.message?.content;
    if (typeof content !== 'string' || !content.trim()) { report.reason = 'empty_answer'; return report; }
    report.output = evaluate(content);
    if (report.finish_reason !== 'stop') report.reason = 'incomplete_answer';
    else if (!report.output.json_parseable) report.reason = 'invalid_output_json';
    else if (!report.output.schema_valid) report.reason = 'invalid_output_schema';
    else if (report.output.quality !== 'heuristic_pass') report.reason = 'quality_check_failed';
    else { report.outcome = 'passed'; report.reason = null; }
  } catch {
    report.reason = timedOut ? 'timeout' : phase === 'response' ? 'invalid_response' : 'network_error';
  } finally {
    clearTimeout(timer);
    controller.abort();
    report.elapsed_ms = Math.max(0, Math.round(clock() - start));
  }
  return report;
}
