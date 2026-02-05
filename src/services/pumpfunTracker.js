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
        this.maxReconnectAttempts = 3; // Quick fallback to polling
        this.pollInterval = null;
        this.skipWebSocket = false; // Set to true when StreamFW is primary
    }

    async startTracking() {
        if (this.isTracking) return;
        this.isTracking = true;

        console.log('🔍 Starting tracker...');

        if (!this.skipWebSocket) {
            // Try WebSocket first
            this.connectWebSocket();

            // Start polling as backup after 5 seconds if WebSocket fails
            setTimeout(() => {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                    console.log('📡 WebSocket not connected, using DexScreener polling...');
                    this.startPolling();
                }
            }, 5000);
        } else {
            console.log('📡 PumpPortal WebSocket skipped (StreamFW is primary)');
        }
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
        console.log(`   ⏳ Waiting 20s for APIs to index token...`);

        // Wait 20 seconds for APIs to index (SVS ~5s, DexScreener ~15-25s, RugCheck ~10-20s)
        await new Promise(r => setTimeout(r, 20000));

        console.log(`   🔄 Fetching data from Solana Vibe Station + DexScreener...`);

        // ============ 1. SOLANA VIBE STATION API (Primary - faster indexing) ============
        const SVS_API_KEY = 'c48991a229b6d58fba136c9cc9af62cf';
        let svsSuccess = false;
        try {
            const [metaRes, priceRes] = await Promise.all([
                axios.post('https://free.api.solanavibestation.com/metadata',
                    { mints: [mintAddress] },
                    { timeout: 10000, headers: { 'Content-Type': 'application/json', 'Authorization': SVS_API_KEY } }
                ),
                axios.post('https://free.api.solanavibestation.com/price',
                    { mints: [mintAddress] },
                    { timeout: 10000, headers: { 'Content-Type': 'application/json', 'Authorization': SVS_API_KEY } }
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

        // ============ 3. GECKOTERMINAL (Additional price data - price changes, txs) ============
        try {
            const geckoRes = await axios.get(
                `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mintAddress}`,
                { timeout: 10000 }
            );

            if (geckoRes.data?.data?.attributes) {
                const attr = geckoRes.data.data.attributes;

                // Price if not set
                if (!initialToken.price && attr.price_usd) {
                    initialToken.price = parseFloat(attr.price_usd);
                }

                // FDV/MC if not set
                if (!initialToken.marketCap && attr.fdv_usd) {
                    initialToken.marketCap = parseFloat(attr.fdv_usd);
                }

                // Volume if not set
                if (!initialToken.volume24h && attr.volume_usd?.h24) {
                    initialToken.volume24h = parseFloat(attr.volume_usd.h24);
                }

                console.log(`   ✅ GeckoTerminal: Price=$${attr.price_usd ? parseFloat(attr.price_usd).toFixed(8) : 'N/A'}`);
            }

            // Also try to get pool data for price changes
            const poolsRes = await axios.get(
                `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mintAddress}/pools?page=1`,
                { timeout: 10000 }
            );

            if (poolsRes.data?.data?.[0]?.attributes) {
                const poolAttr = poolsRes.data.data[0].attributes;

                // Price change percentages
                if (poolAttr.price_change_percentage) {
                    initialToken.priceChange5m = parseFloat(poolAttr.price_change_percentage.m5) || 0;
                    initialToken.priceChange15m = parseFloat(poolAttr.price_change_percentage.m15) || 0;
                    initialToken.priceChange1h = parseFloat(poolAttr.price_change_percentage.h1) || 0;
                    initialToken.priceChange24h = parseFloat(poolAttr.price_change_percentage.h24) || 0;
                }

                // Transaction counts
                if (poolAttr.transactions?.h1) {
                    initialToken.buys1h = poolAttr.transactions.h1.buys || 0;
                    initialToken.sells1h = poolAttr.transactions.h1.sells || 0;
                    initialToken.buyRatio = initialToken.buys1h / (initialToken.buys1h + initialToken.sells1h || 1);
                }

                console.log(`   ✅ GeckoTerminal Pool: 1h Change=${initialToken.priceChange1h?.toFixed(1) || 0}% | Buys=${initialToken.buys1h || 0} Sells=${initialToken.sells1h || 0}`);
            }
        } catch (e) {
            console.log(`   ⚠️ GeckoTerminal failed: ${e.message}`);
        }

        // ============ 4. HELIUS DAS API (Reliable fallback for metadata) ============
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

        // ============ 5. SOLANA RPC (Last resort fallback) ============
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

        // ============ 6. RUGCHECK + BUNDLE DETECTION (parallel) ============
        const [rugResult, bundleResult] = await Promise.allSettled([
            axios.get(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, { timeout: 15000 }),
            this.detectBundleAndSnipers(mintAddress)
        ]);

        // Process RugCheck result
        try {
            if (rugResult.status === 'fulfilled' && rugResult.value?.data) {
                const rugData = rugResult.value.data;
                initialToken.rugScore = rugData.score;
                initialToken.isRugSafe = rugData.score >= 500;
                if (rugData.risks && Array.isArray(rugData.risks)) {
                    initialToken.rugRisks = rugData.risks.slice(0, 5).map(r => ({
                        name: r.name,
                        level: r.level,
                        description: r.description
                    }));
                }
                // Full report has topHolders with pct in percentage format (e.g., 81.71 = 81.71%)
                if (rugData.topHolders && rugData.topHolders.length > 0) {
                    const creator = rugData.creator; // Dev wallet address
                    const poolAddress = initialToken.pairAddress || null;
                    const top10 = rugData.topHolders.slice(0, 10);

                    // Known non-holder addresses (LP pools, bonding curves, programs)
                    const KNOWN_CONTRACTS = [
                        '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Pump.fun bonding curve
                        'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // PumpSwap AMM
                        '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
                        '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h', // Raydium authority
                        'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
                    ];

                    // Find dev holding by matching owner to creator
                    const devHolder = top10.find(h => h.owner === creator);

                    // Identify each holder type
                    const holdersWithType = top10.map((h, i) => {
                        const owner = h.owner || '';
                        const isPool = KNOWN_CONTRACTS.some(c => owner.includes(c)) ||
                                       (poolAddress && owner === poolAddress);
                        const isCreator = owner === creator;

                        return {
                            rank: i + 1,
                            pct: (h.pct || 0) / 100,
                            address: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : '????',
                            isCreator,
                            isPool
                        };
                    });

                    // Calculate top10 % EXCLUDING pools/contracts (real holders only)
                    const realHolders = holdersWithType.filter(h => !h.isPool);
                    const realTop10Pct = realHolders.reduce((sum, h) => sum + h.pct, 0);
                    const allTop10Pct = holdersWithType.reduce((sum, h) => sum + h.pct, 0);

                    initialToken.topHolders = {
                        top10Pct: realTop10Pct, // Only real holders for filtering
                        top10PctAll: allTop10Pct, // Including pools for display
                        count: rugData.topHolders.length,
                        holders: holdersWithType,
                        devPct: devHolder ? (devHolder.pct / 100) : 0,
                        devSold: rugData.creatorBalance === 0
                    };
                    console.log(`   🛡️ RugCheck: ${rugData.score}/1000 | Top10: ${(realTop10Pct * 100).toFixed(1)}% real (${(allTop10Pct * 100).toFixed(1)}% with pools)`);
                } else {
                    console.log(`   🛡️ RugCheck: ${rugData.score}/1000 | No holders data`);
                }
            } else if (rugResult.status === 'rejected') {
                console.log(`   ⚠️ RugCheck failed: ${rugResult.reason?.message || 'Unknown error'}`);
            }
        } catch (e) {
            console.log(`   ⚠️ RugCheck processing error: ${e.message}`);
        }

        // Process Bundle/Sniper result
        if (bundleResult.status === 'fulfilled') {
            const bd = bundleResult.value;
            initialToken.bundleCount = bd.bundleCount;
            initialToken.sniperCount = bd.sniperCount;
            initialToken.bundleHoldPct = bd.bundleHoldPct;
            initialToken.sniperHoldPct = bd.sniperHoldPct;
            console.log(`   🔍 Bundle: ${bd.bundleCount} (${bd.bundleHoldPct}%) | Snipers: ${bd.sniperCount} (${bd.sniperHoldPct}%)`);
        } else {
            initialToken.bundleCount = 0;
            initialToken.sniperCount = 0;
            initialToken.bundleHoldPct = 0;
            initialToken.sniperHoldPct = 0;
            console.log(`   ⚠️ Bundle detection failed`);
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

    // DexScreener polling - primary method when WebSocket is down
    startPolling() {
        if (this.pollInterval) return; // Already polling

        console.log('📡 Starting DexScreener polling (every 10s)...');
        console.log('👀 Looking for new Raydium pairs...');

        this.pollInterval = setInterval(async () => {
            await this.pollNewTokens();
        }, 10000); // Poll every 10 seconds

        // First poll immediately
        this.pollNewTokens();
    }

    async pollNewTokens() {
        try {
            // Use DexScreener latest pairs
            const response = await axios.get(
                'https://api.dexscreener.com/latest/dex/pairs/solana',
                { timeout: 15000 }
            );

            const pairs = response.data?.pairs || [];
            const now = Date.now();
            const tenMinAgo = now - 10 * 60 * 1000;

            // Filter: new pairs (< 10 min), on Raydium, not processed, has liquidity
            const newPairs = pairs.filter(p => {
                const isNew = p.pairCreatedAt > tenMinAgo;
                const isRaydium = p.dexId === 'raydium';
                const notProcessed = !this.recentMigrations.has(p.baseToken?.address);
                const hasLiquidity = (p.liquidity?.usd || 0) >= 3000;
                return isNew && isRaydium && notProcessed && hasLiquidity;
            }).slice(0, 10);

            if (newPairs.length > 0) {
                console.log(`🔍 Found ${newPairs.length} new Raydium pairs`);
            }

            for (const pair of newPairs) {
                const address = pair.baseToken?.address;
                if (!address || this.recentMigrations.has(address)) continue;

                this.recentMigrations.add(address);

                console.log(`🚀 NEW TOKEN: ${pair.baseToken?.symbol || 'Unknown'}`);
                console.log(`   Address: ${address.slice(0, 8)}...`);
                console.log(`   MC: $${Math.round(pair.fdv || pair.marketCap || 0)}`);
                console.log(`   LP: $${Math.round(pair.liquidity?.usd || 0)}`);

                // Format and emit with delay for data enrichment
                const token = this.formatMigrationToken({ mint: address, pool: pair.pairAddress }, {});
                this.emitWithDelay(address, token);
            }

            // Cleanup old entries
            if (this.recentMigrations.size > 500) {
                const arr = Array.from(this.recentMigrations);
                this.recentMigrations = new Set(arr.slice(-250));
            }

        } catch (error) {
            if (error.message.includes('429')) {
                console.log('⚠️ Rate limited, waiting...');
            } else {
                console.log('Poll error:', error.message);
            }
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
            isRugSafe: null,
            bundleCount: 0,
            sniperCount: 0,
            bundleHoldPct: 0,
            sniperHoldPct: 0
        };

        console.log(`   🔄 Fetching from Pump.fun + DexScreener + RugCheck + Jupiter...`);

        // ============ PARALLEL: All APIs at once ============
        const [pumpResult, dexResult, rugResult, jupiterResult] = await Promise.allSettled([
            axios.get(`https://frontend-api.pump.fun/coins/${mintAddress}`, { timeout: 15000 }),
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 15000 }),
            axios.get(`https://api.rugcheck.xyz/v1/tokens/${mintAddress}/report`, { timeout: 15000 }), // Full report for topHolders
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

        // ============ 4. RUGCHECK - Safety score + Holders ============
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

            // Full report has topHolders with pct in percentage format (e.g., 81.71 = 81.71%)
            if (rug.topHolders && rug.topHolders.length > 0) {
                const creator = rug.creator;
                const top10 = rug.topHolders.slice(0, 10);

                const KNOWN_CONTRACTS = [
                    '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
                    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
                    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
                    '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
                    'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
                ];

                const devHolder = top10.find(h => h.owner === creator);

                const holdersWithType = top10.map((h, i) => {
                    const owner = h.owner || '';
                    const isPool = KNOWN_CONTRACTS.some(c => owner.includes(c));
                    return {
                        rank: i + 1,
                        pct: (h.pct || 0) / 100,
                        address: h.address ? `${h.address.slice(0, 4)}...${h.address.slice(-4)}` : '????',
                        isCreator: h.owner === creator,
                        isPool
                    };
                });

                const realHolders = holdersWithType.filter(h => !h.isPool);
                const realTop10Pct = realHolders.reduce((sum, h) => sum + h.pct, 0);

                tokenData.topHolders = {
                    top10Pct: realTop10Pct,
                    top10PctAll: holdersWithType.reduce((sum, h) => sum + h.pct, 0),
                    count: rug.topHolders.length,
                    holders: holdersWithType,
                    devPct: devHolder ? (devHolder.pct / 100) : 0
                };
                console.log(`   🛡️ RugCheck: ${rug.score} | Top10: ${(realTop10Pct * 100).toFixed(1)}% real`);
            } else {
                console.log(`   🛡️ RugCheck: ${rug.score} | No holders data`);
            }
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
            isRugSafe: null,
            // Bundle/Sniper data
            bundleCount: 0,
            sniperCount: 0,
            bundleHoldPct: 0,
            sniperHoldPct: 0
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
        // 1. LP ≥ $3,000 USD
        // 2. Top 10 holders ≤ 35%
        // 3. Mint authority revoked
        // 4. Freeze authority revoked
        // 5. Volume ≥ $7,500 (5min)
        // 6. Market Cap ≥ $20,000
        // 7. Bundle wallets hold ≤ 20% supply
        // 8. Sniper wallets hold ≤ 20% supply

        const MIN_LIQUIDITY_USD = 3000;  // ~15 SOL
        const MAX_TOP10_PERCENT = 35;
        const MIN_VOLUME_5M = 7500;

        const checks = {};
        const reasons = [];

        // 1. Liquidity check (≥15 SOL / ~$3000)
        checks.liquidity = token.liquidity >= MIN_LIQUIDITY_USD;
        if (!checks.liquidity) {
            reasons.push(`LP $${Math.round(token.liquidity || 0)} < $${MIN_LIQUIDITY_USD}`);
        }

        // 2. Top 10 holders ≤ 40%
        const top10PctRaw = token.topHolders?.top10Pct || 0;
        // top10Pct is stored as decimal (0.82 = 82%), convert to percentage for comparison
        const top10Pct = top10PctRaw > 1 ? top10PctRaw : top10PctRaw * 100;
        checks.topHolders = top10Pct <= MAX_TOP10_PERCENT || top10PctRaw === 0; // 0 = no data, pass
        if (!checks.topHolders) {
            reasons.push(`Top10 ${top10Pct.toFixed(1)}% > ${MAX_TOP10_PERCENT}%`);
        }

        // 3. RugCheck data must be available
        const hasRugData = token.rugRisks && token.rugRisks.length > 0;
        checks.rugDataAvailable = hasRugData || (token.rugScore !== null && token.rugScore !== undefined);
        if (!checks.rugDataAvailable) {
            reasons.push('No RugCheck data');
        }

        // 4. Mint authority revoked (only check if RugCheck data exists)
        if (hasRugData) {
            const hasMintRisk = token.rugRisks.some(r =>
                r.name?.toLowerCase().includes('mint') &&
                !r.name?.toLowerCase().includes('revoked')
            );
            checks.mintRevoked = !hasMintRisk;
            if (!checks.mintRevoked) {
                reasons.push('Mint NOT revoked');
            }
        } else {
            checks.mintRevoked = false; // No data = fail
        }

        // 5. Freeze authority revoked (only check if RugCheck data exists)
        if (hasRugData) {
            const hasFreezeRisk = token.rugRisks.some(r =>
                r.name?.toLowerCase().includes('freeze') &&
                !r.name?.toLowerCase().includes('revoked')
            );
            checks.freezeRevoked = !hasFreezeRisk;
            if (!checks.freezeRevoked) {
                reasons.push('Freeze NOT revoked');
            }
        } else {
            checks.freezeRevoked = false; // No data = fail
        }

        // 5. Volume > $5,000 (5min)
        const volume5m = token.volume5m || token.volume1h / 12 || 0; // estimate if no 5m data
        checks.volume = volume5m >= MIN_VOLUME_5M;
        if (!checks.volume) {
            reasons.push(`Vol $${Math.round(volume5m)} < $${MIN_VOLUME_5M}`);
        }

        // 6. Minimum Market Cap ≥ $20,000
        const MIN_MC = 20000;
        checks.marketCap = (token.marketCap || 0) >= MIN_MC;
        if (!checks.marketCap) {
            reasons.push(`MC $${Math.round(token.marketCap || 0)} < $${MIN_MC}`);
        }

        // 7. Bundle wallets hold ≤ 20% supply
        const MAX_BUNDLE_HOLD_PCT = 20;
        const bundleHoldPct = token.bundleHoldPct || 0;
        checks.bundleHold = bundleHoldPct <= MAX_BUNDLE_HOLD_PCT;
        if (!checks.bundleHold) {
            reasons.push(`Bundle ${bundleHoldPct.toFixed(1)}% > ${MAX_BUNDLE_HOLD_PCT}%`);
        }

        // 8. Sniper wallets hold ≤ 20% supply
        const MAX_SNIPER_HOLD_PCT = 20;
        const sniperHoldPct = token.sniperHoldPct || 0;
        checks.sniperHold = sniperHoldPct <= MAX_SNIPER_HOLD_PCT;
        if (!checks.sniperHold) {
            reasons.push(`Sniper ${sniperHoldPct.toFixed(1)}% > ${MAX_SNIPER_HOLD_PCT}%`);
        }

        // All checks must pass
        const passed = Object.values(checks).every(v => v === true);

        if (!passed) {
            console.log(`   ❌ FILTERED: ${reasons.join(' | ')}`);
        } else {
            console.log(`   ✅ PASSED: LP=$${Math.round(token.liquidity)} | Top10=${top10Pct.toFixed(1)}% | MC=$${Math.round(token.marketCap)} | Vol=$${Math.round(volume5m)} | Bundle=${bundleHoldPct.toFixed(1)}% | Sniper=${sniperHoldPct.toFixed(1)}%`);
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

    // Detect bundle buys and snipers using Helius Enhanced Transactions API
    async detectBundleAndSnipers(mintAddress) {
        try {
            const HELIUS_KEY = process.env.HELIUS_API_KEY || '5c70b747-7e24-415b-8b87-697caaad0360';
            const response = await axios.get(
                `https://api.helius.xyz/v0/addresses/${mintAddress}/transactions?api-key=${HELIUS_KEY}&limit=100`,
                { timeout: 15000 }
            );
            const txs = response.data || [];
            if (txs.length === 0) return { bundleCount: 0, sniperCount: 0, bundleHoldPct: 0, sniperHoldPct: 0 };

            // Pump.fun tokens have 1 billion total supply
            const TOTAL_SUPPLY = 1_000_000_000;

            // Sort by slot ascending (oldest first)
            txs.sort((a, b) => a.slot - b.slot);
            const creationSlot = txs[0].slot;

            // Collect buyer wallets per slot with their token amounts
            const buyersBySlot = new Map(); // slot -> Map(wallet -> totalAmount)
            for (const tx of txs) {
                if (!tx.tokenTransfers) continue;
                for (const t of tx.tokenTransfers) {
                    if (t.mint === mintAddress && t.toUserAccount && t.tokenAmount > 0) {
                        if (!buyersBySlot.has(tx.slot)) buyersBySlot.set(tx.slot, new Map());
                        const slotMap = buyersBySlot.get(tx.slot);
                        const current = slotMap.get(t.toUserAccount) || 0;
                        slotMap.set(t.toUserAccount, current + t.tokenAmount);
                    }
                }
            }

            // BUNDLE: wallets that bought in the same slot as creation
            const creationBuyers = buyersBySlot.get(creationSlot) || new Map();
            const bundleCount = creationBuyers.size;
            let bundleTotalTokens = 0;
            for (const amount of creationBuyers.values()) {
                bundleTotalTokens += amount;
            }
            const bundleHoldPct = (bundleTotalTokens / TOTAL_SUPPLY) * 100;

            // SNIPERS: wallets that bought within ~5s (12 slots) after creation, excluding bundle wallets
            const SNIPE_WINDOW = 12;
            const sniperWallets = new Map(); // wallet -> totalAmount
            for (const [slot, walletAmounts] of buyersBySlot) {
                if (slot > creationSlot && slot <= creationSlot + SNIPE_WINDOW) {
                    for (const [wallet, amount] of walletAmounts) {
                        if (!creationBuyers.has(wallet)) {
                            const current = sniperWallets.get(wallet) || 0;
                            sniperWallets.set(wallet, current + amount);
                        }
                    }
                }
            }
            let sniperTotalTokens = 0;
            for (const amount of sniperWallets.values()) {
                sniperTotalTokens += amount;
            }
            const sniperHoldPct = (sniperTotalTokens / TOTAL_SUPPLY) * 100;

            return {
                bundleCount,
                sniperCount: sniperWallets.size,
                bundleHoldPct: Math.round(bundleHoldPct * 100) / 100, // Round to 2 decimals
                sniperHoldPct: Math.round(sniperHoldPct * 100) / 100
            };
        } catch (e) {
            console.log(`   ⚠️ Bundle detection failed: ${e.message}`);
            return { bundleCount: 0, sniperCount: 0, bundleHoldPct: 0, sniperHoldPct: 0 };
        }
    }
}

module.exports = PumpFunTracker;
