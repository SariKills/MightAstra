import { telegramLaunchData, waitForTelegram } from "/telegram-launch.js";

let tg = window.Telegram?.WebApp;
let initData = "";
const app = document.getElementById("app");
const SIGN = "MightAstraAI";
const icons = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5Z"/>',
  bolt: '<path d="m13 2-3 8H4l7 12 3-8h6L13 2Z"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2-1 3v3l-4 2-3-2-3-1-3-1v-4l2-2 1-3 1-3Z"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  arrow: '<path d="m5 12 14 0m-6-6 6 6-6 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.chat}</svg>`; }
let sending = false;

const state = {
  me: null,
  isAdmin: false,
  view: "list", // admin: list | chat | templates | settings ; person: person
  filter: "all",
  q: "",
  contacts: [],
  totalUnread: 0,
  chatId: null,
  contact: null,
  lastId: 0,
  rendered: new Set(),
  quickReplies: [],
  online: true,
};

/* ------------------------------- utils ------------------------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function haptic(type = "light") {
  try {
    if (type === "success" || type === "error" || type === "warning") tg?.HapticFeedback?.notificationOccurred(type);
    else tg?.HapticFeedback?.impactOccurred(type);
  } catch {}
}

let toastTimer;
function toast(text, isErr = false) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = "toast"), 2600);
}

function supports(v) {
  try {
    return !!tg?.isVersionAtLeast?.(v);
  } catch {
    return false;
  }
}

function confirmBox(text) {
  return new Promise((resolve) => {
    if (supports("6.2")) tg.showConfirm(text, (ok) => resolve(ok));
    else resolve(window.confirm(text));
  });
}

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "content-type": "application/json", "x-init-data": initData, ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Ошибка ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function setOnline(ok) {
  if (state.online === ok) return;
  state.online = ok;
  document.querySelectorAll(".live").forEach((el) => {
    el.classList.toggle("off", !ok);
    el.textContent = ok ? "онлайн" : "нет связи…";
  });
}

function nameOf(c) {
  const n = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return n || (c.username ? "@" + c.username : "ID " + c.id);
}

const COLORS = ["#ffd479", "#5fe1ff", "#b78bff", "#5ef0b0", "#ff9e7a", "#ff8fc7", "#9fb4ff"];
function avatar(c) {
  const letter = (nameOf(c).replace("@", "")[0] || "?").toUpperCase();
  return `<div class="avatar" style="background:${COLORS[Math.abs(Number(c.id)) % COLORS.length]}">${esc(letter)}</div>`;
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function fmtShort(d) {
  const date = new Date(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return fmtTime(d);
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
function fmtDay(d) {
  const date = new Date(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Сегодня";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
}

/* ------------------------------- back button ------------------------------- */

let backHandler = null;
function setBack(fn) {
  if (!tg?.BackButton) return;
  if (backHandler) tg.BackButton.offClick(backHandler);
  backHandler = fn;
  if (fn) {
    tg.BackButton.onClick(fn);
    tg.BackButton.show();
  } else tg.BackButton.hide();
}

/* ------------------------------- shared chat ------------------------------- */

let lastDay = "";
function bubbleHtml(m, { personView }) {
  const out = m.direction === "out";
  const cls = personView ? (out ? "in" : "out") : out ? "out" : "in";
  const sig = out ? `<div class="sig">✦ ${SIGN}</div>` : "";
  return `<div class="bubble ${cls}" data-id="${m.id ?? ""}">${sig}${esc(m.text)}<div class="t">${fmtTime(m.createdAt)}</div></div>`;
}

function appendMessages(list, { personView = false } = {}) {
  const box = document.getElementById("messages");
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  let added = false;
  for (const m of list) {
    state.lastId = Math.max(state.lastId, m.id);
    if (state.rendered.has(m.id)) continue;
    state.rendered.add(m.id);
    const day = fmtDay(m.createdAt);
    if (day !== lastDay) {
      lastDay = day;
      box.insertAdjacentHTML("beforeend", `<div class="day">${esc(day)}</div>`);
    }
    box.insertAdjacentHTML("beforeend", bubbleHtml(m, { personView }));
    added = true;
    if (!m._own && ((personView && m.direction === "out") || (!personView && m.direction === "in"))) haptic("light");
  }
  if (added) box.querySelector(".empty")?.remove();
  if (added && (nearBottom || list.some((m) => m._own))) box.scrollTop = box.scrollHeight;
}

