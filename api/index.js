const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== KONFIGURASI ==========
const ADMIN_KEY = process.env.ADMIN_KEY;
const QRISPY_TOKEN = process.env.QRISPY_TOKEN;
const QRISPY_API_URL = 'https://api.qrispy.id';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';

// ========== CACHE ==========
let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 10000;

// ========== RATE LIMITER ==========
const rateLimitMap = new Map();
const RATE_WINDOW = 60000;
const RATE_MAX = 30;

function rateLimit(req, res, next) {
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
    const requests = rateLimitMap.get(ip).filter(t => now - t < RATE_WINDOW);
    if (requests.length >= RATE_MAX) {
        return res.status(429).json({ error: 'Terlalu banyak request. Coba lagi nanti, Bre.' });
    }
    requests.push(now);
    rateLimitMap.set(ip, requests);
    next();
}
app.use(rateLimit);

// ========== LOGGING ==========
const logBuffer = [];
async function sendLogToTelegram(logEntry) {
    try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: `📡 <b>Request Log</b>\n<code>${logEntry}</code>`, parse_mode: 'HTML' })
        });
    } catch(e) {}
}

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.connection?.remoteAddress || '-';
    const log = `[${new Date().toLocaleString('id-ID')}] ${req.method} ${req.path} - ${ip}`;
    console.log(log);
    logBuffer.push(log);
    if (logBuffer.length >= 10) {
        sendLogToTelegram(logBuffer.join('\n')).catch(() => {});
        logBuffer.length = 0;
    }
    next();
});

setInterval(() => {
    if (logBuffer.length > 0) {
        sendLogToTelegram(logBuffer.join('\n')).catch(() => {});
        logBuffer.length = 0;
    }
}, 5 * 60 * 1000);

// ========== DATABASE FUNCTIONS ==========
async function getDB() {
    const now = Date.now();
    if (dbCache && (now - dbCacheTime) < CACHE_TTL) {
        return { ...dbCache, sha: dbCache.sha };
    }
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) {
            console.error('GitHub API error:', res.status);
            return { products: [], orders: [], sha: null, adminIP: null };
        }
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        dbCache = { ...JSON.parse(content), sha: data.sha };
        dbCacheTime = now;
        return { ...dbCache, sha: data.sha };
    } catch (err) {
        console.error('GetDB error:', err);
        return { products: [], orders: [], sha: null, adminIP: null };
    }
}

async function setDB(products, orders, oldSha, retryCount) {
    if (!retryCount) retryCount = 0;
    if (retryCount > 3) throw new Error('GitHub save failed after 3 retries');
    const db = await getDB();
    const content = { 
        products: products || db.products || [], 
        orders: orders || db.orders || [], 
        adminIP: db.adminIP || null,
        updatedAt: new Date().toISOString() 
    };
    const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update db', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (errorData.message && (errorData.message.includes('SHA') || errorData.message.includes('does not match'))) {
            console.log(`SHA conflict, retrying... (${retryCount + 1}/3)`);
            await new Promise(r => setTimeout(r, 500));
            const freshDB = await getDB();
            return setDB(products, orders, freshDB.sha, retryCount + 1);
        }
        throw new Error('GitHub save failed');
    }
    const data = await res.json();
    dbCache = { products: content.products, orders: content.orders, adminIP: content.adminIP, sha: data.content.sha };
    dbCacheTime = Date.now();
    return data.content.sha;
}

async function setAdminIP(ip) {
    const db = await getDB();
    const content = { 
        products: db.products || [], 
        orders: db.orders || [], 
        adminIP: ip,
        updatedAt: new Date().toISOString() 
    };
    const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Set admin IP', content: updatedContent, sha: db.sha })
    });
    if (res.ok) {
        const data = await res.json();
        dbCache = { products: content.products, orders: content.orders, adminIP: ip, sha: data.content.sha };
        dbCacheTime = Date.now();
        return true;
    }
    return false;
}

async function sendTelegramMessage(text) {
    try {
        if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' })
        });
    } catch (err) { console.error('Telegram error:', err); }
}

// ========== AUTO PING ==========
setInterval(async () => {
    try { await fetch('https://stockyanto.vercel.app/api/health'); } catch(e) {}
}, 20 * 1000);

