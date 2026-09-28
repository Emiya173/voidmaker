import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AvatarMotionRig,
  motionLimits,
  motionRigFile,
  validateMotionClip,
} from "../../contracts/src/character-motion.js";
import { assetPath, boundedFile } from "./character-assets.js";

/** Validate numeric resources once; IPC carries only bind data and local URLs. */
export async function readMotionRig(
  root: string,
  file: string,
  faceTargets?: readonly string[],
): Promise<AvatarMotionRig> {
  const rigPath = await assetPath(root, file);
  const bytes = await boundedFile(rigPath, motionLimits.rigBytes);
  const rig = motionRigFile.parse(JSON.parse(bytes.toString("utf8")));
  const hash = createHash("sha256").update(bytes);
  const clips = [];
  for (const descriptor of rig.clips) {
    const clipPath = await assetPath(dirname(rigPath), descriptor.file);
    const data = await boundedFile(clipPath, motionLimits.clipBytes);
    const clip = validateMotionClip(JSON.parse(data.toString("utf8")), rig.joints, descriptor.duration);
    if (faceTargets && clip.expression.some((key) => key.weight > 0) && !faceTargets.includes(descriptor.name))
      throw new Error("动作表情缺少对应形态槽");
    hash.update(createHash("sha256").update(data).digest());
    clips.push({ name: descriptor.name, url: pathToFileURL(clipPath).href, duration: descriptor.duration });
  }
  return { version: 1, assetKey: hash.digest("hex"), joints: rig.joints, clips };
}