function resetChat() {
  state.lastId = 0;
  state.rendered = new Set();
  lastDay = "";
}

async function sendFrom(textarea, url, { personView }) {
  const text = textarea.value.trim();
  if (!text || sending) return;
  sending = true;
  const btn = document.getElementById("send");
  textarea.value = "";
  autosize(textarea);
  btn.disabled = true;
  const box = document.getElementById("messages");
  box.querySelector(".empty")?.remove();
  const tmp = document.createElement("div");
  tmp.innerHTML = bubbleHtml({ direction: personView ? "in" : "out", text, createdAt: new Date() }, { personView });
  const pending = tmp.firstElementChild;
  pending.classList.add("pending");
  box.appendChild(pending);
  box.scrollTop = box.scrollHeight;
  try {
    const { message } = await api(url, { method: "POST", body: { text } });
    pending.remove();
    if (textarea.isConnected) appendMessages([{ ...message, _own: true }], { personView });
    haptic("success");
  } catch (e) {
    pending.classList.remove("pending");
    pending.classList.add("failed");
    pending.title = e.message;
    textarea.value = textarea.value ? text + "\n" + textarea.value : text;
    autosize(textarea);
    toast(e.message, true);
    haptic("error");
    setTimeout(() => pending.remove(), 4000);
  } finally {
    sending = false;
    btn.disabled = !textarea.value.trim();
  }
}

function wireComposer(url, opts) {
  const ta = document.getElementById("input");
  const btn = document.getElementById("send");
  ta.addEventListener("input", () => {
    autosize(ta);
    btn.disabled = !ta.value.trim();
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
      e.preventDefault();
      sendFrom(ta, url(), opts);
    }
  });
  btn.addEventListener("click", () => {
    sendFrom(ta, url(), opts);
    ta.focus();
  });
}

/* ------------------------------- person view ------------------------------- */

function renderPerson() {
  setBack(null);
  app.innerHTML = `
    <header class="topbar">
      <div class="avatar astra">✦</div>
      <div class="grow">
        <div class="brand"><span class="spark">${SIGN}</span></div>
        <span class="live">онлайн</span>
      </div>
    </header>
    <div class="messages" id="messages">
      <div class="empty">
        <div class="empty-symbol">${icon("chat")}</div>
        <h3>Напишите сообщение</h3>
        <p>Вам лично ответит ${SIGN}. Ответ придёт сюда и в чат с ботом.</p>
      </div>
    </div>
    <div class="composer">
      <textarea aria-label="Сообщение" id="input" rows="1" placeholder="Сообщение…" maxlength="3800"></textarea>
      <button class="send" id="send" disabled aria-label="Отправить">${icon("arrow")}</button>
    </div>`;
  wireComposer(() => "/chat/messages", { personView: true });
}

async function pollPerson() {
  const { messages } = await api(`/chat/messages?after=${state.lastId}`);
  appendMessages(messages, { personView: true });
}

/* ------------------------------- admin shell ------------------------------- */

function tabsHtml() {
  const t = (id, ico, label, extra = "") =>
    `<button class="tab ${state.view === id ? "active" : ""}" data-tab="${id}" aria-current="${state.view === id ? "page" : "false"}"><span class="ico">${icon(ico)}</span>${label}${extra}</button>`;
  const dot = state.totalUnread ? `<span class="dot">${state.totalUnread > 99 ? "99+" : state.totalUnread}</span>` : "";
  return `<nav class="tabs">${t("list", "chat", "Диалоги", dot)}${t("templates", "bolt", "Шаблоны")}${t("settings", "settings", "Настройки")}</nav>`;
}

function wireTabs() {
  document.querySelectorAll("[data-tab]").forEach((b) =>
    b.addEventListener("click", () => {
      haptic("light");
      go(b.dataset.tab);
    }),
  );
}

function adminHeader(sub) {
  return `
    <header class="topbar">
      <div class="avatar astra">✦</div>
      <div class="grow">
        <div class="brand"><span class="spark">${SIGN}</span></div>
        <div class="sub">${sub} · <span class="live ${state.online ? "" : "off"}">${state.online ? "онлайн" : "нет связи…"}</span></div>
      </div>
    </header>`;
}

