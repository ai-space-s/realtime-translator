import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTimedText, emptyCaptionFrames, pairedCaptionFrames, sentenceRanges, timedCaptionFrames } from '../shared/caption-flow.mjs';

const pairs = Array.from({ length: 9 }, (_, index) => ({ source: `원문 ${index + 1}입니다.`, target: `Sentence ${index + 1}.` }));

test('empty, partial and CJK sentences do not need spaces or final punctuation', () => {
  assert.deepEqual(pairedCaptionFrames([]).current, emptyCaptionFrames().current);
  assert.deepEqual(sentenceRanges('こんにちは。次です！まだ途中', 'ja').map(x => x.text), ['こんにちは。', '次です！', 'まだ途中']);
  assert.equal(sentenceRanges('The value is 3.14. Next sentence.', 'en').length, 2);
  assert.equal(sentenceRanges('아직 문장이 끝나지 않았', 'ko').length, 1);
});

test('latest three sentences move to previous without duplication or losing export data', () => {
  const early = pairedCaptionFrames(pairs.slice(0, 2));
  assert.equal(early.previous.target.length, 0);
  assert.equal(early.current.target.length, 2);
  const frames = pairedCaptionFrames(pairs, '다음 하나. 다음 둘. 다음 셋. 다음 넷.');
  assert.deepEqual(frames.previous.target, ['Sentence 4.', 'Sentence 5.', 'Sentence 6.']);
  assert.deepEqual(frames.current.target, ['Sentence 7.', 'Sentence 8.', 'Sentence 9.']);
  assert.deepEqual(frames.current.source, ['원문 7입니다.', '원문 8입니다.', '원문 9입니다.']);
  assert.equal(frames.pending.length, 3);
  assert.equal(frames.pendingMore, 1);
  assert.equal(pairs.length, 9);
  assert.equal(pairedCaptionFrames(pairs).pending.length, 0);
});

test('utterances with unequal source and translation counts are not paired by sentence index', () => {
  const frames = pairedCaptionFrames([{ source: '한 문장으로 이야기했습니다.', target: 'First sentence. Second sentence. Third sentence.' }]);
  assert.equal(frames.current.source.length, 1);
  assert.equal(frames.current.target.length, 3);
  assert.equal(frames.pending.length, 0);
});

test('same timestamp deltas retain exact text including token fragments', () => {
  const parts = [];
  appendTimedText(parts, 'Hel', 200);
  appendTimedText(parts, 'lo', 200);
  appendTimedText(parts, '. Next', 400);
  assert.equal(parts.map(x => x.text).join(''), 'Hello. Next');
  assert.equal(parts.length, 2);
  const frames = timedCaptionFrames([], parts);
  assert.deepEqual(frames.current.target, ['Hello.', 'Next']);
});

test('time-aligned backlog clears only as output timestamps catch up, including late input', () => {
  const source = [];
  const target = [];
  appendTimedText(source, '첫 문장. ', 200);
  appendTimedText(source, '둘째 문장. ', 400);
  appendTimedText(source, '셋째 문장.', 600);
  assert.equal(timedCaptionFrames(source, target).pending.length, 3);
  appendTimedText(target, 'First. ', 200);
  let frames = timedCaptionFrames(source, target);
  assert.deepEqual(frames.current.source, ['첫 문장.']);
  assert.deepEqual(frames.pending, ['둘째 문장.', '셋째 문장.']);
  appendTimedText(target, 'Second and third.', 600);
  frames = timedCaptionFrames(source, target);
  assert.equal(frames.pending.length, 0);
  assert.equal(frames.current.source.length, 3);
  // Source transcript may arrive after the translation; it must not reappear as pending.
  appendTimedText(source, '늦게 도착한 원문.', 600);
  assert.equal(timedCaptionFrames(source, target).pending.length, 0);
});

test('six timed sentences use separate windows and pending never fabricates future speech', () => {
  const source = [], target = [];
  pairs.forEach((pair, index) => {
    appendTimedText(source, pair.source + ' ', index * 200);
    appendTimedText(target, pair.target + ' ', index * 200);
  });
  const frames = timedCaptionFrames(source, target);
  assert.deepEqual(frames.previous.source, ['원문 4입니다.', '원문 5입니다.', '원문 6입니다.']);
  assert.deepEqual(frames.current.source, ['원문 7입니다.', '원문 8입니다.', '원문 9입니다.']);
  assert.deepEqual(frames.pending, []);
});

test('missing timing explicitly marks unaligned source, without guessing pending text', () => {
  const source = [], target = [];
  appendTimedText(source, '원문은 도착했습니다.', undefined);
  appendTimedText(target, 'Translation arrived.', undefined);
  const frames = timedCaptionFrames(source, target);
  assert.equal(frames.alignment, 'none');
  assert.deepEqual(frames.current.source, ['원문은 도착했습니다.']);
  assert.deepEqual(frames.pending, []);
});

test('partial timing progress never cuts the beginning of a pending sentence', () => {
  const source = [], target = [];
  appendTimedText(source, '오늘의 말씀을 ', 200);
  appendTimedText(source, '함께 나눕니다.', 600);
  appendTimedText(target, 'Today', 400);
  assert.deepEqual(timedCaptionFrames(source, target).pending, ['오늘의 말씀을 함께 나눕니다.']);
  appendTimedText(target, ' we share the message.', 600);
  assert.deepEqual(timedCaptionFrames(source, target).pending, []);
  assert.deepEqual(timedCaptionFrames(source, target).current.source, ['오늘의 말씀을 함께 나눕니다.']);
});

test('long sentences are preserved for layout fitting; alignment buffer is bounded', () => {
  const longSentence = 'A long clause, '.repeat(80) + 'the end.';
  assert.equal(pairedCaptionFrames([{ source: '긴 원문.', target: longSentence }]).current.target[0], longSentence);
  const parts = [];
  for (let index = 0; index < 20000; index++) appendTimedText(parts, 'text ', index * 200);
  assert.ok(parts.length <= 4000);
  assert.ok(parts.reduce((sum, x) => sum + x.text.length, 0) <= 12005);
  assert.equal(parts.at(-1).time, 19999 * 200);
});
