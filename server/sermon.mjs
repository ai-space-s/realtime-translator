import { languageByCode, translationLanguageError } from '../shared/languages.mjs';
import { boundedText, validateReference, transcriptionHints, sermonTranslationInstructions } from '../shared/sermon-context.mjs';
import { validateSeminarContext, seminarTranslationInstructions } from '../shared/seminar-context.mjs';

const fail = (status, message) => Object.assign(new Error(message), { status });
function validateRequest(body) {
  if (!languageByCode(body.sourceLanguage) || !languageByCode(body.targetLanguage) || body.sourceLanguage === body.targetLanguage) throw fail(400, '서로 다른 원어와 번역어를 선택해 주세요.');
  const languageError = translationLanguageError('openai', body.sourceLanguage, body.targetLanguage);
  if (languageError) throw fail(400, languageError);
  return validateReference(body.reference, body.sourceLanguage, body.targetLanguage);
}
async function openaiRequest(path, body, { env, fetchImpl, signal }) {
  const response = await fetchImpl(`https://api.openai.com/v1/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) throw fail(502, response.status === 429 ? 'OpenAI 사용 한도 또는 잔액을 확인해 주세요.' : `OpenAI 정확도 모드 요청 실패 (${response.status}). 모델 접근 권한과 서버 설정을 확인해 주세요.`);
  // No raw upstream errors, headers, credentials or input content in logs/errors.
  return response.json();
}
export async function createSermonToken(body, options) {
  const reference = validateRequest(body);
  const hints = transcriptionHints(reference);
  const data = await openaiRequest('realtime/client_secrets', {
    expires_after: { anchor: 'created_at', seconds: 60 },
    session: { type: 'transcription', audio: { input: {
      transcription: { model: 'gpt-live-transcribe', languages: [body.sourceLanguage], delay: 'low', ...hints },
      turn_detection: null,
    } } },
  }, options);
  if (typeof data.value !== 'string' || !data.value) throw fail(502, '음성 인식 연결 토큰을 받지 못했습니다.');
  return { value: data.value, expires_at: data.expires_at };
}
export async function translateSermon(body, options) {
  const reference = validateRequest(body);
  const seminar = options.seminar ? validateSeminarContext(body.seminar) : null;
  const utterance = boundedText(body.utterance, 8000, '현재 발언', true);
  if (!Array.isArray(body.recent) || body.recent.length > 3) throw fail(400, '최근 문맥 형식을 확인해 주세요.');
  const recent = body.recent.map(text => boundedText(text, 2000, '최근 발언'));
  const data = await openaiRequest('responses', {
    model: options.env.OPENAI_SERMON_TEXT_MODEL || 'gpt-5.4-mini-2026-03-17',
    store: false, reasoning: { effort: 'low' }, max_output_tokens: 6000,
    instructions: seminar ? seminarTranslationInstructions : sermonTranslationInstructions,
    input: JSON.stringify({ source_language: languageByCode(body.sourceLanguage).native, target_language: languageByCode(body.targetLanguage).native,
      current_utterance: utterance, recent_utterances: recent, reference_only: reference,
      ...(seminar ? { seminar_reference_only: seminar } : {}) }),
    text: { format: { type: 'json_schema', name: 'sermon_translation', strict: true, schema: {
      type: 'object', additionalProperties: false,
      properties: { translation: { type: 'string' }, needs_review: { type: 'boolean' }, review_reason: { type: 'string' } },
      required: ['translation', 'needs_review', 'review_reason'],
    } } },
  }, options);
  if (data.status !== 'completed') throw fail(502, '번역이 완료되지 않았습니다. 해당 발언을 기록에서 확인해 주세요.');
  const content = (data.output || []).filter(item => item.type === 'message').flatMap(item => item.content || []);
  if (content.some(item => item.type === 'refusal')) throw fail(502, '해당 발언의 번역 결과를 받지 못했습니다. 원문은 기록에 보존됩니다.');
  let result;
  try { result = JSON.parse(content.filter(item => item.type === 'output_text').map(item => item.text).join('')); }
  catch { throw fail(502, '번역 결과 형식을 확인할 수 없습니다.'); }
  if (!result || typeof result.translation !== 'string' || !result.translation.trim() || result.translation.length > 24000 || typeof result.needs_review !== 'boolean' || typeof result.review_reason !== 'string' || result.review_reason.length > 1000) throw fail(502, '유효한 번역 결과를 받지 못했습니다.');
  return { translation: result.translation.trim(), needsReview: result.needs_review, reviewReason: result.review_reason.trim(), referenceCount: seminar ? seminar.sections.length : reference.excerpts.length,
    ...(seminar ? { referenceLabel: seminar.sections.length ? seminar.sections.map(x => `${x.title}${x.page ? ` · PDF ${x.page}쪽` : ''}${x.slide ? ` · 슬라이드 ${x.slide}` : ''}`).join(' / ') : seminar.mode === 'qa' ? '질의응답' : '일치 구간 없음' } : {}) };
}
