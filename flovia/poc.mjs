import { performance } from 'node:perf_hooks';
import { EXPECTED_CONTRACT_VERSION, PUBLIC_CODES } from '@flovialabs/sdk';

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
const percent = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : null;
const timestamp = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const windowSummary = (v) => ({ used_pct: percent(v?.used_pct), resets_at: timestamp(v?.resets_at) });
const stages = new Set(['alpha', 'active', 'ready', 'free', 'free_pending', 'stopped']);
const serviceStates = new Set(['ready', 'available', 'on', 'off', 'stopped', 'unavailable']);
const codes = new Set([...PUBLIC_CODES, 'unauthorized', 'formal_registration_required', 'timeout', 'network_error', 'mcp_error', 'tool_error', 'missing_key', 'invalid_status']);

// Never serialize arbitrary server strings, notices, tool descriptions, error causes or replies.
export function safeError(error) {
  const code = codes.has(error?.code) ? error.code : 'unclassified_error';
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  let category = 'other';
  if (status === 401 || ['unauthorized', 'formal_registration_required', 'missing_key'].includes(code)) category = 'authentication';
  else if (status === 403) category = 'forbidden';
  else if (status === 429 || code === 'rate_limited') category = 'rate_limit';
  else if (['window_5h', 'window_week', 'over_week', 'free_limited', 'free_needs_email', 'free_not_granted'].includes(code)) category = 'free_allowance';
  else if (['notice_first', 'data_consent_needed', 'consent_missing', 'data_consent_mismatch'].includes(code)) category = 'human_action_required';
  else if (['service_off', 'not_configured', 'endpoint_disabled'].includes(code)) category = 'tool_unavailable';
  else if (['network_error', 'timeout'].includes(code)) category = 'transport';
  return { category, code, http_status: status, executed: ['yes', 'no', 'unknown'].includes(error?.executed) ? error.executed : 'unknown' };
}

function contractDiagnostics(status) {
  const result = { contract_version_state: 'missing', observed_contract_version: null };
  if (!Object.hasOwn(status, 'contract_version')) return result;
  const version = status.contract_version;
  if (version === null) return { ...result, contract_version_state: 'null' };
  if (typeof version !== 'string') return { ...result, contract_version_state: 'invalid_type' };
  // Local publication filter, not a declaration of the server's accepted syntax
  // or compatibility. Require the entire string and a real calendar date.
  const match = /^(20\d{2}-\d{2}-\d{2})\.([1-9]\d{0,5})$/u.exec(version);
  const date = match && Date.parse(`${match[1]}T00:00:00.000Z`);
  if (!match || match[0] !== version || !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== match[1]) {
    return { ...result, contract_version_state: 'invalid_format' };
  }
  return {
    contract_version_state: version === EXPECTED_CONTRACT_VERSION ? 'matches_sdk' : 'different_version',
    observed_contract_version: version,
  };
}

export function summarizeStatus(status) {
  const s = object(status);
  const consent = object(s.data_consent);
  const sharing = object(s.consent).sharing;
  const x = object(object(s.services).x);
  // Reports may be public. Purchase balances are not needed for the stop decision.
  return {
    ...contractDiagnostics(s),
    contract_matches_sdk: s.contract_version === EXPECTED_CONTRACT_VERSION,
    stage: stages.has(s.stage) ? s.stage : 'unrecognized',
    five_hour: windowSummary(s.five_hour), week: windowSummary(s.week),
    free_pending: Boolean(s.free_pending), stopped: Boolean(s.stopped),
    data_consent_needed: consent.needed === true,
    data_consent_answer: ['y', 'n'].includes(consent.answer) ? consent.answer : null,
    sharing: ['withdrawn', 'accepted', 'declined'].includes(sharing) ? sharing : null,
    x_disabled: Array.isArray(s.services_off) ? s.services_off.includes('x') : null,
    x_provider_state: serviceStates.has(x.state) ? x.state : 'unrecognized',
  };
}

function stopReason(s) {
  if (!s.contract_matches_sdk) return 'contract_mismatch';
  if (s.stopped || s.stage === 'stopped' || ['withdrawn', 'declined'].includes(s.sharing) || s.data_consent_answer === 'n') return 'stopped';
  if (s.free_pending || s.stage === 'free_pending') return 'free_pending';
  if (s.data_consent_needed || s.data_consent_answer !== 'y') return 'consent_unconfirmed';
  if (s.five_hour.used_pct === null || s.week.used_pct === null) return 'allowance_unknown';
  if (s.five_hour.used_pct >= 100 || s.week.used_pct >= 100) return 'allowance_exhausted';
  if (s.x_disabled !== false) return 'x_unavailable_or_unknown';
  return null;
}

// Only read-only status/catalog operations. SDK 0.1.15 documents paid fallback and
// no server-enforced free-only request option. Therefore this version never searches.
export async function runPoc(client, { now = () => new Date(), clock = () => performance.now(), statusOnly = false } = {}) {
  const report = {
    format_version: 1, started_at: now().toISOString(), sdk_version: '0.1.15',
    expected_contract: EXPECTED_CONTRACT_VERSION, mode: statusOnly ? 'status-only' : 'check',
    outcome: 'stopped', stop_reason: null, phase: 'status_before',
    before: null, after: null, x_offered: null,
    search: { executed: false, count: null, posts: [], quality: 'unverified', reason: 'not_reached' },
    calls: [], error: null,
  };
  const call = async (name, fn) => {
    const start = clock();
    try { return await fn(); }
    finally { report.calls.push({ operation: name, elapsed_ms: Math.round(clock() - start) }); }
  };
  try {
    const before = await call('flovia_status', () => client.status());
    if (before?.ok === false || !before || typeof before !== 'object') throw { code: 'invalid_status' };
    report.before = summarizeStatus(before);
    report.stop_reason = stopReason(report.before);
    if (report.stop_reason) return report;
    if (statusOnly) {
      report.outcome = 'checked_status_only';
      return report;
    }
    report.phase = 'tools_list';
    const tools = await call('tools/list', () => client.listTools());
    report.x_offered = Array.isArray(tools) && tools.some((t) => t?.name === 'flovia_x');
    if (!report.x_offered) { report.stop_reason = 'x_not_offered'; return report; }
    // Do not invent free_only, max_cost or consent arguments absent from the official contract.
    report.stop_reason = 'free_only_not_guaranteed';
    report.search.reason = report.stop_reason;
    report.phase = 'status_after';
    const after = await call('flovia_status', () => client.status());
    if (after?.ok === false || !after || typeof after !== 'object') throw { code: 'invalid_status' };
    report.after = summarizeStatus(after);
    report.outcome = 'checked_search_skipped';
  } catch (error) {
    report.outcome = 'error';
    report.stop_reason = 'request_failed';
    report.error = safeError(error);
  } finally {
    report.search.reason = report.stop_reason ?? (statusOnly ? 'status_only' : 'not_reached');
    report.finished_at = now().toISOString();
  }
  return report;
}

export async function runStatusOnly(client, options = {}) {
  return runPoc(client, { ...options, statusOnly: true });
}
