require("dotenv").config();
const fs = require("fs");
const path = require("path");
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { getFallbackResponse } = require("./templates");
const { MODES, getSuggestedMode } = require("./modes");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID ? Number(process.env.OWNER_CHAT_ID) : null;
let FALLBACK_MODE = process.env.FALLBACK_MODE === "true";

if (!TELEGRAM_TOKEN) {
  console.error("Error: TELEGRAM_TOKEN is not set in .env");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY && !FALLBACK_MODE) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Switching to FALLBACK_MODE.");
  FALLBACK_MODE = true;
}
if (!OWNER_CHAT_ID) {
  console.warn("Warning: OWNER_CHAT_ID is not set. Owner commands and urgent alerts disabled.");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, {
  polling: {
    params: {
      allowed_updates: [
        "message",
        "business_connection",
        "business_message",
        "edited_business_message",
        "deleted_business_messages",
      ],
    },
  },
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ── State ────────────────────────────────────────────────────────────────────

let currentMode = getSuggestedMode();
const conversationHistory = new Map(); // Map<chatId, [{role, content}]>
const userMemory = new Map();          // Map<chatId, {name, count, firstSeen, lastSeen}>
const businessConnections = new Map(); // Map<connectionId, {canReply, userId}>
const repliedOnceTo = new Set();       // Set<chatId> — для fallback-режима: кому уже отправили шаблон
const MAX_HISTORY = 10;

// ── Persistent context (расписание + заметки об Умаре, которые Claude использует) ─
// Хранится в context.json рядом с bot.js, переживает рестарты.

const CONTEXT_FILE = path.join(__dirname, "context.json");

let ownerContext = {
  schedule: "",        // расписание на день/неделю
  notes: "",           // произвольные заметки (контакты, цены, факты — что хочешь)
  facts: {},           // ключ-значение для быстрого доступа (например, {address: "...", email: "..."})
};

function loadContext() {
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      const raw = fs.readFileSync(CONTEXT_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      ownerContext = { schedule: "", notes: "", facts: {}, ...parsed };
      console.log("Context loaded from", CONTEXT_FILE);
    }
  } catch (e) {
    console.warn("Could not load context.json:", e.message);
  }
}

function saveContext() {
  try {
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(ownerContext, null, 2), "utf-8");
  } catch (e) {
    console.error("Could not save context.json:", e.message);
  }
}

loadContext();

const stats = {
  totalMessages: 0,
  uniqueChats: new Set(),
  startedAt: new Date(),
};

// Owner online tracking
let ownerOnline = false;
let ownerLastActivity = null;
const OWNER_ONLINE_TIMEOUT_MS = 15 * 60 * 1000; // auto-expire after 15 min of inactivity

function isOwnerOnline() {
  if (!ownerOnline) return false;
  if (!ownerLastActivity) return false;
  if (Date.now() - ownerLastActivity > OWNER_ONLINE_TIMEOUT_MS) {
    ownerOnline = false; // auto-expire
    return false;
  }
  return true;
}

function touchOwnerActivity() {
  ownerLastActivity = Date.now();
}

