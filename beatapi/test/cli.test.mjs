import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../cli.mjs';
import { ALLOWED_MODELS, runPoc } from '../poc.mjs';

const exec = promisify(execFile);
const KEY = 'sk-MOCK-PRIVATE-KEY';
globalThis.fetch = () => { throw new Error('Live HTTP is forbidden in offline tests'); };

test('CLI rejects arbitrary text/files/endpoints/model lists without HTTP or echoing input', async () => {
  for (const args of [[], ['--model', KEY], ['--model', ALLOWED_MODELS[0], '--text', KEY],
    ['--model', ALLOWED_MODELS[0], '--model', ALLOWED_MODELS[1]], ['--endpoint', KEY]]) {
    const logs = [];
    let report;
    let requests = 0;
    const status = await runCli({ args, env: { BEAT_API_KEY: KEY },
      run: (options) => runPoc({ ...options, fetchImpl: () => { requests++; throw new Error(KEY); } }),
      save: async (value) => { report = value; }, log: (line) => logs.push(line),
    });
    assert.equal(status, 1);
    assert.equal(requests, 0);
    assert.equal(report.reason, 'invalid_model');
    assert.doesNotMatch(JSON.stringify({ logs, report }), /sk-MOCK/);
  }
});

test('CLI with missing key saves a safe preflight report and fails', async () => {
  let report;
  const code = await runCli({ args: ['--model', ALLOWED_MODELS[0]], env: {},
    save: async (value) => { report = value; }, log() {},
  });
  assert.equal(code, 1);
  assert.equal(report.reason, 'missing_key');
  assert.equal(report.requests_sent, 0);
});

test('CLI suppresses exceptions from saving a report', async () => {
  const logs = [];
  const code = await runCli({ args: [], env: {}, save: async () => { throw new Error(KEY); }, log: (line) => logs.push(line) });
  assert.equal(code, 1);
  assert.doesNotMatch(logs.join('\n'), /sk-MOCK/);
});

test('real CLI entry point writes only sanitized report.json and sets exit status (mock HTTP)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'beatapi-cli-'));
  try {
    for (const file of ['run.mjs', 'cli.mjs', 'poc.mjs']) {
      await cp(new URL(`../${file}`, import.meta.url), join(directory, file));
    }
    const mockPath = join(directory, 'mock.mjs');
    await writeFile(mockPath, `
      globalThis.fetch = async (url, options) => {
        if (url !== 'https://direct.beatapi.io/v1/chat/completions' || options.redirect !== 'error') throw new Error('bad request');
        return Response.json({ model: JSON.parse(options.body).model,
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
            summary: '11月15日、中央公園で防災訓練を行います。', category: '防災'
          }) } }], private: 'sk-MOCK-PRIVATE-KEY' });
      };
    `);
    const result = await exec(process.execPath, ['--import', mockPath, join(directory, 'run.mjs'), '--model', ALLOWED_MODELS[0]], {
      env: { BEAT_API_KEY: KEY },
    });
    const report = JSON.parse(await readFile(join(directory, 'results/report.json'), 'utf8'));
    assert.equal(report.outcome, 'passed');
    assert.doesNotMatch(JSON.stringify({ report, ...result }), /sk-MOCK|中央公園/);
    for (const [args, env, reason] of [
      [['--model', KEY], { BEAT_API_KEY: KEY }, 'invalid_model'],
      [['--model', ALLOWED_MODELS[0]], {}, 'missing_key'],
    ]) {
      await assert.rejects(exec(process.execPath, ['--import', mockPath, join(directory, 'run.mjs'), ...args], { env }), (error) => {
        assert.equal(error.code, 1);
        assert.doesNotMatch(error.stdout + error.stderr, /sk-MOCK/);
        return true;
      });
      const stopped = JSON.parse(await readFile(join(directory, 'results/report.json'), 'utf8'));
      assert.equal(stopped.reason, reason);
      assert.equal(stopped.requests_sent, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
