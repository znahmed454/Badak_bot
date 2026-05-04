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
const crypto = require('crypto');

// ╔══════════════════════════════════════════════════════════════╗
// ║         W A - K I C K E R   B O T   v 4 . 2 . 1            ║
// ║              F I X E D   E D I T I O N                      ║
// ╚══════════════════════════════════════════════════════════════╝

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN tidak ditemukan di .env!');
    process.exit(1);
}

const ADMIN_IDS = (process.env.ADMIN_IDS || '')
    .split(',')
    .map(id => parseInt(id.trim()))
    .filter(id => !isNaN(id));

if (ADMIN_IDS.length === 0) {
    console.error('❌ ADMIN_IDS tidak ditemukan atau tidak valid di .env!');
    process.exit(1);
}

const BOT_NAME             = process.env.BOT_NAME || '⚡ WA Kicker Bot';
const PAYMENT_BANK_NAME    = process.env.PAYMENT_BANK_NAME   || 'SEA';
const PAYMENT_BANK_NUMBER  = process.env.PAYMENT_BANK_NUMBER || '1234567890';
const PAYMENT_BANK_HOLDER  = process.env.PAYMENT_BANK_HOLDER || 'Bot Owner';
const PAYMENT_DANA         = process.env.PAYMENT_DANA       || '081234567890';
const PAYMENT_CONTACT      = process.env.PAYMENT_CONTACT     || '@adminusername';
const TRIAL_DURATION_HOURS = parseInt(process.env.TRIAL_DURATION_HOURS || '24');

const PAYMENT_INFO =
    `Transfer ke:\n` +
    `🏦 ${PAYMENT_BANK_NAME}: ${PAYMENT_BANK_NUMBER} a/n ${PAYMENT_BANK_HOLDER}\n` +
    `💚 Dana/Shopeepay: ${PAYMENT_DANA}`;

const PACKAGES = {
    '1bulan':  { label: '1 Bulan',  days: 30,  price: parseInt(process.env.PRICE_1BULAN  || '50000')  },
    '3bulan':  { label: '3 Bulan',  days: 90,  price: parseInt(process.env.PRICE_3BULAN  || '125000') },
    '6bulan':  { label: '6 Bulan',  days: 180, price: parseInt(process.env.PRICE_6BULAN  || '200000') },
    '1tahun':  { label: '1 Tahun',  days: 365, price: parseInt(process.env.PRICE_1TAHUN  || '350000') },
};

const DATA_FILE        = './bot_users.json';
const AUTH_BASE_FOLDER = './auth_states';

const tgBot = new Telegraf(TELEGRAM_BOT_TOKEN);
const userSessions  = new Map();
const kickSelections = new Map();

if (!fs.existsSync(AUTH_BASE_FOLDER)) fs.mkdirSync(AUTH_BASE_FOLDER, { recursive: true });

// ══════════════════════════════════════════════════════════════
//  STEALTH: HUMAN DELAY FUNCTION
// ══════════════════════════════════════════════════════════════

async function humanDelay(minMs = 1200, maxMs = 3800) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    return new Promise(resolve => setTimeout(resolve, delay));
}

function getRandomBrowserProfile() {
    const profiles = [
        ['Windows', 'Edge', '121.0.0'],
        ['Windows', 'Chrome', '122.0.0'],
        ['Mac OS', 'Safari', '17.2'],
        ['iPhone', 'WA', '2.24.4'],
        ['Android', 'WhatsApp', '2.24.4']
    ];
    return profiles[Math.floor(Math.random() * profiles.length)];
}

function getEncryptedAuthFolder(userId) {
    const hash = crypto.createHash('sha256').update(`wa_${userId}_v2_salt`).digest('hex').substring(0, 32);
    return path.join(AUTH_BASE_FOLDER, hash);
}

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
//  REPLY KEYBOARDS
// ══════════════════════════════════════════════════════════════

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
//  QR SENDER
// ══════════════════════════════════════════════════════════════

