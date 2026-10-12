import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as contextModule from '../shared/sermon-context.mjs';
import * as flowModule from '../shared/sermon-flow.mjs';
import * as languageModule from '../shared/languages.mjs';
import * as seminarModule from '../shared/seminar-context.mjs';

// Compile only this TS transport in memory. All browser/audio/network surfaces
// below are fakes: tests must never acquire a real mic or send a paid request.
const compiled = ts.transpileModule(readFileSync(new URL('../src/providers/sermon.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function harness() {
  const controller = new AbortController();
  const calls = [], updates = [], errors = [];
  const track = new EventTarget(); track.enabled = true; track.stopped = false; track.stop = () => { track.stopped = true; };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  let peer, ended = 0, meterStopped = false, boundaryCommit, boundaryStopped = false;
  class FakePeer extends EventTarget {
    constructor() { super(); peer = this; this.connectionState = 'new'; this.channel = new EventTarget(); this.channel.readyState = 'connecting'; this.channel.sent = []; this.channel.send = text => this.channel.sent.push(JSON.parse(text)); }
    createDataChannel() { return this.channel; }
    addTrack() {}
    async createOffer() { return { sdp: 'local-test-sdp' }; }
    async setLocalDescription() {}
    async setRemoteDescription() { this.connectionState = 'connected'; this.channel.readyState = 'open'; }
    close() { this.connectionState = 'closed'; this.channel.readyState = 'closed'; }
    event(event) { this.channel.onmessage({ data: JSON.stringify(event) }); }
  }
  const exports = {};
  vm.runInNewContext(compiled, { exports, require(name) {
    if (name === '../audio') return { captureMicrophone: async () => stream, monitorLevel: () => () => { meterStopped = true; }, monitorSpeechBoundaries: async (_stream, commit) => { boundaryCommit = commit; return { flush() {}, stop() { boundaryStopped = true; }, setMuted() {} }; } };
    if (name.endsWith('sermon-context.mjs')) return contextModule;
    if (name.endsWith('sermon-flow.mjs')) return flowModule;
    if (name.endsWith('languages.mjs')) return languageModule;
    if (name.endsWith('seminar-context.mjs')) return seminarModule;
    throw new Error(`Unexpected test dependency: ${name}`);
  }, RTCPeerConnection: FakePeer, structuredClone, AbortController, AbortSignal, DOMException, Date, setTimeout, clearTimeout, setInterval, clearInterval,
  fetch: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/sermon/session') return Response.json({ value: 'ephemeral-test-token' });
    if (url === 'https://api.openai.com/v1/realtime/calls') return new Response('remote-test-sdp');
    if (url === '/api/sermon/translate' || url === '/api/seminar/translate') return Response.json({ translation: 'An improvised comment.', needsReview: false, reviewReason: '', referenceCount: 0 });
    throw new Error('Unexpected network request');
  } });
  const options = { source: 'ko', target: 'en', deviceId: '', signal: controller.signal, sermon: contextModule.emptySermonSettings(),
    onTranscript: value => updates.push(value), onError: message => errors.push(message), onLevel() {}, onEnded() { ended++; } };
  return { start: () => exports.startSermon(options), options, controller, calls, updates, errors, get peer() { return peer; }, track,
    get ended() { return ended; }, get meterStopped() { return meterStopped; }, commit: () => boundaryCommit(), get boundaryStopped() { return boundaryStopped; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('sermon WebRTC transport uses transcription-only call and scoped reference translation, then releases devices', async () => {
  const h = harness();
  h.options.sermon.manuscript = '이사야의 물과 불에 관한 설교 원고입니다.';
  const session = await h.start();
  assert.equal(h.calls[0].url, '/api/sermon/session');
  assert.equal(h.calls[1].options.headers.Authorization, 'Bearer ephemeral-test-token');
  assert.equal(h.calls[1].url, 'https://api.openai.com/v1/realtime/calls');
  h.peer.event({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null });
  h.peer.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: '식당에서 점심을 먹겠습니다.' });
  await settle();
  const translation = h.calls.find(x => x.url === '/api/sermon/translate');
  const body = JSON.parse(translation.options.body);
  assert.equal(body.utterance, '식당에서 점심을 먹겠습니다.'); assert.deepEqual(body.reference.excerpts, []);
  assert.equal(h.updates.at(-1).target, 'An improvised comment.');
  session.setMuted(true); assert.equal(h.track.enabled, false); session.setMuted(false); assert.equal(h.track.enabled, true);
  const stopped = session.stop(); assert.equal(session.stop(), stopped); await stopped;
  assert.equal(h.track.stopped, true); assert.equal(h.meterStopped, true); assert.equal(h.peer.connectionState, 'closed');
  assert.equal(h.boundaryStopped, true);
});

test('seminar transport snapshots prepared data, accepts live navigation and Q&A, and commits from client VAD', async () => {
  const h = harness();
  h.options.seminar = { ...seminarModule.emptySeminarSettings(), sections: seminarModule.sectionsFromPages([
    { page: 1, text: '첫 번째 원고입니다.' }, { page: 2, text: '두 번째 원고입니다.' },
  ]) };
  let control = { index: 0, mode: 'manual' };
  const positions = [];
  h.options.getSeminarControl = () => control; h.options.onSeminarPosition = index => positions.push(index);
  await h.start(); h.options.seminar.sections[0].source = '진행 중 몰래 변경';
  h.commit(); assert.equal(h.peer.channel.sent[0].type, 'input_audio_buffer.commit');
  for (const [index, mode] of [[0, 'manual'], [1, 'manual'], [1, 'qa']]) {
    control = { index, mode }; const id = `turn-${positions.length}`;
    h.peer.event({ type: 'input_audio_buffer.committed', item_id: id, previous_item_id: positions.length ? `turn-${positions.length - 1}` : null });
    h.peer.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript: '실제로 말한 문장입니다.' });
    await settle();
  }
  const bodies = h.calls.filter(x => x.url === '/api/seminar/translate').map(x => JSON.parse(x.options.body));
  assert.equal(bodies.length, 3); assert.equal(bodies[0].seminar.sections[0].source, '첫 번째 원고입니다.');
  assert.equal(bodies[1].seminar.sections[0].page, 2); assert.deepEqual(bodies[2].seminar.sections, []);
  assert.ok(bodies.every(x => x.utterance === '실제로 말한 문장입니다.'));
  h.controller.abort(); assert.equal(h.boundaryStopped, true); assert.equal(h.track.stopped, true);
});

test('abort releases microphone and ignores late events; raw provider error is never exposed', async () => {
  const h = harness(); await h.start();
  h.peer.event({ type: 'error', error: { message: 'server-secret must not appear', code: 'test_error' } });
  assert.equal(h.ended, 1); assert.equal(h.track.stopped, true); assert.doesNotMatch(h.errors.join(''), /server-secret/);
  const before = h.updates.length;
  h.peer.event({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'late', transcript: 'late speech' });
  assert.equal(h.updates.length, before);
  const aborted = harness(); await aborted.start(); aborted.controller.abort();
  assert.equal(aborted.track.stopped, true); assert.equal(aborted.meterStopped, true);
});
