// Собирает звук с микрофона в куски по 100 мс (1600 сэмплов при 16 кГц) и считает громкость.
class MicChunker extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1600);
    this.n = 0;
    this.sum = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        const v = channel[i];
        this.buf[this.n++] = v;
        this.sum += v * v;
        if (this.n === this.buf.length) {
          const rms = Math.sqrt(this.sum / this.n);
          this.port.postMessage({ samples: this.buf, rms }, [this.buf.buffer]);
          this.buf = new Float32Array(1600);
          this.n = 0;
          this.sum = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('mic-chunker', MicChunker);