async function sendQR(ctx, qr) {
    if (!qr) {
        await ctx.reply(`❌ QR code kosong, coba lagi.`);
        return;
    }
    
    await humanDelay(1800, 3600);
    
    const sendAsText = Math.random() < 0.25;
    
    try {
        if (!sendAsText) {
            const qrBuffer = await QRCode.toBuffer(qr, {
                type: 'png',
                width: 1024,
                margin: 2,
                color: { dark: '#000000', light: '#FFFFFF' },
                scale: 8
            });
            
            await ctx.replyWithPhoto(
                { source: qrBuffer },
                {
                    caption: `📱 *SCAN QR CODE DI WHATSAPP*\n\n` +
                             `1. Buka WhatsApp di HP\n` +
                             `2. Tap ⋮ (titik tiga) → *Perangkat Tertaut*\n` +
                             `3. Tap *Tautkan Perangkat*\n` +
                             `4. Scan QR code di atas\n\n` +
                             `_Kalo gagal scan, screenshot aja terus scan dari galeri_`,
                    parse_mode: 'Markdown'
                }
            );
        } else {
            await ctx.reply(
                `📱 *SCAN QR CODE MANUAL*\n\n` +
                `1. Buka WhatsApp → Perangkat Tertaut\n` +
                `2. Tautkan Perangkat\n` +
                `3. Scan kode dibawah (screenshot):\n\n` +
                `\`\`\`\n${qr}\n\`\`\``,
                { parse_mode: 'Markdown' }
            );
        }
    } catch (err) {
        await ctx.reply(
            `📱 *SCAN QR CODE (Teks Backup)*\n\n\`\`\`\n${qr}\n\`\`\``,
            { parse_mode: 'Markdown' }
        );
    }
}

// ══════════════════════════════════════════════════════════════
//  STEALTH KICK
// ══════════════════════════════════════════════════════════════

async function stealthKick(sock, groupId, jids, onProgress) {
    const batchSize = 2;
    let totalKicked = 0;
    for (let i = 0; i < jids.length; i += batchSize) {
        const batch = jids.slice(i, i + batchSize);
        try {
            await sock.groupParticipantsUpdate(groupId, batch, 'remove');
            totalKicked += batch.length;
            if (onProgress) onProgress(totalKicked);
        } catch (err) {
            console.log(`Kick error: ${err.message}`);
        }
        if (i + batchSize < jids.length) {
            await humanDelay(4000, 9000);
        }
    }
    return totalKicked;
}

// ══════════════════════════════════════════════════════════════
//  LOGIN
// ══════════════════════════════════════════════════════════════

async function startLogin(ctx, userId) {
    if (userSessions.has(userId)) {
        const old = userSessions.get(userId);
        if (old.qrTimer) clearTimeout(old.qrTimer);
        try { old.sock.end(new Error('restart')); } catch (_) {}
        userSessions.delete(userId);
    }

    const authFolder = getEncryptedAuthFolder(userId);
    const { version } = await fetchLatestBaileysVersion();
    const browserProfile = getRandomBrowserProfile();
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
        auth: state,
        browser: browserProfile,
        logger: pino({ level: 'error' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 30000,
        keepAliveIntervalMs: 25000,
        version,
        generateHighQualityLinkPreview: false,
        printQRInTerminal: false,
    });

    const session = {
        sock, saveCreds,
        qrTimer: null, lastQR: null, qrBlocked: false,
        loggedIn: false, groupId: null, groupName: null, members: []
    };
    userSessions.set(userId, session);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            session.lastQR = qr;
            if (!session.qrBlocked) {
                session.qrBlocked = true;
                await sendQR(ctx, qr);
                session.qrTimer = setTimeout(async () => {
                    if (!session.loggedIn) {
                        session.qrBlocked = false;
                        await ctx.reply(`⏱ *QR expired.*\nKetik /refreshqr untuk QR baru.`, { parse_mode: 'Markdown' });
                    }
                }, 5 * 60 * 1000);
            }
        }

        if (connection === 'close') {
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
            session.loggedIn = true;
            if (session.qrTimer) clearTimeout(session.qrTimer);
            try { await sock.sendPresenceUpdate('available'); } catch(_) {}
            const kb = isAdmin(userId) ? KB_ADMIN_MAIN : KB_MAIN;
            await ctx.reply(
                `✅ *LOGIN WHATSAPP BERHASIL!*\n\nPilih menu di keyboard bawah.`,
                { parse_mode: 'Markdown', ...kb }
            );
        }
    });

    sock.ev.on('creds.update', () => {
        saveCreds();
    });
}

// ══════════════════════════════════════════════════════════════
//  KICK MENU BUILDER
// ══════════════════════════════════════════════════════════════

function buildMemberKeyboard(members, selected) {
    const buttons = [];
    for (const m of members) {
        const isSelected = selected.has(m.jid);
        buttons.push([Markup.button.callback(`${isSelected ? '✅' : '⬜'} ${m.name.substring(0, 25)}`, `toggle_${m.jid}`)]);
    }
    buttons.push([Markup.button.callback('🔨 KICK TERPILIH', 'do_kick')]);
    buttons.push([Markup.button.callback('❌ BATAL', 'cancel_kick')]);
    return { reply_markup: { inline_keyboard: buttons } };
}

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

    if (digits.startsWith('0')) return '62' + digits.slice(1);
    if (digits.startsWith('62')) return digits;
    if (digits.length >= 9) return '62' + digits;

    return digits.length >= 7 ? digits : null;
}

