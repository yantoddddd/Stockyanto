const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ========== KONFIGURASI QRISPY ==========
const QRISPY_API_TOKEN = 'cki_MDT3cC14ASTcV9yCcZOEOROZFqVgNvZlWjsC5ofjrp3x2DBe';
const QRISPY_API_URL = 'https://api.qrispy.id';

// ========== STORAGE (MEMORY) ==========
let products = [];
let orders = [];

// ========== ADMIN KEY ==========
const ADMIN_KEY = 'rahasia123';

// ========== FUNGSI GENERATE QRIS ==========
async function generateQRIS(amount, paymentReference) {
  const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
    method: 'POST',
    headers: {
      'X-API-Token': QRISPY_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amount,
      payment_reference: paymentReference
    })
  });
  return await response.json();
}

// ========== FUNGSI CEK STATUS ==========
async function checkPaymentStatus(qrisId) {
  const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/status`, {
    headers: { 'X-API-Token': QRISPY_API_TOKEN }
  });
  return await response.json();
}

// ========== API: GET PRODUK ==========
app.get('/api/products', (req, res) => {
  res.json({ success: true, products });
});

// ========== API: ORDER (GENERATE QRIS DARI HARGA PRODUK) ==========
app.post('/api/order', async (req, res) => {
  const { productId, customerName, customerEmail } = req.body;
  if (!productId || !customerName) {
    return res.status(400).json({ error: 'Nama dan produk wajib' });
  }
  
  const product = products.find(p => p.id == productId);
  if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });
  if (product.stock <= 0) return res.status(400).json({ error: 'Stok habis' });
  
  // Generate QRIS dengan nominal = harga produk (admin yang set)
  const paymentRef = `order-${Date.now()}-${productId}`;
  const qrisResult = await generateQRIS(product.price, paymentRef);
  
  if (qrisResult.status !== 'success') {
    return res.status(500).json({ error: 'Gagal generate QRIS' });
  }
  
  // Simpan order
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
  orders.unshift(newOrder);
  
  res.json({
    success: true,
    orderId: newOrder.id,
    qrisId: qrisResult.data.qris_id,
    qrisImage: qrisResult.data.qris_image_url,
    amount: product.price,
    expiredAt: qrisResult.data.expired_at
  });
});

// ========== API: CEK STATUS PEMBAYARAN ==========
app.get('/api/check-payment/:orderId', async (req, res) => {
  const order = orders.find(o => o.id == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  
  // Kalo udah sukses, langsung balikin
  if (order.status === 'paid') {
    return res.json({ success: true, status: 'paid', productCode: order.productCode });
  }
  
  // Cek ke API QRISPY
  const statusResult = await checkPaymentStatus(order.qrisId);
  
  if (statusResult.status === 'success' && statusResult.data.status === 'paid') {
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    
    // Kurangi stok produk
    const product = products.find(p => p.id == order.productId);
    if (product) product.stock -= 1;
    
    return res.json({ success: true, status: 'paid', productCode: order.productCode });
  }
  
  // Cek kadaluarsa
  if (new Date(order.expiredAt) < new Date()) {
    order.status = 'expired';
    return res.json({ success: true, status: 'expired' });
  }
  
  res.json({ success: true, status: 'pending' });
});

// ========== API: CANCEL ORDER ==========
app.post('/api/cancel-order/:orderId', async (req, res) => {
  const order = orders.find(o => o.id == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status !== 'pending') {
    return res.status(400).json({ error: 'Order sudah diproses' });
  }
  
  // Cancel ke QRISPY
  await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/cancel`, {
    method: 'POST',
    headers: { 'X-API-Token': QRISPY_API_TOKEN }
  });
  
  order.status = 'cancelled';
  res.json({ success: true });
});

// ========== ADMIN: TAMBAH PRODUK ==========
app.post('/api/admin/product', (req, res) => {
  const { name, price, stock, itemCode, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!name || !itemCode || price <= 0) {
    return res.status(400).json({ error: 'Nama, harga > 0, dan kode wajib' });
  }
  
  products.push({
    id: Date.now(),
    name,
    price: parseInt(price),
    stock: parseInt(stock) || 1,
    itemCode,
    createdAt: new Date().toISOString()
  });
  res.json({ success: true });
});

// ========== ADMIN: HAPUS PRODUK ==========
app.delete('/api/admin/product/:id', (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  products = products.filter(p => p.id != req.params.id);
  res.json({ success: true });
});

// ========== ADMIN: GET SEMUA ORDER ==========
app.get('/api/admin/orders', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, orders });
});

// ========== ADMIN: GET PRODUK ==========
app.get('/api/admin/products', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, products });
});

module.exports = app;
