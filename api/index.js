const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(express.json());
app.use(express.static('public'));

const ADMIN_KEY = process.env.ADMIN_KEY;
const QRISPY_TOKEN = process.env.QRISPY_TOKEN;
const QRISPY_API_URL = 'https://api.qrispy.id';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';
const ENCRYPT_KEY = process.env.ENCRYPT_KEY;

function encrypt(text) {
    if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset');
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(cookie => {
        const [name, ...rest] = cookie.trim().split('=');
        cookies[name] = rest.join('=');
    });
    return cookies;
}

let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 5000;

const rateLimitMap = new Map();
app.use((req, res, next) => {
    const ip = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim();
    if (dbCache && (dbCache.adminIP === ip || (dbCache.adminIPs && dbCache.adminIPs.includes(ip)))) return next();
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const requests = rateLimitMap.get(ip).filter(t => now - t < 60000);
    if (requests.length >= 60) return res.status(429).json({ error: 'Rate limit' });
    requests.push(now);
    rateLimitMap.set(ip, requests);
    next();
});

function getClientIP(req) { return (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim(); }
function isAdmin(req, adminKey) { if (adminKey === ADMIN_KEY) return true; const ip = getClientIP(req); if (dbCache && dbCache.adminIP === ip) return true; if (dbCache && dbCache.adminIPs && dbCache.adminIPs.includes(ip)) return true; return false; }

async function getDB() {
    const now = Date.now();
    if (dbCache && (now - dbCacheTime) < CACHE_TTL) return { ...dbCache, sha: dbCache.sha };
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], users: [], withdrawals: [], deposits: [], sha: null, adminIP: null, adminIPs: [], maintenance: false };
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        let parsed;
        try { parsed = JSON.parse(content); } catch(e) { const decrypted = decrypt(content); parsed = JSON.parse(decrypted); }
        dbCache = { ...parsed, sha: data.sha };
        dbCacheTime = now;
        return { ...dbCache, sha: data.sha };
    } catch (err) { return { products: [], orders: [], users: [], withdrawals: [], deposits: [], sha: null, adminIP: null, adminIPs: [], maintenance: false }; }
}

async function setDB(products, orders, oldSha, retryCount) {
    if (!retryCount) retryCount = 0;
    if (retryCount > 5) throw new Error('Save failed after 5 retries');
    const db = await getDB();
    const content = {
        products: products || db.products || [],
        orders: orders || db.orders || [],
        users: db.users || [],
        withdrawals: db.withdrawals || [],
        deposits: db.deposits || [],
        adminIP: db.adminIP || null,
        adminIPs: db.adminIPs || [],
        maintenance: db.maintenance || false,
        encrypted: true,
        updatedAt: new Date().toISOString()
    };
    const encryptedContent = encrypt(JSON.stringify(content));
    const updatedContent = Buffer.from(encryptedContent).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.message?.includes('SHA')) { await new Promise(r => setTimeout(r, 800)); const f = await getDB(); return setDB(products, orders, f.sha, retryCount + 1); }
        throw new Error('Save failed: ' + (e.message || res.status));
    }
    const d = await res.json();
    dbCache = { ...content, sha: d.content.sha };
    dbCacheTime = Date.now();
    return d.content.sha;
}

async function setAdminIP(ip) {
    const db = await getDB();
    const adminIPs = db.adminIPs || [];
    if (db.adminIP && !adminIPs.includes(db.adminIP)) adminIPs.push(db.adminIP);
    if (!adminIPs.includes(ip)) adminIPs.push(ip);
    const content = { products: db.products || [], orders: db.orders || [], users: db.users || [], withdrawals: db.withdrawals || [], deposits: db.deposits || [], adminIP: ip, adminIPs, maintenance: db.maintenance || false, encrypted: true, updatedAt: new Date().toISOString() };
    const encryptedContent = encrypt(JSON.stringify(content));
    const c = Buffer.from(encryptedContent).toString('base64');
    const r = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Set IP', content: c, sha: db.sha })
    });
    if (r.ok) { const d = await r.json(); dbCache = { ...content, sha: d.content.sha }; dbCacheTime = Date.now(); return true; }
    return false;
}