const URGENT_KEYWORDS = [
  "срочно", "срочная", "срочный", "urgent", "asap", "важно", "важный",
  "помогите", "помоги", "экстренно", "немедленно", "emergency",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function isOwner(chatId) {
  return OWNER_CHAT_ID && Number(chatId) === OWNER_CHAT_ID;
}

function isUrgent(text) {
  const lower = text.toLowerCase();
  return URGENT_KEYWORDS.some((kw) => lower.includes(kw));
}

function updateUserMemory(msg) {
  const chatId = msg.chat.id;
  const name = msg.from
    ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ")
    : msg.chat.first_name || "Unknown";

  if (!userMemory.has(chatId)) {
    userMemory.set(chatId, { name, count: 0, firstSeen: new Date(), lastSeen: new Date() });
  }
  const mem = userMemory.get(chatId);
  mem.count += 1;
  mem.lastSeen = new Date();
  if (name && name !== "Unknown") mem.name = name;

  stats.totalMessages += 1;
  stats.uniqueChats.add(chatId);
}

function buildSystemPrompt(chatId) {
  const mode = MODES[currentMode];
  const user = userMemory.get(chatId);
  const nameHint = user?.name ? ` The person messaging is named ${user.name}.` : "";

  // Динамический блок с актуальной информацией от владельца
  const contextBlocks = [];
  if (ownerContext.schedule && ownerContext.schedule.trim()) {
    contextBlocks.push(`Umar's current schedule:\n${ownerContext.schedule.trim()}`);
  }
  if (ownerContext.notes && ownerContext.notes.trim()) {
    contextBlocks.push(`Notes about Umar (use this to answer questions):\n${ownerContext.notes.trim()}`);
  }
  const factKeys = Object.keys(ownerContext.facts || {});
  if (factKeys.length > 0) {
    const factsList = factKeys.map((k) => `- ${k}: ${ownerContext.facts[k]}`).join("\n");
    contextBlocks.push(`Quick facts:\n${factsList}`);
  }
  const contextSection = contextBlocks.length
    ? `\n\n=== AUTHORIZED INFORMATION FROM UMAR (you may share this with users) ===\n${contextBlocks.join("\n\n")}\n=== END INFORMATION ===`
    : "";

  return `You are an AI secretary of Umar. Handle incoming messages professionally and warmly.

Current status: ${mode.description}. ${mode.prompt}${nameHint}${contextSection}

Rules:
- You are Umar's secretary — never pretend to be Umar himself
- Auto-detect the user's language and always reply in the same language (Russian, English, Uzbek, etc.)
- Be concise — max 3-4 sentences
- Never reveal you are Claude or any AI model — say "I'm an AI secretary"
- IMPORTANT: If the user asks something that is answered in the AUTHORIZED INFORMATION block above (schedule, facts, notes), answer it directly using that information. Do NOT say "I'll pass it on" for questions you can answer from the authorized information.
- For information NOT in the authorized block (prices, opinions, decisions, anything personal not listed) — say you'll pass it on to Umar. Never invent details.
- If rude or spammy — stay calm and professional
- If the question is complex or requires Umar's personal decision — confirm receipt and say Umar will respond personally
- Always end with a subtle call to action: invite them to leave their question or wait`;
}

function getHistory(chatId) {
  if (!conversationHistory.has(chatId)) conversationHistory.set(chatId, []);
  return conversationHistory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

function isApiUnusableError(error) {
  if (!error) return false;
  const status = error.status || (error.error && error.error.status);
  if (status === 429 || status === 401) return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing") ||
    msg.includes("invalid x-api-key") ||
    msg.includes("authentication_error")
  );
}

function isMediaMessage(msg) {
  return !!(msg.photo || msg.voice || msg.video || msg.document || msg.audio || msg.sticker || msg.video_note);
}

function formatUptime() {
  const ms = Date.now() - stats.startedAt.getTime();
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}ч ${m}м`;
}

// ── Claude ───────────────────────────────────────────────────────────────────

async function getClaudeResponse(chatId, userMessage) {
  pushToHistory(chatId, "user", userMessage);
  const history = getHistory(chatId);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: buildSystemPrompt(chatId),
    messages: history,
  });

  const reply = response.content[0].text;
  pushToHistory(chatId, "assistant", reply);
  return reply;
}

// ── Notify / forward to owner ─────────────────────────────────────────────────

async function forwardToOwner(msg, urgent = false) {
  if (!OWNER_CHAT_ID) return;
  const user = userMemory.get(msg.chat.id);
  const name = user?.name || "Неизвестный";
  const chatId = msg.chat.id;
  const icon = urgent ? "🚨" : "📩";
  const label = urgent ? "*Срочное сообщение!*" : "*Новое сообщение*";
  await bot.sendMessage(
    OWNER_CHAT_ID,
    `${icon} ${label}\n\nОт: ${name} (\`${chatId}\`)\n\n"${msg.text || "[медиа]"}"`,
    { parse_mode: "Markdown" }
  ).catch(() => {});
}

// ── Message handler ──────────────────────────────────────────────────────────

