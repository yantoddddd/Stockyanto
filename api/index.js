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
    cookieHeader.split(';').forEach(function(cookie) {
        var parts = cookie.trim().split('=');
        var name = parts[0];
        var value = parts.slice(1).join('=');
        if (name) cookies[name] = value;
    });
    return cookies;
}

let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 5000;

const rateLimitMap = new Map();
app.use(function(req, res, next) {
    var ip = (req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown').split(',')[0].trim();
    if (dbCache && (dbCache.adminIP === ip || (dbCache.adminIPs && dbCache.adminIPs.includes(ip)))) return next();
    var now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    var requests = rateLimitMap.get(ip).filter(function(t) { return now - t < 60000; });
    if (requests.length >= 60) return res.status(429).json({ error: 'Rate limit' });
    requests.push(now);
    rateLimitMap.set(ip, requests);
    next();
});

function getClientIP(req) { return (req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown').split(',')[0].trim(); }
function isAdmin(req, adminKey) { if (adminKey === ADMIN_KEY) return true; var ip = getClientIP(req); if (dbCache && dbCache.adminIP === ip) return true; if (dbCache && dbCache.adminIPs && dbCache.adminIPs.includes(ip)) return true; return false; }

async function getDB() {
    var now = Date.now();
    if (dbCache && (now - dbCacheTime) < CACHE_TTL) return { ...dbCache, sha: dbCache.sha };
    try {
        var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, {
            headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null, adminIP: null, adminIPs: [], maintenance: false };
        var data = await res.json();
        var content = Buffer.from(data.content, 'base64').toString('utf8');
        var parsed;
        try { parsed = JSON.parse(content); } catch(e) { parsed = JSON.parse(decrypt(content)); }
        dbCache = { ...parsed, sha: data.sha };
        dbCacheTime = now;
        return { ...dbCache, sha: data.sha };
    } catch (err) { return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null, adminIP: null, adminIPs: [], maintenance: false }; }
}

async function setDB(products, orders, oldSha, retryCount) {
    if (!retryCount) retryCount = 0;
    if (retryCount > 5) throw new Error('Save failed after 5 retries');
    var db = await getDB();
    var content = {
        products: products || db.products || [],
        orders: orders || db.orders || [],
        users: db.users || [],
        withdrawals: db.withdrawals || [],
        deposits: db.deposits || [],
        referralVisitors: db.referralVisitors || [],
        adminIP: db.adminIP || null,
        adminIPs: db.adminIPs || [],
        maintenance: db.maintenance || false,
        encrypted: true,
        updatedAt: new Date().toISOString()
    };
    var encryptedContent = encrypt(JSON.stringify(content));
    var updatedContent = Buffer.from(encryptedContent).toString('base64');
    var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, {
        method: 'PUT',
        headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        var e = await res.json().catch(function() { return {}; });
        if (e.message && e.message.includes('SHA')) { await new Promise(function(r) { setTimeout(r, 800); }); var f = await getDB(); return setDB(products, orders, f.sha, retryCount + 1); }
        throw new Error('Save failed: ' + (e.message || res.status));
    }
    var d = await res.json();
    dbCache = { ...content, sha: d.content.sha };
    dbCacheTime = Date.now();
    return d.content.sha;
}

async function sendTelegramMessage(text) {
    try { if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' }) }); } catch (e) {}
}

function sanitize(str) { if (!str) return ''; return String(str).replace(/[<>"'&]/g, function(m) { return ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[m]; }); }
function generateReferralCode(name) { return name.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) + crypto.randomBytes(3).toString('hex').toUpperCase(); }
function validateAge(birthDate) { var today = new Date(); var birth = new Date(birthDate); var age = today.getFullYear() - birth.getFullYear(); var m = today.getMonth() - birth.getMonth(); if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--; return age >= 12; }
function hashPassword(password) { return crypto.createHash('sha256').update(password + 'YANTO_SALT').digest('hex'); }
function verifyPassword(password, hash) { return hashPassword(password) === hash; }
function calculateCartDiscount(itemCount) { return Math.max(0, (itemCount - 1) * 500); }
function getRefFromCookie(cookieHeader) { var c = parseCookies(cookieHeader); return c['yanto_ref'] || null; }
async function cancelQRISInQrispy(qrisId) { if (!QRISPY_TOKEN) return false; try { var r = await fetch(QRISPY_API_URL + '/api/payment/qris/' + qrisId + '/cancel', { method: 'POST', headers: { 'X-API-Token': QRISPY_TOKEN } }); return (await r.json()).status === 'success'; } catch (e) { return false; } }

function getReferralFromDB(db, customerName) {
    if (!customerName) return null;
    var nameLower = customerName.toLowerCase();
    var visitors = db.referralVisitors || [];
    for (var i = 0; i < visitors.length; i++) {
        if (visitors[i].visitorName.toLowerCase() === nameLower) return visitors[i].referralCode;
    }
    var users = db.users || [];
    for (var j = 0; j < users.length; j++) {
        if (users[j].name.toLowerCase() === nameLower && users[j].referredBy) return users[j].referredBy;
    }
    return null;
}

// ✅ FUNGSI REWARD REFERRAL — BACA DARI ORDER DULU
async function processReferralReward(db, order, cookieHeader) {
    if (!order || order.referralRewarded) return;
    
    var refCode = null;
    var customerName = (order.customerName || '').toLowerCase();
    
    // 1. DARI ORDER (disimpen pas checkout — paling akurat)
    if (order.referralCode) {
        refCode = order.referralCode;
        console.log('REFERRAL FROM ORDER: ' + refCode);
    }
    
    // 2. DARI COOKIE (fallback)
    if (!refCode && cookieHeader) {
        refCode = getRefFromCookie(cookieHeader);
        if (refCode) console.log('REFERRAL FROM COOKIE: ' + refCode);
    }
    
    // 3. DARI DATABASE (fallback terakhir)
    if (!refCode) {
        refCode = getReferralFromDB(db, order.customerName);
        if (refCode) console.log('REFERRAL FROM DB: ' + refCode);
    }
    
    if (!refCode) {
        console.log('REFERRAL NOT FOUND untuk ' + customerName);
        return;
    }
    
    var referrer = (db.users || []).find(function(u) { return u.referralCode === refCode; });
    if (!referrer) {
        console.log('REFERRER NOT FOUND untuk kode ' + refCode);
        return;
    }
    
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    referrer.discountBalance = (referrer.discountBalance || 0) + 500;
    order.referralRewarded = true;
    console.log('REFERRAL AWARDED: ' + referrer.name + ' +Rp500 dari ' + customerName);
}

// Auto keep-alive
setInterval(function() { fetch('https://stockyanto.vercel.app/api/health').catch(function() {}); }, 20000);

// Auto expire orders
setInterval(async function() {
    try { var db = await getDB(); var n = new Date(); var changed = false; (db.orders || []).forEach(function(o) { if (o.status === 'pending' && o.expiredAt && new Date(o.expiredAt) < n) { o.status = 'expired'; changed = true; } }); if (changed) await setDB(null, db.orders, db.sha); } catch(e) {}
}, 30000);

// Auto check deposit
setInterval(async function() {
    try {
        var db = await getDB(); if (!db.deposits) db.deposits = []; var changed = false;
        for (var i = 0; i < db.deposits.length; i++) { var dep = db.deposits[i]; if (dep.status === 'pending' && dep.qrisId && QRISPY_TOKEN) { try { var r = await fetch(QRISPY_API_URL + '/api/payment/qris/' + dep.qrisId + '/status', { headers: { 'X-API-Token': QRISPY_TOKEN } }); var d = await r.json(); if (d.status === 'success' && d.data && d.data.status === 'paid') { dep.status = 'paid'; dep.paidAt = new Date().toISOString(); var user = (db.users || []).find(function(u) { return u.id === dep.userId; }); if (user) user.discountBalance = (user.discountBalance || 0) + dep.amount; changed = true; } } catch(e) {} } }
        if (changed) await setDB(null, db.orders, db.sha);
    } catch(e) {}
}, 10000);

// ========== PUBLIC ==========
app.get('/api/health', function(req, res) { res.json({ status: 'ok', time: new Date().toISOString() }); });
app.get('/api/public-stats', async function(req, res) { try { var db = await getDB(); var paid = (db.orders || []).filter(function(o) { return o.status === 'paid'; }); var today = new Date().toISOString().split('T')[0]; var soldMap = {}; paid.forEach(function(o) { soldMap[o.productId] = (soldMap[o.productId] || 0) + 1; }); res.json({ success: true, totalProducts: (db.products || []).filter(function(p) { return p.stock > 0; }).length, todayOrders: paid.filter(function(o) { return (o.paidAt || o.createdAt).startsWith(today); }).length, soldMap: soldMap, maintenance: db.maintenance || false }); } catch(e) { res.status(500).json({ success: false }); } });

// ========== REFERRAL APPLY ==========
app.get('/api/referral/apply', async function(req, res) {
    var ref = req.query.ref;
    if (!ref) return res.json({ success: false });
    try {
        var db = await getDB();
        var referrer = (db.users || []).find(function(u) { return u.referralCode === ref; });
        if (!referrer) return res.json({ success: false });
        referrer.referralClicks = (referrer.referralClicks || 0) + 1;
        
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        var visitorName = 'Guest';
        var visitorId = null;
        if (token) { var v = (db.users || []).find(function(u) { return u.token === token; }); if (v) { visitorName = v.name; visitorId = v.id; } }
        
        if (!db.referralVisitors) db.referralVisitors = [];
        db.referralVisitors.unshift({ id: Date.now(), referralCode: ref, visitorName: visitorName, visitorId: visitorId, ip: getClientIP(req), createdAt: new Date().toISOString() });
        
        res.setHeader('Set-Cookie', 'yanto_ref=' + ref + '; Path=/; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
        await setDB(null, db.orders, db.sha);
        res.json({ success: true });
    } catch(e) { res.json({ success: false }); }
});

// ========== AUTH ==========
app.post('/api/register', async function(req, res) {
    var name = req.body.name, birthDate = req.body.birthDate, password = req.body.password;
    if (!name || !birthDate || !password) return res.status(400).json({ error: 'Data tidak lengkap' });
    if (!validateAge(birthDate)) return res.status(400).json({ error: 'Minimal umur 12 tahun' });
    for (var attempt = 1; attempt <= 3; attempt++) {
        try {
            var db = await getDB(); if (!db.users) db.users = [];
            if (db.users.find(function(u) { return u.name.toLowerCase() === name.toLowerCase(); })) return res.status(400).json({ error: 'Nama sudah terdaftar' });
            var refCode = getRefFromCookie(req.headers.cookie);
            var user = { id: Date.now(), name: sanitize(name), birthDate: birthDate, password: hashPassword(password), referralCode: generateReferralCode(name), referredBy: refCode || null, referralCount: 0, referralClicks: 0, discountBalance: 0, createdAt: new Date().toISOString() };
            db.users.push(user);
            await setDB(null, db.orders, db.sha);
            return res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: 0, referralClicks: 0, discountBalance: 0 } });
        } catch(e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); }); }
    }
    res.status(500).json({ error: 'Save failed' });
});