const vcfPending = new Map();

async function addContactsToGroup(ctx, userId, contacts, groupId, groupName) {
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) {
        return ctx.reply('❌ *Session WA berakhir.* Tekan *🔑 Login WhatsApp*.', { parse_mode: 'Markdown' });
    }

    const total  = contacts.length;
    let berhasil = 0, gagal = 0, notWA = 0;

    const statusMsg = await ctx.reply(`⏳ *Menambahkan ${total} kontak ke grup...*`, { parse_mode: 'Markdown' });

    for (let i = 0; i < contacts.length; i++) {
        const c = contacts[i];
        try {
            const [result] = await session.sock.onWhatsApp(c.phone);
            if (!result || !result.exists) { notWA++; continue; }
            await session.sock.groupParticipantsUpdate(groupId, [result.jid], 'add');
            berhasil++;
            await humanDelay(1200, 2800);
            
            if ((i + 1) % 3 === 0 || i + 1 === total) {
                try {
                    await ctx.telegram.editMessageText(
                        ctx.chat.id, statusMsg.message_id, null,
                        `⏳ Progres: ${i + 1}/${total}\n✅ Berhasil: ${berhasil} | 📵 No WA: ${notWA}`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (_) {}
            }
        } catch (err) {
            gagal++;
            await humanDelay(800, 1500);
        }
    }

    let hasil = `╔${DIVIDER}╗\n║  HASIL IMPORT VCF\n╚${DIVIDER}╝\n\n`;
    hasil += `🎯 *Grup:* ${groupName}\n\n`;
    hasil += `${DIVIDER_THIN}\n`;
    hasil += `✅ *Berhasil ditambah:* ${berhasil} kontak\n`;
    hasil += `📵 *Tidak punya WA:* ${notWA} kontak\n`;
    hasil += `❌ *Error:* ${gagal} kontak\n`;

    await ctx.reply(hasil, { parse_mode: 'Markdown' });
    vcfPending.delete(userId);
}

// ══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS (DEFINED BEFORE HEARS)
// ══════════════════════════════════════════════════════════════

tgBot.start(async (ctx) => {
    const userId   = ctx.from.id;
    const name     = ctx.from.first_name || 'User';
    const status   = getUserStatus(userId);
    const loggedIn = userSessions.get(userId)?.loggedIn;

    if (isAdmin(userId)) {
        const kb = loggedIn ? KB_ADMIN_MAIN : KB_ADMIN_PRE;
        return ctx.reply(
            `╔${DIVIDER}╗\n║  ${BOT_NAME}\n╚${DIVIDER}╝\n\n` +
            `👑 *Selamat datang, Admin ${esc(name)}!*\n\n` +
            `${DIVIDER_THIN}\n` +
            (loggedIn ? `✅ WA: *Terhubung*\n\n*Pilih menu di keyboard bawah:*` : `🔴 WA: *Belum login*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

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
            (loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

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
            (loggedIn ? `📡 WA: *Terhubung* ✅` : `🔴 WA: *Belum login*`),
            { parse_mode: 'Markdown', ...kb }
        );
    }

    if (status === 'expired' || status === 'trial_expired') {
        return ctx.reply(
            `⚠️ *Akses lo sudah berakhir.*\nPerpanjang untuk bisa pakai lagi!`,
            { parse_mode: 'Markdown', ...KB_LANDING }
        );
    }

    await ctx.reply(
        `👋 *Halo ${esc(name)}!*\n\n` +
        `Bot ini membantu lo *kick anggota grup WhatsApp*.\n\n` +
        `🎁 *COBA GRATIS ${TRIAL_DURATION_HOURS} JAM*\n` +
        `⭐ *PREMIUM* — akses penuh\n\n` +
        `Pilih di keyboard bawah:`,
        { parse_mode: 'Markdown', ...KB_LANDING }
    );
});

// COMMANDS
tgBot.command('trial', async (ctx) => {
    const user   = ctx.from;
    const status = getUserStatus(user.id);

    if (status === 'admin')   return ctx.reply('👑 Lo adalah admin.', KB_ADMIN_PRE);
    if (status === 'regular') return ctx.reply('✅ Lo sudah punya akses reguler.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ *Masih trial.* Sisa: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }

    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ Gagal: ${result.reason}`);

    await ctx.reply(
        `🎉 *TRIAL AKTIF!*\n\n✅ ${TRIAL_DURATION_HOURS} jam\n⏱ Berakhir: ${formatDate(result.expiresAt.toISOString())}\n\n` +
        `Tekan *🔑 Login WhatsApp* untuk mulai!`,
        { parse_mode: 'Markdown', ...KB_PRE_LOGIN }
    );
});

async function showPriceMenu(ctx) {
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback(`📦 1 Bulan — ${formatRupiah(PACKAGES['1bulan'].price)}`, 'buy_1bulan')],
        [Markup.button.callback(`📦 3 Bulan — ${formatRupiah(PACKAGES['3bulan'].price)}`, 'buy_3bulan')],
        [Markup.button.callback(`📦 6 Bulan — ${formatRupiah(PACKAGES['6bulan'].price)}`, 'buy_6bulan')],
        [Markup.button.callback(`🏆 1 Tahun — ${formatRupiah(PACKAGES['1tahun'].price)}`, 'buy_1tahun')],
    ]);

    await ctx.reply(
        `╔${DIVIDER}╗\n║  PAKET HARGA\n╚${DIVIDER}╝\n\n` +
        `📦 1 Bulan → ${formatRupiah(PACKAGES['1bulan'].price)}\n` +
        `📦 3 Bulan → ${formatRupiah(PACKAGES['3bulan'].price)}\n` +
        `📦 6 Bulan → ${formatRupiah(PACKAGES['6bulan'].price)}\n` +
        `🏆 1 Tahun → ${formatRupiah(PACKAGES['1tahun'].price)}\n\n` +
        `Pilih paket di bawah:`,
        { parse_mode: 'Markdown', ...keyboard }
    );
}

