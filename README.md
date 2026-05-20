# Telegram Secretary Bot

A Telegram bot powered by Claude Haiku that acts as your personal secretary — politely handling messages while you're busy.

## Features

- Responds to users via Claude Haiku (claude-haiku-4-5)
- Maintains per-user conversation history (last 10 messages)
- `/start` — welcome message explaining the bot
- `/clear` — reset conversation history for that user
- **Fallback mode**: if the Claude API quota is exhausted (HTTP 429 / billing error), the bot automatically switches to keyword-based template responses so it never goes silent

## Setup

### 1. Get your tokens

- **Telegram token**: message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`, and copy the token
- **Anthropic API key**: get it from [console.anthropic.com](https://console.anthropic.com)

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your tokens:

```bash
cp .env.example .env
```

Edit `.env`:

```
TELEGRAM_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwXyz
ANTHROPIC_API_KEY=sk-ant-...
FALLBACK_MODE=false
```

Set `FALLBACK_MODE=true` to skip Claude API entirely and use template responses (useful for testing or when API credits run out).

### 3. Install dependencies

```bash
npm install
```

### 4. Run the bot

```bash
npm start
```

You should see:
```
Secretary bot is running in Claude Haiku mode...
```

## File Structure

```
secretary-bot/
├── bot.js          # Main bot logic
├── templates.js    # Fallback keyword-response templates
├── .env            # Your secrets (never commit this)
├── .env.example    # Template for .env
├── package.json
└── README.md
```

## Fallback Mode

When the Claude API returns a quota/billing error (HTTP 429 or "credit balance" message), the bot automatically sets `FALLBACK_MODE = true` for the rest of the session and switches to template-based responses. You can also force this mode manually by setting `FALLBACK_MODE=true` in `.env`.

Template responses cover common intents: greetings, pricing, meeting requests, urgency, partnership, etc. If no keyword matches, a default "message saved" reply is sent.

## Customisation

- **System prompt**: edit the `SYSTEM_PROMPT` constant in `bot.js` to change the secretary's personality or language
- **Templates**: add more entries to the `templates` array in `templates.js`
- **History length**: change `MAX_HISTORY` in `bot.js` (default: 10 messages per user)
