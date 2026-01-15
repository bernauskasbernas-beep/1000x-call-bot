const jupiterSwap = require('./jupiterSwap');
const path = require('path');
const fs = require('fs');

const TRADING_USERS_FILE = path.join(__dirname, '../data/trading_users.json');
const USER_WALLETS_FILE = path.join(__dirname, '../data/user_wallets.json');

// Owner Telegram ID - only owner can use auto trading for now
const OWNER_ID = '1967466851';

// Safety limits
const MIN_WALLET_BALANCE = 0.01; // Keep at least 0.01 SOL for fees

// ==================== DATA MANAGEMENT ====================

function loadTradingUsers() {
    if (!fs.existsSync(TRADING_USERS_FILE)) {
        return {};
    }
    try {
        const data = fs.readFileSync(TRADING_USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('[AUTO-TRADER] Error loading trading users:', error.message);
        return {};
    }
}

function saveTradingUsers(users) {
    try {
        // Ensure data directory exists
        const dataDir = path.dirname(TRADING_USERS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(TRADING_USERS_FILE, JSON.stringify(users, null, 2));
    } catch (error) {
        console.error('[AUTO-TRADER] Error saving trading users:', error.message);
    }
}

function loadUserWallets() {
    if (!fs.existsSync(USER_WALLETS_FILE)) {
        return {};
    }
    try {
        const data = fs.readFileSync(USER_WALLETS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('[AUTO-TRADER] Error loading user wallets:', error.message);
        return {};
    }
}

function saveUserWallets(wallets) {
    try {
        const dataDir = path.dirname(USER_WALLETS_FILE);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
        }
        fs.writeFileSync(USER_WALLETS_FILE, JSON.stringify(wallets, null, 2));
    } catch (error) {
        console.error('[AUTO-TRADER] Error saving user wallets:', error.message);
    }
}

// Get or create user trading profile
function getUserProfile(userId) {
    const users = loadTradingUsers();
    if (!users[userId]) {
        users[userId] = {
            tradingEnabled: false,
            positions: [],
            history: [],
            settings: {
                tradeSize: 0.05,        // Default 0.05 SOL per trade
                maxPositions: 3,         // Max 3 positions at once
                takeProfitMultiplier: 2.0,  // Sell at 2x
                stopLossMultiplier: 0.5     // Sell at -50%
            }
        };
        saveTradingUsers(users);
    }
    return users[userId];
}

// Update user profile
function updateUserProfile(userId, updates) {
    const users = loadTradingUsers();
    if (!users[userId]) {
        users[userId] = getUserProfile(userId);
    }
    Object.assign(users[userId], updates);
    saveTradingUsers(users);
    return users[userId];
}

// Update user settings
function updateUserSettings(userId, settingKey, value) {
    const users = loadTradingUsers();
    if (!users[userId]) {
        users[userId] = getUserProfile(userId);
    }
    users[userId].settings[settingKey] = value;
    saveTradingUsers(users);
    return users[userId];
}

// Get user wallet
function getUserWallet(userId) {
    const wallets = loadUserWallets();
    return wallets[userId] || null;
}

// Save user wallet (encrypted private key would be better in production)
function saveUserWallet(userId, privateKey) {
    const wallets = loadUserWallets();
    wallets[userId] = {
        privateKey: privateKey,
        addedAt: Date.now()
    };
    saveUserWallets(wallets);
}

// Remove user wallet
function removeUserWallet(userId) {
    const wallets = loadUserWallets();
    delete wallets[userId];
    saveUserWallets(wallets);
}

// ==================== TRADING FUNCTIONS ====================

async function handleNewMigration(token, bot) {
    console.log('[AUTO-TRADER] New call detected:', token.symbol, 'MC:', Math.round(token.marketCap));

    const users = loadTradingUsers();

    for (const [userId, user] of Object.entries(users)) {
        // Skip if trading disabled
        if (!user.tradingEnabled) {
            continue;
        }

        // Check if user has wallet configured
        const userWallet = getUserWallet(userId);
        if (!userWallet && userId !== OWNER_ID) {
            console.log('[AUTO-TRADER] User', userId, 'has no wallet configured');
            continue;
        }

        // Check max positions
        if (user.positions && user.positions.length >= user.settings.maxPositions) {
            console.log('[AUTO-TRADER] User', userId, 'max positions reached:', user.positions.length);
            continue;
        }

        // Check wallet balance
        try {
            const walletBalance = await jupiterSwap.getWalletBalance();
            const requiredBalance = user.settings.tradeSize + MIN_WALLET_BALANCE;

            if (walletBalance < requiredBalance) {
                console.log('[AUTO-TRADER] Low balance:', walletBalance.toFixed(4), 'SOL (need', requiredBalance.toFixed(4), 'SOL)');

                bot.telegram.sendMessage(userId,
                    '⚠️ <b>LOW WALLET BALANCE</b>\n\n' +
                    '💰 Wallet: ' + walletBalance.toFixed(4) + ' SOL\n' +
                    '📊 Need: ' + requiredBalance.toFixed(4) + ' SOL\n\n' +
                    'Add more SOL to continue auto-trading.',
                    { parse_mode: 'HTML' }
                ).catch(err => console.error('Notify error:', err.message));
                continue;
            }
        } catch (error) {
            console.error('[AUTO-TRADER] Error checking balance:', error.message);
            continue;
        }

        // Execute buy
        console.log('[AUTO-TRADER] Buying', token.symbol, 'for user', userId);

        try {
            const buyResult = await jupiterSwap.buyToken(userId, token.address, user.settings.tradeSize);

            if (buyResult.success) {
                // Add position
                if (!user.positions) user.positions = [];
                user.positions.push({
                    tokenAddress: token.address,
                    symbol: token.symbol,
                    name: token.name,
                    buyMC: token.marketCap,
                    buyPrice: token.price || 0,
                    tokensOwned: buyResult.tokensReceived,
                    solSpent: user.settings.tradeSize,
                    boughtAt: Date.now(),
                    signature: buyResult.signature
                });

                saveTradingUsers(users);

                console.log('[AUTO-TRADER] BUY SUCCESS:', token.symbol);

                const msg = '✅ <b>AUTO-BUY EXECUTED</b>\n\n' +
                    '🪙 Token: <b>' + token.symbol + '</b>\n' +
                    '💰 Spent: ' + user.settings.tradeSize + ' SOL\n' +
                    '📊 Buy MC: $' + formatNumber(token.marketCap) + '\n' +
                    '📈 Positions: ' + user.positions.length + '/' + user.settings.maxPositions + '\n\n' +
                    '🎯 TP: ' + user.settings.takeProfitMultiplier + 'x | SL: ' + (user.settings.stopLossMultiplier * 100) + '%\n\n' +
                    '🔗 <a href="' + buyResult.txUrl + '">View Transaction</a>';

                bot.telegram.sendMessage(userId, msg, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                }).catch(err => console.error('Notify error:', err.message));

            } else {
                console.error('[AUTO-TRADER] BUY FAILED:', buyResult.error);

                bot.telegram.sendMessage(userId,
                    '❌ <b>AUTO-BUY FAILED</b>\n\n' +
                    '🪙 Token: ' + token.symbol + '\n' +
                    '⚠️ Error: ' + buyResult.error,
                    { parse_mode: 'HTML' }
                ).catch(err => console.error('Notify error:', err.message));
            }
        } catch (error) {
            console.error('[AUTO-TRADER] Exception during buy:', error.message);
        }
    }
}

// Manual buy function
async function manualBuy(userId, tokenAddress, solAmount, bot) {
    const user = getUserProfile(userId);

    try {
        const walletBalance = await jupiterSwap.getWalletBalance();
        if (walletBalance < solAmount + MIN_WALLET_BALANCE) {
            return { success: false, error: 'Insufficient balance: ' + walletBalance.toFixed(4) + ' SOL' };
        }

        const buyResult = await jupiterSwap.buyToken(userId, tokenAddress, solAmount);

        if (buyResult.success) {
            // Add to positions
            const users = loadTradingUsers();
            if (!users[userId]) users[userId] = user;
            if (!users[userId].positions) users[userId].positions = [];

            users[userId].positions.push({
                tokenAddress: tokenAddress,
                symbol: 'MANUAL',
                name: 'Manual Buy',
                buyMC: 0,
                buyPrice: 0,
                tokensOwned: buyResult.tokensReceived,
                solSpent: solAmount,
                boughtAt: Date.now(),
                signature: buyResult.signature,
                manual: true
            });

            saveTradingUsers(users);
        }

        return buyResult;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Manual sell function
async function manualSell(userId, tokenAddress, bot) {
    const users = loadTradingUsers();
    const user = users[userId];

    if (!user || !user.positions) {
        return { success: false, error: 'No positions found' };
    }

    const positionIndex = user.positions.findIndex(p => p.tokenAddress === tokenAddress);
    if (positionIndex === -1) {
        return { success: false, error: 'Position not found' };
    }

    const position = user.positions[positionIndex];

    try {
        const sellResult = await jupiterSwap.sellToken(userId, tokenAddress, position.tokensOwned);

        if (sellResult.success) {
            // Remove position and add to history
            user.positions.splice(positionIndex, 1);

            if (!user.history) user.history = [];
            user.history.push({
                ...position,
                soldAt: Date.now(),
                sellSignature: sellResult.signature,
                solReceived: sellResult.solReceived / 1e9,
                reason: 'MANUAL'
            });

            saveTradingUsers(users);
        }

        return sellResult;
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// Get current market cap
async function getCurrentMC(tokenAddress) {
    try {
        const fetch = require('cross-fetch');
        const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddress);
        const data = await response.json();

        if (data.pairs && data.pairs.length > 0) {
            return data.pairs[0].fdv || data.pairs[0].marketCap || 0;
        }
        return 0;
    } catch (error) {
        return 0;
    }
}

// Monitor positions for TP/SL
async function monitorPositions(bot) {
    const users = loadTradingUsers();

    for (const [userId, user] of Object.entries(users)) {
        if (!user.positions || user.positions.length === 0) continue;
        if (!user.tradingEnabled) continue;

        for (let i = user.positions.length - 1; i >= 0; i--) {
            const position = user.positions[i];

            try {
                const currentMC = await getCurrentMC(position.tokenAddress);
                if (currentMC === 0 || position.buyMC === 0) continue;

                const multiplier = currentMC / position.buyMC;

                const shouldSellProfit = multiplier >= user.settings.takeProfitMultiplier;
                const shouldSellLoss = multiplier <= user.settings.stopLossMultiplier;

                if (shouldSellProfit || shouldSellLoss) {
                    const reason = shouldSellProfit ? 'TAKE PROFIT' : 'STOP LOSS';
                    console.log('[AUTO-TRADER] Selling', position.symbol, '-', reason, '(' + multiplier.toFixed(2) + 'x)');

                    const sellResult = await jupiterSwap.sellToken(userId, position.tokenAddress, position.tokensOwned);

                    if (sellResult.success) {
                        const solReceived = sellResult.solReceived / 1e9;
                        const pnl = solReceived - position.solSpent;

                        // Move to history
                        user.positions.splice(i, 1);
                        if (!user.history) user.history = [];
                        user.history.push({
                            ...position,
                            sellMC: currentMC,
                            multiplier: multiplier,
                            solReceived: solReceived,
                            pnl: pnl,
                            soldAt: Date.now(),
                            sellSignature: sellResult.signature,
                            reason: reason
                        });

                        saveTradingUsers(users);

                        const emoji = pnl > 0 ? '🚀' : '📉';
                        const pnlText = pnl > 0 ? '+' + pnl.toFixed(4) : pnl.toFixed(4);

                        const msg = emoji + ' <b>AUTO-SELL: ' + reason + '</b>\n\n' +
                            '🪙 Token: <b>' + position.symbol + '</b>\n' +
                            '📊 Exit: ' + multiplier.toFixed(2) + 'x\n' +
                            '💵 P&L: ' + pnlText + ' SOL\n' +
                            '📈 Positions: ' + user.positions.length + '/' + user.settings.maxPositions + '\n\n' +
                            '🔗 <a href="' + sellResult.txUrl + '">View Transaction</a>';

                        bot.telegram.sendMessage(userId, msg, {
                            parse_mode: 'HTML',
                            disable_web_page_preview: true
                        }).catch(err => console.error('Notify error:', err.message));
                    }
                }
            } catch (error) {
                console.error('[AUTO-TRADER] Monitor error:', error.message);
            }
        }
    }
}

function startPositionMonitoring(bot) {
    console.log('[AUTO-TRADER] Starting position monitoring (every 30s)');
    setInterval(() => monitorPositions(bot), 30000);
}

// Format number helper
function formatNumber(num) {
    if (!num) return '0';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toFixed(0);
}

module.exports = {
    handleNewMigration,
    startPositionMonitoring,
    getUserProfile,
    updateUserProfile,
    updateUserSettings,
    getUserWallet,
    saveUserWallet,
    removeUserWallet,
    manualBuy,
    manualSell,
    loadTradingUsers,
    saveTradingUsers,
    OWNER_ID
};
