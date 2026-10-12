import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionDisplayMode, CaptionFlow } from '../../src/CaptionFlow';
import { defaultCaption } from '../../src/captionChannel';
import { createGoogleTranscript } from '../../shared/google-transcript.mjs';
import '../../src/styles.css';

// Dev-only, deterministic UI fixture. No microphone, credentials or API calls.
const tracker = createGoogleTranscript('ko', 'en');
const events = [
  { interimInputTranscription: { text: '서로 사랑' } },
  { interimInputTranscription: { text: '서로 사랑합시다' } },
  { inputTranscription: { text: '서로 사랑합시다.', finished: true } },
  { outputTranscription: { text: 'Let us love one another.', finished: true } },
  { interimInputTranscription: { text: '우리의 이웃을' } },
];
function threeSentences() {
  const sample = createGoogleTranscript('ko', 'en');
  for (let index = 1; index <= 6; index++) sample.apply({
    inputTranscription: { text: `${index}번째 말씀입니다.`, finished: true },
    outputTranscription: { text: `This is message number ${index}.`, finished: true },
  });
  return sample.apply({ interimInputTranscription: { text: '지금 다음 말씀을 듣고 있습니다. 이어서 음성을 인식하는 중입니다.' } })!.captions;
}
function Check() {
  const [step, setStep] = useState(0);
  const [caption, setCaption] = useState({ ...defaultCaption, live: true, showSource: true });
  return <main className="audience">
    <div className="audience-tools"><span>로컬 자막 검사 · 실제 마이크/API 사용 안 함 · {step}/5</span>
      <CaptionDisplayMode showSource={caption.showSource} onChange={showSource => setCaption(value => ({ ...value, showSource }))}/>
      <button disabled={step === events.length} onClick={() => {
        const result = tracker.apply(events[step]);
        setCaption(value => ({ ...value, frames: result.captions })); setStep(step + 1);
      }}>다음 단계</button>
      <button onClick={() => setCaption(value => ({ ...value, frames: threeSentences() }))}>세 문장 표시 검사</button>
    </div>
    <div className="audience-content"><CaptionFlow caption={caption}/></div>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Check/>);
