require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);
const CHANNEL_ID = process.env.CHANNEL_ID || '@callbot1000x';

async function sendTest() {
    // Test milestone message
    const message = `🚀 *2x* 🚀
💰 Call MC: $50.0K
💎 Current MC: $100.0K`;

    try {
        await bot.telegram.sendMessage(CHANNEL_ID, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true
        });
        console.log('Test message sent!');
    } catch (e) {
        console.error('Error:', e.message);
    }
}

sendTest();
