import { readFile, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = new URL("./app.ts", import.meta.url);
const output = new URL("./app.js", import.meta.url);
const typescript = await readFile(source, "utf8");
const javascript = stripTypeScriptTypes(typescript, { mode: "strip" }).replace(/[ \t]+$/gm, "");
await writeFile(output, `// Generated from app.ts by node build.mjs.\n${javascript}`);
