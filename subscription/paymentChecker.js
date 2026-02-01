const axios = require('axios');
const path = require('path');
const subscriptionManager = require('./subscriptionManager');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '../.env') });

// Admin Telegram ID for notifications
const ADMIN_ID = process.env.ADMIN_ID;

// Helius API key (same as used in the bot)
const HELIUS_API_KEY = '5c70b747-7e24-415b-8b87-697caaad0360';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Payment wallet to monitor
const PAYMENT_WALLET = subscriptionManager.getPaymentWallet();

// Track processed transactions to avoid duplicates
const processedTxs = new Set();

// Tolerance for amount matching (0.0001 SOL)
const AMOUNT_TOLERANCE = 0.0001;

class PaymentChecker {
    constructor(bot) {
        this.bot = bot;
        this.isRunning = false;
        this.checkInterval = null;
        this.lastSignature = null;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log('[PAYMENT] Starting payment checker (every 30s)...');
        console.log(`[PAYMENT] Monitoring wallet: ${PAYMENT_WALLET}`);

        // Check every 30 seconds
        this.checkInterval = setInterval(() => {
            this.checkPayments();
        }, 30000);

        // First check immediately
        this.checkPayments();
    }

    stop() {
        this.isRunning = false;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        console.log('[PAYMENT] Payment checker stopped');
    }

    async checkPayments() {
        const pendingPayments = subscriptionManager.getAllPendingPayments();

        if (pendingPayments.length === 0) {
            return; // No pending payments to check
        }

        console.log(`[PAYMENT] Checking ${pendingPayments.length} pending payments...`);

        try {
            // Get recent transactions to our wallet
            const transactions = await this.getRecentTransactions();

            if (!transactions || transactions.length === 0) {
                return;
            }

            // Check each pending payment
            for (const payment of pendingPayments) {
                const matchingTx = await this.findMatchingTransaction(
                    transactions,
                    payment.uniqueAmount
                );

                if (matchingTx) {
                    console.log(`[PAYMENT] Found matching payment for user ${payment.userId}!`);
                    console.log(`[PAYMENT] TX: ${matchingTx.signature}`);
                    console.log(`[PAYMENT] Amount: ${matchingTx.amount} SOL`);

                    // Confirm payment
                    await this.processPayment(payment.userId, matchingTx);
                }
            }

        } catch (error) {
            console.error('[PAYMENT] Error checking payments:', error.message);
        }
    }

    async getRecentTransactions() {
        try {
            // Get signatures first
            const sigResponse = await axios.post(HELIUS_RPC, {
                jsonrpc: '2.0',
                id: 1,
                method: 'getSignaturesForAddress',
                params: [
                    PAYMENT_WALLET,
                    { limit: 20 }
                ]
            }, { timeout: 15000 });

            const signatures = sigResponse.data?.result || [];

            if (signatures.length === 0) {
                return [];
            }

            // Get transaction details for each signature
            const transactions = [];

            for (const sig of signatures) {
                // Skip already processed transactions
                if (processedTxs.has(sig.signature)) {
                    continue;
                }

                // Skip old transactions (older than 1 hour)
                const txTime = sig.blockTime * 1000;
                if (Date.now() - txTime > 60 * 60 * 1000) {
                    continue;
                }

                try {
                    const txResponse = await axios.post(HELIUS_RPC, {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'getTransaction',
                        params: [
                            sig.signature,
                            { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }
                        ]
                    }, { timeout: 15000 });

                    const tx = txResponse.data?.result;
                    if (tx) {
                        const solTransfer = this.extractSolTransfer(tx, PAYMENT_WALLET);
                        if (solTransfer) {
                            transactions.push({
                                signature: sig.signature,
                                amount: solTransfer.amount,
                                from: solTransfer.from,
                                timestamp: txTime
                            });
                        }
                    }
                } catch (e) {
                    // Skip failed transactions
                }
            }

            return transactions;

        } catch (error) {
            console.error('[PAYMENT] Error fetching transactions:', error.message);
            return [];
        }
    }

