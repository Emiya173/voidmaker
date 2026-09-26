type Speaker = "assistant" | "user";
type Page = "chat" | "notes";
type PermissionChoice = "deny" | "once" | "always";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
}

const desktop = element<HTMLElement>("desktop");
const drawer = element<HTMLElement>("drawer");
const portrait = document.querySelector<HTMLImageElement>(".portrait")!;
const bubble = element<HTMLElement>("bubble");
const bubbleText = element<HTMLElement>("bubbleText");
const chatScroll = element<HTMLElement>("chatScroll");
const messageInput = element<HTMLInputElement>("messageInput");
const permissionCard = element<HTMLElement>("permissionCard");
const toast = element<HTMLElement>("toast");

let drawerOpen = false;
let currentPage: Page = "chat";
let clickCount = 0;
let replySequence = 0;
let bubbleTypingTimer: number | undefined;
let bubbleHideTimer: number | undefined;
let replyTimer: number | undefined;
let toastTimer: number | undefined;

function setDrawer(open: boolean): void {
  drawerOpen = open;
  desktop.classList.toggle("drawer-open", open);
  drawer.setAttribute("aria-hidden", String(!open));
  if (open && currentPage === "chat") window.setTimeout(() => messageInput.focus(), 320);
}

function setPage(page: Page): void {
  currentPage = page;
  element<HTMLElement>("chatPage").hidden = page !== "chat";
  element<HTMLElement>("notesPage").hidden = page !== "notes";
  document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
    const active = button.dataset.tab === page;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
}

function now(): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function updateClock(): void {
  element<HTMLElement>("clock").textContent = now();
}

function addMessage(speaker: Speaker, text: string): void {
  const message = document.createElement("div");
  message.className = `chat-message ${speaker}`;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.textContent = speaker === "assistant" ? "桜" : "你";

  const body = document.createElement("div");
  body.className = "message-body";
  const name = document.createElement("span");
  name.className = "message-name";
  name.textContent = speaker === "assistant" ? "夜樱" : "你";
  const content = document.createElement("p");
  content.textContent = text;
  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = now();
  body.append(name, content, time);
  message.append(avatar, body);
  chatScroll.append(message);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function setThinking(visible: boolean): void {
  document.querySelector(".typing-row")?.remove();
  if (!visible) return;
  const row = document.createElement("div");
  row.className = "typing-row";
  row.innerHTML = "<i></i><i></i><i></i><span>夜樱正在想……</span>";
  chatScroll.append(row);
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function hideBubble(): void {
  window.clearInterval(bubbleTypingTimer);
  window.clearTimeout(bubbleHideTimer);
  bubble.classList.remove("is-visible", "is-typing");
  bubble.setAttribute("aria-hidden", "true");
}

function showBubble(text: string): void {
  hideBubble();
  const characters = Array.from(text);
  let position = 0;
  bubbleText.textContent = "";
  bubble.classList.add("is-visible", "is-typing");
  bubble.setAttribute("aria-hidden", "false");
  bubbleTypingTimer = window.setInterval(() => {
    position = Math.min(position + 1, characters.length);
    bubbleText.textContent = characters.slice(0, position).join("");
    if (position === characters.length) {
      window.clearInterval(bubbleTypingTimer);
      bubble.classList.remove("is-typing");
      bubbleHideTimer = window.setTimeout(hideBubble, 5000);
    }
  }, 27);
}

function showToast(text: string): void {
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function replyTo(text: string): void {
  const clean = text.trim();
  if (!clean) return;
  setDrawer(true);
  setPage("chat");
  permissionCard.hidden = true;
  addMessage("user", clean);
  messageInput.value = "";
  setThinking(true);
  const sequence = ++replySequence;
  window.clearTimeout(replyTimer);
  replyTimer = window.setTimeout(() => {
    if (sequence !== replySequence) return;
    setThinking(false);
    const answer = "我在这里。气泡等会儿会消失，但我的位置不会变。想继续聊，打开旁边的侧栏就好。";
    addMessage("assistant", answer);
    showBubble(answer);
  }, 850);
}

function showPermission(): void {
  setDrawer(true);
  setPage("chat");
  permissionCard.hidden = false;
  showToast("权限请求已在侧栏中展开");
}

function answerPermission(choice: PermissionChoice): void {
  permissionCard.hidden = true;
  const labels: Record<PermissionChoice, string> = {
    deny: "已拒绝打开浏览器。",
    once: "已允许这一次打开浏览器。",
    always: "已记录：以后允许打开浏览器。",
  };
  addMessage("assistant", labels[choice]);
  showToast(labels[choice]);
}

function resetDemo(): void {
  ++replySequence;
  window.clearTimeout(replyTimer);
  setThinking(false);
  hideBubble();
  permissionCard.hidden = true;
  messageInput.value = "";
  chatScroll.querySelectorAll(".chat-message:not([data-initial])").forEach((item) => item.remove());
  clickCount = 0;
  element<HTMLElement>("clickCount").textContent = "0";
  setPage("chat");
  setDrawer(false);
  showToast("原型已重置");
}

portrait.addEventListener("click", () => setDrawer(!drawerOpen));
element<HTMLButtonElement>("closeDrawer").addEventListener("click", () => setDrawer(false));
element<HTMLButtonElement>("demoReply").addEventListener("click", () => replyTo("今天怎么样？"));
element<HTMLButtonElement>("demoPermission").addEventListener("click", showPermission);
element<HTMLButtonElement>("resetDemo").addEventListener("click", resetDemo);
element<HTMLFormElement>("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  replyTo(messageInput.value);
});
element<HTMLButtonElement>("desktopTarget").addEventListener("click", () => {
  clickCount += 1;
  element<HTMLElement>("clickCount").textContent = String(clickCount);
  showToast(`桌面收到了第 ${clickCount} 次点击，立绘没有移动`);
});
element<HTMLButtonElement>("mockMic").addEventListener("click", () => showToast("语音按钮交互示意；此原型不会调用麦克风"));
element<HTMLButtonElement>("mockSnip").addEventListener("click", () => showToast("截图按钮交互示意；此原型不会读取屏幕"));
document.querySelectorAll<HTMLButtonElement>(".tab").forEach((button) => {
  button.addEventListener("click", () => setPage(button.dataset.tab as Page));
});
document.querySelectorAll<HTMLButtonElement>("[data-permission]").forEach((button) => {
  button.addEventListener("click", () => answerPermission(button.dataset.permission as PermissionChoice));
});
document.addEventListener("keydown", (event) => {
  if (event.altKey && event.key.toLowerCase() === "p") {
    event.preventDefault();
    setDrawer(!drawerOpen);
  }
  if (event.key === "Escape" && drawerOpen) setDrawer(false);
});

updateClock();
window.setInterval(updateClock, 30_000);

// 静态截图与设计评审可用 ?state=expanded / permission / bubble。
const previewState = new URLSearchParams(window.location.search).get("state");
if (previewState === "expanded") {
  setDrawer(true);
  addMessage("user", "今天怎么样？");
  addMessage("assistant", "我在这里。气泡消失后，我依然会留在原处。");
} else if (previewState === "permission") {
  showPermission();
} else if (previewState === "bubble") {
  showBubble("我在这里。气泡会消失，但我的位置不会变。");
}
