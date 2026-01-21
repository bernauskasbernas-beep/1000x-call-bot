require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const PumpFunTracker = require('./services/pumpfunTracker');
const { formatCallMessage } = require('./utils/formatter');
const autoTrader = require('../trading/autoTrader');

// Subscription system
const subscriptionManager = require('../subscription/subscriptionManager');
const PaymentChecker = require('../subscription/paymentChecker');

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const tracker = new PumpFunTracker();

// Channels to post calls
const CHANNEL_ID = process.env.CHANNEL_ID || '@your_channel';  // PAID - instant
const FREE_CHANNEL_ID = process.env.FREE_CHANNEL_ID || null;   // FREE - delayed
const FREE_DELAY_MS = parseInt(process.env.FREE_DELAY_MS) || 120000; // 2 min delay

// ==================== SUBSCRIPTION SYSTEM ====================
const ADMIN_IDS = [1967466851]; // Admin Telegram IDs

const SUBSCRIPTION_CONFIG = {
    walletAddress: 'Gzos8rvjcPD6WWk1YQKFRSbPx9GioPcejLGuZtpHSNDG',
    priceSOL: 0.26,
    paidGroupChatId: -1003321804950, // PAID channel ID (@callbot1000x)
};

// Generate unique one-time invite link for subscriber
async function generateUniqueInviteLink(userId) {
    try {
        const inviteLink = await bot.telegram.createChatInviteLink(SUBSCRIPTION_CONFIG.paidGroupChatId, {
            member_limit: 1,  // Only 1 person can use this link
            expire_date: Math.floor(Date.now() / 1000) + 86400,  // Expires in 24 hours
            name: `User_${userId}_${Date.now()}`  // Optional name for tracking
        });
        return inviteLink.invite_link;
    } catch (error) {
        console.error('Failed to create invite link:', error.message);
        return null;
    }
}

// Track pending payments: oderId -> { telegramId, oderId, createdAt }
const pendingPayments = new Map();
// Track verified users to prevent double-claiming
const verifiedPayments = new Set(); // transaction signatures

// Generate unique order ID for memo field
function generateOrderId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Check Solana transactions for payment
async function checkPayment(orderId, minAmount) {
    try {
        // Use Helius API (free tier) to check transactions
        const response = await axios.get(
            `https://api.helius.xyz/v0/addresses/${SUBSCRIPTION_CONFIG.walletAddress}/transactions?api-key=5c70b747-7e24-415b-8b87-697caaad0360&type=TRANSFER`,
            { timeout: 15000 }
        );

        const transactions = response.data || [];
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000); // Check last hour

        for (const tx of transactions) {
            // Skip if already verified
            if (verifiedPayments.has(tx.signature)) continue;

            // Check if transaction is recent enough
            const txTime = tx.timestamp * 1000;
            if (txTime < oneHourAgo) continue;

            // Check if it's a SOL transfer to our wallet
            if (tx.nativeTransfers) {
                for (const transfer of tx.nativeTransfers) {
                    if (transfer.toUserAccount === SUBSCRIPTION_CONFIG.walletAddress) {
                        const amountSOL = transfer.amount / 1e9; // lamports to SOL

                        // Check if amount matches (with small tolerance)
                        if (amountSOL >= minAmount * 0.99) {
                            // Check memo for order ID
                            const memo = tx.memo || '';
                            if (memo.includes(orderId) || amountSOL >= minAmount) {
                                return { success: true, signature: tx.signature, amount: amountSOL };
                            }
                        }
                    }
                }
            }
        }

        // Fallback: Use Solscan API
        const solscanResponse = await axios.get(
            `https://api.solscan.io/account/transfer?account=${SUBSCRIPTION_CONFIG.walletAddress}&limit=20`,
            { timeout: 15000, headers: { 'Accept': 'application/json' } }
        );

        const solscanTxs = solscanResponse.data?.data || [];
        for (const tx of solscanTxs) {
            if (verifiedPayments.has(tx.txHash)) continue;

            const txTime = tx.blockTime * 1000;
            if (txTime < oneHourAgo) continue;

            if (tx.dst === SUBSCRIPTION_CONFIG.walletAddress && tx.lamport) {
                const amountSOL = tx.lamport / 1e9;
                if (amountSOL >= minAmount * 0.99) {
                    return { success: true, signature: tx.txHash, amount: amountSOL };
                }
            }
        }

        return { success: false };
    } catch (error) {
        console.error('Payment check error:', error.message);
        // If API fails, return pending status
        return { success: false, error: error.message };
    }
}

// Filters
const FILTERS = {
    minLiquidity: parseInt(process.env.MIN_LIQUIDITY) || 0,
    minMarketCap: parseInt(process.env.MIN_MARKET_CAP) || 0,
    maxAgeMinutes: parseInt(process.env.MAX_AGE_MINUTES) || 120,
    minBuyRatio: parseFloat(process.env.MIN_BUY_RATIO) || 0
};

// Stats
let stats = {
    callsSent: 0,
    tokensScanned: 0,
    tokensFiltered: 0,
    startedAt: Date.now()
};

// Performance tracking - stores final X achieved by each token
const performanceHistory = new Map(); // address -> { symbol, name, maxX, calledAt, initialMC }

// Duplicate call prevention - track recently called tokens
const recentlyCalled = new Set(); // token addresses called in last 5 minutes

// ==================== PRICE TRACKER ====================

// Store called tokens with their initial price/MC
const trackedTokens = new Map();

// Milestones to alert (2x, 3x, 5x, 10x, etc.)
const MILESTONES = [2, 3, 5, 10, 20, 50, 100];

// Track a new token
function trackToken(token, messageId, freeMessageId = null) {
    const now = Date.now();
    trackedTokens.set(token.address, {
        name: token.name,
        symbol: token.symbol,
        initialPrice: token.price,
        initialMC: token.marketCap,
        image: token.image,
        calledAt: now,
        lastMilestone: 1,
        maxX: 1,
        alertedMilestones: new Set([1]),
        messageId: messageId, // Store PAID channel message ID for reply
        freeMessageId: freeMessageId // Store FREE channel message ID for reply
    });

    // Also add to performance history
    performanceHistory.set(token.address, {
        symbol: token.symbol,
        name: token.name,
        maxX: 1,
        calledAt: now,
        initialMC: token.marketCap
    });

    console.log(`📌 Tracking: ${token.symbol} @ $${token.marketCap.toLocaleString()} MC | Image: ${token.image ? '✅' : '❌'}`);
}

