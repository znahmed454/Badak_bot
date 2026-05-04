require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════╗
// ║              W A  K I C K E R  B O T  v3.0                  ║
// ║         Bot WA Kick Berbayar dengan Sistem Trial             ║
// ╚══════════════════════════════════════════════════════════════╝

// ──────────────────────────────────────────────────────────────
//  KONFIGURASI DARI ENV
// ──────────────────────────────────────────────────────────────

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di .env!');
    process.exit(1);
}

// Admin IDs dari env, pisah koma
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

if (ADMIN_IDS.length === 0) {
    console.error('❌ ADMIN_IDS tidak ditemukan atau tidak valid di .env!');
    process.exit(1);
}

const BOT_NAME             = process.env.BOT_NAME || '⚡ WA Kicker Bot';
const PAYMENT_BANK_NAME    = process.env.PAYMENT_BANK_NAME   || 'BCA';
const PAYMENT_BANK_NUMBER  = process.env.PAYMENT_BANK_NUMBER || '1234567890';
const PAYMENT_BANK_HOLDER  = process.env.PAYMENT_BANK_HOLDER || 'Bot Owner';
const PAYMENT_GOPAY        = process.env.PAYMENT_GOPAY       || '081234567890';
const PAYMENT_CONTACT      = process.env.PAYMENT_CONTACT     || '@adminusername';
const TRIAL_DURATION_HOURS = parseInt(process.env.TRIAL_DURATION_HOURS || '24');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 GoPay/OVO: ${PAYMENT_GOPAY}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') },
};

// File penyimpanan data
const DATA_FILE        = './bot_users.json';
const AUTH_BASE_FOLDER = './auth_states';

// ──────────────────────────────────────────────────────────────

const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions  = new Map();
const kickSelections = new Map();

if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

// ══════════════════════════════════════════════════════════════
//  MANAJEMEN DATA USER
// ══════════════════════════════════════════════════════════════

function loadData() {
    if (!fs.existsSync(DATA_FILE)) {
        const init = { users: [], pending: [], pendingPayment: [] };
        fs.writeFileSync(DATA_FILE, JSON.stringify(init, null, 2));
        return init;
    }
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        if (!raw.users && raw.approved) {
            raw.users = raw.approved.map(u => ({
                ...u, role: 'regular', expiresAt: null, hadTrial: true
            }));
            delete raw.approved;
        }
        raw.users          = raw.users          || [];
        raw.pending        = raw.pending        || [];
        raw.pendingPayment = raw.pendingPayment || [];
        return raw;
    } catch {
        return { users: [], pending: [], pendingPayment: [] };
    }
}

function saveData(data) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── ROLE CHECKS ──────────────────────────────────────────────

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function getUser(userId) {
    if (isAdmin(userId)) return { id: userId, role: 'admin', status: 'active' };
    const data = loadData();
    return (data.users || []).find(u => u.id === userId) || null;
}

function getUserStatus(userId) {
    if (isAdmin(userId)) return 'admin';
    const u = getUser(userId);
    if (!u) return 'none';
    if (u.role === 'regular') {
        return new Date(u.expiresAt) > new Date() ? 'regular' : 'expired';
    }
    if (u.role === 'trial') {
        return new Date(u.trialExpiresAt) > new Date() ? 'trial' : 'trial_expired';
    }
    return 'none';
}

function canUseBot(userId) {
    return ['admin', 'regular', 'trial'].includes(getUserStatus(userId));
}

function isTrialOnly(userId) {
    return getUserStatus(userId) === 'trial';
}

// ── TRIAL ────────────────────────────────────────────────────

function startTrial(user) {
    const data = loadData();
    const existing = data.users.find(u => u.id === user.id);
    if (existing) return { success: false, reason: 'already_user', user: existing };

    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) return { success: false, reason: 'used_trial' };

    const now = new Date();
    const exp = new Date(now.getTime() + TRIAL_DURATION_HOURS * 60 * 60 * 1000);
    const newUser = {
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        role: 'trial',
        trialStartedAt: now.toISOString(),
        trialExpiresAt: exp.toISOString(),
        hadTrial: true,
        createdAt: now.toISOString()
    };
    data.users.push(newUser);
    saveData(data);
    return { success: true, user: newUser, expiresAt: exp };
}

// ── PENDING PAYMENT ──────────────────────────────────────────

function addPendingPayment(user, packageKey) {
    const data = loadData();
    data.pendingPayment = data.pendingPayment.filter(p => p.id !== user.id);
    data.pendingPayment.push({
        id: user.id,
        username: user.username || null,
        firstName: user.first_name || '',
        lastName: user.last_name || '',
        packageKey,
        requestedAt: new Date().toISOString()
    });
    saveData(data);
}

function getPendingPayment(userId) {
    return loadData().pendingPayment.find(p => p.id === userId) || null;
}

// ── APPROVE PAYMENT ──────────────────────────────────────────

function approvePayment(userId, packageKey) {
    const data = loadData();
    const pkg  = PACKAGES[packageKey];
    if (!pkg) return { success: false, reason: 'invalid_package' };

    const pendIdx = data.pendingPayment.findIndex(p => p.id === userId);
    let userInfo  = pendIdx >= 0 ? data.pendingPayment.splice(pendIdx, 1)[0] : null;

    const now = new Date();
    let expiresAt;

    const existingIdx = data.users.findIndex(u => u.id === userId);
    if (existingIdx >= 0) {
        const existing = data.users[existingIdx];
        const base = existing.expiresAt && new Date(existing.expiresAt) > now
            ? new Date(existing.expiresAt)
            : now;
        expiresAt = new Date(base.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        data.users[existingIdx] = {
            ...existing,
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            updatedAt: now.toISOString()
        };
    } else {
        expiresAt = new Date(now.getTime() + pkg.days * 24 * 60 * 60 * 1000);
        const src = userInfo || {};
        data.users.push({
            id: userId,
            username: src.username || null,
            firstName: src.firstName || '',
            lastName: src.lastName || '',
            role: 'regular',
            expiresAt: expiresAt.toISOString(),
            lastPackage: packageKey,
            hadTrial: true,
            createdAt: now.toISOString()
        });
    }

    saveData(data);
    return { success: true, expiresAt, pkg };
}

// ── REVOKE USER ──────────────────────────────────────────────

function revokeUser(userId) {
    const data = loadData();
    const idx  = data.users.findIndex(u => u.id === userId);
    if (idx === -1) return null;
    const [user] = data.users.splice(idx, 1);
    saveData(data);
    return user;
}

function getAllPendingPayments() { return loadData().pendingPayment || []; }
function getAllUsers()           { return loadData().users || []; }

// ══════════════════════════════════════════════════════════════
//  FORMATTING HELPERS
// ══════════════════════════════════════════════════════════════

function formatDate(isoStr) {
    if (!isoStr) return '-';
    return new Date(isoStr).toLocaleString('id-ID', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta'
    });
}

function formatCountdown(isoStr) {
    const ms = new Date(isoStr) - new Date();
    if (ms <= 0) return 'SUDAH EXPIRED';
    const hours = Math.floor(ms / 3600000);
    const mins  = Math.floor((ms % 3600000) / 60000);
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        return `${days} hari ${hours % 24} jam`;
    }
    return `${hours} jam ${mins} menit`;
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function esc(text) {
    if (!text) return '';
    return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
}

