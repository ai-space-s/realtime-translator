import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { SpeechTranslationConfig } from 'microsoft-cognitiveservices-speech-sdk';
import { languages, languageByCode, azureTarget, translationLanguageError } from '../shared/languages.mjs';
import { createHandler } from '../server/app.mjs';
import { issueGoogleToken } from '../server/google.mjs';
import { createGoogleTranscript } from '../shared/google-transcript.mjs';
import { emptySermonSettings, referenceFor, validateProfile } from '../shared/sermon-context.mjs';
import * as captions from '../shared/caption-flow.mjs';
import { exportSessions } from '../shared/captions.mjs';

test('Lao has a unique ISO code and is enabled only on the supported provider paths', () => {
  assert.equal(languageByCode('lo').locale, 'lo-LA');
  assert.equal(languageByCode('lo').name, '라오어 (라오스)');
  assert.equal(new Set(languages.map(x => x.code)).size, languages.length);
  for (const provider of ['azure', 'google']) {
    assert.equal(translationLanguageError(provider, 'ko', 'lo'), '');
    assert.equal(translationLanguageError(provider, 'lo', 'ko'), '');
  }
  assert.match(translationLanguageError('openai', 'ko', 'lo'), /Microsoft.*Google/);
  assert.match(translationLanguageError('openai', 'lo', 'en'), /Microsoft.*Google/);
  assert.equal(translationLanguageError('openai', 'ko', 'en'), '');
  assert.match(translationLanguageError('google', 'ko', 'invalid'), /지원하지/);
});

test('Azure SDK configuration uses Korean recognition and lo as the text translation target', () => {
  const config = SpeechTranslationConfig.fromAuthorizationToken('test-only-token', 'koreacentral');
  config.speechRecognitionLanguage = languageByCode('ko').locale;
  config.addTargetLanguage(azureTarget('lo'));
  assert.equal(config.speechRecognitionLanguage, 'ko-KR');
  assert.deepEqual(config.targetLanguages, ['lo']);
  assert.equal(azureTarget('zh'), 'zh-Hans');
  config.close();
});

test('Google token locks lo as the output language without changing the model or key handling', async () => {
  let request;
  const token = await issueGoogleToken({ env: { GOOGLE_API_KEY: 'test-only-key' }, targetLanguage: 'lo', createClient: () => ({ authTokens: {
    create: async input => { request = input; return { name: 'auth_tokens/test-only' }; },
  } }) });
  assert.equal(request.config.liveConnectConstraints.config.translationConfig.targetLanguageCode, 'lo');
  assert.equal(request.config.liveConnectConstraints.model, 'gemini-3.5-live-translate-preview');
  assert.doesNotMatch(JSON.stringify(token), /test-only-key/);
});

test('HTTP routes accept Lao for Google and reject OpenAI fast/sermon before any upstream request', async t => {
  const targets = [];
  const server = createServer(createHandler({ env: { OPENAI_API_KEY: 'test-only', GOOGLE_API_KEY: 'test-only' },
    fetchImpl: () => assert.fail('OpenAI must not be called for Lao'),
    googleTokenImpl: async input => { targets.push(input.targetLanguage); return { value: 'auth_tokens/test-only' }; },
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = (path, body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: {
    Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-Between-Client': '1',
  }, body: JSON.stringify(body) });
  assert.equal((await post('/api/google/session', { targetLanguage: 'lo' })).status, 200);
  assert.deepEqual(targets, ['lo']);
  const fast = await post('/api/openai/session', { targetLanguage: 'lo' });
  assert.equal(fast.status, 400); assert.match((await fast.json()).error, /Microsoft.*Google/);
  const body = { sourceLanguage: 'ko', targetLanguage: 'lo', reference: referenceFor(emptySermonSettings()), utterance: '안녕하세요.', recent: [] };
  for (const path of ['/api/sermon/session', '/api/sermon/translate']) {
    assert.equal((await post(path, body)).status, 400);
    assert.equal((await post(path, { ...body, sourceLanguage: 'lo', targetLanguage: 'ko' })).status, 400);
  }
});

test('Lao Unicode survives streamed fragments, 3-sentence caption windows and Markdown export', () => {
  const tracker = createGoogleTranscript('ko', 'lo');
  const sentences = ['ສະບາຍດີ.', 'ຂອບໃຈ.', 'ພວກເຮົາຢູ່ທີ່ນີ້.', 'ດີຫຼາຍ.', 'ມື້ນີ້ແມ່ນວັນພຸດ.', 'ແລ້ວພົບກັນໃໝ່.'];
  tracker.apply({ inputTranscription: { text: '안녕하세요. 감사합니다.', finished: true } });
  let result;
  for (const character of sentences.join(' ')) result = tracker.apply({ outputTranscription: { text: character } });
  assert.equal(result.target, sentences.join(' '));
  assert.deepEqual(result.captions.previous.target, sentences.slice(0, 3));
  assert.deepEqual(result.captions.current.target, sentences.slice(3));
  const output = exportSessions([{ title: '라오어 검사', source: result.source, target: result.target, sourceLanguage: '한국어', targetLanguage: languageByCode('lo').name, provider: '모의 응답', startedAt: 0, seconds: 1 }]);
  assert.ok(output.includes(result.target)); assert.match(output, /한국어 → 라오어/);
  const profile = { ...emptySermonSettings().profile, targetLanguage: 'lo', expressions: '감사합니다 => ຂອບໃຈ' };
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(profile))), profile);
});

for (const [locale, greeting, thanks] of [['lo', 'ສະບາຍດີ', 'ຂອບໃຈ'], ['id', 'Halo', 'Terima kasih']]) {
test(`${locale} demo emits complete graphemes and final captions without a microphone or network`, async () => {
  const compiled = ts.transpileModule(readFileSync(new URL('../src/providers/demo.ts', import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let advance, stopped = false;
  const exports = {}, updates = [];
  vm.runInNewContext(compiled, { exports, Intl, setInterval: callback => { advance = callback; return 1; }, clearInterval: () => { stopped = true; }, require(name) {
    if (name.endsWith('caption-flow.mjs')) return captions;
    if (name === '../types') return { emptyTranscript: () => ({ source: '', target: '', interimSource: '', interimTarget: '' }) };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  const session = await exports.startDemo({ source: 'ko', target: locale, signal: new AbortController().signal, onLevel() {}, onTranscript: value => updates.push(value), onEnded() {} });
  for (let i = 0; i < 40; i++) advance();
  const full = updates.at(-1).target;
  assert.ok(full.includes(greeting));
  const boundaries = new Set([0, ...Array.from(new Intl.Segmenter(locale, { granularity: 'grapheme' }).segment(full), part => part.index + part.segment.length)]);
  for (const update of updates) assert.ok(boundaries.has(update.interimTarget.length));
  for (let i = 0; i < 121; i++) advance();
  assert.equal(stopped, true);
  assert.ok(updates.at(-1).captions.current.target.some(text => text.includes(thanks)));
  await session.stop();
});
}
