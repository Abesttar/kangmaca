require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const GEMINI_MODEL = 'gemini-3.8-flash';
const chatMemories = new Map(); // { chatID: [ {role, parts}, ... ] }

// Helper: panggil Gemini API langsung via fetch (bukan SDK)
async function callGemini(history, userMessage) {
    const apiKey = process.env.GEMINI_API_KEY;
    const contents = [
        ...history,
        { role: 'user', parts: [{ text: userMessage }] }
    ];
    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20000), // timeout 20 detik
            body: JSON.stringify({ contents })
        }
    );
    if (!response.ok) {
        const err = await response.json();
        throw new Error(`Gemini error ${response.status}: ${JSON.stringify(err)}`);
    }
    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!replyText) throw new Error('Gemini tidak mengembalikan teks');
    return replyText;
}

// ==========================================
// 2. SETUP WEB SERVER & DATABASE LOKAL
// ==========================================
let latestQR = null;      // simpan QR string terbaru
let botConnected = false;  // status koneksi bot
const app = express();
const port = process.env.PORT || 3000;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = './public/uploads';
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

function readDB() {
    if (!fs.existsSync('database.json')) fs.writeFileSync('database.json', JSON.stringify({ users: [], reports: [] }));
    return JSON.parse(fs.readFileSync('database.json', 'utf8'));
}
function writeDB(data) { fs.writeFileSync('database.json', JSON.stringify(data, null, 2)); }

function getBadge(poin) {
    if (poin >= 500) return { badge: "Legend 👑", warna: "#8b5cf6" };
    if (poin >= 250) return { badge: "Master 💎", warna: "#ec4899" };
    if (poin >= 150) return { badge: "Scholar 🎓", warna: "#3b82f6" };
    if (poin >= 50)  return { badge: "Reader 📚", warna: "#10b981" };
    return { badge: "Beginner 🌱", warna: "#64748b" };
}

