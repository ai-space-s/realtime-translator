import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { languageByCode, translationLanguageError } from '../shared/languages.mjs';
import { googleApiKey, issueGoogleToken } from './google.mjs';
import { createSermonToken, translateSermon } from './sermon.mjs';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req, maxBytes = 4096) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'JSON 요청이 필요합니다.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw fail(413, '요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw fail(400, '요청 형식이 올바르지 않습니다.'); }
}

export function createHandler({ env = process.env, getProviderEnv = () => env, fetchImpl = fetch, googleTokenImpl = issueGoogleToken, frontend, dist = resolve('dist') } = {}) {
  const limits = new Map();
  const allowedOrigins = new Set(env.APP_ORIGIN ? [env.APP_ORIGIN] : [
    `http://localhost:${env.PORT || 5173}`, `http://127.0.0.1:${env.PORT || 5173}`,
  ]);
  return async function handler(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'microphone=(self)');
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const serviceEnv = path.startsWith('/api/') ? getProviderEnv() : {};
      const configured = {
        openai: Boolean(serviceEnv.OPENAI_API_KEY?.trim()),
        azure: Boolean(serviceEnv.AZURE_SPEECH_KEY?.trim() && /^[a-z0-9]+$/.test(serviceEnv.AZURE_SPEECH_REGION || '')),
        google: Boolean(googleApiKey(serviceEnv)),
      };
      if (path === '/api/config' && req.method === 'GET') {
        return json(res, 200, { providers: configured });
      }
      if (['/api/sermon/status', '/api/seminar/status'].includes(path) && req.method === 'GET') {
        return json(res, 200, { available: true });
      }
      if (path.startsWith('/api/')) {
        const sermon = ['/api/sermon/session', '/api/sermon/translate', '/api/seminar/translate'].includes(path);
        const translation = path.endsWith('/translate');
        if (!['/api/openai/session', '/api/azure/token', '/api/google/session'].includes(path) && !sermon) return json(res, 404, { error: 'API를 찾을 수 없습니다.' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST 요청이 필요합니다.' });
        if (!allowedOrigins.has(req.headers.origin) || req.headers['x-between-client'] !== '1') {
          throw fail(403, '이 주소에서는 연결할 수 없습니다. APP_ORIGIN 설정을 확인해 주세요.');
        }
        const now = Date.now();
        for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
        const ip = `${req.socket.remoteAddress || 'local'}:${translation ? 'translation' : 'connection'}`;
        const bucket = limits.get(ip) || { until: now + 60_000, count: 0 };
        limits.set(ip, bucket);
        if (++bucket.count > (translation ? 120 : 20)) throw fail(429, '요청이 많습니다. 잠시 후 다시 시도해 주세요.');
        const body = await readJson(req, sermon ? 160000 : 4096);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '요청 형식이 올바르지 않습니다.');
        if (sermon) {
          if (!configured.openai) throw fail(503, '정확도 모드에는 서버의 OpenAI API 키가 필요합니다.');
          const controller = new AbortController();
          const abort = () => { if (!res.writableEnded) controller.abort(); };
          res.on('close', abort);
          try {
            const result = await (path.endsWith('/session') ? createSermonToken : translateSermon)(body, { env: serviceEnv, fetchImpl, signal: controller.signal, seminar: path === '/api/seminar/translate' });
            if (!res.destroyed) return json(res, 200, result);
            return;
          } finally { res.off('close', abort); }
        }
        if (path === '/api/google/session') {
          if (!configured.google) throw fail(503, 'Google Gemini API 키를 서버의 .env 파일에 설정해 주세요.');
          if (!languageByCode(body.targetLanguage)) throw fail(400, '지원하지 않는 번역 언어입니다.');
          return json(res, 200, await googleTokenImpl({ env: serviceEnv, targetLanguage: body.targetLanguage }));
        }
        const isOpenAI = path === '/api/openai/session';
        if (!configured[isOpenAI ? 'openai' : 'azure']) throw fail(503, isOpenAI
          ? 'OpenAI API 키를 서버의 .env 파일에 설정해 주세요.'
          : 'Azure Speech 키와 리전을 서버의 .env 파일에 설정해 주세요.');
        if (isOpenAI && !languageByCode(body.targetLanguage)) throw fail(400, '지원하지 않는 번역 언어입니다.');
        if (isOpenAI && body.targetLanguage === 'lo') throw fail(400, translationLanguageError('openai', 'ko', 'lo'));

        const upstream = await fetchImpl(isOpenAI
          ? 'https://api.openai.com/v1/realtime/translations/client_secrets'
          : `https://${serviceEnv.AZURE_SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`, {
          method: 'POST',
          signal: AbortSignal.timeout(15_000),
          headers: isOpenAI ? {
            Authorization: `Bearer ${serviceEnv.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          } : {
            'Ocp-Apim-Subscription-Key': serviceEnv.AZURE_SPEECH_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: isOpenAI ? JSON.stringify({ session: {
            model: serviceEnv.OPENAI_TRANSLATION_MODEL || 'gpt-realtime-translate',
            audio: { input: { transcription: { model: 'gpt-realtime-whisper' } }, output: { language: body.targetLanguage } },
          } }) : '',
        });
        if (!upstream.ok) {
          // Do not forward provider responses: they may contain credentials or internal details.
          const provider = isOpenAI ? 'OpenAI' : 'Azure';
          const detail = upstream.status === 429 ? '사용 한도 또는 잔액을 확인해 주세요.'
            : isOpenAI ? '.env의 OPENAI_API_KEY와 서비스 접근 권한을 확인해 주세요.' : '키, 리전 및 서비스 접근 권한을 확인해 주세요.';
          throw fail(502, `${provider} 연결 실패 (${upstream.status}). ${detail}`);
        }
        if (isOpenAI) {
          const data = await upstream.json();
          if (typeof data.value !== 'string' || !data.value) throw fail(502, 'OpenAI가 유효한 연결 토큰을 반환하지 않았습니다.');
          return json(res, 200, { value: data.value, expires_at: data.expires_at });
        }
        const token = await upstream.text();
        if (!token.trim()) throw fail(502, 'Azure가 유효한 연결 토큰을 반환하지 않았습니다.');
        return json(res, 200, { token, region: serviceEnv.AZURE_SPEECH_REGION });
      }
      if (frontend) return frontend(req, res, () => json(res, 404, { error: '페이지를 찾을 수 없습니다.' }));
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '지원하지 않는 요청입니다.' });
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { throw fail(400, '잘못된 주소입니다.'); }
      const file = resolve(dist, `.${decoded === '/' ? '/index.html' : decoded}`);
      if (!file.startsWith(resolve(dist) + sep)) throw fail(403, '접근할 수 없습니다.');
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) return json(res, 404, { error: '페이지를 찾을 수 없습니다. 먼저 npm run build를 실행해 주세요.' });
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': `${mime[extname(file)] || 'application/octet-stream'}; charset=utf-8` });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      const status = error.status || (error.name === 'TimeoutError' ? 504 : 500);
      json(res, status, { error: error.status ? error.message : status === 504 ? '서비스 연결 시간이 초과되었습니다. 다시 시도해 주세요.' : '서버 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };
}