    extractSolTransfer(tx, toWallet) {
        try {
            // Check pre and post balances
            const accountKeys = tx.transaction?.message?.accountKeys || [];
            const preBalances = tx.meta?.preBalances || [];
            const postBalances = tx.meta?.postBalances || [];

            // Find our wallet's index
            let walletIndex = -1;
            for (let i = 0; i < accountKeys.length; i++) {
                const key = typeof accountKeys[i] === 'string'
                    ? accountKeys[i]
                    : accountKeys[i]?.pubkey;
                if (key === toWallet) {
                    walletIndex = i;
                    break;
                }
            }

            if (walletIndex === -1) return null;

            // Calculate amount received (in SOL)
            const preBalance = preBalances[walletIndex] || 0;
            const postBalance = postBalances[walletIndex] || 0;
            const lamportsReceived = postBalance - preBalance;

            if (lamportsReceived <= 0) return null;

            const solAmount = lamportsReceived / 1e9; // Convert lamports to SOL

            // Find sender (the account that lost SOL)
            let senderAddress = null;
            for (let i = 0; i < accountKeys.length; i++) {
                if (i === walletIndex) continue;
                const diff = (preBalances[i] || 0) - (postBalances[i] || 0);
                if (diff > 0) {
                    senderAddress = typeof accountKeys[i] === 'string'
                        ? accountKeys[i]
                        : accountKeys[i]?.pubkey;
                    break;
                }
            }

            return {
                amount: solAmount,
                from: senderAddress
            };

        } catch (e) {
            return null;
        }
    }

    async findMatchingTransaction(transactions, expectedAmount) {
        for (const tx of transactions) {
            // Check if amount matches within tolerance
            const diff = Math.abs(tx.amount - expectedAmount);
            if (diff <= AMOUNT_TOLERANCE) {
                return tx;
            }
        }
        return null;
    }

    async processPayment(userId, transaction) {
        // Mark transaction as processed
        processedTxs.add(transaction.signature);

        // Confirm payment in subscription manager
        const result = await subscriptionManager.confirmPayment(
            userId,
            transaction.signature,
            this.bot
        );

        if (result.success) {
            const sub = result.subscriber;

            // Send success message to user
            try {
                let expiryText;
                if (sub.isLifetime) {
                    expiryText = 'Never (Lifetime)';
                } else {
                    const expiryDate = new Date(sub.expiresAt);
                    expiryText = expiryDate.toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'long',
                        day: 'numeric'
                    });
                }

                await this.bot.telegram.sendMessage(userId, `
🎉 *PAYMENT CONFIRMED!*

✅ Your VIP subscription is now active!

📋 *Details:*
• Plan: ${sub.planName}
• Expires: ${expiryText}
• TX: \`${transaction.signature.slice(0, 20)}...\`

🔗 *Join VIP Channel:*
${sub.inviteLink}

⚠️ This link is unique to you and can only be used once!

Thank you for subscribing! 🚀
                `, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });

                console.log(`[PAYMENT] Sent confirmation to user ${userId}`);

                // Send notification to admin
                if (ADMIN_ID) {
                    try {
                        await this.bot.telegram.sendMessage(ADMIN_ID, `
💰 *NEW VIP PURCHASE!*

👤 User: ${sub.username || 'Unknown'} (ID: ${userId})
📦 Plan: ${sub.planName}
💵 Amount: ${sub.amountPaid.toFixed(6)} SOL
🔗 TX: \`${transaction.signature}\`

📊 Total active VIPs: ${subscriptionManager.getActiveSubscribers().length}
                        `, {
                            parse_mode: 'Markdown',
                            disable_web_page_preview: true
                        });
                        console.log(`[PAYMENT] Sent admin notification`);
                    } catch (adminErr) {
                        console.error('[PAYMENT] Error sending admin notification:', adminErr.message);
                    }
                }

            } catch (e) {
                console.error('[PAYMENT] Error sending confirmation:', e.message);
            }

        } else {
            console.error(`[PAYMENT] Failed to confirm payment for user ${userId}:`, result.error);
        }
    }

    // Manual check (for admin/testing)
    async manualCheck() {
        console.log('[PAYMENT] Running manual check...');
        await this.checkPayments();
    }
}

module.exports = PaymentChecker;
