import { emptyCaptionFrames, sentenceRanges } from './caption-flow.mjs';

// Continuous transcript APIs do not always send an utterance-final event.
// Intl.Segmenter can confirm a preceding sentence once another sentence starts.
// A trailing period alone is ambiguous (3. + 14, Dr. + Smith), so keep it below
// until more text arrives. Explicit provider completion never needs punctuation.
function sentenceBoundary(text, locale) {
  const parts = sentenceRanges(text, locale);
  if (!parts.length) return 0;
  const last = parts.at(-1);
  if (/[!?。！？]["'”’»）)\]]*$/u.test(last.text)) return text.length;
  for (let index = parts.length - 2; index >= 0; index--) {
    // Segmenter can treat common English titles/initials as sentences even when
    // their following name is already present. Prefer keeping these below.
    if (/(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Rev|Sr|Jr|St|vs|e\.g|i\.e)|(?:^|\s)[A-Z])\.$/u.test(parts[index].text)) continue;
    return parts[index + 1].start;
  }
  return 0;
}

/** Separate received text from text ready for the middle panel.
 * Completion is a provider signal when available, otherwise a labeled sentence
 * boundary heuristic. Translation progress must never finalize recognition.
 */
export function createRecognitionFlow(locale = 'ko') {
  let source = '', committed = 0, ended = false, awaitingFinal = false;
  let method = 'provider';
  return {
    /** @param {string} delta @param {boolean|undefined} finished */
    append(delta = '', finished = undefined) {
      if (delta) {
        source += `${ended && source ? '\n\n' : ''}${delta}`;
        ended = false;
      }
      if (finished === true) {
        committed = source.length;
        ended = true;
        awaitingFinal = false;
        method = 'provider';
      } else if (finished === false) {
        awaitingFinal = true;
        method = 'provider';
      } else if (!awaitingFinal) {
        committed += sentenceBoundary(source.slice(committed), locale);
        method = 'sentence';
      }
      return this.snapshot();
    },
    snapshot() {
      return {
        source,
        // Full received source is retained for export, independently of display.
        completed: source.slice(Math.max(0, committed - 16000), committed),
        pending: source.slice(committed),
        method,
      };
    },
  };
}

/** Source completion and target arrival are independent clocks, not matching
 * sentence IDs. Never hold completed recognition below while awaiting output. */
export function recognitionCaptionFrames(completedSource, target, pendingSource = '', sourceLocale = 'ko', targetLocale = 'en', recognition = 'provider') {
  const frames = emptyCaptionFrames();
  frames.alignment = 'independent';
  frames.recognition = recognition;
  const sources = sentenceRanges(completedSource, sourceLocale).map(part => part.text);
  const targets = sentenceRanges(target.slice(-16000), targetLocale).map(part => part.text);
  frames.previous = { source: sources.slice(-6, -3), target: targets.slice(-6, -3) };
  frames.current = { source: sources.slice(-3), target: targets.slice(-3) };
  const pending = sentenceRanges(pendingSource, sourceLocale).map(part => part.text);
  frames.pending = pending.slice(0, 3);
  frames.pendingMore = Math.max(0, pending.length - 3);
  return frames;
}