tgBot.command('beli', showPriceMenu);

Object.keys(PACKAGES).forEach(pkgKey => {
    tgBot.action(`buy_${pkgKey}`, async (ctx) => {
        await ctx.answerCbQuery();
        const pkg  = PACKAGES[pkgKey];
        const user = ctx.from;

        addPendingPayment(user, pkgKey);

        for (const adminId of ADMIN_IDS) {
            try {
                const approveKeyboard = Markup.inlineKeyboard([
                    [Markup.button.callback(`✅ Approve`, `admin_approve_${user.id}_${pkgKey}`), Markup.button.callback(`❌ Reject`, `admin_reject_${user.id}`)]
                ]);
                await tgBot.telegram.sendMessage(adminId, `🔔 *Permintaan Beli*\n👤 ${userDisplayName(user)}\n📦 ${pkg.label} (${formatRupiah(pkg.price)})`, { parse_mode: 'Markdown', ...approveKeyboard });
            } catch (_) {}
        }

        await ctx.reply(
            `✅ *Permintaan diterima!*\n\n💰 ${formatRupiah(pkg.price)}\n${PAYMENT_INFO}\n\nKonfirmasi ke ${PAYMENT_CONTACT} dengan format: \`KICKER-${user.id}-${pkgKey}\``,
            { parse_mode: 'Markdown' }
        );
    });
});

