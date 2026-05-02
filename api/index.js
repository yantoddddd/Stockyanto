const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== KONFIGURASI ==========
const ADMIN_KEY = process.env.ADMIN_KEY || 'nisaimut';
const QRISPY_TOKEN = process.env.QRISPY_TOKEN || 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = 'https://api.qrispy.id';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8622926718:AAFgjPx774euFGn3NFdekbMfF9NyJgBNUWs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8182530431';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';

// ========== CACHE DATABASE (5 DETIK) ==========
let dbCache = null;
let dbCacheTime = 0;
const CACHE_TTL = 5000;

// ========== RATE LIMITER ==========
const rateLimitMap = new Map();
const RATE_WINDOW = 60000; // 1 menit
const RATE_MAX = 30; // max 30 request per menit per IP

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

// ========== LOGGING REQUEST + KIRIM KE TELEGRAM ==========
const logBuffer = [];
async function sendLogToTelegram(logEntry) {
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: `📡 <b>Request Log</b>\n<code>${logEntry}</code>`,
                parse_mode: 'HTML'
            })
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

// Kirim log setiap 5 menit kalau ada buffer
setInterval(() => {
    if (logBuffer.length > 0) {
        sendLogToTelegram(logBuffer.join('\n')).catch(() => {});
        logBuffer.length = 0;
    }
}, 5 * 60 * 1000);

// ========== DATABASE FUNCTIONS (WITH CACHE) ==========
async function getDB() {
    const now = Date.now();
    if (dbCache && (now - dbCacheTime) < CACHE_TTL) {
        return { ...dbCache, sha: dbCache.sha };
    }
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], sha: null };
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        dbCache = { ...JSON.parse(content), sha: data.sha };
        dbCacheTime = now;
        return { ...dbCache, sha: data.sha };
    } catch (err) {
        console.error('GetDB error:', err);
        return { products: [], orders: [], sha: null };
    }
}

async function setDB(products, orders, oldSha, retryCount = 0) {
    if (retryCount > 3) throw new Error('GitHub save failed after 3 retries');
    const content = { products, orders, updatedAt: new Date().toISOString() };
    const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update db', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        if (errorData.message?.includes('SHA') || errorData.message?.includes('does not match')) {
            console.log(`⚠️ SHA conflict, retrying... (${retryCount + 1}/3)`);
            await new Promise(r => setTimeout(r, 300));
            const freshDB = await getDB();
            return setDB(products, orders, freshDB.sha, retryCount + 1);
        }
        throw new Error('GitHub save failed: ' + (errorData.message || res.status));
    }
    const data = await res.json();
    dbCache = { products, orders, sha: data.content.sha };
    dbCacheTime = Date.now();
    return data.content.sha;
}