// Check token prices and send milestone alerts
async function checkMilestones() {
    if (trackedTokens.size === 0) return;

    console.log(`🔄 Checking ${trackedTokens.size} tracked tokens...`);

    for (const [address, data] of trackedTokens) {
        try {
            // Get current price
            const response = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${address}`,
                { timeout: 10000 }
            );

            const pairs = response.data.pairs;
            if (!pairs || pairs.length === 0) continue;

            const currentMC = pairs[0].fdv || 0;
            const currentPrice = parseFloat(pairs[0].priceUsd) || 0;

            if (data.initialMC === 0) continue;

            // Calculate multiplier
            const multiplier = currentMC / data.initialMC;

            // DEBUG: Show current status
            console.log(`   📊 ${data.symbol}: ${multiplier.toFixed(2)}x (MC: $${currentMC.toLocaleString()} / Initial: $${data.initialMC.toLocaleString()})`);

            // Update maxX for stats tracking
            if (multiplier > data.maxX) {
                data.maxX = multiplier;
                // Also update performance history
                if (performanceHistory.has(address)) {
                    performanceHistory.get(address).maxX = multiplier;
                }
            }

            // Check for new milestones
            for (const milestone of MILESTONES) {
                if (multiplier >= milestone && !data.alertedMilestones.has(milestone)) {
                    // New milestone reached! Mark as alerted BEFORE sending
                    data.alertedMilestones.add(milestone);
                    data.lastMilestone = milestone;

                    console.log(`🎯 ${data.symbol} reached ${milestone}x!`);

                    // Send alert
                    await sendMilestoneAlert(data, currentMC, currentPrice, multiplier, milestone);
                }
            }

            // Remove tokens older than 24 hours (but keep in performanceHistory for stats)
            if (Date.now() - data.calledAt > 24 * 60 * 60 * 1000) {
                trackedTokens.delete(address);
                console.log(`🗑️ Removed old token: ${data.symbol}`);
            }

        } catch (error) {
            // Ignore errors for individual tokens
        }
    }
}

// Send milestone alert as reply to original call
async function sendMilestoneAlert(data, currentMC, currentPrice, multiplier, milestone) {
    const rocketEmoji = milestone >= 10 ? '🚀🚀🚀' : milestone >= 5 ? '🚀🚀' : '🚀';

    // Show exact multiplier with 2 decimal places (e.g. 2.17x, 5.43x)
    const exactX = multiplier.toFixed(2);
    const message = `<b>${data.symbol}</b> gains ${rocketEmoji} ${exactX}x ${rocketEmoji}
💰 Call MC: $${formatNumber(data.initialMC)}
💎 Current MC: $${formatNumber(currentMC)}`;

    // Send to PAID channel
    try {
        const options = {
            parse_mode: 'HTML',
            disable_web_page_preview: true
        };

        // Reply to original call message if we have messageId
        if (data.messageId) {
            console.log(`   📎 Replying to message ID: ${data.messageId}`);
            options.reply_to_message_id = data.messageId;
        } else {
            console.log(`   ⚠️ No messageId stored for ${data.symbol}`);
        }

        await bot.telegram.sendMessage(CHANNEL_ID, message, options);
        console.log(`📢 Milestone alert sent: ${data.symbol} ${milestone}x ${data.messageId ? '(reply)' : ''}`);
    } catch (error) {
        console.error('Error sending milestone:', error.message);
    }

    // Send to FREE channel (instant - no delay)
    if (FREE_CHANNEL_ID) {
        try {
            const freeOptions = {
                parse_mode: 'HTML',
                disable_web_page_preview: true
            };

            // Reply to original FREE call message if we have freeMessageId
            if (data.freeMessageId) {
                console.log(`   📎 FREE Replying to message ID: ${data.freeMessageId}`);
                freeOptions.reply_to_message_id = data.freeMessageId;
            }

            await bot.telegram.sendMessage(FREE_CHANNEL_ID, message, freeOptions);
            console.log(`📢 FREE milestone sent: ${data.symbol} ${milestone}x`);
        } catch (error) {
            console.error('Error sending FREE milestone:', error.message);
        }
    }
}

// Helper functions
function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(0);
}

function formatPrice(price) {
    if (!price) return '0';
    if (price < 0.00000001) return price.toExponential(2);
    if (price < 0.0001) return price.toFixed(10).replace(/\.?0+$/, '');
    if (price < 0.01) return price.toFixed(6);
    if (price < 1) return price.toFixed(4);
    return price.toFixed(2);
}

function getTimeAgo(timestamp) {
    const minutes = Math.floor((Date.now() - timestamp) / 60000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

// ==================== BOT COMMANDS ====================

bot.start((ctx) => {
    // Check if user came from "BUY VIP" button (start=vip)
    const startPayload = ctx.startPayload;

    if (startPayload === 'vip') {
        // Go directly to VIP info
        return ctx.replyWithMarkdown(`
💎 *VIP SUBSCRIPTION*

Get *INSTANT* access to all calls!
Premium signals and early access.

━━━━━━━━━━━━━━━━━━━━

📩 *Contact owner for VIP access:*
👤 @imthebestever1

━━━━━━━━━━━━━━━━━━━━

✅ Fast response
✅ Secure payment
✅ Instant access after payment
        `, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📩 Contact Owner', url: 'https://t.me/imthebestever1' }],
                    [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
                ]
            }
        });
    }

    // Normal start - show menu
    ctx.replyWithMarkdown(`
🚀 *Welcome to 1000x Call Bot!*

The fastest Pump.fun migration alerts.

💎 *PAID* - Instant calls
🆓 *FREE* - 2 minute delay

Choose an option below:
    `, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Info', callback_data: 'menu_info' },
                    { text: '💎 Buy VIP', callback_data: 'menu_vip' }
                ],
                [
                    { text: '📈 Stats', callback_data: 'menu_stats' },
                    { text: '🔍 Status', callback_data: 'menu_status' }
                ],
                [
                    { text: '💬 Support', callback_data: 'menu_support' },
                    { text: '📢 Channels', callback_data: 'menu_channels' }
                ],
                [
                    { text: '🤖 Auto Trading', callback_data: 'menu_trading' }
                ]
            ]
        }
    });
});

// Main menu command
bot.command('menu', (ctx) => {
    ctx.replyWithMarkdown(`
🚀 *1000x Call Bot Menu*

Choose an option:
    `, {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Info', callback_data: 'menu_info' },
                    { text: '💎 Buy VIP', callback_data: 'menu_vip' }
                ],
                [
                    { text: '📈 Stats', callback_data: 'menu_stats' },
                    { text: '🔍 Status', callback_data: 'menu_status' }
                ],
                [
                    { text: '💬 Support', callback_data: 'menu_support' },
                    { text: '📢 Channels', callback_data: 'menu_channels' }
                ],
                [
                    { text: '🤖 Auto Trading', callback_data: 'menu_trading' }
                ]
            ]
        }
    });
});

// Menu button handlers
bot.action('menu_info', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
📊 *What is 1000x Call Bot?*

We track Pump.fun token migrations to Raydium in real-time.

✅ Instant migration alerts
✅ Price milestone tracking (2x, 5x, 10x+)
✅ Safety score analysis
✅ Token socials & links

💎 *VIP* = Instant calls
🆓 *FREE* = 2 min delay
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

bot.action('menu_vip', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const plans = subscriptionManager.getPlans();

    // Check if user already has active subscription
    if (subscriptionManager.isSubscribed(userId)) {
        const sub = subscriptionManager.getSubscriber(userId);
        let expiryText = sub.isLifetime ? 'Never (Lifetime)' : new Date(sub.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

        await ctx.editMessageText(`
💎 *VIP SUBSCRIPTION*

✅ You are already a VIP member!

📋 *Your Subscription:*
• Plan: ${sub.planName}
• Expires: ${expiryText}

🔗 *VIP Channel Link:*
${sub.inviteLink || 'Contact @imthebestever1 for access'}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
                ]
            }
        });
        return;
    }

    await ctx.editMessageText(`
💎 *VIP SUBSCRIPTION*

Get *INSTANT* access to all calls!
Premium signals and early access.

━━━━━━━━━━━━━━━━━━━━
💰 *PRICING:*
━━━━━━━━━━━━━━━━━━━━

📅 1 Month - ${plans['1month'].price} SOL
📅 2 Months - ${plans['2months'].price} SOL
📅 3 Months - ${plans['3months'].price} SOL
👑 Lifetime - ${plans['lifetime'].price} SOL

━━━━━━━━━━━━━━━━━━━━

✅ Automatic payment verification
✅ Instant access after payment
✅ Unique one-time invite link

_Select a plan to continue:_
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📅 1 Month', callback_data: 'vip_buy_1month' },
                    { text: '📅 2 Months', callback_data: 'vip_buy_2months' }
                ],
                [
                    { text: '📅 3 Months', callback_data: 'vip_buy_3months' },
                    { text: '👑 Lifetime', callback_data: 'vip_buy_lifetime' }
                ],
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

// VIP purchase flow - plan selection
bot.action(/vip_buy_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const username = ctx.from.username || ctx.from.first_name || 'Unknown';
    const planId = ctx.match[1];

    // Create pending payment
    const payment = subscriptionManager.createPendingPayment(userId, username, planId);

    if (!payment) {
        await ctx.editMessageText('❌ Invalid plan selected.', {
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu_vip' }]]
            }
        });
        return;
    }

    await ctx.editMessageText(`
💎 *VIP SUBSCRIPTION - ${payment.planName}*

━━━━━━━━━━━━━━━━━━━━
📋 *ORDER DETAILS:*
━━━━━━━━━━━━━━━━━━━━

🆔 Order: \`${payment.orderId}\`
📅 Plan: ${payment.planName}
💰 Amount: *${payment.uniqueAmount.toFixed(6)} SOL*

━━━━━━━━━━━━━━━━━━━━
📤 *SEND PAYMENT TO:*
━━━━━━━━━━━━━━━━━━━━

\`${payment.wallet}\`

⚠️ *IMPORTANT:*
• Send *EXACTLY* ${payment.uniqueAmount.toFixed(6)} SOL
• The unique amount helps identify your payment
• Payment expires in 30 minutes

━━━━━━━━━━━━━━━━━━━━

After sending, click "✅ Check Payment" below.
_Payment is auto-checked every 30 seconds._
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Check Payment', callback_data: 'vip_check_payment' }],
                [{ text: '❌ Cancel', callback_data: 'vip_cancel' }]
            ]
        }
    });
});

// Check payment status
bot.action('vip_check_payment', async (ctx) => {
    await ctx.answerCbQuery('🔍 Checking payment...');
    const userId = ctx.from.id.toString();

    const payment = subscriptionManager.getPendingPayment(userId);

    if (!payment) {
        await ctx.editMessageText(`
❌ *No Pending Payment*

Your payment session has expired or was cancelled.
Please start a new order.
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '💎 Buy VIP', callback_data: 'menu_vip' }]]
            }
        });
        return;
    }

    await ctx.editMessageText(`
⏳ *CHECKING PAYMENT...*

🆔 Order: \`${payment.orderId}\`
💰 Looking for: ${payment.uniqueAmount.toFixed(6)} SOL

_Please wait..._
    `, { parse_mode: 'Markdown' });

    // The actual payment checking is done by PaymentChecker automatically
    // This just shows the user their pending payment status

    setTimeout(async () => {
        // Check if payment was confirmed while we waited
        if (subscriptionManager.isSubscribed(userId)) {
            const sub = subscriptionManager.getSubscriber(userId);
            let expiryText = sub.isLifetime ? 'Never (Lifetime)' : new Date(sub.expiresAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

            await ctx.editMessageText(`
🎉 *PAYMENT CONFIRMED!*

✅ Your VIP subscription is now active!

📋 *Details:*
• Plan: ${sub.planName}
• Expires: ${expiryText}

🔗 *Join VIP Channel:*
${sub.inviteLink}

⚠️ This link is unique to you and can only be used once!
            `, {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]]
                }
            });
        } else {
            await ctx.editMessageText(`
⏳ *PAYMENT NOT FOUND YET*

🆔 Order: \`${payment.orderId}\`
💰 Amount: ${payment.uniqueAmount.toFixed(6)} SOL
📤 Wallet: \`${payment.wallet}\`

_Make sure you sent the EXACT amount._
_Payments are checked automatically every 30s._

⏱️ Expires: ${Math.ceil((payment.expiresAt - Date.now()) / 60000)} minutes
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🔄 Check Again', callback_data: 'vip_check_payment' }],
                        [{ text: '❌ Cancel', callback_data: 'vip_cancel' }]
                    ]
                }
            });
        }
    }, 3000);
});

// Cancel payment
bot.action('vip_cancel', async (ctx) => {
    await ctx.answerCbQuery('Payment cancelled');
    const userId = ctx.from.id.toString();

    subscriptionManager.cancelPendingPayment(userId);

    await ctx.editMessageText(`
❌ *Payment Cancelled*

Your order has been cancelled.
No payment was processed.
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[{ text: '💎 Buy VIP', callback_data: 'menu_vip' }]]
        }
    });
});

