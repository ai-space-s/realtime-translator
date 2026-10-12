import { readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// Mechanical redaction only. Keep actual credentials in the ignored .env file.
const examplePath = new URL('../.env.example', import.meta.url);
const localPath = new URL('../.env', import.meta.url);
const original = readFileSync(examplePath, 'utf8');
const example = parseEnv(original);
const local = parseEnv(readFileSync(localPath, 'utf8'));
const keys = ['OPENAI_API_KEY', 'AZURE_SPEECH_KEY'];
for (const name of keys) {
  if (example[name]?.trim() && example[name] !== local[name]) {
    throw new Error('예시 파일과 .env의 키가 달라 자동 제거를 중단했습니다. 키 값은 출력하지 않습니다.');
  }
}
const redacted = original.replace(/^(OPENAI_API_KEY|AZURE_SPEECH_KEY)=.*$/gm, '$1=');
writeFileSync(examplePath, redacted);
console.log('예시 파일의 키 값을 비웠습니다. .env는 변경하지 않았습니다.');
