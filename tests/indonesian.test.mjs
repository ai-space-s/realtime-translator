import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SpeechTranslationConfig } from 'microsoft-cognitiveservices-speech-sdk';
import { languageByCode, azureTarget, translationLanguageError } from '../shared/languages.mjs';
import { createHandler } from '../server/app.mjs';
import { issueGoogleToken } from '../server/google.mjs';
import { translateSermon } from '../server/sermon.mjs';
import { createOpenAITranscript } from '../shared/openai-transcript.mjs';
import { createGoogleTranscript } from '../shared/google-transcript.mjs';
import { emptySermonSettings, referenceFor, validateProfile } from '../shared/sermon-context.mjs';
import { pairedCaptionFrames } from '../shared/caption-flow.mjs';
import { exportSessions } from '../shared/captions.mjs';

// All provider responses are mocked; never read .env or use real audio/API calls.
test('Indonesian uses id/id-ID and remains selectable for all three providers', () => {
  assert.equal(languageByCode('id').name, '인도네시아어');
  assert.equal(languageByCode('id').locale, 'id-ID');
  assert.equal(languageByCode('id').native, 'Indonesian');
  for (const provider of ['azure', 'google', 'openai']) {
    assert.equal(translationLanguageError(provider, 'ko', 'id'), '');
    assert.equal(translationLanguageError(provider, 'id', 'ko'), '');
  }
  assert.notEqual(translationLanguageError('openai', 'ko', 'lo'), '');
  assert.equal(translationLanguageError('google', 'ko', 'lo'), '');
});

test('Azure SDK and Google token select id as the translation target', async () => {
  const config = SpeechTranslationConfig.fromAuthorizationToken('test-token', 'koreacentral');
  config.speechRecognitionLanguage = languageByCode('ko').locale;
  config.addTargetLanguage(azureTarget('id'));
  assert.equal(config.speechRecognitionLanguage, 'ko-KR');
  assert.deepEqual(config.targetLanguages, ['id']); config.close();
  let captured;
  await issueGoogleToken({ env: { GOOGLE_API_KEY: 'test-key' }, targetLanguage: 'id', createClient: () => ({ authTokens: {
    create: async input => { captured = input; return { name: 'auth_tokens/test-only' }; },
  } }) });
  assert.equal(captured.config.liveConnectConstraints.config.translationConfig.targetLanguageCode, 'id');
  assert.equal(captured.config.liveConnectConstraints.model, 'gemini-3.5-live-translate-preview');
});

test('OpenAI and Google HTTP routes accept Indonesian without changing models or exposing keys', async t => {
  let captured, googleTarget;
  const server = createServer(createHandler({ env: { OPENAI_API_KEY: 'test-long-key', GOOGLE_API_KEY: 'test-google-key' },
    fetchImpl: async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return Response.json({ value: 'test-ephemeral', expires_at: 123 }); },
    googleTokenImpl: async ({ targetLanguage }) => { googleTarget = targetLanguage; return { value: 'auth_tokens/test-only' }; },
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = path => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers: {
    Origin: 'http://localhost:5173', 'Content-Type': 'application/json', 'X-Between-Client': '1',
  }, body: JSON.stringify({ targetLanguage: 'id' }) });
  const response = await post('/api/openai/session');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { value: 'test-ephemeral', expires_at: 123 });
  assert.equal(captured.body.session.model, 'gpt-realtime-translate');
  assert.equal(captured.body.session.audio.output.language, 'id');
  assert.equal(captured.url, 'https://api.openai.com/v1/realtime/translations/client_secrets');
  assert.equal((await post('/api/google/session')).status, 200); assert.equal(googleTarget, 'id');
});

test('Indonesian speaker dictionaries round-trip and the text translation request preserves off-script speech', async () => {
  const settings = emptySermonSettings();
  settings.profile = { ...settings.profile, name: '검사 사전', targetLanguage: 'id', expressions: '언약 => perjanjian', notes: '부정 표현과 성경 장절을 보존' };
  assert.deepEqual(validateProfile(JSON.parse(JSON.stringify(settings.profile))), settings.profile);
  const utterance = '원고에 없는 즉흥 발언입니다.';
  let input;
  const result = await translateSermon({ sourceLanguage: 'ko', targetLanguage: 'id', reference: referenceFor(settings), utterance, recent: [] }, {
    env: { OPENAI_API_KEY: 'test-key' }, signal: new AbortController().signal,
    fetchImpl: async (_url, options) => {
      input = JSON.parse(JSON.parse(options.body).input);
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ translation: 'Ini adalah ucapan spontan yang tidak ada dalam naskah.', needs_review: false, review_reason: '' }) }] }] });
    },
  });
  assert.equal(input.target_language, 'Indonesian'); assert.equal(input.source_language, 'Korean');
  assert.equal(input.current_utterance, utterance); assert.deepEqual(input.reference_only.excerpts, []);
  assert.equal(input.reference_only.profile.expressions, '언약 => perjanjian');
  assert.ok(result.translation.includes('ucapan spontan'));
});

test('Indonesian captions preserve streamed text, both 3-sentence regions and exported metadata', () => {
  const sentences = ['Halo.', 'Terima kasih.', 'Kita belajar bersama.', 'Hari ini hari Minggu.', 'Mari kita mulai.', 'Sampai jumpa!'];
  const target = sentences.join(' '), source = '안녕하세요. 감사합니다.';
  const openai = createOpenAITranscript('ko', 'id'), google = createGoogleTranscript('ko', 'id');
  let first, second;
  for (const delta of [target.slice(0, 8), target.slice(8, 21), target.slice(21)]) {
    first = openai.apply({ type: 'session.output_transcript.delta', delta });
    second = google.apply({ outputTranscription: { text: delta } });
  }
  const azure = pairedCaptionFrames([{ source, target }], '', 'ko', 'id');
  for (const frames of [first.captions, second.captions, azure]) {
    assert.deepEqual(frames.previous.target, sentences.slice(0, 3));
    assert.deepEqual(frames.current.target, sentences.slice(3));
  }
  assert.equal(first.target, target); assert.equal(second.target, target);
  const output = exportSessions([{ title: '검사', source, target, sourceLanguage: '한국어', targetLanguage: languageByCode('id').name, provider: '모의 응답', startedAt: 0, seconds: 2 }]);
  assert.match(output, /한국어 → 인도네시아어/); assert.ok(output.includes(target));
});
