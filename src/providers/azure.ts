import { azureTarget, languageByCode } from '../../shared/languages.mjs';
import { captureMicrophone, monitorLevel, postJson } from '../audio';
import { emptyTranscript, type Session, type SessionOptions } from '../types';
import { pairedCaptionFrames } from '../../shared/caption-flow.mjs';

export async function startAzure(options: SessionOptions): Promise<Session> {
  const sdk = await import('microsoft-cognitiveservices-speech-sdk');
  options.signal.throwIfAborted();
  const stream = await captureMicrophone(options.deviceId, options.signal);
  const stopMeter = monitorLevel(stream, options.onLevel);
  let recognizer: InstanceType<typeof sdk.TranslationRecognizer> | undefined;
  let input: InstanceType<typeof sdk.AudioConfig> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let stopping = false;
  const transcript = emptyTranscript();
  const pairs: { source: string; target: string }[] = [];
  const publish = () => {
    transcript.captions = pairedCaptionFrames(pairs, transcript.interimSource, options.source, options.target);
    options.onTranscript({ ...transcript });
  };
  const seen = new Set<string>();
  let credentials: { token: string; region: string };
  const cleanup = () => {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener('abort', cleanup);
    clearTimeout(refreshTimer);
    recognizer?.close(); input?.close();
    stream.getTracks().forEach(track => track.stop()); stopMeter();
  };
  options.signal.addEventListener('abort', cleanup, { once: true });
  const ended = (message?: string) => {
    if (closed || stopping) return;
    if (message) options.onError(message);
    cleanup(); options.onEnded();
  };
  stream.getAudioTracks()[0].addEventListener('ended', () => ended('마이크 연결이 끊어졌습니다.'));
  try {
    credentials = await postJson('/api/azure/token', {}, options.signal);
    options.signal.throwIfAborted();
    const config = sdk.SpeechTranslationConfig.fromAuthorizationToken(credentials.token, credentials.region);
    config.speechRecognitionLanguage = languageByCode(options.source)!.locale;
    config.addTargetLanguage(azureTarget(options.target));
    input = sdk.AudioConfig.fromStreamInput(stream);
    recognizer = new sdk.TranslationRecognizer(config, input);
    recognizer.recognizing = (_, event) => {
      if (closed) return;
      transcript.interimSource = event.result.text;
      transcript.interimTarget = event.result.translations.get(azureTarget(options.target)) || '';
      publish();
    };
    recognizer.recognized = (_, event) => {
      if (closed) return;
      transcript.interimSource = ''; transcript.interimTarget = '';
      if ((event.result.reason === sdk.ResultReason.TranslatedSpeech || event.result.reason === sdk.ResultReason.RecognizedSpeech) && !seen.has(event.result.resultId)) {
        seen.add(event.result.resultId);
        const translated = event.result.translations.get(azureTarget(options.target)) || '';
        transcript.source += `${transcript.source ? '\n\n' : ''}${event.result.text}`;
        transcript.target += `${transcript.target ? '\n\n' : ''}${translated}`;
        pairs.push({ source: event.result.text, target: translated });
        if (pairs.length > 32) pairs.shift();
      }
      publish();
    };
    recognizer.canceled = () => ended('Azure 음성 연결이 종료되었습니다. 키, 리전 및 네트워크를 확인해 주세요.');
    recognizer.sessionStopped = () => ended();
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Azure 연결 시간이 초과되었습니다.')), 20_000);
      const abort = () => finish(new DOMException('취소됨', 'AbortError'));
      const finish = (error?: Error) => {
        clearTimeout(timeout); options.signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve();
      };
      options.signal.addEventListener('abort', abort, { once: true });
      recognizer!.startContinuousRecognitionAsync(() => finish(), () => finish(new Error('Azure 음성 연결을 시작하지 못했습니다.')));
    });
    if (closed) throw new Error('Azure 연결이 종료되었습니다. 다시 시작해 주세요.');
    const refresh = async () => {
      try {
        credentials = await postJson('/api/azure/token', {}, options.signal);
        if (closed) return;
        recognizer!.authorizationToken = credentials.token;
        refreshTimer = setTimeout(refresh, 8 * 60_000);
      } catch { ended('Azure 연결 토큰을 갱신하지 못했습니다. 통역을 다시 시작해 주세요.'); }
    };
    refreshTimer = setTimeout(refresh, 8 * 60_000);
    return {
      async stop() {
        if (closed) return;
        stopping = true;
        stream.getAudioTracks().forEach(track => { track.enabled = false; });
        await new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, 4000);
          const finish = () => { clearTimeout(timeout); resolve(); };
          recognizer!.stopContinuousRecognitionAsync(finish, finish);
        });
        cleanup();
      },
      setMuted(muted) { stream.getAudioTracks().forEach(track => { track.enabled = !muted; }); },
    };
  } catch (error) { cleanup(); throw error; }
}
