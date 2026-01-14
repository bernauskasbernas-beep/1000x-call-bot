const { Connection, VersionedTransaction, PublicKey, Keypair } = require('@solana/web3.js');
const fetch = require('cross-fetch');
const bs58 = require('bs58').default;

// Load from environment - Helius RPC for better performance
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '5c70b747-7e24-415b-8b87-697caaad0360';
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const TRADING_PRIVATE_KEY = process.env.TRADING_PRIVATE_KEY;

const connection = new Connection(RPC_URL, {
    commitment: 'confirmed',
    confirmTransactionInitialTimeout: 60000
});

const JUPITER_QUOTE_API = 'https://api.jup.ag/swap/v1/quote';
const JUPITER_SWAP_API = 'https://api.jup.ag/swap/v1/swap';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Get trading wallet keypair from .env
function getTradingKeypair() {
    if (!TRADING_PRIVATE_KEY) {
        throw new Error('TRADING_PRIVATE_KEY not found in .env');
    }
    const secretKey = bs58.decode(TRADING_PRIVATE_KEY);
    return Keypair.fromSecretKey(secretKey);
}

// Check wallet balance
async function getWalletBalance() {
    try {
        const keypair = getTradingKeypair();
        const balance = await connection.getBalance(keypair.publicKey);
        return balance / 1e9; // Convert lamports to SOL
    } catch (error) {
        console.error('[JUPITER] Error getting balance:', error.message);
        return 0;
    }
}

// Sleep helper
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Buy token with retry logic - HARDCODED 50% slippage for volatile memecoins
async function buyToken(userId, tokenMint, solAmount) {
    const BUY_SLIPPAGE = 5000; // 50% slippage for buying
    console.log(`[JUPITER] Buying ${tokenMint} with ${solAmount} SOL (slippage: 50%)`);

    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const keypair = getTradingKeypair();

            // Step 0: Check balance
            const balance = await getWalletBalance();
            const minRequired = solAmount + 0.01; // Extra for fees

            if (balance < minRequired) {
                return {
                    success: false,
                    error: `Insufficient balance: ${balance.toFixed(4)} SOL (need ${minRequired.toFixed(4)} SOL)`
                };
            }

            console.log(`[JUPITER] Attempt ${attempt}/${MAX_RETRIES} - Balance: ${balance.toFixed(4)} SOL`);

            const lamports = Math.floor(solAmount * 1e9);

            // Step 1: Get quote
            const quoteUrl = `${JUPITER_QUOTE_API}?inputMint=${SOL_MINT}&outputMint=${tokenMint}&amount=${lamports}&slippageBps=${BUY_SLIPPAGE}`;

            const quoteResponse = await fetch(quoteUrl);
            const quoteData = await quoteResponse.json();

            if (quoteData.error) {
                throw new Error(`Quote error: ${quoteData.error}`);
            }

            const tokensOut = quoteData.outAmount;
            console.log(`[JUPITER] Quote: ${solAmount} SOL -> ${tokensOut} tokens`);

            // Step 2: Get swap transaction with priority fee
            const swapResponse = await fetch(JUPITER_SWAP_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: keypair.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        priorityLevelWithMaxLamports: {
                            maxLamports: 1000000,
                            priorityLevel: "high"
                        }
                    }
                })
            });

            const swapData = await swapResponse.json();

            if (swapData.error) {
                throw new Error(`Swap error: ${swapData.error}`);
            }

            // Step 3: Deserialize and sign transaction
            const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([keypair]);

            // Step 4: Send transaction (skipPreflight=true for speed)
            console.log(`[JUPITER] Sending transaction...`);
            const signature = await connection.sendTransaction(transaction, {
                skipPreflight: true,
                maxRetries: 5,
                preflightCommitment: 'processed'
            });

            console.log(`[JUPITER] TX sent: ${signature}`);

            // Step 5: Confirm transaction
            const confirmation = await connection.confirmTransaction({
                signature: signature,
                blockhash: transaction.message.recentBlockhash,
                lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log(`[JUPITER] BUY SUCCESS: ${signature}`);

            return {
                success: true,
                signature: signature,
                tokensReceived: tokensOut,
                solSpent: solAmount,
                txUrl: `https://solscan.io/tx/${signature}`
            };

        } catch (error) {
            lastError = error;
            console.error(`[JUPITER] Attempt ${attempt} failed:`, error.message);

            if (attempt < MAX_RETRIES) {
                console.log(`[JUPITER] Retrying in 2 seconds...`);
                await sleep(2000);
            }
        }
    }

    return {
        success: false,
        error: lastError?.message || 'Unknown error after all retries'
    };
}