app.post('/api/login', async function(req, res) {
    var name = req.body.name, password = req.body.password;
    var db = await getDB();
    var user = (db.users || []).find(function(u) { return u.name.toLowerCase() === name.toLowerCase(); });
    if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Nama atau password salah' });
    var token = crypto.randomBytes(32).toString('hex');
    user.token = token;
    if (!user.referredBy) { var refCode = getRefFromCookie(req.headers.cookie); if (refCode) user.referredBy = refCode; }
    await setDB(null, db.orders, db.sha);
    res.setHeader('Set-Cookie', 'yanto_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
    res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0 } });
});

app.post('/api/logout', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (token) { var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; }); if (user) { user.token = null; await setDB(null, db.orders, db.sha); } }
    res.setHeader('Set-Cookie', 'yanto_token=; Path=/; Max-Age=0');
    res.json({ success: true });
});

app.get('/api/user/profile', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, user: { name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0 } });
});

app.get('/api/user/orders', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    var orders = (db.orders || []).filter(function(o) { return o.customerName.toLowerCase() === user.name.toLowerCase(); });
    res.json({ success: true, orders: orders.slice(0, 50).map(function(o) { return { id: o.id, orderCode: o.orderCode, productName: o.productName, totalAmount: o.totalAmount || o.price, status: o.status, createdAt: o.createdAt }; }) });
});

