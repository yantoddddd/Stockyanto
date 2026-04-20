const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// ========== KONFIGURASI QRISPY ==========
const QRISPY_API_TOKEN = 'cki_IBpAYezwDHbfrMuENZMFvFw5mI94M11dAT146N0Ar4HrOWKi';
const QRISPY_API_URL = 'https://api.qrispy.id';
const ADMIN_KEY = 'rahasia123';

// ========== KONFIGURASI WEBHOOK ==========
const WEBHOOK_SECRET = 'whsec_jJfqxO5wpcbQQF7sMVURsJ7re3ofIVTX';

// ========== KONFIGURASI GITHUB ==========
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';

// ========== FUNGSI BACA DATABASE DARI GITHUB ==========
async function getDB() {
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
      headers: { 
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    if (!res.ok) {
      return { products: [], orders: [], sha: null };
    }
    const data = await res.json();
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return { ...JSON.parse(content), sha: data.sha };
  } catch (err) {
    console.error('Get DB error:', err);
    return { products: [], orders: [], sha: null };
  }
}

// ========== FUNGSI SIMPAN DATABASE KE GITHUB ==========
async function setDB(products, orders, oldSha) {
  const content = { products, orders, updatedAt: new Date().toISOString() };
  const updatedContent = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
    method: 'PUT',
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Update database ${new Date().toISOString()}`,
      content: updatedContent,
      sha: oldSha
    })
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`GitHub save failed: ${error}`);
  }
  const data = await res.json();
  return data.content.sha;
}

// ========== FUNGSI GENERATE QRIS ==========
async function generateQRIS(amount, paymentReference) {
  try {
    const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
      method: 'POST',
      headers: {
        'X-API-Token': QRISPY_API_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ amount, payment_reference: paymentReference })
    });
    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      console.error('QRIS API non-JSON:', raw);
      return { status: 'error', message: `API error: ${raw.substring(0, 100)}` };
    }
    console.log('QRIS generate response:', data);
    return data;
  } catch (err) {
    console.error('QRIS generate exception:', err);
    return { status: 'error', message: err.message };
  }
}

// ========== WEBHOOK UNTUK PEMBAYARAN (DENGAN VERIFIKASI SIGNATURE) ==========
app.post('/api/webhook', (req, res) => {
  const signature = req.headers['x-qrispy-signature'];
  const payload = req.rawBody.toString();
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  
  if (signature !== expected) {
    console.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }
  
  // Signature valid, proses async
  res.status(200).end();
  
  (async () => {
    try {
      const { event, data } = req.body;
      if (event === 'payment.received') {
        const qrisId = data?.qris_id;
        if (!qrisId) return;
        const db = await getDB();
        const order = db.orders.find(o => o.qrisId === qrisId);
        if (!order || order.status === 'paid') return;
        
        const product = db.products.find(p => p.id == order.productId);
        if (product && product.stock > 0) product.stock -= 1;
        order.status = 'paid';
        order.paidAt = data.paid_at || new Date().toISOString();
        await setDB(db.products, db.orders, db.sha);
        console.log(`Order ${order.id} paid via webhook`);
      }
    } catch (err) {
      console.error('Webhook process error:', err);
    }
  })();
});

// ========== API CUSTOMER ==========
app.get('/api/products', async (req, res) => {
  try {
    const db = await getDB();
    res.json({ success: true, products: db.products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/order', async (req, res) => {
  const { productId, customerName, customerEmail } = req.body;
  if (!productId || !customerName) {
    return res.status(400).json({ error: 'Nama dan produk wajib' });
  }
  try {
    const db = await getDB();
    const product = db.products.find(p => p.id == productId);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
    if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
    
    const paymentRef = `order-${Date.now()}-${productId}`;
    const qrisResult = await generateQRIS(product.price, paymentRef);
    if (qrisResult.status !== 'success') {
      return res.status(500).json({ error: qrisResult.message || 'Gagal generate QRIS' });
    }
    
    const newOrder = {
      id: Date.now(),
      qrisId: qrisResult.data.qris_id,
      productId: product.id,
      productName: product.name,
      productCode: product.itemCode,
      price: product.price,
      customerName,
      customerEmail: customerEmail || '-',
      status: 'pending',
      qrisImage: qrisResult.data.qris_image_url,
      expiredAt: qrisResult.data.expired_at,
      createdAt: new Date().toISOString()
    };
    db.orders.unshift(newOrder);
    await setDB(db.products, db.orders, db.sha);
    res.json({
      success: true,
      orderId: newOrder.id,
      qrisId: qrisResult.data.qris_id,
      qrisImage: qrisResult.data.qris_image_url,
      amount: product.price,
      expiredAt: qrisResult.data.expired_at
    });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/check-payment/:orderId', async (req, res) => {
  try {
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/cancel-order/:orderId', async (req, res) => {
  try {
    const db = await getDB();
    const order = db.orders.find(o => o.id == req.params.orderId);
    if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
    if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
    order.status = 'cancelled';
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== API ADMIN ==========
app.post('/api/admin/product', async (req, res) => {
  const { name, price, stock, itemCode, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!name || !itemCode || price <= 0) {
    return res.status(400).json({ error: 'Nama, harga >0, dan kode wajib' });
  }
  try {
    const db = await getDB();
    db.products.push({
      id: Date.now(),
      name,
      price: parseInt(price),
      stock: parseInt(stock) || 1,
      itemCode,
      createdAt: new Date().toISOString()
    });
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/product/:id', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDB();
    db.products = db.products.filter(p => p.id != req.params.id);
    await setDB(db.products, db.orders, db.sha);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/orders', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDB();
    res.json({ success: true, orders: db.orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/products', async (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const db = await getDB();
    res.json({ success: true, products: db.products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