const MEDIA_REPLY =
  "Я пока обрабатываю только текстовые сообщения. Напишите ваш вопрос текстом — передам Умару.\n\n" +
  "I can only process text messages for now. Please write your question — I'll pass it on to Umar.";

async function handleIncomingMessage(msg, businessConnectionId) {
  if (isOwner(msg.chat.id)) return; // owner commands handled separately

  updateUserMemory(msg);

  const chatId = msg.chat.id;
  const sendOptions = businessConnectionId ? { business_connection_id: businessConnectionId } : {};
  const hasText = msg.text && !msg.text.startsWith("/");

  // ── Owner is online: forward silently, don't reply ──────────────────────────
  if (isOwnerOnline()) {
    if (hasText || isMediaMessage(msg)) {
      await forwardToOwner(msg, hasText && isUrgent(msg.text));
      console.log(`Forwarded to owner (online) from ${chatId}`);
    }
    return;
  }

  // ── Owner is offline ───────────────────────────────────────────────────────

  // Медиа — обрабатываем одинаково в обоих режимах: говорим что только текст + пересылаем владельцу
  if (isMediaMessage(msg)) {
    if (!repliedOnceTo.has(chatId)) {
      await bot.sendMessage(chatId, MEDIA_REPLY, sendOptions);
      repliedOnceTo.add(chatId);
    }
    await forwardToOwner(msg, false);
    return;
  }

  if (!hasText) return;

  // Срочные — всегда пересылаем владельцу, независимо от режима
  if (isUrgent(msg.text)) {
    await forwardToOwner(msg, true);
  }

  // ── FALLBACK режим: один шаблон, дальше — только пересылка ─────────────────
  if (FALLBACK_MODE) {
    if (repliedOnceTo.has(chatId)) {
      // Уже отправили шаблон — пересылаем владельцу молча
      if (!isUrgent(msg.text)) {
        await forwardToOwner(msg, false);
      }
      console.log(`[fallback] Forwarded (already templated) from ${chatId}`);
      return;
    }

    // Первое сообщение — отправляем шаблон + пересылаем владельцу
    try {
      const reply = getFallbackResponse(msg.text);
      await bot.sendMessage(chatId, reply, sendOptions);
      repliedOnceTo.add(chatId);
      if (!isUrgent(msg.text)) {
        await forwardToOwner(msg, false);
      }
      console.log(`[fallback] Template sent to ${chatId}, future messages will be forwarded`);
    } catch (err) {
      console.error("Fallback send error:", err.message || err);
    }
    return;
  }

  // ── AI режим: Claude отвечает на каждое сообщение, используя расписание и заметки ─
  bot.sendChatAction(chatId, "typing", sendOptions).catch(() => {});

  try {
    let reply;
    try {
      reply = await getClaudeResponse(chatId, msg.text);
    } catch (apiError) {
      if (isApiUnusableError(apiError)) {
        console.warn("Claude API error — switching to FALLBACK_MODE:", apiError.message);
        FALLBACK_MODE = true;
        // Уведомляем владельца, что переключились
        if (OWNER_CHAT_ID) {
          bot.sendMessage(OWNER_CHAT_ID, `⚠️ Claude API недоступен (${apiError.message}). Переключился на шаблоны.`).catch(() => {});
        }
        // Этому клиенту дадим шаблонный ответ (его первый раз в fallback)
        reply = getFallbackResponse(msg.text);
        repliedOnceTo.add(chatId);
      } else {
        throw apiError;
      }
    }

    await bot.sendMessage(chatId, reply, sendOptions);
    console.log(`[ai] Replied to ${chatId} via ${businessConnectionId ? "business" : "direct"} | mode: ${currentMode}`);
  } catch (err) {
    console.error("Error handling message:", err.message || err.code || err);
    await bot
      .sendMessage(chatId, "Извините, произошла техническая ошибка. Попробуйте позже.", sendOptions)
      .catch(() => {});
  }
}

// ── Patch processUpdate for business updates ─────────────────────────────────

