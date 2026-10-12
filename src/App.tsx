import { useEffect, useRef, useState } from 'react';
import { languages, languageByCode, translationLanguageError } from '../shared/languages.mjs';
import { selectConfiguredProvider } from '../shared/providers.mjs';
import { exportSessions, formatTime } from '../shared/captions.mjs';
import { channelName, type CaptionState } from './captionChannel';
import { friendlyError } from './audio';
import { Icon } from './Icon';
import { CaptionDisplayMode, CaptionFlow } from './CaptionFlow';
import { startDemo } from './providers/demo';
import { startOpenAI } from './providers/openai';
import { startAzure } from './providers/azure';
import { startGoogle } from './providers/google';
import { startSermon } from './providers/sermon';
import { SermonPanel } from './SermonPanel';
import { SeminarPanel } from './SeminarPanel';
import { emptySeminarSettings, validateSeminar, seminarSermonSettings } from '../shared/seminar-context.mjs';
import { emptySermonSettings, referenceFor, validateReference, transcriptionHints } from '../shared/sermon-context.mjs';
import type { QualityState, SeminarSettings, SeminarControl } from './types';
import { emptyTranscript, type Provider, type Session, type Status, type Transcript } from './types';

type RecordEntry = {
  id: string; title: string; source: string; target: string; sourceLanguage: string;
  targetLanguage: string; provider: string; demo: boolean; startedAt: number; seconds: number;
  quality?: QualityState;
};
const providerName = (value: Provider) => ({ azure: 'Microsoft Azure', openai: 'OpenAI', google: 'Google Gemini' })[value];
const combined = (final: string, interim: string) => `${final}${final && interim ? '\n\n' : ''}${interim}`;

