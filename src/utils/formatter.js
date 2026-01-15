// Escape HTML special characters
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Format migration call message (HTML format - more stable than Markdown)
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

    // Escape token name and symbol
    const safeName = escapeHtml(token.name);
    const safeSymbol = escapeHtml(token.symbol);

    let message = `🚀 <b>NEW MIGRATION</b> 🚀

📛 <b>${safeName}</b> ($${safeSymbol})
📍 <code>${token.address}</code>

💰 MC: $${formatNumber(token.marketCap)} | 💧 Liq: $${formatNumber(token.liquidity)}
💵 Price: $${formatPrice(token.price)}
🕐 Migrated: ${ageText}`;

    // RugCheck info
    if (token.rugScore !== null) {
        message += `\n\n🛡️ <b>RugCheck:</b> ${getRugEmoji(token.rugScore)} ${token.rugScore}/1000`;

        // Top holders concentration
        if (token.topHolders?.top10Pct) {
            const holdPct = (token.topHolders.top10Pct * 100).toFixed(1);
            message += ` | Top10: ${holdPct}%`;
        }

        // Show top risks (max 2)
        if (token.rugRisks && token.rugRisks.length > 0) {
            const topRisks = token.rugRisks.slice(0, 2).map(r => escapeHtml(r.name)).join(', ');
            message += `\n⚠️ ${topRisks}`;
        }
    }

    // Add socials if available
    let socials = [];
    if (token.twitter) socials.push(`<a href="${token.twitter}">TW</a>`);
    if (token.telegram) socials.push(`<a href="${token.telegram}">TG</a>`);
    if (token.website) socials.push(`<a href="${token.website}">Web</a>`);

    if (socials.length > 0) {
        message += `\n\n🔗 ${socials.join(' | ')}`;
    }

    message += `

<a href="https://dexscreener.com/solana/${token.address}">Dex</a> | <a href="https://birdeye.so/token/${token.address}?chain=solana">Birdeye</a> | <a href="https://photon-sol.tinyastro.io/en/lp/${token.address}">Photon</a> | <a href="https://pump.fun/${token.address}">Pump</a> | <a href="https://rugcheck.xyz/tokens/${token.address}">RugCheck</a>

💎 Join VIP for premium signals without delay.
🎁 FREE group has no delay until end of January!
⚠️ Always DYOR!

👉 @Degens_1000x_call_bot`;

    return message;
}

// Format simple alert (HTML)
function formatQuickAlert(token) {
    const safeSymbol = escapeHtml(token.symbol);
    return `🚀 <b>${safeSymbol}</b> migrated!

💰 MC: $${formatNumber(token.marketCap)}
💧 Liq: $${formatNumber(token.liquidity)}

<code>${token.address}</code>

<a href="https://dexscreener.com/solana/${token.address}">DexScreener</a>`;
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