// ========== DEPOSIT ==========
app.post('/api/user/deposit-save', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var amount = parseInt(req.body.amount), qrisId = req.body.qrisId, qrisImage = req.body.qrisImage, expiredAt = req.body.expiredAt;
    if (!amount || !qrisId || !qrisImage || !expiredAt) return res.status(400).json({ error: 'Data tidak lengkap' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!db.deposits) db.deposits = [];
    var depId = Date.now();
    db.deposits.unshift({ id: depId, userId: user.id, userName: user.name, amount: amount, qrisId: qrisId, qrisImage: qrisImage, expiredAt: expiredAt, status: 'pending', createdAt: new Date().toISOString() });
    await setDB(null, db.orders, db.sha);
    res.json({ success: true, depId: depId });
});

app.get('/api/user/deposits', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, deposits: (db.deposits || []).filter(function(d) { return d.userId === user.id; }) });
});

// ========== CHANGE PASSWORD ==========
app.post('/api/user/change-password', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var oldPassword = req.body.oldPassword, newPassword = req.body.newPassword;
    if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Data tidak lengkap' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (!verifyPassword(oldPassword, user.password)) return res.status(400).json({ error: 'Password lama salah' });
    user.password = hashPassword(newPassword);
    await setDB(null, db.orders, db.sha);
    res.json({ success: true });
});