export function App() {
  const [provider, setProvider] = useState<Provider>('azure');
  const [translationMode, setTranslationMode] = useState<'fast' | 'sermon' | 'seminar'>('fast');
  const [seminar, setSeminar] = useState<SeminarSettings>(emptySeminarSettings);
  const seminarRef = useRef(seminar);
  const [preparing, setPreparing] = useState(false);
  const [seminarControl, setSeminarControl] = useState<SeminarControl>({ index: 0, mode: 'manual' });
  const seminarControlRef = useRef(seminarControl);
  const [seminarNote, setSeminarNote] = useState('');
  function updateSeminarControl(value: SeminarControl) { seminarControlRef.current = value; setSeminarControl(value); setSeminarNote(''); }
  const [sermon, setSermon] = useState(emptySermonSettings);
  const sermonRef = useRef(sermon);
  const sermonMode = provider === 'openai' && translationMode === 'sermon';
  const seminarMode = provider === 'openai' && translationMode === 'seminar';
  const referenceMode = sermonMode || seminarMode;
  const [sermonServerReady, setSermonServerReady] = useState<boolean | null>(null);
  const [source, setSource] = useState('ko');
  const [target, setTarget] = useState('en');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [config, setConfig] = useState<Record<Provider, boolean> | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const statusRef = useRef<Status>('idle');
  const [transcript, setTranscript] = useState<Transcript>(emptyTranscript);
  const transcriptRef = useRef<Transcript>(emptyTranscript());
  const [demo, setDemo] = useState(false);
  const [muted, setMuted] = useState(false);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const [tab, setTab] = useState<'live' | 'records'>('live');
  const [records, setRecords] = useState<RecordEntry[]>([]);
  const recordsRef = useRef<RecordEntry[]>([]);
  const [transcriptLanguages, setTranscriptLanguages] = useState({ source: 'ko', target: 'en' });
  const [title, setTitle] = useState('설교 · 강의');
  const [fontSize, setFontSize] = useState(56);
  const [showSource, setShowSource] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [audienceConnected, setAudienceConnected] = useState(false);
  const sessionRef = useRef<Session | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const currentRef = useRef<RecordEntry | null>(null);
  const channelId = useRef(crypto.randomUUID());
  const broadcast = useRef<BroadcastChannel | null>(null);
  const audienceWindow = useRef<Window | null>(null);
  const latestCaption = useRef<CaptionState | null>(null);
  const lastAudience = useRef(0);
  const setupDialog = useRef<HTMLDialogElement>(null);
  const sourcePane = useRef<HTMLDivElement>(null);
  const targetPane = useRef<HTMLDivElement>(null);
  const active = status !== 'idle' || preparing;
  const languageError = translationLanguageError(provider, source, target);
  const fullSource = combined(transcript.source, transcript.interimSource);
  const fullTarget = combined(transcript.target, transcript.interimTarget);
  const displaySource = fullSource || fullTarget ? transcriptLanguages.source : source;
  const displayTarget = fullSource || fullTarget ? transcriptLanguages.target : target;
  const audienceUrl = `/?view=caption&channel=${channelId.current}`;
  const captionState: CaptionState = {
    frames: transcript.captions, sourceLanguage: displaySource, targetLanguage: displayTarget,
    fontSize, showSource, hidden, title, language: languageByCode(displayTarget)!.native, live: status === 'live', demo,
  };

  const setPhase = (value: Status) => { statusRef.current = value; setStatus(value); };
  async function refreshConfig() {
    try {
      const response = await fetch('/api/config');
      if (!response.ok) throw new Error();
      const data = await response.json(); setConfig(data.providers);
      if (statusRef.current === 'idle') setProvider(current => selectConfiguredProvider(current, data.providers));
      return true;
    } catch { setConfig(null); setError('서버 설정을 읽지 못했습니다. 앱 서버가 실행 중인지 확인해 주세요.'); return false; }
  }
  async function refreshDevices() {
    try { setDevices((await navigator.mediaDevices?.enumerateDevices() || []).filter(device => device.kind === 'audioinput')); }
    catch { setNotice('마이크 목록을 읽지 못했습니다. 기본 입력 장치로 시작할 수 있습니다.'); }
  }
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);
  useEffect(() => { sermonRef.current = sermon; }, [sermon]);
  useEffect(() => { seminarRef.current = seminar; }, [seminar]);
  useEffect(() => {
    if (!referenceMode) return;
    const controller = new AbortController(); setSermonServerReady(null);
    void fetch(seminarMode ? '/api/seminar/status' : '/api/sermon/status', { signal: controller.signal }).then(async response => {
      const ready = response.ok && (await response.json()).available === true;
      if (!controller.signal.aborted) setSermonServerReady(ready);
    }).catch(() => { if (!controller.signal.aborted) setSermonServerReady(false); });
    return () => controller.abort();
  }, [referenceMode, seminarMode]);
  useEffect(() => {
    void refreshConfig(); void refreshDevices();
    navigator.mediaDevices?.addEventListener('devicechange', refreshDevices);
    return () => { navigator.mediaDevices?.removeEventListener('devicechange', refreshDevices); controllerRef.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!showSetup) { setupDialog.current?.close(); return; }
    setupDialog.current?.showModal();
  }, [showSetup]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (statusRef.current !== 'idle' && currentRef.current) setSeconds(Math.floor((Date.now() - currentRef.current.startedAt) / 1000));
      setAudienceConnected(Date.now() - lastAudience.current < 6000);
    }, 1000);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const preparation = sermonRef.current;
      if (statusRef.current !== 'idle' || seminarRef.current.sections.length || seminarRef.current.profile.keywords || seminarRef.current.profile.expressions || recordsRef.current.length || transcriptRef.current.source || transcriptRef.current.target || preparation.manuscript || preparation.passage || preparation.scriptureSource || preparation.scriptureTarget || preparation.profile.keywords || preparation.profile.expressions || preparation.profile.notes) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return;
    const channel = new BroadcastChannel(channelName(channelId.current)); broadcast.current = channel;
    channel.onmessage = ({ data }) => {
      if (data.type === 'ready') { lastAudience.current = Date.now(); if (latestCaption.current) channel.postMessage({ type: 'caption', state: latestCaption.current }); }
      if (data.type === 'display-mode' && typeof data.showSource === 'boolean') setShowSource(data.showSource);
    };
    return () => { channel.postMessage({ type: 'closed' }); channel.close(); broadcast.current = null; };
  }, []);
  useEffect(() => {
    latestCaption.current = captionState;
    broadcast.current?.postMessage({ type: 'caption', state: captionState });
  }, [transcript.captions, fontSize, showSource, hidden, title, displaySource, displayTarget, status, demo]);
  useEffect(() => {
    for (const pane of [sourcePane.current, targetPane.current]) if (pane) pane.scrollTop = pane.scrollHeight;
  }, [transcript, tab, fontSize]);

  function finish(id: string) {
    if (currentRef.current?.id !== id) return;
    const current = currentRef.current;
    const text = transcriptRef.current;
    const completed = { ...current, source: combined(text.source, text.interimSource), target: combined(text.target, text.interimTarget), quality: text.quality, seconds: Math.floor((Date.now() - current.startedAt) / 1000) };
    if (completed.source || completed.target || completed.quality?.segments.length) setRecords(previous => [...previous, completed]);
    currentRef.current = null; sessionRef.current = null;
    controllerRef.current?.abort(); controllerRef.current = null;
    setSeconds(completed.seconds); setPhase('idle'); setLevel(0); setMuted(false);
  }

  async function start(isDemo = false) {
    if (statusRef.current !== 'idle' || preparing) return;
    if (!isDemo && languageError) { setError(languageError); return; }
    if (!isDemo && !config?.[provider]) { setError(`${providerName(provider)} 연결 설정이 필요합니다.`); setShowSetup(true); return; }
    if (source === target) { setError('원문과 번역 언어를 다르게 선택해 주세요.'); return; }
    const referenceSettings = seminarMode ? seminarSermonSettings(seminar) : sermon;
    if (referenceMode && !isDemo) {
      if (sermonServerReady !== true) { setError('정확도 모드 서버 API를 확인할 수 없습니다. 기존 서버를 종료하고 npm run dev로 다시 실행한 뒤 화면을 새로고침해 주세요.'); return; }
      try { if (seminarMode) validateSeminar(seminar, source, target); transcriptionHints(validateReference(referenceFor(referenceSettings), source, target)); }
      catch (cause) { setError(friendlyError(cause)); return; }
    }
    setError(''); setDemo(isDemo); setMuted(false); setHidden(false); setSeconds(0); setTab('live');
    setTranscriptLanguages({ source, target });
    const controller = new AbortController(); controllerRef.current = controller;
    const id = crypto.randomUUID();
    currentRef.current = { id, title, source: '', target: '', sourceLanguage: languageByCode(source)!.name,
      targetLanguage: languageByCode(target)!.name, provider: isDemo ? '샘플 데모 (참고 자료 미적용)' : seminarMode ? `OpenAI · 세미나-원고제공방식 · ${seminar.name || '발표 원고'}` : sermonMode ? `OpenAI · 설교 정확도 모드${sermon.profile.name ? ` · ${sermon.profile.name}` : ''}` : providerName(provider), demo: isDemo, startedAt: Date.now(), seconds: 0 };
    transcriptRef.current = emptyTranscript(); setTranscript(emptyTranscript()); setPhase('connecting');
    try {
      const startProvider = isDemo ? startDemo : referenceMode ? startSermon : { openai: startOpenAI, azure: startAzure, google: startGoogle }[provider];
      const session = await startProvider({ source, target, deviceId, signal: controller.signal,
        sermon: referenceMode ? referenceSettings : undefined,
        seminar: seminarMode ? seminar : undefined,
        getSeminarControl: () => seminarControlRef.current,
        onSeminarPosition(index, note) { if (currentRef.current?.id === id) { const next = { ...seminarControlRef.current, index }; seminarControlRef.current = next; setSeminarControl(next); setSeminarNote(note); } },
        onTranscript(value) { if (currentRef.current?.id === id) { transcriptRef.current = value; setTranscript(value); } },
        onLevel: setLevel,
        onError(message) { if (currentRef.current?.id === id) setError(message); },
        onEnded() { finish(id); },
      });
      if (controller.signal.aborted || currentRef.current?.id !== id) { await session.stop(); return; }
      sessionRef.current = session; setPhase('live');
      if (!isDemo) void refreshDevices();
    } catch (cause) {
      if (!controller.signal.aborted) setError(friendlyError(cause));
      finish(id);
    }
  }
  async function stop() {
    const current = currentRef.current;
    if (!current || statusRef.current === 'stopping') return;
    if (statusRef.current === 'connecting') { controllerRef.current?.abort(); finish(current.id); return; }
    setPhase('stopping');
    try { await sessionRef.current?.stop(); } finally { finish(current.id); }
  }
  function toggleMuted() {
    sessionRef.current?.setMuted(!muted); setMuted(!muted);
  }
  function openAudience() {
    if (!('BroadcastChannel' in window)) { setError('이 브라우저는 자막 창 연결을 지원하지 않습니다. 최신 Chrome 또는 Edge를 사용해 주세요.'); return; }
    if (audienceWindow.current && !audienceWindow.current.closed) { audienceWindow.current.focus(); return; }
    audienceWindow.current = window.open(audienceUrl, `between-${channelId.current}`, 'popup,width=1280,height=720');
    if (!audienceWindow.current) setError('자막 창이 차단되었습니다. 아래의 ‘새 탭으로 열기’를 사용하거나 팝업을 허용해 주세요.');
  }
  function getExport() {
    const all = [...records];
    if (currentRef.current && (fullSource || fullTarget || transcript.quality?.segments.length)) all.push({ ...currentRef.current, source: fullSource, target: fullTarget, quality: transcript.quality, seconds });
    return exportSessions(all);
  }
  function download() {
    const text = getExport();
    if (!text) return;
    const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/markdown;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `between-${new Date().toISOString().slice(0, 10)}.md`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('원문과 번역 기록을 내려받았습니다.');
  }
  async function copy() {
    try { await navigator.clipboard.writeText(getExport()); setNotice('통역 기록을 복사했습니다.'); }
    catch { setError('복사 권한이 없습니다. 기록 내려받기를 사용해 주세요.'); }
  }
  const hasExport = records.length > 0 || Boolean(fullSource || fullTarget || transcript.quality?.segments.length);
  const statusLabel = status === 'connecting' ? '연결 중' : status === 'stopping' ? '마무리 중' : status === 'live' ? muted ? '입력 일시정지' : demo ? '데모 진행 중' : '실시간 통역 중' : '시작 준비';

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="wordmark" href="/" onClick={event => { event.preventDefault(); setTab('live'); }}><span className="brand-symbol"><i/><i/><i/><i/></span>between<span className="wordmark-dot">.</span></a>
      <span className="sidebar-caption">말씀과 배움을, 더 가까이</span>
      <div className="nav-label">WORKSPACE</div>
      <nav aria-label="주 메뉴">
        <button className={tab === 'live' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('live')}><Icon name="screen"/>라이브 자막<span className="nav-indicator"/></button>
        <button className={tab === 'records' ? 'nav-item selected' : 'nav-item'} onClick={() => setTab('records')}><Icon name="record"/>통역 기록<span className="nav-count">{records.length}</span></button>
        <button className="nav-item" onClick={() => setShowSetup(true)}><Icon name="settings"/>연결 설정</button>
      </nav>
      <div className="sidebar-bottom"><div className="sidebar-tip"><Icon name="book" size={22}/><strong>언어 너머로 전하는 이야기</strong><p>예배와 강의의 모든 순간을<br/>청중의 언어로 이어 보세요.</p></div>
        <div className="local-status"><span className="dot live"/>로컬 워크스페이스<span>v0.1</span></div>
      </div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span>워크스페이스</span><span className="breadcrumb-slash">/</span><strong>{tab === 'live' ? '라이브 자막' : '통역 기록'}</strong></div>
        <button className="connection-pill" onClick={() => setShowSetup(true)}><span className={config?.[provider] ? 'dot live' : 'dot amber'}/>{providerName(provider)} · {config?.[provider] ? '키 설정됨' : '설정 필요'}<Icon name="chevron" size={14}/></button>
      </header>
      <main className="workspace">
        <div className="page-heading"><div><div className="eyebrow">LIVE INTERPRETATION</div><h1>{tab === 'live' ? '언어가 달라도, 함께 듣도록.' : '이야기는 기록으로 남습니다.'}</h1><p>{tab === 'live' ? '설교와 강의를 실시간으로 번역하고, 큰 화면으로 전하세요.' : '이번에 진행한 세션의 원문과 번역을 확인하고 내려받으세요.'}</p></div>
          <button className="button secondary export-top" onClick={download} disabled={!hasExport}><Icon name="download" size={17}/>기록 내려받기</button>
        </div>
        {error && <div className="alert error" role="alert"><Icon name="info" size={18}/><span>{error}</span><button aria-label="오류 메시지 닫기" onClick={() => setError('')}><Icon name="close" size={16}/></button></div>}
        {tab === 'live' ? <>
          {referenceMode && sermonServerReady === false && <div className="alert error" role="alert"><Icon name="info" size={18}/><span>원고 참고 모드에는 새 서버 API가 필요합니다. 기존 서버를 종료하고 npm run dev로 다시 실행한 뒤, 기록을 보관하고 이 화면을 새로고침해 주세요.</span></div>}
          {sermonMode && <SermonPanel value={sermon} onChange={setSermon} disabled={active} source={source} target={target} onBusy={setPreparing}/>}
          {seminarMode && <SeminarPanel value={seminar} onChange={setSeminar} disabled={status !== 'idle'} busy={preparing} onBusy={setPreparing} control={seminarControl} onControl={updateSeminarControl} note={seminarNote} canTranslate={sermonServerReady === true && Boolean(config?.openai) && !translationLanguageError('openai', seminar.sourceLanguage, seminar.targetLanguage)}/>}
          <div className="control-grid">
            <section className="panel session-panel" aria-label="통역 세션 설정">
              <div className="section-heading"><h2>통역 설정</h2><span className="section-index">01</span></div>
              <label className="field-label" htmlFor="session-title">세션 이름</label><input className="text-input" id="session-title" value={title} maxLength={60} disabled={active} onChange={event => setTitle(event.target.value)}/>
              <div className="field-label">통역 서비스</div>
              <div className="provider-picker" role="group" aria-label="통역 서비스">
                <button disabled={active} aria-label="Microsoft Azure Speech" aria-pressed={provider === 'azure'} className={provider === 'azure' ? 'provider active' : 'provider'} onClick={() => setProvider('azure')}><span className="ms-mark"><i/><i/><i/><i/></span><span>Microsoft<small>Azure Speech</small></span>{provider === 'azure' && <Icon name="check" size={15}/>}</button>
                <button disabled={active} aria-label="OpenAI Realtime" aria-pressed={provider === 'openai'} className={provider === 'openai' ? 'provider active' : 'provider'} onClick={() => setProvider('openai')}><span className="oai-mark">◎</span><span>OpenAI<small>Realtime</small></span>{provider === 'openai' && <Icon name="check" size={15}/>}</button>
                <button disabled={active} aria-label="Google Gemini Live Translate" aria-pressed={provider === 'google'} className={provider === 'google' ? 'provider active' : 'provider'} onClick={() => setProvider('google')}><span className="google-mark" aria-hidden="true">G</span><span>Google<small>Live Translate</small></span>{provider === 'google' && <Icon name="check" size={15}/>}</button>
              </div>
              {provider === 'openai' && <div className="translation-mode"><label className="field-label" htmlFor="translation-mode">통역 방식</label><select id="translation-mode" className="text-input" disabled={active} value={translationMode} onChange={e => setTranslationMode(e.target.value as 'fast' | 'sermon' | 'seminar')}><option value="fast">빠른 통역 · 기존 방식</option><option value="sermon">설교 정확도 · 원고·사전 참고</option><option value="seminar">세미나-원고제공방식</option></select><p className="field-help">{seminarMode ? 'PDF 원고·구간별 번역·용어집을 준비하고 발표 위치를 선택하세요.' : sermonMode ? 'OpenAI 음성 인식 + 문맥 번역. 위의 참고 자료를 확인하세요.' : '음성을 바로 번역합니다. 원고와 설교자 사전은 적용하지 않습니다.'}</p></div>}
              <div className="language-picker">
                <label><span className="field-label">말하는 언어</span><select value={source} disabled={active} onChange={event => { setSource(event.target.value); if (event.target.value === target) setTarget(source); }}>{languages.map(language => <option value={language.code} key={language.code}>{language.name}</option>)}</select></label>
                <button className="swap-button" title="언어 바꾸기" aria-label="원문과 번역 언어 바꾸기" disabled={active} onClick={() => { setSource(target); setTarget(source); }}><Icon name="swap" size={18}/></button>
                <label><span className="field-label">번역 언어</span><select value={target} disabled={active} onChange={event => { setTarget(event.target.value); if (event.target.value === source) setSource(target); }}>{languages.map(language => <option value={language.code} key={language.code}>{language.name}</option>)}</select></label>
              </div>
              <p className="field-help">{referenceMode || provider === 'azure' ? '말하는 언어를 지정하면 더 정확하게 인식할 수 있어요.' : `${provider === 'google' ? 'Google은' : 'OpenAI는'} 입력 언어를 자동으로 감지합니다.`}</p>
              {target === 'id' && <p className="field-help">인도네시아어(Bahasa Indonesia) 자막을 표시합니다. ‘원어 + 번역어’를 선택하면 원문도 함께 표시합니다.</p>}
              {languageError && <div className="sermon-warning" id="language-support-note" role="alert"><p>{languageError}</p><div className="sermon-actions"><button type="button" className="button secondary" disabled={active} onClick={() => { setProvider('azure'); setError(''); }}>Microsoft 선택</button><button type="button" className="button secondary" disabled={active} onClick={() => { setProvider('google'); setError(''); }}>Google 선택</button></div></div>}
              {(source === 'lo' || target === 'lo') && !languageError && <p className="field-help">라오어 자막을 표시합니다. 원고·설교자 사전은 적용되지 않으며, 설교에 사용하기 전 라오어 화자와 성경 인명·장절·주요 표현을 확인해 주세요. 데모는 고정 예문이며 실제 번역 품질 검사가 아닙니다.</p>}
              {provider === 'google' && <p className="google-provider-note">Gemini Live Translate 프리뷰 · Google AI Studio의 API 키를 사용합니다. 연결 시간 제한 시 다시 시작해야 합니다.</p>}
              <label className="field-label" htmlFor="microphone">오디오 입력</label>
              <div className="input-select"><Icon name="mic" size={16}/><select id="microphone" value={deviceId} disabled={active} onChange={event => setDeviceId(event.target.value)}><option value="">시스템 기본 마이크</option>{devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `오디오 입력 ${index + 1}`}</option>)}</select></div>
              <div className="meter-line"><div className="meter" aria-label={`마이크 입력 레벨 ${Math.round(level * 100)}%`}>{Array.from({ length: 24 }, (_, i) => <i key={i} className={level * 24 > i ? 'lit' : ''}/>)}</div><span>{muted ? '일시정지' : status === 'live' ? demo ? '샘플 신호' : '입력 중' : '대기 중'}</span></div>
              <div className="session-divider"/>
              <div className="session-status"><span><span className={status === 'live' ? 'dot live' : 'dot'}/>{statusLabel}</span><time>{formatTime(seconds)}</time></div>
              <div className="session-buttons">{status !== 'idle' ? <><button className="button stop-button" disabled={status === 'stopping'} onClick={stop}><Icon name={status === 'connecting' ? 'close' : 'stop'} size={17}/>{status === 'connecting' ? '연결 취소' : status === 'stopping' ? '마지막 자막 수신 중…' : '통역 종료'}</button>{status === 'live' && <button className={muted ? 'button mute-button muted' : 'button mute-button'} onClick={toggleMuted} aria-label={muted ? '마이크 입력 재개' : '마이크 입력 일시정지'} title={muted ? '입력 재개' : '입력 일시정지'}><Icon name={muted ? 'play' : 'pause'} size={18}/></button>}</> : <button className="button primary start-button" disabled={preparing || Boolean(languageError)} aria-describedby={languageError ? 'language-support-note' : undefined} onClick={() => start(false)}><Icon name="mic" size={18}/>{preparing ? '원고 준비 중…' : '통역 시작'}<Icon name="arrow" size={18}/></button>}</div>
              <button className="demo-button" disabled={active} onClick={() => start(true)}><Icon name="play" size={12}/> 마이크 없이 데모 체험</button>
              {referenceMode && <p className="field-help">데모는 고정 샘플로 화면만 보여줍니다. 원고·사전·발표 위치 추적의 효과를 검증하지 않습니다.</p>}
            </section>
            <section className="panel caption-panel" aria-label="청중용 자막">
              <div className="section-heading"><div><h2>청중용 자막</h2><span className="subtle-text">큰 화면에 전할 메시지</span></div><span className="preview-label">PREVIEW</span></div>
              <div className={`caption-preview ${hidden ? 'is-hidden' : ''}`}>
                {!hidden && <><div className="preview-meta"><span className={status === 'live' ? 'dot live' : 'dot'}/>{demo ? 'DEMO' : 'LIVE CAPTIONS'}<span>{languageByCode(displayTarget)!.native}</span></div>
                  <CaptionFlow caption={captionState} preview/><div className="preview-bottom"><span>{title || '라이브 번역 자막'}</span><span>BETWEEN</span></div></>}
                {hidden && <div className="hidden-caption"><Icon name="eye" size={28}/><span>청중 화면의 자막이 숨겨져 있습니다.</span></div>}
              </div>
              <div className="caption-options"><div className="font-control"><label htmlFor="caption-size">최대 글자 크기</label><span className="small-a">A</span><input type="range" id="caption-size" min="36" max="88" step="2" value={fontSize} onChange={event => setFontSize(Number(event.target.value))}/><span className="large-a">A</span><output>{fontSize}</output></div><CaptionDisplayMode showSource={showSource} onChange={setShowSource}/></div>
              <p className="caption-layout-help">이전 자막은 위쪽 ⅓, 현재 자막은 넓은 ⅔ 영역에 표시합니다. 인식 중인 원문은 자막에 표시하지 않고, 완료된 원문과 도착한 번역을 반영합니다. 각 영역 최대 3문장이며 문장마다 새 줄로 표시합니다. 긴 문장은 자동 줄바꿈되고, 완료 신호가 없는 스트림은 문장 구분 기준으로 반영됩니다.</p>
              <div className="caption-footer"><button className="quiet-button" onClick={() => setHidden(!hidden)}><Icon name="eye" size={17}/>{hidden ? '자막 다시 표시' : '자막 잠시 숨기기'}</button><button className="button dark" onClick={openAudience}><Icon name="external" size={16}/>자막 창 열기</button></div>
              <p className="caption-hint"><span className={audienceConnected ? 'dot live' : 'dot'}/>{audienceConnected ? '자막 창 연결됨 · 실시간으로 동기화 중' : '별도 창을 프로젝터로 옮기고 전체화면으로 표시하세요.'}</p>
              <a className="caption-tab-link" href={audienceUrl} target="_blank" rel="noopener">새 탭으로 열기 <Icon name="external" size={11}/></a>
            </section>
          </div>
          {transcript.quality && <section className="sermon-quality panel" aria-label="정확도 모드 확인 내역"><h2>정확도 모드 확인 내역</h2><p>번역 대기 {transcript.quality.pending}개 · 확인 필요 {transcript.quality.reviews.length}개</p><p className="field-help">원고 일치 여부와 무관하게 모든 완료 발언을 번역합니다. 확인 필요 표시는 자동 참고 정보이며, 표시가 없어도 정확성을 보장하지 않습니다.</p>{transcript.quality.reviews.length > 0 && <details open><summary>운영자 확인 사항</summary><ul>{transcript.quality.reviews.slice(-10).map((review, index) => <li key={index}>{review}</li>)}</ul><p className="field-help">최근 10개를 표시합니다. 전체 발언별 내역은 기록 내려받기에 포함됩니다.</p></details>}</section>}
          <section className="transcript-section" aria-label="실시간 통역 텍스트"><div className="transcript-heading"><h2>실시간 기록</h2><span>{demo ? '샘플 문장 · 실제 음성을 인식하지 않습니다' : '발화에 따라 자막이 순차적으로 완성됩니다'}</span><span className="auto-scroll">자동 스크롤 <Icon name="check" size={13}/></span></div>
            <div className="transcript-grid">{(['source', 'target'] as const).map(side => <div className={`transcript-card ${side}`} key={side}><div className="transcript-card-label"><span>{side === 'source' ? '원문' : '번역'}</span><span>{languageByCode(side === 'source' ? displaySource : displayTarget)!.name}</span></div><div className="transcript-content" ref={side === 'source' ? sourcePane : targetPane} lang={side === 'source' ? displaySource : displayTarget}>{transcript[side] || transcript[side === 'source' ? 'interimSource' : 'interimTarget'] ? <><span>{transcript[side]}</span><span className="interim">{transcript[side] ? '\n\n' : ''}{transcript[side === 'source' ? 'interimSource' : 'interimTarget']}</span>{status === 'live' && <span className="typing-cursor"/>}</> : <p className="empty-transcript">{side === 'source' ? '인식된 말씀이 여기에 쌓입니다.' : '번역된 내용이 여기에 쌓입니다.'}</p>}</div></div>)}</div>
          </section>
          <div className="workspace-footnote"><Icon name="info" size={15}/><span>마이크 소리는 선택한 통역 서비스로 전송됩니다. 기록은 이 탭에만 유지되므로 종료 전에 내려받아 주세요.</span></div>
        </> : <section className="records-panel panel"><div className="section-heading"><h2>이번 워크스페이스의 기록 <span className="record-count">{records.length}</span></h2><button className="quiet-button" onClick={copy} disabled={!hasExport}><Icon name="copy" size={16}/>전체 복사</button></div>
          {active && <div className="record-live-note"><span className="dot live"/>진행 중인 세션은 통역 종료 후 이곳에 추가됩니다.</div>}
          {!records.length && <div className="records-empty"><Icon name="record" size={38}/><h3>아직 완료된 통역이 없습니다.</h3><p>설교나 강의를 시작하면 원문과 번역이 함께 기록됩니다.</p><button className="button secondary" onClick={() => setTab('live')}>라이브 자막으로 돌아가기<Icon name="arrow" size={16}/></button></div>}
          {records.map((record, index) => <details className="record-item" key={record.id} open={index === records.length - 1}><summary><span className="record-icon"><Icon name="record" size={19}/></span><span><strong>{record.title}{record.demo && <em>DEMO</em>}</strong><small>{new Date(record.startedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} · {record.sourceLanguage} → {record.targetLanguage} · {record.provider}</small></span><time>{formatTime(record.seconds)}</time><Icon name="chevron" size={18}/></summary><div className="record-columns"><div><h4>원문</h4><p>{record.source || '원문 없음'}</p></div><div><h4>번역</h4><p>{record.target || '번역 없음'}</p></div></div></details>)}
          <p className="records-note">새로고침하거나 탭을 닫으면 기록이 사라집니다. 필요한 내용은 내려받아 보관하세요.</p>
        </section>}
      </main>
    </div>
    {notice && <div className="toast" role="status"><Icon name="check" size={18}/>{notice}</div>}
    <dialog className="setup-dialog" ref={setupDialog} onCancel={() => setShowSetup(false)} onClick={event => { if (event.target === event.currentTarget) setShowSetup(false); }}><div className="dialog-inner"><div className="section-heading"><div><div className="eyebrow">CONNECTION</div><h2>통역 서비스 연결</h2></div><button className="icon-button" aria-label="연결 설정 닫기" onClick={() => setShowSetup(false)}><Icon name="close"/></button></div><p>서버의 <code>.env</code> 파일에 사용할 서비스의 키를 설정한 뒤 ‘설정 다시 확인’을 눌러 주세요. 세 서비스 중 하나만 설정해도 사용할 수 있습니다.</p>
      <p className="setup-selection">현재 선택: <strong>{providerName(provider)}</strong>{config?.[provider] ? ' · 키 설정됨' : ' · 설정 필요'}</p>
      <div className="setup-provider"><div><strong>Microsoft Azure Speech</strong><span className={config?.azure ? 'setup-ready' : 'setup-missing'}>{config?.azure ? '설정됨' : '설정 필요'}</span></div><pre>AZURE_SPEECH_KEY=발급받은_키{'\n'}AZURE_SPEECH_REGION=리전</pre><small>Azure Speech 리소스의 키와 실제 배포 리전을 입력하세요.</small></div>
      <div className="setup-provider"><div><strong>OpenAI</strong><span className={config?.openai ? 'setup-ready' : 'setup-missing'}>{config?.openai ? '설정됨' : '설정 필요'}</span></div><pre>OPENAI_API_KEY=발급받은_키</pre><small>통역 모델의 접근 권한과 API 잔액이 필요합니다.</small></div>
      <div className="setup-provider"><div><strong>Google Gemini Live Translate</strong><span className={config?.google ? 'setup-ready' : 'setup-missing'}>{config?.google ? '설정됨' : '설정 필요'}</span></div><pre>GOOGLE_API_KEY=발급받은_키</pre><small><a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">Google AI Studio에서 키 발급 ↗</a><br/>Gemini API용 키를 사용하세요. Cloud Speech-to-Text 전용 키와는 다릅니다. 프리뷰 모델 접근 권한과 사용 한도를 확인해 주세요. 기존 GEMINI_API_KEY도 사용할 수 있습니다.</small></div>
      <p className="setup-note">설정됨은 키 입력 여부입니다. 실제 연결은 통역 시작 시 확인합니다. 실제 키는 화면이나 기록에 표시하지 않습니다.</p><div className="dialog-actions"><button className="button secondary" onClick={async () => { if (await refreshConfig()) { setError(''); setNotice('서버 설정을 다시 확인했습니다.'); } }}>설정 다시 확인</button>{!active && config && !config[provider] && (config.openai || config.azure || config.google) ? <button className="button primary" onClick={() => { setProvider(selectConfiguredProvider(provider, config)); setError(''); setShowSetup(false); }}>{providerName(selectConfiguredProvider(provider, config))}로 전환</button> : <button className="button primary" onClick={() => setShowSetup(false)}>확인</button>}</div>
    </div></dialog>
  </div>;
}