bot.action('menu_stats', async (ctx) => {
    await ctx.answerCbQuery();

    // Calculate stats from performanceHistory (last 24h)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    let totalTokens = 0;
    let x2 = 0, x3_5 = 0, x5_10 = 0, x10_50 = 0, x50_100 = 0, x100plus = 0;
    let losses = 0;
    let totalROI = 0;

    for (const [, data] of performanceHistory) {
        if (data.calledAt >= oneDayAgo) {
            totalTokens++;
            const maxX = data.maxX || 1;

            // Calculate ROI for this token
            if (maxX >= 2) {
                totalROI += (maxX - 1) * 100;
            } else {
                totalROI -= 100;
                losses++;
            }

            // Categorize by multiplier
            if (maxX >= 100) x100plus++;
            else if (maxX >= 50) x50_100++;
            else if (maxX >= 10) x10_50++;
            else if (maxX >= 5) x5_10++;
            else if (maxX >= 3) x3_5++;
            else if (maxX >= 2) x2++;
        }
    }

    const winners = x2 + x3_5 + x5_10 + x10_50 + x50_100 + x100plus;
    const winRate = totalTokens > 0 ? ((winners / totalTokens) * 100).toFixed(2) : '0.00';
    const avgGains = totalTokens > 0 ? (totalROI / totalTokens).toFixed(2) : '0.00';

    await ctx.editMessageText(`📊 *Trade Outcome Statistics (Last 24 Hours):*

🔍 *Total Tokens Found:* ${totalTokens}

*Outcomes:*
✅ 2x: ${x2} tokens
✅ 3-5x: ${x3_5} tokens
✅ 5-10x: ${x5_10} tokens
✅ 10-50x: ${x10_50} tokens
✅ 50-100x: ${x50_100} tokens
✅ >100x: ${x100plus} tokens
❌ loss: ${losses} tokens

🔴 *Win Rate:* ${winRate}%
📈 *Total ROI:* ${totalROI.toFixed(2)}%
🔑 *Average Gains:* ${avgGains}%

📡 *Currently Tracking:* ${trackedTokens.size} tokens
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'menu_stats' }],
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

bot.action('menu_status', async (ctx) => {
    await ctx.answerCbQuery();
    const uptime = Math.floor((Date.now() - stats.startedAt) / 60000);

    await ctx.editMessageText(`
🔍 *BOT STATUS*

🟢 Status: Online
⏱️ Uptime: ${uptime} minutes
📡 Tracking: Pump.fun migrations
📈 Tokens tracked: ${trackedTokens.size}
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

bot.action('menu_support', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
💬 *SUPPORT*

Need help? Contact us:

👤 @imthebestever1
👤 @nebezinaunieka

We typically respond within 24 hours.
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

bot.action('menu_channels', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
📢 *OUR CHANNELS*

💎 *VIP Channel:* Instant calls
   (Subscribe to get access)

🆓 *Free Channel:* ${FREE_CHANNEL_ID}
   (2 min delay)

Join FREE channel to see our calls!
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🆓 Join FREE', url: `https://t.me/${FREE_CHANNEL_ID.replace('@', '')}` }],
                [{ text: '💎 Get VIP Access', callback_data: 'menu_vip' }],
                [{ text: '⬅️ Back to Menu', callback_data: 'menu_back' }]
            ]
        }
    });
});

