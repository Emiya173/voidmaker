import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let turnId = 0;
let threadParams;
const complete = (status = "completed") => notify("turn/completed", { threadId: "thread", turn: { id: String(turnId), status } });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "config/read") send({ id: message.id, result: { config: { mcp_servers: { test: { enabled: true } }, apps: { test: { enabled: true } } } } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadParams = message.params;
    send({ id: message.id, result: { thread: { id: "thread" } } });
  }
  if (message.method === "turn/start") {
    turnId += 1;
    send({ id: message.id, result: { turn: { id: String(turnId) } } });
    if (message.params.input[0].text === "crash") process.exit(2);
    if (message.params.input[0].text === "wait") return;
    if (message.params.input[0].text === "policy") {
      notify("item/completed", { threadId: "thread", turnId: String(turnId), item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify({threadParams, turnParams: message.params}) } });
      complete();
      return;
    }
    if (message.params.input[0].text === "approval") {
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId: "thread", turnId: String(turnId), command: "echo test" } });
      return;
    }
    const params = { threadId: "thread", turnId: String(turnId) };
    notify("item/started", { ...params, item: { type: "agentMessage", id: "comment", phase: "commentary" } });
    notify("item/agentMessage/delta", { ...params, itemId: "comment", delta: "internal progress" });
    notify("item/started", { ...params, item: { type: "agentMessage", id: "final", phase: "final_answer" } });
    notify("item/agentMessage/delta", { ...params, itemId: "final", delta: "你好" });
    notify("item/completed", { ...params, item: { type: "agentMessage", id: "final", phase: "final_answer", text: "你好" } });
    complete();
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    complete("interrupted");
  }
  if (message.id === "approval-1" && message.result) {
    notify("item/completed", {
      threadId: "thread",
      turnId: String(turnId),
      item: { type: "agentMessage", id: "final", phase: "final_answer", text: message.result.decision },
    });
    complete();
  }
});
