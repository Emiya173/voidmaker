import { convertPmx } from "./characters/pmx.js";

const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error("用法：pnpm character:pmx <模型.pmx> <新输出目录>");
console.log(JSON.stringify(await convertPmx(source, output), null, 2));