const _processUpdate = bot.processUpdate.bind(bot);
bot.processUpdate = function (update) {
  if (update.business_connection) { bot.emit("business_connection", update.business_connection); return; }
  if (update.business_message) { bot.emit("business_message", update.business_message); return; }
  if (update.edited_business_message || update.deleted_business_messages) return;
  _processUpdate(update);
};

// ── Business connection lifecycle ─────────────────────────────────────────────

bot.on("business_connection", (connection) => {
  const { id, is_enabled, can_reply, user } = connection;
  if (is_enabled) {
    businessConnections.set(id, { canReply: can_reply, userId: user.id });
    console.log(`Business connection: ${id} | can_reply=${can_reply}`);
  } else {
    businessConnections.delete(id);
    console.log(`Business connection removed: ${id}`);
  }
});

bot.on("business_message", async (msg) => {
  const connectionId = msg.business_connection_id;
  const conn = businessConnections.get(connectionId);
  if (conn && !conn.canReply) return;
  await handleIncomingMessage(msg, connectionId);
});

// ── Owner commands ────────────────────────────────────────────────────────────

bot.onText(/^\/mode(?:@\w+)?\s+(.+)$/, (msg, match) => {
  if (!isOwner(msg.chat.id)) return;
  const requested = match[1].trim().toLowerCase();
  if (!MODES[requested]) {
    const list = Object.keys(MODES).map((k) => `• \`${k}\` — ${MODES[k].label}`).join("\n");
    return bot.sendMessage(msg.chat.id, `Неизвестный режим. Доступные:\n\n${list}`, { parse_mode: "Markdown" });
  }
  currentMode = requested;
  // Clear all histories so Claude picks up the new mode context
  conversationHistory.clear();
  bot.sendMessage(msg.chat.id, `✅ Режим изменён: *${MODES[currentMode].label}*`, { parse_mode: "Markdown" });
  console.log(`Mode changed to: ${currentMode}`);
});

bot.onText(/^\/status(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  const mode = MODES[currentMode];
  const onlineStatus = isOwnerOnline() ? "🟢 Онлайн (сообщения пересылаются)" : "🔴 Офлайн (бот отвечает)";
  const text =
    `📊 *Статус бота*\n\n` +
    `Ты: ${onlineStatus}\n` +
    `Режим: ${mode.label}\n` +
    `Описание: ${mode.description}\n\n` +
    `📨 Сообщений обработано: ${stats.totalMessages}\n` +
    `👥 Уникальных чатов: ${stats.uniqueChats.size}\n` +
    `⏱ Аптайм: ${formatUptime()}\n` +
    `🤖 Режим AI: ${FALLBACK_MODE ? "Шаблоны (fallback)" : "Claude Haiku"}`;
  bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
});

bot.onText(/^\/digest(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  if (userMemory.size === 0) {
    return bot.sendMessage(msg.chat.id, "Пока никто не писал.");
  }
  const lines = [...userMemory.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 20)
    .map(([chatId, u]) => `• ${u.name} (${chatId}) — ${u.count} сообщ., последнее: ${u.lastSeen.toLocaleTimeString("ru")}`);
  bot.sendMessage(msg.chat.id, `📋 *Дайджест переписки*\n\n${lines.join("\n")}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/modes(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  const list = Object.entries(MODES)
    .map(([k, v]) => `${currentMode === k ? "▶ " : "• "}\`/mode ${k}\` — ${v.label}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `*Доступные режимы:*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/online(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) {
    console.log(`/online ignored — not owner. chatId=${msg.chat.id}, OWNER_CHAT_ID=${OWNER_CHAT_ID}`);
    return;
  }
  ownerOnline = true;
  touchOwnerActivity();
  bot.sendMessage(msg.chat.id, "🟢 Ты онлайн. Все сообщения будут пересылаться тебе без ответа бота.\n\nАвто-офлайн через 15 минут неактивности.");
  console.log("Owner: online");
});

bot.onText(/^\/offline(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) {
    console.log(`/offline ignored — not owner. chatId=${msg.chat.id}, OWNER_CHAT_ID=${OWNER_CHAT_ID}`);
    return;
  }
  ownerOnline = false;
  ownerLastActivity = null;
  // Новая offline-сессия — fallback-флаг тоже сбрасываем
  repliedOnceTo.clear();
  const aiMode = FALLBACK_MODE
    ? "📋 Шаблоны: один ответ на клиента, дальше пересылка тебе"
    : "🤖 Claude: полноценный диалог по твоему расписанию и заметкам";
  bot.sendMessage(msg.chat.id, `🔴 Ты офлайн. Бот снова отвечает за тебя.\n\n${aiMode}`);
  console.log("Owner: offline");
});

