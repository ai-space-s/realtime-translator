/* AudioWorklet: 16 kHz mono float input -> 100 ms little-endian PCM16 frames.
 * The output stays silent: microphone audio is never played through speakers. */
class GooglePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new ArrayBuffer(3200);
    this.view = new DataView(this.frame);
    this.used = 0;
    this.paused = true;
    this.port.onmessage = ({ data }) => {
      if (data === 'resume') { this.used = 0; this.paused = false; }
      if (data === 'pause') { this.paused = true; this.used = 0; }
      if (data === 'stop') {
        this.paused = true;
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  flush() {
    if (!this.used) return;
    const audio = this.frame.slice(0, this.used * 2);
    this.port.postMessage({ type: 'audio', buffer: audio }, [audio]);
    this.used = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!this.paused && channel) for (const value of channel) {
      const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
      this.view.setInt16(this.used++ * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
      if (this.used === 1600) this.flush();
    }
    return true;
  }
}
registerProcessor('between-google-pcm', GooglePcmProcessor);