async function sendTelegramMessage(text) {
    try {
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
    try {
        const db = await getDB();
        const backupData = JSON.stringify({ products: db.products, orders: db.orders, updatedAt: db.updatedAt }, null, 2);
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', new Blob([backupData], { type: 'application/json' }), `backup_${new Date().toISOString().split('T')[0]}.json`);
        formData.append('caption', `📦 Auto Backup\n📅 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
        console.log('💾 Auto backup terkirim');
    } catch(e) { console.error('Backup error:', e); }
}
let lastBackupDate = '';
setInterval(async () => {
    const now = new Date();
    const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = wib.toISOString().split('T')[0];
    if (lastBackupDate !== today && wib.getHours() === 3) {
        lastBackupDate = today;
        await autoBackupToTelegram();
    }
}, 60 * 1000);

// ========== AUTO REPORT JAM 00:00 WIB ==========
async function dailyRevenueReport() {
    try {
        const db = await getDB();
        const now = new Date();
        const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const todayWIB = wib.toISOString().split('T')[0];
        const todayOrders = db.orders.filter(o => {
            if (!o.paidAt || o.status !== 'paid') return false;
            const paidWIB = new Date(new Date(o.paidAt).toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            return paidWIB.toISOString().split('T')[0] === todayWIB;
        });
        const totalRevenue = todayOrders.reduce((s, o) => s + (o.totalAmount || o.price || 0), 0);
        const productCounts = {};
        todayOrders.forEach(o => { productCounts[o.productName] = (productCounts[o.productName] || 0) + 1; });
        let breakdown = '';
        for (const [n, c] of Object.entries(productCounts)) breakdown += `  • ${n}: ${c}x\n`;
        await sendTelegramMessage(`📊 <b>LAPORAN HARIAN</b>\n📅 ${todayWIB}\n⏰ 00:00 WIB\n\n💰 <b>Total: Rp ${totalRevenue.toLocaleString()}</b>\n📦 Order: ${todayOrders.length}\n\n📋 <b>Rincian:</b>\n${breakdown || '  Tidak ada'}`);
    } catch(e) {}
}
let lastReportDate = '';
setInterval(async () => {
    const now = new Date();
    const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
    const today = wib.toISOString().split('T')[0];
    if (lastReportDate !== today && wib.getHours() === 0) {
        lastReportDate = today;
        await dailyRevenueReport();
    }
}, 5 * 60 * 1000);

// ========== AUTO EXPIRE CHECK (TIAP 30 DETIK) ==========
async function autoExpireCheck() {
    try {
        const db = await getDB();
        const now = new Date();
        let expiredCount = 0;
        for (const o of db.orders) {
            if (o.status === 'pending' && o.expiredAt && new Date(o.expiredAt) < now) {
                o.status = 'expired';
                expiredCount++;
            }
        }
        if (expiredCount > 0) {
            await setDB(db.products, db.orders, db.sha);
            console.log(`⏰ Auto expire: ${expiredCount} order expired`);
        }
    } catch(e) { console.error('Expire check error:', e); }
}
setInterval(autoExpireCheck, 30 * 1000);

// ========== AUTO DELETE CANCELLED/EXPIRED ==========
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
            console.log(`✅ Cleanup: ${deleted} order dihapus`);
        }
    } catch(e) {}
}
setInterval(cleanupOrders, 30 * 1000);

// ========== CANCEL QRIS ==========
async function cancelQRISInQrispy(qrisId) {
    try {
        const res = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/cancel`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' }
        });
        return (await res.json()).status === 'success';
    } catch(e) { return false; }
}

// ========== API ENDPOINTS ==========

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString(), uptime: process.uptime() });
});

// PING DATABASE
app.get('/api/ping-db', async (req, res) => {
    try {
        const start = Date.now();
        const db = await getDB();
        const latency = Date.now() - start;
        res.json({
            status: 'ok',
            latency_ms: latency,
            products: db.products?.length || 0,
            orders: db.orders?.length || 0,
            cached: (Date.now() - dbCacheTime) < CACHE_TTL
        });
    } catch(e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// Proxy QRIS
app.post('/api/generate-qris-proxy', async (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ status: 'error', message: 'Amount diperlukan' });
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        res.json(await response.json());
    } catch(e) { res.status(500).json({ status: 'error', message: e.message }); }
});

