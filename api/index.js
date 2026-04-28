const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== KONFIGURASI ==========
const ADMIN_KEY = process.env.ADMIN_KEY || 'rahasia123';
const QRISPY_TOKEN = process.env.QRISPY_TOKEN || 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = 'https://api.qrispy.id';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8622926718:AAFgjPx774euFGn3NFdekbMfF9NyJgBNUWs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8182530431';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';

// ========== DATABASE FUNCTIONS ==========
async function getDB() {
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], sha: null };
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return { ...JSON.parse(content), sha: data.sha };
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
            const freshDB = await getDB();
            return setDB(products, orders, freshDB.sha, retryCount + 1);
        }
        throw new Error('GitHub save failed: ' + (errorData.message || res.status));
    }
    
    const data = await res.json();
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

// ========== AUTO PING SETIAP 20 DETIK ==========
setInterval(async () => {
    try { 
        await fetch('https://stockyanto.vercel.app/api/health'); 
    } catch(e) { /* silent fail */ }
}, 20 * 1000);

// ========== AUTO BACKUP KE TELEGRAM JAM 3 PAGI WIB ==========
async function autoBackupToTelegram() {
    try {
        const db = await getDB();
        const backupData = JSON.stringify({ products: db.products, orders: db.orders, updatedAt: db.updatedAt }, null, 2);
        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', new Blob([backupData], { type: 'application/json' }), `backup_${new Date().toISOString().split('T')[0]}.json`);
        formData.append('caption', `📦 Auto Backup Database\n📅 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}`);
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: formData });
        console.log('💾 Auto backup terkirim');
    } catch(e) { console.error('Backup error:', e); }
}

let lastBackupDate = '';
setInterval(async () => {
    try {
        const now = new Date();
        const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const today = wib.toISOString().split('T')[0];
        const hour = wib.getHours();
        
        if (lastBackupDate !== today && hour === 3) {
            lastBackupDate = today;
            await autoBackupToTelegram();
        }
    } catch(e) { console.error('Backup scheduler error:', e); }
}, 60 * 1000);

// ========== AUTO REPORT PENGHASILAN JAM 00:00 WIB ==========
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
        
        const totalRevenue = todayOrders.reduce((sum, o) => sum + (o.totalAmount || o.price || 0), 0);
        
        const productCounts = {};
        todayOrders.forEach(o => {
            productCounts[o.productName] = (productCounts[o.productName] || 0) + 1;
        });
        let breakdown = '';
        for (const [name, count] of Object.entries(productCounts)) {
            breakdown += `  • ${name}: ${count}x\n`;
        }
        
        const message = `📊 <b>LAPORAN PENGHASILAN HARIAN</b>\n📅 ${todayWIB}\n⏰ 00:00 WIB\n\n💰 <b>Total: Rp ${totalRevenue.toLocaleString()}</b>\n📦 Total Order: ${todayOrders.length}\n\n📋 <b>Rincian:</b>\n${breakdown || '  Tidak ada transaksi hari ini'}\n\n🤖 <i>Auto Report - Yanto Store</i>`;
        
        await sendTelegramMessage(message);
        console.log('📊 Report harian terkirim');
    } catch(e) { console.error('Report error:', e); }
}

let lastReportDate = '';
setInterval(async () => {
    try {
        const now = new Date();
        const wib = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
        const today = wib.toISOString().split('T')[0];
        const hour = wib.getHours();
        
        if (lastReportDate !== today && hour === 0) {
            lastReportDate = today;
            await dailyRevenueReport();
        }
    } catch(e) { console.error('Report scheduler error:', e); }
}, 5 * 60 * 1000);

// ========== AUTO DELETE CANCELLED/EXPIRED ==========
async function cleanupOrders() {
    try {
        const db = await getDB();
        let deletedCount = 0;
        const ordersToKeep = [];
        for (const order of db.orders) {
            if (order.status === 'cancelled' || order.status === 'expired') {
                deletedCount++;
            } else {
                ordersToKeep.push(order);
            }
        }
        if (deletedCount > 0) {
            db.orders = ordersToKeep;
            await setDB(db.products, db.orders, db.sha);
            console.log(`✅ Cleanup selesai, ${deletedCount} order dihapus`);
        }
    } catch(e) { console.error('Cleanup error:', e); }
}
setInterval(cleanupOrders, 30 * 1000);