// ========== AUTO BACKUP JAM 3 WIB ==========
async function autoBackupToTelegram() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const db = await getDB();
        const backupData = JSON.stringify({ products: db.products, orders: db.orders, adminIP: db.adminIP, updatedAt: db.updatedAt }, null, 2);
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', new Blob([backupData], { type: 'application/json' }), `backup_${new Date().toISOString().split('T')[0]}.json`);
        formData.append('caption', `📦 Auto Backup\n📅 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
        console.log('Backup terkirim');
    } catch(e) { console.error('Backup error:', e); }
}
let lastBackupDate = '';
setInterval(async () => {
    const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = wib.toISOString().split('T')[0];
    if (lastBackupDate !== today && wib.getHours() === 3) {
        lastBackupDate = today;
        await autoBackupToTelegram();
    }
}, 60 * 1000);

// ========== AUTO REPORT JAM 00:00 WIB ==========
async function dailyRevenueReport() {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        const db = await getDB();
        const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const todayWIB = wib.toISOString().split('T')[0];
        const todayOrders = db.orders.filter(o => {
            if (!o.paidAt || o.status !== 'paid') return false;
            const paidWIB = new Date(new Date(o.paidAt).toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            return paidWIB.toISOString().split('T')[0] === todayWIB;
        });
        const totalRevenue = todayOrders.reduce((s, o) => s + (o.totalAmount || o.price || 0), 0);
        await sendTelegramMessage(`📊 <b>LAPORAN HARIAN</b>\n📅 ${todayWIB}\n💰 <b>Rp ${totalRevenue.toLocaleString()}</b>\n📦 ${todayOrders.length} order`);
    } catch(e) {}
}
let lastReportDate = '';
setInterval(async () => {
    const wib = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = wib.toISOString().split('T')[0];
    if (lastReportDate !== today && wib.getHours() === 0) {
        lastReportDate = today;
        await dailyRevenueReport();
    }
}, 5 * 60 * 1000);

// ========== AUTO EXPIRE CHECK ==========
async function autoExpireCheck() {
    try {
        const db = await getDB();
        const now = new Date();
        let count = 0;
        for (const o of db.orders) {
            if (o.status === 'pending' && o.expiredAt && new Date(o.expiredAt) < now) {
                o.status = 'expired';
                count++;
            }
        }
        if (count > 0) {
            await setDB(db.products, db.orders, db.sha);
            console.log(`Auto expire: ${count} order`);
        }
    } catch(e) {}
}
setInterval(autoExpireCheck, 30 * 1000);

// ========== AUTO DELETE ==========
async function cleanupOrders() {
    try {
        const db = await getDB();
        let deleted = 0;
        const kept = [];
        for (const o of db.orders) {
            if (o.status === 'cancelled' || o.status === 'expired') deleted++;
            else kept.push(o);
        }
        if (deleted > 0) {
            db.orders = kept;
            await setDB(db.products, db.orders, db.sha);
            console.log(`Cleanup: ${deleted} dihapus`);
        }
    } catch(e) {}
}
setInterval(cleanupOrders, 30 * 1000);

// ========== CANCEL QRIS ==========
async function cancelQRISInQrispy(qrisId) {
    if (!QRISPY_TOKEN) return false;
    try {
        const res = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/cancel`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' }
        });
        return (await res.json()).status === 'success';
    } catch(e) { return false; }
}

function sanitize(str) {
    if (!str) return '';
    return String(str).replace(/[<>"'&]/g, m => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'})[m]);
}

// ========== API ENDPOINTS ==========

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/ping-db', async (req, res) => {
    try {
        const start = Date.now();
        const db = await getDB();
        res.json({ status: 'ok', latency_ms: Date.now() - start, products: (db.products || []).length, orders: (db.orders || []).length });
    } catch(e) { res.status(500).json({ status: 'error', message: e.message }); }
});

app.get('/api/public-stats', async (req, res) => {
    try {
        const db = await getDB();
        const paid = (db.orders || []).filter(o => o.status === 'paid');
        const today = new Date().toISOString().split('T')[0];
        const todayOrders = paid.filter(o => (o.paidAt || o.createdAt).startsWith(today));
        res.json({ success: true, totalProducts: (db.products || []).filter(p => p.stock > 0).length, todayOrders: todayOrders.length, recentOrders: paid.slice(-8).reverse().map(o => ({ customerName: o.customerName, productName: o.productName })) });
    } catch(e) { res.status(500).json({ success: false }); }
});

