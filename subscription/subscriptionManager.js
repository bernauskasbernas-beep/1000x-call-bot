const fs = require('fs');
const path = require('path');

const SUBSCRIBERS_FILE = path.join(__dirname, '../data/subscribers.json');
const PENDING_PAYMENTS_FILE = path.join(__dirname, '../data/pending_payments.json');

// Subscription plans
const PLANS = {
    '1month': { months: 1, price: 0.26, name: '1 Month' },
    '2months': { months: 2, price: 0.44, name: '2 Months' },
    '3months': { months: 3, price: 0.62, name: '3 Months' },
    'lifetime': { months: 9999, price: 1.00, name: 'Lifetime' }
};

// VIP Channel ID
const VIP_CHANNEL_ID = '-1003321804950';

// Payment wallet
const PAYMENT_WALLET = 'Gzos8rvjcPD6WWk1YQKFRSbPx9GioPcejLGuZtpHSNDG';

class SubscriptionManager {
    constructor() {
        this.subscribers = this.loadSubscribers();
        this.pendingPayments = this.loadPendingPayments();
        this.usedAmounts = new Set();
    }

    loadSubscribers() {
        try {
            if (fs.existsSync(SUBSCRIBERS_FILE)) {
                return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('[SUBS] Error loading subscribers:', e.message);
        }
        return {};
    }

    saveSubscribers() {
        try {
            const dir = path.dirname(SUBSCRIBERS_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(this.subscribers, null, 2));
        } catch (e) {
            console.error('[SUBS] Error saving subscribers:', e.message);
        }
    }

    loadPendingPayments() {
        try {
            if (fs.existsSync(PENDING_PAYMENTS_FILE)) {
                const data = JSON.parse(fs.readFileSync(PENDING_PAYMENTS_FILE, 'utf8'));
                Object.values(data).forEach(p => {
                    if (p.uniqueAmount) this.usedAmounts.add(p.uniqueAmount.toFixed(6));
                });
                return data;
            }
        } catch (e) {
            console.error('[SUBS] Error loading pending payments:', e.message);
        }
        return {};
    }

    savePendingPayments() {
        try {
            const dir = path.dirname(PENDING_PAYMENTS_FILE);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(PENDING_PAYMENTS_FILE, JSON.stringify(this.pendingPayments, null, 2));
        } catch (e) {
            console.error('[SUBS] Error saving pending payments:', e.message);
        }
    }

    generateUniqueAmount(basePrice) {
        let uniqueAmount;
        let attempts = 0;

        do {
            const microAmount = Math.floor(Math.random() * 999) + 1;
            uniqueAmount = basePrice + (microAmount / 1000000);
            attempts++;
        } while (this.usedAmounts.has(uniqueAmount.toFixed(6)) && attempts < 1000);

        this.usedAmounts.add(uniqueAmount.toFixed(6));
        return uniqueAmount;
    }

    createPendingPayment(userId, username, planId) {
        const plan = PLANS[planId];
        if (!plan) return null;

        if (this.pendingPayments[userId]) {
            const oldAmount = this.pendingPayments[userId].uniqueAmount;
            if (oldAmount) this.usedAmounts.delete(oldAmount.toFixed(6));
        }

        const uniqueAmount = this.generateUniqueAmount(plan.price);

        const payment = {
            orderId: `ORD-${Date.now().toString(36).toUpperCase()}`,
            userId: userId.toString(),
            username: username || 'Unknown',
            planId,
            planName: plan.name,
            months: plan.months,
            basePrice: plan.price,
            uniqueAmount,
            wallet: PAYMENT_WALLET,
            createdAt: Date.now(),
            expiresAt: Date.now() + (30 * 60 * 1000),
            status: 'pending'
        };

        this.pendingPayments[userId] = payment;
        this.savePendingPayments();

        console.log(`[SUBS] Created payment for user ${userId}: ${uniqueAmount.toFixed(6)} SOL (${plan.name})`);
        return payment;
    }

    getPendingPayment(userId) {
        const payment = this.pendingPayments[userId];
        if (!payment) return null;

        if (Date.now() > payment.expiresAt) {
            this.cancelPendingPayment(userId);
            return null;
        }

        return payment;
    }

    cancelPendingPayment(userId) {
        const payment = this.pendingPayments[userId];
        if (payment) {
            if (payment.uniqueAmount) {
                this.usedAmounts.delete(payment.uniqueAmount.toFixed(6));
            }
            delete this.pendingPayments[userId];
            this.savePendingPayments();
            console.log(`[SUBS] Cancelled payment for user ${userId}`);
        }
    }

    async confirmPayment(userId, txSignature, bot) {
        const payment = this.pendingPayments[userId];
        if (!payment) return { success: false, error: 'No pending payment found' };

        const now = Date.now();
        let expiresAt;

        if (payment.months >= 9999) {
            expiresAt = null;
        } else {
            const existingSub = this.subscribers[userId];
            const startFrom = (existingSub && existingSub.expiresAt && existingSub.expiresAt > now)
                ? existingSub.expiresAt
                : now;
            expiresAt = startFrom + (payment.months * 30 * 24 * 60 * 60 * 1000);
        }

        this.subscribers[userId] = {
            orderId: payment.orderId,
            userId: userId.toString(),
            username: payment.username,
            planId: payment.planId,
            planName: payment.planName,
            isLifetime: payment.months >= 9999,
            subscribedAt: now,
            expiresAt,
            amountPaid: payment.uniqueAmount,
            txSignature,
            inviteLink: null
        };

        try {
            const inviteLink = await bot.telegram.createChatInviteLink(VIP_CHANNEL_ID, {
                member_limit: 1,
                name: `VIP-${userId}-${Date.now()}`
            });
            this.subscribers[userId].inviteLink = inviteLink.invite_link;
        } catch (e) {
            console.error('[SUBS] Error creating invite link:', e.message);
            return { success: false, error: 'Failed to create invite link' };
        }

        this.saveSubscribers();
        this.cancelPendingPayment(userId);

        console.log(`[SUBS] Activated subscription for user ${userId}: ${payment.planName}`);

        return {
            success: true,
            subscriber: this.subscribers[userId]
        };
    }

    isSubscribed(userId) {
        const sub = this.subscribers[userId];
        if (!sub) return false;
        if (sub.isLifetime) return true;
        if (sub.expiresAt && Date.now() > sub.expiresAt) {
            return false;
        }
        return true;
    }

    getSubscriber(userId) {
        return this.subscribers[userId] || null;
    }

    getActiveSubscribers() {
        const now = Date.now();
        return Object.values(this.subscribers).filter(sub => {
            if (sub.isLifetime) return true;
            return sub.expiresAt && sub.expiresAt > now;
        });
    }

    getExpiringSubscribers(days = 3) {
        const now = Date.now();
        const threshold = now + (days * 24 * 60 * 60 * 1000);

        return Object.values(this.subscribers).filter(sub => {
            if (sub.isLifetime) return false;
            return sub.expiresAt && sub.expiresAt > now && sub.expiresAt <= threshold;
        });
    }

    getExpiredSubscribers() {
        const now = Date.now();
        return Object.values(this.subscribers).filter(sub => {
            if (sub.isLifetime) return false;
            return sub.expiresAt && sub.expiresAt <= now;
        });
    }

    manualActivate(userId, username, planId, bot) {
        const plan = PLANS[planId];
        if (!plan) return { success: false, error: 'Invalid plan' };

        this.pendingPayments[userId] = {
            orderId: `MANUAL-${Date.now()}`,
            userId: userId.toString(),
            username,
            planId,
            planName: plan.name,
            months: plan.months,
            basePrice: plan.price,
            uniqueAmount: plan.price
        };

        return this.confirmPayment(userId, 'MANUAL', bot);
    }

    getPlans() {
        return PLANS;
    }

    getPaymentWallet() {
        return PAYMENT_WALLET;
    }

    getVipChannelId() {
        return VIP_CHANNEL_ID;
    }

    getAllPendingPayments() {
        const now = Date.now();
        let changed = false;

        Object.keys(this.pendingPayments).forEach(userId => {
            if (this.pendingPayments[userId].expiresAt < now) {
                this.cancelPendingPayment(userId);
                changed = true;
            }
        });

        if (changed) this.savePendingPayments();

        return Object.values(this.pendingPayments);
    }
}

module.exports = new SubscriptionManager();
