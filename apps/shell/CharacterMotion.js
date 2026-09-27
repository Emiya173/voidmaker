// Deterministic small joint motions; no root translation or rotation.
// Periods divide 120 s, so the loop reconnects at the neutral pose.
// biome-ignore lint/correctness/noUnusedVariables: Imported by QML as Motion.sample.
function sample(seconds) {
  const t = Math.max(0, seconds);
  const tau = 2 * Math.PI;
  const start = Math.min(1, t / 1.2);
  const ease = start * start * (3 - 2 * start);
  const breath = (1 - Math.cos((tau * t) / 4.8)) * 0.5 * ease;
  const blinkTime = (t % 6) - 4.1;
  let blink = 0;
  if (blinkTime >= 0 && blinkTime < 0.09) blink = blinkTime / 0.09;
  else if (blinkTime >= 0.09 && blinkTime < 0.23) blink = 1 - (blinkTime - 0.09) / 0.14;
  return {
    breath: breath,
    chestPitch: -0.22 * breath,
    neckPitch: 0.12 * breath,
    headPitch: 0.55 * Math.sin((tau * t) / 8) * ease,
    headYaw: 1.6 * Math.sin((tau * t) / 12) * ease,
    headRoll: 0.35 * Math.sin((tau * t) / 15) * ease,
    eyePitch: 0.8 * Math.sin((tau * t) / 15) * ease * (1 - blink),
    eyeYaw: (2.4 * Math.sin((tau * t) / 10) + 0.5 * Math.sin((tau * t) / 4)) * ease * (1 - blink),
    blink: blink,
  };
}
