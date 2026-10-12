// Client-side boundaries for transcription models without server VAD.
export function createSpeechBoundary(commit, now = Date.now) {
  let started = 0, lastVoice = 0, voiced = 0, previous = now();
  function reset() { started = 0; lastVoice = 0; voiced = 0; previous = now(); }
  function flush() {
    const shouldCommit = voiced >= 150;
    reset();
    if (shouldCommit) commit();
  }
  return {
    sample(rms) {
      const time = now(), elapsed = Math.min(100, Math.max(0, time - previous)); previous = time;
      if (rms >= 0.015) { if (!started) started = time; lastVoice = time; voiced += elapsed; }
      if (started && (time - lastVoice >= 750 || time - started >= 12000)) flush();
    }, flush, reset,
  };
}
