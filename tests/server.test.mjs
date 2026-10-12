import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHandler } from '../server/app.mjs';

async function serverFor(t, options = {}) {
  const server = createServer(createHandler(options));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { get: path => fetch(base + path), post: (path, body = {}, extra = {}) => fetch(base + path, {
    method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-Between-Client': '1', ...extra }, body: JSON.stringify(body),
  }) };
}

test('configuration exposes only readiness; missing keys never call a provider', async t => {
  const server = await serverFor(t, { env: {}, fetchImpl: () => assert.fail('No provider request expected') });
  const config = await server.get('/api/config');
  assert.deepEqual(await config.json(), { providers: { openai: false, azure: false, google: false } });
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 503);
  assert.equal((await server.post('/api/azure/token')).status, 503);
  assert.equal((await server.post('/api/google/session', { targetLanguage: 'en' })).status, 503);
});

test('Google endpoint uses refreshed keys, validates language and applies existing origin/method protections', async t => {
  let current = { GOOGLE_API_KEY: 'first-test-secret' };
  const calls = [];
  const server = await serverFor(t, { env: {}, getProviderEnv: () => current, googleTokenImpl: async input => {
    calls.push({ key: input.env.GOOGLE_API_KEY, target: input.targetLanguage });
    return { value: 'auth_tokens/temporary-test-token', model: 'gemini-3.5-live-translate-preview', expiresAt: '2026-09-05T01:00:00Z' };
  } });
  const config = await (await server.get('/api/config')).json();
  assert.deepEqual(config.providers, { openai: false, azure: false, google: true });
  assert.doesNotMatch(JSON.stringify(config), /first-test-secret/);
  const response = await server.post('/api/google/session', { targetLanguage: 'ja' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value, 'auth_tokens/temporary-test-token');
  current = { GOOGLE_API_KEY: 'rotated-test-secret' };
  await server.post('/api/google/session', { targetLanguage: 'ko' });
  assert.deepEqual(calls, [{ key: 'first-test-secret', target: 'ja' }, { key: 'rotated-test-secret', target: 'ko' }]);
  assert.equal((await server.post('/api/google/session', { targetLanguage: 'bad-language' })).status, 400);
  assert.equal((await server.post('/api/google/session', { targetLanguage: 'en' }, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await server.post('/api/google/session', { targetLanguage: 'en' }, { 'X-Between-Client': '' })).status, 403);
  assert.equal((await server.get('/api/google/session')).status, 405);
  assert.equal(calls.length, 2);
  current = { GOOGLE_API_KEY: '' };
  assert.equal((await server.post('/api/google/session', { targetLanguage: 'en' })).status, 503);
});

test('OpenAI session passes validated target and returns only a short-lived credential', async t => {
  let captured;
  const server = await serverFor(t, { env: { OPENAI_API_KEY: 'server-secret' }, fetchImpl: async (url, options) => {
    captured = { url, options };
    return Response.json({ value: 'ephemeral', expires_at: 123, internal: 'do-not-forward' });
  } });
  const response = await server.post('/api/openai/session', { targetLanguage: 'ko' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { value: 'ephemeral', expires_at: 123 });
  assert.equal(captured.url, 'https://api.openai.com/v1/realtime/translations/client_secrets');
  assert.equal(captured.options.headers.Authorization, 'Bearer server-secret');
  assert.equal(JSON.parse(captured.options.body).session.audio.output.language, 'ko');
  assert.deepEqual(JSON.parse(captured.options.body).session.audio.input.transcription, { model: 'gpt-realtime-whisper' });
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'not-a-language' })).status, 400);
});

test('Azure token exchange stays on the configured regional endpoint', async t => {
  let captured;
  const server = await serverFor(t, { env: { AZURE_SPEECH_KEY: 'private-key', AZURE_SPEECH_REGION: 'koreacentral' }, fetchImpl: async (url, options) => {
    captured = { url, options }; return new Response('temporary-token');
  } });
  const response = await server.post('/api/azure/token');
  assert.deepEqual(await response.json(), { token: 'temporary-token', region: 'koreacentral' });
  assert.equal(captured.url, 'https://koreacentral.api.cognitive.microsoft.com/sts/v1.0/issueToken');
  assert.equal(captured.options.headers['Ocp-Apim-Subscription-Key'], 'private-key');
});

test('cross-origin, missing client header, wrong content type, and large bodies are rejected', async t => {
  const server = await serverFor(t, { env: {}, fetchImpl: () => assert.fail('No provider request expected') });
  assert.equal((await server.post('/api/azure/token', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await server.post('/api/azure/token', {}, { 'X-Between-Client': '' })).status, 403);
  assert.equal((await server.post('/api/azure/token', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await server.post('/api/azure/token', { large: 'a'.repeat(5000) })).status, 413);
  assert.equal((await server.post('/api/azure/token', null)).status, 400);
});

test('provider failures are sanitized and session creation is rate limited', async t => {
  const server = await serverFor(t, { env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => new Response('sensitive-provider-body', { status: 401 }) });
  const response = await server.post('/api/openai/session', { targetLanguage: 'en' });
  assert.equal(response.status, 502);
  const body = await response.text();
  assert.match(body, /401/); assert.doesNotMatch(body, /sensitive-provider-body|secret/);
  for (let i = 1; i < 20; i++) await server.post('/api/openai/session', { targetLanguage: 'en' });
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 429);
});

test('unexpected tokens and unsafe Azure region fail closed', async t => {
  const invalid = await serverFor(t, { env: { AZURE_SPEECH_KEY: 'secret', AZURE_SPEECH_REGION: 'eastus.evil.example/' } });
  assert.equal((await (await invalid.get('/api/config')).json()).providers.azure, false);
  const server = await serverFor(t, { env: { OPENAI_API_KEY: 'secret' }, fetchImpl: async () => Response.json({ other: 'unexpected' }) });
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 502);
  assert.equal((await server.get('/api/openai/session')).status, 405);
  assert.equal((await server.get('/api/unknown')).status, 404);
  assert.equal((await server.get('/.env')).status, 404);
});

test('configuration refresh and token requests both use the latest service credentials', async t => {
  let current = {};
  const sentKeys = [];
  const server = await serverFor(t, { env: {}, getProviderEnv: () => current, fetchImpl: async (_, options) => {
    sentKeys.push(options.headers.Authorization);
    return Response.json({ value: 'ephemeral' });
  } });
  assert.equal((await (await server.get('/api/config')).json()).providers.openai, false);
  current = { OPENAI_API_KEY: 'new-test-key' };
  assert.equal((await (await server.get('/api/config')).json()).providers.openai, true);
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 200);
  current = { OPENAI_API_KEY: 'rotated-test-key' };
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 200);
  assert.deepEqual(sentKeys, ['Bearer new-test-key', 'Bearer rotated-test-key']);
  current = { OPENAI_API_KEY: '' };
  assert.equal((await server.post('/api/openai/session', { targetLanguage: 'en' })).status, 503);
});