function go(view, chatId) {
  state.view = view;
  if (view === "chat") return openChat(chatId);
  setBack(null);
  if (view === "list") renderList();
  if (view === "templates") renderTemplates();
  if (view === "settings") renderSettings();
}

/* ------------------------------- dialogs list ------------------------------- */

function renderList() {
  app.innerHTML = `
    ${adminHeader("панель ответов")}
    <div class="scroll"><div class="pad">
      <div class="page-heading"><div class="eyebrow">ВАШЕ ПРОСТРАНСТВО ОБЩЕНИЯ</div><h1>Диалоги<span>.</span></h1><p>Все сообщения. Личные ответы. В одном месте.</p></div><label class="search"><span>${icon("search")}</span><input aria-label="Поиск диалогов" id="q" placeholder="Поиск по имени, @username или ID" value="${esc(state.q)}" /></label>
      <div class="chips">
        ${[["all", "Все"], ["unread", "Непрочитанные"], ["blocked", "Заблокированные"]]
          .map(([k, l]) => `<button class="chip ${state.filter === k ? "active" : ""}" data-filter="${k}">${l}</button>`)
          .join("")}
      </div>
      <div id="list"></div>
    </div></div>
    ${tabsHtml()}`;
  wireTabs();
  const q = document.getElementById("q");
  let t;
  q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = q.value;
      loadContacts().catch((e) => toast(e.message, true));
    }, 250);
  });
  document.querySelectorAll("[data-filter]").forEach((b) =>
    b.addEventListener("click", () => {
      state.filter = b.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
      haptic("light");
      loadContacts().catch((e) => toast(e.message, true));
    }),
  );
  drawList();
  loadContacts().catch((e) => toast(e.message, true));
}

function drawList() {
  const box = document.getElementById("list");
  if (!box) return;
  if (!state.contacts.length) {
    box.innerHTML = state.q || state.filter !== "all"
      ? `<div class="empty"><div class="empty-symbol">${icon("search")}</div><h3>Ничего не найдено</h3></div>`
      : `<div class="empty"><div class="empty-symbol">${icon("chat")}</div><h3>Пока нет сообщений</h3><p>Как только кто-то напишет боту, диалог появится здесь — в реальном времени.</p></div>`;
    return;
  }
  box.innerHTML = state.contacts
    .map(
      (c) => `
      <button class="row" data-open="${c.id}">
        ${avatar(c)}
        <div class="grow">
          <div class="name">${esc(nameOf(c))}</div>
          <div class="preview">${c.blocked ? '<span class="tag">⛔ заблокирован · </span>' : ""}${esc(c.lastText || "—")}</div>
        </div>
        <div class="meta">
          <span class="time">${fmtShort(c.lastAt)}</span>
          ${c.unread ? `<span class="badge">${c.unread}</span>` : ""}
        </div>
      </button>`,
    )
    .join("");
  box.querySelectorAll("[data-open]").forEach((b) =>
    b.addEventListener("click", () => {
      haptic("light");
      go("chat", Number(b.dataset.open));
    }),
  );
}

let contactsReq = 0;
async function loadContacts() {
  const id = ++contactsReq;
  const params = new URLSearchParams({ q: state.q, filter: state.filter });
  const data = await api(`/admin/contacts?${params}`);
  if (id !== contactsReq) return;
  const changed = JSON.stringify(data.contacts) !== JSON.stringify(state.contacts);
  state.contacts = data.contacts;
  if (data.totalUnread !== state.totalUnread) {
    state.totalUnread = data.totalUnread;
    const tab = document.querySelector('[data-tab="list"]');
    if (tab) {
      tab.querySelector(".dot")?.remove();
      if (state.totalUnread) tab.insertAdjacentHTML("beforeend", `<span class="dot">${state.totalUnread > 99 ? "99+" : state.totalUnread}</span>`);
    }
  }
  if (changed && state.view === "list") drawList();
}

/* ------------------------------- admin chat ------------------------------- */

