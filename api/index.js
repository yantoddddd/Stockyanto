const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ========== KONFIGURASI ==========
const QRISPY_API_TOKEN = 'cki_MDT3cC14ASTcV9yCcZOEOROZFqVgNvZlWjsC5ofjrp3x2DBe';
const QRISPY_API_URL = 'https://api.qrispy.id';
const ADMIN_KEY = 'rahasia123';

// Backup ke Telegram (pake bot lo yang udah ada)
const TELEGRAM_BOT_TOKEN = '8622926718:AAFgjPx774euFGn3NFdekbMfF9NyJgBNUWs';
const TELEGRAM_BACKUP_CHAT_ID = '-5260518165'; // grup lo

// ========== DATA DI MEMORY ==========
let products = [];
let orders = [];

// ========== FUNGSI BACKUP KE TELEGRAM ==========
async function backupToTelegram() {
  try {
    const data = JSON.stringify({ products, orders, updatedAt: new Date().toISOString() }, null, 2);
    // Kirim sebagai file
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_BACKUP_CHAT_ID);
    formData.append('document', new Blob([data]), 'database_backup.json');
    formData.append('caption', `Backup ${new Date().toLocaleString()}`);
    
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    console.log('Backup ke Telegram berhasil');
  } catch (err) {
    console.error('Backup gagal:', err);
  }
}

// ========== FUNGSI RESTORE DARI TELEGRAM (panggil manual via API) ==========
app.get('/api/restore', async (req, res) => {
  try {
    // Ambil pesan terakhir yang berisi file backup
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 50, allowed_updates: ['message'] })
    });
    const data = await response.json();
    
    // Cari file backup terbaru
    let lastBackup = null;
    if (data.ok && data.result) {
      for (let update of data.result.reverse()) {
        if (update.message?.document?.file_name === 'database_backup.json') {
          lastBackup = update.message.document;
          break;
        }
      }
    }
    
    if (lastBackup) {
      const fileInfo = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${lastBackup.file_id}`);
      const fileData = await fileInfo.json();
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
      
      const backupRes = await fetch(fileUrl);
      const backupData = await backupRes.json();
      
      if (backupData.products) products = backupData.products;
      if (backupData.orders) orders = backupData.orders;
      
      res.json({ success: true, message: 'Restore berhasil', products: products.length, orders: orders.length });
    } else {
      res.json({ success: false, message: 'Tidak ada backup ditemukan' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== FUNGSI GENERATE QRIS ==========
async function generateQRIS(amount, paymentReference) {
  const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/generate`, {
    method: 'POST',
    headers: {
      'X-API-Token': QRISPY_API_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ amount, payment_reference: paymentReference })
  });
  const data = await response.json();
  console.log('Generate QRIS:', data);
  return data;
}

async function checkPaymentStatus(qrisId) {
  const response = await fetch(`${QRISPY_API_URL}/api/payment/qris/${qrisId}/status`, {
    headers: { 'X-API-Token': QRISPY_API_TOKEN }
  });
  return await response.json();
}

// ========== API CUSTOMER ==========
app.get('/api/products', (req, res) => {
  res.json({ success: true, products });
});

app.post('/api/order', async (req, res) => {
  const { productId, customerName, customerEmail } = req.body;
  if (!productId || !customerName) return res.status(400).json({ error: 'Nama dan produk wajib' });
  
  const product = products.find(p => p.id == productId);
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

app.get('/api/check-payment/:orderId', async (req, res) => {
  const order = orders.find(o => o.id == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status === 'paid') return res.json({ success: true, status: 'paid', productCode: order.productCode });
  if (new Date(order.expiredAt) < new Date()) {
    order.status = 'expired';
    return res.json({ success: true, status: 'expired' });
  }
  
  const statusResult = await checkPaymentStatus(order.qrisId);
  if (statusResult.status === 'success' && statusResult.data.status === 'paid') {
    const product = products.find(p => p.id == order.productId);
    if (product && product.stock > 0) product.stock -= 1;
    order.status = 'paid';
    order.paidAt = new Date().toISOString();
    await backupToTelegram(); // backup setiap ada perubahan
    return res.json({ success: true, status: 'paid', productCode: order.productCode });
  }
  
  res.json({ success: true, status: 'pending' });
});

app.post('/api/cancel-order/:orderId', async (req, res) => {
  const order = orders.find(o => o.id == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
  
  try {
    await fetch(`${QRISPY_API_URL}/api/payment/qris/${order.qrisId}/cancel`, { method: 'POST', headers: { 'X-API-Token': QRISPY_API_TOKEN } });
  } catch(e) {}
  
  order.status = 'cancelled';
  res.json({ success: true });
});

// ========== API ADMIN ==========
app.post('/api/admin/product', async (req, res) => {
  const { name, price, stock, itemCode, adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!name || !itemCode || price <= 0) return res.status(400).json({ error: 'Nama, harga >0, dan kode wajib' });
  
  products.push({
    id: Date.now(),
    name,
    price: parseInt(price),
    stock: parseInt(stock) || 1,
    itemCode,
    createdAt: new Date().toISOString()
  });
  await backupToTelegram();
  res.json({ success: true });
});

app.delete('/api/admin/product/:id', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  products = products.filter(p => p.id != req.params.id);
  await backupToTelegram();
  res.json({ success: true });
});

app.get('/api/admin/orders', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, orders });
});

app.get('/api/admin/products', (req, res) => {
  const { adminKey } = req.query;
  if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, products });
});

module.exports = app;
