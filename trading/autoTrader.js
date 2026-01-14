const jupiterSwap = require('./jupiterSwap');
const path = require('path');
const fs = require('fs');

const TRADING_USERS_FILE = path.join(__dirname, '../data/trading_users.json');

// ⚠️ REAL TRADING MODE - Set to false to use real SOL
const DRY_RUN_MODE = false;

// Safety limits
const MIN_WALLET_BALANCE = 0.05; // Keep at least 0.05 SOL for fees

function loadTradingUsers() {
    if (!fs.existsSync(TRADING_USERS_FILE)) {
        return {};
    }
    const data = fs.readFileSync(TRADING_USERS_FILE, 'utf8');
    return JSON.parse(data);
}

function saveTradingUsers(users) {
    fs.writeFileSync(TRADING_USERS_FILE, JSON.stringify(users, null, 2));
}

// Simulated buy function for dry-run mode
async function simulateBuy(tokenAddress, solAmount) {
    console.log('[DRY-RUN] Simulating buy...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const fakeTokensReceived = Math.floor(Math.random() * 1000000000) + 100000000;
    const fakeTxSignature = 'DRY_RUN_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    return {
        success: true,
        signature: fakeTxSignature,
        tokensReceived: fakeTokensReceived,
        solSpent: solAmount,
        txUrl: 'https://solscan.io/tx/' + fakeTxSignature
    };
}