function userDisplayName(u) {
    const name  = [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama';
    const uname = u.username ? ` (@${u.username})` : '';
    return `${name}${uname}`;
}

function userDisplayNameEsc(u) {
    const name  = esc([u.firstName, u.lastName].filter(Boolean).join(' ') || 'Tanpa Nama');
    const uname = u.username ? ` (@${esc(u.username)})` : '';
    return `${name}${uname}`;
}

const DIVIDER      = '━━━━━━━━━━━━━━━━━━━━━━';
const DIVIDER_THIN = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';

// ══════════════════════════════════════════════════════════════
//  REPLY KEYBOARDS  ← FIX UTAMA: pakai .reply_markup langsung
// ══════════════════════════════════════════════════════════════

// Keyboard LANDING — user baru, belum punya akses
const KB_LANDING = {
    reply_markup: {
        keyboard: [
            [{ text: '🎁 Coba Gratis (Trial)' }, { text: '⭐ Premium' }],
            [{ text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// Keyboard PRE LOGIN — sudah punya akses, belum login WA
const KB_PRE_LOGIN = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📊 Status' }, { text: '👤 Akun Saya' }],
            [{ text: '⭐ Premium' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// Keyboard MAIN — sudah login WA
const KB_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
            [{ text: '🚪 Logout WhatsApp' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// Keyboard ADMIN sebelum login WA
const KB_ADMIN_PRE = {
    reply_markup: {
        keyboard: [
            [{ text: '🔑 Login WhatsApp' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '📊 Status' }, { text: '❓ Bantuan' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

// Keyboard ADMIN setelah login WA
const KB_ADMIN_MAIN = {
    reply_markup: {
        keyboard: [
            [{ text: '📋 Daftar Grup' }, { text: '🎯 Pilih Grup' }],
            [{ text: '➕ Buat Grup WA' }, { text: '📥 Import VCF' }],
            [{ text: '🔴 Kick Menu' }, { text: '📡 Status' }],
            [{ text: '📋 Pending Payment' }, { text: '👥 User List' }],
            [{ text: '🚪 Logout WhatsApp' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
    }
};

function getKeyboard(userId) {
    const loggedIn = userSessions.get(userId)?.loggedIn;
    if (isAdmin(userId))   return loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return loggedIn ? KB_MAIN : KB_PRE_LOGIN;
    return KB_LANDING;
}

// ══════════════════════════════════════════════════════════════
//  MIDDLEWARE: CEK AKSES
// ══════════════════════════════════════════════════════════════

async function requireAccess(ctx, next) {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (isAdmin(userId)) return next();
    const status = getUserStatus(userId);
    if (status === 'regular' || status === 'trial') return next();

    if (status === 'expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  AKSES BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Paket lo sudah expired.\nPerpanjang sekarang!\n\nKetik /beli untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    if (status === 'trial_expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  TRIAL BERAKHIR\n╚${DIVIDER}╝\n\n` +
            `Masa trial lo sudah habis.\nUpgrade ke paket reguler!\n\nKetik /beli untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }
    await ctx.reply(
        `╔${DIVIDER}╗\n║  AKSES DITOLAK\n╚${DIVIDER}╝\n\n` +
        `Bot ini berbayar.\n\n` +
        `🎁 Coba *gratis ${TRIAL_DURATION_HOURS} jam* → tekan tombol *Coba Gratis*\n` +
        `💳 Atau langsung beli paket → tekan *⭐ Premium*`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
}

// ══════════════════════════════════════════════════════════════
//  HELPERS WA
// ══════════════════════════════════════════════════════════════

async function sendQR(ctx, qr) {
    console.log(`[DEBUG] sendQR called, QR length: ${qr?.length || 0}`);
    
    if (!qr) {
        await ctx.reply(`❌ QR code kosong, coba lagi.`);
        return;
    }
    
    try {
        // PRIORITAS: Kirim sebagai GAMBAR
        const qrBuffer = await QRCode.toBuffer(qr, {
            type: 'png',
            width: 1024,  // Perbesar biar lebih jelas
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            },
            scale: 8  // Tambah skala biar lebih besar
        });
        
        await ctx.replyWithPhoto(
            { source: qrBuffer },
            {
                caption: `📱 *SCAN QR CODE DI WHATSAPP*\n\n` +
                         `1. Buka WhatsApp di HP\n` +
                         `2. Tap ⋮ (titik tiga) → *Perangkat Tertaut*\n` +
                         `3. Tap *Tautkan Perangkat*\n` +
                         `4. Scan QR code di atas`,
                parse_mode: 'Markdown'
            }
        );
        
        console.log(`[DEBUG] QR image sent successfully`);
        
        // Kirim teks sebagai backup (opsional)
        await ctx.reply(
            `⚠️ *Jika scan QR gambar gagal, gunakan kode di bawah:*\n\n` +
            `\`\`\`\n${qr}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
        
    } catch (err) {
        console.error(`[ERROR] Failed to send QR:`, err);
        
        // Fallback: Kirim sebagai teks biasa
        await ctx.reply(
            `📱 *SCAN QR CODE DI WHATSAPP*\n\n` +
            `1. Buka WhatsApp di HP\n` +
            `2. Tap ⋮ → *Perangkat Tertaut*\n` +
            `3. Tap *Tautkan Perangkat*\n` +
            `4. Scan QR di bawah (screenshot foto):\n\n` +
            `\`\`\`\n${qr}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
    }
}

async function startLogin(ctx, userId) {
    console.log(`[DEBUG] Starting login for user ${userId}`);
    
    if (userSessions.has(userId)) {
        console.log(`[DEBUG] Cleaning old session for ${userId}`);
        const old = userSessions.get(userId);
        if (old.qrTimer) clearTimeout(old.qrTimer);
        try { old.sock.end(new Error('restart')); } catch (_) {}
        userSessions.delete(userId);
    }

    const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
    console.log(`[DEBUG] Auth folder: ${authFolder}`);
    
    const { version } = await fetchLatestBaileysVersion();
    console.log(`[DEBUG] Using WA version: ${version}`);
 
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        // ✅ FIX 2: Pakai Chrome bukan Firefox
        browser: ['Ubuntu', 'Chrome', '120.0.0'],
        logger: pino({ level: 'silent' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        version,                          // ✅ versi otomatis
        // ❌ HAPUS: firefoxFix tidak ada
        generateHighQualityLinkPreview: false,
        printQRInTerminal: false,
    });
    console.log(`[DEBUG] Socket created`);

    const session = {
        sock, saveCreds,
        qrTimer: null, lastQR: null, qrBlocked: false,
        loggedIn: false, groupId: null, groupName: null, members: []
    };
    userSessions.set(userId, session);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        console.log(`[DEBUG] Connection update:`, { connection, hasQR: !!qr, lastDisconnect: !!lastDisconnect });

        if (qr) {
            console.log(`[DEBUG] QR received, length: ${qr.length}`);
            session.lastQR = qr;
            if (!session.qrBlocked) {
                session.qrBlocked = true;
                console.log(`[DEBUG] Sending QR to user ${userId}`);
                try {
                    await sendQR(ctx, qr);
                    console.log(`[DEBUG] QR sent successfully`);
                } catch (err) {
                    console.error(`[ERROR] Failed to send QR:`, err);
                    await ctx.reply(`❌ Gagal kirim QR: ${err.message}\n\nCoba periksa koneksi internet.`);
                }
                session.qrTimer = setTimeout(async () => {
                    if (!session.loggedIn) {
                        session.qrBlocked = false;
                        await ctx.reply(`⏱ *QR sudah expired.*\nKetik /refreshqr untuk QR baru.`, { parse_mode: 'Markdown' });
                    }
                }, 5 * 60 * 1000);
            }
        }

        if (connection === 'close') {
            console.log(`[DEBUG] Connection closed`);
            if (session.qrTimer) clearTimeout(session.qrTimer);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (!session.loggedIn) {
                const msg = statusCode === DisconnectReason.loggedOut
                    ? '🚫 Session ditolak WA. Ketik /login untuk coba lagi.'
                    : '🔌 Koneksi terputus. Ketik /login untuk coba lagi.';
                await ctx.reply(msg);
                userSessions.delete(userId);
            } else {
                await ctx.reply('⚠️ *Koneksi WA terputus.*\nTekan *🔑 Login WhatsApp* untuk reconnect.', { parse_mode: 'Markdown' });
                userSessions.delete(userId);
            }
        }

        if (connection === 'open') {
            console.log(`[DEBUG] Connection OPEN - Login successful for user ${userId}`);
            session.loggedIn = true;
            if (session.qrTimer) clearTimeout(session.qrTimer);
            const kb = isAdmin(userId) ? KB_ADMIN_MAIN : KB_MAIN;
            await ctx.reply(
                `✅ *LOGIN WHATSAPP BERHASIL!*\n\n` +
                `Pilih menu di keyboard bawah.`,
                { parse_mode: 'Markdown', ...kb }
            );
        }
    });

    sock.ev.on('creds.update', (creds) => {
        console.log(`[DEBUG] Credentials updated for user ${userId}`);
        saveCreds();
    });
}

// ══════════════════════════════════════════════════════════════
//  /START
// ══════════════════════════════════════════════════════════════

tgBot.start(async (ctx) => {
    const userId   = ctx.from.id;
    const name     = ctx.from.first_name || 'User';
    const status   = getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;

    // ── ADMIN ─────────────────────────────────────────────────
    if (isAdmin(userId)) {
        const kb = loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `👑 *Selamat datang, Admin ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            (loggedIn
                ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`) +
            `\n${DIVIDER_THIN}`,
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── REGULAR AKTIF ─────────────────────────────────────────
    if (status === 'regular') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `✅ *Halo ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `🏷️ Status: *Premium Aktif*\n` +
            `📅 Hingga: *${formatDate(u.expiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.expiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn
                ? `📡 WA: *Terhubung* ✅\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── TRIAL AKTIF ───────────────────────────────────────────
    if (status === 'trial') {
        const u  = getUser(userId);
        const kb = loggedIn ? KB_MAIN : KB_PRE_LOGIN;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `🎁 *Halo ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `🏷️ Status: *Trial Aktif*\n` +
            `⏱ Habis: *${formatDate(u.trialExpiresAt)}*\n` +
            `⏳ Sisa: *${formatCountdown(u.trialExpiresAt)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            (loggedIn
                ? `📡 WA: *Terhubung* ✅\n\n*Pilih menu di keyboard bawah:*`
                : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`) +
            `\n\n_Trial hanya 1 grup WA. Upgrade: tekan ⭐ Premium_`,
            { parse_mode: 'Markdown', ...kb }
        );
    }

    // ── EXPIRED ───────────────────────────────────────────────
    if (status === 'expired' || status === 'trial_expired') {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `⚠️ *Halo ${esc(name)}!*\n\n` +
            `Akses lo sudah berakhir.\n` +
            `Perpanjang untuk bisa pakai lagi!`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    // ── USER BARU ─────────────────────────────────────────────
    await ctx.reply(
        `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
        `👋 *Halo ${esc(name)}!*\n\n` +
        `Bot ini membantu lo *kick anggota grup WhatsApp* dengan mudah langsung dari Telegram.\n\n` +
        `${DIVIDER_THIN}\n` +
        `🎁 *COBA GRATIS ${TRIAL_DURATION_HOURS} JAM* — tanpa bayar\n` +
        `⭐ *PREMIUM* — akses penuh tanpa batas\n` +
        `${DIVIDER_THIN}\n\n` +
        `Pilih di keyboard bawah untuk memulai:`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
});

// ══════════════════════════════════════════════════════════════
//  /TRIAL
// ══════════════════════════════════════════════════════════════

tgBot.command('trial', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);

    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin, tidak perlu trial.', KB_ADMIN_PRE);
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler aktif.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(
            `⏱ *Lo masih dalam masa trial.*\n\nSisa: ${formatCountdown(u.trialExpiresAt)}`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    }

    const data     = loadData();
    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) {
        return ctx.reply(
            `❌ *Lo sudah pernah menggunakan masa trial.*\n\n` +
            `Upgrade ke paket reguler untuk akses penuh.\n` +
            `Tekan *⭐ Premium* untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    const result = startTrial(user);
    if (!result.success) {
        return ctx.reply(`❌ Gagal memulai trial: ${result.reason}`);
    }

    await ctx.reply(
        `🎉 *TRIAL BERHASIL DIAKTIFKAN!*\n\n` +
        `${DIVIDER_THIN}\n` +
        `✅ Akses trial aktif selama *${TRIAL_DURATION_HOURS} jam*\n` +
        `⏱ Berakhir: *${formatDate(result.expiresAt.toISOString())}*\n` +
        `${DIVIDER_THIN}\n\n` +
        `*Batasan trial:*\n` +
        `• Hanya bisa akses *1 grup WA*\n` +
        `• Durasi *${TRIAL_DURATION_HOURS} jam*\n\n` +
        `Tekan *🔑 Login WhatsApp* di bawah untuk mulai!\n\n` +
        `💳 Upgrade kapan saja: tekan *⭐ Premium*`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

// ══════════════════════════════════════════════════════════════
//  /BELI — HALAMAN PAKET HARGA
// ══════════════════════════════════════════════════════════════

async function showPriceMenu(ctx) {
    const status    = getUserStatus(ctx.from.id);
    const isRenewal = status === 'regular';

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`,                  'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)} (hemat 17%)`,     'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)} (hemat 33%)`,     'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)} (hemat 42%)`,     'buy_1tahun')],
    ]);

    await ctx.reply(
        `╔${DIVIDER}╗\n║  PAKET HARGA\n╚${DIVIDER}╝\n\n` +
        `${isRenewal ? '🔄 *Perpanjang akses lo!*' : '⭐ *Pilih paket yang sesuai:*'}\n\n` +
        `${DIVIDER_THIN}\n` +
        `📦 *1 Bulan*    → ${formatRupiah(PACKAGES['1bulan'].price)}\n` +
        `📦 *3 Bulan*    → ${formatRupiah(PACKAGES['3bulan'].price)}  *(hemat 17%)*\n` +
        `📦 *6 Bulan*    → ${formatRupiah(PACKAGES['6bulan'].price)}  *(hemat 33%)*\n` +
        `🏆 *1 Tahun*    → ${formatRupiah(PACKAGES['1tahun'].price)}  *(hemat 42%)*\n` +
        `${DIVIDER_THIN}\n\n` +
        `✅ *Semua paket reguler:*\n` +
        `• Akses grup WA *tidak terbatas*\n` +
        `• Kick anggota tanpa batasan\n` +
        `• Prioritas support\n\n` +
        `Pilih paket di bawah:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
}

tgBot.command('beli', showPriceMenu);

// Callback tombol paket beli
Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        const pkg  = PACKAGES[pkgKey];
        const user = ctx.from;

        addPendingPayment(user, pkgKey);

        // Notifikasi ke semua admin dengan tombol Approve/Reject inline
        for (const adminId of ADMIN_IDS) {
            try {
                const approveKeyboard = Markup.inlineKeyboard([
                    [
                        Markup.button.callback(`✅ Approve`, `admin_approve_${user.id}_${pkgKey}`),
                        Markup.button.callback(`❌ Reject`,  `admin_reject_${user.id}`)
                    ]
                ]);
                await tgBot.telegram.sendMessage(
                    adminId,
                    `🔔 *PERMINTAAN BELI BARU*\n\n` +
                    `👤 ${userDisplayName(user)}\n` +
                    `🆔 ID: \`${user.id}\`\n` +
                    `📦 Paket: *${pkg.label}* (${formatRupiah(pkg.price)})\n` +
                    `🕐 Waktu: ${formatDate(new Date().toISOString())}\n\n` +
                    `Tekan tombol di bawah untuk konfirmasi:`,
                    { parse_mode: 'Markdown', ...approveKeyboard }
                );
            } catch (_) {}
        }

        await ctx.reply(
            `✅ *Permintaan pembelian diterima!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `📦 Paket: *${pkg.label}*\n` +
            `💰 Harga: *${formatRupiah(pkg.price)}*\n` +
            `${DIVIDER_THIN}\n\n` +
            `*Langkah selanjutnya:*\n\n` +
            `1️⃣ *Lakukan pembayaran:*\n${PAYMENT_INFO}\n\n` +
            `2️⃣ *Konfirmasi ke admin:*\n` +
            `Kirim bukti transfer ke ${PAYMENT_CONTACT}\n` +
            `dengan format: \`KICKER-${user.id}-${pkgKey}\`\n\n` +
            `3️⃣ Admin akan memverifikasi & mengaktifkan akses lo secara otomatis.\n\n` +
            `${DIVIDER_THIN}\n` +
            `ℹ️ Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
            { parse_mode: 'Markdown' }
        );
    });
});

// ══════════════════════════════════════════════════════════════
//  CALLBACK ADMIN: APPROVE / REJECT INLINE BUTTON
// ══════════════════════════════════════════════════════════════

// Format: admin_approve_{userId}_{pkgKey}
tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('✅ Memproses approve...');

    const targetId = parseInt(ctx.match[1]);
    const pkgKey   = ctx.match[2];

    const result = approvePayment(targetId, pkgKey);
    if (!result.success) {
        return ctx.editMessageText(
            `❌ Gagal approve: ${result.reason}\n\n` +
            `User mungkin sudah diapprove sebelumnya.`
        );
    }

    // Update pesan admin
    await ctx.editMessageText(
        `✅ *APPROVED!*\n\n` +
        `🆔 ID: \`${targetId}\`\n` +
        `📦 Paket: *${result.pkg.label}*\n` +
        `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n` +
        `👤 Diapprove oleh: ${ctx.from.first_name}\n` +
        `🕐 Waktu: ${formatDate(new Date().toISOString())}`,
        { parse_mode: 'Markdown' }
    );

    // Notifikasi otomatis ke user
    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `📦 Paket: *${result.pkg.label}*\n` +
            `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n` +
            `⏳ Durasi: *${formatCountdown(result.expiresAt.toISOString())}*\n` +
            `${DIVIDER_THIN}\n\n` +
            `✅ Akses lo sudah aktif sebagai *Premium*!\n` +
            `Tekan *🔑 Login WhatsApp* untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

// Format: admin_reject_{userId}
tgBot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('❌ Memproses reject...');

    const targetId = parseInt(ctx.match[1]);

    const data  = loadData();
    const idx   = data.pendingPayment.findIndex(p => p.id === targetId);
    let userInfo = null;
    if (idx >= 0) {
        [userInfo] = data.pendingPayment.splice(idx, 1);
        saveData(data);
    }

    await ctx.editMessageText(
        `❌ *REJECTED*\n\n` +
        `🆔 ID: \`${targetId}\`\n` +
        `👤 Direject oleh: ${ctx.from.first_name}\n` +
        `🕐 Waktu: ${formatDate(new Date().toISOString())}`,
        { parse_mode: 'Markdown' }
    );

    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `❌ *Pembayaran lo ditolak oleh admin.*\n\n` +
            `Kemungkinan bukti transfer tidak valid atau belum dikirim.\n` +
            `Hubungi ${PAYMENT_CONTACT} untuk info lebih lanjut.\n\n` +
            `Coba beli lagi: tekan *⭐ Premium*`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

// ══════════════════════════════════════════════════════════════
//  COMMANDS ADMIN — TEXT COMMANDS
// ══════════════════════════════════════════════════════════════

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const list = getAllPendingPayments();
    if (list.length === 0) {
        return ctx.reply(`📭 *Tidak ada pembayaran pending.*`, { parse_mode: 'Markdown' });
    }

    let msg = `╔${DIVIDER}╗\n║  PEMBAYARAN PENDING\n╚${DIVIDER}╝\n\n`;
    msg += `Total: ${list.length} permintaan\n\n`;
    for (const p of list) {
        const pkg = PACKAGES[p.packageKey];
        msg += `👤 ${userDisplayName(p)}\n`;
        msg += `   ID: \`${p.id}\`\n`;
        msg += `   Paket: ${pkg ? pkg.label : p.packageKey} (${pkg ? formatRupiah(pkg.price) : '-'})\n`;
        msg += `   Waktu: ${formatDate(p.requestedAt)}\n\n`;
    }
    msg += `${DIVIDER_THIN}\n`;
    msg += `Approve: /approvepayment [id] [paket]\n`;
    msg += `Reject: /rejectpayment [id]`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });

    // Kirim tombol approve/reject per pending
    for (const p of list) {
        const pkg          = PACKAGES[p.packageKey];
        const approveKb    = Markup.inlineKeyboard([
            [
                Markup.button.callback(`✅ Approve`, `admin_approve_${p.id}_${p.packageKey}`),
                Markup.button.callback(`❌ Reject`,  `admin_reject_${p.id}`)
            ]
        ]);
        await ctx.reply(
            `👤 *${userDisplayName(p)}*\nID: \`${p.id}\` | Paket: *${pkg ? pkg.label : p.packageKey}*`,
            { parse_mode: 'Markdown', ...approveKb }
        );
    }
});

tgBot.command('approvepayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];

    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return ctx.reply(
            `*Format:* /approvepayment [user_id] [paket]\n\n` +
            `Paket: 1bulan / 3bulan / 6bulan / 1tahun\n` +
            `Contoh: /approvepayment 123456789 1bulan`,
            { parse_mode: 'Markdown' }
        );
    }

    const result = approvePayment(targetId, pkgKey);
    if (!result.success) {
        return ctx.reply(`❌ Gagal: ${result.reason}`, { parse_mode: 'Markdown' });
    }

    await ctx.reply(
        `✅ *Pembayaran diapprove!*\n\n` +
        `🆔 ID: \`${targetId}\`\n` +
        `📦 Paket: *${result.pkg.label}*\n` +
        `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*`,
        { parse_mode: 'Markdown' }
    );

    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n` +
            `${DIVIDER_THIN}\n` +
            `📦 Paket: *${result.pkg.label}*\n` +
            `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n` +
            `⏳ Durasi: *${formatCountdown(result.expiresAt.toISOString())}*\n` +
            `${DIVIDER_THIN}\n\n` +
            `✅ Akses lo sudah aktif sebagai *Premium*!\n` +
            `Tekan *🔑 Login WhatsApp* untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

tgBot.command('rejectpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);

    if (!targetId) {
        return ctx.reply(`*Format:* /rejectpayment [user_id]`, { parse_mode: 'Markdown' });
    }

    const data = loadData();
    const idx  = data.pendingPayment.findIndex(p => p.id === targetId);
    if (idx === -1) {
        return ctx.reply(`❌ Tidak ada pending payment dari ID ${targetId}.`);
    }
    const [user] = data.pendingPayment.splice(idx, 1);
    saveData(data);

    await ctx.reply(`❌ Pembayaran dari ID ${targetId} (${userDisplayName(user)}) direject.`);

    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `❌ *Pembayaran lo ditolak oleh admin.*\n\n` +
            `Kemungkinan bukti transfer tidak valid.\n` +
            `Hubungi ${PAYMENT_CONTACT} untuk info lebih lanjut.\n\n` +
            `Coba beli lagi: tekan *⭐ Premium*`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

tgBot.command('revokeuser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    if (!targetId) return ctx.reply(`*Format:* /revokeuser [user_id]`, { parse_mode: 'Markdown' });

    const user = revokeUser(targetId);
    if (!user) return ctx.reply(`❌ User ID ${targetId} tidak ditemukan.`);

    if (userSessions.has(targetId)) {
        const session = userSessions.get(targetId);
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('revoked')); } catch (_) {}
        userSessions.delete(targetId);
    }

    await ctx.reply(`🚫 Akses ${userDisplayName(user)} (ID: ${targetId}) dicabut.`);

    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `⚠️ *Akses lo ke ${BOT_NAME} telah dicabut oleh admin.*\n\n` +
            `Hubungi ${PAYMENT_CONTACT} jika ada pertanyaan.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    } catch (_) {}
});

tgBot.command('adduser', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const args     = ctx.message.text.split(' ');
    const targetId = parseInt(args[1]);
    const pkgKey   = args[2];

    if (!targetId || !pkgKey || !PACKAGES[pkgKey]) {
        return ctx.reply(
            `*Format:* /adduser [user_id] [paket]\n\nPaket: 1bulan / 3bulan / 6bulan / 1tahun`,
            { parse_mode: 'Markdown' }
        );
    }

    const result = approvePayment(targetId, pkgKey);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`);

    await ctx.reply(
        `✅ *User berhasil ditambahkan!*\n\n` +
        `🆔 ID: \`${targetId}\`\n` +
        `📦 Paket: *${result.pkg.label}*\n` +
        `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*`,
        { parse_mode: 'Markdown' }
    );

    try {
        await tgBot.telegram.sendMessage(
            targetId,
            `🎉 *Akses ke ${BOT_NAME} sudah diaktifkan!*\n\n` +
            `📦 Paket: *${result.pkg.label}*\n` +
            `📅 Aktif hingga: *${formatDate(result.expiresAt.toISOString())}*\n\n` +
            `Tekan *🔑 Login WhatsApp* untuk mulai.`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    } catch (_) {}
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });

    const now     = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });

    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n`;
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;

    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n`;
            msg += `   ID: \`${u.id}\` | ${role}\n`;
            msg += `   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }

    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: \`${u.id}\`\n`;
            msg += `   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_`;
    }

    msg += `\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  /MYACCOUNT & /HELP
// ══════════════════════════════════════════════════════════════

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);

    if (status === 'admin') {
        return ctx.reply(`👑 *Lo adalah Admin bot ini.*\n\nAkses penuh tanpa batas.`, { parse_mode: 'Markdown', ...KB_ADMIN_PRE });
    }

    const u = getUser(userId);
    if (!u) {
        return ctx.reply(
            `📋 *Info Akun Lo*\n\nStatus: *Belum terdaftar*\n\n` +
            `Tekan *🎁 Coba Gratis* untuk trial.\nTekan *⭐ Premium* untuk beli akses.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    let statusLine = '';
    if (status === 'regular')            statusLine = `✅ *Reguler* (Aktif)`;
    else if (status === 'trial')         statusLine = `🎁 *Trial* (Aktif)`;
    else if (status === 'expired')       statusLine = `❌ *Reguler* (Expired)`;
    else if (status === 'trial_expired') statusLine = `❌ *Trial* (Expired)`;

    const expDate = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
    const sisa    = expDate && new Date(expDate) > new Date() ? formatCountdown(expDate) : 'Expired';

    await ctx.reply(
        `╔${DIVIDER}╗\n║  INFO AKUN\n╚${DIVIDER}╝\n\n` +
        `👤 Nama: ${userDisplayNameEsc(u)}\n` +
        `🆔 ID: \`${u.id}\`\n\n` +
        `${DIVIDER_THIN}\n` +
        `🏷️ Status: ${statusLine}\n` +
        (expDate ? `📅 Expires: ${formatDate(expDate)}\n` : '') +
        (sisa !== 'Expired' ? `⏳ Sisa: ${sisa}\n` : '') +
        `${DIVIDER_THIN}\n\n` +
        (status === 'expired' || status === 'trial_expired'
            ? `⚠️ Akses lo sudah habis!\nTekan *⭐ Premium* untuk perpanjang.`
            : `💳 Perpanjang / upgrade: tekan *⭐ Premium*`),
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('help', async (ctx) => {
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PANDUAN PENGGUNAAN\n╚${DIVIDER}╝\n\n` +
        `${DIVIDER_THIN}\n*📌 CARA PAKAI BOT:*\n${DIVIDER_THIN}\n\n` +
        `*1. Daftar & Aktifkan Akses*\n` +
        `   Tekan *🎁 Coba Gratis* untuk trial gratis ${TRIAL_DURATION_HOURS} jam\n` +
        `   Tekan *⭐ Premium* untuk beli paket reguler\n\n` +
        `*2. Login WhatsApp*\n` +
        `   Tekan *🔑 Login WhatsApp*\n` +
        `   → Scan QR di WA lo\n\n` +
        `*3. Pilih Grup*\n` +
        `   Tekan *📋 Daftar Grup* — Lihat semua grup\n` +
        `   Tekan *🎯 Pilih Grup* → ketik: /select "Nama Grup"\n\n` +
        `*4. Kick Anggota*\n` +
        `   Tekan *🔴 Kick Menu*\n` +
        `   → Centang anggota yang mau dikick\n` +
        `   → Tekan tombol "Kick"\n\n` +
        `${DIVIDER_THIN}\n*⚠️ PENTING:*\n` +
        `• Bot hanya bisa kick jika lo adalah *admin grup*\n` +
        `• Akun WA yang login harus jadi *admin* di grup target\n` +
        `• Trial hanya bisa akses *1 grup*\n` +
        `${DIVIDER_THIN}\n\n` +
        `Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

// ══════════════════════════════════════════════════════════════
//  COMMANDS BOT UTAMA (WA)
// ══════════════════════════════════════════════════════════════

tgBot.command('login', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply(
            '✅ *Lo udah login ke WhatsApp!*\nTekan *🚪 Logout WhatsApp* dulu jika ingin ganti akun.',
            { parse_mode: 'Markdown' }
        );
    }
    await ctx.reply(`🔄 *Memulai koneksi ke WhatsApp...*\n\n_Harap tunggu..._`, { parse_mode: 'Markdown' });
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session)         return ctx.reply('❌ Belum ada sesi. Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    if (session.loggedIn) return ctx.reply('✅ Lo sudah login! QR tidak diperlukan.');
    if (!session.lastQR)  return ctx.reply('⏳ QR belum tersedia. Tunggu atau login ulang.');

    session.qrBlocked = true;
    await sendQR(ctx, session.lastQR);
    if (session.qrTimer) clearTimeout(session.qrTimer);
    session.qrTimer = setTimeout(async () => {
        if (!session.loggedIn) {
            session.qrBlocked = false;
            await ctx.reply('⏱ QR expired. Ketik /refreshqr untuk QR baru.');
        }
    }, 5 * 60 * 1000);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Lo belum login!');
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout WhatsApp berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR Scan';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (exp: ${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (sisa: ${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(
        `╔${DIVIDER}╗\n║  STATUS\n╚${DIVIDER}╝\n\n` +
        `📡 WA: ${waStatus}\n` +
        `🏷️ Akun: ${accLine}\n` +
        (session?.groupName ? `🎯 Grup aktif: ${session.groupName}\n` : '🎯 Grup: Belum dipilih\n'),
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });

    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats        = await session.sock.groupFetchAllParticipating();
        const groups       = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ Tidak ada grup WA.');

        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP WA\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ _Trial: hanya 1 grup ditampilkan_\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `*${i + 1}.* ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        if (isTrial && groups.length > 1) msg += `_+${groups.length - 1} grup lain (upgrade untuk akses semua)_\n\n`;
        msg += `${DIVIDER_THIN}\nTekan *🎯 Pilih Grup* untuk memilih grup target`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    let groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (!groupName) return ctx.reply('*Format:* /select "Nama Grup"', { parse_mode: 'Markdown' });

    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);

        const isTrial       = isTrialOnly(userId);
        const allowedGroups = isTrial ? groups.slice(0, 1) : groups;
        const target        = allowedGroups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());

        if (!target) {
            const msg = isTrial
                ? `❌ *Grup "${groupName}" tidak ditemukan.*\n\n_Trial hanya bisa akses 1 grup._`
                : `❌ *Grup "${groupName}" tidak ditemukan.*\n\nCek nama grup di *📋 Daftar Grup*.`;
            return ctx.reply(msg, { parse_mode: 'Markdown' });
        }

        session.groupId   = target.id;
        session.groupName = target.subject;
        await ctx.reply(
            `✅ *Grup terpilih!*\n\n` +
            `🎯 *${target.subject}*\n` +
            `👥 Total anggota: ${target.participants?.length || 0} orang\n\n` +
            `Tekan *🔴 Kick Menu* untuk mulai kick anggota.`,
            { parse_mode: 'Markdown' }
        );
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId)              return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });
    await showKickMenu(ctx, userId, session);
});

async function showKickMenu(ctx, userId, session) {
    await ctx.reply('⏳ *Mengambil daftar anggota...*', { parse_mode: 'Markdown' });
    try {
        const metadata = await session.sock.groupMetadata(session.groupId);
        const myJid    = session.sock.user.id.replace(/:.*@/, '@');
        const members  = metadata.participants
            .filter(p => {
                const isMe  = p.id === myJid || p.id.split('@')[0] === myJid.split('@')[0];
                const isAdm = p.admin === 'admin' || p.admin === 'superadmin';
                return !isMe && !isAdm;
            })
            .map(p => ({ jid: p.id, name: p.id.split('@')[0] }));

        if (members.length === 0) {
            return ctx.reply(`ℹ️ *Tidak ada anggota yang bisa dikick.*\n\nSemua anggota adalah admin.`, { parse_mode: 'Markdown' });
        }

        session.members = members;
        kickSelections.set(userId, new Set());

        await ctx.reply(
            `╔${DIVIDER}╗\n║  MENU KICK ANGGOTA\n╚${DIVIDER}╝\n\n` +
            `🎯 Grup: *${session.groupName}*\n` +
            `👥 Non-admin: *${members.length} orang*\n\n` +
            `Ketuk nama untuk pilih/batal.\n` +
            `Tekan *Kick Terpilih* jika sudah siap.\n\n` +
            `⚠️ _Aksi kick tidak bisa dibatalkan!_`,
            { parse_mode: 'Markdown', ...buildMemberKeyboard(members, kickSelections.get(userId)) }
        );
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
}

// ══════════════════════════════════════════════════════════════
//  VCF PARSER
// ══════════════════════════════════════════════════════════════

function parseVCF(vcfText) {
    const contacts = [];
    const seen     = new Set();
    const blocks   = vcfText.split(/END:VCARD/i).map(b => b.trim()).filter(Boolean);

    for (const block of blocks) {
        let name = 'Tanpa Nama';
        const fnMatch = block.match(/^FN[;:][^\r\n]*/mi);
        const nMatch  = block.match(/^N[;:][^\r\n]*/mi);
        if (fnMatch) {
            const qpMatch = fnMatch[0].match(/ENCODING=QUOTED-PRINTABLE.*?:(.*)/i);
            if (qpMatch) {
                try { name = decodeQP(qpMatch[1].trim()); } catch (_) {}
            } else {
                name = fnMatch[0].replace(/^FN.*?:/i, '').trim();
            }
        } else if (nMatch) {
            const raw   = nMatch[0].replace(/^N.*?:/i, '').trim();
            const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
            name = parts.slice(0, 2).reverse().join(' ').trim() || 'Tanpa Nama';
        }
        name = name.replace(/[\x00-\x1F]/g, '').trim() || 'Tanpa Nama';

        const telLines = block.match(/^TEL[^\r\n]*/gim) || [];
        for (const telLine of telLines) {
            let num = telLine.replace(/^TEL[^:]*:/i, '').replace(/[\s\-().]/g, '').trim();
            if (!num) continue;
            num = normalizePhone(num);
            if (!num) continue;
            if (seen.has(num)) continue;
            seen.add(num);
            contacts.push({ name, phone: num });
        }
    }
    return contacts;
}

function decodeQP(str) {
    return str.replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function normalizePhone(raw) {
    const hasPlus = raw.trimStart().startsWith('+');
    let digits    = raw.replace(/\D/g, '');
    if (!digits) return null;

    if (hasPlus || digits.startsWith('00')) {
        const withCC = hasPlus ? digits : digits.slice(2);
        if (withCC.length >= 7) return withCC;
    }

    // Default: coba Indonesia
    if (digits.startsWith('0')) return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9) return '62' + digits;

    return digits.length >= 7 ? digits : null;
}

const vcfPending = new Map();

// ══════════════════════════════════════════════════════════════
//  COMMAND /buatgrup
// ══════════════════════════════════════════════════════════════

tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    }

    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) {
        return ctx.reply(
            `╔${DIVIDER}╗\n║  BUAT GRUP WA BARU\n╚${DIVIDER}╝\n\n` +
            `*Format:* /buatgrup "Nama Grup"\n\nContoh:\n/buatgrup "Arisan RT 05"`,
            { parse_mode: 'Markdown' }
        );
    }

    await ctx.reply(`⏳ *Membuat grup "${namaGrup}"...*`, { parse_mode: 'Markdown' });

    try {
        const result  = await session.sock.groupCreate(namaGrup, []);
        const groupId = result.id;

        session.groupId   = groupId;
        session.groupName = namaGrup;

        let inviteLink = '-';
        try {
            const code = await session.sock.groupInviteCode(groupId);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (_) {}

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback('📥 Import VCF Sekarang', `importvcf_start_${userId}`)],
            [Markup.button.callback('🔴 Kick Menu',           `goto_kickmenu_${userId}`)],
        ]);

        await ctx.reply(
            `╔${DIVIDER}╗\n║  GRUP BERHASIL DIBUAT!\n╚${DIVIDER}╝\n\n` +
            `✅ *${namaGrup}*\n\n` +
            `${DIVIDER_THIN}\n` +
            `🆔 ID Grup:\n\`${groupId}\`\n\n` +
            `🔗 Link Invite:\n${inviteLink}\n` +
            `${DIVIDER_THIN}\n\n` +
            `Grup ini sudah jadi *grup aktif* lo.\n` +
            `Mau langsung import kontak dari VCF?`,
            { parse_mode: 'Markdown', ...keyboard }
        );
    } catch (err) {
        await ctx.reply(`❌ *Gagal buat grup:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  COMMAND /importvcf
// ══════════════════════════════════════════════════════════════

tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    }
    if (!session.groupId) {
        return ctx.reply(
            `❌ *Pilih grup dulu!*\n\nTekan *📋 Daftar Grup* → *🎯 Pilih Grup*\natau tekan *➕ Buat Grup WA*`,
            { parse_mode: 'Markdown' }
        );
    }

    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });

    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n` +
        `${DIVIDER_THIN}\n` +
        `📎 *Kirim file .vcf sekarang*\n\n` +
        `Format yang didukung:\n` +
        `• vCard 2.1, 3.0, 4.0\n` +
        `• Nomor lokal 08xx → otomatis 628xx\n` +
        `• Multi-nomor per kontak ✓\n` +
        `${DIVIDER_THIN}\n\n` +
        `_Kirim file .vcf langsung ke chat ini..._`,
        { parse_mode: 'Markdown' }
    );
});

// ══════════════════════════════════════════════════════════════
//  HANDLER FILE VCF
// ══════════════════════════════════════════════════════════════

tgBot.on('document', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;

    const doc   = ctx.message.document;
    const fname = doc.file_name || '';

    if (!fname.toLowerCase().endsWith('.vcf') && doc.mime_type !== 'text/x-vcard' && doc.mime_type !== 'text/vcard') {
        return ctx.reply('⚠️ *File harus berformat .vcf*\n\nKirim ulang file yang benar.', { parse_mode: 'Markdown' });
    }

    await ctx.reply('⏳ *Membaca file VCF...*', { parse_mode: 'Markdown' });

    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp     = await fetch(fileLink.href);
        const vcfText  = await resp.text();
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            vcfPending.delete(userId);
            return ctx.reply(
                `❌ *Tidak ada nomor valid ditemukan di file VCF.*\n\n` +
                `Pastikan file VCF berisi nomor telepon yang valid.`,
                { parse_mode: 'Markdown' }
            );
        }

        pending.contacts    = contacts;
        pending.waitingFile = false;
        vcfPending.set(userId, pending);

        let preview = `╔${DIVIDER}╗\n║  PREVIEW KONTAK VCF\n╚${DIVIDER}╝\n\n`;
        preview += `📊 *Total kontak valid: ${contacts.length}*\n`;
        preview += `🎯 *Target grup:* ${pending.groupName}\n\n`;
        preview += `${DIVIDER_THIN}\n*5 Kontak Pertama:*\n${DIVIDER_THIN}\n`;
        contacts.slice(0, 5).forEach((c, i) => {
            preview += `${i + 1}. ${c.name}\n   📱 +${c.phone}\n`;
        });
        if (contacts.length > 5) preview += `\n_...dan ${contacts.length - 5} kontak lainnya_\n`;
        preview += `\n${DIVIDER_THIN}\n`;
        preview += `⚠️ _Bot hanya bisa tambahkan kontak yang sudah punya WhatsApp_`;

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`✅ Tambahkan Semua (${contacts.length} kontak)`, 'vcf_add_all')],
            [Markup.button.callback(`📦 Per Batch 5 kontak`, 'vcf_add_batch')],
            [Markup.button.callback('❌ Batal', 'vcf_cancel')],
        ]);

        await ctx.reply(preview, { parse_mode: 'Markdown', ...keyboard });

    } catch (err) {
        vcfPending.delete(userId);
        await ctx.reply(`❌ *Gagal baca file:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  HELPER: TAMBAH KONTAK KE GRUP
// ══════════════════════════════════════════════════════════════

async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Session WA berakhir.* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    }

    const total  = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;
    const gagalList = [];

    const statusMsg = await ctx.reply(
        `⏳ *Menambahkan ${total} kontak ke grup...*\n\n_0 / ${total} selesai_`,
        { parse_mode: 'Markdown' }
    );

    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        try {
            const [result] = await session.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) { notWA++; continue; }
            await session.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            await new Promise(r => setTimeout(r, 800));

            if ((i + 1) % 5 === 0 || i + 1 === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, statusMsg.message_id, null,
                        `⏳ *Menambahkan kontak...*\n\n${i + 1} / ${total} diproses\n✅ Berhasil: ${berhasil}  |  📵 No WA: ${notWA}`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (_) {}
            }
        } catch (err) {
            gagal++;
            gagalList.push(`• ${c.name} (+${c.phone}): ${err.message}`);
            await new Promise(r => setTimeout(r, 500));
        }
    }

    let hasil = `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n`;
    hasil += `🎯 *Grup:* ${groupName}\n\n`;
    hasil += `${DIVIDER_THIN}\n`;
    hasil += `✅ *Berhasil ditambah:* ${berhasil} kontak\n`;
    hasil += `📵 *Tidak punya WA:* ${notWA} kontak\n`;
    hasil += `❌ *Error:* ${gagal} kontak\n`;
    hasil += `${DIVIDER_THIN}`;
    if (gagalList.length > 0 && gagalList.length <= 5) {
        hasil += `\n\n*Detail error:*\n${gagalList.join('\n')}`;
    }

    await ctx.reply(hasil, { parse_mode: 'Markdown' });
    vcfPending.delete(userId);
}

// ══════════════════════════════════════════════════════════════
//  CALLBACKS INLINE KEYBOARD
// ══════════════════════════════════════════════════════════════

tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');

    const jid      = ctx.match[1];
    const session  = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired. Tekan 🔴 Kick Menu.');

    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus dari pilihan');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan ke pilihan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId   = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');

    const session  = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    await ctx.answerCbQuery();

    if (!session || !session.loggedIn) return ctx.reply('❌ *Session expired.* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    if (!selected || selected.size === 0) return ctx.reply('⚠️ *Belum ada yang dipilih!*', { parse_mode: 'Markdown' });

    const jidList = Array.from(selected);
    await ctx.reply(`⏳ *Mengkick ${jidList.length} anggota...*\n_Harap tunggu..._`, { parse_mode: 'Markdown' });

    let berhasil = 0, gagal = 0;
    const gagalList = [];

    for (const jid of jidList) {
        try {
            await session.sock.groupParticipantsUpdate(session.groupId, [jid], 'remove');
            berhasil++;
            await new Promise(r => setTimeout(r, 500));
        } catch (err) {
            gagal++;
            gagalList.push(`• ${jid.split('@')[0]}: ${err.message}`);
        }
    }

    kickSelections.set(userId, new Set());

    let result = `╔${DIVIDER}╗\n║  HASIL KICK\n╚${DIVIDER}╝\n\n`;
    result += `✅ *Berhasil dikick:* ${berhasil} orang\n`;
    result += `❌ *Gagal:* ${gagal} orang\n`;
    if (gagalList.length > 0) result += `\n*Detail gagal:*\n${gagalList.join('\n')}`;
    result += `\n\nTekan *🔴 Kick Menu* untuk kick lagi`;

    await ctx.reply(result, { parse_mode: 'Markdown' });
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Kick dibatalkan.*', { parse_mode: 'Markdown' });
    try { await ctx.deleteMessage(); } catch (_) {}
});

tgBot.action(/^importvcf_start_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn || !session.groupId) {
        return ctx.reply('❌ Pilih grup dulu atau login ulang.');
    }
    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n📎 *Kirim file .vcf sekarang ke chat ini.*`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.action(/^goto_kickmenu_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply('Tekan *🔴 Kick Menu* untuk membuka menu kick anggota.', { parse_mode: 'Markdown' });
});

tgBot.action('vcf_add_all', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('Memulai proses...');

    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts || pending.contacts.length === 0) {
        return ctx.reply('❌ Data kontak tidak ditemukan. Tekan *📥 Import VCF* untuk ulangi.', { parse_mode: 'Markdown' });
    }
    await addContactsToGroup(ctx, userId, pending.contacts, pending.groupId, pending.groupName);
});

