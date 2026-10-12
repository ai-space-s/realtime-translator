import { useLayoutEffect, useRef, useState } from 'react';
import type { CaptionState } from './captionChannel';

export function CaptionDisplayMode({ showSource, onChange, disabled = false }: {
  showSource: boolean; onChange: (value: boolean) => void; disabled?: boolean;
}) {
  return <div className="caption-display-mode" role="group" aria-label="자막 표시 방식">
    <button type="button" disabled={disabled} aria-pressed={!showSource} onClick={() => onChange(false)}>번역어만</button>
    <button type="button" disabled={disabled} aria-pressed={showSource} onClick={() => onChange(true)}>원어 + 번역어</button>
  </div>;
}

function Region({ name, label, source, target, caption, preview, note, placeholder }: {
  name: 'previous' | 'current'; label: string; source: string[]; target: string[]; caption: CaptionState;
  preview: boolean; note: string; placeholder: string;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  // Only completed source windows are displayed. Keep recognition drafts in the
  // transcript pipeline, without giving them a separate caption region.
  const sourceText = caption.showSource ? source.join('\n') : '';
  const targetText = target.join(' ');
  useLayoutEffect(() => {
    const box = viewport.current;
    const text = content.current;
    if (!box || !text) return;
    const fit = () => {
      const fits = () => text.getBoundingClientRect().height <= box.clientHeight - 2 && text.scrollWidth <= box.clientWidth;
      const desired = caption.fontSize * (preview ? 0.5 : 1) * (name === 'current' ? 1 : 0.82);
      let low = preview ? 11 : 18;
      let high = Math.max(low, desired);
      // Measure against the actual region, including the bilingual source. Do not
      // cut words to fit. Very long sentences retain an accessible scroll area.
      text.style.fontSize = `${high}px`;
      if (!fits()) {
        for (let i = 0; i < 9; i++) {
          const mid = (low + high) / 2;
          text.style.fontSize = `${mid}px`;
          if (!fits()) high = mid;
          else low = mid;
        }
        text.style.fontSize = `${low}px`;
      }
      setOverflow(text.scrollHeight > box.clientHeight + 1);
    };
    fit();
    const resize = new ResizeObserver(fit);
    resize.observe(box);
    document.fonts.ready.then(() => { if (content.current === text) fit(); });
    return () => resize.disconnect();
  }, [sourceText, targetText, caption.fontSize, preview, name, placeholder]);
  return <section className={`caption-region ${name}${sourceText ? ' has-original' : ''}`} aria-label={label}>
    <div className="caption-region-heading"><h3>{label}</h3><span>{note}{overflow ? ' · 스크롤하여 더 보기' : ''}</span></div>
    <div className="caption-region-viewport" ref={viewport} tabIndex={overflow ? 0 : undefined} aria-label={`${label} 내용`}>
      <div className="caption-region-text" ref={content}>
        {sourceText && <p className="caption-original" lang={caption.sourceLanguage}>{sourceText}</p>}
        {target.map((sentence, index) => <p className="caption-translation" lang={caption.targetLanguage} key={index}>{sentence}</p>)}
        {name === 'current' && sourceText && !targetText && <p className="caption-placeholder">번역 결과를 기다리고 있습니다.</p>}
        {!targetText && !sourceText && <p className="caption-placeholder">{placeholder}</p>}
      </div>
    </div>
  </section>;
}

export function CaptionFlow({ caption, preview = false, waiting = false }: { caption: CaptionState; preview?: boolean; waiting?: boolean }) {
  const { frames } = caption;
  const sentenceBased = frames.recognition === 'sentence';
  const sourceNote = caption.showSource ? frames.alignment === 'independent' ? ' · 원어·번역 별도 구간' : frames.alignment === 'none' ? ' · 원어는 최근 인식 내용' : frames.alignment === 'time' ? ' · 원어는 시간 기준' : ' · 원어는 발화 기준' : '';
  const currentPlaceholder = waiting ? '운영자 화면에 연결하는 중입니다.' : frames.current.source.length ? `${sentenceBased ? '원문 문장 수신' : '원문 인식 완료'} · 번역을 기다리고 있습니다.` : '인식이 완료된 원문과 도착한 번역이 표시됩니다.';
  return <div className={`caption-flow ${preview ? 'is-preview' : ''}`}>
    <Region name="previous" label="이전 자막" source={frames.previous.source} target={frames.previous.target} caption={caption} preview={preview}
      note={`최근 3문장${sourceNote}`} placeholder="지나간 번역이 이곳에 남습니다."/>
    <Region name="current" label="현재 자막" source={frames.current.source} target={frames.current.target} caption={caption} preview={preview}
      note={`${sentenceBased ? '문장 구분 기준 원문' : '인식 완료 원문'} · 도착한 번역${sourceNote}`} placeholder={currentPlaceholder}/>
  </div>;
}