async function openChat(id) {
  state.view = "chat";
  state.chatId = id;
  resetChat();
  setBack(() => go("list"));
  const known = state.contacts.find((c) => c.id === id);
  state.contact = known || null;
  app.innerHTML = `
    <header class="topbar">
      <button class="icon-btn" id="back" aria-label="Назад">←</button>
      <div id="chatAvatar">${known ? avatar(known) : '<div class="avatar astra">…</div>'}</div>
      <div class="grow">
        <div class="name" id="chatName" style="font-weight:700">${known ? esc(nameOf(known)) : "Загрузка…"}</div>
        <div class="sub" id="chatSub"></div>
      </div>
      <button class="icon-btn" id="menu" aria-label="Действия">⋯</button>
    </header>
    <div class="messages" id="messages"><div class="empty"><div class="orb" style="width:36px;height:36px"></div></div></div>
    <div class="quick" id="quick"></div>
    <div class="signhint">Ответ уйдёт с подписью <b>✦ ${SIGN}</b></div>
    <div class="composer">
      <textarea aria-label="Сообщение" id="input" rows="1" placeholder="Ответ от ${SIGN}…" maxlength="3800"></textarea>
      <button class="send" id="send" disabled aria-label="Отправить">${icon("arrow")}</button>
    </div>`;
  document.getElementById("back").addEventListener("click", () => go("list"));
  document.getElementById("menu").addEventListener("click", openChatMenu);
  wireComposer(() => `/admin/contacts/${state.chatId}/messages`, { personView: false });
  drawQuick();
  try {
    await pollChat(true);
  } catch (e) {
    toast(e.message, true);
    go("list");
  }
}

function drawChatHeader() {
  const c = state.contact;
  if (!c) return;
  document.getElementById("chatAvatar").innerHTML = avatar(c);
  document.getElementById("chatName").textContent = nameOf(c);
  const parts = [];
  if (c.username) parts.push("@" + esc(c.username));
  parts.push("ID " + c.id);
  if (c.blocked) parts.push('<span class="tag">заблокирован</span>');
  document.getElementById("chatSub").innerHTML = parts.join(" · ");
}

async function pollChat(first = false) {
  const id = state.chatId;
  const data = await api(`/admin/contacts/${id}?after=${state.lastId}&read=1`);
  if (state.view !== "chat" || state.chatId !== id) return;
  const prevBlocked = state.contact?.blocked;
  state.contact = data.contact;
  if (first || prevBlocked !== data.contact.blocked) drawChatHeader();
  if (first) {
    const box = document.getElementById("messages");
    box.innerHTML = data.messages.length ? "" : `<div class="empty"><div class="big">✉️</div><h3>Нет сообщений</h3></div>`;
  }
  appendMessages(data.messages);
  if (first) {
    const box = document.getElementById("messages");
    box.scrollTop = box.scrollHeight;
  }
}

function drawQuick() {
  const box = document.getElementById("quick");
  if (!box) return;
  box.innerHTML = state.quickReplies
    .map((q) => `<button class="chip" data-q="${q.id}" title="${esc(q.text)}">⚡ ${esc(q.text)}</button>`)
    .join("");
  box.style.display = state.quickReplies.length ? "" : "none";
  box.querySelectorAll("[data-q]").forEach((b) =>
    b.addEventListener("click", () => {
      const q = state.quickReplies.find((x) => x.id === Number(b.dataset.q));
      const ta = document.getElementById("input");
      ta.value = ta.value ? ta.value.trimEnd() + " " + q.text : q.text;
      autosize(ta);
      document.getElementById("send").disabled = false;
      ta.focus();
      haptic("light");
    }),
  );
}

