const axios = require('axios');
const EventEmitter = require('events');
const WebSocket = require('ws');

class PumpFunTracker extends EventEmitter {
    constructor() {
        super();
        this.recentMigrations = new Set();
        this.isTracking = false;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 10;
    }

    async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;

        console.log('🔍 Starting Pump.fun WebSocket connection...');

        this.connectWebSocket();
    }

    connectWebSocket() {
        try {
            // Pump.fun WebSocket for real-time new token creation
            console.log('🔌 Connecting to wss://pumpportal.fun/api/data ...');
            this.ws = new WebSocket('wss://pumpportal.fun/api/data');

            this.ws.on('open', () => {
                console.log('✅ Connected to Pump.fun WebSocket!');
                this.reconnectAttempts = 0;

                // Subscribe to MIGRATION events only (tokens that graduated to Raydium)
                const subscribeMsg = {
                    method: "subscribeMigration"
                };
                this.ws.send(JSON.stringify(subscribeMsg));
                console.log('📡 Subscribed to MIGRATION events only');
                console.log('👀 Waiting for tokens to migrate to Raydium...');
            });

            this.ws.on('message', async (data) => {
                try {
                    const message = JSON.parse(data.toString());

                    // Log server messages
                    if (message.message) {
                        console.log(`📨 Server: ${message.message}`);
                    }

                    // Migration event - token graduated to Raydium!
                    if (message.mint && message.pool) {
                        // DUPLICATE CHECK - skip if already processed
                        if (this.recentMigrations.has(message.mint)) {
                            console.log(`⏭️ SKIP: ${message.mint.slice(0,8)}... already processing`);
                            return;
                        }

                        // Add IMMEDIATELY to prevent duplicates
                        this.recentMigrations.add(message.mint);

                        console.log(`🚀 MIGRATION DETECTED!`);
                        console.log(`   Address: ${message.mint}`);
                        console.log(`   Pool: ${message.pool}`);

                        // Initial token data (may be incomplete)
                        const token = this.formatMigrationToken(message, {});
                        console.log(`   Token: ${token.name} (${token.symbol})`);

                        // DELAY + FETCH: Wait for DexScreener to index, then emit with full data
                        this.emitWithDelay(message.mint, token);
                    }
                } catch (e) {
                    console.log('Parse error:', e.message);
                }
            });

            this.ws.on('close', (code, reason) => {
                console.log(`⚠️ WebSocket disconnected (code: ${code})`);
                this.attemptReconnect();
            });

            this.ws.on('error', (error) => {
                console.log('❌ WebSocket error:', error.message);
            });

        } catch (error) {
            console.error('❌ Failed to connect:', error.message);
            this.attemptReconnect();
        }
    }

    // DELAYED EMIT: Wait for APIs to index, then fetch full data and emit
    async emitWithDelay(mintAddress, initialToken) {
        console.log(`   ⏳ Waiting 30s for APIs to index token...`);

        // Wait 30 seconds (SVS is faster than DexScreener)
        await new Promise(r => setTimeout(r, 30000));

        console.log(`   🔄 Fetching data from Solana Vibe Station + DexScreener...`);

        // ============ 1. SOLANA VIBE STATION API (Primary - faster indexing) ============
        let svsSuccess = false;
        try {
            const [metaRes, priceRes] = await Promise.all([
                axios.post('https://beta-api.solanavibestation.com/metadata',
                    { mints: [mintAddress] },
                    { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
                ),
                axios.post('https://beta-api.solanavibestation.com/price',
                    { mints: [mintAddress] },
                    { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
                )
            ]);

            const meta = metaRes.data?.metas?.[0];
            const price = priceRes.data?.prices?.[0];

            if (meta) {
                initialToken.name = meta.name || initialToken.name;
                initialToken.symbol = meta.symbol || initialToken.symbol;

                // IMAGE from off_chain_metadata (IPFS - very reliable!)
                if (meta.off_chain_metadata?.image) {
                    initialToken.image = meta.off_chain_metadata.image;
                    console.log(`   ✅ SVS: Got IMAGE (IPFS)`);
                    svsSuccess = true;
                }

                // SOCIALS from off_chain_metadata
                if (meta.off_chain_metadata?.twitter) {
                    initialToken.twitter = meta.off_chain_metadata.twitter;
                    console.log(`   ✅ SVS: Got Twitter`);
                }
                if (meta.off_chain_metadata?.telegram) {
                    initialToken.telegram = meta.off_chain_metadata.telegram;
                    console.log(`   ✅ SVS: Got Telegram`);
                }
                if (meta.off_chain_metadata?.website) {
                    initialToken.website = meta.off_chain_metadata.website;
                }
            }

            if (price) {
                initialToken.price = price.latest_price || initialToken.price;
            }

            console.log(`   ✅ SVS API: OK | Image: ${initialToken.image ? '✅' : '❌'}`);
        } catch (e) {
            console.log(`   ⚠️ SVS API failed: ${e.message}`);
        }

        // ============ 2. DEXSCREENER (For MC, Liquidity, Volume + fallback image) ============
        try {
            const dex = await axios.get(
                `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`,
                { timeout: 15000 }
            );

            if (dex.data?.pairs?.[0]) {
                const pair = dex.data.pairs[0];

                // Always get price data from DexScreener (more accurate)
                initialToken.marketCap = pair.fdv || pair.marketCap || initialToken.marketCap;
                initialToken.liquidity = pair.liquidity?.usd || initialToken.liquidity;
                initialToken.price = parseFloat(pair.priceUsd) || initialToken.price;

                // Volume data for filtering
                initialToken.volume5m = pair.volume?.m5 || 0;
                initialToken.volume1h = pair.volume?.h1 || 0;
                initialToken.volume24h = pair.volume?.h24 || 0;

                // Fallback name/symbol if SVS didn't have it
                if (!initialToken.name || initialToken.name.startsWith('Token ')) {
                    initialToken.name = pair.baseToken?.name || initialToken.name;
                }
                if (!initialToken.symbol || initialToken.symbol.length <= 4) {
                    initialToken.symbol = pair.baseToken?.symbol || initialToken.symbol;
                }

                // Fallback IMAGE if SVS didn't have it
                if (!initialToken.image && pair.info?.imageUrl) {
                    initialToken.image = pair.info.imageUrl;
                    console.log(`   ✅ DexScreener: Got IMAGE (fallback)`);
                }

                // Fallback SOCIALS if SVS didn't have them
                if (!initialToken.website && pair.info?.websites?.[0]?.url) {
                    initialToken.website = pair.info.websites[0].url;
                }
                if (pair.info?.socials) {
                    if (!initialToken.twitter) {
                        const tw = pair.info.socials.find(s => s.type === 'twitter');
                        if (tw) {
                            initialToken.twitter = tw.url;
                            console.log(`   ✅ DexScreener: Got Twitter (fallback)`);
                        }
                    }
                    if (!initialToken.telegram) {
                        const tg = pair.info.socials.find(s => s.type === 'telegram');
                        if (tg) {
                            initialToken.telegram = tg.url;
                            console.log(`   ✅ DexScreener: Got Telegram (fallback)`);
                        }
                    }
                }

                console.log(`   ✅ DexScreener: MC=$${Math.round(initialToken.marketCap)} | LP=$${Math.round(initialToken.liquidity)}`);
            } else {
                console.log(`   ⚠️ DexScreener: No pairs yet`);
            }
        } catch (e) {
            console.log(`   ⚠️ DexScreener fetch failed: ${e.message}`);
        }

        // ============ 3. HELIUS DAS API (Reliable fallback for metadata) ============
        if (!initialToken.image) {
            try {
                console.log(`   🔗 Trying Helius DAS API for metadata...`);
                const heliusResponse = await axios.post(
                    'https://mainnet.helius-rpc.com/?api-key=5c70b747-7e24-415b-8b87-697caaad0360',
                    {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'getAsset',
                        params: { id: mintAddress }
                    },
                    { timeout: 10000, headers: { 'Content-Type': 'application/json' } }
                );

                const asset = heliusResponse.data?.result;
                if (asset) {
                    // Get image from content
                    if (asset.content?.links?.image && !initialToken.image) {
                        initialToken.image = asset.content.links.image;
                        console.log(`   ✅ Helius: Got IMAGE`);
                    }
                    // Fallback to files
                    if (!initialToken.image && asset.content?.files?.[0]?.uri) {
                        initialToken.image = asset.content.files[0].uri;
                        console.log(`   ✅ Helius: Got IMAGE from files`);
                    }
                    // Get metadata
                    if (asset.content?.metadata) {
                        const meta = asset.content.metadata;
                        if (meta.name && (!initialToken.name || initialToken.name.startsWith('Token '))) {
                            initialToken.name = meta.name;
                        }
                        if (meta.symbol) {
                            initialToken.symbol = meta.symbol;
                        }
                    }
                    console.log(`   ✅ Helius DAS: OK | Image: ${initialToken.image ? '✅' : '❌'}`);
                }
            } catch (e) {
                console.log(`   ⚠️ Helius DAS failed: ${e.message}`);
            }
        }

        // ============ 4. SOLANA RPC (Last resort fallback) ============
        if (!initialToken.image) {
            try {
                console.log(`   🔗 Trying Solana RPC for on-chain metadata...`);
                const rpcResponse = await axios.post('https://api.mainnet-beta.solana.com', {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'getAccountInfo',
                    params: [mintAddress, { encoding: 'jsonParsed' }]
                }, { timeout: 10000, headers: { 'Content-Type': 'application/json' } });

                const extensions = rpcResponse.data?.result?.value?.data?.parsed?.info?.extensions;
                if (extensions) {
                    const tokenMeta = extensions.find(e => e.extension === 'tokenMetadata');
                    if (tokenMeta?.state?.uri) {
                        const metadataUri = tokenMeta.state.uri;
                        console.log(`   📄 Found metadata URI: ${metadataUri.substring(0, 50)}...`);

                        // Fetch the metadata JSON
                        const metaResponse = await axios.get(metadataUri, { timeout: 10000 });
                        const metaJson = metaResponse.data;

                        if (metaJson) {
                            // Get image
                            if (metaJson.image && !initialToken.image) {
                                initialToken.image = metaJson.image;
                                console.log(`   ✅ Solana RPC: Got IMAGE (on-chain)`);
                            }
                            // Get name/symbol if still missing
                            if (metaJson.name && (!initialToken.name || initialToken.name.startsWith('Token '))) {
                                initialToken.name = metaJson.name;
                            }
                            if (metaJson.symbol && (!initialToken.symbol || initialToken.symbol.length <= 4)) {
                                initialToken.symbol = metaJson.symbol;
                            }
                            // Get socials
                            if (metaJson.twitter && !initialToken.twitter) {
                                initialToken.twitter = metaJson.twitter;
                                console.log(`   ✅ Solana RPC: Got Twitter (on-chain)`);
                            }
                            if (metaJson.telegram && !initialToken.telegram) {
                                initialToken.telegram = metaJson.telegram;
                            }
                            if (metaJson.website && !initialToken.website) {
                                initialToken.website = metaJson.website;
                            }
                        }
                    }
                }
            } catch (e) {
                console.log(`   ⚠️ Solana RPC failed: ${e.message}`);
            }
        }

        // ============ 4. RUGCHECK (Safety score) ============
        try {
            const rug = await axios.get(
                `https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`,
                { timeout: 10000 }
            );
            if (rug.data) {
                initialToken.rugScore = rug.data.score;
                initialToken.isRugSafe = rug.data.score >= 500;
                if (rug.data.risks && Array.isArray(rug.data.risks)) {
                    initialToken.rugRisks = rug.data.risks.slice(0, 5).map(r => ({
                        name: r.name,
                        level: r.level,
                        description: r.description
                    }));
                }
                if (rug.data.topHolders) {
                    initialToken.topHolders = {
                        top10Pct: rug.data.topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0),
                        count: rug.data.topHolders.length
                    };
                }
                console.log(`   🛡️ RugCheck: ${rug.data.score}/1000`);
            }
        } catch (e) {
            // RugCheck optional
        }

        // Final summary
        console.log(`   📊 Final: ${initialToken.name} ($${initialToken.symbol}) | MC=$${Math.round(initialToken.marketCap)} | Image: ${initialToken.image ? '✅' : '❌'}`);

        // Skip tokens without image
        if (!initialToken.image) {
            console.log(`   ⏭️ SKIPPING: No image available for ${initialToken.symbol}`);
            return;
        }

        // Emit with updated data
        console.log(`   📤 Emitting call for ${initialToken.symbol}...`);
        this.emit('newMigration', initialToken);
    }

    attemptReconnect() {
        if (!this.isTracking) return;

        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * this.reconnectAttempts, 10000);
            console.log(`🔄 Reconnecting in ${delay/1000}s... (attempt ${this.reconnectAttempts})`);

            setTimeout(() => {
                if (this.isTracking) {
                    this.connectWebSocket();
                }
            }, delay);
        } else {
            console.log('❌ Max reconnect attempts reached, falling back to polling...');
            this.startPolling();
        }
    }

    // Fallback polling method
    startPolling() {
        console.log('📡 Starting polling fallback...');

        this.pollInterval = setInterval(async () => {
            await this.pollNewTokens();
        }, 5000);

        this.pollNewTokens();
    }

    async pollNewTokens() {
        try {
            // Use DexScreener latest pairs as fallback
            const response = await axios.get(
                'https://api.dexscreener.com/latest/dex/pairs/solana',
                { timeout: 10000 }
            );

            const pairs = response.data.pairs || [];
            const now = Date.now();
            const fiveMinAgo = now - 5 * 60 * 1000;

            const newPairs = pairs.filter(p =>
                p.pairCreatedAt > fiveMinAgo &&
                !this.recentMigrations.has(p.baseToken?.address)
            ).slice(0, 20);

            for (const pair of newPairs) {
                const address = pair.baseToken?.address;
                if (address && !this.recentMigrations.has(address)) {
                    this.recentMigrations.add(address);

                    const token = this.formatDexPair(pair);
                    console.log(`🚀 New token (poll): ${token.name} (${token.symbol})`);
                    this.emit('newMigration', token);
                }
            }

            // Cleanup old entries
            if (this.recentMigrations.size > 500) {
                const arr = Array.from(this.recentMigrations);
                this.recentMigrations = new Set(arr.slice(-250));
            }

        } catch (error) {
            console.log('Poll error:', error.message);
        }
    }

    stopTracking() {
        this.isTracking = false;

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        if (this.pollInterval) {
            clearInterval(this.pollInterval);
        }

        console.log('⏹️ Stopped tracking');
    }

    // Get token info from multiple APIs
    async getPumpFunTokenInfo(mintAddress) {
        let tokenData = {
            name: null,
            symbol: null,
            image_uri: null,
            usd_market_cap: null,
            priceUsd: null,
            liquidity: null,
            website: null,
            twitter: null,
            telegram: null,
            rugScore: null,
            rugRisks: [],
            topHolders: null,
            isRugSafe: null
        };

        console.log(`   🔄 Fetching from Pump.fun + DexScreener + RugCheck + Jupiter...`);

        // ============ PARALLEL: All APIs at once ============
        const [pumpResult, dexResult, rugResult, jupiterResult] = await Promise.allSettled([
            axios.get(`https://frontend-api.pump.fun/coins/${mintAddress}`, { timeout: 15000 }),
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 15000 }),
            axios.get(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report/summary`, { timeout: 15000 }),
            axios.get(`https://tokens.jup.ag/token/${mintAddress}`, { timeout: 15000 })
        ]);

        // ============ 1. PUMP.FUN - Best for name, symbol, image, socials ============
        if (pumpResult.status === 'fulfilled' && pumpResult.value?.data) {
            const pump = pumpResult.value.data;
            console.log(`   ✅ Pump.fun - OK`);

            tokenData.name = pump.name;
            tokenData.symbol = pump.symbol;
            tokenData.usd_market_cap = pump.usd_market_cap;

            // Image (IPFS works with Telegram)
            if (pump.image_uri) {
                tokenData.image_uri = pump.image_uri;
                console.log(`   📷 Image: Pump.fun IPFS`);
            }

            // Socials
            if (pump.twitter) tokenData.twitter = pump.twitter.startsWith('http') ? pump.twitter : `https://twitter.com/${pump.twitter}`;
            if (pump.telegram) tokenData.telegram = pump.telegram.startsWith('http') ? pump.telegram : `https://t.me/${pump.telegram}`;
            if (pump.website) tokenData.website = pump.website;
        } else {
            console.log(`   ⚠️ Pump.fun - Failed`);
        }

        // ============ 2. DEXSCREENER - Best for price, MC, liquidity ============
        if (dexResult.status === 'fulfilled' && dexResult.value?.data?.pairs?.length > 0) {
            const pair = dexResult.value.data.pairs[0];
            console.log(`   ✅ DexScreener - OK`);

            // Price data
            tokenData.usd_market_cap = pair.fdv || pair.marketCap || tokenData.usd_market_cap;
            tokenData.priceUsd = pair.priceUsd;
            tokenData.liquidity = pair.liquidity?.usd;

            // Fallback name/symbol
            if (!tokenData.name) tokenData.name = pair.baseToken?.name;
            if (!tokenData.symbol) tokenData.symbol = pair.baseToken?.symbol;

            // Fallback image
            if (!tokenData.image_uri && pair.info?.imageUrl) {
                tokenData.image_uri = pair.info.imageUrl;
                console.log(`   📷 Image: DexScreener`);
            }

            // Fallback socials
            if (!tokenData.website && pair.info?.websites?.[0]?.url) {
                tokenData.website = pair.info.websites[0].url;
            }
            if (pair.info?.socials) {
                if (!tokenData.twitter) {
                    const tw = pair.info.socials.find(s => s.type === 'twitter');
                    if (tw) tokenData.twitter = tw.url;
                }
                if (!tokenData.telegram) {
                    const tg = pair.info.socials.find(s => s.type === 'telegram');
                    if (tg) tokenData.telegram = tg.url;
                }
            }
        } else {
            console.log(`   ⚠️ DexScreener - No pairs yet`);
        }

        // ============ 3. JUPITER - Fallback for name/symbol/image ============
        if (jupiterResult.status === 'fulfilled' && jupiterResult.value?.data) {
            const jup = jupiterResult.value.data;
            console.log(`   ✅ Jupiter - OK`);

            if (!tokenData.name && jup.name) tokenData.name = jup.name;
            if (!tokenData.symbol && jup.symbol) tokenData.symbol = jup.symbol;
            if (!tokenData.image_uri && jup.logoURI) {
                tokenData.image_uri = jup.logoURI;
                console.log(`   📷 Image: Jupiter`);
            }
        } else {
            console.log(`   ⚠️ Jupiter - Not listed yet`);
        }

        // ============ 4. RUGCHECK - Safety score ============
        if (rugResult.status === 'fulfilled' && rugResult.value?.data) {
            const rug = rugResult.value.data;
            tokenData.rugScore = rug.score;
            tokenData.isRugSafe = rug.score >= 500;

            if (rug.risks && Array.isArray(rug.risks)) {
                tokenData.rugRisks = rug.risks.slice(0, 5).map(r => ({
                    name: r.name,
                    level: r.level,
                    description: r.description
                }));
            }

            if (rug.topHolders) {
                tokenData.topHolders = {
                    top10Pct: rug.topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0),
                    count: rug.topHolders.length
                };
            }
            console.log(`   🛡️ RugCheck: ${rug.score} | Risks: ${tokenData.rugRisks.length}`);
        } else {
            console.log(`   ⚠️ RugCheck - Failed`);
        }

        // ============ RETRY if missing critical data ============
        if (!tokenData.image_uri || !tokenData.name || !tokenData.symbol) {
            console.log(`   🔄 Missing data, retrying APIs (up to 20x)...`);

            for (let retry = 1; retry <= 20; retry++) {
                await new Promise(r => setTimeout(r, 2000));
                console.log(`   ⏳ Retry ${retry}/20...`);

                // Retry Pump.fun (best source)
                if (!tokenData.image_uri || !tokenData.name) {
                    try {
                        const pump = await axios.get(`https://frontend-api.pump.fun/coins/${mintAddress}`, { timeout: 8000 });
                        if (pump.data) {
                            if (!tokenData.name && pump.data.name) tokenData.name = pump.data.name;
                            if (!tokenData.symbol && pump.data.symbol) tokenData.symbol = pump.data.symbol;
                            if (!tokenData.image_uri && pump.data.image_uri) {
                                tokenData.image_uri = pump.data.image_uri;
                                console.log(`   ✅ Retry ${retry}: Got image from Pump.fun!`);
                            }
                            if (pump.data.twitter && !tokenData.twitter) tokenData.twitter = pump.data.twitter.startsWith('http') ? pump.data.twitter : `https://twitter.com/${pump.data.twitter}`;
                            if (pump.data.telegram && !tokenData.telegram) tokenData.telegram = pump.data.telegram.startsWith('http') ? pump.data.telegram : `https://t.me/${pump.data.telegram}`;
                            if (pump.data.website && !tokenData.website) tokenData.website = pump.data.website;
                        }
                    } catch (e) {}
                }

                // Retry DexScreener
                if (!tokenData.image_uri) {
                    try {
                        const dex = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 8000 });
                        if (dex.data?.pairs?.[0]) {
                            const pair = dex.data.pairs[0];
                            if (!tokenData.name) tokenData.name = pair.baseToken?.name;
                            if (!tokenData.symbol) tokenData.symbol = pair.baseToken?.symbol;
                            if (pair.info?.imageUrl) {
                                tokenData.image_uri = pair.info.imageUrl;
                                console.log(`   ✅ Retry ${retry}: Got image from DexScreener!`);
                            }
                        }
                    } catch (e) {}
                }

                // Got everything we need
                if (tokenData.image_uri && tokenData.name && tokenData.symbol) {
                    console.log(`   ✅ All data obtained on retry ${retry}`);
                    break;
                }
            }
        }

        // ============ FALLBACK: Try to get image from DexScreener one more time ============
        if (!tokenData.image_uri) {
            try {
                const finalDex = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 10000 });
                if (finalDex.data?.pairs?.[0]?.info?.imageUrl) {
                    tokenData.image_uri = finalDex.data.pairs[0].info.imageUrl;
                    console.log(`   📷 Got image from final DexScreener fetch!`);
                }
            } catch (e) {}
        }

        // If still no image, set to null - bot.js will fetch fresh from DexScreener
        if (!tokenData.image_uri) {
            console.log(`   ⚠️ No image found - will try DexScreener API when sending`);
        }

        // Fallback name/symbol
        if (!tokenData.name) tokenData.name = `Token ${mintAddress.slice(0, 8)}`;
        if (!tokenData.symbol) tokenData.symbol = mintAddress.slice(0, 5).toUpperCase();

        // Default MC if missing
        if (!tokenData.usd_market_cap || tokenData.usd_market_cap < 1000) {
            tokenData.usd_market_cap = 50000;
        }

        console.log(`   📊 Final: ${tokenData.name} ($${tokenData.symbol}) | MC=$${Math.round(tokenData.usd_market_cap)} | Liq=$${Math.round(tokenData.liquidity || 0)}`);
        console.log(`   📷 Image: ${tokenData.image_uri ? '✅' : '❌'} | 🐦 TW: ${tokenData.twitter ? '✅' : '❌'} | 📱 TG: ${tokenData.telegram ? '✅' : '❌'} | 🌐 Web: ${tokenData.website ? '✅' : '❌'}`);

        return tokenData;
    }

    // Format token from migration event (initial data, will be updated by emitWithDelay)
    formatMigrationToken(migrationData, pumpInfo) {
        const now = Date.now();
        const info = pumpInfo || {};

        return {
            address: migrationData.mint,
            name: info.name || migrationData.name || `Token ${migrationData.mint.slice(0, 6)}`,
            symbol: info.symbol || migrationData.symbol || migrationData.mint.slice(0, 4).toUpperCase(),
            price: parseFloat(info.priceUsd) || 0,
            priceChange5m: 0,
            priceChange1h: 0,
            marketCap: info.usd_market_cap || 69000,
            liquidity: info.liquidity || 12000,
            volume1h: 0,
            volume24h: 0,
            buys1h: 0,
            sells1h: 0,
            buyRatio: 0.5,
            pairAddress: migrationData.pool || null,
            dex: 'raydium',
            ageMinutes: 0,
            createdAt: now,
            website: null,
            twitter: null,
            telegram: null,
            image: null, // Will be set by emitWithDelay from DexScreener
            migrated: true,
            // RugCheck data
            rugScore: null,
            rugRisks: [],
            topHolders: null,
            isRugSafe: null
        };
    }

    // Format token from DexScreener API
    formatDexPair(pair) {
        const now = Date.now();
        return {
            address: pair.baseToken?.address || pair.tokenAddress,
            name: pair.baseToken?.name || 'Unknown',
            symbol: pair.baseToken?.symbol || '???',
            price: parseFloat(pair.priceUsd) || 0,
            priceChange5m: pair.priceChange?.m5 || 0,
            priceChange1h: pair.priceChange?.h1 || 0,
            marketCap: pair.fdv || pair.marketCap || 0,
            liquidity: pair.liquidity?.usd || 0,
            volume1h: pair.volume?.h1 || 0,
            volume24h: pair.volume?.h24 || 0,
            buys1h: pair.txns?.h1?.buys || 0,
            sells1h: pair.txns?.h1?.sells || 0,
            buyRatio: (pair.txns?.h1?.buys || 0) / ((pair.txns?.h1?.buys || 0) + (pair.txns?.h1?.sells || 0) || 1),
            pairAddress: pair.pairAddress,
            dex: pair.dexId || 'raydium',
            ageMinutes: pair.pairCreatedAt ? Math.floor((now - pair.pairCreatedAt) / 60000) : 0,
            createdAt: pair.pairCreatedAt || now,
            website: pair.info?.websites?.[0]?.url || null,
            twitter: (() => {
                const tw = pair.info?.socials?.find(s => s.type === 'twitter' || s.platform === 'twitter');
                return tw?.url || (tw?.handle ? `https://twitter.com/${tw.handle}` : null);
            })(),
            telegram: (() => {
                const tg = pair.info?.socials?.find(s => s.type === 'telegram' || s.platform === 'telegram');
                return tg?.url || (tg?.handle ? `https://t.me/${tg.handle}` : null);
            })()
        };
    }

    checkFilters(token, filters = {}) {
        // ========== CALL FILTERS ==========
        // 1. LP ≥ 15 SOL (~$3,000 USD)
        // 2. Top 10 holders ≤ 40%
        // 3. Mint authority revoked
        // 4. Freeze authority revoked
        // 5. Volume > $5,000 (5min)

        const MIN_LIQUIDITY_USD = 3000;  // ~15 SOL
        const MAX_TOP10_PERCENT = 40;
        const MIN_VOLUME_5M = 5000;

        const checks = {};
        const reasons = [];

        // 1. Liquidity check (≥15 SOL / ~$3000)
        checks.liquidity = token.liquidity >= MIN_LIQUIDITY_USD;
        if (!checks.liquidity) {
            reasons.push(`LP $${Math.round(token.liquidity || 0)} < $${MIN_LIQUIDITY_USD}`);
        }

        // 2. Top 10 holders ≤ 40%
        const top10Pct = token.topHolders?.top10Pct || 0;
        checks.topHolders = top10Pct <= MAX_TOP10_PERCENT || top10Pct === 0; // 0 = no data, pass
        if (!checks.topHolders) {
            reasons.push(`Top10 ${top10Pct.toFixed(1)}% > ${MAX_TOP10_PERCENT}%`);
        }

        // 3. Mint authority revoked
        const hasMintRisk = token.rugRisks?.some(r =>
            r.name?.toLowerCase().includes('mint') &&
            !r.name?.toLowerCase().includes('revoked')
        );
        checks.mintRevoked = !hasMintRisk;
        if (!checks.mintRevoked) {
            reasons.push('Mint NOT revoked');
        }

        // 4. Freeze authority revoked
        const hasFreezeRisk = token.rugRisks?.some(r =>
            r.name?.toLowerCase().includes('freeze') &&
            !r.name?.toLowerCase().includes('revoked')
        );
        checks.freezeRevoked = !hasFreezeRisk;
        if (!checks.freezeRevoked) {
            reasons.push('Freeze NOT revoked');
        }

        // 5. Volume > $5,000 (5min)
        const volume5m = token.volume5m || token.volume1h / 12 || 0; // estimate if no 5m data
        checks.volume = volume5m >= MIN_VOLUME_5M;
        if (!checks.volume) {
            reasons.push(`Vol $${Math.round(volume5m)} < $${MIN_VOLUME_5M}`);
        }

        // All checks must pass
        const passed = Object.values(checks).every(v => v === true);

        if (!passed) {
            console.log(`   ❌ FILTERED: ${reasons.join(' | ')}`);
        } else {
            console.log(`   ✅ PASSED: LP=$${Math.round(token.liquidity)} | Top10=${top10Pct.toFixed(1)}% | Vol=$${Math.round(volume5m)}`);
        }

        return { passed, checks, reasons };
    }

    async getSafetyScore(token) {
        let score = 50;
        const warnings = [];
        const positives = [];

        if (token.liquidity >= 20000) {
            score += 15;
            positives.push('✅ Strong liquidity');
        } else if (token.liquidity >= 10000) {
            score += 10;
            positives.push('✅ Good liquidity');
        } else if (token.liquidity < 5000) {
            score -= 10;
            warnings.push('⚠️ Low liquidity');
        }

        if (token.buyRatio >= 0.6) {
            score += 15;
            positives.push('✅ Strong buy pressure');
        } else if (token.buyRatio < 0.4) {
            score -= 10;
            warnings.push('⚠️ More sells than buys');
        }

        if (token.ageMinutes < 10) {
            score += 10;
            positives.push('🔥 Very fresh');
        }

        if (token.volume1h > 5000) {
            score += 10;
            positives.push('✅ High volume');
        }

        return {
            score: Math.max(0, Math.min(100, score)),
            warnings,
            positives,
            risk: score >= 70 ? 'LOW' : score >= 50 ? 'MEDIUM' : 'HIGH'
        };
    }
}

module.exports = PumpFunTracker;
