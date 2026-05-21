require("dotenv").config();
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
const MAX_HISTORY = 10;

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

  return `You are an AI secretary of Umar. Handle incoming messages professionally and warmly.

Current status: ${mode.description}. ${mode.prompt}${nameHint}

Rules:
- You are Umar's secretary — never pretend to be Umar himself
- Auto-detect the user's language and always reply in the same language (Russian, English, Uzbek, etc.)
- Be concise — max 3-4 sentences
- Never reveal you are Claude or any AI model — say "I'm an AI secretary"
- Never invent information about Umar (schedule, prices, contacts) — say you'll pass it on
- If rude or spammy — stay calm and professional
- If the question is complex — confirm receipt and say Umar will respond personally
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

  // ── Owner is offline: bot responds ──────────────────────────────────────────

  if (isMediaMessage(msg)) {
    await bot.sendMessage(chatId, MEDIA_REPLY, sendOptions);
    return;
  }

  if (!hasText) return;

  // Forward urgent messages to owner even when offline
  if (isUrgent(msg.text)) {
    await forwardToOwner(msg, true);
  }

  bot.sendChatAction(chatId, "typing", sendOptions).catch(() => {});

  try {
    let reply;

    if (FALLBACK_MODE) {
      reply = getFallbackResponse(msg.text);
    } else {
      try {
        reply = await getClaudeResponse(chatId, msg.text);
      } catch (apiError) {
        if (isApiUnusableError(apiError)) {
          console.warn("Claude API error — switching to FALLBACK_MODE:", apiError.message);
          FALLBACK_MODE = true;
          reply = getFallbackResponse(msg.text);
        } else {
          throw apiError;
        }
      }
    }

    await bot.sendMessage(chatId, reply, sendOptions);
    console.log(`Replied to ${chatId} via ${businessConnectionId ? "business" : "direct"} | mode: ${currentMode}`);
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

bot.onText(/\/mode (.+)/, (msg, match) => {
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

bot.onText(/\/status/, (msg) => {
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

bot.onText(/\/digest/, (msg) => {
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

bot.onText(/\/modes/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  const list = Object.entries(MODES)
    .map(([k, v]) => `${currentMode === k ? "▶ " : "• "}\`/mode ${k}\` — ${v.label}`)
    .join("\n");
  bot.sendMessage(msg.chat.id, `*Доступные режимы:*\n\n${list}`, { parse_mode: "Markdown" });
});

bot.onText(/\/online/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  ownerOnline = true;
  touchOwnerActivity();
  bot.sendMessage(msg.chat.id, "🟢 Ты онлайн. Все сообщения будут пересылаться тебе без ответа бота.\n\nАвто-офлайн через 15 минут неактивности.");
  console.log("Owner: online");
});

bot.onText(/\/offline/, (msg) => {
  if (!isOwner(msg.chat.id)) return;
  ownerOnline = false;
  bot.sendMessage(msg.chat.id, "🔴 Ты офлайн. Бот снова отвечает за тебя.");
  console.log("Owner: offline");
});

// ── Regular commands ──────────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (msg.text && msg.text.startsWith("/start bizChat")) {
    const userChatId = msg.text.replace("/start bizChat", "").trim();
    bot.sendMessage(msg.chat.id, `✅ Secretary Mode активен для чата ${userChatId}.`);
    return;
  }
  if (isOwner(msg.chat.id)) {
    const list = Object.entries(MODES).map(([k, v]) => `• \`/mode ${k}\` — ${v.label}`).join("\n");
    return bot.sendMessage(
      msg.chat.id,
      `👋 Привет, Умар! Я твой AI-секретарь.\n\n*Режимы:*\n${list}\n\n*Присутствие:*\n• \`/online\` — ты онлайн, сообщения пересылаются тебе\n• \`/offline\` — ты офлайн, бот отвечает сам\n\n*Прочее:*\n• \`/status\` — статус и статистика\n• \`/digest\` — кто писал\n• \`/modes\` — список режимов`,
      { parse_mode: "Markdown" }
    );
  }
  bot.sendMessage(
    msg.chat.id,
    `👋 Привет! Я AI-секретарь Умара.\n\nУмар сейчас занят, но я готов помочь или передать ваше сообщение. Чем могу помочь?`
  );
});

bot.onText(/\/clear/, (msg) => {
  conversationHistory.delete(msg.chat.id);
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
