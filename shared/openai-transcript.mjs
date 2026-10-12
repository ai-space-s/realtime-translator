import { createRecognitionFlow, recognitionCaptionFrames } from './recognition-flow.mjs';

export function createOpenAITranscript(sourceLocale, targetLocale) {
  const recognition = createRecognitionFlow(sourceLocale);
  let target = '';
  return {
    apply(event) {
      if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
        recognition.append(event.delta);
      } else if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
        target += event.delta;
      } else return null;
      const state = recognition.snapshot();
      return {
        source: state.source, target, interimSource: '', interimTarget: '',
        captions: recognitionCaptionFrames(state.completed, target, state.pending, sourceLocale, targetLocale, 'sentence'),
      };
    },
  };
}
