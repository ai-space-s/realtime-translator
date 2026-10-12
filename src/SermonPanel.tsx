import { useRef, useState } from 'react';
import { languages } from '../shared/languages.mjs';
import { emptySpeakerProfile, validateProfile, sermonLimits } from '../shared/sermon-context.mjs';
import type { SermonSettings } from './types';
import { readManuscript } from './manuscript';

const storageKey = 'between.speaker-profiles.v1';
type Profile = SermonSettings['profile'];
const profileKey = (profile: Profile) => `${profile.sourceLanguage}:${profile.targetLanguage}:${profile.name}`;
function readProfiles(): Profile[] {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw || raw.length > 300000) return [];
    const value = JSON.parse(raw);
    if (value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 20) return [];
    return value.profiles.map(validateProfile);
  } catch { return []; }
}
function downloadProfile(profile: Profile) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, profile }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = 'between-speaker-profile.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SermonPanel({ value, onChange, disabled, source, target, onBusy }: {
  value: SermonSettings; onChange: (value: SermonSettings) => void; disabled: boolean; source: string; target: string; onBusy?: (value: boolean) => void;
}) {
  const [profiles, setProfiles] = useState<Profile[]>(readProfiles);
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [importedFile, setImportedFile] = useState('');
  const profileInput = useRef<HTMLInputElement>(null);
  const locked = disabled || loading;
  const setProfile = (patch: Partial<Profile>) => onChange({ ...value, profile: { ...value.profile, ...patch } });
  function persist(next: Profile[]) {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, profiles: next })); setProfiles(next);
  }
  function save() {
    try {
      const profile = validateProfile(value.profile);
      if (!profile.name) throw new Error('설교자 이름을 입력해 주세요.');
      const key = profileKey(profile);
      const next = profiles.filter(x => profileKey(x) !== key);
      if (next.length >= 20) throw new Error('최대 20개 사전을 저장할 수 있습니다. 사용하지 않는 사전을 삭제해 주세요.');
      persist([...next, profile]); setSelected(key); setImportedFile(''); setMessage('이 브라우저의 사전 목록에 저장했습니다. 다음에는 ‘저장된 사전’에서 선택할 수 있습니다. 원고는 저장하지 않습니다.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '브라우저 저장이 차단되었습니다. 사전 파일로 내려받아 주세요.'); }
  }
  async function loadFile(file: File | undefined, kind: 'manuscript' | 'profile') {
    if (!file || locked) return;
    setLoading(true); onBusy?.(true); setMessage('');
    try {
      if (kind === 'manuscript') {
        const result = await readManuscript(file);
        const text = result.sections.map(x => x.source).join('\n\n');
        if (text.length > sermonLimits.manuscript) throw new Error('원고는 최대 80,000자까지 등록할 수 있습니다.');
        onChange({ ...value, manuscript: text, manuscriptName: file.name });
        setMessage(`원고를 이 탭에 읽었습니다. 통역 시작 전에는 외부로 전송하지 않습니다. ${result.warning}`);
        return;
      }
      if (file.size > 60000) throw new Error('파일이 너무 큽니다. 사전은 60KB 이하로 준비해 주세요.');
      if (!/\.json$/i.test(file.name)) throw new Error('사전 JSON 파일을 선택해 주세요.');
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()).replace(/^\uFEFF/u, ''); }
      catch { throw new Error('UTF-8 인코딩으로 저장한 파일을 선택해 주세요.'); }
        let data;
        try { data = JSON.parse(text); } catch { throw new Error('사전 JSON 형식을 확인해 주세요.'); }
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Between에서 내려받은 사전 JSON 파일을 선택해 주세요.');
        if (data.version !== 1) throw new Error('지원하지 않는 사전 파일 버전입니다.');
        onChange({ ...value, profile: validateProfile(data.profile) }); setSelected(''); setImportedFile(file.name);
        setMessage('사전을 불러와 아래 입력란에 적용했습니다. 내용을 확인하고 ‘사전 목록에 저장’을 누르면 다음에도 선택할 수 있습니다.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '파일을 읽지 못했습니다.'); }
    finally { setLoading(false); onBusy?.(false); }
  }
  const mismatch = (value.profile.keywords || value.profile.expressions || value.profile.notes) && (value.profile.sourceLanguage !== source || value.profile.targetLanguage !== target);
  return <section className="panel sermon-panel" aria-label="설교 정확도 참고 자료">
    <div className="section-heading"><h2>설교 정확도 참고 자료</h2><span className="sermon-badge">OpenAI · 실제 발언 우선</span></div>
    <p className="sermon-intro">원고와 사전은 참고용입니다. 즉흥 발언도 번역하며, 말하지 않은 내용을 자막에 추가하지 않도록 지시합니다. 정확도를 보장하는 기능은 아닙니다.</p>
    <fieldset disabled={locked}>
      <div className="sermon-grid">
        <div>
          <h3>1. 설교자별 어휘·표현</h3>
          <label className="field-label" htmlFor="saved-speaker">저장된 사전</label>
          <div className="speaker-picker">
            <select id="saved-speaker" className="text-input" value={selected} onChange={event => {
              const key = event.target.value; setSelected(key); setImportedFile(''); setMessage('');
              const profile = profiles.find(x => profileKey(x) === key);
              if (profile) onChange({ ...value, profile: { ...profile } });
            }}><option value="">{importedFile ? `불러온 사전 · ${value.profile.name || '이름 없음'} (미저장)` : '사전 선택 / 새 사전 작성'}</option>{profiles.map(profile => <option key={profileKey(profile)} value={profileKey(profile)}>{profile.name} · {profile.sourceLanguage} → {profile.targetLanguage}</option>)}</select>
            <button type="button" className="button secondary speaker-import-button" onClick={() => profileInput.current?.click()} aria-describedby="speaker-import-help">JSON 사전 불러오기</button>
            <input ref={profileInput} id="speaker-import" type="file" hidden accept=".json,application/json" aria-label="JSON 사전 파일" onChange={e => { void loadFile(e.target.files?.[0], 'profile'); e.target.value = ''; }}/>
          </div>
          <p className="field-help" id="speaker-import-help">‘JSON 사전 내려받기’로 보관한 파일을 선택하세요. UTF-8 JSON, 최대 60KB. 불러오기는 편집 중인 사전만 바꾸며, 저장된 사전은 자동으로 덮어쓰지 않습니다.</p>
          {importedFile && <div className="speaker-import-summary"><span>불러온 파일: {importedFile}</span><button type="button" className="button secondary" onClick={save}>사전 목록에 저장</button></div>}
          {message && <p className="sermon-feedback" role="status">{message}</p>}
          <label className="field-label" htmlFor="speaker-name">설교자 이름</label>
          <input className="text-input" id="speaker-name" maxLength={60} value={value.profile.name} onChange={e => setProfile({ name: e.target.value })} placeholder="예: 주일 설교자"/>
          <div className="sermon-language-row">{(['sourceLanguage', 'targetLanguage'] as const).map((key, index) => <label key={key}><span className="field-label">사전 {index === 0 ? '원어' : '번역어'}</span><select className="text-input" value={value.profile[key]} onChange={e => setProfile({ [key]: e.target.value })}>{languages.map(language => <option key={language.code} value={language.code}>{language.name}</option>)}</select></label>)}</div>
          {mismatch && <p className="sermon-warning" role="alert">사전 언어가 통역 언어와 다릅니다. 통역 시작 전에 사전 언어와 선호 번역을 확인해 주세요.</p>}
          <label className="field-label" htmlFor="speaker-keywords">인식 어휘 · 줄마다 한 개 (최대 100개)</label>
          <textarea id="speaker-keywords" rows={3} maxLength={sermonLimits.keywords} value={value.profile.keywords} onChange={e => setProfile({ keywords: e.target.value })} placeholder={'이사야\n언약\n교회명'}/>
          <label className="field-label" htmlFor="speaker-expressions">용어·문장별 선호 번역</label>
          <textarea id="speaker-expressions" rows={4} maxLength={sermonLimits.expressions} value={value.profile.expressions} onChange={e => setProfile({ expressions: e.target.value })} placeholder={'언약 => covenant\n너는 내 것이다 => You are mine.'}/>
          <label className="field-label" htmlFor="speaker-notes">표현의 의미·주의사항</label>
          <textarea id="speaker-notes" rows={3} maxLength={sermonLimits.notes} value={value.profile.notes} onChange={e => setProfile({ notes: e.target.value })} placeholder="예: ‘물과 불’은 실제 표현을 보존하고, 임의로 ‘홍해’로 바꾸지 않기"/>
          <div className="sermon-actions">
            <button type="button" className="button secondary" onClick={save}>이 브라우저에 저장</button>
            <button type="button" className="button secondary" onClick={() => { try { downloadProfile(validateProfile(value.profile)); } catch { setMessage('사전 내용을 확인해 주세요.'); } }}>JSON 사전 내려받기</button>
            <button type="button" className="quiet-button" onClick={() => { setSelected(''); setImportedFile(''); setMessage(''); onChange({ ...value, profile: emptySpeakerProfile(source, target) }); }}>새 사전</button>
            <button type="button" className="quiet-button" disabled={!selected} onClick={() => {
              try { persist(profiles.filter(x => profileKey(x) !== selected)); setSelected(''); setMessage('선택한 브라우저 저장 사전을 삭제했습니다. 편집 중인 내용은 남아 있어 다시 저장할 수 있습니다.'); }
              catch { setMessage('브라우저 저장 사전을 삭제하지 못했습니다.'); }
            }}>저장 사전 삭제</button>
          </div>
          <p className="field-help">명시적으로 저장할 때만 이 브라우저에 보관합니다. 같은 이름·언어의 사전은 갱신됩니다. 공용 PC에서는 사용 후 삭제하거나 파일로 보관해 주세요.</p>
        </div>
        <div>
          <h3>2. 이번 설교 원고와 성경 본문</h3>
          <label className="field-label" htmlFor="sermon-file">원고 불러오기 · PDF / UTF-8 TXT / Markdown</label>
          <input id="sermon-file" type="file" accept=".pdf,.txt,.md,text/plain,text/markdown,application/pdf" onChange={e => { void loadFile(e.target.files?.[0], 'manuscript'); e.target.value = ''; }}/>
          <label className="field-label" htmlFor="sermon-manuscript">원고 직접 입력 · {value.manuscript.length.toLocaleString()} / 80,000자</label>
          <textarea id="sermon-manuscript" rows={8} maxLength={sermonLimits.manuscript} value={value.manuscript} onChange={e => onChange({ ...value, manuscript: e.target.value })} placeholder="관련 문단을 찾아 번역에 참고합니다. 원고가 없어도 즉흥 발언을 번역할 수 있습니다."/>
          <div className="sermon-file-meta"><span>{value.manuscriptName || '이 탭에서만 유지됩니다.'}</span><button className="quiet-button" type="button" disabled={!value.manuscript} onClick={() => onChange({ ...value, manuscript: '', manuscriptName: '' })}>원고 비우기</button></div>
          <label className="field-label" htmlFor="sermon-passage">성경 본문</label>
          <input className="text-input" id="sermon-passage" maxLength={300} value={value.passage} onChange={e => onChange({ ...value, passage: e.target.value })} placeholder="예: 이사야 43:1–3 / Isaiah 43:1–3"/>
          <label className="field-label" htmlFor="sermon-bible-version">선호 성경 번역본</label>
          <input className="text-input" id="sermon-bible-version" maxLength={120} value={value.bibleVersion} onChange={e => onChange({ ...value, bibleVersion: e.target.value })} placeholder="사용할 번역본 이름"/>
          <details className="sermon-scripture"><summary>검토한 성경 인용문 등록 (선택)</summary>
            <label className="field-label" htmlFor="scripture-source">검토한 인용 원문</label><textarea id="scripture-source" rows={3} maxLength={sermonLimits.scripture} value={value.scriptureSource} onChange={e => onChange({ ...value, scriptureSource: e.target.value })}/>
            <label className="field-label" htmlFor="scripture-target">검토한 인용 번역문</label><textarea id="scripture-target" rows={3} maxLength={sermonLimits.scripture} value={value.scriptureTarget} onChange={e => onChange({ ...value, scriptureTarget: e.target.value })}/>
            <p className="field-help">직접 검토하고 사용할 권한이 있는 본문을 입력하세요. 실제 발언과 맞는 부분만 참고하며, 다른 구절이나 바뀐 표현을 강제 교체하지 않습니다. 번역본 이름만으로 정확한 인용문을 보장하지 않습니다.</p>
          </details>
        </div>
      </div>
    </fieldset>
    <p className="sermon-privacy">통역을 시작하면 마이크 음성·인식 어휘·관련 원고 문단·사전·등록 인용문이 OpenAI로 전송됩니다. 원고와 실시간 기록은 서버 파일에 저장하지 않습니다. 별도 음성 인식과 문맥 번역으로 추가 비용·지연이 발생할 수 있습니다. 시작 전 참고 자료를 확인해 주세요.</p>
    {disabled && <p className="field-help">진행 중에는 참고 자료를 변경할 수 없습니다. 통역 종료 후 수정해 주세요.</p>}
  </section>;
}
