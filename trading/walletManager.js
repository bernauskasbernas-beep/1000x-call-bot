const { Keypair, Connection, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");
const bs58 = require("bs58").default;
const fs = require("fs");

const path = require('path');
const WALLETS_FILE = path.join(__dirname, '../data/user_wallets.json');
const RPC_URL = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// Load/save wallet mappings
function loadWallets() {
    try {
        return JSON.parse(fs.readFileSync(WALLETS_FILE, "utf8"));
    } catch (e) {
        return {};
    }
}

function saveWallets(wallets) {
    fs.writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

// Generate unique wallet for user
function generateWalletForUser(userId) {
    const keypair = Keypair.generate();
    const publicKey = keypair.publicKey.toString();
    const privateKey = bs58.encode(keypair.secretKey);
    
    const wallets = loadWallets();
    wallets[userId] = {
        publicKey: publicKey,
        privateKey: privateKey, // ENCRYPTED in production!
        createdAt: Date.now()
    };
    saveWallets(wallets);
    
    console.log(`✅ Generated wallet for user ${userId}: ${publicKey}`);
    return { publicKey, privateKey };
}

// Get user wallet (or create if doesnt exist)
function getUserWallet(userId) {
    const wallets = loadWallets();
    
    if (!wallets[userId]) {
        return generateWalletForUser(userId);
    }
    
    return wallets[userId];
}

// Get user keypair
function getUserKeypair(userId) {
    const wallet = getUserWallet(userId);
    const secretKey = bs58.decode(wallet.privateKey);
    return Keypair.fromSecretKey(secretKey);
}

// Check wallet balance
async function getWalletBalance(publicKey) {
    try {
        const balance = await connection.getBalance(new PublicKey(publicKey));
        return balance / 1e9; // Convert lamports to SOL
    } catch (e) {
        console.error("Error getting balance:", e.message);
        return 0;
    }
}

// Monitor deposits for a user wallet
async function checkForDeposit(userId, expectedAmount = null) {
    const wallet = getUserWallet(userId);
    const balance = await getWalletBalance(wallet.publicKey);
    
    console.log(`💰 User ${userId} wallet balance: ${balance} SOL`);
    
    // If checking for specific amount
    if (expectedAmount && balance >= expectedAmount) {
        return { detected: true, amount: balance };
    }
    
    return { detected: balance > 0, amount: balance };
}

// Withdraw from user wallet to external address
async function withdrawFromUserWallet(userId, toAddress, amount) {
    try {
        const keypair = getUserKeypair(userId);
        const fromPubkey = keypair.publicKey;
        const toPubkey = new PublicKey(toAddress);
        
        // Create transaction
        const transaction = new Transaction().add(
            SystemProgram.transfer({
                fromPubkey: fromPubkey,
                toPubkey: toPubkey,
                lamports: Math.floor(amount * 1e9)
            })
        );
        
        // Get recent blockhash
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = fromPubkey;
        
        // Sign and send
        transaction.sign(keypair);
        const signature = await connection.sendRawTransaction(transaction.serialize());
        await connection.confirmTransaction(signature);
        
        console.log(`✅ Withdraw success: ${signature}`);
        return { success: true, signature };
        
    } catch (error) {
        console.error("Withdraw failed:", error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    generateWalletForUser,
    getUserWallet,
    getUserKeypair,
    getWalletBalance,
    checkForDeposit,
    withdrawFromUserWallet
};
