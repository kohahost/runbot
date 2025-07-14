const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
require("dotenv").config();

// =================================================================
// 1. KONFIGURASI DAN INISIALISASI
// =================================================================
const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const PI_NETWORK_PASSPHRASE = 'Pi Network';

// Ambil konfigurasi dari file .env
const SOURCE_MNEMONIC = process.env.SOURCE_MNEMONIC;
const SPONSOR_MNEMONIC = process.env.SPONSOR_MNEMONIC;
const RECIPIENT_ADDRESS = process.env.RECEIVER_ADDRESS;

// --- ⚙️ PENGATURAN PENTING ---
// Masukkan ID Saldo yang Anda dapatkan dari skrip find_balances.js
const BALANCE_ID_TO_CLAIM = "00000000........................................................";
// Kekuatan transaksi: berapa kali operasi diulang dalam 1 transaksi.
// Semakin tinggi, semakin kuat menembus jaringan sibuk, tapi fee lebih mahal. (1 - 50)
const OPERATION_COUNT = 25; 
const LOOP_INTERVAL_MS = 449; // Jeda antar percobaan dalam milidetik

// =================================================================
// 2. FUNGSI UTAMA (TOOLKIT)
// =================================================================

/**
 * Menghasilkan Keypair (public & secret) dari mnemonic.
 * @param {string} mnemonic - Seed phrase.
 * @returns {Promise<StellarSdk.Keypair>} Keypair object.
 */
async function getKeypair(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error("Mnemonic tidak valid.");
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

/**
 * Fungsi inti untuk mengklaim dan mengirim saldo terkunci menggunakan sponsor.
 * @param {StellarSdk.Keypair} sourceKeypair - Keypair pemilik saldo terkunci.
 * @param {StellarSdk.Keypair} sponsorKeypair - Keypair pembayar biaya.
 * @param {string} recipientAddress - Alamat tujuan.
 * @param {string} balanceId - ID dari saldo yang akan diklaim.
 * @returns {Promise<object>} Hasil submit transaksi.
 */
async function claimAndSend(sourceKeypair, sponsorKeypair, recipientAddress, balanceId) {
    // 1. Muat akun sponsor untuk mendapatkan sequence number dan membayar fee
    const sponsorAccount = await server.loadAccount(sponsorKeypair.publicKey());
    
    // 2. Dapatkan detail saldo terkunci untuk mengetahui jumlahnya
    const claimableBalance = await server.claimableBalances().claimableBalance(balanceId).call();
    if (!claimableBalance || !claimableBalance.amount) {
        throw new Error(`Saldo dengan ID ${balanceId} tidak ditemukan atau tidak valid.`);
    }
    const amountToSend = claimableBalance.amount;
    console.log(`✅ Ditemukan saldo ${amountToSend} PI dengan ID: ${balanceId}`);

    // 3. Bangun transaksi dengan sponsor
    const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
        fee: (100 * OPERATION_COUNT).toString(), // Fee disesuaikan dengan jumlah operasi
        networkPassphrase: PI_NETWORK_PASSPHRASE,
    });

    console.log(`🚀 Membangun transaksi dengan ${OPERATION_COUNT} operasi...`);
    // 4. Tambahkan operasi berulang kali untuk "kekuatan"
    for (let i = 0; i < OPERATION_COUNT; i++) {
        transaction
            // Operasi 1: Klaim saldo, sumbernya adalah dompet 'source'
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: balanceId,
                source: sourceKeypair.publicKey(), // PENTING: sumber operasi adalah pemilik saldo
            }))
            // Operasi 2: Kirim pembayaran, sumbernya juga dompet 'source'
            .addOperation(StellarSdk.Operation.payment({
                destination: recipientAddress,
                asset: StellarSdk.Asset.native(),
                amount: amountToSend,
                source: sourceKeypair.publicKey(), // PENTING: yang mengirim adalah pemilik saldo
            }));
    }
    
    const builtTx = transaction.setTimeout(30).build();

    // 5. Tandatangani transaksi dengan DUA kunci
    builtTx.sign(sponsorKeypair); // Sponsor tanda tangan untuk bayar fee
    builtTx.sign(sourceKeypair);  // Sumber tanda tangan untuk otorisasi klaim & kirim

    console.log("📡 Mengirimkan transaksi ke jaringan...");
    return server.submitTransaction(builtTx);
}

// =================================================================
// 3. LOGIKA UTAMA BOT
// =================================================================
async function runBot() {
    try {
        if (!SOURCE_MNEMONIC || !SPONSOR_MNEMONIC || !RECIPIENT_ADDRESS) {
            throw new Error("Harap lengkapi SOURCE_MNEMONIC, SPONSOR_MNEMONIC, dan RECEIVER_ADDRESS di .env");
        }
        if (!BALANCE_ID_TO_CLAIM.startsWith("00000000")) {
             throw new Error("Harap isi BALANCE_ID_TO_CLAIM dengan ID yang valid.");
        }

        console.log("Memulai bot klaim & kirim...");
        const sourceKeypair = await getKeypair(SOURCE_MNEMONIC);
        const sponsorKeypair = await getKeypair(SPONSOR_MNEMONIC);

        console.log("Dompet Sumber  :", sourceKeypair.publicKey());
        console.log("Dompet Sponsor :", sponsorKeypair.publicKey());
        console.log("Dompet Penerima:", RECIPIENT_ADDRESS);
        
        const result = await claimAndSend(sourceKeypair, sponsorKeypair, RECIPIENT_ADDRESS, BALANCE_ID_TO_CLAIM);

        console.log("\n🎉 Transaksi BERHASIL!");
        console.log("✅ Hash Transaksi:", result.hash);
        console.log(`🔗 Lihat di Explorer: https://api.mainnet.minepi.com/transactions/${result.hash}`);
        console.log("Bot akan berhenti karena tugas selesai.");

    } catch (e) {
        const errorCode = e.response?.data?.extras?.result_codes?.transaction;
        if (errorCode === 'tx_bad_seq') {
            console.warn("⚠️ BENTROK TRANSAKSI (tx_bad_seq): Jaringan sibuk atau bot lain menang. Mencoba lagi...");
        } else if (errorCode === 'tx_insufficient_balance') {
            console.error("❌ GAGAL: Saldo dompet SPONSOR tidak cukup untuk membayar biaya transaksi!");
            return; // Berhenti jika sponsor kehabisan dana
        } else {
            console.error("❌ Terjadi Error:", e.response?.data?.extras || e.message);
        }
        // Atur untuk mencoba lagi setelah jeda
        setTimeout(runBot, LOOP_INTERVAL_MS);
    }
}


// =================================================================
// 4. JALANKAN BOT
// =================================================================
runBot();