function openChatMenu() {
  const c = state.contact;
  if (!c) return;
  haptic("medium");
  const bg = document.createElement("div");
  bg.className = "sheet-bg";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.innerHTML = `
    ${c.username ? `<button data-act="profile">👤 Открыть профиль @${esc(c.username)}</button>` : ""}
    <button data-act="copy">📋 Скопировать ID</button>
    <button data-act="unread">🔵 Отметить непрочитанным</button>
    <button data-act="block" class="${c.blocked ? "" : "danger"}">${c.blocked ? "✅ Разблокировать" : "⛔ Заблокировать"}</button>
    <button data-act="delete" class="danger">🗑 Удалить диалог</button>
    <button data-act="close">Отмена</button>`;
  const close = () => {
    bg.remove();
    sheet.remove();
  };
  bg.addEventListener("click", close);
  sheet.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    close();
    try {
      if (act === "profile") {
        const url = `https://t.me/${c.username}`;
        tg?.openTelegramLink ? tg.openTelegramLink(url) : window.open(url, "_blank");
      }
      if (act === "copy") {
        await navigator.clipboard.writeText(String(c.id)).catch(() => {
          throw new Error("Не удалось скопировать");
        });
        toast("ID скопирован");
      }
      if (act === "unread") {
        await api(`/admin/contacts/${c.id}/read`, { method: "POST", body: { unread: true } });
        toast("Отмечено непрочитанным");
        go("list");
      }
      if (act === "block") {
        const ok = await confirmBox(c.blocked ? `Разблокировать ${nameOf(c)}?` : `Заблокировать ${nameOf(c)}? Его новые сообщения перестанут приходить.`);
        if (!ok) return;
        const { contact } = await api(`/admin/contacts/${c.id}/block`, { method: "POST", body: { blocked: !c.blocked } });
        state.contact = contact;
        drawChatHeader();
        toast(contact.blocked ? "Пользователь заблокирован" : "Пользователь разблокирован");
        haptic("success");
      }
      if (act === "delete") {
        const ok = await confirmBox(`Удалить диалог с ${nameOf(c)}? История будет стёрта из панели.`);
        if (!ok) return;
        await api(`/admin/contacts/${c.id}`, { method: "DELETE" });
        state.contacts = state.contacts.filter((x) => x.id !== c.id);
        toast("Диалог удалён");
        haptic("success");
        go("list");
      }
    } catch (err) {
      toast(err.message, true);
      haptic("error");
    }
  });
  document.body.append(bg, sheet);
}

/* ------------------------------- templates ------------------------------- */

async function loadQuick() {
  const { quickReplies } = await api("/admin/quick-replies");
  state.quickReplies = quickReplies;
}

function renderTemplates() {
  app.innerHTML = `
    ${adminHeader("быстрые ответы")}
    <div class="scroll"><div class="pad">
      <div class="card">
        <h4>Новый шаблон</h4>
        <textarea aria-label="Текст шаблона" class="field" id="tplText" placeholder="Например: Спасибо за сообщение! Отвечу в течение часа." maxlength="3800"></textarea>
        <button class="btn" id="tplAdd" disabled>＋ Сохранить шаблон</button>
      </div>
      <div class="card">
        <h4>Мои шаблоны</h4>
        <div id="tplList"></div>
      </div>
    </div></div>
    ${tabsHtml()}`;
  wireTabs();
  const ta = document.getElementById("tplText");
  const add = document.getElementById("tplAdd");
  ta.addEventListener("input", () => (add.disabled = !ta.value.trim()));
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      const { quickReply } = await api("/admin/quick-replies", { method: "POST", body: { text: ta.value } });
      state.quickReplies.push(quickReply);
      ta.value = "";
      drawTemplates();
      toast("Шаблон сохранён");
      haptic("success");
    } catch (e) {
      toast(e.message, true);
      add.disabled = false;
    }
  });
  drawTemplates();
  loadQuick().then(drawTemplates).catch((e) => toast(e.message, true));
}

function drawTemplates() {
  const box = document.getElementById("tplList");
  if (!box) return;
  if (!state.quickReplies.length) {
    box.innerHTML = `<p class="small">Шаблонов пока нет. Они появятся кнопками над полем ввода в каждом диалоге.</p>`;
    return;
  }
  box.innerHTML = state.quickReplies
    .map((q) => `<div class="tpl"><p>${esc(q.text)}</p><button class="icon-btn" data-del="${q.id}" aria-label="Удалить">🗑</button></div>`)
    .join("");
  box.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!(await confirmBox("Удалить шаблон?"))) return;
      try {
        await api(`/admin/quick-replies/${b.dataset.del}`, { method: "DELETE" });
        state.quickReplies = state.quickReplies.filter((x) => x.id !== Number(b.dataset.del));
        drawTemplates();
        toast("Шаблон удалён");
      } catch (e) {
        toast(e.message, true);
      }
    }),
  );
}

/* ------------------------------- settings ------------------------------- */