// ========== CANCEL QRIS DI QRISPY ==========
async function cancelQRISInQrispy(qrisId) {
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/cancel`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' }
        });
        const data = await response.json();
        return data.status === 'success';
    } catch (err) {
        console.error('Cancel QRIS error:', err);
        return false;
    }
}

// ========== API ENDPOINTS ==========

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// Proxy generate QRIS (biar token aman dari frontend)
app.post('/api/generate-qris-proxy', async (req, res) => {
    const { amount } = req.body;
    if (!amount) return res.status(400).json({ status: 'error', message: 'Amount diperlukan' });
    try {
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
            method: 'POST',
            headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount })
        });
        const data = await response.json();
        res.json(data);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Cancel order
app.post('/api/cancel-order/:orderId', async (req, res) => {
    const db = await getDB();
    const order = db.orders.find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
    
    if (order.qrisId && order.qrisId !== 'test-') {
        await cancelQRISInQrispy(order.qrisId);
    }
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
    
    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
    }
    
    let bonusHtml = '';
    if (product.bonusContent) {
        bonusHtml = `<div class="section"><div class="section-title"><i class="fas fa-gift"></i> Bonus</div><div class="text-content">${escapeHtml(product.bonusContent)}</div></div>`;
    }
    
    let itemHtml = '';
    const isLink = product.itemType === 'link' || product.itemContent?.startsWith('http');
    const isHtml = product.itemType === 'html';
    
    if (isHtml) {
        itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-code"></i> Barang Utama (HTML)</div><div class="text-content">${escapeHtml(product.itemContent)}</div><button class="chip-btn copy-btn" onclick="copyToClipboard('${escapeHtml(product.itemContent)}')"><i class="fas fa-copy"></i> Salin HTML</button></div>`;
    } else if (isLink) {
        itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-box"></i> Barang Utama</div><div class="text-content">${escapeHtml(product.itemContent)}</div><a href="${escapeHtml(product.itemContent)}" class="chip-btn link-chip" target="_blank"><i class="fas fa-external-link-alt"></i> Buka</a><button class="chip-btn copy-btn" onclick="copyToClipboard('${escapeHtml(product.itemContent)}')"><i class="fas fa-copy"></i> Salin Link</button></div>`;
    } else {
        itemHtml = `<div class="section"><div class="section-title"><i class="fas fa-box"></i> Barang Utama</div><div class="text-content">${escapeHtml(product.itemContent)}</div><button class="chip-btn copy-btn" onclick="copyToClipboard('${escapeHtml(product.itemContent)}')"><i class="fas fa-copy"></i> Salin Teks</button></div>`;
    }
    
    res.send(`<!DOCTYPE html><html><head><title>Test Order</title><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:linear-gradient(135deg,#0f172a,#1e1b4b);font-family:Arial,sans-serif;min-height:100vh;display:flex;justify-content:center;align-items:center;padding:20px;}
.card{background:rgba(255,255,255,0.1);border-radius:32px;padding:32px;max-width:500px;width:100%;}
h1{color:#10b981;text-align:center;margin-bottom:20px;}
.product-name{color:white;text-align:center;margin-bottom:24px;}
.section{background:rgba(0,0,0,0.3);border-radius:20px;padding:16px;margin-bottom:16px;}
.section-title{color:#60a5fa;margin-bottom:10px;}
.text-content{color:#e2e8f0;margin-bottom:10px;word-break:break-all;}
.chip-btn{background:#334155;border:none;padding:6px 14px;border-radius:40px;color:white;cursor:pointer;margin:4px;display:inline-block;}
.link-chip{background:#3b82f6;text-decoration:none;}
.btn-back{background:#334155;border:none;padding:10px 20px;border-radius:40px;color:white;cursor:pointer;text-decoration:none;display:inline-block;}
.footer-note{text-align:center;color:#475569;margin-top:20px;}
</style></head><body>
<div class="card"><h1>✅ TEST ORDER BERHASIL!</h1><div class="product-name">${escapeHtml(product.name)}</div>${itemHtml}${bonusHtml}<div style="text-align:center;margin-top:20px;"><a href="/" class="btn-back">Kembali</a></div><div class="footer-note">Mode test - tidak mempengaruhi stok</div></div>
<script>function copyToClipboard(t){navigator.clipboard?.writeText(t).then(()=>alert('Tersalin!')).catch(()=>{const n=document.createElement('textarea');n.value=t;document.body.appendChild(n);n.select();document.execCommand('copy');document.body.removeChild(n);alert('Tersalin!')})}</script>
</body></html>`);
});

// Get order
app.get('/api/get-order/:orderCode', async (req, res) => {
    const db = await getDB();
    const order = db.orders.find(o => o.orderCode === req.params.orderCode);
    if (!order) return res.json({ success: false });
    const product = db.products.find(p => p.id == order.productId);
    res.json({
        success: true,
        status: order.status,
        productName: order.productName,
        productCode: order.productCode || 'Tidak ada kode',
        bonusContent: product?.bonusContent || '',
        qrisImage: order.qrisImage,
        totalAmount: order.totalAmount,
        expiredAt: order.expiredAt,
        itemType: product?.itemType || 'text'
    });
});

