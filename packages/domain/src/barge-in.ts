export type BargeState = Readonly<{ qualifyingMs: number; triggered: boolean; evidence: readonly number[] }>;
export const initialBarge: BargeState = { qualifyingMs: 0, triggered: false, evidence: [] };

export function advanceBarge(
  state: BargeState,
  frame: Readonly<{
    rawLevel: number;
    cleanLevel: number;
    referenceLevel: number;
    referenceFresh: boolean;
    durationMs: number;
  }>,
  config: Readonly<{ threshold: number; referenceRatio: number; confirmationMs: number }>,
): BargeState {
  if (state.triggered) return state;
  if (
    !frame.referenceFresh ||
    ![frame.rawLevel, frame.cleanLevel, frame.referenceLevel, frame.durationMs].every(Number.isFinite) ||
    frame.durationMs <= 0 ||
    frame.durationMs > 100 ||
    Math.min(frame.rawLevel, frame.cleanLevel, frame.referenceLevel) < 0
  )
    return initialBarge;
  const rawDominant =
    frame.rawLevel >= config.threshold && frame.rawLevel > frame.referenceLevel * config.referenceRatio * 2;
  const cleanSupport =
    frame.cleanLevel >= config.threshold / 2 && frame.cleanLevel > frame.referenceLevel * config.referenceRatio;
  // Very dominant raw speech can survive severe AEC suppression. This is still an energy heuristic.
  const qualifies = rawDominant && (cleanSupport || frame.rawLevel > frame.referenceLevel * config.referenceRatio * 4);
  const evidence = [...state.evidence, qualifies ? frame.durationMs : -frame.durationMs];
  let excess = evidence.reduce((total, item) => total + Math.abs(item), 0) - (config.confirmationMs + 150);
  while (excess > 0 && evidence.length) {
    const first = evidence[0] ?? 0;
    if (Math.abs(first) <= excess) {
      evidence.shift();
      excess -= Math.abs(first);
    } else {
      evidence[0] = Math.sign(first) * (Math.abs(first) - excess);
      excess = 0;
    }
  }
  const qualifyingMs = evidence.reduce((total, item) => total + Math.max(0, item), 0);
  return { evidence, qualifyingMs, triggered: qualifyingMs >= config.confirmationMs };
}