tgBot.action(/^admin_approve_(\d+)_(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const targetId = parseInt(ctx.match[1]);
    const pkgKey   = ctx.match[2];
    const result   = approvePayment(targetId, pkgKey);

    if (!result.success) return ctx.editMessageText(`❌ Gagal: ${result.reason}`);

    await ctx.editMessageText(`✅ *APPROVED!*\nID: ${targetId}\nPaket: ${result.pkg.label}\nAktif hingga: ${formatDate(result.expiresAt.toISOString())}`, { parse_mode: 'Markdown' });

    try {
        await tgBot.telegram.sendMessage(targetId, `🎉 *PEMBAYARAN DIKONFIRMASI!*\n\n📦 ${result.pkg.label}\n📅 Aktif hingga: ${formatDate(result.expiresAt.toISOString())}\n\nTekan *🔑 Login WhatsApp* untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (_) {}
});

tgBot.action(/^admin_reject_(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const targetId = parseInt(ctx.match[1]);
    const data = loadData();
    const idx = data.pendingPayment.findIndex(p => p.id === targetId);
    if (idx >= 0) data.pendingPayment.splice(idx, 1);
    saveData(data);

    await ctx.editMessageText(`❌ *REJECTED*\nID: ${targetId}`, { parse_mode: 'Markdown' });

    try {
        await tgBot.telegram.sendMessage(targetId, `❌ *Pembayaran ditolak.*\nHubungi ${PAYMENT_CONTACT}`, { parse_mode: 'Markdown', ...KB_LANDING });
    } catch (_) {}
});

tgBot.command('login', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply('✅ *Lo udah login!*', { parse_mode: 'Markdown' });
    }
    await ctx.reply(`🔄 *Memulai koneksi...*`, { parse_mode: 'Markdown' });
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('refreshqr', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Belum ada sesi.', { parse_mode: 'Markdown' });
    if (session.loggedIn) return ctx.reply('✅ Sudah login!');
    if (!session.lastQR) return ctx.reply('⏳ QR belum tersedia.');

    await sendQR(ctx, session.lastQR);
});

tgBot.command('logout', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Belum login!');
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

tgBot.command('groups', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ Tidak ada grup.');

        const isTrial = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ Trial: hanya 1 grup\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `${i+1}. ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('select', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    let groupName = ctx.message.text.replace('/select', '').trim().replace(/^["']|["']$/g, '');
    if (!groupName) return ctx.reply('Format: /select "Nama Grup"', { parse_mode: 'Markdown' });

    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        const isTrial = isTrialOnly(userId);
        const allowedGroups = isTrial ? groups.slice(0, 1) : groups;
        const target = allowedGroups.find(g => g.subject.toLowerCase() === groupName.toLowerCase());

        if (!target) return ctx.reply(`❌ Grup "${groupName}" tidak ditemukan.`, { parse_mode: 'Markdown' });

        session.groupId = target.id;
        session.groupName = target.subject;
        await ctx.reply(`✅ *Grup terpilih!*\n🎯 ${target.subject}\n👥 ${target.participants?.length || 0} anggota\n\nTekan *🔴 Kick Menu* untuk mulai.`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('kickmenu', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });
    await showKickMenu(ctx, userId, session);
});

tgBot.command('buatgrup', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    const namaGrup = ctx.message.text.replace('/buatgrup', '').trim().replace(/^["']|["']$/g, '');
    if (!namaGrup) return ctx.reply('Format: /buatgrup "Nama Grup"', { parse_mode: 'Markdown' });

    await ctx.reply(`⏳ *Membuat grup "${namaGrup}"...*`, { parse_mode: 'Markdown' });

    try {
        const result = await session.sock.groupCreate(namaGrup, []);
        session.groupId = result.id;
        session.groupName = namaGrup;

        let inviteLink = '-';
        try {
            const code = await session.sock.groupInviteCode(result.id);
            inviteLink = `https://chat.whatsapp.com/${code}`;
        } catch (_) {}

        await ctx.reply(`✅ *Grup berhasil dibuat!*\n\n${namaGrup}\n🔗 ${inviteLink}\n\nTekan *🔴 Kick Menu* untuk mulai.`, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Gagal: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.command('importvcf', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });

    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(`📎 *Kirim file .vcf sekarang* ke chat ini.`, { parse_mode: 'Markdown' });
});

tgBot.command('status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.command('myaccount', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') return ctx.reply(`👑 Admin bot.`, { parse_mode: 'Markdown' });
    const u = getUser(userId);
    if (!u) return ctx.reply(`Belum terdaftar. Tekan *🎁 Coba Gratis*`, { parse_mode: 'Markdown', ...KB_LANDING });
    await ctx.reply(`👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`, { parse_mode: 'Markdown' });
});

tgBot.command('help', async (ctx) => {
    await ctx.reply(
        "╔━━━━━━━━━━━━━━━━━━━━━━╗\n" +
        "║  PANDUAN PENGGUNAAN\n" +
        "╚━━━━━━━━━━━━━━━━━━━━━━╝\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*📌 CARA PAKAI BOT:*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        "*1. Daftar & Aktifkan Akses*\n" +
        "   Tekan 🎁 Coba Gratis untuk trial gratis 24 jam\n" +
        "   Tekan ⭐ Premium untuk beli paket reguler\n\n" +
        "*2. Login WhatsApp*\n" +
        "   Tekan 🔑 Login WhatsApp\n" +
        "   → Scan QR di WA lo\n\n" +
        "*3. Pilih Grup*\n" +
        "   Tekan 📋 Daftar Grup — Lihat semua grup\n" +
        "   Tekan 🎯 Pilih Grup → ketik: /select \"Nama Grup\"\n\n" +
        "*4. Kick Anggota*\n" +
        "   Tekan 🔴 Kick Menu\n" +
        "   → Centang anggota yang mau dikick\n" +
        "   → Tekan tombol \"Kick\"\n\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n" +
        "*⚠️ PENTING:*\n" +
        "• Bot hanya bisa kick jika lo adalah *admin grup*\n" +
        "• Akun WA yang login harus jadi *admin* di grup target\n" +
        "• Trial hanya bisa akses *1 grup*\n" +
        "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n\n" +
        `Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`,
        { parse_mode: 'Markdown' }
    );
});

tgBot.command('pendingpayment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await ctx.reply(msg);
});

tgBot.command('userlist', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('⛔ Akses ditolak.');

    const users = getAllUsers();
    if (users.length === 0) return ctx.reply('*Belum ada user terdaftar.*', { parse_mode: 'Markdown' });

    const now = new Date();
    const actives = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return exp && new Date(exp) > now;
    });
    const expired = users.filter(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        return !exp || new Date(exp) <= now;
    });

    let msg = "╔━━━━━━━━━━━━━━━━━━━━━━╗\n";
    msg += "║  DAFTAR USER\n";
    msg += "╚━━━━━━━━━━━━━━━━━━━━━━╝\n\n";
    msg += `✅ Aktif: ${actives.length}  |  ❌ Expired: ${expired.length}\n\n`;

    if (actives.length > 0) {
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        msg += "✅ USER AKTIF:\n";
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        
        for (let i = 0; i < actives.length; i++) {
            const u = actives[i];
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            const role = u.role === 'trial' ? '🎁 Trial' : '⭐ Reguler';
            const sisa = formatCountdown(exp);
            
            msg += `${i + 1}. ${userDisplayName(u)}\n`;
            msg += `   ID: \`${u.id}\` | ${role}\n`;
            msg += `   Exp: ${formatDate(exp)} (${sisa})\n\n`;
        }
    }

    if (expired.length > 0 && expired.length <= 10) {
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        msg += "❌ EXPIRED:\n";
        msg += "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄\n";
        expired.forEach((u, i) => {
            const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
            msg += `${i + 1}. ${userDisplayName(u)} | ID: \`${u.id}\`\n`;
            msg += `   Expired: ${formatDate(exp)}\n\n`;
        });
    } else if (expired.length > 10) {
        msg += `\n_(+${expired.length} user expired tidak ditampilkan)_\n\n`;
    }

    msg += `\n/revokeuser [id] — Cabut akses`;

    await ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  HEARS HANDLERS (NON-COMMAND TEXT BUTTONS)
// ══════════════════════════════════════════════════════════════

tgBot.hears('🎁 Coba Gratis (Trial)', async (ctx) => {
    const user = ctx.from;
    const status = getUserStatus(user.id);
    if (status === 'regular') return ctx.reply('✅ Sudah punya akses.', getKeyboard(user.id));
    if (status === 'trial') {
        const u = getUser(user.id);
        return ctx.reply(`⏱ Masih trial: ${formatCountdown(u.trialExpiresAt)}`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    }
    const result = startTrial(user);
    if (!result.success) return ctx.reply(`❌ ${result.reason}`);
    await ctx.reply(`🎉 *TRIAL AKTIF!*\n\nTekan *🔑 Login WhatsApp* untuk mulai.`, { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
});

tgBot.hears('⭐ Premium', async (ctx) => { await showPriceMenu(ctx); });
tgBot.hears('❓ Bantuan', async (ctx) => { await ctx.reply(`Butuh bantuan? Hubungi ${PAYMENT_CONTACT}`, { parse_mode: 'Markdown' }); });

tgBot.hears('🔑 Login WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (session && session.loggedIn) {
        return ctx.reply('✅ *Lo udah login!*', { parse_mode: 'Markdown' });
    }
    await ctx.reply(`🔄 *Memulai koneksi...*`, { parse_mode: 'Markdown' });
    try {
        await startLogin(ctx, userId);
    } catch (err) {
        await ctx.reply(`❌ *Gagal:* ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.hears('📊 Status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('👤 Akun Saya', async (ctx) => {
    const userId = ctx.from.id;
    const status = getUserStatus(userId);
    if (status === 'admin') return ctx.reply(`👑 Admin bot.`, { parse_mode: 'Markdown' });
    const u = getUser(userId);
    if (!u) return ctx.reply(`Belum terdaftar. Tekan *🎁 Coba Gratis*`, { parse_mode: 'Markdown', ...KB_LANDING });
    await ctx.reply(`👤 ${userDisplayNameEsc(u)}\n🆔 ${u.id}\nStatus: ${status}\nExp: ${u.expiresAt ? formatDate(u.expiresAt) : u.trialExpiresAt ? formatDate(u.trialExpiresAt) : '-'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('📋 Daftar Grup', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });

    await ctx.reply('⏳ *Mengambil daftar grup...*', { parse_mode: 'Markdown' });
    try {
        const chats = await session.sock.groupFetchAllParticipating();
        const groups = Object.values(chats);
        if (groups.length === 0) return ctx.reply('❌ Tidak ada grup.');

        const isTrial = isTrialOnly(userId);
        const displayGroups = isTrial ? groups.slice(0, 1) : groups;

        let msg = `╔${DIVIDER}╗\n║  DAFTAR GRUP\n╚${DIVIDER}╝\n\n`;
        if (isTrial) msg += `⚠️ Trial: hanya 1 grup\n\n`;
        displayGroups.forEach((g, i) => {
            msg += `${i+1}. ${g.subject}\n   👥 ${g.participants?.length || 0} anggota\n\n`;
        });
        await ctx.reply(msg, { parse_mode: 'Markdown' });
    } catch (err) {
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

tgBot.hears('🎯 Pilih Grup', requireAccess, async (ctx) => {
    await ctx.reply(`Format: /select "Nama Grup"\n\nContoh: /select "Arisan RT 05"`, { parse_mode: 'Markdown' });
});

tgBot.hears('➕ Buat Grup WA', requireAccess, async (ctx) => {
    await ctx.reply(`Format: /buatgrup "Nama Grup"\n\nContoh: /buatgrup "Arisan RT 05"`, { parse_mode: 'Markdown' });
});

tgBot.hears('📥 Import VCF', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });

    vcfPending.set(userId, { waitingFile: true, groupId: session.groupId, groupName: session.groupName });
    await ctx.reply(`📎 *Kirim file .vcf sekarang* ke chat ini.`, { parse_mode: 'Markdown' });
});

tgBot.hears('🔴 Kick Menu', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ *Login dulu!*', { parse_mode: 'Markdown' });
    if (!session.groupId) return ctx.reply('❌ *Pilih grup dulu!*', { parse_mode: 'Markdown' });
    await showKickMenu(ctx, userId, session);
});

tgBot.hears('📡 Status', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    const accStatus = getUserStatus(userId);
    const u = getUser(userId);

    let waStatus = '🔴 Belum Login';
    if (session && !session.loggedIn) waStatus = '🟡 Menunggu QR';
    if (session && session.loggedIn) waStatus = '🟢 Terhubung';

    let accLine = '';
    if (accStatus === 'admin') accLine = '👑 Admin';
    else if (accStatus === 'regular') accLine = `⭐ Reguler (${formatCountdown(u?.expiresAt)})`;
    else if (accStatus === 'trial') accLine = `🎁 Trial (${formatCountdown(u?.trialExpiresAt)})`;

    await ctx.reply(`📡 WA: ${waStatus}\n🏷️ Akun: ${accLine}\n🎯 Grup: ${session?.groupName || 'Belum pilih'}`, { parse_mode: 'Markdown' });
});

tgBot.hears('🚪 Logout WhatsApp', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const session = userSessions.get(userId);
    if (!session) return ctx.reply('❌ Belum login!');
    try {
        if (session.qrTimer) clearTimeout(session.qrTimer);
        try { session.sock.end(new Error('logout')); } catch (_) {}
        const authFolder = getEncryptedAuthFolder(userId);
        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        userSessions.delete(userId);
        kickSelections.delete(userId);
        await ctx.reply('✅ *Logout berhasil.*', { parse_mode: 'Markdown', ...KB_PRE_LOGIN });
    } catch (err) {
        await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
        userSessions.delete(userId);
    }
});

tgBot.hears('📋 Pending Payment', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const list = getAllPendingPayments();
    if (list.length === 0) return ctx.reply(`📭 Kosong.`);
    let msg = `PENDING: ${list.length}\n\n`;
    for (const p of list) {
        msg += `👤 ${p.id}\n📦 ${p.packageKey}\n📅 ${formatDate(p.requestedAt)}\n\n`;
    }
    await ctx.reply(msg);
});

tgBot.hears('👥 User List', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const users = getAllUsers();
    if (users.length === 0) return ctx.reply(`Belum ada user.`);
    let msg = `TOTAL: ${users.length}\n\n`;
    users.slice(0, 20).forEach(u => {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        msg += `${u.id} | ${u.role} | ${exp ? formatDate(exp) : '-'}\n`;
    });
    await ctx.reply(msg);
});

