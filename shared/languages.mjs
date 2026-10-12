export const languages = [
  { code: 'ko', locale: 'ko-KR', name: '한국어', native: 'Korean', voice: 'ko-KR-SunHiNeural' },
  { code: 'en', locale: 'en-US', name: '영어', native: 'English', voice: 'en-US-JennyNeural' },
  { code: 'ja', locale: 'ja-JP', name: '일본어', native: 'Japanese', voice: 'ja-JP-NanamiNeural' },
  { code: 'zh', locale: 'zh-CN', name: '중국어', native: 'Chinese', voice: 'zh-CN-XiaoxiaoNeural' },
  { code: 'es', locale: 'es-ES', name: '스페인어', native: 'Spanish', voice: 'es-ES-ElviraNeural' },
  { code: 'fr', locale: 'fr-FR', name: '프랑스어', native: 'French', voice: 'fr-FR-DeniseNeural' },
  { code: 'de', locale: 'de-DE', name: '독일어', native: 'German', voice: 'de-DE-KatjaNeural' },
  { code: 'vi', locale: 'vi-VN', name: '베트남어', native: 'Vietnamese', voice: 'vi-VN-HoaiMyNeural' },
  { code: 'lo', locale: 'lo-LA', name: '라오어 (라오스)', native: 'Lao', voice: '' },
  { code: 'id', locale: 'id-ID', name: '인도네시아어', native: 'Indonesian', voice: '' },
];
export const languageByCode = (code) => languages.find((language) => language.code === code);
export const azureTarget = (code) => code === 'zh' ? 'zh-Hans' : code;

// Lao is enabled for the documented Azure/Google speech translation paths.
// OpenAI's direct translation model has no Lao output; its separate sermon
// pipeline is not enabled for Lao in this release. Never switch paid providers
// or interpretation modes implicitly when the language selection changes.
export function translationLanguageError(provider, source, target) {
  if (!languageByCode(source) || !languageByCode(target)) return '지원하지 않는 원어 또는 번역어입니다.';
  if (provider === 'openai' && (source === 'lo' || target === 'lo')) return '현재 이 앱의 라오어 통역은 Microsoft 또는 Google에서 사용할 수 있습니다. 통역 서비스를 변경해 주세요. OpenAI 전용 원고·사전 참고 기능은 적용되지 않습니다.';
  return '';
}
