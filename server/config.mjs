import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { resolve } from 'node:path';

const providerKeys = ['OPENAI_API_KEY', 'OPENAI_TRANSLATION_MODEL', 'OPENAI_SERMON_TEXT_MODEL', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION', 'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_TRANSLATION_MODEL'];

/** Only reload service credentials; listener address and origin remain startup settings. */
export function loadProviderEnv(baseEnv = process.env, envFile = resolve('.env')) {
  let local = {};
  try { local = parseEnv(readFileSync(envFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('로컬 환경설정 파일을 읽을 수 없습니다.'); }
  const result = { ...baseEnv };
  for (const key of providerKeys) if (Object.hasOwn(local, key)) result[key] = local[key].trim();
  return result;
}