tgBot.action('vcf_add_batch', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Akses ditolak.');
    await ctx.answerCbQuery('Mode batch aktif...');

    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts || pending.contacts.length === 0) {
        return ctx.reply('❌ Data kontak tidak ditemukan. Tekan *📥 Import VCF* untuk ulangi.', { parse_mode: 'Markdown' });
    }

    const contacts   = pending.contacts;
    const batchSize  = 5;
    const totalBatch = Math.ceil(contacts.length / batchSize);

    await ctx.reply(
        `📦 *Mode batch aktif*\n\nTotal: ${contacts.length} kontak → ${totalBatch} batch (@5 kontak)\n\n_Memulai batch 1..._`,
        { parse_mode: 'Markdown' }
    );

    for (let b = 0; b < totalBatch; b++) {
        const batch   = contacts.slice(b * batchSize, (b + 1) * batchSize);
        const session = userSessions.get(userId);
        if (!session || !session.loggedIn) break;

        await ctx.reply(`⏳ *Batch ${b + 1}/${totalBatch}* (${batch.length} kontak)...`, { parse_mode: 'Markdown' });

        let ok = 0, skip = 0, err = 0;
        for (const c of batch) {
            try {
                const [result] = await session.sock.onWhatsApp(c.phone);
                if (!result || !result.exists) { skip++; continue; }
                await session.sock.groupParticipantsUpdate(pending.groupId, [result.jid], 'add');
                ok++;
                await new Promise(r => setTimeout(r, 800));
            } catch (_) {
                err++;
                await new Promise(r => setTimeout(r, 500));
            }
        }

        await ctx.reply(
            `✅ *Batch ${b + 1}/${totalBatch} selesai*\nBerhasil: ${ok} | Skip (no WA): ${skip} | Error: ${err}`,
            { parse_mode: 'Markdown' }
        );
        if (b + 1 < totalBatch) await new Promise(r => setTimeout(r, 2000));
    }

    vcfPending.delete(userId);
    await ctx.reply(`🎉 *Import selesai!*\n\nTekan *🔴 Kick Menu* untuk menu kick anggota.`, { parse_mode: 'Markdown' });
});

