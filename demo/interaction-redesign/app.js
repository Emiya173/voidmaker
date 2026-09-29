// Offline design prototype. Every voice, task and connection event is simulated.
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const params = new URLSearchParams(location.search);
const state = {
  mode: params.get('mode') === 'immersive' ? 'immersive' : 'companion',
  phase: 'idle', appearance: params.get('appearance') === 'model' ? 'model' : 'portrait', continuous: false, generation: 0,
  workGeneration: 0, work: 'draft', page: 'tasks', attached: false, log: true,
  companionExpanded: params.get('panel') === 'open', replyVisible: false,
  // null means no parallel transcript; an empty string is an intentionally cleared edit.
  lastReply: '嗯，存个档吧。今天想聊些什么？', pendingTranscript: null,
};
const labels = { idle: '待机', listening: '聆听中', transcribing: '识别中', review: '转写待确认', thinking: '思考中', speaking: '回应中', stopping: '停止中', offline: '未连接', error: '语音不可用' };
const frames = { idle: [0], listening: [3], transcribing: [4, 5], review: [4], thinking: [4, 5], speaking: [17, 18], stopping: [0], offline: [8], error: [8] };
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const busy = () => ['listening', 'transcribing', 'thinking', 'speaking', 'stopping'].includes(state.phase);
let toastTimer;
let replyTimer;
let spriteTick = 0;
const assetUrls = new Map();

function toast(text) {
  clearTimeout(toastTimer);
  $('toast').textContent = text;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 2500);
}
function later(delay, callback) {
  const generation = state.generation;
  setTimeout(() => { if (state.generation === generation) callback(); }, delay);
}
function setMode(mode) {
  state.mode = mode;
  if (mode === 'companion') closeWorkspace(false);
  render();
}
function setCompanionExpanded(expanded) {
  state.companionExpanded = expanded;
  render();
  (expanded ? $('input') : $('dockChat')).focus();
}
function focusCompanion() {
  (state.companionExpanded ? $('input') : $('dockChat')).focus();
}
function setPhase(phase) {
  const previous = state.phase;
  clearTimeout(replyTimer);
  state.phase = phase;
  if (phase === 'speaking') state.replyVisible = true;
  else if (phase === 'idle' && previous === 'speaking') {
    replyTimer = setTimeout(() => { state.replyVisible = false; render(); }, 5000);
  } else state.replyVisible = false;
  spriteTick = 0;
  if (phase === 'review') {
    const transcript = '先整理一下项目文档。';
    if ($('input').value.trim()) state.pendingTranscript = transcript;
    else { state.pendingTranscript = null; $('input').value = transcript; }
  }
  render();
}
function buttonLabel(id, label) {
  $(id).setAttribute('aria-label', label);
  $(id).dataset.tip = label;
}
function renderSprites() {
  const sequence = frames[state.phase] || frames.idle;
  const index = reducedMotion.matches || document.body.classList.contains('reduced-motion') ? 0 : spriteTick % sequence.length;
  const frame = sequence[index];
  document.documentElement.style.setProperty('--sprite-x', `${-(10 + (frame % 5) * 96)}px`);
  document.documentElement.style.setProperty('--sprite-y', `${-(11 + Math.floor(frame / 5) * 83)}px`);
  $('stage').dataset.frame = String(frame);
}
function render() {
  $('stage').dataset.mode = state.mode;
  $('stage').dataset.phase = state.phase;
  $('stage').dataset.appearance = state.appearance;
  $('stage').dataset.companionExpanded = String(state.companionExpanded);
  $('chat').hidden = state.mode === 'companion' && !state.companionExpanded;
  $('dockChat').setAttribute('aria-expanded', String(state.companionExpanded));
  $('stage').classList.toggle('log-hidden', !state.log && state.mode === 'immersive');
  $('appearanceLabel').textContent = state.appearance === 'portrait' ? '立绘' : '3D';
  $('appearance').setAttribute('aria-label', state.appearance === 'portrait' ? '角色显示：立绘，切换为 3D' : '角色显示：3D，切换为立绘');
  $('appearance').querySelector('use').setAttribute('href', state.appearance === 'portrait' ? '#i-image' : '#i-cube');
  $('renderNote').hidden = state.appearance !== 'model';
  document.querySelectorAll('button[data-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode)));
  $('historyToggle').setAttribute('aria-pressed', String(state.log));
  $('voiceMode').setAttribute('aria-pressed', String(state.continuous));
  buttonLabel('voiceMode', state.continuous ? '连续语音：开' : '连续语音：关');
  $('voiceMode').disabled = busy() || state.phase === 'offline';
  const capturing = state.phase === 'listening' || (state.continuous && ['thinking', 'speaking'].includes(state.phase));
  const captureText = capturing ? '录音中' : '麦克风已关闭';
  const wave = '<span class="wave" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  $('chatStatus').innerHTML = capturing ? `${wave}<span>${captureText}</span>` : icon('mic-off');
  $('chatStatus').setAttribute('aria-label', captureText);
  $('chatStatus').title = captureText;
  const micLabel = state.phase === 'listening' ? '结束说话' : busy() ? '停止' : '说话';
  for (const id of ['mic', 'dockMic']) {
    $(id).innerHTML = icon(state.phase === 'listening' ? 'check' : busy() ? 'stop' : 'mic');
    buttonLabel(id, micLabel);
    $(id).disabled = ['offline', 'error', 'stopping'].includes(state.phase);
  }
  $('send').innerHTML = icon(busy() ? 'stop' : 'arrow');
  buttonLabel('send', busy() ? '停止' : '发送');
  $('send').disabled = state.phase === 'offline' || state.phase === 'stopping' || (!busy() && (!$('input').value.trim() || state.pendingTranscript !== null));
  const reviewing = state.phase === 'review';
  const compactTranscript = reviewing ? state.pendingTranscript ?? $('input').value : '';
  const canSendTranscript = !!compactTranscript.trim();
  $('dockSend').innerHTML = icon(busy() ? 'stop' : 'arrow');
  buttonLabel('dockSend', busy() ? '停止' : '发送本次转写');
  $('dockSend').disabled = state.phase === 'stopping' || (!busy() && !canSendTranscript);
  $('dockSend').classList.toggle('ready', canSendTranscript && !busy());
  $('dockMic').setAttribute('aria-pressed', String(capturing));
  $('draftDot').hidden = !$('input').value.trim() && !state.pendingTranscript && !state.attached;
  buttonLabel('dockChat', state.phase === 'review' ? '展开对话面板' : $('draftDot').hidden ? '展开文字面板' : '展开文字面板 · 有草稿');
  $('compactBubble').hidden = !(reviewing || state.replyVisible);
  $('compactBubble').dataset.kind = reviewing ? 'transcript' : 'reply';
  $('compactBubble').setAttribute('aria-label', reviewing ? '你的转写，待发送' : '七海千秋的回复');
  $('compactTranscript').hidden = !reviewing;
  $('compactText').hidden = reviewing;
  // Avoid assigning unchanged input: keep the caret, selection and IME composition intact.
  if ($('transcriptInput').value !== compactTranscript) $('transcriptInput').value = compactTranscript;
  $('compactText').textContent = state.lastReply.match(/[^。！？!?]+[。！？!?]?/u)?.[0] || state.lastReply;
  resizeTranscript();
  const dockNotices = { transcribing: '识别中…', thinking: '回应中…', stopping: '停止中…', offline: '未连接', error: '语音不可用' };
  $('dockStatus').innerHTML = capturing ? `${wave}<span>录音中</span>` : dockNotices[state.phase] || '';
  $('dockStatus').hidden = !capturing && !dockNotices[state.phase];
  $('input').placeholder = state.phase === 'offline' ? '草稿会保留…' : '说点什么…';
  $('attach').disabled = busy() || state.phase === 'offline';
  $('contextChip').hidden = !state.attached;
  const notices = { transcribing: '识别中…', thinking: '回应中…', stopping: '停止中…', review: '确认后发送', offline: '连接中断 · 草稿已保留', error: '语音不可用 · 可继续打字' };
  $('feedback').hidden = !notices[state.phase] && state.pendingTranscript === null;
  if (state.pendingTranscript !== null) {
    $('feedback').innerHTML = '<span>转写已就绪</span><p class="transcript-preview"></p><button data-transcript="replace">替换</button> <button data-transcript="append">追加</button> <button data-transcript="discard">放弃</button>';
    $('feedback').querySelector('.transcript-preview').textContent = state.pendingTranscript;
  } else $('feedback').textContent = notices[state.phase] || '';
  $('caption').hidden = state.mode === 'companion';
  $('captionMeta').textContent = state.phase === 'idle' ? '上一句，已结束' : labels[state.phase];
  $('captionActivity').title = labels[state.phase];
  const captions = { listening: '我在听。', transcribing: '…', review: '这句话，需要改一下吗？', thinking: '…', stopping: '…', offline: '连接断开了。', error: '先用文字聊吧。' };
  $('captionText').textContent = captions[state.phase] || state.lastReply;
  $('attentionDot').hidden = state.work !== 'permission';
  $('workCount').hidden = state.work !== 'permission';
  $('dockAttention').hidden = state.work !== 'permission';
  buttonLabel('dockWork', state.work === 'permission' ? '任务：待审批' : '任务');
  buttonLabel('immersiveWork', state.work === 'permission' ? '任务：待审批' : '任务');
  buttonLabel('companionWork', state.work === 'permission' ? '任务：待审批' : '任务');
  if ([...$('scenario').options].some((option) => option.value === state.phase)) $('scenario').value = state.phase;
  else $('scenario').selectedIndex = -1;
  renderSprites();
}
function resizeTranscript() {
  const input = $('transcriptInput');
  if (!input.getClientRects().length) return;
  const scrollTop = input.scrollTop;
  input.style.height = 'auto';
  input.style.height = `${Math.min(120, Math.max(30, input.scrollHeight + 2))}px`;
  input.scrollTop = scrollTop;
}
function stop() {
  state.generation++;
  state.continuous = false;
  state.pendingTranscript = null;
  setPhase('stopping');
  later(300, () => {
    state.lastReply = '嗯，我们停一下。';
    setPhase('idle');
  });
}
function startVoice() {
  if (state.phase === 'listening') {
    state.generation++;
    setPhase('transcribing');
    later(700, () => {
      if (state.continuous) {
        if ($('input').value.trim()) {
          state.continuous = false;
          setPhase('review');
        } else {
          setPhase('review');
          if (state.mode === 'companion' && !state.companionExpanded) sendCompact();
          else send();
        }
      } else {
        setPhase('review');
        if (state.mode === 'immersive' || state.companionExpanded) $('input').focus();
      }
    });
  } else if (busy()) stop();
  else if (!['offline', 'error'].includes(state.phase)) {
    state.generation++;
    setPhase('listening');
  }
}
function appendMessage(role, text) {
  const list = $('conversation');
  const wasAtEnd = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const article = document.createElement('article');
  article.className = `message ${role}`;
  article.setAttribute('aria-label', role === 'user' ? '你' : '七海千秋');
  const body = document.createElement('p');
  body.textContent = text;
  article.append(body);
  list.append(article);
  if (wasAtEnd || role === 'user') list.scrollTop = list.scrollHeight;
}
function send() {
  if (busy()) { stop(); return; }
  if (state.pendingTranscript !== null) return;
  submitMessage($('input').value.trim(), false, true);
}
function sendCompact() {
  if (busy()) { stop(); return; }
  if (state.phase !== 'review') return;
  // Send only the visible voice text. An existing typed draft and its attachment stay private.
  submitMessage((state.pendingTranscript ?? $('input').value).trim(), state.pendingTranscript !== null, false);
  if (state.phase === 'thinking') $('dockSend').focus();
}
function submitMessage(text, preserveDraft, includeContext) {
  if (!text || state.phase === 'offline') return;
  state.generation++;
  appendMessage('user', text + (includeContext && state.attached ? ' ［截图］' : ''));
  if (!preserveDraft) $('input').value = '';
  if (includeContext) state.attached = false;
  state.pendingTranscript = null;
  setPhase('thinking');
  later(1400, () => {
    state.lastReply = '嗯，一步一步来，我陪你一起。';
    appendMessage('assistant', state.lastReply);
    setPhase('speaking');
    later(3900, () => setPhase(state.continuous ? 'listening' : 'idle'));
  });
}
function closeWorkspace(focus = true) {
  $('workspace').hidden = true;
  $('chat').inert = false;
  if (focus) $('immersiveWork').focus();
}
function openWorkspace(page = 'tasks') {
  setMode('immersive');
  state.page = page;
  renderWorkspace();
  $('workspace').hidden = false;
  $('chat').inert = true;
  $('closeWork').focus();
}
function renderWorkspace() {
  const titles = { tasks: '任务', sessions: '会话与记忆', settings: '设置' };
  $('workspaceTitle').textContent = titles[state.page];
  document.querySelectorAll('[data-page]').forEach((button) => {
    button.classList.toggle('active', button.dataset.page === state.page);
    button.setAttribute('aria-pressed', String(button.dataset.page === state.page));
  });
  if (state.page === 'sessions') {
    $('workContent').innerHTML = `<div class="session-row">${icon('chat')}<div>今天<small>当前会话</small></div><button data-action="return-chat" aria-label="返回当前会话">↗</button></div><div class="session-row">${icon('chat')}<div>周末计划<small>昨天</small></div><button data-action="history">查看</button></div><section class="settings-group"><div class="setting-row"><span>角色记忆</span><button data-action="memory">查看</button></div></section>`;
  } else if (state.page === 'settings') {
    $('workContent').innerHTML = `<section class="settings-group"><div class="setting-row"><span>减少动效</span><button data-action="motion" role="switch" aria-checked="${document.body.classList.contains('reduced-motion')}">${document.body.classList.contains('reduced-motion') ? '开' : '关'}</button></div></section><section class="settings-group"><div class="setting-row"><span>角色显示</span><button data-action="appearance">${state.appearance === 'portrait' ? '立绘' : '3D'}</button></div></section><section class="settings-group"><div class="setting-row"><span>连续语音</span><button data-action="voice-setting" role="switch" aria-checked="${state.continuous}">${state.continuous ? '开' : '关'}</button></div><p>开启后，转写自动发送。</p></section><section class="settings-group"><div class="setting-row"><span>服务与设备</span><button data-action="diagnostics">检查</button></div></section><section class="settings-group"><div class="setting-row"><span>角色素材</span><button data-action="character">载入</button></div></section>`;
  } else {
    const workLabels = { draft: '草稿', running: '进行中', permission: '待审批', completed: '已完成', cancelled: '已停止' };
    let detail = '';
    if (state.work === 'draft') detail = '<div class="button-row"><button class="primary" data-action="start-work">开始</button><button class="secondary" data-action="return-chat">返回</button></div>';
    if (state.work === 'running') detail = `<ul class="progress-list"><li>${icon('check')} 范围已确认</li><li>检查文档…</li></ul><button class="danger" data-action="cancel-work">停止</button>`;
    if (state.work === 'permission') detail = '<div class="permission"><h4>允许修改这个文件？</h4><p><code>docs/index.md</code></p><p class="subtle">更新文档索引。停止任务不会撤回已写入的修改。</p><div class="button-row"><button class="primary" data-action="approve">允许一次</button><button class="secondary" data-action="deny">拒绝</button></div></div>';
    if (state.work === 'completed') detail = `<div class="artifact">${icon('check')} <b>docs/index.md</b><p class="subtle">产物已验证 · 模拟</p><pre># 项目文档\n\n- 快速开始\n- 角色与语音\n- 桌面上下文</pre></div><div class="button-row"><button class="secondary" data-action="reset-work">重置演示</button></div>`;
    if (state.work === 'cancelled') detail = '<p class="subtle">已停止。已发生的修改会保留。</p><div class="button-row"><button class="secondary" data-action="reset-work">重新准备</button></div>';
    $('workContent').innerHTML = `<div class="work-title"><h3>文档索引</h3><span class="badge ${state.work === 'permission' ? 'warning' : ''}">${workLabels[state.work]}</span></div><dl class="task-facts"><dt>项目</dt><dd>示例项目</dd><dt>读取</dt><dd><code>docs/</code></dd><dt>写入</dt><dd><code>docs/index.md</code></dd></dl>${detail}<details><summary>详情</summary><p>范围：~/Projects/example。完成条件：索引存在、内容非空、链接有效。本原型不写入实际文件。</p></details><div class="finished-task">${icon('check')}<span>昨日笔记</span><small>已完成</small></div>`;
  }
  render();
}
function updateWork(next) {
  state.workGeneration++;
  state.work = next;
  renderWorkspace();
}
function scheduleWork(next, delay) {
  const generation = state.workGeneration;
  setTimeout(() => {
    if (generation !== state.workGeneration) return;
    updateWork(next);
    if (next === 'completed') toast('任务完成');
  }, delay);
}
function changeAppearance() {
  state.appearance = state.appearance === 'portrait' ? 'model' : 'portrait';
  render();
}

// Atlas display only: CSS clips the original sheet. No source pixels are edited.
for (const img of document.querySelectorAll('.sprite > img')) {
  const failed = () => { img.hidden = true; img.parentElement.dataset.missing = 'true'; };
  img.addEventListener('error', failed);
  img.addEventListener('load', () => { img.hidden = false; delete img.parentElement.dataset.missing; });
  if (img.complete && img.naturalWidth === 0) failed();
}
for (const [id, fallback] of [['portrait', 'portraitFallback'], ['modelPreview', 'modelFallback']]) {
  const updateAsset = () => {
    const loaded = $(id).naturalWidth > 0;
    $(id).hidden = !loaded;
    $(fallback).hidden = loaded;
  };
  $(id).addEventListener('load', updateAsset);
  $(id).addEventListener('error', updateAsset);
  if ($(id).complete) updateAsset();
}
$('assetLoad').addEventListener('click', () => $('assetInput').click());
$('assetInput').addEventListener('change', async () => {
  for (const file of $('assetInput').files) {
    const url = URL.createObjectURL(file);
    const probe = new Image();
    probe.src = url;
    try { await probe.decode(); } catch { URL.revokeObjectURL(url); toast('图片无法读取'); continue; }
    const kind = probe.width === 490 && probe.height === 343 ? 'sprite' : 'portrait';
    if (file.name.toLowerCase() === 'pixel.png' && kind !== 'sprite') {
      URL.revokeObjectURL(url); toast('像素图尺寸应为 490 × 343'); continue;
    }
    if (assetUrls.has(kind)) URL.revokeObjectURL(assetUrls.get(kind));
    assetUrls.set(kind, url);
    if (kind === 'sprite') document.querySelectorAll('.sprite > img').forEach((img) => { img.src = url; });
    else $('portrait').src = url;
  }
  $('assetInput').value = '';
});

document.querySelectorAll('button[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
document.querySelectorAll('[data-page]').forEach((button) => button.addEventListener('click', () => { state.page = button.dataset.page; renderWorkspace(); }));
$('scenario').addEventListener('change', (event) => { state.generation++; state.continuous = false; state.pendingTranscript = null; setPhase(event.target.value); });
$('input').addEventListener('input', render);
$('transcriptInput').addEventListener('input', () => {
  if (state.phase !== 'review') return;
  if (state.pendingTranscript !== null) state.pendingTranscript = $('transcriptInput').value;
  else $('input').value = $('transcriptInput').value;
  render();
});
$('transcriptInput').addEventListener('keydown', (event) => {
  if (event.isComposing) return;
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (state.phase === 'review') sendCompact();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    $('dockChat').focus();
  }
});
window.addEventListener('resize', resizeTranscript);
$('input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!busy()) send(); }
});
$('feedback').addEventListener('click', (event) => {
  const action = event.target.closest('[data-transcript]')?.dataset.transcript;
  if (!action) return;
  if (action === 'replace') $('input').value = state.pendingTranscript;
  if (action === 'append') $('input').value += `\n${state.pendingTranscript}`;
  state.pendingTranscript = null;
  render();
  $('input').focus();
});
$('send').addEventListener('click', send);
for (const id of ['mic', 'dockMic']) $(id).addEventListener('click', startVoice);
$('expand').addEventListener('click', () => { setMode('immersive'); $('input').focus(); });
$('collapse').addEventListener('click', () => { setMode('companion'); focusCompanion(); });
$('dockChat').addEventListener('click', () => setCompanionExpanded(true));
$('foldCompanion').addEventListener('click', () => setCompanionExpanded(false));
$('dockSend').addEventListener('click', sendCompact);
$('dockExpand').addEventListener('click', () => { setMode('immersive'); $('input').focus(); });
for (const id of ['historyToggle', 'closeChat']) $(id).addEventListener('click', () => { state.log = !state.log; render(); });
for (const id of ['companionWork', 'dockWork', 'immersiveWork', 'taskLink']) $(id).addEventListener('click', () => openWorkspace('tasks'));
for (const id of ['companionSettings', 'immersiveSettings']) $(id).addEventListener('click', () => openWorkspace('settings'));
$('sessionButton').addEventListener('click', () => openWorkspace('sessions'));
$('closeWork').addEventListener('click', () => closeWorkspace());
$('appearance').addEventListener('click', changeAppearance);
$('voiceMode').addEventListener('click', () => { state.continuous = !state.continuous; toast(state.continuous ? '连续语音：转写自动发送' : '单次语音：确认后发送'); render(); });
$('attach').addEventListener('click', () => { $('contextDialog').returnValue = ''; $('contextDialog').showModal(); });
$('contextDialog').addEventListener('close', () => {
  if ($('contextDialog').returnValue === 'attach') { state.attached = true; render(); $('input').focus(); }
});
$('removeContext').addEventListener('click', () => { state.attached = false; render(); });
$('desktopTarget').addEventListener('click', () => toast('桌面收到点击'));
$('workContent').addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  if (action === 'return-chat') { closeWorkspace(false); $('input').focus(); }
  if (action === 'start-work') { updateWork('running'); scheduleWork('permission', 1200); }
  if (['cancel-work', 'deny'].includes(action)) updateWork('cancelled');
  if (action === 'reset-work') updateWork('draft');
  if (action === 'approve') { updateWork('running'); scheduleWork('completed', 1200); }
  if (action === 'motion') { document.body.classList.toggle('reduced-motion'); renderWorkspace(); }
  if (action === 'appearance') { changeAppearance(); renderWorkspace(); }
  if (action === 'voice-setting') {
    if (busy()) toast('请先停止当前语音');
    else { state.continuous = !state.continuous; renderWorkspace(); }
  }
  if (action === 'diagnostics') toast('模拟：服务已连接');
  if (action === 'character') $('assetInput').click();
  if (action === 'memory') toast('本角色：喜欢先看计划再执行');
  if (action === 'history') toast('示例：周末去散步');
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || $('contextDialog').open) return;
  if (busy()) stop();
  else if (!$('workspace').hidden) closeWorkspace();
  else if (state.mode === 'immersive') { setMode('companion'); focusCompanion(); }
  else if (state.companionExpanded) setCompanionExpanded(false);
});
setInterval(() => {
  if (document.hidden || reducedMotion.matches || document.body.classList.contains('reduced-motion')) return;
  if ((frames[state.phase]?.length || 0) < 2) return;
  spriteTick++;
  renderSprites();
}, 450);
reducedMotion.addEventListener('change', renderSprites);
setPhase(Object.hasOwn(labels, params.get('state')) ? params.get('state') : 'idle');