bot.action('menu_back', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
🚀 *1000x Call Bot Menu*

Choose an option:
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '📊 Info', callback_data: 'menu_info' },
                    { text: '💎 Buy VIP', callback_data: 'menu_vip' }
                ],
                [
                    { text: '📈 Stats', callback_data: 'menu_stats' },
                    { text: '🔍 Status', callback_data: 'menu_status' }
                ],
                [
                    { text: '💬 Support', callback_data: 'menu_support' },
                    { text: '📢 Channels', callback_data: 'menu_channels' }
                ],
                [
                    { text: '🤖 Auto Trading', callback_data: 'menu_trading' }
                ]
            ]
        }
    });
});

// ==================== AUTO TRADING MENU ====================

const jupiterSwap = require('../trading/jupiterSwap');

// Main trading menu
bot.action('menu_trading', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = autoTrader.getUserProfile(userId);

    const statusEmoji = user.tradingEnabled ? '🟢' : '🔴';
    const statusText = user.tradingEnabled ? 'ENABLED' : 'DISABLED';

    let balanceText = 'Not connected';
    try {
        const balance = await jupiterSwap.getWalletBalance();
        balanceText = balance.toFixed(4) + ' SOL';
    } catch (e) {
        balanceText = 'Error';
    }

    await ctx.editMessageText(`
🤖 *AUTO TRADING*

${statusEmoji} Status: *${statusText}*
💰 Wallet: ${balanceText}
📊 Positions: ${user.positions?.length || 0}/${user.settings.maxPositions}

*Current Settings:*
💵 Trade Size: ${user.settings.tradeSize} SOL
🎯 Take Profit: ${user.settings.takeProfitMultiplier}x
🛑 Stop Loss: -${((1 - user.settings.stopLossMultiplier) * 100).toFixed(0)}%

_When enabled, bot will auto-buy every call and auto-sell at TP/SL._
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: user.tradingEnabled ? '🔴 Disable Trading' : '🟢 Enable Trading', callback_data: 'trading_toggle' }
                ],
                [
                    { text: '⚙️ Settings', callback_data: 'trading_settings' },
                    { text: '📊 Positions', callback_data: 'trading_positions' }
                ],
                [
                    { text: '💼 Wallet', callback_data: 'trading_wallet' },
                    { text: '📜 History', callback_data: 'trading_history' }
                ],
                [
                    { text: '⬅️ Back to Menu', callback_data: 'menu_back' }
                ]
            ]
        }
    });
});

// Toggle trading on/off
bot.action('trading_toggle', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = autoTrader.getUserProfile(userId);

    const newStatus = !user.tradingEnabled;
    autoTrader.updateUserProfile(userId, { tradingEnabled: newStatus });

    const emoji = newStatus ? '🟢' : '🔴';
    const text = newStatus ? 'ENABLED' : 'DISABLED';

    await ctx.editMessageText(`
${emoji} *Auto Trading ${text}*

${newStatus ? 'Bot will now automatically buy every call and sell at your TP/SL settings.' : 'Auto trading is now disabled. Bot will not make any trades.'}
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]
            ]
        }
    });
});

// Trading settings menu
bot.action('trading_settings', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = autoTrader.getUserProfile(userId);

    await ctx.editMessageText(`
⚙️ *TRADING SETTINGS*

💵 *Trade Size:* ${user.settings.tradeSize} SOL
🎯 *Take Profit:* ${user.settings.takeProfitMultiplier}x
🛑 *Stop Loss:* -${((1 - user.settings.stopLossMultiplier) * 100).toFixed(0)}%
📊 *Max Positions:* ${user.settings.maxPositions}

_Tap a button to change setting:_
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💵 Trade Size', callback_data: 'set_tradesize' }
                ],
                [
                    { text: '🎯 Take Profit', callback_data: 'set_takeprofit' }
                ],
                [
                    { text: '🛑 Stop Loss', callback_data: 'set_stoploss' }
                ],
                [
                    { text: '📊 Max Positions', callback_data: 'set_maxpos' }
                ],
                [
                    { text: '⬅️ Back to Trading', callback_data: 'menu_trading' }
                ]
            ]
        }
    });
});

// Trade size options
bot.action('set_tradesize', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
💵 *SET TRADE SIZE*

Select how much SOL to spend per trade:
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '0.01 SOL', callback_data: 'tradesize_0.01' },
                    { text: '0.02 SOL', callback_data: 'tradesize_0.02' },
                    { text: '0.05 SOL', callback_data: 'tradesize_0.05' }
                ],
                [
                    { text: '0.1 SOL', callback_data: 'tradesize_0.1' },
                    { text: '0.2 SOL', callback_data: 'tradesize_0.2' },
                    { text: '0.5 SOL', callback_data: 'tradesize_0.5' }
                ],
                [
                    { text: '1 SOL', callback_data: 'tradesize_1' },
                    { text: '2 SOL', callback_data: 'tradesize_2' }
                ],
                [
                    { text: '⬅️ Back', callback_data: 'trading_settings' }
                ]
            ]
        }
    });
});

// Handle trade size selection
bot.action(/tradesize_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const size = parseFloat(ctx.match[1]);

    autoTrader.updateUserSettings(userId, 'tradeSize', size);

    await ctx.editMessageText(`
✅ *Trade Size Updated*

New trade size: *${size} SOL*
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Settings', callback_data: 'trading_settings' }]
            ]
        }
    });
});

// Take profit options
bot.action('set_takeprofit', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
🎯 *SET TAKE PROFIT*

Sell automatically when token reaches:
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '1.5x', callback_data: 'tp_1.5' },
                    { text: '2x', callback_data: 'tp_2' },
                    { text: '3x', callback_data: 'tp_3' }
                ],
                [
                    { text: '5x', callback_data: 'tp_5' },
                    { text: '10x', callback_data: 'tp_10' },
                    { text: '20x', callback_data: 'tp_20' }
                ],
                [
                    { text: '⬅️ Back', callback_data: 'trading_settings' }
                ]
            ]
        }
    });
});

bot.action(/tp_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const tp = parseFloat(ctx.match[1]);

    autoTrader.updateUserSettings(userId, 'takeProfitMultiplier', tp);

    await ctx.editMessageText(`
✅ *Take Profit Updated*

New TP: *${tp}x*
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Settings', callback_data: 'trading_settings' }]
            ]
        }
    });
});

// Stop loss options
bot.action('set_stoploss', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
🛑 *SET STOP LOSS*

Sell automatically when token drops to:
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '-20%', callback_data: 'sl_0.8' },
                    { text: '-30%', callback_data: 'sl_0.7' },
                    { text: '-40%', callback_data: 'sl_0.6' }
                ],
                [
                    { text: '-50%', callback_data: 'sl_0.5' },
                    { text: '-60%', callback_data: 'sl_0.4' },
                    { text: '-70%', callback_data: 'sl_0.3' }
                ],
                [
                    { text: '⬅️ Back', callback_data: 'trading_settings' }
                ]
            ]
        }
    });
});

bot.action(/sl_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const sl = parseFloat(ctx.match[1]);

    autoTrader.updateUserSettings(userId, 'stopLossMultiplier', sl);

    await ctx.editMessageText(`
✅ *Stop Loss Updated*

New SL: *-${((1 - sl) * 100).toFixed(0)}%*
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Settings', callback_data: 'trading_settings' }]
            ]
        }
    });
});