// ══════════════════════════════════════════════════════════════
//  DOCUMENT HANDLER (VCF)
// ══════════════════════════════════════════════════════════════

tgBot.on('document', requireAccess, async (ctx) => {
    const userId = ctx.from.id;
    const pending = vcfPending.get(userId);
    if (!pending || !pending.waitingFile) return;

    const doc = ctx.message.document;
    const fname = doc.file_name || '';

    if (!fname.toLowerCase().endsWith('.vcf')) {
        return ctx.reply('⚠️ *File harus .vcf*', { parse_mode: 'Markdown' });
    }

    await ctx.reply('⏳ *Membaca file VCF...*', { parse_mode: 'Markdown' });

    try {
        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const resp = await fetch(fileLink.href);
        const vcfText = await resp.text();
        const contacts = parseVCF(vcfText);

        if (contacts.length === 0) {
            vcfPending.delete(userId);
            return ctx.reply('❌ *Tidak ada nomor valid.*', { parse_mode: 'Markdown' });
        }

        pending.contacts = contacts;
        pending.waitingFile = false;
        vcfPending.set(userId, pending);

        const keyboard = Markup.inlineKeyboard([
            [Markup.button.callback(`✅ Tambah Semua (${contacts.length})`, 'vcf_add_all')],
            [Markup.button.callback('❌ Batal', 'vcf_cancel')]
        ]);

        await ctx.reply(`📊 *${contacts.length} kontak* ditemukan.\n\nTambahkan sekarang?`, { parse_mode: 'Markdown', ...keyboard });
    } catch (err) {
        vcfPending.delete(userId);
        await ctx.reply(`❌ Error: ${err.message}`, { parse_mode: 'Markdown' });
    }
});