app.get('/api/sync-all-referral-balances', async function(req, res) {
    if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' });
    
    var db = await getDB();
    var updated = 0;
    
    (db.users || []).forEach(function(user) {
        var referralCode = user.referralCode;
        var currentBalance = user.discountBalance || 0;
        
        // Ambil semua order PAID dengan referralCode user ini, urutkan by waktu
        var userOrders = (db.orders || []).filter(function(order) {
            return order.status === 'paid' && order.referralCode === referralCode;
        }).sort(function(a, b) {
            return new Date(a.paidAt || a.createdAt) - new Date(b.paidAt || b.createdAt);
        });
        
        // Ambil semua WD sukses user ini, urutkan by waktu
        var userWDs = (db.withdrawals || []).filter(function(wd) {
            return wd.userId === user.id && wd.status === 'success';
        }).sort(function(a, b) {
            return new Date(a.processedAt || a.createdAt) - new Date(b.processedAt || b.createdAt);
        });
        
        var orderCount = userOrders.length;
        var totalEarned = orderCount * 500;
        
        // Hitung saldo berdasarkan kronologi: 
        // Setiap kali WD, kurangi dari saldo yang tersedia saat itu
        var simulatedBalance = 0;
        var wdIndex = 0;
        
        for (var i = 0; i < userOrders.length; i++) {
            simulatedBalance += 500; // Tambah Rp 500 dari order ini
            
            // Proses semua WD yang terjadi SEBELUM order berikutnya
            var nextOrderTime = i + 1 < userOrders.length 
                ? new Date(userOrders[i + 1].paidAt || userOrders[i + 1].createdAt).getTime() 
                : Infinity;
            
            while (wdIndex < userWDs.length) {
                var wdTime = new Date(userWDs[wdIndex].processedAt || userWDs[wdIndex].createdAt).getTime();
                if (wdTime <= nextOrderTime) {
                    simulatedBalance -= userWDs[wdIndex].amount || 0;
                    wdIndex++;
                } else {
                    break;
                }
            }
        }
        
        // Sisa WD yang terjadi setelah order terakhir
        while (wdIndex < userWDs.length) {
            simulatedBalance -= userWDs[wdIndex].amount || 0;
            wdIndex++;
        }
        
        if (simulatedBalance < 0) simulatedBalance = 0;
        
        if (user.discountBalance !== simulatedBalance || user.referralCount !== orderCount) {
            user.referralCount = orderCount;
            user.discountBalance = simulatedBalance;
            updated++;
        }
    });
    
    if (updated > 0) await setDB(null, db.orders, db.sha);
    res.json({ success: true, updatedCount: updated });
});

// ========== PING: TRIGGER REFERRAL MANUAL ==========
app.get('/api/ping-referral', async function(req, res) {
    var orderCode = req.query.code;
    if (!orderCode) return res.json({ error: 'Masukkan kode order: ?code=xxx' });
    
    var db = await getDB();
    dbCacheTime = 0; // bypass cache
    
    var order = (db.orders || []).find(function(o) { return o.orderCode === orderCode; });
    if (!order) return res.json({ error: 'Order tidak ditemukan' });
    
    console.log('=== PING REFERRAL ===');
    console.log('Order:', order.orderCode);
    console.log('Status:', order.status);
    console.log('ReferralCode:', order.referralCode);
    console.log('ReferralRewarded:', order.referralRewarded);
    
    if (order.status !== 'paid') return res.json({ error: 'Order belum PAID. Status: ' + order.status });
    if (order.referralRewarded) return res.json({ message: 'Order udah di-reward sebelumnya' });
    
    // ✅ PROSES REFERRAL
    await processReferralReward(db, order, null);
    
    // ✅ SIMPAN
    if (order.referralRewarded) {
        await setDB(null, db.orders, db.sha);
        res.json({ success: true, message: 'Referral berhasil diproses!', orderCode: orderCode });
    } else {
        res.json({ error: 'Gagal proses referral. Cek log Vercel.' });
    }
});

