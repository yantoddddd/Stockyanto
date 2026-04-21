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

// ========== AUTO DELETE: CANCELLED LANGSUNG, EXPIRED LANGSUNG ==========
async function cleanupOrders() {
  console.log('🧹 Menjalankan cleanup orders...');
  const db = await getDB();
  let deletedCount = 0;
  const now = new Date();
  const ordersToKeep = [];
  
  for (const order of db.orders) {
    let shouldKeep = true;
    
    // CANCELLED: LANGSUNG DIHAPUS (no jeda)
    if (order.status === 'cancelled') {
      shouldKeep = false;
      deletedCount++;
      console.log(`🗑️ Hapus order cancelled: ${order.orderCode}`);
    }
    
    // EXPIRED: LANGSUNG DIHAPUS (no jeda)
    else if (order.status === 'expired') {
      shouldKeep = false;
      deletedCount++;
      console.log(`🗑️ Hapus order expired: ${order.orderCode}`);
    }
    
    // PENDING: tetap disimpan sampai expired (tidak dihapus)
    // PAID: tetap disimpan (tidak dihapus)
    // TEST: tetap disimpan
    
    if (shouldKeep) ordersToKeep.push(order);
  }
  
  if (deletedCount > 0) {
    db.orders = ordersToKeep;
    await setDB(db.products, db.orders, db.sha);
    console.log(`✅ Cleanup selesai, ${deletedCount} order dihapus`);
  }
}

// Jalankan cleanup setiap 30 detik (biar cepet)
setInterval(cleanupOrders, 30 * 1000);
cleanupOrders();

// ========== RESET ORDER (HAPUS HANYA PENDING & CANCELLED) ==========
app.post('/api/admin/reset-orders', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const paidOrders = db.orders.filter(o => o.status === 'paid');
  const deletedCount = db.orders.length - paidOrders.length;
  
  db.orders = paidOrders;
  await setDB(db.products, db.orders, db.sha);
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `🗑️ *RESET ORDER*\n\n✅ ${deletedCount} order (pending/cancelled) telah dihapus.\n📦 ${paidOrders.length} order paid tetap tersimpan.`,
      parse_mode: 'Markdown'
    })
  }).catch(console.error);
  
  res.json({ success: true, deletedCount, keptCount: paidOrders.length });
});

// ========== TEST ORDER (LANGSUNG SUCCESS, TIDAK PAKAI QRIS) ==========
app.post('/api/admin/test-order', async (req, res) => {
  const { productId, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  
  const db = await getDB();
  const product = db.products.find(p => p.id == productId);
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  
  const testOrderCode = crypto.randomBytes(16).toString('hex');
  const testOrder = {
    id: Date.now(),
    orderCode: testOrderCode,
    qrisId: `test-${Date.now()}`,
    productId: product.id,
    productName: product.name,
    productCode: product.itemContent,
    price: product.price,
    totalAmount: product.price,
    customerName: 'ADMIN_TEST',
    customerEmail: '-',
    status: 'paid',
    qrisImage: '',
    expiredAt: new Date(Date.now() + 15 * 60000).toISOString(),
    createdAt: new Date().toISOString(),
    paidAt: new Date().toISOString()
  };
  db.orders.unshift(testOrder);
  await setDB(db.products, db.orders, db.sha);
  
  res.json({ success: true, orderCode: testOrderCode });
});

// ========== GET PRODUCT BY ID ==========
app.get('/api/admin/product/:id', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const db = await getDB();
  const product = db.products.find(p => p.id == req.params.id);
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ success: true, product });
});

// ========== UPDATE PRODUCT ==========
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

// ========== API GET ORDER ==========
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
    expiredAt: order.expiredAt
  });
});

// ========== CEK STATUS PEMBAYARAN ==========
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

// ========== API PRODUK ==========
app.get('/api/products', async (req, res) => {
  const db = await getDB();
  res.json({ success: true, products: db.products });
});

// ========== API BUAT ORDER ==========
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

// ========== CANCEL ORDER ==========
app.post('/api/cancel-order/:orderId', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
  
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await setDB(db.products, db.orders, db.sha);
  
  res.json({ success: true });
});

// ========== FUNGSI GENERATE QRIS ==========
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

// ========== FUNGSI TAMBAHAN ADMIN ==========
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
  
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: `📢 *BROADCAST*\n\n${message}\n\n📨 Terkirim ke ${sentCount} customer.`,
      parse_mode: 'Markdown'
    })
  });
  
  res.json({ success: true, sentCount });
});

// ========== ADMIN API ==========
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

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

module.exports = app;