// Cancel order
app.post('/api/cancel-order/:orderId', async (req, res) => {
    const db = await getDB();
    const order = db.orders.find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
    if (order.qrisId && order.qrisId !== 'test-') await cancelQRISInQrispy(order.qrisId);
    order.status = 'cancelled';
    order.cancelledAt = new Date().toISOString();
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

// Test order
app.post('/api/admin/test-order', async (req, res) => {
    const { productId, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const product = db.products.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    function esc(str) { if(!str) return ''; return str.replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[m]); }
    let bonusHtml = product.bonusContent ? `<div class="section"><div class="section-title"><i class="fas fa-gift"></i> Bonus</div><div class="text-content">${esc(product.bonusContent)}</div></div>` : '';
    let itemHtml = '';
    const isLink = product.itemType === 'link' || product.itemContent?.startsWith('http');
    const isHtml = product.itemType === 'html';
    if (isHtml) itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-code"></i> Barang Utama (HTML)</div><div class="text-content">${esc(product.itemContent)}</div><button class="chip-btn copy-btn" onclick="copyToClipboard('${esc(product.itemContent)}')"><i class="fas fa-copy"></i> Salin HTML</button></div>`;
    else if (isLink) itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-box"></i> Barang Utama</div><div class="text-content">${esc(product.itemContent)}</div><a href="${esc(product.itemContent)}" class="chip-btn link-chip" target="_blank"><i class="fas fa-external-link-alt"></i> Buka</a><button class="chip-btn copy-btn" onclick="copyToClipboard('${esc(product.itemContent)}')"><i class="fas fa-copy"></i> Salin Link</button></div>`;
    else itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-box"></i> Barang Utama</div><div class="text-content">${esc(product.itemContent)}</div><button class="chip-btn copy-btn" onclick="copyToClipboard('${esc(product.itemContent)}')"><i class="fas fa-copy"></i> Salin Teks</button></div>`;
    res.send(`<!DOCTYPE html><html><head><title>Test Order</title><meta charset="UTF-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{background:linear-gradient(135deg,#0f172a,#1e1b4b);font-family:Arial,sans-serif;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px}.card{background:rgba(255,255,255,0.1);border-radius:32px;padding:32px;max-width:500px;width:100%}h1{color:#10b981;text-align:center;margin-bottom:20px}.product-name{color:white;text-align:center;margin-bottom:24px}.section{background:rgba(0,0,0,0.3);border-radius:20px;padding:16px;margin-bottom:16px}.section-title{color:#60a5fa;margin-bottom:10px}.text-content{color:#e2e8f0;margin-bottom:10px;word-break:break-all}.chip-btn{background:#334155;border:none;padding:6px 14px;border-radius:40px;color:white;cursor:pointer;margin:4px;display:inline-block}.link-chip{background:#3b82f6;text-decoration:none}.btn-back{background:#334155;border:none;padding:10px 20px;border-radius:40px;color:white;cursor:pointer;text-decoration:none;display:inline-block}.footer-note{text-align:center;color:#475569;margin-top:20px}</style></head><body><div class="card"><h1>✅ TEST ORDER BERHASIL!</h1><div class="product-name">${esc(product.name)}</div>${itemHtml}${bonusHtml}<div style="text-align:center;margin-top:20px"><a href="/" class="btn-back">Kembali</a></div><div class="footer-note">Mode test</div></div><script>function copyToClipboard(t){navigator.clipboard?.writeText(t).then(()=>alert('Tersalin!')).catch(()=>{const n=document.createElement('textarea');n.value=t;document.body.appendChild(n);n.select();document.execCommand('copy');document.body.removeChild(n);alert('Tersalin!')})}</script></body></html>`);
});

// Get order
app.get('/api/get-order/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = db.orders.find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ success: false });
    const product = db.products.find(p => p.id == order.productId);
    res.json({ success: true, status: order.status, productName: order.productName, productCode: order.productCode || 'Tidak ada kode', bonusContent: product?.bonusContent || '', qrisImage: order.qrisImage, totalAmount: order.totalAmount, expiredAt: order.expiredAt, itemType: product?.itemType || 'text', createdAt: order.createdAt });
});

// Check payment
app.get('/api/check-payment/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = db.orders.find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ status: 'not_found' });
    if (order.status === 'paid') return res.json({ status: 'paid', productCode: order.productCode });
    if (new Date(order.expiredAt) < new Date()) {
        order.status = 'expired';
        await setDB(db.products, db.orders, db.sha);
        return res.json({ status: 'expired' });
    }
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/status`, { headers: { 'X-API-Token': QRISPY_TOKEN } });
        const data = await response.json();
        if (data.status === 'success' && data.data.status === 'paid') {
            const product = db.products.find(p => p.id == order.productId);
            if (product && product.stock > 0) product.stock -= 1;
            order.status = 'paid';
            order.paidAt = new Date().toISOString();
            await setDB(db.products, db.orders, db.sha);
            const bonusText = product?.bonusContent ? `\n\n🎁 Bonus:\n${product.bonusContent}` : '';
            await sendTelegramMessage(`✅ <b>PEMBAYARAN BERHASIL!</b> (via Check)\n\n📦 <b>Produk:</b> ${order.productName}\n👤 <b>Pembeli:</b> ${order.customerName}\n💰 <b>Total:</b> Rp ${(order.totalAmount || order.price).toLocaleString()}\n🆔 <b>Order:</b> ${order.orderCode}\n📅 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}\n\n🔑 <b>Kode:</b>\n${order.productCode || 'Tidak ada kode'}${bonusText}`);
            return res.json({ status: 'paid', productCode: order.productCode });
        }
        res.json({ status: 'pending' });
    } catch(e) { res.json({ status: 'pending' }); }
});

// Get products
app.get('/api/products', async (req, res) => {
    const db = await getDB();
    res.json({ success: true, products: db.products });
});

// Create order
app.post('/api/create-order', async (req, res) => {
    const { productId, customerName, customerEmail, qrisId, qrisImage, totalAmount, expiredAt } = req.body;
    if (!productId || !customerName || !qrisId) return res.status(400).json({ error: 'Data tidak lengkap' });
    const db = await getDB();
    const product = db.products.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
    const orderCode = crypto.randomBytes(16).toString('hex');
    const newOrder = {
        id: Date.now(),
        orderCode, qrisId, productId: product.id,
        productName: product.name,
        productCode: product.itemContent,
        price: product.price,
        totalAmount: totalAmount || product.price,
        customerName: sanitize(customerName),
        customerEmail: sanitize(customerEmail || '-'),
        status: 'pending',
        qrisImage, expiredAt,
        createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, orderCode });
});

function sanitize(str) {
    if (!str) return '';
    return String(str).replace(/[<>"'&]/g, m => ({'<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;'})[m]);
}

// Admin stats
app.get('/api/admin/stats', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const paid = db.orders.filter(o => o.status === 'paid');
    const revenue = paid.reduce((s, o) => s + (o.totalAmount || o.price || 0), 0);
    res.json({ success: true, stats: {
        totalProducts: db.products.length,
        totalOrders: db.orders.length,
        totalRevenue: revenue,
        pendingCount: db.orders.filter(o => o.status === 'pending').length,
        expiredCount: db.orders.filter(o => o.status === 'expired').length,
        cancelledCount: db.orders.filter(o => o.status === 'cancelled').length,
        paidCount: paid.length
    }});
});

// Admin products
app.get('/api/admin/products', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    res.json({ success: true, products: db.products });
});

// Admin orders
app.get('/api/admin/orders', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    res.json({ success: true, orders: db.orders });
});

// Admin single product
app.get('/api/admin/product/:id', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const product = db.products.find(p => p.id == req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true, product });
});

// Admin add product
app.post('/api/admin/product', async (req, res) => {
    const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
    const db = await getDB();
    db.products.push({ id: Date.now(), name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', createdAt: new Date().toISOString() });
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

// Admin update product
app.put('/api/admin/product/:id', async (req, res) => {
    const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
    const db = await getDB();
    const idx = db.products.findIndex(p => p.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.products[idx] = { ...db.products[idx], name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', updatedAt: new Date().toISOString() };
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

// Admin delete product
app.delete('/api/admin/product/:id', async (req, res) => {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    db.products = db.products.filter(p => p.id != req.params.id);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

// Admin reset orders
app.post('/api/admin/reset-orders', async (req, res) => {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const paid = db.orders.filter(o => o.status === 'paid');
    const deleted = db.orders.length - paid.length;
    db.orders = paid;
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, deletedCount: deleted, keptCount: paid.length });
});

// Admin delete selected
app.post('/api/admin/delete-selected-orders', async (req, res) => {
    const { adminKey, orderIds } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderIds?.length) return res.status(400).json({ error: 'Tidak ada order dipilih' });
    const db = await getDB();
    db.orders = db.orders.filter(o => !orderIds.includes(o.id.toString()));
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, deletedCount: orderIds.length });
});

// Admin backup
app.post('/api/admin/backup', async (req, res) => {
    const { adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const backupData = JSON.stringify({ products: db.products, orders: db.orders }, null, 2);
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('document', new Blob([backupData], { type: 'application/json' }), `backup_${Date.now()}.json`);
    formData.append('caption', `📦 Manual Backup\n📅 ${new Date().toLocaleString('id-ID')}`);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
    res.json({ success: true });
});

// Admin broadcast
app.post('/api/admin/broadcast', async (req, res) => {
    const { adminKey, message } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!message) return res.status(400).json({ error: 'Pesan wajib diisi' });
    const db = await getDB();
    const unique = [...new Map(db.orders.map(o => [o.customerName, o.customerEmail])).entries()];
    const sent = unique.filter(([_, email]) => email && email !== '-').length;
    await sendTelegramMessage(`📢 <b>BROADCAST</b>\n\n${message}\n\n📨 Terkirim ke ${sent} customer.`);
    res.json({ success: true, sentCount: sent });
});

// Halaman order
app.get('/order/:code', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/order.html'));
});

module.exports = app;
