import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleTranscript } from '../shared/google-transcript.mjs';

test('Google output before input stays independent; append-only fragments preserve words and repetitions', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  tracker.apply({ outputTranscription: { text: 'Hel' } });
  tracker.apply({ outputTranscription: { text: 'lo. Yes, yes.' } });
  const result = tracker.apply({ inputTranscription: { text: '안녕하세요. 네, 네.', finished: true } });
  assert.equal(result.source, '안녕하세요. 네, 네.');
  assert.equal(result.target, 'Hello. Yes, yes.');
  assert.equal(result.captions.alignment, 'independent');
  assert.deepEqual(result.captions.pending, []);
  assert.deepEqual(result.captions.current.source, ['안녕하세요.', '네, 네.']);
});

test('Google interim snapshots replace, finalized source clears them, output turns do not commit source', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  tracker.apply({ interimInputTranscription: { text: '오늘' } });
  let result = tracker.apply({ interimInputTranscription: { text: '오늘의 말씀.' } });
  assert.equal(result.interimSource, '오늘의 말씀.');
  assert.equal(result.source, '');
  assert.deepEqual(result.captions.pending, ['오늘의 말씀.']);
  tracker.apply({ turnComplete: true });
  result = tracker.apply({ outputTranscription: { text: 'The message today.' } });
  assert.deepEqual(result.captions.pending, ['오늘의 말씀.']);
  assert.deepEqual(result.captions.current.source, []);
  result = tracker.apply({ inputTranscription: { text: '오늘의 말씀입니다.', finished: true } });
  assert.equal(result.source, '오늘의 말씀입니다.');
  assert.equal(result.interimSource, '');
  assert.deepEqual(result.captions.pending, []);
  assert.deepEqual(result.captions.current.source, ['오늘의 말씀입니다.']);
});

test('Google partial input stays below until a finish-only event, without waiting for a translation', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  let result = tracker.apply({ inputTranscription: { text: '서로 사랑합시다.', finished: false } });
  assert.deepEqual(result.captions.current.source, []);
  assert.deepEqual(result.captions.pending, ['서로 사랑합시다.']);
  // Missing flags on intermediate fragments must not override explicit unfinished.
  result = tracker.apply({ inputTranscription: { text: ' 이웃과 함께' } });
  assert.deepEqual(result.captions.current.source, []);
  result = tracker.apply({ inputTranscription: { finished: true } });
  assert.deepEqual(result.captions.pending, []);
  assert.deepEqual(result.captions.current.source, ['서로 사랑합시다.', '이웃과 함께']);
  assert.deepEqual(result.captions.current.target, []);
  assert.equal(result.source, '서로 사랑합시다. 이웃과 함께');
  result = tracker.apply({ interimInputTranscription: { text: '이제 다음 말씀' } });
  result = tracker.apply({ outputTranscription: { text: 'Let us love one another.', finished: true }, turnComplete: true });
  assert.deepEqual(result.captions.pending, ['이제 다음 말씀']);
  assert.deepEqual(result.captions.current.target, ['Let us love one another.']);
});

test('Google final source wins over a same-message draft and corrected drafts never enter history', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  tracker.apply({ interimInputTranscription: { text: '잘못된 인식' } });
  const result = tracker.apply({
    inputTranscription: { text: '올바른 원문', finished: true },
    interimInputTranscription: { text: '잘못된 인식 수정 중' },
  });
  assert.equal(result.interimSource, '');
  assert.equal(result.source, '올바른 원문');
  assert.deepEqual(result.captions.pending, []);
  assert.deepEqual(result.captions.current.source, ['올바른 원문']);
});

test('Google missing completion flags use labeled sentence boundaries, not output completion', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  let result = tracker.apply({ inputTranscription: { text: '첫 문장. 다음 문장' } });
  assert.equal(result.captions.recognition, 'sentence');
  assert.deepEqual(result.captions.current.source, ['첫 문장.']);
  assert.deepEqual(result.captions.pending, ['다음 문장']);
  tracker.apply({ turnComplete: true });
  result = tracker.apply({ outputTranscription: { text: 'First sentence.' } });
  assert.deepEqual(result.captions.pending, ['다음 문장']);
});

test('Google uses separate three-sentence windows and preserves all full history', () => {
  const tracker = createGoogleTranscript('ko', 'en');
  let result;
  for (let i = 1; i <= 9; i++) result = tracker.apply({
    inputTranscription: { text: `원문 ${i}입니다.`, finished: true },
    outputTranscription: { text: `Sentence ${i}.`, finished: true },
  });
  assert.deepEqual(result.captions.previous.target, ['Sentence 4.', 'Sentence 5.', 'Sentence 6.']);
  assert.deepEqual(result.captions.current.target, ['Sentence 7.', 'Sentence 8.', 'Sentence 9.']);
  assert.equal(result.captions.previous.source.length, 3);
  assert.equal(result.captions.current.source.length, 3);
  assert.match(result.source, /원문 1입니다/);
  assert.match(result.target, /Sentence 1\./);
  assert.equal(tracker.apply({ modelTurn: { parts: [{ inlineData: { data: 'unplayed-audio' } }] } }), null);
});