function renderSettings() {
  app.innerHTML = `
    ${adminHeader("настройки")}
    <div class="scroll"><div class="pad">
      <div class="card">
        <h4>Статистика</h4>
        <div class="stats" id="stats">
          <div class="stat"><b>—</b><span>людей</span></div>
          <div class="stat"><b>—</b><span>входящих</span></div>
          <div class="stat"><b>—</b><span>ответов</span></div>
        </div>
      </div>
      <div class="card">
        <h4>Бот</h4>
        <div id="botStatus" class="status"><i></i>Проверка…</div>
        <div class="small" id="botInfo"></div>
        <button class="btn" id="reconnect">🔌 Переподключить бота</button>
        <button class="btn ghost" id="openBot" style="display:none">🤖 Открыть бота</button>
        <button class="btn ghost" id="shareBot" style="display:none">📨 Поделиться ссылкой на бота</button>
      </div>
      <div class="card">
        <h4>Подпись ответов</h4>
        <p class="small" style="margin-top:0">Так люди видят ваши ответы:</p>
        <div class="bubble in preview-bubble" style="max-width:100%"><div class="sig">✦ ${SIGN}</div>Здравствуйте! Спасибо, что написали 🙌</div>
      </div>
      <div class="card">
        <h4>Аккаунт</h4>
        <p class="small" style="margin-top:0">Вы вошли как ${esc(state.me.first_name || "")} (ID ${state.me.id}) — администратор.</p>
        <button class="btn ghost" id="closeApp">✕ Закрыть приложение</button>
      </div>
    </div></div>
    ${tabsHtml()}`;
  wireTabs();
  document.getElementById("reconnect").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    b.textContent = "Подключение…";
    try {
      await api("/admin/setup", { method: "POST" });
      toast("Бот подключён к приложению");
      haptic("success");
      await loadStats();
    } catch (err) {
      toast(err.message, true);
      haptic("error");
    } finally {
      b.disabled = false;
      b.textContent = "🔌 Переподключить бота";
    }
  });
  document.getElementById("closeApp").addEventListener("click", () => (tg?.close ? tg.close() : window.close()));
  loadStats().catch((e) => toast(e.message, true));
}