// ========== WITHDRAW ==========
app.post('/api/user/withdraw', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var amount = parseInt(req.body.amount), paymentMethod = req.body.paymentMethod, paymentNumber = req.body.paymentNumber;
    if (!amount || amount < 2000) return res.status(400).json({ error: 'Minimal WD Rp 2.000' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if ((user.discountBalance || 0) < amount) return res.status(400).json({ error: 'Saldo gak cukup' });
    if (!db.withdrawals) db.withdrawals = [];
    db.withdrawals.unshift({ id: Date.now(), userId: user.id, userName: user.name, amount: amount, paymentMethod: paymentMethod || 'DANA', paymentNumber: paymentNumber || '-', status: 'pending', createdAt: new Date().toISOString() });
    user.discountBalance -= amount;
    await setDB(null, db.orders, db.sha);
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) sendTelegramMessage('💰 WITHDRAW\n\n👤 ' + user.name + '\n💵 Rp ' + amount.toLocaleString() + '\n🏦 ' + (paymentMethod || 'DANA') + '\n📱 ' + (paymentNumber || '-'));
    res.json({ success: true });
});

app.get('/api/user/withdrawals', async function(req, res) {
    var cookies = parseCookies(req.headers.cookie); var token = cookies['yanto_token'];
    if (!token) return res.status(401).json({ error: 'Login dulu' });
    var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; });
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    res.json({ success: true, withdrawals: (db.withdrawals || []).filter(function(w) { return w.userId === user.id; }) });
});