// Sell token with retry logic - HARDCODED 55% slippage for volatile memecoins
async function sellToken(userId, tokenMint, tokenAmount) {
    const SELL_SLIPPAGE = 5500; // 55% slippage for selling
    console.log(`[JUPITER] Selling ${tokenAmount} of ${tokenMint} (slippage: 55%)`);

    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const keypair = getTradingKeypair();

            console.log(`[JUPITER] Sell attempt ${attempt}/${MAX_RETRIES}`);

            // Step 1: Get quote (token -> SOL)
            const quoteUrl = `${JUPITER_QUOTE_API}?inputMint=${tokenMint}&outputMint=${SOL_MINT}&amount=${tokenAmount}&slippageBps=${SELL_SLIPPAGE}`;

            const quoteResponse = await fetch(quoteUrl);
            const quoteData = await quoteResponse.json();

            if (quoteData.error) {
                throw new Error(`Quote error: ${quoteData.error}`);
            }

            const solOut = quoteData.outAmount;
            console.log(`[JUPITER] Quote: ${tokenAmount} tokens -> ${solOut / 1e9} SOL`);

            // Step 2: Get swap transaction
            const swapResponse = await fetch(JUPITER_SWAP_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quoteData,
                    userPublicKey: keypair.publicKey.toString(),
                    wrapAndUnwrapSol: true,
                    dynamicComputeUnitLimit: true,
                    prioritizationFeeLamports: {
                        priorityLevelWithMaxLamports: {
                            maxLamports: 1000000,
                            priorityLevel: "high"
                        }
                    }
                })
            });

            const swapData = await swapResponse.json();

            if (swapData.error) {
                throw new Error(`Swap error: ${swapData.error}`);
            }

            // Step 3: Sign and send
            const swapTransactionBuf = Buffer.from(swapData.swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
            transaction.sign([keypair]);

            console.log(`[JUPITER] Sending sell transaction...`);
            const signature = await connection.sendTransaction(transaction, {
                skipPreflight: true,
                maxRetries: 5,
                preflightCommitment: 'processed'
            });

            console.log(`[JUPITER] TX sent: ${signature}`);

            // Confirm
            const confirmation = await connection.confirmTransaction({
                signature: signature,
                blockhash: transaction.message.recentBlockhash,
                lastValidBlockHeight: (await connection.getLatestBlockhash()).lastValidBlockHeight
            }, 'confirmed');

            if (confirmation.value.err) {
                throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
            }

            console.log(`[JUPITER] SELL SUCCESS: ${signature}`);

            return {
                success: true,
                signature: signature,
                solReceived: solOut,
                txUrl: `https://solscan.io/tx/${signature}`
            };

        } catch (error) {
            lastError = error;
            console.error(`[JUPITER] Sell attempt ${attempt} failed:`, error.message);

            if (attempt < MAX_RETRIES) {
                console.log(`[JUPITER] Retrying in 2 seconds...`);
                await sleep(2000);
            }
        }
    }

    return {
        success: false,
        error: lastError?.message || 'Unknown error after all retries'
    };
}

module.exports = {
    buyToken,
    sellToken,
    getWalletBalance,
    getTradingKeypair
};
