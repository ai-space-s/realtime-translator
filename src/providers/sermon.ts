import { captureMicrophone, monitorLevel, monitorSpeechBoundaries } from '../audio';
import type { Session, SessionOptions } from '../types';
import { createSermonFlow } from '../../shared/sermon-flow.mjs';
import { referenceFor, validateReference, transcriptionHints } from '../../shared/sermon-context.mjs';
import { translationLanguageError } from '../../shared/languages.mjs';
import { validateSeminar, selectSeminarContext } from '../../shared/seminar-context.mjs';

export async function startSermon(options: SessionOptions): Promise<Session> {
  const languageError = translationLanguageError('openai', options.source, options.target);
  if (languageError) throw new Error(languageError);
  if (!options.sermon) throw new Error('설교 참고 자료 설정이 필요합니다.');
  // Snapshot settings at start; edits cannot silently change a running session.
  const settings = structuredClone(options.sermon);
  const seminar = options.seminar ? validateSeminar(structuredClone(options.seminar), options.source, options.target) : null;
  const reference = validateReference(referenceFor(settings), options.source, options.target);
  transcriptionHints(reference);
  const stream = await captureMicrophone(options.deviceId, options.signal);
  const stopMeter = monitorLevel(stream, options.onLevel);
  const peer = new RTCPeerConnection();
  const events = peer.createDataChannel('oai-events');
  const requests = new AbortController();
  let closed = false, stopping = false, speechActive = false;
  let disconnected: ReturnType<typeof setTimeout> | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  let stopPromise: Promise<void> | undefined;
  let speech: Awaited<ReturnType<typeof monitorSpeechBoundaries>> | undefined;
  async function post(path: string, body: object) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Between-Client': '1' },
      body: JSON.stringify(body), signal: AbortSignal.any([options.signal, requests.signal, AbortSignal.timeout(35000)]) });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '정확도 모드 요청에 실패했습니다.');
    return value;
  }
  const flow = createSermonFlow({ source: options.source, target: options.target, onTranscript: options.onTranscript, onError: options.onError,
    translate: (utterance: string, recent: string[]) => {
      const control = options.getSeminarControl?.() || { index: 0, mode: 'auto' };
      const context = seminar ? selectSeminarContext(seminar.sections, utterance, control.index, control.mode) : null;
      if (context) options.onSeminarPosition?.(context.index, context.note);
      return post(seminar ? '/api/seminar/translate' : '/api/sermon/translate', { sourceLanguage: options.source, targetLanguage: options.target,
        utterance, recent, reference: referenceFor(settings, utterance),
        ...(context ? { seminar: { mode: control.mode, sections: context.sections } } : {}) });
    },
  });
  const cleanup = () => {
    if (closed) return;
    closed = true; speech?.stop(); flow.close(); requests.abort();
    clearTimeout(disconnected); clearInterval(tick);
    options.signal.removeEventListener('abort', cleanup);
    stream.getTracks().forEach(track => track.stop()); stopMeter(); peer.close();
  };
  const lost = (message: string) => {
    if (closed || stopping) return;
    options.onError(message); cleanup(); options.onEnded();
  };
  options.signal.addEventListener('abort', cleanup, { once: true });
  if (options.signal.aborted) { cleanup(); options.signal.throwIfAborted(); }
  stream.getAudioTracks()[0].addEventListener('ended', () => lost('마이크 연결이 끊어졌습니다. 수신된 원문은 기록에서 확인할 수 있습니다.'));
  peer.addTrack(stream.getAudioTracks()[0], stream);
  events.onmessage = ({ data }) => {
    if (closed) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (event.type === 'input_audio_buffer.speech_started') speechActive = true;
    if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'input_audio_buffer.committed') speechActive = false;
    if (event.type === 'error') {
      // A VAD commit can race the final explicit flush; an empty buffer is benign.
      if (event.error?.code === 'input_audio_buffer_commit_empty') return;
      lost('OpenAI 음성 인식 오류입니다. 모델 접근 권한·사용 한도를 확인한 뒤 다시 시작해 주세요.'); return;
    }
    flow.apply(event);
  };
  events.onclose = () => lost('음성 인식 연결이 종료되었습니다. 기록 확인 후 다시 시작해 주세요.');
  try {
    const token = await post('/api/sermon/session', { sourceLanguage: options.source, targetLanguage: options.target, reference });
    options.signal.throwIfAborted();
    const offer = await peer.createOffer(); await peer.setLocalDescription(offer);
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST', headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/sdp' }, body: offer.sdp,
      signal: AbortSignal.any([options.signal, requests.signal, AbortSignal.timeout(20000)]),
    });
    if (!response.ok) throw new Error(`정확도 모드 음성 연결 실패 (${response.status}). gpt-live-transcribe 접근 권한을 확인해 주세요.`);
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('음성 인식 연결 시간이 초과되었습니다.')), 20000);
      const abort = () => finish(new DOMException('취소됨', 'AbortError'));
      const check = () => {
        if (peer.connectionState === 'connected' && events.readyState === 'open') finish();
        else if (['failed', 'closed'].includes(peer.connectionState)) finish(new Error('음성 인식 연결에 실패했습니다.'));
      };
      const finish = (error?: Error) => {
        clearTimeout(timer); options.signal.removeEventListener('abort', abort);
        peer.removeEventListener('connectionstatechange', check); events.removeEventListener('open', check);
        error ? reject(error) : resolve();
      };
      options.signal.addEventListener('abort', abort, { once: true });
      peer.addEventListener('connectionstatechange', check); events.addEventListener('open', check);
      if (options.signal.aborted) abort(); else check();
    });
    speech = await monitorSpeechBoundaries(stream, () => {
      if (!closed && events.readyState === 'open') events.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    });
    if (closed || options.signal.aborted) { speech.stop(); options.signal.throwIfAborted(); throw new Error('음성 인식 연결이 종료되었습니다.'); }
    tick = setInterval(() => flow.tick(), 1000);
    peer.onconnectionstatechange = () => {
      clearTimeout(disconnected);
      if (peer.connectionState === 'failed') lost('음성 인식 연결이 끊어졌습니다.');
      if (peer.connectionState === 'disconnected') disconnected = setTimeout(() => lost('음성 인식 연결이 끊어졌습니다.'), 5000);
    };
    return {
      stop() {
        if (stopPromise) return stopPromise;
        stopPromise = (async () => {
          if (closed) return;
          stopping = true; stream.getAudioTracks().forEach(track => { track.enabled = false; });
          speech?.flush(); speech?.stop();
          if (speechActive && events.readyState === 'open') {
            try { events.send(JSON.stringify({ type: 'input_audio_buffer.commit' })); } catch { /* Preserve unfinished draft on cleanup. */ }
          }
          const started = Date.now();
          // Allow VAD/final ASR delivery, then bounded draining of translations.
          while (!closed && !options.signal.aborted && Date.now() - started < 15000) {
            if (Date.now() - started > 1500 && !flow.hasPending()) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          cleanup();
        })();
        return stopPromise;
      },
      setMuted(muted) { if (!stopping && !closed) { speech?.setMuted(muted); stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); } },
    };
  } catch (error) { cleanup(); throw error; }
}
