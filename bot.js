require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const Anthropic = require("@anthropic-ai/sdk");
const { getFallbackResponse } = require("./templates");

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
let FALLBACK_MODE = process.env.FALLBACK_MODE === "true";

if (!TELEGRAM_TOKEN) {
  console.error("Error: TELEGRAM_TOKEN is not set in .env");
  process.exit(1);
}
if (!ANTHROPIC_API_KEY && !FALLBACK_MODE) {
  console.warn("Warning: ANTHROPIC_API_KEY is not set. Switching to FALLBACK_MODE.");
  FALLBACK_MODE = true;
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

const conversationHistory = new Map();
const MAX_HISTORY = 10;

// Business connections: Map<connectionId, { canReply: bool, userId: number }>
const businessConnections = new Map();

const SYSTEM_PROMPT = `You are an AI secretary of Umar. Your job is to handle incoming messages professionally and warmly.

Rules:
- You are the secretary of Umar. Never pretend to be Umar himself — always clarify you are his personal AI secretary
- Auto-detect the user's language and always reply in the same language (Russian → Russian, English → English, Uzbek → Uzbek, etc.)
- Be concise — max 3-4 sentences per reply
- Never reveal that you are Claude or any AI model — just say "I'm an AI secretary"
- Never make up information about Umar (schedule, prices, contacts) — say you'll pass it on
- If someone asks something specific about Umar's work or services — acknowledge their question and say Umar will respond personally
- If someone is rude or sends spam — stay calm and professional, do not mirror their tone
- Greet warmly and introduce yourself as Umar's AI secretary when appropriate
- For urgent messages — acknowledge the urgency and promise to notify Umar immediately
- For compliments or thanks — respond warmly on behalf of Umar
- Always end replies with a subtle call to action: invite them to leave their question or wait for Umar`;

const START_MESSAGE = `👋 Привет! Я AI-секретарь Умара.

Умар сейчас занят, но я готов помочь или передать ваше сообщение.

• Задайте вопрос — отвечу если смогу, или передам Умару
• Оставьте сообщение — он обязательно ответит

Команды:
/start — это сообщение
/clear — сбросить историю диалога

Чем могу помочь?`;

const MEDIA_REPLY = {
  ru: "Я пока обрабатываю только текстовые сообщения. Напишите ваш вопрос текстом — передам Умару.",
  en: "I can only process text messages for now. Please write your question in text — I'll pass it on to Umar.",
  uz: "Hozircha faqat matnli xabarlarni qayta ishlay olaman. Savolingizni matn ko'rinishida yozing — Umarga yetkazaman.",
};

function getHistory(chatId) {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  return conversationHistory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

function isQuotaError(error) {
  if (!error) return false;
  const status = error.status || (error.error && error.error.status);
  if (status === 429) return true;
  const msg = (error.message || "").toLowerCase();
  return (
    msg.includes("credit balance") ||
    msg.includes("quota") ||
    msg.includes("rate limit") ||
    msg.includes("insufficient_quota") ||
    msg.includes("billing")
  );
}

async function getClaudeResponse(chatId, userMessage) {
  pushToHistory(chatId, "user", userMessage);
  const history = getHistory(chatId);

  const response = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const assistantMessage = response.content[0].text;
  pushToHistory(chatId, "assistant", assistantMessage);
  return assistantMessage;
}

function isMediaMessage(msg) {
  return !!(msg.photo || msg.voice || msg.video || msg.document || msg.audio || msg.sticker || msg.video_note);
}

async function handleIncomingMessage(msg, businessConnectionId) {
  const chatId = msg.chat.id;
  const sendOptions = businessConnectionId ? { business_connection_id: businessConnectionId } : {};

  // Non-text media
  if (isMediaMessage(msg)) {
    await bot.sendMessage(chatId, MEDIA_REPLY.ru + "\n\n" + MEDIA_REPLY.en, sendOptions);
    return;
  }

  if (!msg.text || msg.text.startsWith("/")) return;

  bot.sendChatAction(chatId, "typing", sendOptions);

  try {
    let reply;

    if (FALLBACK_MODE) {
      reply = getFallbackResponse(msg.text);
    } else {
      try {
        reply = await getClaudeResponse(chatId, msg.text);
      } catch (apiError) {
        if (isQuotaError(apiError)) {
          console.warn("Claude API quota/billing error — switching to FALLBACK_MODE:", apiError.message);
          FALLBACK_MODE = true;
          reply = getFallbackResponse(msg.text);
        } else {
          throw apiError;
        }
      }
    }

    await bot.sendMessage(chatId, reply, sendOptions);
  } catch (err) {
    console.error("Error handling message:", err.message || err);
    await bot.sendMessage(
      chatId,
      "Извините, произошла техническая ошибка. Пожалуйста, попробуйте позже.",
      sendOptions
    );
  }
}

// ── Secretary Mode: business connection lifecycle ────────────────────────────

bot.on("business_connection", (connection) => {
  const { id, is_enabled, can_reply, user } = connection;

  if (is_enabled) {
    businessConnections.set(id, { canReply: can_reply, userId: user.id });
    console.log(`Business connection established: ${id} | can_reply=${can_reply} | user=${user.id}`);
  } else {
    businessConnections.delete(id);
    console.log(`Business connection removed: ${id}`);
  }
});

bot.on("business_message", async (msg) => {
  const connectionId = msg.business_connection_id;
  const conn = businessConnections.get(connectionId);

  // If we missed the business_connection update (e.g. bot restarted), still reply.
  // Telegram will return an error on sendMessage if can_reply is actually false.
  if (conn && !conn.canReply) {
    console.log(`business_message received but can_reply=false for connection ${connectionId}`);
    return;
  }

  await handleIncomingMessage(msg, connectionId);
});

// ── Regular bot messages ─────────────────────────────────────────────────────

bot.onText(/\/start/, (msg) => {
  if (msg.text && msg.text.startsWith("/start bizChat")) {
    const userChatId = msg.text.replace("/start bizChat", "").trim();
    bot.sendMessage(
      msg.chat.id,
      `✅ Secretary Mode активен для чата ${userChatId}.\nБот отвечает собеседникам от имени Умара.`
    );
    return;
  }
  bot.sendMessage(msg.chat.id, START_MESSAGE);
});

bot.onText(/\/clear/, (msg) => {
  conversationHistory.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ История диалога сброшена.");
});

bot.on("message", async (msg) => {
  if (msg.business_connection_id) return; // handled by business_message
  await handleIncomingMessage(msg, null);
});

bot.on("polling_error", (err) => {
  const msg = err.message || err.code || "unknown error";
  console.error("Polling error:", msg);
});

const modeLabel = FALLBACK_MODE ? "FALLBACK (template)" : "Claude Haiku";
console.log(`Secretary bot is running in ${modeLabel} mode...`);
