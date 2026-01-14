// Remove problematic Markdown characters (simple removal, not escaping)
function cleanText(text) {
    if (!text) return '';
    return String(text)
        .replace(/[_*\[\]`~]/g, '');
}

// Format migration call message
function formatCallMessage(token, safety) {
    // RugCheck score emoji
    const getRugEmoji = (score) => {
        if (!score) return '❓';
        if (score >= 700) return '🟢';
        if (score >= 400) return '🟡';
        return '🔴';
    };

    const ageText = token.ageMinutes < 1
        ? 'Just now'
        : token.ageMinutes < 60
            ? `${token.ageMinutes}m ago`
            : `${Math.floor(token.ageMinutes / 60)}h ago`;

    // Clean token name and symbol to remove problematic characters
    const safeName = cleanText(token.name);
    const safeSymbol = cleanText(token.symbol);

    let message = `🚀 *NEW MIGRATION* 🚀

📛 *${safeName}* ($${safeSymbol})
📍 \`${token.address}\`

💰 MC: $${formatNumber(token.marketCap)} | 💧 Liq: $${formatNumber(token.liquidity)}
💵 Price: $${formatPrice(token.price)}
🕐 Migrated: ${ageText}`;

    // RugCheck info
    if (token.rugScore !== null) {
        message += `\n\n🛡️ *RugCheck:* ${getRugEmoji(token.rugScore)} ${token.rugScore}/1000`;

        // Top holders concentration
        if (token.topHolders?.top10Pct) {
            const holdPct = (token.topHolders.top10Pct * 100).toFixed(1);
            message += ` | Top10: ${holdPct}%`;
        }

        // Show top risks (max 2)
        if (token.rugRisks && token.rugRisks.length > 0) {
            const topRisks = token.rugRisks.slice(0, 2).map(r => cleanText(r.name)).join(', ');
            message += `\n⚠️ ${topRisks}`;
        }
    }

    // Add socials if available
    let socials = [];
    if (token.twitter) socials.push(`[TW](${token.twitter})`);
    if (token.telegram) socials.push(`[TG](${token.telegram})`);
    if (token.website) socials.push(`[Web](${token.website})`);

    if (socials.length > 0) {
        message += `\n\n🔗 ${socials.join(' | ')}`;
    }

    message += `

[Dex](https://dexscreener.com/solana/${token.address}) | [Birdeye](https://birdeye.so/token/${token.address}?chain=solana) | [Photon](https://photon-sol.tinyastro.io/en/lp/${token.address}) | [Pump](https://pump.fun/${token.address}) | [RugCheck](https://rugcheck.xyz/tokens/${token.address})

💎 Join VIP and get signals first.
(Free group has a 2-minute delay)
⚠️ Always DYOR!

Our VIP members get instant calls and more premium signals than the public group. 👉 @Degens_1000x_call_bot`;

    return message;
}

// Format simple alert
function formatQuickAlert(token) {
    const safeSymbol = cleanText(token.symbol);
    return `
🚀 *${safeSymbol}* migrated!

💰 MC: $${formatNumber(token.marketCap)}
💧 Liq: $${formatNumber(token.liquidity)}

\`${token.address}\`

[DexScreener](https://dexscreener.com/solana/${token.address})
`;
}

// Format price
function formatPrice(price) {
    if (!price || price === 0) return '0';

    if (price < 0.00000001) {
        return price.toExponential(2);
    } else if (price < 0.0001) {
        return price.toFixed(10).replace(/\.?0+$/, '');
    } else if (price < 0.01) {
        return price.toFixed(6);
    } else if (price < 1) {
        return price.toFixed(4);
    } else {
        return price.toFixed(2);
    }
}

// Format large numbers
function formatNumber(num) {
    if (!num || num === 0) return '0';

    if (num >= 1000000000) {
        return (num / 1000000000).toFixed(2) + 'B';
    } else if (num >= 1000000) {
        return (num / 1000000).toFixed(2) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    } else {
        return num.toFixed(0);
    }
}

module.exports = {
    formatCallMessage,
    formatQuickAlert,
    formatPrice,
    formatNumber
};
