import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as context from '../shared/sermon-context.mjs';
import * as languages from '../shared/languages.mjs';

// Exercise the component's actual handlers with in-memory hooks/storage/files.
// No browser profile, microphone, network, or API credentials are used.
const compiled = ts.transpileModule(readFileSync(new URL('../src/SermonPanel.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const storageKey = 'between.speaker-profiles.v1';
const profile = { ...context.emptySpeakerProfile(), name: '테스트 설교자', keywords: '언약\n이사야', expressions: '언약 => covenant', notes: '실제 표현을 보존' };
const file = (text = JSON.stringify({ version: 1, profile }), name = 'speaker.json') => new File([text], name, { type: 'application/json' });
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(saved = []) {
  const slots = [], storage = new Map(), writes = [], exports = {};
  if (saved.length) storage.set(storageKey, JSON.stringify({ version: 1, profiles: saved }));
  let cursor = 0, tree, props = { value: { ...context.emptySermonSettings(), manuscript: '보존할 원고' }, source: 'ko', target: 'en', disabled: false };
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ||= { current: initial }; },
  };
  vm.runInNewContext(compiled, { exports, TextDecoder, Error, setTimeout, localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value); writes.push(value); },
  }, require(name) {
    if (name === 'react') return react;
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
    if (name.endsWith('sermon-context.mjs')) return context;
    if (name.endsWith('languages.mjs')) return languages;
    if (name === './manuscript') return { readManuscript: () => assert.fail('Profile import must not read a manuscript') };
    throw new Error(`Unexpected dependency: ${name}`);
  } });
  props.onChange = value => { props.value = value; };
  const render = () => { cursor = 0; tree = exports.SermonPanel(props); };
  function nodes(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(nodes);
    return [node, ...nodes(node.props?.children)];
  }
  const find = predicate => { const match = nodes(tree).find(predicate); assert.ok(match, 'Expected UI element'); return match; };
  const byId = id => find(node => node.props?.id === id);
  const button = label => find(node => node.type === 'button' && node.props.children === label);
  const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'object' && node ? text(node.props?.children) : String(node ?? '');
  render();
  return { props, storage, writes, render, byId, button, find,
    get status() { return text(find(node => node.props?.role === 'status')); },
    async upload(inputFile) {
      const event = { target: { files: inputFile ? [inputFile] : [], value: inputFile?.name || '' } };
      byId('speaker-import').props.onChange(event);
      assert.equal(event.target.value, '', 'Input resets to allow selecting the same file again');
      await settle(); render();
    },
  };
}

test('JSON import is next to the saved dictionary picker and opens the file chooser', () => {
  const h = harness();
  const picker = h.find(node => node.props?.className === 'speaker-picker');
  assert.ok(picker.props.children.some(node => node.props?.id === 'saved-speaker'));
  assert.ok(picker.props.children.includes(h.button('JSON 사전 불러오기')));
  let clicked = 0;
  h.byId('speaker-import').props.ref.current = { click: () => clicked++ };
  h.button('JSON 사전 불러오기').props.onClick();
  assert.equal(clicked, 1);
});

test('import fills all profile fields, preserves manuscript and saves to the list only explicitly', async () => {
  const h = harness();
  await h.upload(file());
  assert.deepEqual(h.props.value.profile, profile);
  assert.equal(h.props.value.manuscript, '보존할 원고');
  assert.equal(h.writes.length, 0);
  assert.match(h.status, /아래 입력란에 적용/);
  h.button('사전 목록에 저장').props.onClick(); h.render();
  assert.equal(h.writes.length, 1);
  assert.deepEqual(JSON.parse(h.storage.get(storageKey)).profiles, [profile]);
  assert.equal(h.byId('saved-speaker').props.value, 'ko:en:테스트 설교자');
  h.button('새 사전').props.onClick(); h.render();
  h.byId('saved-speaker').props.onChange({ target: { value: 'ko:en:테스트 설교자' } }); h.render();
  assert.deepEqual({ ...h.props.value.profile }, profile);
  const reload = harness(JSON.parse(h.storage.get(storageKey)).profiles);
  reload.byId('saved-speaker').props.onChange({ target: { value: 'ko:en:테스트 설교자' } });
  assert.deepEqual({ ...reload.props.value.profile }, profile);
});

test('same-name imports leave the saved dictionary unchanged until explicit save', async () => {
  const original = { ...profile, notes: '기존 사전' };
  const h = harness([original]);
  await h.upload(file());
  assert.deepEqual(JSON.parse(h.storage.get(storageKey)).profiles, [original]);
  h.button('사전 목록에 저장').props.onClick(); h.render();
  assert.deepEqual(JSON.parse(h.storage.get(storageKey)).profiles, [profile]);
});

test('malformed, wrong-version, wrong-language and oversized JSON leave the current profile unchanged', async () => {
  const h = harness();
  await h.upload(file());
  const existing = h.props.value.profile;
  for (const invalid of [file('{'), file('null'), file('[]'), file('{"version":2}'),
    file(JSON.stringify({ version: 1, profile: { ...profile, sourceLanguage: 'invalid' } })),
    file(JSON.stringify({ version: 1, profile: { ...profile, expressions: 'x'.repeat(6001) } })),
    file('x'.repeat(60001)), file('{}', 'speaker.txt'),
    new File([new Uint8Array([0xff, 0xfe])], 'speaker.json')]) {
    await h.upload(invalid);
    assert.equal(h.props.value.profile, existing);
    assert.equal(h.writes.length, 0);
    assert.doesNotMatch(h.status, /TypeError|Cannot read|SyntaxError/);
    assert.match(h.status, /확인|선택|버전|크기|큽니다/);
  }
});

test('UTF-8 BOM and repeat import work; cancel and active-session lock do not change the profile', async () => {
  const h = harness();
  const sameFile = file('\uFEFF' + JSON.stringify({ version: 1, profile }));
  await h.upload(sameFile);
  await h.upload(sameFile);
  assert.deepEqual(h.props.value.profile, profile);
  const existing = h.props.value.profile;
  await h.upload(undefined);
  assert.equal(h.props.value.profile, existing);
  h.props.disabled = true; h.render();
  assert.equal(h.find(node => node.type === 'fieldset').props.disabled, true);
  await h.upload(file(JSON.stringify({ version: 1, profile: { ...profile, name: '다른 설교자' } })));
  assert.equal(h.props.value.profile, existing);
});
