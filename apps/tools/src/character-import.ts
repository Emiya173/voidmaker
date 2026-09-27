import { importCharacter } from "./characters/import.js";

const [source, destination, id, endpoint] = process.argv.slice(2);
if (!source || !destination || !id || !endpoint) {
  throw new Error("用法：pnpm character:import <角色.char> <新角色目录> <id> <专用回环 TTS URL>");
}
const character = await importCharacter(source, destination, id, endpoint);
console.log(`已导入 ${character.name}（${character.id}）；请为 voice/ 权重启动独立 GPT-SoVITS 服务。`);
