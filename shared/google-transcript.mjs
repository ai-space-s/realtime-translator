import { createRecognitionFlow, recognitionCaptionFrames } from './recognition-flow.mjs';

/** Google sends input/output transcripts independently, without guaranteed pairing.
 * Keep both histories intact; never pair them by arrival order or sentence count.
 */
export function createGoogleTranscript(sourceLocale, targetLocale) {
  const recognition = createRecognitionFlow(sourceLocale);
  let target = '', interimSource = '';
  let targetEnded = false;
  return {
    apply(content) {
      let changed = false;
      if (typeof content.interimInputTranscription?.text === 'string') {
        // Replace drafts, never append corrections to the permanent transcript.
        interimSource = content.interimInputTranscription.text;
        changed = true;
      }
      if (content.inputTranscription) {
        const part = content.inputTranscription;
        const text = typeof part.text === 'string' ? part.text : '';
        if (text || part.finished === true) {
          recognition.append(text, typeof part.finished === 'boolean' ? part.finished : undefined);
          // A final result in the same packet takes priority over its draft.
          interimSource = ''; changed = true;
        }
      }
      if (content.outputTranscription) {
        const part = content.outputTranscription;
        if (typeof part.text === 'string' && part.text) {
          const delta = `${targetEnded && target ? '\n\n' : ''}${part.text}`;
          target += delta;
          targetEnded = false; changed = true;
        }
        if (part.finished) targetEnded = true;
      }
      // Output completion is NOT an input-transcript boundary.
      if (content.turnComplete) targetEnded = true;
      if (!changed) return null;
      const state = recognition.snapshot();
      const captions = recognitionCaptionFrames(state.completed, target, interimSource || state.pending, sourceLocale, targetLocale, state.method);
      return { source: state.source, target, interimSource, interimTarget: '', captions };
    },
  };
}
