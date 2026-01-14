# 1000x Call Bot - Pump.fun Migration Alerts

Telegram bot that automatically detects and calls new Pump.fun token migrations to Raydium.

## Features

- **Auto Detection** - Monitors Pump.fun graduations in real-time
- **Smart Filters** - Filters by liquidity, market cap, age, buy pressure
- **Risk Analysis** - Scores each token's risk level
- **Instant Calls** - Posts to Telegram channel immediately
- **Full Token Info** - MC, liquidity, volume, socials, links

## Call Message Example

```
🚀 NEW PUMP.FUN MIGRATION 🚀

━━━━━━━━━━━━━━━━━━━━

📛 PEPE2.0 ($PEPE2)

📍 7xKXabc...defg123

━━━━━━━━━━━━━━━━━━━━

💰 Market Cap: $45.5K
💧 Liquidity: $12.0K
💵 Price: $0.00000089
🟢 5m Change: +24.5%

📊 1h Volume: $8.5K
🟢 Buys: 156 | 🔴 Sells: 42

━━━━━━━━━━━━━━━━━━━━

🟢 Risk Level: LOW
📈 Score: 75/100

✅ Strong liquidity
✅ Strong buy pressure
🔥 Very fresh (<5 min)

━━━━━━━━━━━━━━━━━━━━

📈 DexScreener | 🦅 Birdeye | 💊 Pump.fun

⚠️ DYOR - NFA
```

## Setup

### 1. Create Telegram Bot

1. Message [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Copy the bot token

### 2. Create Telegram Channel

1. Create a new channel in Telegram
2. Add your bot as admin (with post permissions)
3. Get channel username (e.g., @my1000xcalls)

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```
BOT_TOKEN=your_bot_token_here
CHANNEL_ID=@your_channel_name
MIN_LIQUIDITY=5000
MIN_MARKET_CAP=10000
```

### 4. Install & Run

```bash
npm install
npm start
```

## Filters

| Filter | Default | Description |
|--------|---------|-------------|
| MIN_LIQUIDITY | $5,000 | Minimum liquidity in USD |
| MIN_MARKET_CAP | $10,000 | Minimum market cap |
| MAX_AGE_MINUTES | 60 | Maximum age since migration |
| MIN_BUY_RATIO | 0.4 | Minimum buy/sell ratio (40%) |

## Bot Commands

| Command | Description |
|---------|-------------|
| /start | Welcome message |
| /status | Bot status |
| /stats | Call statistics |
| /filters | Current filter settings |
| /help | Help information |

## Project Structure

```
1000x-call-bot/
├── src/
│   ├── bot.js                 # Main bot file
│   ├── services/
│   │   └── pumpfunTracker.js  # Migration detection
│   └── utils/
│       └── formatter.js       # Message formatting
├── .env.example
├── package.json
└── README.md
```

## Deployment

### On Server (24/7)

```bash
# SSH to your server
ssh root@your_server_ip

# Clone/upload project
cd /root
git clone your_repo_url
cd 1000x-call-bot

# Install dependencies
npm install

# Create .env
nano .env

# Run with PM2 (keeps running)
npm install -g pm2
pm2 start src/bot.js --name "1000x-bot"
pm2 save
```

## Disclaimer

This bot is for informational purposes only. Cryptocurrency trading is risky. Always DYOR (Do Your Own Research). This is not financial advice.
