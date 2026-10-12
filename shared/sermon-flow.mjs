import { pairedCaptionFrames } from './caption-flow.mjs';

const failedCaption = {
  ko: '[번역 실패 · 운영자 확인 필요]', en: '[Translation unavailable · operator notified]',
  ja: '[翻訳できません · 担当者に通知済み]', zh: '[翻译暂不可用 · 已通知操作员]',
  es: '[Traducción no disponible]', fr: '[Traduction indisponible]', de: '[Übersetzung nicht verfügbar]', vi: '[Bản dịch không khả dụng]',
};

/** Ordered, independently testable ASR-to-translation pipeline. References never
 * decide whether speech is accepted. All final utterances enter the same queue.
 * @param {{source: string, target: string, translate: Function, onTranscript: Function, onError: Function, now?: Function}} options
 */
export function createSermonFlow({ source, target, translate, onTranscript, onError, now = Date.now }) {
  const items = new Map();
  const seen = new Set();
  let running = 0, closed = false;
  function item(id) {
    if (!items.has(id)) items.set(id, { id, previous: undefined, committed: false, since: now(), draft: '', source: '', target: '', final: false, status: 'listening', review: '', referenceCount: 0 });
    return items.get(id);
  }
  function ordered() {
    const result = [], visited = new Set(), visiting = new Set();
    function visit(entry) {
      if (visited.has(entry.id) || visiting.has(entry.id)) return;
      visiting.add(entry.id);
      if (entry.previous && items.has(entry.previous)) visit(items.get(entry.previous));
      visiting.delete(entry.id); visited.add(entry.id); result.push(entry);
    }
    for (const entry of items.values()) visit(entry);
    return result;
  }
  function snapshot() {
    const all = ordered();
    // Later translations may complete first. Keep them behind the first unsettled
    // turn so subtitles never jump forward and then backwards in spoken order.
    let blocked = false;
    const pairs = all.filter(x => x.final).map(entry => {
      if (!['done', 'failed'].includes(entry.status)) blocked = true;
      return { source: entry.source, target: blocked ? '' : entry.target };
    });
    const segments = all.map((entry, index) => ({
      number: index + 1, source: entry.final ? entry.source : entry.draft, target: entry.target,
      status: entry.status, review: entry.review, referenceCount: entry.referenceCount, referenceLabel: entry.referenceLabel || '',
    }));
    return {
      source: all.filter(x => x.final).map(x => x.source).filter(Boolean).join('\n\n'),
      target: pairs.map(x => x.target).filter(Boolean).join('\n\n'),
      interimSource: all.filter(x => !x.final).map(x => x.draft).filter(Boolean).join('\n\n'), interimTarget: '',
      captions: pairedCaptionFrames(pairs.slice(-40), '', source, target),
      quality: { pending: all.filter(x => ['ready', 'translating'].includes(x.status)).length,
        reviews: segments.filter(x => x.review).map(x => `발언 ${x.number}: ${x.review}`), segments },
    };
  }
  const emit = () => onTranscript(snapshot());
  function schedule() {
    if (closed) return;
    const all = ordered();
    for (let index = 0; index < all.length && running < 2; index++) {
      const entry = all[index];
      // Commit links, not completion-arrival order, establish spoken order.
      if (entry.status === 'unconfirmed') continue;
      if (entry.status === 'listening' || !entry.committed || (entry.previous && !items.has(entry.previous))) break;
      if (entry.status !== 'ready') continue;
      entry.status = 'translating'; running++;
      const recent = all.slice(0, index).filter(x => x.final).slice(-3).map(x => x.source.slice(-2000));
      Promise.resolve().then(() => translate(entry.source, recent)).then(result => {
        if (closed) return;
        entry.target = result.translation; entry.status = 'done'; entry.referenceCount = result.referenceCount || 0;
        entry.referenceLabel = result.referenceLabel || '';
        if (result.needsReview) entry.review = result.reviewReason || '번역 의미를 원문과 대조해 주세요.';
      }).catch(() => {
        if (closed) return;
        entry.status = 'failed'; entry.target = failedCaption[target] || failedCaption.en;
        entry.review = '번역 요청 실패. 원문을 보존했으며 이후 발언은 계속 번역합니다.';
        onError('일부 발언의 번역에 실패했습니다. 정확도 모드 확인 내역과 기록을 확인해 주세요.');
      }).finally(() => { running--; if (!closed) { emit(); schedule(); } });
    }
  }
  return {
    apply(event) {
      if (closed || !event || typeof event.item_id !== 'string') return;
      if (!['input_audio_buffer.speech_started', 'input_audio_buffer.committed', 'conversation.item.input_audio_transcription.delta', 'conversation.item.input_audio_transcription.completed', 'conversation.item.input_audio_transcription.failed'].includes(event.type)) return;
      if (typeof event.event_id === 'string') {
        if (seen.has(event.event_id)) return;
        seen.add(event.event_id); if (seen.size > 5000) seen.delete(seen.values().next().value);
      }
      const entry = item(event.item_id);
      if (event.type === 'input_audio_buffer.committed') {
        if (!entry.committed) entry.since = now();
        entry.committed = true; entry.previous = event.previous_item_id || null;
      } else if (event.type === 'conversation.item.input_audio_transcription.delta' && !entry.final) {
        if (typeof event.delta === 'string') entry.draft += event.delta;
      } else if (event.type === 'conversation.item.input_audio_transcription.completed' && !entry.final && typeof event.transcript === 'string') {
        entry.final = true; entry.source = event.transcript.trim(); entry.draft = '';
        entry.status = entry.source ? 'ready' : 'done';
        if (!entry.source) entry.review = '완료된 음성 인식 결과가 비어 있습니다. 음성을 확인해 주세요.';
      } else if (event.type === 'conversation.item.input_audio_transcription.failed' && !entry.final) {
        entry.status = 'unconfirmed'; entry.review = '음성 인식 실패. 미완료 원문을 원고로 채우지 않았습니다.';
        onError('일부 음성을 인식하지 못했습니다. 해당 구간을 확인해 주세요.');
      }
      emit(); schedule();
    },
    tick() {
      if (closed) return;
      for (const entry of items.values()) {
        // A stalled recognizer must not block every later spontaneous utterance.
        if (entry.status === 'listening' && entry.committed && now() - entry.since > 20000) {
          entry.status = 'unconfirmed'; entry.review = '음성 인식 완료가 지연되었습니다. 수신 원문은 미완료로 보존합니다.';
        }
      }
      emit(); schedule();
    },
    snapshot,
    hasPending() { return ordered().some(x => ['listening', 'ready', 'translating'].includes(x.status)); },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of items.values()) {
        if (['ready', 'translating'].includes(entry.status)) {
          entry.status = 'failed'; entry.target = failedCaption[target] || failedCaption.en;
          entry.review = '종료 대기 시간 내 번역을 받지 못했습니다. 원문을 확인해 주세요.';
        } else if (entry.status === 'listening') {
          entry.status = 'unconfirmed'; entry.review = '종료 시 인식 미완료. 수신한 임시 원문을 기록에 보존합니다.';
        }
      }
      emit();
    },
  };
}
