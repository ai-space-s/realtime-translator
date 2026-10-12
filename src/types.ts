export type Provider = 'openai' | 'azure' | 'google';
export type Status = 'idle' | 'connecting' | 'live' | 'stopping';
import { emptyCaptionFrames, type CaptionFrames } from '../shared/caption-flow.mjs';
import { emptySermonSettings } from '../shared/sermon-context.mjs';
export type SermonSettings = ReturnType<typeof emptySermonSettings>;
export type SeminarSection = { id: string; title: string; page: number; slide: string; kind: string; source: string; target: string };
export type SeminarSettings = { name: string; sourceLanguage: string; targetLanguage: string; profile: SermonSettings['profile']; sections: SeminarSection[] };
export type SeminarControl = { index: number; mode: 'auto' | 'manual' | 'qa' };
export type QualitySegment = { number: number; source: string; target: string; status: string; review: string; referenceCount: number };
export type QualityState = { pending: number; reviews: string[]; segments: QualitySegment[] };
export type Transcript = { source: string; target: string; interimSource: string; interimTarget: string; captions: CaptionFrames; quality?: QualityState };
export type Session = {
  stop: () => Promise<void>;
  setMuted: (muted: boolean) => void;
};
export type SessionOptions = {
  source: string; target: string; deviceId: string; signal: AbortSignal;
  sermon?: SermonSettings;
  seminar?: SeminarSettings;
  getSeminarControl?: () => SeminarControl;
  onSeminarPosition?: (index: number, note: string) => void;
  onTranscript: (transcript: Transcript) => void;
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onEnded: () => void;
};
export const emptyTranscript = (): Transcript => ({ source: '', target: '', interimSource: '', interimTarget: '', captions: emptyCaptionFrames() });
