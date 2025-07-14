const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
require("dotenv").config();

const server = new StellarSdk.Server('https://api.mainnet.minepi.com');

/**
 * Menghasilkan public key dari mnemonic.
 * @param {string} mnemonic - Seed phrase dari dompet Pi.
 * @returns {Promise<string>} Public key (alamat dompet).
 */
async function getPublicKey(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) {
        throw new Error("Mnemonic (seed phrase) tidak valid.");
    }
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const derivationPath = "m/44'/314159'/0'";
    const { key } = ed25519.derivePath(derivationPath, seed.toString('hex'));
    const keypair = StellarSdk.Keypair.fromRawEd25519Seed(key);
    return keypair.publicKey();
}

/**
 * Menemukan semua saldo terkunci (claimable balances) untuk sebuah alamat dompet.
 * @param {string} publicKey - Alamat dompet yang akan diperiksa.
 * @returns {Promise<Array<object>>} Daftar saldo terkunci.
 */
async function findClaimableBalances(publicKey) {
    try {
        const response = await server.claimableBalances().claimant(publicKey).limit(20).call();
        return response.records;
    } catch (e) {
        console.error("Gagal mengambil claimable balances:", e);
        return [];
    }
}

async function main() {
    const sourceMnemonic = process.env.SOURCE_MNEMONIC;
    if (!sourceMnemonic) {
        console.error("❌ Harap atur SOURCE_MNEMONIC di file .env Anda.");
        return;
    }

    try {
        console.log("Mencari alamat dompet dari mnemonic...");
        const sourcePublicKey = await getPublicKey(sourceMnemonic);
        console.log("✅ Alamat Dompet Sumber:", sourcePublicKey);

        console.log("\n🔍 Mencari saldo terkunci untuk alamat ini...");
        const balances = await findClaimableBalances(sourcePublicKey);

        if (balances.length === 0) {
            console.log("\nℹ️ Tidak ada saldo terkunci yang ditemukan untuk dompet ini.");
        } else {
            console.log(`\n✅ Ditemukan ${balances.length} saldo terkunci:`);
            balances.forEach((balance, index) => {
                console.log(`\n--- Saldo #${index + 1} ---`);
                console.log(`   💰 Jumlah : ${balance.amount} PI`);
                console.log(`   🆔 ID     : ${balance.id}`); // Ini yang Anda butuhkan!
            });
            console.log("\n📋 Salin 'ID' dari saldo yang ingin Anda klaim dan masukkan ke skrip bot utama.");
        }
    } catch (error) {
        console.error("❌ Terjadi kesalahan:", error.message);
    }
}

main();