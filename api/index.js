const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_KEY = 'rahasia123';

// Konfigurasi GitHub
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

// ========== WEBHOOK QRISPY (tetap ada untuk notifikasi real-time) ==========
const WEBHOOK_SECRET = 'whsec_jJfqxO5wpcbQQF7sMVURsJ7re3ofIVTX';
app.post('/api/webhook', (req, res) => {
  const signature = req.headers['x-qrispy-signature'];
  const payload = JSON.stringify(req.body);
  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  if (signature !== expected) return res.status(401).end();
  res.status(200).end();
  
  (async () => {
    try {
      const { event, data } = req.body;
      if (event === 'payment.received') {
        const db = await getDB();
        const order = db.orders.find(o => o.qrisId === data.qris_id);
        if (!order || order.status === 'paid') return;
        const product = db.products.find(p => p.id == order.productId);
        if (product && product.stock > 0) product.stock -= 1;
        order.status = 'paid';
        order.paidAt = data.paid_at || new Date().toISOString();
        await setDB(db.products, db.orders, db.sha);
        console.log(`Order ${order.id} paid via webhook`);
      }
    } catch(e) {}
  })();
});

// ========== ENDPOINT untuk menerima order dari frontend ==========
app.post('/api/order-frontend', async (req, res) => {
  const { productId, customerName, customerEmail, qrisId, qrisImage, amount, expiredAt } = req.body;
  try {
    const db = await getDB();
    const product = db.products.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });

    const newOrder = {
      id: Date.now(),
      qrisId,
      productId,
      productName: product.name,
      productCode: product.itemCode,
      price: amount,
      customerName,
      customerEmail: customerEmail || '-',
      status: 'pending',
      qrisImage,
      expiredAt,
      createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true, orderId: newOrder.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== API lainnya (tidak berubah) ==========
app.get('/api/products', async (req, res) => {
  const db = await getDB();
  res.json({ success: true, products: db.products });
});

app.get('/api/check-payment/:orderId', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.id == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status === 'paid') {
    return res.json({ success: true, status: 'paid', productCode: order.productCode });
  }
  if (new Date(order.expiredAt) < new Date()) {
    order.status = 'expired';
    await setDB(db.products, db.orders, db.sha);
    return res.json({ success: true, status: 'expired' });
  }
  res.json({ success: true, status: 'pending' });
});

app.post('/api/cancel-order/:orderId', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.id == req.params.orderId);
  if (!order || order.status !== 'pending') return res.status(400).json({ error: 'Tidak bisa dibatalkan' });
  order.status = 'cancelled';
  await setDB(db.products, db.orders, db.sha);
  res.json({ success: true });
});

// ========== API ADMIN (tidak berubah) ==========
app.post('/api/admin/product', async (req, res) => {
  const { name, price, stock, itemCode, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!name || !itemCode || price <= 0) return res.status(400).json({ error: 'Invalid data' });
  const db = await getDB();
  db.products.push({ id: Date.now(), name, price: parseInt(price), stock: parseInt(stock) || 1, itemCode, createdAt: new Date().toISOString() });
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

module.exports = app;