// Max positions options
bot.action('set_maxpos', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`
📊 *SET MAX POSITIONS*

Maximum open positions at once:
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '1', callback_data: 'maxpos_1' },
                    { text: '2', callback_data: 'maxpos_2' },
                    { text: '3', callback_data: 'maxpos_3' }
                ],
                [
                    { text: '5', callback_data: 'maxpos_5' },
                    { text: '10', callback_data: 'maxpos_10' }
                ],
                [
                    { text: '⬅️ Back', callback_data: 'trading_settings' }
                ]
            ]
        }
    });
});

bot.action(/maxpos_(.+)/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const max = parseInt(ctx.match[1]);

    autoTrader.updateUserSettings(userId, 'maxPositions', max);

    await ctx.editMessageText(`
✅ *Max Positions Updated*

New max: *${max} positions*
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Settings', callback_data: 'trading_settings' }]
            ]
        }
    });
});

// Positions view with live P&L
bot.action('trading_positions', async (ctx) => {
    await ctx.answerCbQuery('Loading positions...');
    const userId = ctx.from.id.toString();
    const user = autoTrader.getUserProfile(userId);

    if (!user.positions || user.positions.length === 0) {
        await ctx.editMessageText(`
📊 *OPEN POSITIONS*

No open positions.

_When auto trading is enabled, bought tokens will appear here._
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔄 Refresh', callback_data: 'trading_positions' }],
                    [{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]
                ]
            }
        });
        return;
    }

    let posText = '';
    const buttons = [];
    let totalPnlPct = 0;

    for (const pos of user.positions) {
        const ageMin = Math.floor((Date.now() - pos.boughtAt) / 60000);
        const ageText = ageMin < 60 ? `${ageMin}m` : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`;

        // Fetch current market cap from DexScreener
        let pnlText = '';
        let pnlPct = 0;
        try {
            const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${pos.tokenAddress}`);
            const data = await response.json();
            if (data.pairs && data.pairs.length > 0) {
                const currentMC = data.pairs[0].fdv || data.pairs[0].marketCap || 0;
                if (currentMC > 0 && pos.buyMC > 0) {
                    const multiplier = currentMC / pos.buyMC;
                    pnlPct = (multiplier - 1) * 100;
                    totalPnlPct += pnlPct;

                    const emoji = pnlPct >= 0 ? '🟢' : '🔴';
                    const sign = pnlPct >= 0 ? '+' : '';
                    pnlText = `${emoji} ${sign}${pnlPct.toFixed(1)}% (${multiplier.toFixed(2)}x)`;
                } else {
                    pnlText = '⏳ Calculating...';
                }
            } else {
                pnlText = '❓ No data';
            }
        } catch (error) {
            pnlText = '❓ Error';
        }

        posText += `\n🪙 *${pos.symbol}*\n`;
        posText += `   💰 ${pos.solSpent} SOL | ⏱️ ${ageText}\n`;
        posText += `   📊 ${pnlText}\n`;

        buttons.push([{ text: `🔴 Sell ${pos.symbol}`, callback_data: `sell_${pos.tokenAddress.substring(0, 20)}` }]);
    }

    // Add refresh button at top
    buttons.unshift([{ text: '🔄 Refresh Prices', callback_data: 'trading_positions' }]);
    buttons.push([{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]);

    const avgPnl = user.positions.length > 0 ? totalPnlPct / user.positions.length : 0;
    const avgEmoji = avgPnl >= 0 ? '📈' : '📉';
    const avgSign = avgPnl >= 0 ? '+' : '';

    await ctx.editMessageText(`
📊 *OPEN POSITIONS* (${user.positions.length}/${user.settings.maxPositions})
${avgEmoji} Avg P&L: ${avgSign}${avgPnl.toFixed(1)}%
${posText}
_Tap to manually sell:_
    `, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
    });
});

// Manual sell
bot.action(/sell_(.+)/, async (ctx) => {
    await ctx.answerCbQuery('Selling...');
    const userId = ctx.from.id.toString();
    const addressPrefix = ctx.match[1];

    const user = autoTrader.getUserProfile(userId);
    const position = user.positions?.find(p => p.tokenAddress.startsWith(addressPrefix));

    if (!position) {
        await ctx.editMessageText('❌ Position not found.', {
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'trading_positions' }]]
            }
        });
        return;
    }

    const result = await autoTrader.manualSell(userId, position.tokenAddress, bot);

    if (result.success) {
        await ctx.editMessageText(`
✅ *SOLD ${position.symbol}*

🔗 TX: ${result.txUrl}
        `, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back to Positions', callback_data: 'trading_positions' }]]
            }
        });
    } else {
        await ctx.editMessageText(`
❌ *Sell Failed*

Error: ${result.error}
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[{ text: '⬅️ Back to Positions', callback_data: 'trading_positions' }]]
            }
        });
    }
});

