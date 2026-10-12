/** @typedef {{source: string[], target: string[]}} CaptionBlock */
/** @typedef {{previous: CaptionBlock, current: CaptionBlock, pending: string[], pendingMore: number, alignment: 'utterance'|'time'|'none'|'independent', recognition?: string}} CaptionFrames */
/** @typedef {{text: string, time: number|null}} TimedText */

/** @returns {CaptionFrames} */
export function emptyCaptionFrames() {
  return { previous: { source: [], target: [] }, current: { source: [], target: [] }, pending: [], pendingMore: 0, alignment: 'none' };
}

// Keep the unfinished last sentence visible. Intl.Segmenter handles CJK punctuation
// and decimals without assuming source/translation have equal sentence counts.
export function sentenceRanges(text, locale = 'en') {
  const segmenter = new Intl.Segmenter(locale, { granularity: 'sentence' });
  return Array.from(segmenter.segment(text), ({ segment, index }) => ({
    text: segment.trim(), start: index, end: index + segment.trimEnd().length,
  })).filter(part => part.text);
}

const texts = (text, locale) => sentenceRanges(text, locale).map(part => part.text);
const windows = sentences => ({ previous: sentences.slice(-6, -3), current: sentences.slice(-3) });
function setPending(frames, text, locale) {
  const pending = texts(text, locale);
  frames.pending = pending.slice(0, 3);
  frames.pendingMore = Math.max(0, pending.length - 3);
}

/** Build captions from provider-confirmed utterance pairs (Azure and demo).
 * @param {{source: string, target: string}[]} pairs
 * @returns {CaptionFrames}
 */
export function pairedCaptionFrames(pairs, pendingSource = '', sourceLocale = 'ko', targetLocale = 'en') {
  const frames = emptyCaptionFrames();
  frames.alignment = 'utterance';
  let target = '';
  const entries = pairs.map(pair => {
    const start = target.length;
    target += pair.target + '\n\n';
    return { ...pair, start, end: target.length };
  });
  for (const [name, sentences] of Object.entries(windows(sentenceRanges(target, targetLocale)))) {
    const first = sentences[0];
    const last = sentences.at(-1);
    const source = first && last ? entries.filter(entry => entry.start < last.end && entry.end > first.start).map(entry => entry.source).join('\n\n') : '';
    frames[name] = { target: sentences.map(part => part.text), source: texts(source, sourceLocale).slice(-3) };
  }
  // A recognized source must move up even if its translation has not arrived.
  // In that case, do not imply that the latest target belongs to that source.
  if (pairs.some(pair => !pair.target.trim())) {
    frames.alignment = 'independent';
    const sources = windows(texts(pairs.map(pair => pair.source).join('\n\n'), sourceLocale));
    frames.previous.source = sources.previous;
    frames.current.source = sources.current;
  }
  setPending(frames, pendingSource, sourceLocale);
  return frames;
}

/** Keep only the recent alignment buffer; the full recording lives in Transcript.
 * Equal timestamps are NOT event IDs. All append-only deltas must be retained.
 * @param {TimedText[]} parts
 */
export function appendTimedText(parts, delta, elapsed) {
  if (!delta) return;
  const time = typeof elapsed === 'number' && Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  const last = parts.at(-1);
  if (last && last.time === time) last.text += delta;
  else parts.push({ text: delta, time });
  let length = parts.reduce((sum, part) => sum + part.text.length, 0);
  while (parts.length > 1 && (length - parts[0].text.length >= 12000 || parts.length > 4000)) length -= parts.shift().text.length;
  // A provider can emit a long stretch without timing metadata.
  if (parts.length === 1 && parts[0].text.length > 16000) parts[0].text = parts[0].text.slice(-16000);
}

/** Time alignment is approximate, not a word-for-word translation boundary.
 * @param {TimedText[]} sourceParts
 * @param {TimedText[]} targetParts
 * @returns {CaptionFrames}
 */
export function timedCaptionFrames(sourceParts, targetParts, sourceLocale = 'ko', targetLocale = 'en') {
  const frames = emptyCaptionFrames();
  let offset = 0;
  const targetSpans = targetParts.map(part => {
    const span = { ...part, start: offset, end: offset + part.text.length };
    offset = span.end;
    return span;
  });
  const sentences = sentenceRanges(targetParts.map(part => part.text).join(''), targetLocale);
  let sourceOffset = 0;
  const sourceSpans = sourceParts.map(part => {
    sourceOffset += part.text.length;
    return { ...part, end: sourceOffset };
  });
  const sourceSentences = sentenceRanges(sourceParts.map(part => part.text).join(''), sourceLocale).map(sentence => ({
    ...sentence, time: sourceSpans.find(part => part.end >= sentence.end)?.time ?? null,
  }));
  const aligned = sourceParts.every(part => part.time !== null) && targetParts.every(part => part.time !== null);
  frames.alignment = aligned ? 'time' : 'none';
  for (const [name, group] of Object.entries(windows(sentences))) {
    frames[name].target = group.map(part => part.text);
    if (!group.length || !aligned) continue;
    const firstIndex = sentences.indexOf(group[0]);
    const before = sentences[firstIndex - 1];
    const from = before ? targetSpans.find(part => part.end >= before.end)?.time ?? -Infinity : -Infinity;
    const through = targetSpans.find(part => part.end >= group.at(-1).end)?.time ?? -Infinity;
    frames[name].source = sourceSentences.filter(part =>
      (part.time > from || from === through && part.time === through) && part.time <= through
    ).map(part => part.text).slice(-3);
  }
  if (aligned) {
    const translatedThrough = targetParts.at(-1)?.time ?? -Infinity;
    // Keep complete source sentences, not a suffix cut midway through a token
    // when the translation timestamp catches up within that sentence.
    const pending = sourceSentences.filter(part => part.time > translatedThrough).map(part => part.text);
    frames.pending = pending.slice(0, 3);
    frames.pendingMore = Math.max(0, pending.length - 3);
  } else {
    // Without timing, display the latest source explicitly as unaligned. Never
    // infer the translation backlog from sentence counts in different languages.
    frames.current.source = texts(sourceParts.map(part => part.text).join(''), sourceLocale).slice(-3);
  }
  return frames;
}