// Simulated sell function for dry-run mode
async function simulateSell(tokenAddress, tokenAmount, buyMC, currentMC) {
    console.log('[DRY-RUN] Simulating sell...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    const multiplier = currentMC / buyMC;
    const fakeTxSignature = 'DRY_RUN_' + Date.now() + '_' + Math.random().toString(36).substring(7);

    return {
        success: true,
        signature: fakeTxSignature,
        solReceived: 0,
        txUrl: 'https://solscan.io/tx/' + fakeTxSignature
    };
}

async function handleNewMigration(token, bot) {
    console.log('[AUTO-TRADER] New call detected:', token.symbol, 'MC:', token.marketCap);

    const users = loadTradingUsers();

    for (const [userId, user] of Object.entries(users)) {
        if (!user.tradingEnabled) {
            console.log('[AUTO-TRADER] User', userId, 'has trading disabled');
            continue;
        }

        if (user.balance < user.settings.tradeSize) {
            console.log('[AUTO-TRADER] User', userId, 'insufficient balance:', user.balance, 'SOL');
            continue;
        }

        if (user.positions.length >= user.settings.maxPositions) {
            console.log('[AUTO-TRADER] User', userId, 'max positions reached:', user.positions.length);
            continue;
        }

        // Check real wallet balance before trading
        if (!DRY_RUN_MODE) {
            try {
                const walletBalance = await jupiterSwap.getWalletBalance();
                const requiredBalance = user.settings.tradeSize + MIN_WALLET_BALANCE;

                if (walletBalance < requiredBalance) {
                    console.log('[AUTO-TRADER] Wallet balance too low:', walletBalance, 'SOL (need', requiredBalance, 'SOL)');

                    // Notify user
                    bot.telegram.sendMessage(userId,
                        '⚠️ <b>LOW WALLET BALANCE</b>\n\n' +
                        'Wallet: ' + walletBalance.toFixed(4) + ' SOL\n' +
                        'Need: ' + requiredBalance.toFixed(4) + ' SOL\n\n' +
                        'Please add more SOL to continue trading.',
                        { parse_mode: 'HTML' }
                    ).catch(err => console.error('Notify error:', err.message));

                    continue;
                }
            } catch (error) {
                console.error('[AUTO-TRADER] Error checking wallet balance:', error.message);
                continue;
            }
        }

        console.log('[AUTO-TRADER] Buying', token.symbol, 'for user', userId, DRY_RUN_MODE ? '(DRY-RUN)' : '(REAL)');

        try {
            let buyResult;

            if (DRY_RUN_MODE) {
                buyResult = await simulateBuy(token.address, user.settings.tradeSize);
            } else {
                buyResult = await jupiterSwap.buyToken(userId, token.address, user.settings.tradeSize);
            }

            if (buyResult.success) {
                user.balance -= user.settings.tradeSize;

                if (!user.positions) user.positions = [];
                user.positions.push({
                    tokenAddress: token.address,
                    symbol: token.symbol,
                    buyMC: token.marketCap,
                    buyPrice: token.price || 0,
                    tokensOwned: buyResult.tokensReceived,
                    solSpent: user.settings.tradeSize,
                    boughtAt: Date.now(),
                    signature: buyResult.signature,
                    dryRun: DRY_RUN_MODE
                });

                saveTradingUsers(users);

                console.log('[AUTO-TRADER] Buy SUCCESS for user', userId);

                const modeLabel = DRY_RUN_MODE ? '[TEST] ' : '';
                const msg = modeLabel + '✅ <b>AUTO-BUY</b>\n\n' +
                    '🪙 Token: ' + token.symbol + '\n' +
                    '💰 Spent: ' + user.settings.tradeSize + ' SOL\n' +
                    '📊 Buy MC: $' + Math.round(token.marketCap) + '\n' +
                    '💼 Balance: ' + user.balance.toFixed(3) + ' SOL\n' +
                    '📈 Positions: ' + user.positions.length + '/' + user.settings.maxPositions + '\n\n' +
                    '🔗 TX: ' + buyResult.txUrl;

                bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(err => {
                    console.error('Notify error:', err.message);
                });
            } else {
                console.error('[AUTO-TRADER] Buy FAILED for user', userId, ':', buyResult.error);

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

async function getCurrentMC(tokenAddress) {
    try {
        const fetch = require('cross-fetch');
        const response = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + tokenAddress);
        const data = await response.json();

        if (data.pairs && data.pairs.length > 0) {
            const pair = data.pairs[0];
            return pair.fdv || pair.marketCap || 0;
        }

        return 0;
    } catch (error) {
        console.error('[AUTO-TRADER] Error fetching MC:', error.message);
        return 0;
    }
}

async function monitorPositions(bot) {
    console.log('[DEBUG] monitorPositions called');
    const users = loadTradingUsers();

    for (const [userId, user] of Object.entries(users)) {
        if (!user.positions || user.positions.length === 0) continue;

        for (let i = user.positions.length - 1; i >= 0; i--) {
            const position = user.positions[i];

            try {
                const currentMC = await getCurrentMC(position.tokenAddress);

                if (currentMC === 0) {
                    console.log('[MONITOR] Could not fetch MC for', position.symbol);
                    continue;
                }

                const multiplier = currentMC / position.buyMC;

                console.log('[MONITOR]', position.symbol, ':', multiplier.toFixed(2) + 'x', '(MC:', Math.round(currentMC) + ')');

                const shouldSellProfit = multiplier >= user.settings.takeProfitMultiplier;
                const shouldSellLoss = multiplier <= user.settings.stopLossMultiplier;

                if (shouldSellProfit || shouldSellLoss) {
                    const reason = shouldSellProfit ? 'TAKE PROFIT (' + multiplier.toFixed(2) + 'x)' : 'STOP LOSS (' + multiplier.toFixed(2) + 'x)';
                    console.log('[MONITOR] Selling', position.symbol, 'for user', userId, '-', reason);

                    let sellResult;
                    const isDryRun = DRY_RUN_MODE || position.dryRun;

                    if (isDryRun) {
                        sellResult = await simulateSell(position.tokenAddress, position.tokensOwned, position.buyMC, currentMC);
                        sellResult.solReceived = Math.floor(position.solSpent * multiplier * 1e9);
                    } else {
                        sellResult = await jupiterSwap.sellToken(userId, position.tokenAddress, position.tokensOwned);
                    }

                    if (sellResult.success) {
                        const solReceived = sellResult.solReceived / 1e9;
                        const pnl = solReceived - position.solSpent;

                        user.balance += solReceived;
                        user.positions.splice(i, 1);

                        if (!user.history) user.history = [];
                        user.history.push({
                            symbol: position.symbol,
                            buyMC: position.buyMC,
                            sellMC: currentMC,
                            multiplier: multiplier,
                            solSpent: position.solSpent,
                            solReceived: solReceived,
                            pnl: pnl,
                            soldAt: Date.now(),
                            signature: sellResult.signature,
                            reason: reason,
                            dryRun: isDryRun
                        });

                        saveTradingUsers(users);

                        const emoji = pnl > 0 ? '🚀' : '📉';
                        const pnlText = pnl > 0 ? '+' + pnl.toFixed(3) : pnl.toFixed(3);
                        const modeLabel = isDryRun ? '[TEST] ' : '';

                        const msg = modeLabel + '💰 <b>AUTO-SELL</b>\n\n' +
                            '🪙 Token: ' + position.symbol + '\n' +
                            '📊 Exit: ' + multiplier.toFixed(2) + 'x ' + emoji + '\n' +
                            '💵 P&L: ' + pnlText + ' SOL\n' +
                            '💼 Balance: ' + user.balance.toFixed(3) + ' SOL\n' +
                            '📈 Positions: ' + user.positions.length + '/' + user.settings.maxPositions + '\n\n' +
                            '🔗 TX: ' + sellResult.txUrl;

                        bot.telegram.sendMessage(userId, msg, { parse_mode: 'HTML' }).catch(err => {
                            console.error('Notify error:', err.message);
                        });
                    } else {
                        console.error('[MONITOR] Sell FAILED for', position.symbol, ':', sellResult.error);
                    }
                }

            } catch (error) {
                console.error('[MONITOR] Error monitoring position', position.symbol, ':', error.message);
            }
        }
    }
}

function startPositionMonitoring(bot) {
    const mode = DRY_RUN_MODE ? '[DRY-RUN MODE]' : '[REAL TRADING MODE]';
    console.log('[AUTO-TRADER] Starting position monitoring (every 30s)', mode);

    setInterval(async () => {
        await monitorPositions(bot);
    }, 30000);
}

module.exports = {
    handleNewMigration,
    startPositionMonitoring
};
