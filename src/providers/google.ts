import { captureMicrophone, monitorLevel, postJson } from '../audio';
import { createGoogleTranscript } from '../../shared/google-transcript.mjs';
import { connectGoogleLive } from '../../shared/google-connection.mjs';
import type { Session, SessionOptions } from '../types';

export async function startGoogle(options: SessionOptions): Promise<Session> {
  const { signal } = options;
  signal.throwIfAborted();
  const stream = await captureMicrophone(options.deviceId, signal);
  const stopMeter = monitorLevel(stream, options.onLevel);
  const transcript = createGoogleTranscript(options.source, options.target);
  let context: AudioContext | undefined;
  let input: MediaStreamAudioSourceNode | undefined;
  let processor: AudioWorkletNode | undefined;
  let connection: Awaited<ReturnType<typeof connectGoogleLive>> | undefined;
  let closed = false, stopping = false, muted = false;
  let resolveFlush: (() => void) | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let contextResumeTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', cleanup);
    clearTimeout(flushTimer); clearTimeout(contextResumeTimer); resolveFlush?.();
    connection?.close();
    if (processor) { processor.onprocessorerror = null; processor.port.onmessage = null; processor.port.close(); processor.disconnect(); }
    input?.disconnect();
    stream.getTracks().forEach(track => track.stop());
    void context?.close().catch(() => {});
    stopMeter();
  };
  const ended = (message: string) => {
    if (closed) return;
    options.onError(message); cleanup(); options.onEnded();
  };
  signal.addEventListener('abort', cleanup, { once: true });
  stream.getAudioTracks()[0].addEventListener('ended', () => { if (!stopping) ended('마이크 연결이 끊어졌습니다.'); });
  try {
    context = new AudioContext({ sampleRate: 16000 });
    if (!context.audioWorklet || context.sampleRate !== 16000) throw new Error('Google 통역에는 16 kHz 오디오 입력을 지원하는 최신 Chrome 또는 Edge가 필요합니다.');
    // Resume before any API roundtrip, while the microphone-start gesture is recent.
    await Promise.race([
      context.resume(),
      new Promise<never>((_, reject) => { contextResumeTimer = setTimeout(() => reject(new Error('오디오 입력을 시작하지 못했습니다. 화면에서 통역 시작을 다시 눌러 주세요.')), 5000); }),
    ]);
    clearTimeout(contextResumeTimer);
    signal.throwIfAborted();
    await context.audioWorklet.addModule('/google-pcm-worklet.js');
    signal.throwIfAborted();
    processor = new AudioWorkletNode(context, 'between-google-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
    processor.onprocessorerror = () => ended('Google 오디오 입력 처리에 문제가 발생했습니다. 통역을 다시 시작해 주세요.');
    input = context.createMediaStreamSource(stream);
    input.connect(processor); processor.connect(context.destination);
    processor.port.onmessage = ({ data }) => {
      if (closed) return;
      if (data.type === 'flushed') { clearTimeout(flushTimer); resolveFlush?.(); return; }
      if (muted || data.type !== 'audio' || !(data.buffer instanceof ArrayBuffer)) return;
      const bytes = new Uint8Array(data.buffer);
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      connection?.sendAudio(btoa(binary));
    };
    // The mic/AudioWorklet are ready before creating the 60-second start token.
    const token = await postJson('/api/google/session', { targetLanguage: options.target }, signal);
    signal.throwIfAborted();
    connection = await connectGoogleLive({ ...token, signal,
      onContent(content: Parameters<typeof transcript.apply>[0]) {
        if (closed) return;
        const value = transcript.apply(content);
        if (value) options.onTranscript(value);
        // Translated audio is deliberately ignored; this is a subtitle-only app.
      },
      onFailure: ended,
      onNotice: (message: string) => { if (!closed && !stopping) options.onError(message); },
    });
    signal.throwIfAborted();
    if (closed) { connection.close(); throw new Error('Google 연결이 종료되었습니다. 다시 시작해 주세요.'); }
    processor.port.postMessage('resume');
    return {
      async stop() {
        if (closed || stopping) return;
        stopping = true;
        stream.getAudioTracks().forEach(track => { track.enabled = false; });
        await new Promise<void>(resolve => {
          resolveFlush = resolve;
          flushTimer = setTimeout(resolve, 750);
          processor!.port.postMessage('stop');
        });
        try { await connection?.stop(); } finally { cleanup(); }
      },
      setMuted(value) {
        if (closed || stopping) return;
        muted = value;
        processor!.port.postMessage(muted ? 'pause' : 'resume');
        stream.getAudioTracks().forEach(track => { track.enabled = !muted; });
        if (muted) connection?.endAudio();
      },
    };
  } catch (error) { cleanup(); throw error; }
}
