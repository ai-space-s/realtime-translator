import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadProviderEnv } from '../server/config.mjs';
import { selectConfiguredProvider } from '../shared/providers.mjs';

test('only OpenAI configured: automatically select it instead of the Microsoft default', () => {
  assert.equal(selectConfiguredProvider('azure', { openai: true, azure: false }), 'openai');
  assert.equal(selectConfiguredProvider('openai', { openai: true, azure: true }), 'openai');
  assert.equal(selectConfiguredProvider('azure', { openai: false, azure: false }), 'azure');
  assert.equal(selectConfiguredProvider('openai', { openai: false, azure: true }), 'azure');
  assert.equal(selectConfiguredProvider('azure', { openai: false, azure: false, google: true }), 'google');
  assert.equal(selectConfiguredProvider('google', { openai: true, azure: true, google: true }), 'google');
});

test('.env credential updates take effect on the next read without changing listener settings', t => {
  const dir = mkdtempSync(join(tmpdir(), 'between-config-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  const inherited = { OPENAI_API_KEY: 'inherited-test-placeholder', PORT: '5173', APP_ORIGIN: 'http://localhost:5173' };
  writeFileSync(file, 'OPENAI_API_KEY=local-test-key\nPORT=9000\nAPP_ORIGIN=https://different.example\n');
  let current = loadProviderEnv(inherited, file);
  assert.equal(current.OPENAI_API_KEY, 'local-test-key');
  assert.equal(current.PORT, '5173');
  assert.equal(current.APP_ORIGIN, 'http://localhost:5173');
  writeFileSync(file, 'OPENAI_API_KEY=changed-test-key\n');
  assert.equal(loadProviderEnv(inherited, file).OPENAI_API_KEY, 'changed-test-key');
  writeFileSync(file, 'OPENAI_API_KEY=\n');
  assert.equal(loadProviderEnv(inherited, file).OPENAI_API_KEY, '');
  assert.equal(inherited.OPENAI_API_KEY, 'inherited-test-placeholder');
  writeFileSync(file, 'GOOGLE_API_KEY=google-test-key\nGOOGLE_TRANSLATION_MODEL=gemini-3.5-live-translate-preview\nGEMINI_API_KEY=alias-test-key\n');
  current = loadProviderEnv(inherited, file);
  assert.equal(current.GOOGLE_API_KEY, 'google-test-key');
  assert.equal(current.GEMINI_API_KEY, 'alias-test-key');
  assert.equal(current.GOOGLE_TRANSLATION_MODEL, 'gemini-3.5-live-translate-preview');
  assert.equal(loadProviderEnv(inherited, join(dir, 'missing.env')).OPENAI_API_KEY, inherited.OPENAI_API_KEY);
});