// Wallet info
bot.action('trading_wallet', async (ctx) => {
    await ctx.answerCbQuery();

    let walletInfo = 'Not configured';
    let balance = 'N/A';
    let address = 'N/A';

    try {
        const keypair = jupiterSwap.getTradingKeypair();
        address = keypair.publicKey.toString();
        const bal = await jupiterSwap.getWalletBalance();
        balance = bal.toFixed(4) + ' SOL';
        walletInfo = 'Connected';
    } catch (e) {
        walletInfo = 'Error: ' + e.message;
    }

    await ctx.editMessageText(`
💼 *TRADING WALLET*

📊 Status: ${walletInfo}
💰 Balance: ${balance}
📍 Address:
\`${address}\`

_This wallet is used for auto trading._
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Refresh Balance', callback_data: 'trading_wallet' }],
                [{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]
            ]
        }
    });
});

// Trading history
bot.action('trading_history', async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id.toString();
    const user = autoTrader.getUserProfile(userId);

    if (!user.history || user.history.length === 0) {
        await ctx.editMessageText(`
📜 *TRADING HISTORY*

No trades yet.
        `, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]
                ]
            }
        });
        return;
    }

    // Show last 5 trades
    const recent = user.history.slice(-5).reverse();
    let histText = '';
    let totalPnl = 0;

    for (const trade of recent) {
        const emoji = (trade.pnl || 0) > 0 ? '🟢' : '🔴';
        const pnlText = trade.pnl ? (trade.pnl > 0 ? '+' : '') + trade.pnl.toFixed(4) : 'N/A';
        histText += `${emoji} *${trade.symbol}* | ${trade.reason || 'MANUAL'}\n`;
        histText += `   P&L: ${pnlText} SOL\n`;
        totalPnl += trade.pnl || 0;
    }

    await ctx.editMessageText(`
📜 *TRADING HISTORY* (Last 5)
${histText}
📊 *Total P&L:* ${totalPnl > 0 ? '+' : ''}${totalPnl.toFixed(4)} SOL
    `, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '⬅️ Back to Trading', callback_data: 'menu_trading' }]
            ]
        }
    });
});

bot.command('status', (ctx) => {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 60000);
    ctx.replyWithMarkdown(`
📊 *Bot Status*

🟢 Status: Online
⏱️ Uptime: ${uptime} minutes
📡 Tracking: Pump.fun migrations
📈 Tokens tracked: ${trackedTokens.size}
📢 Channel: ${CHANNEL_ID}
    `);
});

bot.command('stats', (ctx) => {
    // Calculate performance breakdown from performanceHistory
    let x2to5 = 0;      // 2x - 5x
    let x5to15 = 0;     // 5x - 15x
    let x15to50 = 0;    // 15x - 50x
    let x50plus = 0;    // 50x+
    let under2x = 0;    // < 2x

    for (const [, data] of performanceHistory) {
        const maxX = data.maxX || 1;
        if (maxX >= 50) {
            x50plus++;
        } else if (maxX >= 15) {
            x15to50++;
        } else if (maxX >= 5) {
            x5to15++;
        } else if (maxX >= 2) {
            x2to5++;
        } else {
            under2x++;
        }
    }

    const totalCalls = performanceHistory.size;
    const uptimeMs = Date.now() - stats.startedAt;
    const uptimeHours = Math.floor(uptimeMs / (1000 * 60 * 60));
    const uptimeMins = Math.floor((uptimeMs % (1000 * 60 * 60)) / (1000 * 60));

    // Calculate percentages
    const pct = (n) => totalCalls > 0 ? ((n / totalCalls) * 100).toFixed(1) : '0.0';

    ctx.replyWithMarkdown(`
📊 *CALL BOT STATISTICS*

⏱️ *Uptime:* ${uptimeHours}h ${uptimeMins}m
📅 *Started:* ${new Date(stats.startedAt).toLocaleString()}

━━━━━━━━━━━━━━━━━━━━
📈 *PERFORMANCE BREAKDOWN*
━━━━━━━━━━━━━━━━━━━━

🚀 *50x+:* ${x50plus} calls (${pct(x50plus)}%)
🔥 *15x - 50x:* ${x15to50} calls (${pct(x15to50)}%)
💎 *5x - 15x:* ${x5to15} calls (${pct(x5to15)}%)
✅ *2x - 5x:* ${x2to5} calls (${pct(x2to5)}%)
❌ *Under 2x:* ${under2x} calls (${pct(under2x)}%)

━━━━━━━━━━━━━━━━━━━━
📋 *TOTALS*
━━━━━━━━━━━━━━━━━━━━

📞 Total Calls: ${totalCalls}
🔍 Tokens Scanned: ${stats.tokensScanned}
🚫 Filtered Out: ${stats.tokensFiltered}
📡 Currently Tracking: ${trackedTokens.size}
    `);
});

bot.command('tracking', (ctx) => {
    if (trackedTokens.size === 0) {
        ctx.reply('No tokens being tracked yet.');
        return;
    }

    let message = '📈 *Tracked Tokens*\n\n';
    let count = 0;

    for (const [address, data] of trackedTokens) {
        if (count >= 10) break;
        message += `• *${data.symbol}* - ${data.lastMilestone}x reached\n`;
        count++;
    }

    ctx.replyWithMarkdown(message);
});

bot.command('help', (ctx) => {
    ctx.replyWithMarkdown(`
❓ *Help*

This bot:
1. Detects new Pump.fun migrations
2. Posts calls to the channel
3. Tracks prices after calling
4. Alerts when tokens hit 2x, 5x, 10x+

*Commands:*
/status - Bot status
/stats - Statistics
/tracking - View tracked tokens
/subscribe - Get PAID access
/paid - Verify payment

*Join:* ${CHANNEL_ID}
    `);
});

// ==================== ADMIN COMMANDS ====================

bot.command('invite', async (ctx) => {
    const userId = ctx.from.id;

    // Check if user is admin
    if (!ADMIN_IDS.includes(userId)) {
        return ctx.reply('❌ Access denied.');
    }

    try {
        const inviteLink = await bot.telegram.createChatInviteLink(SUBSCRIPTION_CONFIG.paidGroupChatId, {
            member_limit: 1,
            expire_date: Math.floor(Date.now() / 1000) + 86400 * 7, // 7 days
            name: `Admin_${Date.now()}`
        });

        ctx.replyWithMarkdown(`
🔐 *ADMIN INVITE LINK*

👇 One-time use link (expires in 7 days):
${inviteLink.invite_link}
        `);
    } catch (error) {
        ctx.reply(`❌ Error: ${error.message}`);
    }
});

// ==================== SUBSCRIPTION COMMANDS ====================

bot.command('subscribe', (ctx) => {
    ctx.replyWithMarkdown(`
💎 *VIP SUBSCRIPTION*

Get *INSTANT* access to all calls!
Premium signals and early access.

━━━━━━━━━━━━━━━━━━━━

📩 *Contact owner for VIP access:*
👤 @imthebestever1

━━━━━━━━━━━━━━━━━━━━

✅ Fast response
✅ Secure payment
✅ Instant access after payment
    `, {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📩 Contact Owner', url: 'https://t.me/imthebestever1' }]
            ]
        }
    });
});

bot.command('paid', async (ctx) => {
    const telegramId = ctx.from.id;

    // Find user's pending payment
    let userOrderId = null;
    for (const [orderId, data] of pendingPayments) {
        if (data.telegramId === telegramId) {
            userOrderId = orderId;
            break;
        }
    }

    if (!userOrderId) {
        ctx.reply('❌ No pending payment found. Use /subscribe first.');
        return;
    }

    await ctx.reply('🔍 Checking payment... Please wait.');

    const result = await checkPayment(userOrderId, SUBSCRIPTION_CONFIG.priceSOL);

    if (result.success) {
        // Mark as verified
        verifiedPayments.add(result.signature);
        pendingPayments.delete(userOrderId);

        // Generate unique one-time invite link
        const uniqueLink = await generateUniqueInviteLink(telegramId);

        if (uniqueLink) {
            ctx.replyWithMarkdown(`
✅ *PAYMENT VERIFIED!*

💰 Amount: ${result.amount.toFixed(4)} SOL
🔗 TX: \`${result.signature.substring(0, 20)}...\`

━━━━━━━━━━━━━━━━━━━━

🎉 *Welcome to PREMIUM!*

👇 Your *PERSONAL* invite link (1-time use, expires in 24h):
            `, {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 JOIN PAID GROUP', url: uniqueLink }
                    ]]
                }
            });
        } else {
            ctx.replyWithMarkdown(`
✅ *PAYMENT VERIFIED!*

💰 Amount: ${result.amount.toFixed(4)} SOL

⚠️ Could not generate invite link. Please contact @your_support
            `);
        }

        console.log(`💰 New subscriber! User: ${telegramId}, TX: ${result.signature}, Link: ${uniqueLink}`);
    } else {
        ctx.replyWithMarkdown(`
⏳ *Payment not found yet*

Make sure you sent *${SUBSCRIPTION_CONFIG.priceSOL} SOL* to:
\`${SUBSCRIPTION_CONFIG.walletAddress}\`

_Transactions may take 1-2 minutes to appear._
_Try /paid again in a moment._

❓ If you already paid, contact @your_support
        `);
    }
});

// Handle callback buttons
bot.action('copy_wallet', (ctx) => {
    ctx.answerCbQuery(`Wallet: ${SUBSCRIPTION_CONFIG.walletAddress}`);
});