// ══════════════════════════════════════════════════════════════
//  INLINE BUTTON HANDLERS
// ══════════════════════════════════════════════════════════════

tgBot.action('vcf_add_all', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const pending = vcfPending.get(userId);
    if (!pending || !pending.contacts) return ctx.reply('❌ Data tidak ditemukan.');

    await addContactsToGroup(ctx, userId, pending.contacts, pending.groupId, pending.groupName);
});

tgBot.action('vcf_cancel', async (ctx) => {
    vcfPending.delete(ctx.from.id);
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Import dibatalkan.*', { parse_mode: 'Markdown' });
});

tgBot.action(/^toggle_(.+)$/, async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');

    const jid = ctx.match[1];
    const session = userSessions.get(userId);
    if (!session || !kickSelections.has(userId)) return ctx.answerCbQuery('Session expired.');

    const selected = kickSelections.get(userId);
    if (selected.has(jid)) {
        selected.delete(jid);
        await ctx.answerCbQuery('❌ Dihapus');
    } else {
        selected.add(jid);
        await ctx.answerCbQuery('✅ Ditambahkan');
    }
    try { await ctx.editMessageReplyMarkup(buildMemberKeyboard(session.members, selected).reply_markup); } catch (_) {}
});

tgBot.action('do_kick', async (ctx) => {
    const userId = ctx.from.id;
    if (!canUseBot(userId)) return ctx.answerCbQuery('⛔ Ditolak.');
    await ctx.answerCbQuery();

    const session = userSessions.get(userId);
    const selected = kickSelections.get(userId);
    if (!session || !session.loggedIn) return ctx.reply('❌ Session expired.');
    if (!selected || selected.size === 0) return ctx.reply('⚠️ *Belum ada yang dipilih!*', { parse_mode: 'Markdown' });

    const jidList = Array.from(selected);
    await ctx.reply(`⏳ *Mengkick ${jidList.length} anggota...*`, { parse_mode: 'Markdown' });

    const totalKicked = await stealthKick(session.sock, session.groupId, jidList, (progress) => {
        ctx.reply(`🦵 Progress: ${progress}/${jidList.length} terkick...`).catch(() => {});
    });

    kickSelections.set(userId, new Set());
    await ctx.reply(`✅ *Selesai!* ${totalKicked} orang dikick.`, { parse_mode: 'Markdown' });
});

