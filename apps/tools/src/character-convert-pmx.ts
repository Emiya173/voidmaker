import { convertPmx } from "./characters/pmx.js";

const [source, output, flag, pose] = process.argv.slice(2);
if (
  !source ||
  !output ||
  (flag !== undefined && (flag !== "--pose" || !["original", "relaxed"].includes(pose ?? ""))) ||
  process.argv.length > 6
)
  throw new Error("用法：pnpm character:pmx <模型.pmx> <新输出目录> [--pose original|relaxed]");
console.log(
  JSON.stringify(
    await convertPmx(source, output, "あ", "まばたき", pose === "relaxed" ? "relaxed" : "original"),
    null,
    2,
  ),
);
