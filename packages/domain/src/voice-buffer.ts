/** Raw 30 ms frames are immutable to callers. Clean/reference frames never enter this buffer. */
export type VoiceBuffer<T> = Readonly<{ recent: readonly T[]; interrupted: readonly T[] | null }>;
export const initialVoiceBuffer = <T>(): VoiceBuffer<T> => ({ recent: [], interrupted: null });
export function voiceBufferLimits(confirmationMs: number) {
  // Soft syllables may precede qualifying interrupt evidence by over a second.
  // Retention does not lower the detector threshold or delay playback cancellation.
  const recentFrames = Math.max(50, Math.ceil((confirmationMs + 300) / 30));
  return { recentFrames, maximumFrames: recentFrames + 47 };
}
export function appendVoiceFrame<T>(state: VoiceBuffer<T>, frame: T, limits = voiceBufferLimits(300)): VoiceBuffer<T> {
  if (state.interrupted && state.interrupted.length >= limits.maximumFrames)
    throw new Error("打断播报后的录音衔接超时，请重试");
  return {
    recent: [...state.recent.slice(-(limits.recentFrames - 1)), frame],
    interrupted: state.interrupted ? [...state.interrupted, frame] : null,
  };
}
export function interruptVoiceBuffer<T>(state: VoiceBuffer<T>): VoiceBuffer<T> {
  return { ...state, interrupted: state.interrupted ?? [...state.recent] };
}
export function takeVoiceBuffer<T>(state: VoiceBuffer<T>): Readonly<{ frames: readonly T[]; state: VoiceBuffer<T> }> {
  return { frames: state.interrupted ?? [], state: { ...state, interrupted: null } };
}