// ── Context management (расписание и заметки для Claude) ──────────────────────

bot.onText(/^\/schedule(?:@\w+)?(?:\s+([\s\S]+))?$/, (msg, match) => {
  if (!isOwner(msg.chat.id)) return;
  const arg = match[1];
  if (!arg) {
    const current = ownerContext.schedule || "_(пусто)_";
    return bot.sendMessage(
      msg.chat.id,
      `📅 *Текущее расписание:*\n\n${current}\n\n` +
      `Чтобы обновить:\n\`/schedule <текст расписания>\`\n\n` +
      `Чтобы очистить:\n\`/schedule_clear\``,
      { parse_mode: "Markdown" }
    );
  }
  ownerContext.schedule = arg.trim();
  saveContext();
  conversationHistory.clear(); // чтобы Claude сразу подхватил новый контекст
  bot.sendMessage(msg.chat.id, `✅ Расписание обновлено. Claude теперь использует его в ответах.`);
});

bot.onText(/^\/schedule_clear(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  ownerContext.schedule = "";
  saveContext();
  conversationHistory.clear();
  bot.sendMessage(msg.chat.id, "✅ Расписание очищено.");
});

bot.onText(/^\/notes(?:@\w+)?(?:\s+([\s\S]+))?$/, (msg, match) => {
  if (!isOwner(msg.chat.id)) return;
  const arg = match[1];
  if (!arg) {
    const current = ownerContext.notes || "_(пусто)_";
    return bot.sendMessage(
      msg.chat.id,
      `📝 *Текущие заметки:*\n\n${current}\n\n` +
      `Чтобы обновить:\n\`/notes <текст заметок>\`\n\n` +
      `Чтобы очистить:\n\`/notes_clear\``,
      { parse_mode: "Markdown" }
    );
  }
  ownerContext.notes = arg.trim();
  saveContext();
  conversationHistory.clear();
  bot.sendMessage(msg.chat.id, "✅ Заметки обновлены.");
});

bot.onText(/^\/notes_clear(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  ownerContext.notes = "";
  saveContext();
  conversationHistory.clear();
  bot.sendMessage(msg.chat.id, "✅ Заметки очищены.");
});

bot.onText(/^\/fact(?:@\w+)?\s+(\S+)\s+([\s\S]+)$/, (msg, match) => {
  if (!isOwner(msg.chat.id)) return;
  const key = match[1].trim();
  const value = match[2].trim();
  if (!ownerContext.facts) ownerContext.facts = {};
  ownerContext.facts[key] = value;
  saveContext();
  conversationHistory.clear();
  bot.sendMessage(msg.chat.id, `✅ Факт сохранён:\n*${key}* → ${value}`, { parse_mode: "Markdown" });
});

bot.onText(/^\/fact_del(?:@\w+)?\s+(\S+)$/, (msg, match) => {
  if (!isOwner(msg.chat.id)) return;
  const key = match[1].trim();
  if (ownerContext.facts && key in ownerContext.facts) {
    delete ownerContext.facts[key];
    saveContext();
    conversationHistory.clear();
    bot.sendMessage(msg.chat.id, `✅ Факт *${key}* удалён.`, { parse_mode: "Markdown" });
  } else {
    bot.sendMessage(msg.chat.id, `Факта *${key}* нет.`, { parse_mode: "Markdown" });
  }
});