tgBot.action('vcf_cancel', async (ctx) => {
    vcfPending.delete(ctx.from.id);
    await ctx.answerCbQuery('Import dibatalkan');
    await ctx.reply('✖ *Import VCF dibatalkan.*', { parse_mode: 'Markdown' });
    try { await ctx.deleteMessage(); } catch (_) {}
});

// ══════════════════════════════════════════════════════════════
//  HANDLER REPLY KEYBOARD — tombol teks keyboard bawah
// ══════════════════════════════════════════════════════════════

// ── LANDING ──────────────────────────────────────────────────

tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);

    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin, tidak perlu trial.', KB_ADMIN_PRE);
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler aktif.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(
            `⏱ *Lo masih dalam masa trial.*\n\nSisa: ${formatCountdown(u.trialExpiresAt)}`,
            { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
        );
    }

    const data     = loadData();
    const hadTrial = data.users.some(u => u.id === user.id && u.hadTrial);
    if (hadTrial) {
        return ctx.reply(
            `❌ *Lo sudah pernah menggunakan masa trial.*\n\n` +
            `Upgrade ke paket reguler untuk akses penuh.\n` +
            `Tekan *⭐ Premium* untuk lihat paket.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ Gagal memulai trial: ${result.reason}`);

    await ctx.reply(
        `🎉 *TRIAL BERHASIL DIAKTIFKAN!*\n\n` +
        `${DIVIDER_THIN}\n` +
        `✅ Akses trial aktif selama *${TRIAL_DURATION_HOURS} jam*\n` +
        `⏱ Berakhir: *${formatDate(result.expiresAt.toISOString())}*\n` +
        `${DIVIDER_THIN}\n\n` +
        `*Batasan trial:*\n` +
        `• Hanya bisa akses *1 grup WA*\n` +
        `• Durasi *${TRIAL_DURATION_HOURS} jam*\n\n` +
        `Tekan *🔑 Login WhatsApp* di bawah untuk mulai!\n\n` +
        `💳 Upgrade kapan saja: tekan *⭐ Premium*`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

tgBot.hears('⭐ Premium', async (ctx) => {
    await showPriceMenu(ctx);
});

tgBot.hears('❓ Bantuan', async (ctx) => {
    await ctx.reply(
        `╔${DIVIDER}╗\n║  PANDUAN PENGGUNAAN\n╚${DIVIDER}╝\n\n` +
        `${DIVIDER_THIN}\n*📌 CARA PAKAI BOT:*\n${DIVIDER_THIN}\n\n` +
        `*1. Daftar & Aktifkan Akses*\n` +
        `   Tekan *🎁 Coba Gratis* untuk trial gratis ${TRIAL_DURATION_HOURS} jam\n` +
        `   Tekan *⭐ Premium* untuk beli paket reguler\n\n` +
        `*2. Login WhatsApp*\n` +
        `   Tekan *🔑 Login WhatsApp*\n` +
        `   → Scan QR di WA lo\n\n` +
        `*3. Pilih Grup*\n` +
        `   Tekan *📋 Daftar Grup* — Lihat semua grup\n` +
        `   Tekan *🎯 Pilih Grup* → ketik: /select "Nama Grup"\n\n` +
        `*4. Kick Anggota*\n` +
        `   Tekan *🔴 Kick Menu*\n` +
        `   → Centang anggota yang mau dikick\n` +
        `   → Tekan tombol "Kick"\n\n` +
        `${DIVIDER_THIN}\n*⚠️ PENTING:*\n` +
        `• Bot hanya bisa kick jika lo adalah *admin grup*\n` +
        `• Akun WA yang login harus jadi *admin* di grup target\n` +
        `• Trial hanya bisa akses *1 grup*\n` +
        `${DIVIDER_THIN}\n\n` +
        `Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

// ── PRE LOGIN ─────────────────────────────────────────────────

tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    console.log(`[DEBUG] Login button clicked by user ${userId}`);
    
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        console.log(`[DEBUG] User already logged in`);
        return ctx.reply(
            '✅ *Lo udah login ke WhatsApp!*\nTekan *🚪 Logout WhatsApp* dulu jika ingin ganti akun.',
            { parse_mode: 'Markdown' }
        );
    }
    
    await ctx.reply(`🔄 *Memulai koneksi ke WhatsApp...*\n\n_Harap tunggu, QR code akan segera muncul..._`, { 
        parse_mode: 'Markdown' 
    });
    
    try {
        console.log(`[DEBUG] Calling startLogin for user ${userId}`);
        await startLogin(ctx, userId);
        console.log(`[DEBUG] startLogin completed`);
    } catch (err) {
        console.error(`[ERROR] startLogin failed:`, err);
        await ctx.reply(`❌ *Gagal memulai login:* ${err.message}\n\nCoba lagi nanti.`, { 
            parse_mode: 'Markdown' 
        });
    }
});

tgBot.hears('📊 Status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR Scan';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (exp: ${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (sisa: ${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(
        `╔${DIVIDER}╗\n║  STATUS\n╚${DIVIDER}╝\n\n` +
        `📡 WA: ${waStatus}\n` +
        `🏷️ Akun: ${accLine}\n` +
        (session?.groupName ? `🎯 Grup aktif: ${session.groupName}\n` : '🎯 Grup: Belum dipilih\n'),
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);

    if (status === 'admin') {
        return ctx.reply(`👑 *Lo adalah Admin bot ini.*\n\nAkses penuh tanpa batas.`, { parse_mode: 'Markdown', ...KB_ADMIN_PRE });
    }

    const u = getUser(userId);
    if (!u) {
        return ctx.reply(
            `📋 *Info Akun Lo*\n\nStatus: *Belum terdaftar*\n\n` +
            `Tekan *🎁 Coba Gratis* untuk trial.\nTekan *⭐ Premium* untuk beli akses.`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    let statusLine = '';
    if (status === 'regular')            statusLine = `✅ *Reguler* (Aktif)`;
    else if (status === 'trial')         statusLine = `🎁 *Trial* (Aktif)`;
    else if (status === 'expired')       statusLine = `❌ *Reguler* (Expired)`;
    else if (status === 'trial_expired') statusLine = `❌ *Trial* (Expired)`;

    const expDate = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
    const sisa    = expDate && new Date(expDate) > new Date() ? formatCountdown(expDate) : 'Expired';

    await ctx.reply(
        `╔${DIVIDER}╗\n║  INFO AKUN\n╚${DIVIDER}╝\n\n` +
        `👤 Nama: ${userDisplayNameEsc(u)}\n` +
        `🆔 ID: \`${u.id}\`\n\n` +
        `${DIVIDER_THIN}\n` +
        `🏷️ Status: ${statusLine}\n` +
        (expDate ? `📅 Expires: ${formatDate(expDate)}\n` : '') +
        (sisa !== 'Expired' ? `⏳ Sisa: ${sisa}\n` : '') +
        `${DIVIDER_THIN}\n\n` +
        (status === 'expired' || status === 'trial_expired'
            ? `⚠️ Akses lo sudah habis!\nTekan *⭐ Premium* untuk perpanjang.`
            : `💳 Perpanjang / upgrade: tekan *⭐ Premium*`),
        { parse_mode: 'Markdown' }
    );
});

// ── MAIN (setelah login WA) ───────────────────────────────────

tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }

    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats  = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ Tidak ada grup WA.');

        const isTrial       = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP WA\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ _Trial: hanya 1 grup ditampilkan_\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `*${i + 1}.* ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        if (isTrial && groups.length > 1) msg += `_+${groups.length - 1} grup lain (upgrade untuk akses semua)_\n\n`;
        msg += `${DIVIDER_THIN}\nTekan *🎯 Pilih Grup* lalu ketik: /select "Nama Grup"`;

        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    const session = userSessions.get(ctx.from.id);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    await ctx.reply(
        `🎯 *Pilih Grup*\n\nKetik perintah berikut:\n/select "Nama Grup"\n\nContoh:\n/select "Arisan RT 05"\n\n_Lihat daftar nama grup: tekan 📋 Daftar Grup_`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    const session = userSessions.get(ctx.from.id);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    await ctx.reply(
        `➕ *Buat Grup WA Baru*\n\nKetik perintah berikut:\n/buatgrup "Nama Grup"\n\nContoh:\n/buatgrup "Arisan RT 05"`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    if (!session.groupId) {
        return ctx.reply(
            `❌ *Pilih grup dulu!*\n\nTekan *📋 Daftar Grup* → *🎯 Pilih Grup*\natau tekan *➕ Buat Grup WA*`,
            { parse_mode: 'Markdown' }
        );
    }

    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(
        `╔${DIVIDER}╗\n║  IMPORT KONTAK VCF\n╚${DIVIDER}╝\n\n` +
        `🎯 *Grup target:* ${session.groupName}\n\n${DIVIDER_THIN}\n` +
        `📎 *Kirim file .vcf sekarang*\n\nFormat yang didukung:\n` +
        `• vCard 2.1, 3.0, 4.0\n• Nomor lokal 08xx → otomatis 628xx\n` +
        `${DIVIDER_THIN}\n\n_Kirim file .vcf langsung ke chat ini..._`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('🔴 Kick Menu', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Login dulu!* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    if (!session.groupId) {
        return ctx.reply('❌ *Pilih grup dulu!*\n\nTekan *📋 Daftar Grup* lalu *🎯 Pilih Grup*', { parse_mode: 'Markdown' });
    }
    await showKickMenu(ctx, userId, session);
});

tgBot.hears('📡 Status', requireAccess, async (ctx) => {
    const userId    = ctx.from.id;
    const session   = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u         = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR Scan';
    if (session && session.loggedIn)  waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin')        accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (exp: ${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial')   accLine = `🎁 Trial (sisa: ${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(
        `╔${DIVIDER}╗\n║  STATUS\n╚${DIVIDER}╝\n\n` +
        `📡 WA: ${waStatus}\n` +
        `🏷️ Akun: ${accLine}\n` +
        (session?.groupName ? `🎯 Grup aktif: ${session.groupName}\n` : '🎯 Grup: Belum dipilih\n'),
        { parse_mode: 'Markdown' }
    );
});

tgBot.hears('🚪 Logout WhatsApp', requireAccess, async (ctx) => {
    const userId  = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Lo belum login!');
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = path.join(AUTH_BASE_FOLDER, `user_${userId}`);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout WhatsApp berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

// ── ADMIN keyboard handlers ───────────────────────────────────

tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 *Tidak ada pembayaran pending.*`, { parse_mode: 'Markdown' });

    let msg = `╔${DIVIDER}╗\n║  PEMBAYARAN PENDING\n╚${DIVIDER}╝\n\nTotal: ${list.length} permintaan\n\n`;
    list.forEach((p, i) => {
        const pkg = PACKAGES[p.packageKey];
        msg += `${i + 1}. ${userDisplayName(p)}\n   ID: \`${p.id}\`\n   Paket: ${pkg ? pkg.label : p.packageKey} (${pkg ? formatRupiah(pkg.price) : '-'})\n   Waktu: ${formatDate(p.requestedAt)}\n\n`;
    });
    await ctx.reply(msg, { parse_mode: 'Markdown' });

    // Tombol approve/reject per item
    for (const p of list) {
        const pkg       = PACKAGES[p.packageKey];
        const approveKb = Markup.inlineKeyboard([
            [
                Markup.button.callback(`✅ Approve`, `admin_approve_${p.id}_${p.packageKey}`),
                Markup.button.callback(`❌ Reject`,  `admin_reject_${p.id}`)
            ]
        ]);
        await ctx.reply(
            `👤 *${userDisplayName(p)}*\nID: \`${p.id}\` | Paket: *${pkg ? pkg.label : p.packageKey}*`,
            { parse_mode: 'Markdown', ...approveKb }
        );
    }
});

tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });

    const now     = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });

    let msg = `╔${DIVIDER}╗\n║  DAFTAR USER\n╚${DIVIDER}╝\n\n`;
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;

    if (actives.length > 0) {
        msg += `${DIVIDER_THIN}\n✅ USER AKTIF:\n${DIVIDER_THIN}\n`;
        actives.forEach((u, i) => {
            const exp  = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            msg += `${i + 1}. ${userDisplayName(u)}\n   ID: \`${u.id}\` | ${role}\n   Exp: ${formatDate(exp)} (${formatCountdown(exp)})\n\n`;
        });
    }

    if (expired.length > 0 && expired.length <= 10) {
        msg += `${DIVIDER_THIN}\n❌ EXPIRED:\n${DIVIDER_THIN}\n`;
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: \`${u.id}\`\n   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `_(+${expired.length} user expired tidak ditampilkan)_`;
    }

    msg += `\n/revokeuser [id] — Cabut akses`;
    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  AUTO-NOTIF EXPIRED (setiap 1 jam)
// ══════════════════════════════════════════════════════════════

setInterval(async () => {
    const users = getAllUsers();
    const now   = new Date();
    const data  = loadData();

    for (const u of users) {
        if (u.notifiedExpiry) continue;
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        if (!exp) continue;

        const msLeft = new Date(exp) - now;
        if (msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000) {
            try {
                const label = u.role === 'trial' ? 'Trial' : 'Akses';
                await tgBot.telegram.sendMessage(
                    u.id,
                    `⚠️ *PERINGATAN: ${label} lo akan segera habis!*\n\n` +
                    `⏳ Sisa: *${formatCountdown(exp)}*\n\n` +
                    `Perpanjang sekarang agar tidak terputus:\nTekan *⭐ Premium*`,
                    { parse_mode: 'Markdown', ...KB_LANDING }
                );
                // Tandai sudah dinotif agar tidak kirim berkali-kali
                const idx = data.users.findIndex(x => x.id === u.id);
                if (idx >= 0) data.users[idx].notifiedExpiry = true;
            } catch (_) {}
        }
    }
    saveData(data);
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════════════════════

tgBot.launch().then(() => {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║    WA KICKER BOT v3.0 AKTIF          ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Admin IDs  : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial      : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Paket      : ${Object.keys(PACKAGES).join(' | ')}`);
    console.log(`║  Pembayaran : ${PAYMENT_BANK_NAME} ${PAYMENT_BANK_NUMBER}`);
    console.log('╚══════════════════════════════════════╝');
    console.log('');
});

process.on('SIGINT',  () => { tgBot.stop('SIGINT');  process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });
