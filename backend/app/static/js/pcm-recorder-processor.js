/**
 * PCM Recorder AudioWorklet — captures mic audio as Float32 chunks.
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
  }

  process(inputs) {
    if (inputs.length > 0 && inputs[0].length > 0) {
      const inputChannel = inputs[0][0];
      const inputCopy = new Float32Array(inputChannel);
      this.port.postMessage(inputCopy);
    }
    return true;
  }
}

registerProcessor('pcm-recorder-processor', PCMRecorderProcessor);
