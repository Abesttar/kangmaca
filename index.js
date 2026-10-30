const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ==========================================
// 1. SETUP GEMINI AI 
// ==========================================
require('dotenv').config();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); 
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });
const chatMemories = new Map(); 

// ==========================================
// 2. SETUP WEB SERVER & DATABASE LOKAL
// ==========================================
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

app.get('/api/leaderboard', (req, res) => res.json(readDB().users.sort((a, b) => b.poin - a.poin)));
app.get('/api/stats', (req, res) => {
    const db = readDB();
    res.json({ totalPelajar: db.users.length, totalBuku: db.reports.length, totalPoin: db.users.reduce((acc, curr) => acc + curr.poin, 0) });
});

// --- PERBAIKAN API REPORTS (MENGGABUNGKAN DATA NAMA USER & SEKOLAH) ---
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

// --- PEMISAHAN LOGIKA AUTH: /api/register & /api/login ---
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

// --- ENDPOINT LAPOR (ANTI-KECURANGAN 100%) ---
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
// 3. WHATSAPP BOT INTEGRATION
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
    }
});

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('ready', () => {
    console.log('✅ BOT KANG MACA & WEB SERVER AKTIF BERSAMAAN!');
    
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
                    const targetWA = user.noWA.includes('@c.us') ? user.noWA : `${user.noWA}@c.us`;
                    await client.sendMessage(targetWA, `Halo *${user.nama}*, Kang Maca kangen nih! 🥺\nUdah seminggu lebih kamu belum lapor bacaan. Lagi sibuk nugas atau butuh rekomendasi buku santai? Balas pesan ini aja ya! 📚✨`);
                } catch(e) { console.log(`Gagal kirim reminder ke: ${user.nama}`); }
            }
        }
    }, 24 * 60 * 60 * 1000);
});

client.on('message', async message => {
    const teksMasuk = message.body.trim().toLowerCase();
    const chatID = message.from;

    if (teksMasuk === '/lapor') {
        return message.reply(`Wih, mantap! 🎉\nLangsung aja klaim *50 Poin* kamu dengan isi form laporan di website resmi kita:\n🌐 http://localhost:3000\n\nKumpulkan poinnya dan jadilah Legend! 👑`);
    }

    if (teksMasuk === '/reset') {
        chatMemories.delete(chatID);
        return message.reply('Sip, ingatan Akang tentang obrolan kita udah direset! Ada yang mau diceritain dari awal? ✌️');
    }

    if (teksMasuk === '/demo-reminder') {
        return message.reply(`Halo Sahabat Maca, Kang Maca kangen nih! 🥺\nUdah seminggu lebih kamu belum lapor bacaan. Lagi sibuk nugas atau butuh rekomendasi buku santai? Balas pesan ini aja ya! 📚✨\n\n_(Pesan ini adalah simulasi Notifikasi Proaktif 7-Hari)_`);
    }

    try {
        let chatObj = null;
        try {
            chatObj = await message.getChat();
            await chatObj.sendStateTyping();
        } catch (e1) {
            try {
                chatObj = await client.getChatById(chatID);
                await chatObj.sendStateTyping();
            } catch (e2) {}
        }
        
        let aiChatSession = chatMemories.get(chatID);
        if (!aiChatSession) {
            aiChatSession = model.startChat({
                history: [
                    {
                        role: "user",
                        parts: [{ text: `Halo, mulai sekarang kamu adalah 'Kang Maca', asisten literasi dari Jawa Barat yang ramah dan bergaya Gen-Z. 
                        
ATURAN WAJIB (SOP):
1. Dengarkan curhatan saya, validasi perasaan saya, dan berikan tanggapan yang hangat serta suportif.
2. Rekomendasikan 2-3 buku populer yang cocok dengan perasaanku.
3. ATURAN LINK E-BOOK: Jangan pernah menyuruh download aplikasi! Setiap buku wajib disertai tautan web lengkap dengan format persis seperti ini: https://bacagratis.com/search?q=[judul-buku-tanpa-spasi]. 
4. FORMAT PENULISAN: Setiap judul buku dan link-nya HARUS berada di baris baru (Enter dua kali) agar tidak menyatu dengan kalimat lain. Gunakan format list angka 1., 2., 3.
5. Selalu akhiri pesan dengan paragraf baru persis berbunyi: "> Kalau udah selesai baca bukunya, jangan lupa ketik */lapor* ya biar dapat poin literasi!". 

Jawab dengan santai dan gunakan emoji yang pas. Mengerti?` }]
                    },
                    {
                        role: "model",
                        parts: [{ text: "Siap, Sampurasun! Aku Kang Maca, siap dengerin curhatanmu dan ngasih rekomendasi e-book terbaik dari https://bacagratis.com/ buat nemenin harimu!\n\nJangan lupa ketik */lapor* ya kalau udah beres baca! 🚀📚" }]
                    }
                ]
            });
            chatMemories.set(chatID, aiChatSession);
        }

        const result = await aiChatSession.sendMessage(message.body);
        await message.reply(result.response.text());

    } catch (error) {
        console.error("Error Sistem AI:", error);
        await message.reply("Waduh, otak Akang lagi nge-blank dikit nih. Coba chat lagi bentar ya! 🙏");
    }
});

client.initialize();
app.listen(port, () => console.log(`🌐 Website Leaderboard aktif di http://localhost:${port}`));