bot.action(/check_payment_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const userId = ctx.from.id;

    await ctx.answerCbQuery('🔍 Checking payment...');

    const result = await checkPayment(orderId, SUBSCRIPTION_CONFIG.priceSOL);

    if (result.success) {
        verifiedPayments.add(result.signature);
        pendingPayments.delete(orderId);

        // Generate unique one-time invite link
        const uniqueLink = await generateUniqueInviteLink(userId);

        if (uniqueLink) {
            await ctx.editMessageText(`
✅ *PAYMENT VERIFIED!*

💰 Amount: ${result.amount.toFixed(4)} SOL

🎉 *Welcome to PREMIUM!*

👇 Your *PERSONAL* invite link (1-time use, expires in 24h):
            `, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '🚀 JOIN PAID GROUP', url: uniqueLink }
                    ]]
                }
            });
        } else {
            await ctx.editMessageText(`
✅ *PAYMENT VERIFIED!*

💰 Amount: ${result.amount.toFixed(4)} SOL

⚠️ Could not generate invite link. Please contact @your_support
            `, { parse_mode: 'Markdown' });
        }

        console.log(`💰 New subscriber! User: ${userId}, TX: ${result.signature}, Link: ${uniqueLink}`);
    } else {
        await ctx.reply('⏳ Payment not found yet. Make sure you sent the correct amount and try again in 1-2 minutes.');
    }
});

// ==================== MIGRATION HANDLER ====================

// Helper function to send call to a channel
async function sendCallToChannel(channelId, message, imageBuffer, channelName = 'PAID') {
    const replyMarkup = {
        inline_keyboard: [
            [
                { text: '🔫 REKTsol', url: 'https://t.me/REKTsol_bot?start=callbot' },
                { text: '🤖 Maestro', url: 'https://t.me/maestro?start=r-imthebestever1' }
            ],
            [
                { text: '💎 BUY VIP', url: 'https://t.me/Degens_1000x_call_bot' }
            ]
        ]
    };

    try {
        if (imageBuffer) {
            const sentMessage = await bot.telegram.sendPhoto(channelId, {
                source: imageBuffer,
                filename: 'token.png'
            }, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
            console.log(`📢 [${channelName}] Call with photo sent`);
            return sentMessage.message_id;
        } else {
            const sentMessage = await bot.telegram.sendMessage(channelId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
                reply_markup: replyMarkup
            });
            console.log(`📢 [${channelName}] Call sent as text`);
            return sentMessage.message_id;
        }
    } catch (error) {
        console.error(`[${channelName}] Failed to send call:`, error.message);
        return null;
    }
}

tracker.on('newMigration', async (token) => {
    stats.tokensScanned++;

    console.log(`📡 Scanning: ${token.name} (${token.symbol})`);

    // Duplicate call prevention - skip if already called in last 5 minutes
    if (recentlyCalled.has(token.address)) {
        console.log(`⏭️ SKIP: ${token.symbol} already called recently`);
        return;
    }

    const filterResult = tracker.checkFilters(token, FILTERS);

    if (!filterResult.passed) {
        stats.tokensFiltered++;
        console.log(`❌ Filtered out: ${token.symbol}`);
        return;
    }

    const safety = await tracker.getSafetyScore(token);

    console.log(`✅ CALL: ${token.name} (${token.symbol}) - Risk: ${safety.risk}`);

    const message = formatCallMessage(token, safety);

    // Download image using multiple sources
    let imageBuffer = null;
    let imageUrl = token.image;

    // Helper function to convert IPFS URL to working gateway
    const getWorkingIpfsUrl = (url) => {
        if (!url) return null;
        // Extract IPFS hash from various URL formats
        let hash = null;
        if (url.includes('/ipfs/')) {
            hash = url.split('/ipfs/')[1];
        } else if (url.includes('ipfs://')) {
            hash = url.replace('ipfs://', '');
        }
        if (hash) {
            // Use Cloudflare IPFS gateway (no SSL issues)
            return `https://cloudflare-ipfs.com/ipfs/${hash}`;
        }
        return url;
    };

    // Step 1: Try DexScreener CDN first (most reliable, no SSL issues)
    try {
        const dexResponse = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${token.address}`, { timeout: 10000 });
        const dexImage = dexResponse.data?.pairs?.[0]?.info?.imageUrl;

        if (dexImage && dexImage.includes('cdn.dexscreener.com')) {
            console.log(`   📷 Trying DexScreener CDN...`);
            const response = await axios.get(dexImage, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://dexscreener.com' }
            });
            if (response.data && response.data.length > 500) {
                imageBuffer = Buffer.from(response.data);
                console.log(`   ✅ Image from DexScreener CDN`);
            }
        }
    } catch (e) {
        console.log(`   ⚠️ DexScreener CDN failed: ${e.message}`);
    }

    // Step 2: Try SVS API with Cloudflare IPFS gateway
    if (!imageBuffer && imageUrl) {
        const workingUrl = getWorkingIpfsUrl(imageUrl);
        if (workingUrl && workingUrl !== imageUrl) {
            try {
                console.log(`   📷 Trying Cloudflare IPFS gateway...`);
                const response = await axios.get(workingUrl, {
                    responseType: 'arraybuffer',
                    timeout: 15000,
                    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
                });
                if (response.data && response.data.length > 500) {
                    imageBuffer = Buffer.from(response.data);
                    console.log(`   ✅ Image from Cloudflare IPFS`);
                }
            } catch (e) {
                console.log(`   ⚠️ Cloudflare IPFS failed: ${e.message}`);
            }
        }
    }

    // Step 3: Try other IPFS gateways
    if (!imageBuffer && imageUrl && imageUrl.includes('ipfs')) {
        const hash = imageUrl.includes('/ipfs/') ? imageUrl.split('/ipfs/')[1] : null;
        if (hash) {
            const gateways = [
                `https://gateway.pinata.cloud/ipfs/${hash}`,
                `https://dweb.link/ipfs/${hash}`,
                `https://ipfs.filebase.io/ipfs/${hash}`
            ];
            for (const gateway of gateways) {
                try {
                    console.log(`   📷 Trying: ${gateway.substring(0, 45)}...`);
                    const response = await axios.get(gateway, {
                        responseType: 'arraybuffer',
                        timeout: 10000,
                        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*' }
                    });
                    if (response.data && response.data.length > 500) {
                        imageBuffer = Buffer.from(response.data);
                        console.log(`   ✅ Image from IPFS gateway`);
                        break;
                    }
                } catch (e) {
                    // Try next gateway
                }
            }
        }
    }

    // Step 4: Try non-IPFS URL directly
    if (!imageBuffer && imageUrl && !imageUrl.includes('ipfs.io')) {
        try {
            console.log(`   📷 Trying direct URL...`);
            const response = await axios.get(imageUrl, {
                responseType: 'arraybuffer',
                timeout: 10000,
                headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'image/*', 'Referer': 'https://dexscreener.com' }
            });
            if (response.data && response.data.length > 500) {
                imageBuffer = Buffer.from(response.data);
                console.log(`   ✅ Image from direct URL`);
            }
        } catch (e) {
            console.log(`   ⚠️ Direct URL failed: ${e.message}`);
        }
    }

    if (!imageBuffer) {
        console.log(`   ❌ No image available`);
    }

    // Send to PAID channel (instant)
    const paidMessageId = await sendCallToChannel(CHANNEL_ID, message, imageBuffer, 'PAID');

    if (paidMessageId) {
        stats.callsSent++;

        // Add to recently called set to prevent duplicates
        recentlyCalled.add(token.address);
        // Remove from set after 5 minutes
        setTimeout(() => recentlyCalled.delete(token.address), 5 * 60 * 1000);
    }

    // Send to FREE channel (instant - no delay)
    let freeMessageId = null;
    if (FREE_CHANNEL_ID) {
        freeMessageId = await sendCallToChannel(FREE_CHANNEL_ID, message, imageBuffer, 'FREE');
        if (freeMessageId) {
            console.log(`   📌 FREE message ID: ${freeMessageId}`);
        }
    }

    // Track token for milestones with both message IDs
    trackToken(token, paidMessageId, freeMessageId);

    // AUTO TRADING - Execute trades ONLY for tokens that passed filters and were called
    if (paidMessageId) {
        try {
            await autoTrader.handleNewMigration(token, bot);
        } catch (error) {
            console.error('[AUTO-TRADER] Error:', error.message);
        }
    }
});

