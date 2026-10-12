/** Keep complete words where possible while bounding the audience's visible text. */
export function captionTail(text, limit = 220) {
  const clean = text.replace(/\s+/g, ' ').trim();
  const characters = Array.from(clean);
  if (characters.length <= limit) return clean;
  const tail = characters.slice(-limit).join('');
  const boundary = tail.search(/[\s。！？.!?]/);
  return boundary >= 0 && boundary < Math.min(50, limit / 3) ? tail.slice(boundary + 1).trimStart() : tail;
}

export function formatTime(seconds) {
  const value = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(value / 3600)).padStart(2, '0')}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function exportSessions(records) {
  return records.map(record => [
    `# ${record.title || '통역 세션'}${record.demo ? ' (데모)' : ''}`,
    `시작: ${new Date(record.startedAt).toLocaleString('ko-KR')}`,
    `${record.sourceLanguage} → ${record.targetLanguage} · ${record.provider} · ${formatTime(record.seconds)}`,
    '## 원문', record.source || '(원문 없음)',
    '## 번역', record.target || '(번역 없음)',
    ...(record.quality ? ['## 정확도 모드 확인 내역',
      '원문은 음성 인식 결과이며 검증된 발표 원고가 아닙니다. 확인 표시가 없어도 정확성을 보장하지 않습니다.',
      ...record.quality.segments.map(segment => [
        `### 발언 ${segment.number} · ${segment.status}`,
        `원문: ${segment.source || '(인식 결과 없음)'}`,
        `번역: ${segment.target || '(번역 미수신)'}`,
        `참고 문단: ${segment.referenceCount}개 · ${segment.review || '자동 확인 사항 없음'}`,
        ...(segment.referenceLabel ? [`발표 위치: ${segment.referenceLabel}`] : []),
      ].join('\n\n')),
    ] : []),
  ].join('\n\n')).join('\n\n---\n\n');
}
