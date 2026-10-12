import { useEffect, useRef, useState } from 'react';
import { languages } from '../shared/languages.mjs';
import { seminarLimits, seminarSermonSettings, validateSeminar } from '../shared/seminar-context.mjs';
import { referenceFor } from '../shared/sermon-context.mjs';
import { readManuscript } from './manuscript';
import { friendlyError, postJson } from './audio';
import type { SeminarControl, SeminarSection, SeminarSettings } from './types';

export function SeminarPanel({ value, onChange, disabled, busy, onBusy, control, onControl, note, canTranslate }: {
  value: SeminarSettings; onChange: (value: SeminarSettings) => void; disabled: boolean; busy: boolean; onBusy: (busy: boolean) => void;
  control: SeminarControl; onControl: (control: SeminarControl) => void; note: string; canTranslate: boolean;
}) {
  const [message, setMessage] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const request = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current?.abort(); onBusy(false); }; }, []);
  const section = value.sections[control.index];
  const locked = disabled || busy;
  const updateSection = (patch: Partial<SeminarSection>) => onChange({ ...value, sections: value.sections.map((x, index) => index === control.index ? { ...x, ...patch } : x) });
  async function load(file: File | undefined, saved = false) {
    if (!file || locked) return;
    onBusy(true); setMessage('원고를 읽는 중입니다…');
    try {
      let next: SeminarSettings;
      let warning = '';
      if (saved) {
        if (file.size > 6000000 || !/\.json$/i.test(file.name)) throw new Error('6MB 이하의 세미나 JSON 파일을 선택해 주세요.');
        const data = JSON.parse(await file.text());
        if (data.version !== 1 || data.type !== 'between-seminar') throw new Error('Between에서 내려받은 세미나 자료를 선택해 주세요.');
        next = validateSeminar(data.seminar, data.seminar?.sourceLanguage, data.seminar?.targetLanguage);
      } else {
        const result = await readManuscript(file);
        next = { ...value, name: file.name, sections: result.sections };
        warning = result.warning;
      }
      if (!alive.current) return;
      onChange(next); onControl({ index: 0, mode: 'manual' }); setConfirmed(false);
      setMessage(`${next.sections.length}개 구간을 불러왔습니다. ${warning} 본문·참고 자료를 구분하고 내용을 검토하세요.`);
    } catch (error) { if (alive.current) setMessage(friendlyError(error)); }
    finally { if (alive.current) onBusy(false); }
  }
  function save() {
    try {
      const seminar = validateSeminar(value, value.sourceLanguage, value.targetLanguage);
      const url = URL.createObjectURL(new Blob([JSON.stringify({ type: 'between-seminar', version: 1, seminar }, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'between-seminar.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setMessage('원고·구간별 번역·용어집을 파일로 저장했습니다.');
    } catch (error) { setMessage(friendlyError(error)); }
  }
  async function prepare() {
    if (!section || locked || !confirmed) return;
    const controller = new AbortController(); request.current = controller;
    onBusy(true); setMessage('선택 구간의 번역 초안을 만드는 중입니다…');
    try {
      const checked = validateSeminar(value, value.sourceLanguage, value.targetLanguage);
      const result = await postJson('/api/seminar/translate', { sourceLanguage: value.sourceLanguage, targetLanguage: value.targetLanguage,
        utterance: section.source, recent: [], reference: referenceFor(seminarSermonSettings(checked)), seminar: { mode: 'manual', sections: [{ ...section, target: '' }] } }, controller.signal);
      if (result.translation.length > seminarLimits.translation) throw new Error('번역이 너무 깁니다. 원문 구간을 나누어 주세요.');
      if (!alive.current) return;
      updateSection({ target: result.translation });
      setMessage(`번역 초안을 만들었습니다. 숫자·부정·용어를 검토하고 수정하세요.${result.needsReview ? ` 확인: ${result.reviewReason}` : ''}`);
    } catch (error) { if (alive.current) setMessage(friendlyError(error)); }
    finally { request.current = null; if (alive.current) onBusy(false); }
  }
  function changeLanguage(key: 'sourceLanguage' | 'targetLanguage', language: string) {
    onChange({ ...value, [key]: language, profile: { ...value.profile, [key]: language, expressions: '' }, sections: value.sections.map(x => ({ ...x, target: '' })) });
    setMessage('언어를 변경하여 구간 번역과 선호 번역을 비웠습니다. 새 언어로 다시 준비해 주세요.');
  }
  return <section className="panel sermon-panel seminar-panel" aria-label="세미나 원고 준비">
    <div className="section-heading"><h2>세미나-원고제공방식</h2><span className="sermon-badge">OpenAI · 실제 발언 우선</span></div>
    <p className="sermon-intro">원고를 구간별로 준비하고 실제 발표에 맞춰 통역합니다. 다른 세미나는 자료만 바꾸면 됩니다.</p>
    <details open={!disabled} className="seminar-details"><summary>원고·용어집 준비</summary><fieldset disabled={locked}>
      <div className="sermon-grid">
        <div>
          <label className="field-label" htmlFor="seminar-file">발표 원고 · PDF / TXT / Markdown</label>
          <input id="seminar-file" type="file" accept=".pdf,.txt,.md" onChange={e => { void load(e.target.files?.[0]); e.target.value = ''; }}/>
          <p className="field-help">PDF 최대 30MB·200쪽, 원문 총 80,000자. 브라우저에서 읽습니다. 스캔 PDF의 OCR과 그림 해석은 지원하지 않습니다. 새 원고는 기존 구간을 교체합니다.</p>
          <label className="field-label" htmlFor="seminar-name">자료 이름</label>
          <input id="seminar-name" className="text-input" maxLength={240} value={value.name} onChange={e => onChange({ ...value, name: e.target.value })}/>
          <div className="sermon-language-row">{(['sourceLanguage', 'targetLanguage'] as const).map((key, index) => <label key={key}><span className="field-label">원고 {index ? '번역어' : '원어'}</span><select className="text-input" value={value[key]} onChange={e => changeLanguage(key, e.target.value)}>{languages.map(x => <option key={x.code} value={x.code}>{x.name}</option>)}</select></label>)}</div>
          <p className="field-help">통역 설정의 언어와 맞추세요. 언어 변경 시 기존 구간 번역·선호 번역은 비워집니다.</p>
          <div className="sermon-actions"><button className="button secondary" onClick={save}>세미나 자료 내려받기</button></div>
          <label className="field-label" htmlFor="seminar-import">저장한 세미나 자료 불러오기 · JSON</label>
          <input id="seminar-import" type="file" accept=".json" onChange={e => { void load(e.target.files?.[0], true); e.target.value = ''; }}/>
        </div>
        <div>
          <label className="field-label" htmlFor="seminar-speaker">발표자</label><input id="seminar-speaker" className="text-input" maxLength={60} value={value.profile.name} onChange={e => onChange({ ...value, profile: { ...value.profile, name: e.target.value } })}/>
          <label className="field-label" htmlFor="seminar-keywords">인식 어휘 · 줄마다 한 개, 최대 100개</label><textarea id="seminar-keywords" rows={3} maxLength={3000} value={value.profile.keywords} onChange={e => onChange({ ...value, profile: { ...value.profile, keywords: e.target.value } })} placeholder="인명, 지명, 전문 용어"/>
          <label className="field-label" htmlFor="seminar-glossary">용어·문장별 선호 번역</label><textarea id="seminar-glossary" rows={3} maxLength={6000} value={value.profile.expressions} onChange={e => onChange({ ...value, profile: { ...value.profile, expressions: e.target.value } })} placeholder="원어 용어 => 선호 번역"/>
          <label className="field-label" htmlFor="seminar-notes">표현의 의미·주의사항</label><textarea id="seminar-notes" rows={2} maxLength={1500} value={value.profile.notes} onChange={e => onChange({ ...value, profile: { ...value.profile, notes: e.target.value } })}/>
        </div>
      </div>
    </fieldset></details>
    <div className="seminar-position">
      <label className="field-label" htmlFor="seminar-follow">발표 위치</label>
      <div className="sermon-actions">
        <select id="seminar-follow" className="text-input" disabled={busy} value={control.mode} onChange={e => onControl({ ...control, mode: e.target.value as SeminarControl['mode'] })}><option value="manual">수동 고정</option><option value="auto">자동 추적</option><option value="qa">질의응답 · 원고 참고 끄기</option></select>
        <button className="button secondary" disabled={busy || control.index <= 0} onClick={() => onControl({ ...control, index: control.index - 1 })}>이전 구간</button>
        <button className="button secondary" disabled={busy || control.index >= value.sections.length - 1} onClick={() => onControl({ ...control, index: control.index + 1 })}>다음 구간</button>
      </div>
      <label className="field-label" htmlFor="seminar-section">구간 선택 · {value.sections.length}개</label>
      <select id="seminar-section" className="text-input" disabled={busy || !section} value={control.index} onChange={e => onControl({ ...control, index: Number(e.target.value) })}>{!section && <option value={0}>원고를 불러오거나 구간을 추가하세요</option>}{value.sections.map((x, index) => <option key={x.id} value={index}>{index + 1}. {x.page ? `PDF ${x.page}쪽 · ` : ''}{x.slide ? `슬라이드 ${x.slide} · ` : ''}{x.title}</option>)}</select>
      <p className="field-help" role="status">{note || (control.mode === 'qa' ? '질의응답 · 원고 없이 실제 발언을 번역합니다. 용어집은 계속 참고합니다.' : control.mode === 'manual' ? '수동 고정 · 선택한 구간을 참고합니다. 발표 순서에 맞춰 이동하세요.' : '자동 추적은 어휘 겹침을 이용하는 보조 기능입니다. 위치가 다르면 수동 고정으로 조정하세요.')}</p>
    </div>
    <details open={!disabled} className="seminar-details"><summary>선택 구간 원문·번역 확인</summary><fieldset disabled={locked}>
      {section && <div className="sermon-grid">
        <div>
          <label className="field-label" htmlFor="seminar-section-title">구간 제목</label><input id="seminar-section-title" className="text-input" maxLength={150} value={section.title} onChange={e => updateSection({ title: e.target.value })}/>
          <div className="sermon-language-row"><label><span className="field-label">연결할 PPT 슬라이드</span><input className="text-input" maxLength={40} value={section.slide} onChange={e => updateSection({ slide: e.target.value })} placeholder="직접 입력"/></label><label><span className="field-label">구간 종류</span><select className="text-input" value={section.kind} onChange={e => updateSection({ kind: e.target.value })}><option value="speech">발표 본문</option><option value="reference">표·사진 설명 등 참고 자료</option></select></label></div>
          <label className="field-label" htmlFor="seminar-source">구간 원문 · {section.source.length} / 4,000자</label><textarea id="seminar-source" rows={9} maxLength={4000} value={section.source} onChange={e => updateSection({ source: e.target.value, target: '' })}/>
          <p className="field-help">표의 측정 대상·수치·단위를 확인하세요. 원문 수정 시 기존 구간 번역은 비워집니다.</p>
        </div>
        <div>
          <label className="field-label" htmlFor="seminar-target">구간 번역 · 직접 입력하거나 초안을 검토하세요</label><textarea id="seminar-target" rows={9} maxLength={6000} value={section.target} onChange={e => updateSection({ target: e.target.value })}/>
          <label className="seminar-consent"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)}/>선택 구간과 용어집을 OpenAI로 보내 번역 초안을 만듭니다. API 비용이 발생합니다.</label>
          <button className="button secondary" disabled={!confirmed || !canTranslate} onClick={() => void prepare()}>선택 구간 번역 초안 만들기</button>
          <p className="field-help">초안은 자동 검증되지 않습니다. 실제 통역에서는 발언에 맞는 부분만 참고합니다.</p>
        </div>
      </div>}
      <div className="sermon-actions">
        <button className="button secondary" disabled={value.sections.length >= 300} onClick={() => { const index = value.sections.length; onChange({ ...value, sections: [...value.sections, { id: crypto.randomUUID(), title: '새 구간', page: 0, slide: '', kind: 'speech', source: '', target: '' }] }); onControl({ ...control, index }); }}>구간 추가</button>
        <button className="quiet-button" disabled={!section} onClick={() => { onChange({ ...value, sections: value.sections.filter((_, index) => index !== control.index) }); onControl({ ...control, index: Math.max(0, control.index - 1) }); }}>선택 구간 삭제</button>
      </div>
    </fieldset></details>
    {message && <p className="sermon-feedback" role="status">{message}</p>}
    <p className="sermon-privacy">원고는 이 탭에만 유지됩니다. 다음에 쓰려면 세미나 자료를 내려받으세요. 통역 시작 시 음성·어휘·용어집·선택된 원고 및 번역 구간이 OpenAI로 전송됩니다. 발표 중에는 위치와 질의응답만 바꿀 수 있습니다.</p>
  </section>;
}