// ==================== ERROR HANDLING ====================

bot.catch((err, ctx) => {
    console.error('Bot error:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

let launchRetries = 0;
const maxLaunchRetries = 5;

process.on('unhandledRejection', async (err) => {
    if (err.response?.error_code === 409) {
        launchRetries++;
        if (launchRetries <= maxLaunchRetries) {
            console.log(`⚠️ Bot conflict detected (attempt ${launchRetries}/${maxLaunchRetries})`);
            console.log('   Waiting 10 seconds before retry...');
            await new Promise(resolve => setTimeout(resolve, 10000));
            console.log('🔄 Retrying bot launch...');
            bot.launch({ dropPendingUpdates: true }).catch(() => {});
        } else {
            console.error('❌ Could not start bot after multiple attempts.');
            console.error('   Make sure no other bot instance is running anywhere.');
            process.exit(1);
        }
    } else {
        console.error('Unhandled rejection:', err);
    }
});

// ==================== 24H DAILY STATS ====================

// Store 24h stats
let daily24hStats = {
    calls: 0,
    x2: 0,
    x5: 0,
    x10: 0,
    x50: 0,
    lastReset: Date.now()
};

// Track 24h performance for daily report
function update24hStats(milestone) {
    if (milestone >= 50) daily24hStats.x50++;
    else if (milestone >= 10) daily24hStats.x10++;
    else if (milestone >= 5) daily24hStats.x5++;
    else if (milestone >= 2) daily24hStats.x2++;
}

// Send daily stats at 17:00
async function sendDailyStats() {
    // Calculate totals from performanceHistory (last 24h)
    const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);
    let totalTokens = 0;
    let x2 = 0, x3_5 = 0, x5_10 = 0, x10_50 = 0, x50_100 = 0, x100plus = 0;
    let losses = 0;
    let totalROI = 0;

    for (const [, data] of performanceHistory) {
        if (data.calledAt >= oneDayAgo) {
            totalTokens++;
            const maxX = data.maxX || 1;

            // Calculate ROI for this token
            if (maxX >= 2) {
                // Gain: (multiplier - 1) * 100%
                totalROI += (maxX - 1) * 100;
            } else {
                // Loss: -100% (assuming total loss if under 2x)
                totalROI -= 100;
                losses++;
            }

            // Categorize by multiplier
            if (maxX >= 100) x100plus++;
            else if (maxX >= 50) x50_100++;
            else if (maxX >= 10) x10_50++;
            else if (maxX >= 5) x5_10++;
            else if (maxX >= 3) x3_5++;
            else if (maxX >= 2) x2++;
        }
    }

    const winners = x2 + x3_5 + x5_10 + x10_50 + x50_100 + x100plus;
    const winRate = totalTokens > 0 ? ((winners / totalTokens) * 100).toFixed(2) : '0.00';
    const avgGains = totalTokens > 0 ? (totalROI / totalTokens).toFixed(2) : '0.00';

    const statsMessage = `📊 *Trade Outcome Statistics (Last 24 Hours):*

🔍 *Total Tokens Found:* ${totalTokens}

*Outcomes:*
✅ 2x: ${x2} tokens
✅ 3-5x: ${x3_5} tokens
✅ 5-10x: ${x5_10} tokens
✅ 10-50x: ${x10_50} tokens
✅ 50-100x: ${x50_100} tokens
✅ >100x: ${x100plus} tokens
❌ loss: ${losses} tokens

🔴 *Win Rate:* ${winRate}%
_This shows the percentage of tokens that achieved at least 2x gains._

📈 *Total ROI:* ${totalROI.toFixed(2)}%
_The ROI % is calculated as the sum of all individual token ROIs. Losses are marked as -100%, and gains are calculated based on the multiplier (e.g., a 2x multiplier equals a 100% gain)._

🔑 *Average Gains:* ${avgGains}%
_Average gains are calculated as the Total ROI divided by the total number of tokens found._

💎 Get VIP for instant calls!
@callbot1000x`;

    try {
        // Send to PAID channel and pin
        const paidMsg = await bot.telegram.sendMessage(CHANNEL_ID, statsMessage, {
            parse_mode: 'Markdown'
        });
        await bot.telegram.pinChatMessage(CHANNEL_ID, paidMsg.message_id, { disable_notification: true });
        console.log('📊 Daily stats sent & pinned to PAID channel');

        // Send to FREE channel and pin
        if (FREE_CHANNEL_ID) {
            const freeMsg = await bot.telegram.sendMessage(FREE_CHANNEL_ID, statsMessage, {
                parse_mode: 'Markdown'
            });
            await bot.telegram.pinChatMessage(FREE_CHANNEL_ID, freeMsg.message_id, { disable_notification: true });
            console.log('📊 Daily stats sent & pinned to FREE channel');
        }
    } catch (error) {
        console.error('Error sending daily stats:', error.message);
    }
}

// Check if it's 17:00 and send daily stats
function scheduleDailyStats() {
    setInterval(() => {
        const now = new Date();
        // Check if it's 17:00 (5 PM) - checks every minute
        if (now.getHours() === 17 && now.getMinutes() === 0) {
            sendDailyStats();
        }
    }, 60000); // Check every minute

    console.log('✅ Daily stats scheduled for 17:00');
}

// ==================== START BOT ====================

async function start() {
    console.log('');
    console.log('🚀 ================================');
    console.log('   1000x CALL BOT - Pump.fun');
    console.log('🚀 ================================');
    console.log('');

    // Clear any existing webhook and drop pending updates
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log('🔄 Cleared webhook and pending updates');

    // Start the tracker first (doesn't depend on Telegram)
    await tracker.startTracking();
    console.log('✅ Migration tracker started');

    // Start auto trading position monitoring
    autoTrader.startPositionMonitoring(bot);
    console.log('✅ Auto-trader position monitoring started');

    // Check milestones every 15 seconds
    setInterval(checkMilestones, 15000);
    console.log('✅ Price tracker started (checks every 15s)');

    // Schedule daily stats at 15:00
    scheduleDailyStats();

    // Start payment checker for automatic subscription verification
    const paymentChecker = new PaymentChecker(bot);
    paymentChecker.start();
    console.log('✅ Payment checker started (checks every 30s)');

    console.log(`📢 PAID channel: ${CHANNEL_ID} (instant)`);
    if (FREE_CHANNEL_ID) {
        console.log(`📢 FREE channel: ${FREE_CHANNEL_ID} (instant)`);
    }

    // Launch bot (will retry via unhandledRejection handler if 409)
    console.log('🔄 Launching Telegram bot...');
    bot.launch({ dropPendingUpdates: true }).then(() => {
        console.log('✅ Telegram bot started successfully!');
        console.log('');
        console.log('👀 Watching for new migrations...');
        console.log('');
    }).catch(() => {
        // Error will be handled by unhandledRejection handler
    });
}

start();

process.once('SIGINT', () => {
    tracker.stopTracking();
    bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
    tracker.stopTracking();
    bot.stop('SIGTERM');
});
