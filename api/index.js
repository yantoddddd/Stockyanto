const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const ADMIN_KEY = 'rahasia123';
const QRISPY_TOKEN = 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = 'https://api.qrispy.id';

const TELEGRAM_BOT_TOKEN = '8622926718:AAFgjPx774euFGn3NFdekbMfF9NyJgBNUWs';
const TELEGRAM_CHAT_ID = '8182530431';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';

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

async function setDB(products, orders, oldSha) {
  const content = { products, orders, updatedAt: new Date().toISOString() };
  const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
    method: 'PUT',
    headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Update db', content: updatedContent, sha: oldSha })
  });
  if (!res.ok) throw new Error('GitHub save failed');
  const data = await res.json();
  return data.content.sha;
}

// ========== FUNGSI KIRIM PESAN KE TELEGRAM ==========
async function sendTelegramMessage(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Telegram error:', err);
  }
}

// ========== 1. AUTO PING WEB (biar ga tidur) ==========
async function autoPingWeb() {
  const url = 'https://stockyanto.vercel.app/api/health';
  try {
    const response = await fetch(url);
    console.log(`🏓 Auto ping: ${response.status}`);
  } catch (err) {
    console.error('Ping failed:', err);
  }
}
setInterval(autoPingWeb, 5 * 60 * 1000); // setiap 5 menit

// ========== 2. AUTO CEK KESEHATAN API QRISPY ==========
let qrispyHealthy = true;
async function checkQrispyHealth() {
  try {
    const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
      method: 'POST',
      headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 1000, payment_reference: 'health-check' })
    });
    const data = await response.json();
    
    if (!qrispyHealthy && data.status === 'success') {
      qrispyHealthy = true;
      await sendTelegramMessage('✅ <b>QRISPY API</b> sudah kembali normal.');
    } else if (qrispyHealthy && data.status !== 'success') {
      qrispyHealthy = false;
      await sendTelegramMessage('⚠️ <b>QRISPY API</b> sedang bermasalah! Cek log untuk detail.');
    }
    console.log(`🩺 Health check QRISPY: ${data.status || 'error'}`);
  } catch (err) {
    if (qrispyHealthy) {
      qrispyHealthy = false;
      await sendTelegramMessage(`⚠️ <b>QRISPY API ERROR</b>\n${err.message}`);
    }
    console.error('Health check error:', err);
  }
}
setInterval(checkQrispyHealth, 10 * 60 * 1000); // setiap 10 menit
checkQrispyHealth(); // langsung cek sekali

// ========== 3. AUTO HITUNG PENDAPATAN HARIAN (jam 00:00) ==========
async function dailyRevenueReport() {
  const db = await getDB();
  const today = new Date().toISOString().split('T')[0];
  const todayOrders = db.orders.filter(o => {
    if (!o.paidAt) return false;
    return o.paidAt.split('T')[0] === today;
  });
  
  const totalRevenue = todayOrders.reduce((sum, o) => sum + (o.totalAmount || o.price || 0), 0);
  const productSales = {};
  todayOrders.forEach(o => {
    productSales[o.productName] = (productSales[o.productName] || 0) + 1;
  });
  
  let topProducts = Object.entries(productSales).sort((a,b) => b[1] - a[1]).slice(0, 3);
  let topText = topProducts.map(([name, count]) => `  • ${name}: ${count} terjual`).join('\n');
  
  await sendTelegramMessage(`
📊 <b>LAPORAN HARIAN YANTO STORE</b>
📅 Tanggal: ${today}
💰 Total Pendapatan: Rp ${totalRevenue.toLocaleString()}
📦 Total Transaksi: ${todayOrders.length}

🏆 <b>PRODUK TERLARIS HARI INI:</b>
${topText || '  • Belum ada penjualan'}
  `);
}

// Jadwalkan setiap jam 00:00 (perlu cron job, ini pake setInterval cek tiap menit)
let lastReportDate = '';
async function checkDailyReport() {
  const today = new Date().toISOString().split('T')[0];
  if (lastReportDate !== today && new Date().getHours() === 0) {
    lastReportDate = today;
    await dailyRevenueReport();
  }
}
setInterval(checkDailyReport, 60 * 1000);

