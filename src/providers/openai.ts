import { captureMicrophone, monitorLevel, postJson } from '../audio';
import { type Session, type SessionOptions } from '../types';
import { createOpenAITranscript } from '../../shared/openai-transcript.mjs';
import { translationLanguageError } from '../../shared/languages.mjs';

export async function startOpenAI(options: SessionOptions): Promise<Session> {
  const languageError = translationLanguageError('openai', options.source, options.target);
  if (languageError) throw new Error(languageError);
  const { signal } = options;
  const stream = await captureMicrophone(options.deviceId, signal);
  const stopMeter = monitorLevel(stream, options.onLevel);
  const peer = new RTCPeerConnection();
  const audio = new Audio();
  audio.autoplay = true;
  audio.muted = true;
  let closed = false;
  let stopping = false;
  let resolveClosed: (() => void) | undefined;
  let disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  const transcript = createOpenAITranscript(options.source, options.target);
  const seenEvents = new Set<string>();
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    clearTimeout(disconnectTimer);
    stream.getTracks().forEach(track => track.stop());
    stopMeter();
    peer.close();
    audio.pause();
    audio.srcObject = null;
    resolveClosed?.();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    if (!stopping && !closed) { options.onError('마이크 연결이 끊어졌습니다.'); cleanup(); options.onEnded(); }
  });
  peer.addTrack(stream.getAudioTracks()[0], stream);
  peer.ontrack = ({ streams, track }) => {
    audio.srcObject = streams[0] || new MediaStream([track]);
    void audio.play().catch(() => {
      if (!audio.muted && !closed) options.onError('음성 자동 재생이 차단되었습니다. 음성 출력 스위치를 다시 켜 주세요.');
    });
  };
  const events = peer.createDataChannel('oai-events');
  events.onmessage = ({ data }) => {
    if (closed) return;
    let event;
    try { event = JSON.parse(data); } catch { return; }
    if (typeof event.event_id === 'string') {
      if (seenEvents.has(event.event_id)) return;
      seenEvents.add(event.event_id);
      if (seenEvents.size > 4000) seenEvents.delete(seenEvents.values().next().value!);
    }
    if (event.type === 'session.closed') { resolveClosed?.(); if (!stopping) { cleanup(); options.onEnded(); } return; }
    else if (event.type === 'error') {
      options.onError('OpenAI 통역 중 오류가 발생했습니다. 서비스 한도와 선택한 언어를 확인한 뒤 다시 시작해 주세요.');
      cleanup(); options.onEnded(); return;
    }
    const value = transcript.apply(event);
    if (value) options.onTranscript(value);
  };
  events.onclose = () => { if (!closed && !stopping) { options.onError('통역 연결이 종료되었습니다. 다시 시작해 주세요.'); cleanup(); options.onEnded(); } };
  try {
    const { value } = await postJson('/api/openai/session', { targetLanguage: options.target }, signal);
    signal.throwIfAborted();
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch('https://api.openai.com/v1/realtime/translations/calls', {
      method: 'POST', headers: { Authorization: `Bearer ${value}`, 'Content-Type': 'application/sdp' },
      body: offer.sdp, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok) throw new Error(`OpenAI 음성 연결 실패 (${response.status}). 서비스 접근 권한을 확인해 주세요.`);
    await peer.setRemoteDescription({ type: 'answer', sdp: await response.text() });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('음성 연결 시간이 초과되었습니다. 네트워크를 확인해 주세요.')), 20_000);
      const abort = () => finish(new DOMException('취소됨', 'AbortError'));
      const change = () => {
        if (peer.connectionState === 'connected' && events.readyState === 'open') finish();
        if (['failed', 'closed'].includes(peer.connectionState)) finish(new Error('음성 연결에 실패했습니다.'));
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        peer.removeEventListener('connectionstatechange', change); events.removeEventListener('open', change);
        error ? reject(error) : resolve();
      };
      signal.addEventListener('abort', abort, { once: true });
      peer.addEventListener('connectionstatechange', change); events.addEventListener('open', change);
      if (signal.aborted) abort(); else change();
    });
    peer.onconnectionstatechange = () => {
      clearTimeout(disconnectTimer);
      const lost = () => { if (!closed && !stopping) { options.onError('음성 연결이 끊어졌습니다. 다시 시작해 주세요.'); cleanup(); options.onEnded(); } };
      if (peer.connectionState === 'failed') lost();
      if (peer.connectionState === 'disconnected') disconnectTimer = setTimeout(lost, 5000);
    };
    return {
      async stop() {
        if (closed) return;
        stopping = true;
        stream.getAudioTracks().forEach(track => { track.enabled = false; });
        // Give the translation session time to emit pending final output before releasing WebRTC.
        if (events.readyState === 'open') await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 5000);
          resolveClosed = () => { clearTimeout(timeout); resolve(); };
          try { events.send(JSON.stringify({ type: 'session.close' })); } catch { resolveClosed(); }
        });
        cleanup();
      },
      setMuted(muted) { stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); },
    };
  } catch (error) { cleanup(); throw error; }
}