app.get('/api/admin/check-ip', async (req, res) => {
    try {
        const db = await getDB();
        const clientIP = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim();
        res.json({ isAdmin: db.adminIP === clientIP, hasAdmin: !!db.adminIP, yourIP: clientIP });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/set-ip', async (req, res) => {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const clientIP = (req.headers['x-forwarded-for'] || req.connection?.remoteAddress || 'unknown').split(',')[0].trim();
        await setAdminIP(clientIP);
        res.json({ success: true, adminIP: clientIP });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reset-ip', async (req, res) => {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    try {
        const db = await getDB();
        const content = { products: db.products, orders: db.orders, adminIP: null, updatedAt: new Date().toISOString() };
        const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
        await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            method: 'PUT',
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Reset admin IP', content: updatedContent, sha: db.sha })
        });
        dbCache = null;
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/generate-qris-proxy', async (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ error: 'Amount diperlukan' });
    if (!QRISPY_TOKEN) return res.status(500).json({ error: 'QRISPY_TOKEN belum diset' });
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        res.json(await response.json());
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/cancel-order/:orderId', async (req, res) => {
    const db = await getDB();
    const order = (db.orders || []).find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
    if (order.qrisId && order.qrisId !== 'test-') await cancelQRISInQrispy(order.qrisId);
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

app.post('/api/admin/test-order', async (req, res) => {
    const { productId, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const product = (db.products || []).find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    function esc(str) { if(!str) return ''; return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
    let bonusHtml = product.bonusContent ? `<div class="section"><div class="section-title">Bonus</div><div class="text-content">${esc(product.bonusContent)}</div></div>` : '';
    let itemHtml = '';
    const isLink = product.itemType === 'link' || (product.itemContent || '').startsWith('http');
    const isHtml = product.itemType === 'html';
    if (isHtml) itemHtml = `<div class="section"><div class="section-title">HTML</div><div class="text-content">${esc(product.itemContent)}</div></div>`;
    else if (isLink) itemHtml = `<div class="section"><div class="section-title">Link</div><a href="${esc(product.itemContent)}" target="_blank">${esc(product.itemContent)}</a></div>`;
    else itemHtml = `<div class="section"><div class="section-title">Konten</div><div class="text-content">${esc(product.itemContent)}</div></div>`;
    res.send(`<!DOCTYPE html><html><head><title>Test Order</title><meta charset="UTF-8"><style>body{background:#0f172a;font-family:sans-serif;color:white;padding:20px;text-align:center}h1{color:#10b981}.section{background:#1e293b;padding:14px;border-radius:12px;margin:10px 0;text-align:left}</style></head><body><h1>Test Order</h1><h2>${esc(product.name)}</h2>${itemHtml}${bonusHtml}<p style="color:#64748b;margin-top:20px">Mode test</p></body></html>`);
});

app.get('/api/get-order/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = (db.orders || []).find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ success: false });
    const product = (db.products || []).find(p => p.id == order.productId);
    res.json({ success: true, status: order.status, productName: order.productName, productCode: order.productCode || '', bonusContent: product?.bonusContent || '', qrisImage: order.qrisImage, totalAmount: order.totalAmount, expiredAt: order.expiredAt, itemType: product?.itemType || 'text', createdAt: order.createdAt });
});

app.get('/api/check-payment/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = (db.orders || []).find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ status: 'not_found' });
    if (order.status === 'paid') return res.json({ status: 'paid', productCode: order.productCode });
    if (new Date(order.expiredAt) < new Date()) {
        order.status = 'expired';
        await setDB(db.products, db.orders, db.sha);
        return res.json({ status: 'expired' });
    }
    if (!QRISPY_TOKEN) return res.json({ status: 'pending' });
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/status`, { headers: { 'X-API-Token': QRISPY_TOKEN } });
        const data = await response.json();
        if (data.status === 'success' && data.data.status === 'paid') {
            const product = (db.products || []).find(p => p.id == order.productId);
            if (product && product.stock > 0) product.stock -= 1;
            order.status = 'paid';
            order.paidAt = new Date().toISOString();
            await setDB(db.products, db.orders, db.sha);
            const bonusText = product?.bonusContent ? `\n\nBonus:\n${product.bonusContent}` : '';
            await sendTelegramMessage(`✅ PEMBAYARAN BERHASIL!\n\nProduk: ${order.productName}\nPembeli: ${order.customerName}\nTotal: Rp ${(order.totalAmount || order.price).toLocaleString()}\nOrder: ${order.orderCode}\n\nKode:\n${order.productCode || ''}${bonusText}`);
            return res.json({ status: 'paid', productCode: order.productCode });
        }
        res.json({ status: 'pending' });
    } catch(e) { res.json({ status: 'pending' }); }
});

app.get('/api/products', async (req, res) => {
    const db = await getDB();
    res.json({ success: true, products: db.products || [] });
});

app.post('/api/create-order', async (req, res) => {
    const { productId, customerName, customerEmail, qrisId, qrisImage, totalAmount, expiredAt } = req.body;
    if (!productId || !customerName || !qrisId) return res.status(400).json({ error: 'Data tidak lengkap' });
    const db = await getDB();
    const product = (db.products || []).find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
    const orderCode = crypto.randomBytes(16).toString('hex');
    const newOrder = {
        id: Date.now(), orderCode, qrisId, productId: product.id,
        productName: product.name, productCode: product.itemContent,
        price: product.price, totalAmount: totalAmount || product.price,
        customerName: sanitize(customerName), customerEmail: sanitize(customerEmail || '-'),
        status: 'pending', qrisImage, expiredAt, createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, orderCode });
});

// ========== ADMIN ==========
app.get('/api/admin/stats', async (req, res) => {
    if (req.query.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const paid = (db.orders || []).filter(o => o.status === 'paid');
    res.json({ success: true, stats: {
        totalProducts: (db.products || []).length,
        totalOrders: (db.orders || []).length,
        totalRevenue: paid.reduce((s, o) => s + (o.totalAmount || o.price || 0), 0),
        pendingCount: (db.orders || []).filter(o => o.status === 'pending').length,
        expiredCount: (db.orders || []).filter(o => o.status === 'expired').length,
        cancelledCount: (db.orders || []).filter(o => o.status === 'cancelled').length,
        paidCount: paid.length
    }});
});

app.get('/api/admin/products', async (req, res) => {
    if (req.query.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    res.json({ success: true, products: db.products || [] });
});

app.get('/api/admin/orders', async (req, res) => {
    if (req.query.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    res.json({ success: true, orders: db.orders || [] });
});

app.get('/api/admin/product/:id', async (req, res) => {
    if (req.query.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const product = (db.products || []).find(p => p.id == req.params.id);
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, product });
});

app.post('/api/admin/product', async (req, res) => {
    const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
    const db = await getDB();
    db.products.push({ id: Date.now(), name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', createdAt: new Date().toISOString() });
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

app.put('/api/admin/product/:id', async (req, res) => {
    const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
    const db = await getDB();
    const idx = (db.products || []).findIndex(p => p.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.products[idx] = { ...db.products[idx], name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', updatedAt: new Date().toISOString() };
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

app.delete('/api/admin/product/:id', async (req, res) => {
    if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    db.products = (db.products || []).filter(p => p.id != req.params.id);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

app.post('/api/admin/reset-orders', async (req, res) => {
    if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const paid = (db.orders || []).filter(o => o.status === 'paid');
    const deleted = (db.orders || []).length - paid.length;
    db.orders = paid;
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, deletedCount: deleted, keptCount: paid.length });
});

app.post('/api/admin/delete-selected-orders', async (req, res) => {
    const { adminKey, orderIds } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderIds || !orderIds.length) return res.status(400).json({ error: 'Tidak ada order dipilih' });
    const db = await getDB();
    db.orders = (db.orders || []).filter(o => !orderIds.includes(o.id.toString()));
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, deletedCount: orderIds.length });
});

app.post('/api/admin/backup', async (req, res) => {
    if (req.body.adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const backupData = JSON.stringify({ products: db.products, orders: db.orders, adminIP: db.adminIP }, null, 2);
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return res.json({ success: true, note: 'Telegram not configured' });
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('document', new Blob([backupData], { type: 'application/json' }), `backup_${Date.now()}.json`);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
    res.json({ success: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
    const { adminKey, message } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!message) return res.status(400).json({ error: 'Pesan wajib diisi' });
    const db = await getDB();
    const unique = [...new Map((db.orders || []).map(o => [o.customerName, o.customerEmail])).entries()];
    const sent = unique.filter(([_, email]) => email && email !== '-').length;
    await sendTelegramMessage(`📢 BROADCAST\n\n${message}\n\n📨 Terkirim ke ${sent} customer.`);
    res.json({ success: true, sentCount: sent });
});

app.get('/order/:code', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/order.html'));
});

module.exports = app;
