# 1000x Call Bot - Development Log

## Project Overview
Telegram bot that monitors Pump.fun token migrations to Raydium, sends calls to channels, and provides auto-trading functionality.

## VPS Information
- **IP:** 95.179.137.169
- **Bot folder:** `/root/1000x-call-bot`
- **PM2 process:** `callbot`
- **Update command:** `cd /root/1000x-call-bot && git pull && pm2 restart callbot`

## Key Files
- `src/bot.js` - Main bot file with Telegram commands and trading menu
- `src/tracker.js` - Pump.fun migration tracker
- `src/utils/formatter.js` - Message formatting utilities
- `trading/jupiterSwap.js` - Jupiter DEX swap integration
- `trading/autoTrader.js` - Auto trading logic with TP/SL
- `data/trading_users.json` - User trading settings and positions
- `.env` - Environment variables (API keys, private keys)

## Environment Variables (.env)
```
BOT_TOKEN=<telegram bot token>
CHANNEL_ID=<paid channel id>
FREE_CHANNEL_ID=<free channel id>
HELIUS_API_KEY=<helius rpc api key>
TRADING_PRIVATE_KEY=<solana wallet private key in base58>
```

---

# Session Log - 2026-01-16

## Issues Fixed Today

### 1. Stop Loss Display Bug
**Problem:** Stop Loss settings showed wrong percentage (e.g., 40% instead of -60%)

**Root Cause:** Display formula was `stopLossMultiplier * 100` instead of calculating the actual loss percentage

**Fix in bot.js (2 places):**
```javascript
// OLD (wrong):
🛑 Stop Loss: ${(user.settings.stopLossMultiplier * 100)}%

// NEW (correct):
🛑 Stop Loss: -${((1 - user.settings.stopLossMultiplier) * 100).toFixed(0)}%
```

**Example:** If `stopLossMultiplier = 0.4`, it means sell when price drops to 40% of original = -60% loss

---

### 2. Auto Trading Buying All Tokens (Not Just Filtered Ones)
**Problem:** Bot was buying ALL tokens, not just the ones that passed filters and were called to channel

**Root Cause:** `autoTrader.handleNewMigration()` was called BEFORE filters were applied

**Fix in bot.js:** Moved auto trading call to AFTER the token is successfully posted to channel:
```javascript
// Send to PAID channel first
let paidMessageId = await sendCallToChannel(CHANNEL_ID, message, imageBuffer, 'PAID');

// AUTO TRADING - Execute trades ONLY for tokens that passed filters and were called
if (paidMessageId) {
    try {
        await autoTrader.handleNewMigration(token, bot);
    } catch (error) {
        console.error('[AUTO-TRADER] Error:', error.message);
    }
}
```

---

### 3. AUTO-BUY FAILED - "undefined" Error
**Problem:** Error message: "The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received undefined"

**Root Cause:** `TRADING_PRIVATE_KEY` was undefined because `jupiterSwap.js` wasn't loading the `.env` file

**Fix in trading/jupiterSwap.js:** Added dotenv config at the top:
```javascript
const path = require('path');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '../.env') });
```

---

### 4. Positions View - No Live P&L or Refresh
**Problem:** Positions menu only showed basic info, no live profit/loss percentages

**Enhancement in bot.js (`trading_positions` action):**
- Fetch current market cap from DexScreener API for each position
- Calculate P&L percentage: `((currentMC / buyMC) - 1) * 100`
- Display with color coding: 🟢 for profit, 🔴 for loss
- Show multiplier (e.g., 1.45x, 0.77x)
- Show average P&L across all positions
- Added 🔄 Refresh Prices button
- Improved time display (hours + minutes)

**New Positions Display:**
```
📊 OPEN POSITIONS (1/5)
📈 Avg P&L: +45.2%

🪙 TOKEN
   💰 0.1 SOL | ⏱️ 2h 15m
   📊 🟢 +45.2% (1.45x)

[🔄 Refresh Prices]
[🔴 Sell TOKEN]
[⬅️ Back to Trading]
```

---

## Git Commits Today
1. `632dcdf` - Previous fixes (Stop Loss display, auto trading filter, jupiterSwap dotenv)
2. `239b081` - Add live P&L percentages and refresh button to Positions view

---

## How We Work Together

### Workflow
1. User describes problem or feature request
2. I read relevant files to understand the code
3. I make the fix/enhancement using Edit tool
4. I commit changes with descriptive message
5. I push to GitHub
6. User runs on VPS: `cd /root/1000x-call-bot && git pull && pm2 restart callbot`

### Key Patterns in This Codebase

**Telegram Bot Actions:**
```javascript
bot.action('callback_name', async (ctx) => {
    await ctx.answerCbQuery();
    // ... handler logic
    await ctx.editMessageText('message', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [...] }
    });
});
```

**User Settings Storage:**
```javascript
// Get user profile
const user = autoTrader.getUserProfile(userId);

// Update setting
autoTrader.updateUserSettings(userId, 'settingKey', value);

// Settings are stored in data/trading_users.json
```

**Jupiter Swap Integration:**
```javascript
// Buy token
const result = await jupiterSwap.buyToken(userId, tokenAddress, solAmount);

// Sell token
const result = await jupiterSwap.sellToken(userId, tokenAddress, tokenAmount);

// Get wallet balance
const balance = await jupiterSwap.getWalletBalance();
```

**DexScreener API for Price Data:**
```javascript
const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
const data = await response.json();
const currentMC = data.pairs[0].fdv || data.pairs[0].marketCap;
```

---

## Trading Settings
- **Trade Size:** 0.01 - 2 SOL per trade
- **Take Profit:** 1.5x - 20x multiplier
- **Stop Loss:** -20% to -70% (stored as multiplier: 0.8 = -20%, 0.3 = -70%)
- **Max Positions:** 1 - 10 concurrent positions

## Slippage Settings (in jupiterSwap.js)
- **Buy Slippage:** 5000 bps (50%) - for volatile memecoins
- **Sell Slippage:** 5500 bps (55%) - slightly higher for sells
- **Priority Fee:** 1,000,000 lamports max, "high" priority level