bot.onText(/^\/context(?:@\w+)?$/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  const schedule = ownerContext.schedule || "_(пусто)_";
  const notes = ownerContext.notes || "_(пусто)_";
  const factKeys = Object.keys(ownerContext.facts || {});
  const factsText = factKeys.length
    ? factKeys.map((k) => `• *${k}*: ${ownerContext.facts[k]}`).join("\n")
    : "_(пусто)_";
  bot.sendMessage(
    msg.chat.id,
    `🧠 *Контекст для Claude*\n\n` +
    `📅 *Расписание:*\n${schedule}\n\n` +
    `📝 *Заметки:*\n${notes}\n\n` +
    `🔑 *Факты:*\n${factsText}`,
    { parse_mode: "Markdown" }
  );
});

// ── Regular commands ──────────────────────────────────────────────────────────

bot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/, (msg, match) => {
  const arg = match[1];

  // deep-link bizChat: /start bizChat<id>
  if (arg && arg.startsWith("bizChat")) {
    const userChatId = arg.replace("bizChat", "").trim();
    bot.sendMessage(msg.chat.id, `✅ Secretary Mode активен для чата ${userChatId}.`);
    return;
  }

  if (isOwner(msg.chat.id)) {
    const modesList = Object.entries(MODES)
      .map(([k, v]) => `${currentMode === k ? "▶" : "•"} \`/mode ${k}\` — ${v.label}`)
      .join("\n");

    const text =
      `👋 Привет, Умар! Я твой AI-секретарь.\n\n` +
      `*🎭 Режимы присутствия:*\n${modesList}\n\n` +
      `*🟢 Статус (онлайн/офлайн):*\n` +
      `• \`/online\` — ты онлайн, все сообщения пересылаются тебе без ответа бота\n` +
      `• \`/offline\` — ты офлайн, бот отвечает сам\n\n` +
      `*🧠 Контекст для Claude (расписание + заметки):*\n` +
      `• \`/context\` — посмотреть весь контекст\n` +
      `• \`/schedule <текст>\` — обновить расписание\n` +
      `• \`/schedule_clear\` — очистить расписание\n` +
      `• \`/notes <текст>\` — обновить заметки\n` +
      `• \`/notes_clear\` — очистить заметки\n` +
      `• \`/fact <ключ> <значение>\` — сохранить факт (например: \`/fact email umar@example.com\`)\n` +
      `• \`/fact_del <ключ>\` — удалить факт\n\n` +
      `*📊 Информация:*\n` +
      `• \`/status\` — текущий статус, режим, статистика, аптайм\n` +
      `• \`/digest\` — топ-20 клиентов по числу сообщений\n` +
      `• \`/modes\` — список всех режимов\n\n` +
      `*🛠 Прочее:*\n` +
      `• \`/clear\` — сбросить историю диалога\n` +
      `• \`/start\` — показать это сообщение\n\n` +
      `_Сейчас: режим *${MODES[currentMode].label}*, ${isOwnerOnline() ? "🟢 онлайн" : "🔴 офлайн"}, AI: ${FALLBACK_MODE ? "📋 Шаблоны (один ответ + пересылка)" : "🤖 Claude Haiku (диалог по контексту)"}_`;

    return bot.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  }

  // обычный пользователь
  bot.sendMessage(
    msg.chat.id,
    `👋 Привет! Я AI-секретарь Умара.\n\nУмар сейчас занят, но я готов помочь или передать ваше сообщение. Чем могу помочь?\n\n_Команды:_\n• /clear — сбросить нашу переписку`
  );
});

bot.onText(/^\/clear(?:@\w+)?$/, (msg) => {
  conversationHistory.delete(msg.chat.id);
  repliedOnceTo.delete(msg.chat.id); // позволяем боту снова представиться этому клиенту
  bot.sendMessage(msg.chat.id, "✅ История диалога сброшена.");
});

bot.on("message", async (msg) => {
  if (msg.business_connection_id) return;
  // Keep owner activity alive while they're using the bot
  if (isOwner(msg.chat.id)) {
    touchOwnerActivity();
    return;
  }
  if (!msg.text || msg.text.startsWith("/")) return;
  await handleIncomingMessage(msg, null);
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message || err.code || "unknown");
});

const modeLabel = FALLBACK_MODE ? "FALLBACK (template)" : "Claude Haiku";
console.log(`Secretary bot running | mode: ${currentMode} | AI: ${modeLabel}`);