// ========== ADMIN ==========
app.get('/api/admin/check-ip', async function(req, res) { try { var db = await getDB(); var ip = getClientIP(req); res.json({ isAdmin: db.adminIP === ip || (db.adminIPs || []).includes(ip), hasAdmin: !!db.adminIP, yourIP: ip }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/set-ip', async function(req, res) { if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' }); try { var db = await getDB(); var ip = getClientIP(req); var ips = db.adminIPs || []; if (db.adminIP && !ips.includes(db.adminIP)) ips.push(db.adminIP); if (!ips.includes(ip)) ips.push(ip); var c = { products: db.products || [], orders: db.orders || [], users: db.users || [], withdrawals: db.withdrawals || [], deposits: db.deposits || [], referralVisitors: db.referralVisitors || [], adminIP: ip, adminIPs: ips, maintenance: db.maintenance || false, encrypted: true, updatedAt: new Date().toISOString() }; var enc = encrypt(JSON.stringify(c)); var b = Buffer.from(enc).toString('base64'); var r = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, { method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Set IP', content: b, sha: db.sha }) }); if (r.ok) { var d = await r.json(); dbCache = { ...c, sha: d.content.sha }; dbCacheTime = Date.now(); } res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/reset-ip', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); try { var db = await getDB(); var c = { products: db.products, orders: db.orders, users: db.users, withdrawals: db.withdrawals, deposits: db.deposits, referralVisitors: db.referralVisitors, adminIP: null, adminIPs: [], maintenance: db.maintenance, encrypted: true, updatedAt: new Date().toISOString() }; var enc = encrypt(JSON.stringify(c)); var b = Buffer.from(enc).toString('base64'); await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, { method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Reset IP', content: b, sha: db.sha }) }); dbCache = null; res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/toggle-maintenance', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); try { var db = await getDB(); db.maintenance = req.body.maintenance === true; var c = { products: db.products, orders: db.orders, users: db.users, withdrawals: db.withdrawals, deposits: db.deposits, referralVisitors: db.referralVisitors, adminIP: db.adminIP, adminIPs: db.adminIPs || [], maintenance: db.maintenance, encrypted: true, updatedAt: new Date().toISOString() }; var enc = encrypt(JSON.stringify(c)); var b = Buffer.from(enc).toString('base64'); await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, { method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Maintenance', content: b, sha: db.sha }) }); dbCache = null; res.json({ success: true }); } catch(e) { res.status(500).json({ error: e.message }); } });
app.post('/api/admin/save-qris-order', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var qrisId = req.body.qrisId, totalAmount = req.body.totalAmount; if (!qrisId || !totalAmount) return res.status(400).json({ error: 'Data tidak lengkap' }); for (var attempt = 1; attempt <= 3; attempt++) { try { var db = await getDB(); var oc = crypto.randomBytes(16).toString('hex'); db.orders.unshift({ id: Date.now() + attempt, orderCode: oc, qrisId: qrisId, productId: null, productName: 'QRIS Manual', productCode: 'QRIS Manual', price: totalAmount, totalAmount: totalAmount, customerName: sanitize(req.body.customerName || 'Customer'), status: 'pending', qrisImage: req.body.qrisImage, expiredAt: req.body.expiredAt, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(null, db.orders, db.sha); return res.json({ success: true, orderCode: oc }); } catch(e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); }); } } res.status(500).json({ error: 'Save failed' }); });
app.delete('/api/admin/order/:id', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); var idx = (db.orders || []).findIndex(function(o) { return o.id == req.params.id; }); if (idx === -1) return res.status(404).json({ error: 'Not found' }); db.orders.splice(idx, 1); await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.get('/api/admin/withdrawals', async function(req, res) { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, withdrawals: (await getDB()).withdrawals || [] }); });
app.put('/api/admin/withdrawal/:id', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var status = req.body.status; if (!status || ['pending','success','failed'].indexOf(status) === -1) return res.status(400).json({ error: 'Invalid status' }); var db = await getDB(); var wd = (db.withdrawals || []).find(function(w) { return w.id == req.params.id; }); if (!wd) return res.status(404).json({ error: 'Not found' }); wd.status = status; wd.processedAt = new Date().toISOString(); await setDB(null, db.orders, db.sha); res.json({ success: true }); });

// ========== ORDER & PRODUCT ==========
app.post('/api/cancel-order/:orderId', async function(req, res) { var db = await getDB(); var order = (db.orders || []).find(function(o) { return o.id == req.params.orderId || o.orderCode == req.params.orderId; }); if (!order) return res.status(404).json({ error: 'Not found' }); if (order.status !== 'pending') return res.status(400).json({ error: 'Already processed' }); if (order.qrisId && order.qrisId !== 'test-') await cancelQRISInQrispy(order.qrisId); order.status = 'cancelled'; await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.get('/api/get-order/:orderCode', async function(req, res) { var db = await getDB(); var order = (db.orders || []).find(function(o) { return o.orderCode === req.params.orderCode; }); if (!order) return res.json({ success: false }); var product = (db.products || []).find(function(p) { return p.id == order.productId; }); res.json({ success: true, status: order.status, productName: order.productName, productCode: order.productCode || '', qrisImage: order.qrisImage, totalAmount: order.totalAmount, expiredAt: order.expiredAt, itemType: product ? product.itemType : 'text', createdAt: order.createdAt, isGacha: order.isGacha || false, gachaResult: order.gachaResult || '' }); });

app.get('/api/check-payment/:orderCode', async function(req, res) {
    var db = await getDB();
    var order = (db.orders || []).find(function(o) { return o.orderCode === req.params.orderCode; });
    if (!order) return res.json({ status: 'not_found' });
    if (order.status === 'paid') return res.json({ status: 'paid', productCode: order.productCode });
    if (new Date(order.expiredAt) < new Date()) { order.status = 'expired'; await setDB(null, db.orders, db.sha); return res.json({ status: 'expired' }); }
    if (!QRISPY_TOKEN) return res.json({ status: 'pending' });
    try {
        var r = await fetch(QRISPY_API_URL + '/api/payment/qris/' + order.qrisId + '/status', { headers: { 'X-API-Token': QRISPY_TOKEN } });
        var d = await r.json();
        if (d.status === 'success' && d.data && d.data.status === 'paid') {
            dbCacheTime = 0; var freshDB = await getDB();
            var freshOrder = (freshDB.orders || []).find(function(o) { return o.orderCode === req.params.orderCode; });
            if (freshOrder && freshOrder.status === 'paid') return res.json({ status: 'paid', productCode: freshOrder.productCode });
            if (order.items) { order.items.forEach(function(item) { var p = (freshDB.products || []).find(function(x) { return x.id == item.productId; }); if (p && p.stock > 0) p.stock -= item.quantity || 1; }); }
            else { var p = (freshDB.products || []).find(function(x) { return x.id == order.productId; }); if (p && p.stock > 0) p.stock -= 1; }
            freshOrder.status = 'paid'; freshOrder.paidAt = new Date().toISOString();
            
            // ✅ KOMISI REFERRAL
            await processReferralReward(freshDB, freshOrder, req.headers.cookie);
            
            for (var attempt = 1; attempt <= 3; attempt++) { try { await setDB(null, freshDB.orders, freshDB.sha); break; } catch(e) { if (attempt < 3) { await new Promise(function(r) { setTimeout(r, 800); }); freshDB.sha = (await getDB()).sha; } } }
            return res.json({ status: 'paid', productCode: freshOrder.productCode });
        }
        res.json({ status: 'pending' });
    } catch(e) { res.json({ status: 'pending' }); }
});

app.get('/api/products', async function(req, res) { var db = await getDB(); res.json({ success: true, products: db.products || [] }); });

// ✅ CREATE ORDER — SIMPAN REFERRAL DARI COOKIE
app.post('/api/create-order', async function(req, res) {
    var productId = req.body.productId, customerName = req.body.customerName, qrisId = req.body.qrisId;
    if (!productId || !qrisId) return res.status(400).json({ error: 'Data tidak lengkap' });
    var db = await getDB(); var p = (db.products || []).find(function(x) { return x.id == productId; });
    if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (p.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
    var oc = crypto.randomBytes(16).toString('hex');
    db.orders.unshift({
        id: Date.now(), orderCode: oc, qrisId: qrisId,
        productId: p.id, productName: p.name, productCode: p.itemContent,
        price: p.price, totalAmount: req.body.totalAmount || p.price,
        customerName: sanitize(customerName || 'Guest'),
        referralCode: getRefFromCookie(req.headers.cookie) || null, // ✅ SIMPAN REFERRAL
        status: 'pending', qrisImage: req.body.qrisImage, expiredAt: req.body.expiredAt,
        referralRewarded: false, createdAt: new Date().toISOString()
    });
    await setDB(null, db.orders, db.sha);
    res.json({ success: true, orderCode: oc });
});

// ✅ CREATE CART ORDER — SIMPAN REFERRAL DARI COOKIE
app.post('/api/create-cart-order', async function(req, res) {
    var items = req.body.items;
    if (!items || !items.length || !req.body.qrisId) return res.status(400).json({ error: 'Data tidak lengkap' });
    for (var attempt = 1; attempt <= 3; attempt++) {
        try {
            var db = await getDB(); var cartTotal = 0; var oi = [];
            for (var i = 0; i < items.length; i++) { var item = items[i]; var p = (db.products || []).find(function(x) { return x.id == item.productId; }); if (!p) return res.status(404).json({ error: 'Produk tidak ditemukan' }); if (p.stock <= 0) return res.status(400).json({ error: 'Stok ' + p.name + ' habis' }); cartTotal += p.price * (item.quantity || 1); oi.push({ productId: p.id, productName: p.name, productCode: p.itemContent, price: p.price, quantity: item.quantity || 1 }); }
            var totalItems = items.reduce(function(s, it) { return s + (it.quantity || 1); }, 0);
            var discount = calculateCartDiscount(totalItems);
            var finalAmount = Math.max(0, cartTotal - discount);
            oi.forEach(function(it) { var x = (db.products || []).find(function(y) { return y.id == it.productId; }); if (x) x.stock -= it.quantity; });
            var oc = crypto.randomBytes(16).toString('hex');
            db.orders.unshift({
                id: Date.now(), orderCode: oc, qrisId: req.body.qrisId,
                items: oi,
                productName: oi.map(function(x) { return x.productName + ' x' + x.quantity; }).join(', '),
                productCode: oi.map(function(x) { return x.productCode; }).join('\n'),
                price: cartTotal, totalAmount: finalAmount, discountAmount: discount,
                customerName: sanitize(req.body.customerName || 'Guest'),
                referralCode: getRefFromCookie(req.headers.cookie) || null, // ✅ SIMPAN REFERRAL
                status: 'pending', qrisImage: req.body.qrisImage, expiredAt: req.body.expiredAt,
                referralRewarded: false, createdAt: new Date().toISOString()
            });
            await setDB(null, db.orders, db.sha);
            return res.json({ success: true, orderCode: oc });
        } catch(e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); }); }
    }
    res.status(500).json({ error: 'Save failed' });
});

app.get('/api/gacha/info', async function(req, res) { var db = await getDB(); var ap = (db.products || []).filter(function(p) { return p.stock > 0; }); var tv = ap.reduce(function(s, p) { return s + p.price; }, 0); res.json({ success: true, gachaPrice: ap.length > 0 ? Math.floor(tv / ap.length * 0.7) : 0, totalProducts: ap.length, jackpotChance: '20%' }); });
app.post('/api/gacha', async function(req, res) { if (!req.body.qrisId) return res.status(400).json({ error: 'Data tidak lengkap' }); for (var attempt = 1; attempt <= 3; attempt++) { try { var db = await getDB(); var ap = (db.products || []).filter(function(p) { return p.stock > 0 && p.price > 0; }); if (!ap.length) return res.status(400).json({ error: 'Stok habis' }); var w = ap[Math.floor(Math.random() * ap.length)]; w.stock -= 1; var maxPrice = Math.max.apply(null, ap.map(function(p) { return p.price; })); var oc = crypto.randomBytes(16).toString('hex'); db.orders.unshift({ id: Date.now(), orderCode: oc, qrisId: req.body.qrisId, productId: w.id, productName: '🎰 GACHA: ' + w.name, productCode: w.itemContent, price: req.body.totalAmount, totalAmount: req.body.totalAmount, customerName: sanitize(req.body.customerName || 'Guest'), status: 'pending', qrisImage: req.body.qrisImage, expiredAt: req.body.expiredAt, isGacha: true, gachaResult: w.name, referralRewarded: false, createdAt: new Date().toISOString() }); await setDB(null, db.orders, db.sha); return res.json({ success: true, orderCode: oc, gachaResult: w.name, originalPrice: w.price, isJackpot: w.price === maxPrice }); } catch(e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); }); } } res.status(500).json({ error: 'Save failed' }); });
app.get('/api/admin/stats', async function(req, res) { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); var paid = (db.orders || []).filter(function(o) { return o.status === 'paid'; }); res.json({ success: true, stats: { totalProducts: (db.products || []).length, totalOrders: (db.orders || []).length, totalUsers: (db.users || []).length, totalWithdrawals: (db.withdrawals || []).length, totalDeposits: (db.deposits || []).length, totalRevenue: paid.reduce(function(s, o) { return s + (o.totalAmount || 0); }, 0) } }); });
app.get('/api/admin/products', async function(req, res) { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, products: (await getDB()).products || [] }); });
app.get('/api/admin/orders', async function(req, res) { if (!isAdmin(req, req.query.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); res.json({ success: true, orders: (await getDB()).orders || [] }); });
app.post('/api/admin/product', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var name = req.body.name, itemContent = req.body.itemContent, price = parseInt(req.body.price); if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid' }); var db = await getDB(); db.products.push({ id: Date.now(), name: name, description: req.body.description || '', price: price, stock: parseInt(req.body.stock) || 1, itemType: req.body.itemType || 'text', itemContent: itemContent, bonusType: req.body.bonusType || 'none', bonusContent: req.body.bonusContent || '', createdAt: new Date().toISOString() }); await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.put('/api/admin/product/:id', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); var idx = (db.products || []).findIndex(function(p) { return p.id == req.params.id; }); if (idx === -1) return res.status(404).json({ error: 'Not found' }); db.products[idx] = { ...db.products[idx], name: req.body.name, description: req.body.description || '', price: parseInt(req.body.price), stock: parseInt(req.body.stock) || 1, itemType: req.body.itemType || 'text', itemContent: req.body.itemContent, bonusType: req.body.bonusType || 'none', bonusContent: req.body.bonusContent || '' }; await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.delete('/api/admin/product/:id', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); db.products = (db.products || []).filter(function(p) { return p.id != req.params.id; }); await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.post('/api/admin/reset-orders', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); var paid = (db.orders || []).filter(function(o) { return o.status === 'paid'; }); db.orders = paid; await setDB(null, db.orders, db.sha); res.json({ success: true }); });
app.post('/api/admin/backup', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); var db = await getDB(); var fd = new FormData(); fd.append('chat_id', TELEGRAM_CHAT_ID); fd.append('document', new Blob([JSON.stringify(db)], { type: 'application/json' }), 'backup.json'); await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendDocument', { method: 'POST', body: fd }); res.json({ success: true }); });
app.post('/api/admin/broadcast', async function(req, res) { if (!isAdmin(req, req.body.adminKey)) return res.status(401).json({ error: 'Unauthorized' }); if (!req.body.message) return res.status(400).json({ error: 'Pesan wajib diisi' }); await sendTelegramMessage('📢 BROADCAST\n\n' + req.body.message); res.json({ success: true }); });

app.get('/order/:code', function(req, res) { res.sendFile(path.join(__dirname, '../public/order.html')); });

module.exports = app;