async function loadStats() {
  const s = await api("/admin/stats");
  if (state.view !== "settings") return;
  document.getElementById("stats").innerHTML = `
    <div class="stat"><b>${s.people}</b><span>людей</span></div>
    <div class="stat"><b>${s.incoming}</b><span>входящих</span></div>
    <div class="stat"><b>${s.outgoing}</b><span>ответов</span></div>`;
  const st = document.getElementById("botStatus");
  st.className = "status" + (s.webhook.connected ? " ok" : "");
  st.innerHTML = `<i></i>${s.webhook.connected ? "Подключён и принимает сообщения" : "Не подключён к этому приложению"}`;
  const info = [];
  if (s.bot) info.push(`@${esc(s.bot.username)}`);
  if (s.webhook.pending) info.push(`в очереди: ${s.webhook.pending}`);
  if (s.webhook.lastError) info.push(`последняя ошибка: ${esc(s.webhook.lastError)}`);
  document.getElementById("botInfo").innerHTML = info.join(" · ");
  if (s.bot) {
    const link = `https://t.me/${s.bot.username}`;
    const open = document.getElementById("openBot");
    const share = document.getElementById("shareBot");
    open.style.display = share.style.display = "";
    open.onclick = () => (tg?.openTelegramLink ? tg.openTelegramLink(link) : window.open(link, "_blank"));
    share.onclick = () => {
      const url = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(`Напишите мне — отвечу лично. ${SIGN}`)}`;
      tg?.openTelegramLink ? tg.openTelegramLink(url) : window.open(url, "_blank");
    };
  }
}

/* ------------------------------- realtime loop ------------------------------- */

let busy = false;
async function tick() {
  if (!document.hidden && !busy && state.me) {
    busy = true;
    try {
      if (!state.isAdmin) await pollPerson();
      else if (state.view === "chat") await pollChat();
      else await loadContacts();
      setOnline(true);
    } catch (e) {
      setOnline(false);
    } finally {
      busy = false;
    }
  }
  setTimeout(tick, state.view === "chat" || !state.isAdmin ? 1500 : 2500);
}

/* ------------------------------- boot ------------------------------- */

function notInTelegram(msg, title = "Откройте чат в Telegram") {
  app.innerHTML = `
    <div class="welcome scroll">
      <header class="welcome-header"><a class="wordmark" href="/" aria-label="MightAstraAI — главная"><span class="brand-symbol">✦</span> MightAstraAI</a><span class="platform-label">TELEGRAM MINI APP</span></header>
      <div class="welcome-grid">
        <section class="welcome-copy">
          <div class="eyebrow"><span class="tiny-dot"></span> БЛИЖЕ, ЧЕМ КАЖЕТСЯ</div>
          <h1>На связи.<br>По-настоящему<span>.</span></h1>
          <p class="welcome-lead">Ваши сообщения — начало разговора.<br>Личный ответ от MightAstraAI — прямо в Telegram.</p>
          <div class="launch-note">${icon("chat")}<div><strong>${esc(title)}</strong><p>${esc(msg)}</p></div></div>
          <ol class="steps"><li><span>01</span><div><strong>Откройте чат с ботом</strong><p>В приложении Telegram на телефоне или компьютере.</p></div></li><li><span>02</span><div><strong>Запустите мини-приложение</strong><p>Нажмите кнопку приложения в чате бота.</p></div></li><li><span>03</span><div><strong>Напишите о том, что важно</strong><p>Ответ появится здесь и в переписке с ботом.</p></div></li></ol>
          <a class="btn" id="launchBot" hidden>Открыть бота в Telegram</a>
          <button class="btn retry" id="retry">Попробовать снова</button>
        </section>
        <aside class="welcome-art" aria-label="Личное общение с MightAstraAI"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><div class="orbit orbit-three"></div><div class="orbit-center">✦</div><span class="art-caption">У каждого сообщения<br>есть свой адресат.</span><div class="art-label"><span class="tiny-dot"></span> ЛИЧНЫЙ КОНТАКТ</div><div class="message-note"><span class="note-mark">✦</span><div><strong>MightAstraAI</strong><p>Здесь вас услышат.</p></div><span class="note-check">✓✓</span></div></aside>
      </div>
      <footer class="welcome-footer"><span>Меньше расстояний. Больше общения.</span><span>СОЗДАНО ДЛЯ ДИАЛОГА <span class="footer-star">✦</span></span></footer>
    </div>`;
  document.getElementById("retry")?.addEventListener("click", () => location.reload());
  fetch("/api/telegram/launch")
    .then((res) => res.ok ? res.json() : Promise.reject())
    .then(({ url }) => {
      const button = document.getElementById("launchBot");
      if (!button || !/^https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=chat$/.test(url)) return;
      button.href = url;
      button.hidden = false;
      button.addEventListener("click", (event) => {
        if (tg?.openTelegramLink && tg.platform !== "unknown") {
          event.preventDefault();
          tg.openTelegramLink(url);
        }
      });
    }).catch(() => {});
}

async function boot() {
  tg = await waitForTelegram(window);
  initData = telegramLaunchData(tg, window.location);
  if (tg) {
    try {
      tg.ready();
      tg.expand();
      tg.setHeaderColor?.("#171f1e");
      tg.setBackgroundColor?.("#111917");
      if (supports("7.7")) tg.disableVerticalSwipes?.();
    } catch {}
  }
  if (!initData) return notInTelegram("Нажмите «Открыть бота в Telegram», затем «Начать» и «Открыть чат». Обычная ссылка внутри Telegram не передаёт данные входа — нужна кнопка мини-приложения в чате бота.");
  try {
    const me = await api("/me");
    state.me = me.user;
    state.isAdmin = me.isAdmin;
  } catch (e) {
    return notInTelegram(
      e.status === 401 ? "Telegram не подтвердил сессию. Закройте мини-приложение и заново откройте его кнопкой «Открыть чат» у бота." : "Не удалось подключиться к серверу. Проверьте соединение и нажмите «Попробовать снова».",
      e.status === 401 ? "Обновите вход через бота" : "Не удалось загрузить переписку",
    );
  }

  if (!state.isAdmin) {
    state.view = "person";
    renderPerson();
    await pollPerson().catch((e) => toast(e.message, true));
  } else {
    loadQuick().then(() => state.view === "chat" && drawQuick()).catch(() => {});
    const deep = new URLSearchParams(location.search).get("chat") || tg?.initDataUnsafe?.start_param?.replace(/^chat_/, "");
    if (deep && /^-?\d+$/.test(deep)) go("chat", Number(deep));
    else go("list");
  }
  setTimeout(tick, 1500);
}

boot();
