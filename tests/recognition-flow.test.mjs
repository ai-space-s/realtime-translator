import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecognitionFlow } from '../shared/recognition-flow.mjs';
import { createOpenAITranscript } from '../shared/openai-transcript.mjs';
import { pairedCaptionFrames } from '../shared/caption-flow.mjs';

test('explicit final signal promotes punctuation-free input exactly once', () => {
  const flow = createRecognitionFlow('ko');
  assert.equal(flow.append('우리의 ', false).completed, '');
  assert.equal(flow.append('이웃을 사랑합시다', false).pending, '우리의 이웃을 사랑합시다');
  const result = flow.append('', true);
  assert.equal(result.completed, '우리의 이웃을 사랑합시다');
  assert.equal(result.pending, '');
  flow.append('', true);
  assert.equal(flow.snapshot().source, result.source);
  assert.equal(flow.append('다음 원문', false).pending.trim(), '다음 원문');
});

test('sentence fallback preserves decimals, abbreviations, CJK and incomplete tails', () => {
  const decimal = createRecognitionFlow('en');
  assert.equal(decimal.append('The value is 3.').completed, '');
  assert.equal(decimal.append('14. Next sentence').completed, 'The value is 3.14. ');
  const abbreviation = createRecognitionFlow('en');
  assert.equal(abbreviation.append('Dr.').completed, '');
  assert.equal(abbreviation.append(' Smith is here').completed, '');
  const cjk = createRecognitionFlow('ja');
  assert.equal(cjk.append('最初です。').completed, '最初です。');
  assert.equal(cjk.append('まだ途中').pending, 'まだ途中');
});

test('OpenAI moves source on its own boundary, never on translation timestamps', () => {
  const tracker = createOpenAITranscript('ko', 'en');
  const input = delta => tracker.apply({ type: 'session.input_transcript.delta', delta, elapsed_ms: 200 });
  let result = input('오늘의 ');
  assert.deepEqual(result.captions.pending, ['오늘의']);
  assert.deepEqual(result.captions.current.source, []);
  result = tracker.apply({ type: 'session.output_transcript.delta', delta: 'Today’s message.', elapsed_ms: 100000 });
  assert.deepEqual(result.captions.pending, ['오늘의']);
  result = input('말씀입니다. 다음 말씀');
  assert.deepEqual(result.captions.current.source, ['오늘의 말씀입니다.']);
  assert.deepEqual(result.captions.pending, ['다음 말씀']);
  assert.equal(result.source, '오늘의 말씀입니다. 다음 말씀');
  assert.equal(result.interimSource, ''); // The export must not duplicate the tail.
  assert.equal(result.captions.recognition, 'sentence');
  assert.equal(tracker.apply({ type: 'session.closed' }), null); // Do not invent a final signal on disconnect.
});

test('translation-before-source and repeated fragments keep independent histories', () => {
  const tracker = createOpenAITranscript('ko', 'en');
  tracker.apply({ type: 'session.output_transcript.delta', delta: 'Hel' });
  tracker.apply({ type: 'session.output_transcript.delta', delta: 'lo. Yes, yes.' });
  const result = tracker.apply({ type: 'session.input_transcript.delta', delta: '안녕하세요! 네, 네' });
  assert.equal(result.target, 'Hello. Yes, yes.');
  assert.deepEqual(result.captions.current.source, ['안녕하세요!']);
  assert.deepEqual(result.captions.pending, ['네, 네']);
});

test('paired providers move recognized source even before its translated result arrives', () => {
  const pairs = [{ source: '첫 번째 원문입니다.', target: 'First source.' }];
  const initial = pairedCaptionFrames(pairs, '새로운 원문을 인식');
  assert.deepEqual(initial.current.source, ['첫 번째 원문입니다.']);
  assert.deepEqual(initial.pending, ['새로운 원문을 인식']);
  pairs.push({ source: '새로운 원문을 인식했습니다.', target: '' });
  const recognized = pairedCaptionFrames(pairs);
  assert.deepEqual(recognized.pending, []);
  assert.deepEqual(recognized.current.source, ['첫 번째 원문입니다.', '새로운 원문을 인식했습니다.']);
  assert.equal(recognized.alignment, 'independent');
  pairs[1].target = 'New source recognized.';
  const translated = pairedCaptionFrames(pairs, '그다음 발화 중');
  assert.deepEqual(translated.current.target, ['First source.', 'New source recognized.']);
  assert.deepEqual(translated.pending, ['그다음 발화 중']);
});

test('a bounded completed caption buffer never truncates received export history', () => {
  const flow = createRecognitionFlow('ko');
  for (let i = 0; i < 1200; i++) flow.append(`${i}번째 말씀을 함께 나눕니다.`, true);
  const result = flow.snapshot();
  assert.ok(result.completed.length <= 16000);
  assert.ok(result.source.startsWith('0번째'));
  assert.ok(result.source.endsWith('1199번째 말씀을 함께 나눕니다.'));
});
