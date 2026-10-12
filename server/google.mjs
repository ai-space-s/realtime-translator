import { GoogleGenAI } from '@google/genai';
import { languageByCode } from '../shared/languages.mjs';

export const googleApiKey = env => env.GOOGLE_API_KEY?.trim() || env.GEMINI_API_KEY?.trim() || '';
const fail = (status, message) => Object.assign(new Error(message), { status });

/** Issue a single-use, constrained Live API token. Never return or log the API key. */
export async function issueGoogleToken({ env, targetLanguage, now = Date.now(), createClient = options => new GoogleGenAI(options) }) {
  if (!languageByCode(targetLanguage)) throw fail(400, '지원하지 않는 번역 언어입니다.');
  const apiKey = googleApiKey(env);
  if (!apiKey) throw fail(503, 'Google Gemini API 키를 서버의 .env 파일에 설정해 주세요.');
  const model = env.GOOGLE_TRANSLATION_MODEL?.trim().replace(/^models\//, '') || 'gemini-3.5-live-translate-preview';
  if (!/^gemini-[a-z0-9.-]+-live-translate(?:-[a-z0-9.-]+)?$/.test(model)) {
    throw fail(503, 'GOOGLE_TRANSLATION_MODEL에 Gemini Live Translate 전용 모델 이름을 입력해 주세요.');
  }
  const expiresAt = new Date(now + 30 * 60_000).toISOString();
  let token;
  try {
    const client = createClient({ apiKey, vertexai: false, httpOptions: { apiVersion: 'v1beta', timeout: 15_000 } });
    token = await client.authTokens.create({ config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime: new Date(now + 60_000).toISOString(),
      abortSignal: AbortSignal.timeout(15_000),
      // All session configuration is locked on the server, including translation
      // language. A client cannot turn this credential into a general chat token.
      liveConnectConstraints: { model, config: {
        responseModalities: ['AUDIO'],
        inputAudioTranscription: {}, outputAudioTranscription: {},
        translationConfig: { targetLanguageCode: targetLanguage === 'zh' ? 'zh-Hans' : targetLanguage, echoTargetLanguage: false },
      } },
    } });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') throw fail(504, 'Google 연결 시간이 초과되었습니다. 다시 시도해 주세요.');
    const status = Number(error.status);
    const detail = status === 429 ? 'API 사용 한도와 결제 설정을 확인해 주세요.'
      : status === 404 ? '실시간 통역 모델의 제공 여부와 접근 권한을 확인해 주세요.'
      : '.env의 GOOGLE_API_KEY, Gemini API 사용 설정 및 모델 접근 권한을 확인해 주세요.';
    // SDK errors can embed provider bodies, headers or URLs. Forward none of them.
    throw fail(502, `Google 연결 실패${Number.isInteger(status) && status >= 400 && status < 600 ? ` (${status})` : ''}. ${detail}`);
  }
  if (typeof token?.name !== 'string' || !token.name.startsWith('auth_tokens/') || token.name.length <= 12) {
    throw fail(502, 'Google이 유효한 단기 연결 토큰을 반환하지 않았습니다.');
  }
  return { value: token.name, model, expiresAt };
}
