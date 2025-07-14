const StellarSdk = require('stellar-sdk');
const ed25519 = require('ed25519-hd-key');
const bip39 = require('bip39');
const inquirer = require('inquirer');
require("dotenv").config();

// =================================================================
// 1. KONFIGURASI DAN INISIALISASI
// =================================================================
const server = new StellarSdk.Server('https://api.mainnet.minepi.com');
const PI_NETWORK_PASSPHRASE = 'Pi Network';

// Variabel global untuk menyimpan data antar langkah
let availableBalances = [];
let sourceKeypair, sponsorKeypair;

// =================================================================
// 2. FUNGSI-FUNGSI UTAMA (TOOLKIT)
// =================================================================

async function getKeypair(mnemonic) {
    if (!bip39.validateMnemonic(mnemonic)) throw new Error(`Mnemonic tidak valid: "${mnemonic.slice(0, 10)}..."`);
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const { key } = ed25519.derivePath("m/44'/314159'/0'", seed.toString('hex'));
    return StellarSdk.Keypair.fromRawEd25519Seed(key);
}

async function findClaimableBalances(publicKey) {
    console.log("\n🔍 Mencari saldo terkunci untuk alamat:", publicKey);
    const response = await server.claimableBalances().claimant(publicKey).limit(200).call();
    return response.records;
}

async function claimAndSend(sourceKp, sponsorKp, recipientAddress, balanceId, operationCount) {
    const sponsorAccount = await server.loadAccount(sponsorKp.publicKey());
    const claimableBalance = await server.claimableBalances().claimableBalance(balanceId).call();
    
    if (!claimableBalance || !claimableBalance.amount) {
        throw new Error(`Saldo dengan ID ${balanceId} tidak ditemukan atau tidak valid.`);
    }
    const amountToSend = claimableBalance.amount;
    console.log(`✅ Ditemukan saldo ${amountToSend} PI.`);

    const baseFee = await server.fetchBaseFee();
    const transaction = new StellarSdk.TransactionBuilder(sponsorAccount, {
        fee: ((2 * operationCount) * parseInt(baseFee)).toString(),
        networkPassphrase: PI_NETWORK_PASSPHRASE,
    });

    console.log(`🚀 Membangun transaksi dengan ${operationCount} kekuatan...`);
    for (let i = 0; i < operationCount; i++) {
        transaction
            .addOperation(StellarSdk.Operation.claimClaimableBalance({
                balanceId: balanceId,
                source: sourceKp.publicKey(),
            }))
            .addOperation(StellarSdk.Operation.payment({
                destination: recipientAddress,
                asset: StellarSdk.Asset.native(),
                amount: amountToSend,
                source: sourceKp.publicKey(),
            }));
    }
    
    const builtTx = transaction.setTimeout(30).build();
    builtTx.sign(sponsorKp);
    builtTx.sign(sourceKp);

    console.log("📡 Mengirimkan transaksi ke jaringan...");
    return server.submitTransaction(builtTx);
}

// =================================================================
// 3. FUNGSI LOGIKA BOT (LOOPING)
// =================================================================

async function startTransferLoop(config) {
    const { sourceKp, sponsorKp, recipient, balanceId, operationCount, loopInterval } = config;
    let attempt = 0;

    const execute = async () => {
        attempt++;
        console.log(`\n--- Percobaan #${attempt} ---`);
        try {
            const result = await claimAndSend(sourceKp, sponsorKp, recipient, balanceId, operationCount);

            if (result && result.hash) {
                console.log("\n🎉 Transaksi BERHASIL dan TERKONFIRMASI!");
                console.log("✅ Hash:", result.hash);
                console.log(`🔗 Explorer: https://api.mainnet.minepi.com/transactions/${result.hash}`);
                console.log("Bot berhenti.");
                return; // Sukses, hentikan loop
            } else {
                console.warn("⚠️ Transaksi terkirim tapi konfirmasi hash tidak diterima. Mencoba lagi...");
                console.log("Detail Respons Server:", result);
                setTimeout(execute, loopInterval);
            }
        } catch (e) {
            const errorCode = e.response?.data?.extras?.result_codes?.transaction;
            if (errorCode === 'tx_bad_seq') {
                console.warn("⚠️ BENTROK (tx_bad_seq): Jaringan sibuk. Mencoba lagi...");
            } else if (errorCode === 'tx_insufficient_balance') {
                console.error("❌ GAGAL TOTAL: Saldo dompet SPONSOR tidak cukup! Bot berhenti.");
                return; // Gagal total, hentikan loop
            } else {
                const errorMessage = e.response?.data?.extras || e.response?.data || e.message;
                console.error("❌ Error:", JSON.stringify(errorMessage, null, 2));
            }
            console.log(`Mencoba lagi dalam ${loopInterval / 1000} detik...`);
            setTimeout(execute, loopInterval);
        }
    };
    
    await execute();
}

// =================================================================
// 4. ALUR KERJA INTERAKTIF
// =================================================================

