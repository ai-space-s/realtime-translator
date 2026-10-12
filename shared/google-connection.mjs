const endpoint = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
const connectionError = () => new Error('Google 음성 연결에 실패했습니다. Gemini API 키의 권한·사용 한도와 네트워크를 확인해 주세요.');

/** Browser WebSocket lifecycle, injectable for network-free regression tests. */
export function connectGoogleLive({ value, model, signal, onContent, onFailure, onNotice,
  createSocket = url => new WebSocket(url), timeoutMs = 20_000, drainMs = 5000, settleMs = 500 }) {
  if (!value?.startsWith('auth_tokens/') || !/^gemini-[a-z0-9.-]+-live-translate(?:-[a-z0-9.-]+)?$/.test(model)) {
    return Promise.reject(new Error('Google 단기 연결 정보가 올바르지 않습니다. 서버 설정을 다시 확인해 주세요.'));
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let socket;
    let ready = false, closed = false, stopping = false;
    let setupTimer, drainTimer, settleTimer;
    let finishDrain;
    let stopPromise;
    let completionSeen = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(setupTimer); clearTimeout(drainTimer); clearTimeout(settleTimer);
      signal.removeEventListener('abort', abort);
      if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; socket.close(); }
      finishDrain?.();
    };
    const fail = error => {
      if (closed) return;
      const connected = ready;
      close();
      if (!connected) reject(error);
      else onFailure(error.message);
    };
    const abort = () => {
      const pendingSetup = !ready;
      close();
      if (pendingSetup) reject(new DOMException('취소됨', 'AbortError'));
    };
    const send = message => {
      if (closed || socket.readyState !== 1) return false;
      if (socket.bufferedAmount > 256 * 1024) {
        fail(new Error('Google으로 보내는 음성이 지연되고 있습니다. 네트워크를 확인한 뒤 다시 시작해 주세요.'));
        return false;
      }
      try { socket.send(JSON.stringify(message)); return true; }
      catch { fail(connectionError()); return false; }
    };
    const settle = () => {
      if (!stopping || !completionSeen) return;
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => finishDrain?.(), settleMs);
    };
    const connection = {
      sendAudio(data) {
        if (!ready || stopping || closed) return;
        send({ realtimeInput: { audio: { data, mimeType: 'audio/pcm;rate=16000' } } });
      },
      endAudio() { if (ready && !closed) send({ realtimeInput: { audioStreamEnd: true } }); },
      stop() {
        if (stopPromise) return stopPromise;
        if (closed) return Promise.resolve();
        stopping = true;
        stopPromise = new Promise(done => {
          finishDrain = done;
          drainTimer = setTimeout(done, drainMs);
          connection.endAudio();
        }).then(close);
        return stopPromise;
      },
      close,
    };
    try {
      // Only the ephemeral token is present here; the long-lived key never leaves
      // the server. Never log this URL, incoming frames or close/error payloads.
      socket = createSocket(`${endpoint}?access_token=${encodeURIComponent(value)}`);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => send({ setup: { model: `models/${model}` } });
      socket.onerror = () => fail(connectionError());
      socket.onclose = () => {
        if (stopping) close();
        else fail(new Error('Google 통역 연결이 종료되었습니다. 연결 시간 제한·사용 한도를 확인하고 통역을 다시 시작해 주세요.'));
      };
      socket.onmessage = ({ data }) => {
        if (closed) return;
        let message;
        try { message = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
        catch { fail(new Error('Google 음성 응답을 읽지 못했습니다. 통역을 다시 시작해 주세요.')); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return;
        if (message.error) { fail(connectionError()); return; }
        if (message.setupComplete && !ready) {
          ready = true; clearTimeout(setupTimer); resolve(connection);
        }
        if (message.goAway && !stopping) onNotice('Google의 연결 시간 제한으로 곧 세션이 종료됩니다. 종료 후 통역을 다시 시작해 주세요.');
        if (message.serverContent && ready) {
          onContent(message.serverContent);
          if (stopping && (message.serverContent.turnComplete || message.serverContent.waitingForInput)) completionSeen = true;
          settle();
        }
      };
      setupTimer = setTimeout(() => fail(new Error('Google 음성 연결 시간이 초과되었습니다. 네트워크를 확인해 주세요.')), timeoutMs);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    } catch { fail(connectionError()); }
  });
}