// Check payment (DENGAN NOTIFIKASI TELEGRAM)
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
        const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/status`, {
            headers: { 'X-API-Token': QRISPY_TOKEN }
        });
        const data = await response.json();
        
        if (data.status === 'success' && data.data.status === 'paid') {
            const product = db.products.find(p => p.id == order.productId);
            if (product && product.stock > 0) product.stock -= 1;
            order.status = 'paid';
            order.paidAt = new Date().toISOString();
            await setDB(db.products, db.orders, db.sha);
            
            // ✅ KIRIM NOTIFIKASI TELEGRAM (backup kalau webhook gagal)
            const productCode = order.productCode || 'Tidak ada kode';
            const bonusContent = product?.bonusContent || '';
            let bonusText = bonusContent ? `\n\n🎁 Bonus:\n${bonusContent}` : '';
            
            await sendTelegramMessage(`✅ <b>PEMBAYARAN BERHASIL!</b> (via Check)\n\n📦 <b>Produk:</b> ${order.productName}\n👤 <b>Pembeli:</b> ${order.customerName}\n💰 <b>Total:</b> Rp ${(order.totalAmount || order.price).toLocaleString()}\n🆔 <b>Order:</b> ${order.orderCode}\n📅 <b>Waktu:</b> ${new Date().toLocaleString('id-ID')}\n\n🔑 <b>Kode Item:</b>\n${productCode}${bonusText}`);
            
            return res.json({ status: 'paid', productCode: order.productCode });
        }
        res.json({ status: 'pending' });
    } catch (err) {
        res.json({ status: 'pending' });
    }
});

// Get products
app.get('/api/products', async (req, res) => {
    const db = await getDB();
    res.json({ success: true, products: db.products });
});

// Create order
app.post('/api/create-order', async (req, res) => {
    const { productId, customerName, customerEmail, qrisId, qrisImage, totalAmount, expiredAt } = req.body;
    if (!productId || !customerName || !qrisId) {
        return res.status(400).json({ error: 'Data tidak lengkap' });
    }
    const db = await getDB();
    const product = db.products.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
    
    const orderCode = crypto.randomBytes(16).toString('hex');
    const newOrder = {
        id: Date.now(),
        orderCode: orderCode,
        qrisId: qrisId,
        productId: product.id,
        productName: product.name,
        productCode: product.itemContent,
        price: product.price,
        totalAmount: totalAmount || product.price,
        customerName,
        customerEmail: customerEmail || '-',
        status: 'pending',
        qrisImage: qrisImage,
        expiredAt: expiredAt,
        createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, orderCode: orderCode });
});

// Admin stats
app.get('/api/admin/stats', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    const paidOrders = db.orders.filter(o => o.status === 'paid');
    const totalRevenue = paidOrders.reduce((sum, o) => sum + (o.totalAmount || o.price || 0), 0);
    res.json({
        success: true,
        stats: {
            totalProducts: db.products.length,
            totalOrders: db.orders.length,
            totalRevenue,
            pendingCount: db.orders.filter(o => o.status === 'pending').length,
            expiredCount: db.orders.filter(o => o.status === 'expired').length,
            cancelledCount: db.orders.filter(o => o.status === 'cancelled').length,
            paidCount: paidOrders.length
        }
    });
});

// Admin products list
app.get('/api/admin/products', async (req, res) => {
    const { adminKey } = req.query;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    const db = await getDB();
    res.json({ success: true, products: db.products });
});

// Admin orders list
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
    db.products.push({
        id: Date.now(),
        name,
        description: description || '',
        price: parseInt(price),
        stock: parseInt(stock) || 1,
        itemType: itemType || 'text',
        itemContent,
        bonusType: bonusType || 'none',
        bonusContent: bonusContent || '',
        createdAt: new Date().toISOString()
    });
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
});

// Admin update product
app.put('/api/admin/product/:id', async (req, res) => {
    const { name, description, price, stock, itemType, itemContent, bonusType, bonusContent, adminKey } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
    const db = await getDB();
    const index = db.products.findIndex(p => p.id == req.params.id);
    if (index === -1) return res.status(404).json({ error: 'Product not found' });
    db.products[index] = { ...db.products[index], name, description: description || '', price: parseInt(price), stock: parseInt(stock) || 1, itemType: itemType || 'text', itemContent, bonusType: bonusType || 'none', bonusContent: bonusContent || '', updatedAt: new Date().toISOString() };
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
    const paidOrders = db.orders.filter(o => o.status === 'paid');
    const deletedCount = db.orders.length - paidOrders.length;
    db.orders = paidOrders;
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, deletedCount, keptCount: paidOrders.length });
});

// Admin delete selected orders
app.post('/api/admin/delete-selected-orders', async (req, res) => {
    const { adminKey, orderIds } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
    if (!orderIds || !orderIds.length) return res.status(400).json({ error: 'Tidak ada order dipilih' });
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
    const uniqueCustomers = [...new Map(db.orders.map(o => [o.customerName, o.customerEmail])).entries()];
    let sentCount = uniqueCustomers.filter(([_, email]) => email && email !== '-').length;
    await sendTelegramMessage(`📢 <b>BROADCAST</b>\n\n${message}\n\n📨 Terkirim ke ${sentCount} customer.`);
    res.json({ success: true, sentCount });
});

// Halaman order
app.get('/order/:code', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/order.html'));
});

// Export untuk Vercel
module.exports = app;