async function step1_viewBalances() {
    const answers = await inquirer.prompt([
        {
            type: 'password',
            name: 'mnemonic',
            message: 'Masukkan Mnemonic DOMPET SUMBER (yang memiliki saldo terkunci):',
            mask: '*',
            default: process.env.SOURCE_MNEMONIC || '',
            validate: input => bip39.validateMnemonic(input) || 'Mnemonic tidak valid. Silakan periksa kembali.',
        },
    ]);

    try {
        sourceKeypair = await getKeypair(answers.mnemonic);
        availableBalances = await findClaimableBalances(sourceKeypair.publicKey());

        if (availableBalances.length === 0) {
            console.log("\nℹ️ Tidak ada saldo terkunci yang ditemukan untuk dompet ini.");
            return false; // Gagal, tidak ada saldo
        } else {
            console.log(`\n✅ Ditemukan ${availableBalances.length} saldo terkunci:`);
            availableBalances.forEach((balance, index) => {
                console.log(`   [${index + 1}] ${balance.amount} PI (ID: ${balance.id.slice(0, 15)}...)`);
            });
            return true; // Sukses, ada saldo
        }
    } catch (error) {
        console.error("\n❌ Gagal mengambil data:", error.message);
        return false;
    }
}

async function step2_transferConfig() {
    const balanceChoices = availableBalances.map((b, i) => ({
        name: `${b.amount} PI (ID: ${b.id.slice(0, 20)}...)`,
        value: b.id
    }));

    const answers = await inquirer.prompt([
        {
            type: 'list',
            name: 'balanceId',
            message: 'Pilih Saldo Terkunci yang akan dikirim:',
            choices: balanceChoices,
        },
        {
            type: 'password',
            name: 'sponsorMnemonic',
            message: 'Masukkan Mnemonic DOMPET SPONSOR (yang membayar fee):',
            mask: '*',
            default: process.env.SPONSOR_MNEMONIC || '',
            validate: input => bip39.validateMnemonic(input) || 'Mnemonic tidak valid. Silakan periksa kembali.',
        },
        {
            type: 'input',
            name: 'recipient',
            message: 'Masukkan Alamat Dompet PENERIMA:',
            default: process.env.RECIPIENT_ADDRESS || '',
            validate: input => StellarSdk.StrKey.isValidEd25519PublicKey(input) || 'Alamat dompet penerima tidak valid.',
        },
        {
            type: 'input',
            name: 'operationCount',
            message: 'Masukkan Kekuatan Transaksi (1-50):',
            default: 25,
            validate: val => (parseInt(val) > 0 && parseInt(val) <= 50) || 'Masukkan angka antara 1 dan 50.',
            filter: Number,
        },
        {
            type: 'input',
            name: 'schedule',
            message: 'Jadwalkan transfer (biarkan kosong untuk sekarang) (YYYY-MM-DDTHH:mm):'
        }
    ]);

    try {
        sponsorKeypair = await getKeypair(answers.sponsorMnemonic);
    } catch (error) {
        console.error("\n❌ Mnemonic Sponsor tidak valid:", error.message);
        return; // Hentikan proses
    }

    const config = {
        sourceKp: sourceKeypair,
        sponsorKp: sponsorKeypair,
        recipient: answers.recipient,
        balanceId: answers.balanceId,
        operationCount: answers.operationCount,
        loopInterval: 1000,
    };

    if (answers.schedule) {
        const scheduledDate = new Date(answers.schedule);
        const now = new Date();
        const delay = scheduledDate.getTime() - now.getTime();

        if (delay <= 0) {
            console.log("⚠️ Waktu jadwal sudah lewat. Memulai transfer sekarang...");
            await startTransferLoop(config);
        } else {
            console.log(`✅ Transfer dijadwalkan untuk: ${scheduledDate.toLocaleString('id-ID')}`);
            console.log(`Bot akan mulai dalam ${Math.round(delay / 1000 / 60)} menit.`);
            setTimeout(() => {
                console.log("\n⏰ Waktu jadwal telah tiba! Memulai proses transfer...");
                startTransferLoop(config);
            }, delay);
        }
    } else {
        await startTransferLoop(config);
    }
}


async function mainMenu() {
    console.clear();
    console.log("======================================");
    console.log("  PI NETWORK - CLAIM & TRANSFER BOT   ");
    console.log("======================================");

    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Pilih tindakan yang ingin Anda lakukan:',
            choices: [
                { name: '1. Lihat Saldo Terkunci & Lanjutkan ke Transfer', value: 'transfer' },
                { name: '2. Keluar', value: 'exit' },
            ],
        },
    ]);

    if (action === 'transfer') {
        const hasBalances = await step1_viewBalances();
        if (hasBalances) {
            await step2_transferConfig();
        } else {
            console.log("\nProses dihentikan karena tidak ada saldo yang bisa ditransfer.");
            // Beri kesempatan untuk kembali ke menu utama atau keluar
        }
    } else {
        console.log("Terima kasih telah menggunakan bot ini. Sampai jumpa!");
        process.exit(0);
    }
}

// =================================================================
// 5. JALANKAN BOT
// =================================================================
mainMenu();