async function sendTelegramMessage(text) {
    try { if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }) }); } catch (e) {}
}

function sanitize(str) { if (!str) return ''; return String(str).replace(/[<>"'&]/g, m => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[m]); }
async function cancelQRISInQrispy(qrisId) { if (!QRISPY_TOKEN) return false; try { const r = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/cancel`, { method: 'POST', headers: { 'X-API-Token': QRISPY_TOKEN } }); return (await r.json()).status === 'success'; } catch (e) { return false; } }

function generateReferralCode(name) {
    const clean = name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4);
    const random = crypto.randomBytes(3).toString('hex').toUpperCase();
    return clean + random;
}

function validateAge(birthDate) {
    const today = new Date();
    const birth = new Date(birthDate);
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) { age--; }
    return age >= 12;
}

function hashPassword(password) {
    return crypto.createHash('sha256').update(password + 'YANTO_SALT').digest('hex');
}

function verifyPassword(password, hash) {
    return hashPassword(password) === hash;
}

function calculateCartDiscount(itemCount) {
    return Math.max(0, (itemCount - 1) * 500);
}

function getRefFromCookie(cookieHeader) {
    const cookies = parseCookies(cookieHeader);
    return cookies['yanto_ref'] || null;
}

async function processReferralReward(db, order, cookieHeader) {
    if (!order || order.referralRewarded) return;
    let refCode = null;
    const orderUser = (db.users || []).find(u => u.name.toLowerCase() === (order.customerName || '').toLowerCase());
    if (orderUser && orderUser.referredBy) { refCode = orderUser.referredBy; }
    if (!refCode && cookieHeader) { const cookies = parseCookies(cookieHeader); refCode = cookies['yanto_ref'] || null; }
    if (!refCode) return;
    const referrer = (db.users || []).find(u => u.referralCode === refCode);
    if (referrer) { referrer.referralCount = (referrer.referralCount || 0) + 1; referrer.discountBalance = (referrer.discountBalance || 0) + 500; order.referralRewarded = true; }
}

// Auto tasks
setInterval(async () => { try { await fetch('https://stockyanto.vercel.app/api/health'); } catch (e) {} }, 20000);
setInterval(async () => { try { const db = await getDB(); const n = new Date(); let c = 0; for (const o of db.orders) { if (o.status === 'pending' && o.expiredAt && new Date(o.expiredAt) < n) { o.status = 'expired'; c++; } } if (c > 0) await setDB(db.products, db.orders, db.sha); } catch (e) {} }, 30000);

// ✅ AUTO-CHECK DEPOSIT (SETIAP 10 DETIK)
setInterval(async () => {
    try {
        const db = await getDB();
        if (!db.deposits) db.deposits = [];
        let changed = false;
        for (const dep of db.deposits) {
            if (dep.status === 'pending' && dep.qrisId && QRISPY_TOKEN) {
                try {
                    const r = await fetch(`${QRISPY_API_URL}/api/payment/qris/${dep.qrisId}/status`, { headers: { 'X-API-Token': QRISPY_TOKEN } });
                    const d = await r.json();
                    if (d.status === 'success' && d.data.status === 'paid') {
                        dep.status = 'paid';
                        dep.paidAt = new Date().toISOString();
                        const user = (db.users || []).find(u => u.id === dep.userId);
                        if (user) {
                            user.discountBalance = (user.discountBalance || 0) + dep.amount;
                        }
                        changed = true;
                    }
                } catch(e) {}
            }
        }
        if (changed) await setDB(db.products, db.orders, db.sha);
    } catch(e) {}
}, 10000);

// ========== PUBLIC ==========
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
app.get('/api/ping-db', async (req, res) => { try { const db = await getDB(); res.json({ status: 'ok', products: (db.products || []).length, orders: (db.orders || []).length, users: (db.users || []).length, withdrawals: (db.withdrawals || []).length, deposits: (db.deposits || []).length, encrypted: db.encrypted || false }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/public-stats', async (req, res) => {
    try {
        const db = await getDB();
        const paid = (db.orders || []).filter(o => o.status === 'paid');
        const today = new Date().toISOString().split('T')[0];
        const soldMap = {}; paid.forEach(o => { soldMap[o.productId] = (soldMap[o.productId] || 0) + 1; });
        res.json({ success: true, totalProducts: (db.products || []).filter(p => p.stock > 0).length, todayOrders: paid.filter(o => (o.paidAt || o.createdAt).startsWith(today)).length, soldMap, maintenance: db.maintenance || false });
    } catch (e) { res.status(500).json({ success: false }); }
});

// ========== REFERRAL APPLY ==========
app.get('/api/referral/apply', async (req, res) => {
    const { ref } = req.query;
    if (!ref) return res.json({ success: false });
    try {
        const db = await getDB();
        const referrer = (db.users || []).find(u => u.referralCode === ref);
        if (!referrer) return res.json({ success: false, message: 'Kode referral tidak ditemukan' });
        referrer.referralClicks = (referrer.referralClicks || 0) + 1;
        await setDB(db.products, db.orders, db.sha);
        res.setHeader('Set-Cookie', 'yanto_ref=' + ref + '; Path=/; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
        res.json({ success: true, message: 'Referral tersimpan!' });
    } catch(e) { res.json({ success: false }); }
});

// ========== AUTH ==========
app.post('/api/register', async (req, res) => {
    const { name, birthDate, password } = req.body;
    if (!name || !birthDate || !password) { return res.status(400).json({ error: 'Data tidak lengkap' }); }
    if (!validateAge(birthDate)) { return res.status(400).json({ error: 'Minimal umur 12 tahun' }); }
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const db = await getDB();
            if (!db.users) db.users = [];
            if (db.users.find(u => u.name.toLowerCase() === name.toLowerCase())) { return res.status(400).json({ error: 'Nama sudah terdaftar' }); }
            const refCode = getRefFromCookie(req.headers.cookie);
            const user = { id: Date.now(), name: sanitize(name), birthDate, password: hashPassword(password), referralCode: generateReferralCode(name), referredBy: refCode || null, referralCount: 0, referralClicks: 0, discountBalance: 0, createdAt: new Date().toISOString() };
            db.users.push(user);
            await setDB(db.products, db.orders, db.sha);
            return res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: 0, referralClicks: 0, discountBalance: 0, referredBy: user.referredBy } });
        } catch (e) { lastError = e.message; if (attempt < 3) await new Promise(r => setTimeout(r, 500)); }
    }
    res.status(500).json({ error: 'Save failed: ' + lastError });
});

app.post('/api/login', async (req, res) => {
    const { name, password } = req.body;
    const db = await getDB();
    const user = (db.users || []).find(u => u.name.toLowerCase() === name.toLowerCase());
    if (!user || !verifyPassword(password, user.password)) { return res.status(401).json({ error: 'Nama atau password salah' }); }
    const token = crypto.randomBytes(32).toString('hex');
    user.token = token;
    if (!user.referredBy) { const refCode = getRefFromCookie(req.headers.cookie); if (refCode) { user.referredBy = refCode; } }
    await setDB(db.products, db.orders, db.sha);
    res.setHeader('Set-Cookie', 'yanto_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
    res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0, referredBy: user.referredBy } });
});

app.post('/api/logout', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (token) { const db = await getDB(); const user = (db.users || []).find(u => u.token === token); if (user) { user.token = null; await setDB(db.products, db.orders, db.sha); } }
    res.setHeader('Set-Cookie', 'yanto_token=; Path=/; Max-Age=0');
    res.json({ success: true });
});

app.get('/api/user/profile', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, user: { name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0, referredBy: user.referredBy } });
});

app.get('/api/user/orders', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const orders = (db.orders || []).filter(o => o.customerName.toLowerCase() === user.name.toLowerCase());
    res.json({ success: true, orders: orders.slice(0, 50).map(o => ({ id: o.id, orderCode: o.orderCode, productName: o.productName, totalAmount: o.totalAmount || o.price, status: o.status, createdAt: o.createdAt })) });
});

// ========== DEPOSIT ==========
app.post('/api/user/deposit', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    if (!QRISPY_TOKEN) return res.status(500).json({ error: 'QRISPY not configured' });
    const { amount } = req.body;
    const depAmount = parseInt(amount);
    if (!depAmount || depAmount < 1000) return res.status(400).json({ error: 'Minimal deposit Rp 1.000' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const qrisRes = await fetch(QRISPY_API_URL + '/api/payment/qris/generate', {
            method: 'POST', headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount: depAmount })
        });
        const qrisData = await qrisRes.json();
        if (qrisData.status !== 'success') throw new Error(qrisData.message || 'Gagal generate QRIS');
        const depId = Date.now();
        if (!db.deposits) db.deposits = [];
        db.deposits.unshift({ id: depId, userId: user.id, userName: user.name, amount: depAmount, qrisId: qrisData.data.qris_id, qrisImage: qrisData.data.qris_image_url, expiredAt: qrisData.data.expired_at, status: 'pending', createdAt: new Date().toISOString() });
        await setDB(db.products, db.orders, db.sha);
        res.json({ success: true, depId, qrisImage: qrisData.data.qris_image_url, amount: depAmount, expiredAt: qrisData.data.expired_at });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/user/deposits', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    const deps = (db.deposits || []).filter(d => d.userId === user.id);
    res.json({ success: true, deposits: deps });
});

// ========== CHANGE PASSWORD ==========
app.post('/api/user/change-password', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Data tidak lengkap' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyPassword(oldPassword, user.password)) return res.status(400).json({ error: 'Password lama salah' });
    user.password = hashPassword(newPassword);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, message: 'Password berhasil diganti!' });
});

// ========== WITHDRAW ==========
app.post('/api/user/withdraw', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    const { amount, paymentMethod, paymentNumber } = req.body;
    const wdAmount = parseInt(amount);
    if (!wdAmount || wdAmount < 2000) return res.status(400).json({ error: 'Minimal WD Rp 2.000' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if ((user.discountBalance || 0) < wdAmount) return res.status(400).json({ error: 'Saldo gak cukup' });
    const wdId = Date.now();
    if (!db.withdrawals) db.withdrawals = [];
    db.withdrawals.unshift({ id: wdId, userId: user.id, userName: user.name, amount: wdAmount, paymentMethod: paymentMethod || 'DANA', paymentNumber: paymentNumber || '-', status: 'pending', createdAt: new Date().toISOString() });
    user.discountBalance -= wdAmount;
    await setDB(db.products, db.orders, db.sha);
    await sendTelegramMessage('💰 WITHDRAW REQUEST\n\n👤 Nama: ' + user.name + '\n💵 Jumlah: Rp ' + wdAmount.toLocaleString() + '\n🏦 Metode: ' + (paymentMethod || 'DANA') + '\n📱 No: ' + (paymentNumber || '-') + '\n🆔 ID: ' + wdId);
    res.json({ success: true, message: 'WD Rp ' + wdAmount.toLocaleString() + ' diproses!' });
});

app.get('/api/user/withdrawals', async (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    const db = await getDB();
    const user = (db.users || []).find(u => u.token === token);
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, withdrawals: (db.withdrawals || []).filter(w => w.userId === user.id) });
});

// ========== ADMIN ==========
app.get('/api/admin/check-ip', async (req, res) => { try { const db = await getDB(); const ip = getClientIP(req); res.json({ isAdmin: db.adminIP === ip || (db.adminIPs || []).includes(ip), hasAdmin: !!db.adminIP, yourIP: ip }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/set-ip', async (req, res) => { if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' }); try { await setAdminIP(getClientIP(req)); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/reset-ip', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); try { const db = await getDB(); const content = { products: db.products, orders: db.orders, users: db.users, withdrawals: db.withdrawals, deposits: db.deposits, adminIP: null, adminIPs: [], maintenance: db.maintenance, encrypted: true, updatedAt: new Date().toISOString() }; const enc = encrypt(JSON.stringify(content)); await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Reset IP', content: Buffer.from(enc).toString('base64'), sha: db.sha }) }); dbCache = null; res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/toggle-maintenance', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); try { const db = await getDB(); db.maintenance = req.body.maintenance === true; const content = { products: db.products, orders: db.orders, users: db.users, withdrawals: db.withdrawals, deposits: db.deposits, adminIP: db.adminIP, adminIPs: db.adminIPs || [], maintenance: db.maintenance, encrypted: true, updatedAt: new Date().toISOString() }; const enc = encrypt(JSON.stringify(content)); await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, { method: 'PUT', headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Maintenance', content: Buffer.from(enc).toString('base64'), sha: db.sha }) }); dbCache = null; res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.post('/api/admin/save-qris-order', async (req, res) => {
    const { adminKey, qrisId, qrisImage, totalAmount, expiredAt, customerName } = req.body;
    if (!isAdmin(req, adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    if (!qrisId || !totalAmount) return res.status(400).json({ error: 'Data tidak lengkap' });
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt++) { try { const db = await getDB(); db.orders.unshift({ id: Date.now() + attempt, orderCode: crypto.randomBytes(16).toString('hex'), qrisId, productId: null, productName: 'QRIS Manual', productCode: 'QRIS Manual', price: totalAmount, totalAmount, customerName: sanitize(customerName || 'Customer'), status: 'pending', qrisImage, expiredAt, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(db.products, db.orders, db.sha); return res.json({ success: true, orderCode: db.orders[0].orderCode }); } catch (e) { lastError = e.message; if (attempt < 3) await new Promise(r => setTimeout(r, 500)); } }
    res.status(500).json({ error: 'Save failed: ' + lastError });
});

app.delete('/api/admin/order/:id', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const db = await getDB(); const idx = (db.orders || []).findIndex(o => o.id == req.params.id); if (idx === -1) return res.status(404).json({ error: 'Not found' }); db.orders.splice(idx, 1); await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.get('/api/admin/withdrawals', async (req, res) => { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, withdrawals: (await getDB()).withdrawals || [] }); });
app.put('/api/admin/withdrawal/:id', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const { status } = req.body; if (!status || !['pending','success','failed'].includes(status)) return res.status(400).json({ error: 'Invalid status' }); const db = await getDB(); const wd = (db.withdrawals || []).find(w => w.id == req.params.id); if (!wd) return res.status(404).json({ error: 'Not found' }); wd.status = status; wd.processedAt = new Date().toISOString(); await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });

// ========== ORDER & PRODUCT ==========
app.post('/api/cancel-order/:orderId', async (req, res) => { const db = await getDB(); const order = (db.orders || []).find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId); if (!order) return res.status(404).json({ error: 'Not found' }); if (order.status !== 'pending') return res.status(400).json({ error: 'Already processed' }); if (order.qrisId && order.qrisId !== 'test-') await cancelQRISInQrispy(order.qrisId); order.status = 'cancelled'; await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.get('/api/get-order/:orderCode', async (req, res) => { const db = await getDB(); const order = (db.orders || []).find(o => o.orderCode === req.params.orderCode); if (!order) return res.json({ success: false }); const product = (db.products || []).find(p => p.id == order.productId); res.json({ success: true, status: order.status, productName: order.productName, productCode: order.productCode || '', qrisImage: order.qrisImage, totalAmount: order.totalAmount, expiredAt: order.expiredAt, itemType: product?.itemType || 'text', createdAt: order.createdAt, id: order.id, isGacha: order.isGacha || false, gachaResult: order.gachaResult || '' }); });

app.get('/api/check-payment/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = (db.orders || []).find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ status: 'not_found' });
    if (order.status === 'paid') return res.json({ status: 'paid', productCode: order.productCode });
    if (new Date(order.expiredAt) < new Date()) { order.status = 'expired'; await setDB(db.products, db.orders, db.sha); return res.json({ status: 'expired' }); }
    if (!QRISPY_TOKEN) return res.json({ status: 'pending' });
    try {
        const r = await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/status`, { headers: { 'X-API-Token': QRISPY_TOKEN } });
        const d = await r.json();
        if (d.status === 'success' && d.data.status === 'paid') {
            dbCacheTime = 0; const freshDB = await getDB(); const freshOrder = (freshDB.orders || []).find(o => o.orderCode === req.params.orderCode);
            if (freshOrder && freshOrder.status === 'paid') return res.json({ status: 'paid', productCode: freshOrder.productCode });
            if (order.items) { for (const item of order.items) { const p = (freshDB.products || []).find(x => x.id == item.productId); if (p && p.stock > 0) p.stock -= item.quantity || 1; } }
            else { const p = (freshDB.products || []).find(x => x.id == order.productId); if (p && p.stock > 0) p.stock -= 1; }
            freshOrder.status = 'paid'; freshOrder.paidAt = new Date().toISOString();
            await processReferralReward(freshDB, freshOrder, req.headers.cookie);
            for (let attempt = 1; attempt <= 3; attempt++) { try { await setDB(freshDB.products, freshDB.orders, freshDB.sha); break; } catch(e) { if (attempt < 3) { await new Promise(r => setTimeout(r, 800)); freshDB.sha = (await getDB()).sha; } } }
            return res.json({ status: 'paid', productCode: freshOrder.productCode });
        }
        res.json({ status: 'pending' });
    } catch (e) { res.json({ status: 'pending' }); }
});

app.get('/api/products', async (req, res) => { const db = await getDB(); res.json({ success: true, products: db.products || [] }); });
app.post('/api/create-order', async (req, res) => { const { productId, customerName, qrisId, qrisImage, totalAmount, expiredAt } = req.body; if (!productId || !qrisId) return res.status(400).json({ error: 'Data tidak lengkap' }); const db = await getDB(); const product = (db.products || []).find(p => p.id == productId); if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' }); if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' }); db.orders.unshift({ id: Date.now(), orderCode: crypto.randomBytes(16).toString('hex'), qrisId, productId: product.id, productName: product.name, productCode: product.itemContent, price: product.price, totalAmount: totalAmount || product.price, customerName: sanitize(customerName || 'Guest'), status: 'pending', qrisImage, expiredAt, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(db.products, db.orders, db.sha); res.json({ success: true, orderCode: db.orders[0].orderCode }); });
app.post('/api/create-cart-order', async (req, res) => { const { items, customerName, qrisId, qrisImage, totalAmount, expiredAt } = req.body; if (!items || !items.length || !qrisId) return res.status(400).json({ error: 'Data tidak lengkap' }); let lastError = ''; for (let attempt = 1; attempt <= 3; attempt++) { try { const db = await getDB(); let cartTotal = 0; const orderItems = []; for (const item of items) { const p = (db.products || []).find(x => x.id == item.productId); if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' }); if (p.stock <= 0) return res.status(400).json({ error: 'Stok habis' }); cartTotal += p.price * (item.quantity || 1); orderItems.push({ productId: p.id, productName: p.name, productCode: p.itemContent, price: p.price, quantity: item.quantity || 1 }); } const totalItems = items.reduce((s, i) => s + (i.quantity || 1), 0); let discount = calculateCartDiscount(totalItems); const finalAmount = Math.max(0, cartTotal - discount); for (const item of orderItems) { const p = (db.products || []).find(x => x.id == item.productId); if (p) p.stock -= item.quantity; } const ocode = crypto.randomBytes(16).toString('hex'); db.orders.unshift({ id: Date.now(), orderCode: ocode, qrisId, items: orderItems, productName: orderItems.map(i => i.productName + ' x' + i.quantity).join(', '), productCode: orderItems.map(i => i.productCode).join('\n'), price: cartTotal, totalAmount: finalAmount, discountAmount: discount, customerName: sanitize(customerName || 'Guest'), status: 'pending', qrisImage, expiredAt, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(db.products, db.orders, db.sha); return res.json({ success: true, orderCode: ocode, cartTotal, discountAmount: discount, finalAmount }); } catch (e) { lastError = e.message; if (attempt < 3) await new Promise(r => setTimeout(r, 500)); } } res.status(500).json({ error: 'Save failed' }); });
app.get('/api/gacha/info', async (req, res) => { const db = await getDB(); const p = (db.products || []).filter(x => x.stock > 0); const tv = p.reduce((s, x) => s + x.price, 0); res.json({ success: true, gachaPrice: Math.floor((p.length > 0 ? tv / p.length : 0) * 0.7), totalProducts: p.length, jackpotChance: '20%' }); });
app.post('/api/gacha', async (req, res) => { const { customerName, qrisId, qrisImage, totalAmount, expiredAt } = req.body; if (!qrisId) return res.status(400).json({ error: 'Data tidak lengkap' }); let lastError = ''; for (let attempt = 1; attempt <= 3; attempt++) { try { const db = await getDB(); const ap = (db.products || []).filter(p => p.stock > 0 && p.price > 0); if (!ap.length) return res.status(400).json({ error: 'Stok habis' }); const w = ap[Math.floor(Math.random() * ap.length)]; w.stock -= 1; const ocode = crypto.randomBytes(16).toString('hex'); db.orders.unshift({ id: Date.now(), orderCode: ocode, qrisId, productId: w.id, productName: '🎰 GACHA: ' + w.name, productCode: w.itemContent, price: totalAmount, totalAmount, customerName: sanitize(customerName || 'Guest'), status: 'pending', qrisImage, expiredAt, isGacha: true, gachaResult: w.name, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(db.products, db.orders, db.sha); return res.json({ success: true, orderCode: ocode, gachaResult: w.name, originalPrice: w.price, isJackpot: w.price === Math.max(...ap.map(p => p.price)) }); } catch (e) { lastError = e.message; if (attempt < 3) await new Promise(r => setTimeout(r, 500)); } } res.status(500).json({ error: 'Save failed' }); });
app.get('/api/admin/stats', async (req, res) => { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const db = await getDB(); const paid = (db.orders || []).filter(o => o.status === 'paid'); res.json({ success: true, stats: { totalProducts: (db.products || []).length, totalOrders: (db.orders || []).length, totalUsers: (db.users || []).length, totalRevenue: paid.reduce((s, o) => s + (o.totalAmount || 0), 0) } }); });
app.get('/api/admin/products', async (req, res) => { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, products: (await getDB()).products || [] }); });
app.get('/api/admin/orders', async (req, res) => { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, orders: (await getDB()).orders || [] }); });
app.post('/api/admin/product', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent } = req.body; if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid' }); const db = await getDB(); db.products.push({ id: Date.now(), name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', createdAt: new Date().toISOString() }); await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.put('/api/admin/product/:id', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent } = req.body; const db = await getDB(); const idx = (db.products || []).findIndex(p => p.id == req.params.id); if (idx === -1) return res.status(404).json({ error: 'Not found' }); db.products[idx] = { ...db.products[idx], name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '' }; await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.delete('/api/admin/product/:id', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const db = await getDB(); db.products = (db.products || []).filter(p => p.id != req.params.id); await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.post('/api/admin/reset-orders', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const db = await getDB(); const paid = (db.orders || []).filter(o => o.status === 'paid'); db.orders = paid; await setDB(db.products, db.orders, db.sha); res.json({ success: true }); });
app.post('/api/admin/backup', async (req, res) => { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); const db = await getDB(); const fd = new FormData(); fd.append('chat_id', TELEGRAM_CHAT_ID); fd.append('document', new Blob([JSON.stringify(db)], { type: 'application/json' }), 'backup.json'); await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd }); res.json({ success: true }); });

app.get('/order/:code', (req, res) => res.sendFile(path.join(__dirname, '../public/order.html')));

module.exports = app;