tgBot.action('cancel_kick', async (ctx) => {
    kickSelections.set(ctx.from.id, new Set());
    await ctx.answerCbQuery('Dibatalkan');
    await ctx.reply('✖ *Kick dibatalkan.*', { parse_mode: 'Markdown' });
});

// ══════════════════════════════════════════════════════════════
//  AUTO EXPIRE NOTIF
// ══════════════════════════════════════════════════════════════

setInterval(async () => {
    const users = getAllUsers();
    const now = new Date();
    for (const u of users) {
        const exp = u.role === 'trial' ? u.trialExpiresAt : u.expiresAt;
        if (!exp) continue;
        const msLeft = new Date(exp) - now;
        if (msLeft > 0 && msLeft <= 24 * 60 * 60 * 1000 && !u.notifiedExpiry) {
            try {
                await tgBot.telegram.sendMessage(u.id, `⚠️ *Akses akan habis dalam ${formatCountdown(exp)}*\nPerpanjang: /beli`, { parse_mode: 'Markdown' });
                const data = loadData();
                const idx = data.users.findIndex(x => x.id === u.id);
                if (idx >= 0) data.users[idx].notifiedExpiry = true;
                saveData(data);
            } catch (_) {}
        }
    }
}, 60 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
//  LAUNCH
// ══════════════════════════════════════════════════════════════

tgBot.launch().then(() => {
    console.log('\n╔══════════════════════════════════════╗');
    console.log('║   WA KICKER BOT v4.2.1 FIXED      ║');
    console.log('╠══════════════════════════════════════╣');
    console.log(`║  Admin IDs  : ${ADMIN_IDS.join(', ')}`);
    console.log(`║  Trial      : ${TRIAL_DURATION_HOURS} jam`);
    console.log(`║  Stealth    : ACTIVE (human delays, randomized UA, encrypted sessions)`);
    console.log('╚══════════════════════════════════════╝\n');
});

process.on('SIGINT',  () => { tgBot.stop('SIGINT');  process.exit(); });
process.on('SIGTERM', () => { tgBot.stop('SIGTERM'); process.exit(); });
