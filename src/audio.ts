import { createSpeechBoundary } from '../shared/speech-boundary.mjs';

export async function monitorSpeechBoundaries(stream: MediaStream, commit: () => void) {
  const context = new AudioContext();
  try {
    await context.resume();
    if (context.state !== 'running') throw new Error('음성 구간 감지를 시작하지 못했습니다. 통역을 다시 시작해 주세요.');
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser(); analyser.fftSize = 2048; source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    const boundary = createSpeechBoundary(commit);
    let muted = false;
    const timer = setInterval(() => {
      if (muted) return;
      analyser.getFloatTimeDomainData(samples);
      boundary.sample(Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length));
    }, 50);
    return { flush: boundary.flush, setMuted(value: boolean) { if (value) boundary.flush(); muted = value; boundary.reset(); },
      stop() { clearInterval(timer); source.disconnect(); void context.close().catch(() => {}); } };
  } catch (error) { await context.close().catch(() => {}); throw error; }
}

export async function captureMicrophone(deviceId: string, signal: AbortSignal) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('마이크를 사용하려면 localhost 또는 HTTPS 주소에서 접속해 주세요.');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: true, noiseSuppression: true, autoGainControl: true,
  } });
  if (signal.aborted) { stream.getTracks().forEach(track => track.stop()); signal.throwIfAborted(); }
  return stream;
}

export function monitorLevel(stream: MediaStream, onLevel: (value: number) => void) {
  // Meter failures should not prevent speech recognition.
  let context: AudioContext | undefined;
  let frame = 0;
  try {
    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let last = 0;
    const update = (now: number) => {
      if (now - last > 75) {
        analyser.getByteTimeDomainData(data);
        const rms = Math.sqrt(data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / data.length);
        onLevel(Math.min(1, rms * 5));
        last = now;
      }
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
  } catch { /* Recognition still works without a volume meter. */ }
  return () => { cancelAnimationFrame(frame); void context?.close().catch(() => {}); onLevel(0); };
}

export async function postJson(path: string, body: object, signal?: AbortSignal) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Between-Client': '1' },
    body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '서비스에 연결할 수 없습니다.');
  return data;
}

export function friendlyError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return '마이크 권한이 필요합니다. 주소창의 권한 설정에서 마이크를 허용한 뒤 다시 시작해 주세요.';
    if (error.name === 'NotFoundError') return '연결된 마이크를 찾을 수 없습니다.';
    if (error.name === 'NotReadableError') return '마이크를 사용할 수 없습니다. 다른 앱에서 사용 중인지 확인해 주세요.';
    if (error.name === 'OverconstrainedError') return '선택한 마이크를 찾을 수 없습니다. 기본 마이크로 바꿔 주세요.';
    if (error.name === 'TimeoutError') return '연결 시간이 초과되었습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.';
  }
  return error instanceof Error ? error.message : '연결 중 문제가 발생했습니다. 다시 시도해 주세요.';
}