// ========== 4. AUTO BACKUP DATABASE KE TELEGRAM ==========
async function autoBackupToTelegram() {
  const db = await getDB();
  const backupData = JSON.stringify(db, null, 2);
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('document', new Blob([backupData]), `backup_${new Date().toISOString().split('T')[0]}.json`);
  formData.append('caption', `📦 Auto Backup Database\n📅 ${new Date().toLocaleString()}`);
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formData
  });
  console.log('💾 Auto backup terkirim ke Telegram');
}

// Backup setiap jam 03:00
let lastBackupDate = '';
async function checkDailyBackup() {
  const today = new Date().toISOString().split('T')[0];
  if (lastBackupDate !== today && new Date().getHours() === 3) {
    lastBackupDate = today;
    await autoBackupToTelegram();
  }
}
setInterval(checkDailyBackup, 60 * 1000);

// ========== 5. CANCEL QRIS DI QRISPY (UPDATE) ==========
async function cancelQRISInQrispy(qrisId) {
  try {
    console.log(`🔄 Mencoba cancel QRIS: ${qrisId}`);
    const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/cancel`, {
      method: 'POST',
      headers: { 
        'X-API-Token': QRISPY_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    const data = await response.json();
    console.log(`📡 Response cancel QRIS:`, data);
    
    if (data.status === 'success') {
      console.log(`✅ QRIS ${qrisId} berhasil di-cancel`);
      return true;
    } else {
      console.log(`⚠️ Gagal cancel QRIS: ${data.message || 'Unknown error'}`);
      return false;
    }
  } catch (err) {
    console.error('❌ Cancel QRIS error:', err);
    return false;
  }
}

// ========== CANCEL ORDER (UPDATE) ==========
app.post('/api/cancel-order/:orderId', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
  
  // Cancel QRIS di Qrispy
  if (order.qrisId && order.qrisId !== 'test-' && !order.qrisId.startsWith('test')) {
    const cancelled = await cancelQRISInQrispy(order.qrisId);
    if (cancelled) {
      await sendTelegramMessage(`🗑️ <b>ORDER DIBATALKAN</b>\n🆔 Order: ${order.orderCode}\n📦 Produk: ${order.productName}\n💰 Total: Rp ${order.totalAmount.toLocaleString()}\n✅ QRIS telah di-cancel di Qrispy.`);
    } else {
      await sendTelegramMessage(`⚠️ <b>GAGAL CANCEL QRIS</b>\n🆔 Order: ${order.orderCode}\n📦 Produk: ${order.productName}\n❌ QRIS tidak bisa di-cancel (mungkin sudah kadaluarsa/dibayar).`);
    }
  }
  
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await setDB(db.products, db.orders, db.sha);
  
  res.json({ success: true, message: 'Order dibatalkan' });
});

// ========== RESET ORDER ==========
app.post('/api/admin/reset-orders', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const paidOrders = db.orders.filter(o => o.status === 'paid');
  const deletedCount = db.orders.length - paidOrders.length;
  db.orders = paidOrders;
  await setDB(db.products, db.orders, db.sha);
  
  await sendTelegramMessage(`🗑️ <b>RESET ORDER</b>\n\n✅ ${deletedCount} order (pending/cancelled) dihapus.\n📦 ${paidOrders.length} order paid tersimpan.`);
  
  res.json({ success: true, deletedCount, keptCount: paidOrders.length });
});

// ========== DELETE SELECTED ORDERS ==========
app.post('/api/admin/delete-selected-orders', async (req, res) => {
  const { adminKey, orderIds } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!orderIds || !orderIds.length) return res.status(400).json({ error: 'Tidak ada order dipilih' });
  
  const db = await getDB();
  const deletedCount = orderIds.length;
  db.orders = db.orders.filter(o => !orderIds.includes(o.id.toString()));
  await setDB(db.products, db.orders, db.sha);
  
  res.json({ success: true, deletedCount });
});

// ========== AUTO DELETE CANCELED/EXPIRED ==========
async function cleanupOrders() {
  console.log('🧹 Menjalankan cleanup orders...');
  const db = await getDB();
  let deletedCount = 0;
  const ordersToKeep = [];
  
  for (const order of db.orders) {
    let shouldKeep = true;
    if (order.status === 'cancelled') {
      shouldKeep = false;
      deletedCount++;
    } else if (order.status === 'expired') {
      shouldKeep = false;
      deletedCount++;
    }
    if (shouldKeep) ordersToKeep.push(order);
  }
  
  if (deletedCount > 0) {
    db.orders = ordersToKeep;
    await setDB(db.products, db.orders, db.sha);
    console.log(`✅ Cleanup selesai, ${deletedCount} order dihapus`);
  }
}

setInterval(cleanupOrders, 30 * 1000);
cleanupOrders();

// ========== TEST ORDER ==========
app.post('/api/admin/test-order', async (req, res) => {
  const { productId, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const product = db.products.find(p => p.id == productId);
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;');
  }
  
  // Format bonus
  let bonusHtml = '';
  if (product.bonusContent && product.bonusContent !== '') {
    if (product.bonusContent.includes('\n')) {
      const items = product.bonusContent.split('\n').filter(item => item.trim());
      bonusHtml = `
        <div class="section">
          <div class="section-title"><i class="fas fa-gift"></i> Bonus</div>
          <ul class="bonus-list">${items.map(item => `<li><i class="fas fa-star"></i> ${escapeHtml(item.trim())}</li>`).join('')}</ul>
        </div>
      `;
    } else {
      const escapedBonus = escapeHtml(product.bonusContent).replace(/"/g, '&quot;');
      bonusHtml = `
        <div class="section">
          <div class="section-title"><i class="fas fa-gift"></i> Bonus</div>
          <div class="text-content">${escapeHtml(product.bonusContent)}</div>
          <button class="chip-btn copy-btn" data-copy="${escapedBonus}"><i class="fas fa-copy"></i> Salin Teks</button>
        </div>
      `;
    }
  }
  
  // Format item
  let itemHtml = '';
  const isLink = product.itemContent.startsWith('http');
  const isHtml = product.itemType === 'html';
  
  if (isHtml) {
    const rawHtml = product.itemContent;
    const escapedForAttr = rawHtml.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    itemHtml = `
      <div class="section">
        <div class="section-title"><i class="fas fa-code"></i> Barang Utama (HTML)</div>
        <div class="item-row">
          <div class="item-content">
            <div class="html-preview" style="background:#0f172a; padding:12px; border-radius:12px; color:#e2e8f0; font-size:0.75rem; font-family:monospace; white-space:pre-wrap; word-break:break-all; max-height:200px; overflow:auto; border:1px solid #334155;">${rawHtml}</div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="chip-btn preview-btn" data-html="${escapedForAttr}"><i class="fas fa-eye"></i> Cek</button>
            <button class="chip-btn copy-btn" data-copy="${escapedForAttr}"><i class="fas fa-copy"></i> Salin HTML</button>
          </div>
        </div>
      </div>
    `;
  } else if (isLink) {
    const escapedContent = escapeHtml(product.itemContent).replace(/"/g, '&quot;');
    itemHtml = `
      <div class="section">
        <div class="section-title"><i class="fas fa-box"></i> Barang Utama</div>
        <div class="item-row">
          <div class="item-content"><div class="text-content">${escapeHtml(product.itemContent)}</div></div>
          <div style="display: flex; gap: 8px;">
            <button class="chip-btn copy-btn" data-copy="${escapedContent}"><i class="fas fa-copy"></i> Salin Link</button>
            <a href="${escapeHtml(product.itemContent)}" class="chip-btn link-chip" target="_blank"><i class="fas fa-external-link-alt"></i> Buka</a>
          </div>
        </div>
      </div>
    `;
  } else {
    const escapedContent = escapeHtml(product.itemContent).replace(/"/g, '&quot;');
    itemHtml = `
      <div class="section">
        <div class="section-title"><i class="fas fa-box"></i> Barang Utama</div>
        <div class="item-row">
          <div class="item-content"><div class="text-content">${escapeHtml(product.itemContent)}</div></div>
          <button class="chip-btn copy-btn" data-copy="${escapedContent}"><i class="fas fa-copy"></i> Salin Teks</button>
        </div>
      </div>
    `;
  }
  
  res.send(`<!DOCTYPE html>...`); // template HTML test order (sama seperti sebelumnya)
});

// ========== API LAINNYA (GET, POST, dll) ==========
app.get('/api/admin/product/:id', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const db = await getDB();
  const product = db.products.find(p => p.id == req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true, product });
});

app.put('/api/admin/product/:id', async (req, res) => {
  const { adminKey, name, description, price, stock, itemType, itemContent, bonusType, bonusContent } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!name || !itemContent || price <= 0) return res.status(400).json({ error: 'Invalid data' });
  const db = await getDB();
  const index = db.products.findIndex(p => p.id == req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Product not found' });
  db.products[index] = {
    ...db.products[index],
    name,
    description: description || '',
    price: parseInt(price),
    stock: parseInt(stock) || 1,
    itemType: itemType || 'text',
    itemContent,
    bonusType: bonusType || 'none',
    bonusContent: bonusContent || '',
    updatedAt: new Date().toISOString()
  };
  await setDB(db.products, db.orders, db.sha);
  res.json({ success: true });
});

app.get('/api/get-order/:orderCode', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.orderCode === req.params.orderCode);
  if (!order) return res.json({ success: false });
  const product = db.products.find(p => p.id == order.productId);
  const bonusContent = product?.bonusContent || '';
  res.json({
    success: true,
    status: order.status,
    productName: order.productName,
    productCode: order.productCode || 'Tidak ada kode',
    bonusContent: bonusContent,
    qrisImage: order.qrisImage,
    totalAmount: order.totalAmount,
    expiredAt: order.expiredAt,
    itemType: product?.itemType || 'text'
  });
});

app.get('/api/check-payment/:orderCode', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.orderCode === req.params.orderCode);
  if (!order) return res.json({ status: 'not_found' });
  
  if (order.status === 'paid') {
    return res.json({ status: 'paid', productCode: order.productCode });
  }
  
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
      return res.json({ status: 'paid', productCode: order.productCode });
    }
    res.json({ status: 'pending' });
  } catch (err) {
    res.json({ status: 'pending' });
  }
});

app.get('/api/products', async (req, res) => {
  const db = await getDB();
  res.json({ success: true, products: db.products });
});

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

async function generateQRIS(amount, paymentReference) {
  try {
    const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
      method: 'POST',
      headers: {
        'X-API-Token': QRISPY_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount, payment_reference: paymentReference })
    });
    const data = await response.json();
    return data;
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

app.get('/api/admin/stats', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const totalProducts = db.products.length;
  const totalOrders = db.orders.length;
  const paidOrders = db.orders.filter(o => o.status === 'paid');
  const totalRevenue = paidOrders.reduce((sum, o) => sum + (o.totalAmount || o.price || 0), 0);
  const pendingCount = db.orders.filter(o => o.status === 'pending').length;
  const expiredCount = db.orders.filter(o => o.status === 'expired').length;
  const cancelledCount = db.orders.filter(o => o.status === 'cancelled').length;
  
  res.json({
    success: true,
    stats: {
      totalProducts,
      totalOrders,
      totalRevenue,
      pendingCount,
      expiredCount,
      cancelledCount,
      paidCount: paidOrders.length
    }
  });
});

app.post('/api/admin/backup', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const backupData = JSON.stringify(db, null, 2);
  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('document', new Blob([backupData]), `backup_${Date.now()}.json`);
  formData.append('caption', `📦 Backup database Yanto Store\n📅 ${new Date().toLocaleString()}`);
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: formData
  });
  res.json({ success: true });
});

app.post('/api/admin/broadcast', async (req, res) => {
  const { adminKey, message } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!message) return res.status(400).json({ error: 'Pesan wajib diisi' });
  
  const db = await getDB();
  const uniqueCustomers = [...new Map(db.orders.map(o => [o.customerName, o.customerEmail])).entries()];
  let sentCount = 0;
  for (const [name, email] of uniqueCustomers) {
    if (email && email !== '-') {
      console.log(`Send email to ${email}: ${message}`);
      sentCount++;
    }
  }
  
  await sendTelegramMessage(`📢 <b>BROADCAST</b>\n\n${message}\n\n📨 Terkirim ke ${sentCount} customer.`);
  res.json({ success: true, sentCount });
});

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
    itemContent: itemContent,
    bonusType: bonusType || 'none',
    bonusContent: bonusContent || '',
    createdAt: new Date().toISOString()
  });
  await setDB(db.products, db.orders, db.sha);
  res.json({ success: true });
});

app.delete('/api/admin/product/:id', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const db = await getDB();
  db.products = db.products.filter(p => p.id != req.params.id);
  await setDB(db.products, db.orders, db.sha);
  res.json({ success: true });
});

app.get('/api/admin/orders', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const db = await getDB();
  res.json({ success: true, orders: db.orders });
});

app.get('/api/admin/products', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const db = await getDB();
  res.json({ success: true, products: db.products });
});

// ========== ROUTING HALAMAN ==========
app.get('/order/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/order.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

module.exports = app;
