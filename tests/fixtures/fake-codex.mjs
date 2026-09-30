import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });
let turnId = 0;
let threadParams;
let threadId = "thread";
let threadNumber = 0;
const threads = new Map();
const toolRequests = new Map();
let lastToolResult;
const complete = (status = "completed") => notify("turn/completed", { threadId, turn: { id: String(turnId), status } });

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({ id: message.id, result: {} });
  if (message.method === "config/read") send({ id: message.id, result: { config: { mcp_servers: { test: { enabled: true } }, apps: { test: { enabled: true } } } } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    threadParams = message.params;
    threadId = process.env.FAKE_CODEX_UNIQUE_THREADS === "1" ? (message.params.threadId ?? "thread-" + (++threadNumber)) : "thread";
    threads.set(threadId, threadParams);
    send({ id: message.id, result: { thread: { id: threadId } } });
  }
  if (message.method === "turn/start") {
    threadId = message.params.threadId;
    threadParams = threads.get(threadId);
    turnId += 1;
    send({ id: message.id, result: { turn: { id: String(turnId) } } });
    if (message.params.input[0].text === "crash") process.exit(2);
    if ((message.params.input[0].text === "wait" || message.params.input[0].text.startsWith("wait\n\n"))) return;
    if (message.params.input[0].text === "policy") {
      const chatSchema = message.params.outputSchema?.properties?.segments?.items?.properties?.subtitle;
      const policy = JSON.stringify(chatSchema ? {threadParams: {baseInstructions: threadParams.baseInstructions?.includes("LOCAL_MEMORY_FIXTURE") ? "LOCAL_MEMORY_FIXTURE" : ""}, turnParams: {threadId}} : {threadParams, turnParams: message.params});
      const text = chatSchema ? JSON.stringify({openingClipId: "none", segments: [{subtitle: policy, text: "確認できたよ。", referenceId: "neutral", portraitId: "neutral"}]}) : policy;
      notify("item/completed", { threadId, turnId: String(turnId), item: { type: "agentMessage", phase: "final_answer", text } });
      complete();
      return;
    }
    if (message.params.input[0].text === "approval") {
      send({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { threadId, turnId: String(turnId), command: "echo test" } });
      return;
    }
    if (["tool", "tool_wrong_thread", "tool_bad_args", "desktop_tool", "terminal_tool"].includes(message.params.input[0].text)) {
      const input = message.params.input[0].text;
      const requestId = "dynamic-" + turnId;
      const params = { threadId, turnId: String(turnId), callId: requestId, namespace: null, tool: "read_desktop", arguments: input === "tool_bad_args" ? { includeScreenshot: "invalid" } : { includeScreenshot: input === "desktop_tool" ? false : true } };
      if (input === "terminal_tool") {
        params.tool = "run_terminal";
        params.arguments = { command: "printf terminal-ok", cwd: null, timeoutSeconds: 2 };
      }
      toolRequests.set(requestId, { ...params, host: input === "desktop_tool" || (input === "terminal_tool" && !!message.params.outputSchema?.properties?.segments) });
      send({ id: requestId, method: "item/tool/call", params: { ...params, threadId: input === "tool_wrong_thread" ? "stale-thread" : threadId } });
      return;
    }
    if (message.params.input[0].text === "tool_result") {
      notify("item/completed", { threadId, turnId: String(turnId), item: { type: "agentMessage", phase: "final_answer", text: JSON.stringify(lastToolResult) } });
      complete(); return;
    }
    const structured = message.params.outputSchema?.properties?.segments;
    const reply = structured ? JSON.stringify({ openingClipId: "none", segments: [{ subtitle: "你好", text: "こんにちは。", referenceId: message.params.input[0].text === "bad_reply" ? "missing" : "neutral", portraitId: "neutral" }] }) : "你好";
    const params = { threadId, turnId: String(turnId) };
    notify("item/started", { ...params, item: { type: "agentMessage", id: "comment", phase: "commentary" } });
    notify("item/agentMessage/delta", { ...params, itemId: "comment", delta: "internal progress" });
    notify("item/started", { ...params, item: { type: "agentMessage", id: "final", phase: "final_answer" } });
    for (let i = 0; i < reply.length; i += 5) notify("item/agentMessage/delta", { ...params, itemId: "final", delta: reply.slice(i, i + 5) });
    notify("item/completed", { ...params, item: { type: "agentMessage", id: "final", phase: "final_answer", text: reply } });
    complete();
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    complete("interrupted");
  }
  if (toolRequests.has(message.id) && message.result) {
    const params = toolRequests.get(message.id); toolRequests.delete(message.id);
    lastToolResult = message.result;
    const summary = JSON.stringify(params.tool === "run_terminal" ? { success: message.result.success, stdout: message.result.success ? JSON.parse(message.result.contentItems[0].text).stdout : "" } : { success: message.result.success, sawContext: message.result.contentItems.some(item => item.text?.includes("fixture desktop context")) });
    const text = params.host ? JSON.stringify({ openingClipId: "none", segments: [{ subtitle: summary, text: "確認したよ。", referenceId: "neutral", portraitId: "neutral" }] }) : JSON.stringify(message.result);
    notify("item/completed", { threadId: params.threadId, turnId: params.turnId, item: { type: "agentMessage", phase: "final_answer", text } });
    notify("turn/completed", { threadId: params.threadId, turn: { id: params.turnId, status: "completed" } });
  }
  if (message.id === "approval-1" && message.result) {
    notify("item/completed", {
      threadId,
      turnId: String(turnId),
      item: { type: "agentMessage", id: "final", phase: "final_answer", text: message.result.decision },
    });
    complete();
  }
});
