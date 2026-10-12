import { emptyCaptionFrames, type CaptionFrames } from '../shared/caption-flow.mjs';

export type CaptionState = {
  frames: CaptionFrames; sourceLanguage: string; targetLanguage: string; fontSize: number; showSource: boolean; hidden: boolean;
  title: string; language: string; live: boolean; demo: boolean;
};
export const defaultCaption: CaptionState = { frames: emptyCaptionFrames(), sourceLanguage: 'ko', targetLanguage: 'en', fontSize: 56, showSource: false, hidden: false, title: '라이브 번역 자막', language: 'English', live: false, demo: false };
export const channelName = (id: string) => `between-captions-${id}`;
