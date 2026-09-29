export type SpeechSegment = Readonly<{ subtitle: string; text: string; referenceId: string; portraitId?: string }>;
export type SpeechReference = Readonly<{
  id: string;
  description: string;
  refAudioPath: string;
  promptText: string;
  promptLanguage: string;
}>;
