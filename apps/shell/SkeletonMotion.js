// Pure local-pose sampling and hierarchical FK. Quaternions are [w,x,y,z].
function unit(q) {
  const length = Math.hypot(q[0], q[1], q[2], q[3]);
  return q.map((v) => v / length);
}
function multiply(a, b) {
  return unit([
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ]);
}
function rotate(q, v) {
  const x = 2 * (q[2] * v[2] - q[3] * v[1]);
  const y = 2 * (q[3] * v[0] - q[1] * v[2]);
  const z = 2 * (q[1] * v[1] - q[2] * v[0]);
  return [
    v[0] + q[0] * x + q[2] * z - q[3] * y,
    v[1] + q[0] * y + q[3] * x - q[1] * z,
    v[2] + q[0] * z + q[1] * y - q[2] * x,
  ];
}
function slerp(a, b, amount) {
  let dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const target = dot < 0 ? b.map((value) => -value) : b;
  dot = Math.min(1, Math.abs(dot));
  if (dot > 0.9995) return unit(a.map((value, i) => value + amount * (target[i] - value)));
  const angle = Math.acos(dot),
    denominator = Math.sin(angle);
  const from = Math.sin((1 - amount) * angle) / denominator;
  const to = Math.sin(amount * angle) / denominator;
  return unit(a.map((value, i) => value * from + target[i] * to));
}
function interval(times, seconds) {
  if (seconds <= times[0]) return [0, 0, 0];
  const last = times.length - 1;
  if (seconds >= times[last]) return [last, last, 0];
  let low = 0,
    high = last;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle] <= seconds) low = middle;
    else high = middle;
  }
  return [low, high, (seconds - times[low]) / (times[high] - times[low])];
}
function vectorAt(times, values, seconds, quaternion) {
  const [a, b, amount] = interval(times, seconds);
  return quaternion
    ? slerp(values[a], values[b], amount)
    : values[a].map((value, i) => value + amount * (values[b][i] - value));
}
// biome-ignore lint/correctness/noUnusedVariables: QML module entry point.
function sample(joints, clip, seconds) {
  const local = joints.map((joint) => ({ translation: joint.translation, rotation: joint.rotation }));
  let expression = 0;
  if (clip && seconds >= 0 && seconds < clip.duration) {
    for (const track of clip.tracks) {
      if (track.translations)
        local[track.joint].translation = vectorAt(track.times, track.translations, seconds, false);
      if (track.rotations) local[track.joint].rotation = vectorAt(track.times, track.rotations, seconds, true);
    }
    if (clip.expression.length) {
      const [a, b, amount] = interval(
        clip.expression.map((frame) => frame.time),
        seconds,
      );
      expression = clip.expression[a].weight + amount * (clip.expression[b].weight - clip.expression[a].weight);
    }
  }
  const world = [];
  for (let index = 0; index < joints.length; index++) {
    const pose = local[index],
      parent = world[joints[index].parent];
    world.push(
      parent
        ? {
            translation: rotate(parent.rotation, pose.translation).map(
              (value, axis) => value + parent.translation[axis],
            ),
            rotation: multiply(parent.rotation, pose.rotation),
          }
        : { translation: pose.translation.slice(), rotation: unit(pose.rotation) },
    );
  }
  return { joints: world, expression: expression };
}
function finiteVector(value, size, quaternion) {
  return (
    Array.isArray(value) &&
    value.length === size &&
    value.every((n) => Number.isFinite(n) && Math.abs(n) <= 100000) &&
    (!quaternion || Math.abs(Math.hypot(...value) - 1) <= 0.001)
  );
}
function validTimes(times, duration) {
  return (
    Array.isArray(times) &&
    times.length > 0 &&
    times.length <= 4096 &&
    times.every((time, i) => Number.isFinite(time) && time >= 0 && time <= duration && (i === 0 || time > times[i - 1]))
  );
}
// Defense in depth for asynchronous files; the TS boundary owns full validation.
// biome-ignore lint/correctness/noUnusedVariables: QML module entry point.
function validClip(value, jointCount, duration) {
  if (
    value?.version !== 1 ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > 60 ||
    !Number.isInteger(jointCount) ||
    jointCount < 1 ||
    jointCount > 256 ||
    Math.abs(value.duration - duration) > 0.000001 ||
    !Array.isArray(value.tracks) ||
    value.tracks.length === 0 ||
    value.tracks.length > jointCount ||
    !Array.isArray(value.expression)
  )
    return false;
  const seen = {};
  let keys = 0;
  for (const track of value.tracks) {
    if (
      !track ||
      !Number.isInteger(track.joint) ||
      track.joint < 0 ||
      track.joint >= jointCount ||
      seen[track.joint] ||
      !validTimes(track.times, duration) ||
      (!track.rotations && !track.translations)
    )
      return false;
    seen[track.joint] = true;
    keys += track.times.length;
    if (keys > 131072) return false;
    for (const key of ["rotations", "translations"]) {
      if (
        track[key] !== undefined &&
        (!Array.isArray(track[key]) ||
          track[key].length !== track.times.length ||
          !track[key].every((v) => finiteVector(v, key === "rotations" ? 4 : 3, key === "rotations")))
      )
        return false;
    }
  }
  if (value.expression.length > 4096) return false;
  return value.expression.every(
    (frame, i) =>
      frame &&
      Number.isFinite(frame.time) &&
      frame.time >= 0 &&
      frame.time <= duration &&
      (i === 0 || frame.time > value.expression[i - 1].time) &&
      Number.isFinite(frame.weight) &&
      frame.weight >= 0 &&
      frame.weight <= 1,
  );
}
