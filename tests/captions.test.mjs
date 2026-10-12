import test from 'node:test';
import assert from 'node:assert/strict';
import { captionTail, exportSessions, formatTime } from '../shared/captions.mjs';

test('audience captions preserve short text and show the latest part of long speech', () => {
  assert.equal(captionTail('  오늘의\n말씀입니다. '), '오늘의 말씀입니다.');
  const text = 'An older sentence. '.repeat(30) + 'This is the final sentence.';
  assert.ok(captionTail(text, 70).endsWith('This is the final sentence.'));
  assert.ok(captionTail(text, 70).length <= 70);
  assert.equal(Array.from(captionTail('한😀'.repeat(100), 40)).length, 40);
  assert.equal(captionTail(''), '');
});

test('long lectures show elapsed hours correctly', () => {
  assert.equal(formatTime(0), '00:00:00');
  assert.equal(formatTime(7263), '02:01:03');
});

test('exports preserve full source and translation, with demo labels and metadata', () => {
  const source = '긴 설교 원문 '.repeat(200);
  const text = exportSessions([{ title: '주일 설교', source, target: 'Full translation.', sourceLanguage: '한국어', targetLanguage: '영어', provider: '샘플 데모', demo: true, startedAt: 0, seconds: 7200 }]);
  assert.ok(text.includes(source));
  assert.match(text, /주일 설교 \(데모\)/);
  assert.match(text, /한국어 → 영어/);
  assert.match(text, /02:00:00/);
  assert.match(text, /Full translation\./);
});
