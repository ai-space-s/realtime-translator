import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function processor() {
  let Processor;
  const messages = [];
  vm.runInNewContext(readFileSync(new URL('../public/google-pcm-worklet.js', import.meta.url), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor(name, type) { assert.equal(name, 'between-google-pcm'); Processor = type; },
  });
  return { processor: new Processor(), messages };
}

test('worklet sends exactly 100 ms PCM16 little-endian frames, clamps safely and starts paused', () => {
  const { processor: capture, messages } = processor();
  capture.process([[new Float32Array(1600).fill(1)]]);
  assert.equal(messages.length, 0);
  capture.port.onmessage({ data: 'resume' });
  const data = new Float32Array(1600);
  data.set([-2, -1, 0, 1, 2, NaN]);
  capture.process([[data.subarray(0, 128)]]);
  capture.process([[data.subarray(128)]]);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].buffer.byteLength, 3200);
  const view = new DataView(messages[0].buffer);
  assert.deepEqual(Array.from({ length: 6 }, (_, i) => view.getInt16(i * 2, true)), [-32768, -32768, 0, 32767, 32767, 0]);
});

test('worklet discards muted samples, resumes cleanly and flushes the last partial frame on stop', () => {
  const { processor: capture, messages } = processor();
  capture.port.onmessage({ data: 'resume' });
  capture.process([[new Float32Array(100).fill(-1)]]);
  capture.port.onmessage({ data: 'pause' });
  capture.process([[new Float32Array(1600).fill(-1)]]);
  capture.port.onmessage({ data: 'resume' });
  capture.process([[new Float32Array(40).fill(1)]]);
  capture.port.onmessage({ data: 'stop' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].buffer.byteLength, 80);
  assert.equal(new DataView(messages[0].buffer).getInt16(0, true), 32767);
  assert.equal(messages[1].type, 'flushed');
  capture.process([[new Float32Array(1600)]]);
  assert.equal(messages.length, 2);
});
