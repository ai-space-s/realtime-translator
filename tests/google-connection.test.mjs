import test from 'node:test';
import assert from 'node:assert/strict';
import { connectGoogleLive } from '../shared/google-connection.mjs';

class FakeSocket {
  readyState = 0; bufferedAmount = 0; sent = []; closed = false;
  open() { this.readyState = 1; this.onopen?.(); }
  send(data) { this.sent.push(JSON.parse(data)); }
  receive(message, binary = false) { const data = JSON.stringify(message); this.onmessage?.({ data: binary ? new TextEncoder().encode(data).buffer : data }); }
  close() { this.closed = true; this.readyState = 3; }
}
function setup(t, extra = {}) {
  const socket = new FakeSocket(), controller = new AbortController();
  const contents = [], failures = [], notices = [], urls = [];
  const promise = connectGoogleLive({ value: 'auth_tokens/test-ephemeral', model: 'gemini-3.5-live-translate-preview', signal: controller.signal,
    onContent: data => contents.push(data), onFailure: message => failures.push(message), onNotice: message => notices.push(message),
    createSocket: url => { urls.push(url); return socket; }, timeoutMs: 50, drainMs: 40, settleMs: 5, ...extra,
  });
  t.after(() => controller.abort());
  return { socket, controller, promise, contents, failures, notices, urls };
}

test('Google connection waits for setupComplete, uses constrained v1beta and sends only PCM audio', async t => {
  const context = setup(t);
  context.socket.open();
  assert.match(context.urls[0], /v1beta.*BidiGenerateContentConstrained\?access_token=auth_tokens%2F/);
  assert.deepEqual(context.socket.sent[0], { setup: { model: 'models/gemini-3.5-live-translate-preview' } });
  context.socket.receive({ setupComplete: {} }, true);
  const connection = await context.promise;
  connection.sendAudio('test-pcm');
  assert.deepEqual(context.socket.sent[1], { realtimeInput: { audio: { data: 'test-pcm', mimeType: 'audio/pcm;rate=16000' } } });
  context.socket.receive({ serverContent: { outputTranscription: { text: 'Hello.' } } }, true);
  assert.equal(context.contents[0].outputTranscription.text, 'Hello.');
  connection.close();
  assert.ok(context.socket.closed);
});

test('Google stop flushes stream end, accepts trailing transcripts and stops sending new audio', async t => {
  const context = setup(t);
  context.socket.open(); context.socket.receive({ setupComplete: {} });
  const connection = await context.promise;
  const stopped = connection.stop();
  connection.sendAudio('must-not-send');
  assert.deepEqual(context.socket.sent.at(-1), { realtimeInput: { audioStreamEnd: true } });
  context.socket.receive({ serverContent: { outputTranscription: { text: 'Last caption.' }, turnComplete: true } });
  context.socket.receive({ serverContent: { inputTranscription: { text: '늦은 원문.' } } });
  await stopped;
  assert.equal(context.contents.length, 2);
  assert.ok(context.socket.closed);
  assert.equal(context.failures.length, 0);
});

test('Google cancels a pending handshake and times out safely if setup never completes', async t => {
  const canceled = setup(t);
  const rejected = assert.rejects(canceled.promise, { name: 'AbortError' });
  canceled.controller.abort();
  await rejected;
  assert.ok(canceled.socket.closed);
  const stalled = setup(t, { timeoutMs: 10 });
  stalled.socket.open();
  await assert.rejects(stalled.promise, /연결 시간이 초과/);
  assert.ok(stalled.socket.closed);
});

test('Google goAway warns, disconnect fails once, and provider close details are never echoed', async t => {
  const context = setup(t);
  context.socket.open(); context.socket.receive({ setupComplete: {} });
  await context.promise;
  context.socket.receive({ goAway: { timeLeft: '30s' } });
  assert.equal(context.notices.length, 1);
  assert.equal(context.failures.length, 0);
  context.socket.onclose({ reason: 'sensitive provider contents' });
  assert.equal(context.failures.length, 1);
  assert.doesNotMatch(context.failures[0], /sensitive provider contents/);
  assert.ok(context.socket.closed);
});

test('Google closes on excessive buffered audio or malformed/error messages without leaking payloads', async t => {
  for (const action of ['backpressure', 'error', 'invalid']) {
    const context = setup(t);
    context.socket.open(); context.socket.receive({ setupComplete: {} });
    const connection = await context.promise;
    if (action === 'backpressure') { context.socket.bufferedAmount = 300000; connection.sendAudio('data'); }
    if (action === 'error') context.socket.receive({ error: { message: 'private provider payload' } });
    if (action === 'invalid') context.socket.onmessage({ data: 'invalid private provider payload' });
    assert.ok(context.socket.closed);
    assert.equal(context.failures.length, 1);
    assert.doesNotMatch(context.failures[0], /private provider payload/);
  }
});

test('Google refuses a permanent key in the browser and stop has a bounded fallback', async t => {
  const invalid = setup(t, { value: 'permanent-key-placeholder' });
  await assert.rejects(invalid.promise, /단기 연결 정보/);
  assert.equal(invalid.urls.length, 0);
  const context = setup(t, { drainMs: 10 });
  context.socket.open(); context.socket.receive({ setupComplete: {} });
  const connection = await context.promise;
  await connection.stop();
  assert.ok(context.socket.closed);
});
