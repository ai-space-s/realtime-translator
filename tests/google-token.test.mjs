import test from 'node:test';
import assert from 'node:assert/strict';
import { googleApiKey, issueGoogleToken } from '../server/google.mjs';
import { GoogleGenAI } from '@google/genai';
import { createServer } from 'node:http';
import { once } from 'node:events';

test('Google key alias is accepted; explicit nonempty GOOGLE_API_KEY wins', () => {
  assert.equal(googleApiKey({}), '');
  assert.equal(googleApiKey({ GEMINI_API_KEY: ' alias ' }), 'alias');
  assert.equal(googleApiKey({ GOOGLE_API_KEY: ' primary ', GEMINI_API_KEY: 'alias' }), 'primary');
  assert.equal(googleApiKey({ GOOGLE_API_KEY: ' ', GEMINI_API_KEY: 'alias' }), 'alias');
});

test('Google token locks model, target and transcripts and exposes only an ephemeral token', async () => {
  const env = { GOOGLE_API_KEY: 'private-test-placeholder' };
  let options, request;
  const now = Date.parse('2026-09-05T00:00:00Z');
  const result = await issueGoogleToken({ env, targetLanguage: 'zh', now, createClient: supplied => {
    options = supplied;
    return { authTokens: { create: async input => { request = input; return { name: 'auth_tokens/test-ephemeral', other: env.GOOGLE_API_KEY }; } } };
  } });
  assert.equal(options.apiKey, env.GOOGLE_API_KEY);
  assert.equal(options.vertexai, false);
  assert.equal(options.httpOptions.apiVersion, 'v1beta');
  assert.equal(request.config.uses, 1);
  assert.equal(request.config.newSessionExpireTime, '2026-09-05T00:01:00.000Z');
  assert.equal(request.config.expireTime, '2026-09-05T00:30:00.000Z');
  assert.equal(request.config.lockAdditionalFields, undefined);
  assert.deepEqual(request.config.liveConnectConstraints, { model: 'gemini-3.5-live-translate-preview', config: {
    responseModalities: ['AUDIO'], inputAudioTranscription: {}, outputAudioTranscription: {},
    translationConfig: { targetLanguageCode: 'zh-Hans', echoTargetLanguage: false },
  } });
  assert.deepEqual(Object.keys(result).sort(), ['expiresAt', 'model', 'value']);
  assert.doesNotMatch(JSON.stringify(result), /private-test-placeholder/);
});

test('Google missing key, invalid target, non-translation model and malformed token fail closed', async () => {
  const env = { GOOGLE_API_KEY: 'test-placeholder' };
  const noCall = () => assert.fail('No upstream request expected');
  await assert.rejects(issueGoogleToken({ env: {}, targetLanguage: 'en', createClient: noCall }), { status: 503 });
  await assert.rejects(issueGoogleToken({ env, targetLanguage: 'bad', createClient: noCall }), { status: 400 });
  await assert.rejects(issueGoogleToken({ env: { ...env, GOOGLE_TRANSLATION_MODEL: 'gemini-general-chat' }, targetLanguage: 'en', createClient: noCall }), { status: 503 });
  for (const response of [{}, { name: env.GOOGLE_API_KEY }, { name: 'auth_tokens/' }]) {
    await assert.rejects(issueGoogleToken({ env, targetLanguage: 'en', createClient: () => ({ authTokens: { create: async () => response } }) }), { status: 502 });
  }
});

test('Google provider errors never expose raw SDK messages, bodies or keys', async () => {
  for (const status of [400, 401, 403, 404, 429, 503]) {
    await assert.rejects(issueGoogleToken({ env: { GOOGLE_API_KEY: 'private-test-placeholder' }, targetLanguage: 'en',
      createClient: () => ({ authTokens: { create: async () => { throw Object.assign(new Error('private-test-placeholder and sensitive provider body'), { status }); } } }),
    }), error => {
      assert.equal(error.status, 502);
      assert.doesNotMatch(error.message, /private-test-placeholder|sensitive provider body/);
      assert.match(error.message, new RegExp(String(status)));
      return true;
    });
  }
});

test('installed Google SDK produces the constrained v1beta REST request against a local mock only', async t => {
  let captured;
  const mock = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = { path: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(Buffer.concat(chunks).toString()) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: 'auth_tokens/local-mock-token' }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  t.after(() => { mock.closeAllConnections(); mock.close(); });
  const baseUrl = `http://127.0.0.1:${mock.address().port}`;
  const result = await issueGoogleToken({ env: { GOOGLE_API_KEY: 'local-test-placeholder' }, targetLanguage: 'en',
    createClient: options => new GoogleGenAI({ ...options, httpOptions: { ...options.httpOptions, baseUrl } }),
  });
  assert.equal(result.value, 'auth_tokens/local-mock-token');
  assert.equal(captured.path, '/v1beta/auth_tokens');
  assert.equal(captured.key, 'local-test-placeholder');
  assert.equal(captured.body.uses, 1);
  const setup = captured.body.bidiGenerateContentSetup;
  assert.equal(setup.model, 'models/gemini-3.5-live-translate-preview');
  assert.equal(setup.generationConfig.translationConfig.targetLanguageCode, 'en');
  assert.deepEqual(setup.inputAudioTranscription, {});
  assert.deepEqual(setup.outputAudioTranscription, {});
  assert.equal(captured.body.fieldMask, undefined);
});
