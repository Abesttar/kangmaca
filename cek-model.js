require('dotenv').config();
const API_KEY = process.env.GEMINI_API_KEY;

async function cekModel() {
    try {
        console.log("🔍 Mengecek daftar model ke server Google AI...");
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${API_KEY}`);
        const data = await response.json();
        
        if (data.models) {
            console.log("\n✅ BERHASIL! Ini daftar model Gemini yang aktif untuk API Key Anda:");
            data.models.forEach(m => {
                // Kita filter hanya yang berhubungan dengan Gemini dan bisa untuk "generateContent"
                if (m.name.includes("gemini") && m.supportedGenerationMethods.includes("generateContent")) {
                    console.log("👉 " + m.name.replace('models/', ''));
                }
            });
            console.log("\nCatat salah satu nama di atas, lalu masukkan ke dalam file index.js Anda!");
        } else {
            console.log("❌ Error dari Google:", data);
        }
    } catch (error) {
        console.error("Gagal mengecek:", error);
    }
}

cekModel();