// Endpoint QR Code — buka di browser untuk scan WhatsApp
app.get('/qr', async (req, res) => {
    if (botConnected) {
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Kang Maca Bot</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff">
            <h2>✅ Bot Sudah Terhubung!</h2><p>WhatsApp bot Kang Maca sudah aktif dan berjalan.</p></body></html>`);
    }
    if (!latestQR) {
        return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3"><title>Kang Maca QR</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f172a;color:#fff">
            <h2>⏳ QR Code sedang disiapkan...</h2><p>Halaman ini otomatis refresh dalam 3 detik.</p></body></html>`);
    }
    try {
        const qrImageUrl = await QRCode.toDataURL(latestQR, { width: 400, margin: 2 });
        res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="refresh" content="30">
    <title>Scan QR - Kang Maca Bot</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background: #0f172a; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .card { background: #1e293b; border-radius: 20px; padding: 40px; box-shadow: 0 20px 60px rgba(0,0,0,0.5); text-align: center; max-width: 460px; }
        h1 { font-size: 1.8rem; margin-bottom: 8px; }
        p { color: #94a3b8; margin-bottom: 24px; }
        img { border-radius: 12px; border: 4px solid #22d3ee; width: 320px; height: 320px; }
        .badge { background: #0ea5e9; color: #fff; padding: 6px 16px; border-radius: 999px; font-size: 0.85rem; margin-top: 20px; display: inline-block; }
        .step { background: #0f172a; border-radius: 10px; padding: 12px 16px; margin-top: 16px; text-align: left; font-size: 0.9rem; color: #cbd5e1; }
    </style>
</head>
<body>
    <div class="card">
        <h1>📱 Kang Maca Bot</h1>
        <p>Scan QR Code ini dengan WhatsApp kamu</p>
        <img src="${qrImageUrl}" alt="QR Code WhatsApp" />
        <div class="step">1️⃣ Buka WhatsApp di HP kamu<br>2️⃣ Ketuk ⋮ → Perangkat Tertaut<br>3️⃣ Ketuk "Tautkan Perangkat"<br>4️⃣ Scan QR di atas</div>
        <div class="badge">⏱ QR otomatis refresh tiap 30 detik</div>
    </div>
</body>
</html>`);
    } catch (e) {
        res.status(500).send('Error generating QR');
    }
});

app.get('/api/leaderboard', (req, res) => res.json(readDB().users.sort((a, b) => b.poin - a.poin)));
app.get('/api/stats', (req, res) => {
    const db = readDB();
    res.json({ totalPelajar: db.users.length, totalBuku: db.reports.length, totalPoin: db.users.reduce((acc, curr) => acc + curr.poin, 0) });
});

// Endpoint cek model Gemini yang tersedia (untuk debugging)
app.get('/models', async (req, res) => {
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        if (data.models) {
            const geminiModels = data.models
                .filter(m => m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => m.name.replace('models/', ''));
            res.json({ available: geminiModels, current: 'gemini-3.8-flash' });
        } else {
            res.json({ error: data });
        }
    } catch (e) {
        res.json({ error: e.message });
    }
});

app.get('/api/reports', (req, res) => {
    const db = readDB();
    const enrichedReports = db.reports.slice(-5).reverse().map(r => {
        const user = db.users.find(u => u.id === r.userId);
        return {
            ...r,
            namaUser: user ? user.nama : "Pelajar Jabar",
            sekolah: user ? user.sekolah : "Sekolah Umum"
        };
    });
    res.json(enrichedReports);
});

app.post('/api/register', (req, res) => {
    const { nama, sekolah, noWA, pin } = req.body;
    if (!nama || !sekolah || !noWA || !pin) {
        return res.status(400).json({ success: false, message: "Semua kolom wajib diisi!" });
    }

    let cleanWA = noWA.replace(/\D/g, '');
    if (cleanWA.startsWith('0')) cleanWA = '62' + cleanWA.slice(1);

    const db = readDB();
    const existingUser = db.users.find(u => {
        let dbWA = String(u.noWA).replace(/\D/g, '');
        if (dbWA.startsWith('0')) dbWA = '62' + dbWA.slice(1);
        return dbWA === cleanWA;
    });

    if (existingUser) {
        return res.status(400).json({ success: false, message: "Nomor WhatsApp ini sudah terdaftar! Silakan gunakan menu Login." });
    }

    const b = getBadge(0);
    const newUser = {
        id: Date.now().toString(),
        noWA: cleanWA,
        pin,
        nama,
        sekolah,
        poin: 0,
        badge: b.badge,
        warnaBadge: b.warna,
        waktuDaftar: new Date().toISOString()
    };

    db.users.push(newUser);
    writeDB(db);
    res.json({ success: true, message: "Pendaftaran berhasil! Silakan masuk.", user: newUser });
});

app.post('/api/login', (req, res) => {
    const { noWA, pin } = req.body;
    if (!noWA || !pin) {
        return res.status(400).json({ success: false, message: "Nomor WhatsApp dan PIN wajib diisi!" });
    }

    let cleanWA = noWA.replace(/\D/g, '');
    if (cleanWA.startsWith('0')) cleanWA = '62' + cleanWA.slice(1);

    const db = readDB();
    const user = db.users.find(u => {
        let dbWA = String(u.noWA).replace(/\D/g, '');
        if (dbWA.startsWith('0')) dbWA = '62' + dbWA.slice(1);
        return dbWA === cleanWA;
    });

    if (!user) {
        return res.status(404).json({ success: false, message: "Nomor WhatsApp belum terdaftar! Silakan daftar terlebih dahulu." });
    }

    if (user.pin !== pin) {
        return res.status(401).json({ success: false, message: "PIN yang Anda masukkan salah!" });
    }

    res.json({ success: true, message: "Login berhasil!", user });
});

app.post('/api/lapor', upload.single('fotoBukti'), (req, res) => {
    const { userId, judul, penulis, resume } = req.body;
    const db = readDB();
    const user = db.users.find(u => u.id === userId);

    if (!user) return res.status(400).json({ success: false, message: "Sesi tidak valid. Silakan login kembali!" });
    if (!req.file) return res.status(400).json({ success: false, message: "Ditolak: Bukti screenshot/foto bacaan WAJIB diunggah!" });
    if (!resume || resume.trim().length < 150) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ success: false, message: "Ditolak: Resume terlalu singkat! Tulis minimal 150 karakter pemahaman aslimu." });
    }

    const userReports = db.reports.filter(r => r.userId === userId);
    if (userReports.length > 0) {
        const selisihJam = (new Date().getTime() - new Date(userReports[userReports.length - 1].timestamp).getTime()) / (1000 * 60 * 60);
        if (selisihJam < 12) {
            if (req.file) fs.unlinkSync(req.file.path);
            return res.status(400).json({ success: false, message: "Ditolak: Kamu baru saja melapor. Baca buku dengan teliti dan tunggu 12 jam lagi." });
        }
    }

    db.reports.push({ id: Date.now().toString(), userId, judul, penulis, resume: resume.trim(), fotoUrl: `/uploads/${req.file.filename}`, timestamp: new Date().toISOString() });
    user.poin += 50;
    const b = getBadge(user.poin);
    user.badge = b.badge; user.warnaBadge = b.warna;
    writeDB(db);
    res.json({ success: true, message: "Laporan valid! +50 XP literasi berhasil ditambahkan.", user });
});

// ==========================================
// 3. WHATSAPP BOT - BAILEYS (TANPA CHROME!)
// ==========================================

// Simpan referensi socket untuk dipakai reminder
let waSocket = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');

    const sock = makeWASocket({
        version: [2, 3000, 1015901307], // versi statis, tidak perlu fetch
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
    });

    waSocket = sock;

    // Handle status koneksi & QR
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            latestQR = qr;      // simpan QR ke memori
            botConnected = false;
            console.log('📱 QR siap! Buka URL website kamu + /qr untuk scan. Contoh: https://sienna-donkey-164097.hostingersite.com/qr');
        }

        if (connection === 'close') {
            botConnected = false;
            latestQR = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Koneksi terputus, reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            }
        }

        if (connection === 'open') {
            botConnected = true;
            latestQR = null;    // hapus QR setelah login
            console.log('✅ BOT KANG MACA AKTIF! WhatsApp berhasil terhubung.');
            startReminderJob(sock);
        }
    });

    // Simpan credentials saat update
    sock.ev.on('creds.update', saveCreds);

    // Handle pesan masuk
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        console.log(`📨 messages.upsert event: type=${type}, count=${messages.length}`);

        for (const message of messages) {
            // Abaikan pesan dari bot sendiri atau broadcast
            if (message.key.fromMe) continue;
            if (message.key.remoteJid === 'status@broadcast') continue;

            const chatID = message.key.remoteJid;

            // Baca teks dari semua format pesan Baileys
            const msg = message.message;
            const teksMasuk = (
                msg?.conversation ||
                msg?.extendedTextMessage?.text ||
                msg?.imageMessage?.caption ||
                msg?.videoMessage?.caption ||
                msg?.buttonsResponseMessage?.selectedDisplayText ||
                msg?.listResponseMessage?.title ||
                ''
            ).trim();

            console.log(`💬 Pesan dari ${chatID}: "${teksMasuk}" (type: ${type})`);

            if (!teksMasuk) continue;

            // Helper untuk balas pesan
            const reply = async (text) => {
                await sock.sendMessage(chatID, { text }, { quoted: message });
            };

            if (teksMasuk.toLowerCase() === '/lapor') {
                await reply(`Wih, mantap! 🎉\nLangsung aja klaim *50 Poin* kamu dengan isi form laporan di website resmi kita:\n🌐 ${process.env.APP_URL || 'https://kangmaca.up.railway.app'}\n\nKumpulkan poinnya dan jadilah Legend! 👑`);
                continue;
            }

            if (teksMasuk.toLowerCase() === '/reset') {
                chatMemories.delete(chatID);
                await reply('Sip, ingatan Akang tentang obrolan kita udah direset! Ada yang mau diceritain dari awal? ✌️');
                continue;
            }

            if (teksMasuk.toLowerCase() === '/demo-reminder') {
                await reply(`Halo Sahabat Maca, Kang Maca kangen nih! 🥺\nUdah seminggu lebih kamu belum lapor bacaan. Lagi sibuk nugas atau butuh rekomendasi buku santai? Balas pesan ini aja ya! 📚✨\n\n_(Pesan ini adalah simulasi Notifikasi Proaktif 7-Hari)_`);
                continue;
            }

            // AI Chat dengan memori
            try {
                // Tampilkan indikator mengetik
                await sock.sendPresenceUpdate('composing', chatID);

                // Ambil atau buat history percakapan
                let history = chatMemories.get(chatID);
                if (!history) {
                    // System prompt sebagai pesan pertama
                    history = [
                        {
                            role: 'user',
                            parts: [{ text: `Halo, mulai sekarang kamu adalah 'Kang Maca', asisten literasi dari Jawa Barat yang ramah dan bergaya Gen-Z.

ATURAN WAJIB (SOP):
1. Dengarkan curhatan saya, validasi perasaan saya, dan berikan tanggapan yang hangat serta suportif.
2. Rekomendasikan 2-3 buku populer yang cocok dengan perasaanku.
3. ATURAN LINK E-BOOK: Jangan pernah menyuruh download aplikasi! Setiap buku wajib disertai tautan web lengkap dengan format persis seperti ini: https://bacagratis.com/search?q=[judul-buku-tanpa-spasi].
4. FORMAT PENULISAN: Setiap judul buku dan link-nya HARUS berada di baris baru (Enter dua kali). Gunakan format list angka 1., 2., 3.
5. Selalu akhiri pesan dengan: "> Kalau udah selesai baca bukunya, jangan lupa ketik */lapor* ya biar dapat poin literasi!".

Jawab dengan santai dan gunakan emoji yang pas. Mengerti?` }]
                        },
                        {
                            role: 'model',
                            parts: [{ text: 'Siap, Sampurasun! Aku Kang Maca, siap dengerin curhatanmu dan ngasih rekomendasi e-book terbaik dari https://bacagratis.com/ buat nemenin harimu!\n\nJangan lupa ketik */lapor* ya kalau udah beres baca! 🚀📚' }]
                        }
                    ];
                    chatMemories.set(chatID, history);
                }

                console.log(`🤖 Mengirim ke Gemini: "${teksMasuk.substring(0, 50)}..."`);
                const aiReply = await callGemini(history, teksMasuk);
                console.log('✅ Gemini merespons!');

                // Simpan percakapan ke memori
                history.push({ role: 'user', parts: [{ text: teksMasuk }] });
                history.push({ role: 'model', parts: [{ text: aiReply }] });

                await reply(aiReply);

            } catch (error) {
                console.error("Error Sistem AI:", error);
                await reply("Waduh, otak Akang lagi nge-blank dikit nih. Coba chat lagi bentar ya! 🙏");
            }
        }
    });
}

// Reminder otomatis setiap 24 jam
function startReminderJob(sock) {
    setInterval(async () => {
        const db = readDB();
        const sekarang = new Date().getTime();

        for (const user of db.users) {
            const userReports = db.reports.filter(r => r.userId === user.id);
            let waktuTerakhir = userReports.length > 0
                ? new Date(userReports[userReports.length - 1].timestamp).getTime()
                : new Date(user.waktuDaftar || sekarang).getTime();

            const selisihHari = (sekarang - waktuTerakhir) / (1000 * 60 * 60 * 24);

            if (selisihHari >= 7) {
                try {
                    const targetWA = `${user.noWA}@s.whatsapp.net`;
                    await sock.sendMessage(targetWA, {
                        text: `Halo *${user.nama}*, Kang Maca kangen nih! 🥺\nUdah seminggu lebih kamu belum lapor bacaan. Lagi sibuk nugas atau butuh rekomendasi buku santai? Balas pesan ini aja ya! 📚✨`
                    });
                } catch (e) {
                    console.log(`Gagal kirim reminder ke: ${user.nama}`);
                }
            }
        }
    }, 24 * 60 * 60 * 1000);
}

// Jalankan bot dan web server
startBot().catch(err => console.error('Error starting bot:', err));
app.listen(port, () => console.log(`🌐 Website Leaderboard aktif di http://localhost:${port}`));