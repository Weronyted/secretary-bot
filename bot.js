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

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Per-user conversation history: Map<chatId, Array<{role, content}>>
const conversationHistory = new Map();
const MAX_HISTORY = 10;

const SYSTEM_PROMPT = `You are a personal secretary of the bot owner. Your name is Alex.

Your role:
- Introduce yourself as the personal secretary of the owner when appropriate
- Inform users that the owner is currently busy and you are here to help or take a message
- Be polite, professional, and concise in all responses
- Answer simple questions or take messages on behalf of the owner
- If a question is complex or requires the owner's direct input, kindly say you will pass it along and ask the user to leave their question clearly
- Keep responses brief — no more than 3-4 sentences unless the user specifically needs more detail
- Support both Russian and English naturally — reply in the same language the user writes in
- Never pretend to be the owner themselves; always speak as the secretary`;

const START_MESSAGE = `👋 Hello! I'm Alex, the personal secretary of the bot owner.

The owner is currently busy, but I'm here to assist you or take a message.

You can:
• Ask me a question — I'll help if I can, or pass it to the owner
• Leave a message — I'll make sure the owner sees it

Commands:
/start — show this message
/clear — reset our conversation history

How can I help you today?`;

function getHistory(chatId) {
  if (!conversationHistory.has(chatId)) {
    conversationHistory.set(chatId, []);
  }
  return conversationHistory.get(chatId);
}

function pushToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  // Keep only the last MAX_HISTORY messages
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

// /start command
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, START_MESSAGE);
});

// /clear command
bot.onText(/\/clear/, (msg) => {
  conversationHistory.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "✅ Conversation history cleared. Let's start fresh!");
});

// Handle all text messages
bot.on("message", async (msg) => {
  // Ignore commands (already handled above)
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = msg.chat.id;

  // Show typing indicator
  bot.sendChatAction(chatId, "typing");

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

    await bot.sendMessage(chatId, reply);
  } catch (err) {
    console.error("Error handling message:", err.message || err);
    await bot.sendMessage(
      chatId,
      "Извините, произошла техническая ошибка. Пожалуйста, попробуйте позже.\n\nSorry, a technical error occurred. Please try again later."
    );
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message || err);
});

const modeLabel = FALLBACK_MODE ? "FALLBACK (template)" : "Claude Haiku";
console.log(`Secretary bot is running in ${modeLabel} mode...`);
