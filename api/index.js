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

// ========== AUTO DELETE ==========
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

// ========== RESET ORDER ==========
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
      text: `🗑️ *RESET ORDER*\n\n✅ ${deletedCount} order dihapus.\n📦 ${paidOrders.length} order paid tersimpan.`,
      parse_mode: 'Markdown'
    })
  }).catch(console.error);
  
  res.json({ success: true, deletedCount, keptCount: paidOrders.length });
});

// ========== FUNGSI CANCEL QRIS DI QRISPY ==========
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

// ========== CANCEL ORDER (juga cancel QRIS di Qrispy) ==========
app.post('/api/cancel-order/:orderId', async (req, res) => {
  const db = await getDB();
  const order = db.orders.find(o => o.id == req.params.orderId || o.orderCode == req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
  if (order.status !== 'pending') return res.status(400).json({ error: 'Order sudah diproses' });
  
  // Cancel QRIS di Qrispy (hanya jika qrisId valid dan bukan test)
  if (order.qrisId && order.qrisId !== 'test-' && !order.qrisId.startsWith('test')) {
    const cancelled = await cancelQRISInQrispy(order.qrisId);
    if (!cancelled) {
      console.log(`⚠️ Gagal cancel QRIS di Qrispy, tetap lanjutkan cancel order di database`);
    }
  }
  
  order.status = 'cancelled';
  order.cancelledAt = new Date().toISOString();
  await setDB(db.products, db.orders, db.sha);
  
  res.json({ success: true, message: 'Order dibatalkan' });
});

// ========== TEST ORDER (TIDAK DISIMPAN) ==========
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
  
  // Format item berdasarkan tipe
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
  
  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
        <title>Test Order | ${escapeHtml(product.name)}</title>
        <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700&display=swap" rel="stylesheet">
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css">
        <style>
            * { margin: 0; padding: 0; box-sizing: border-box; -webkit-tap-highlight-color: transparent; user-select: none; }
            body { background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%); font-family: 'Inter', sans-serif; min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; animation: fadeIn 0.5s ease; }
            @keyframes fadeIn { from { opacity: 0; transform: translateY(-20px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes pulse { 0%,100% { transform: scale(1); } 50% { transform: scale(1.02); } }
            .card { background: rgba(255,255,255,0.06); backdrop-filter: blur(12px); border-radius: 32px; padding: 32px; max-width: 580px; width: 100%; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 25px 45px rgba(0,0,0,0.3); }
            .logo { text-align: center; margin-bottom: 20px; }
            .logo h2 { font-size: 1.3rem; font-weight: 700; background: linear-gradient(135deg, #ffffff, #94a3f8); background-clip: text; -webkit-background-clip: text; color: transparent; }
            .success-icon { text-align: center; margin-bottom: 20px; }
            .success-icon i { font-size: 4rem; color: #10b981; animation: pulse 0.5s ease; }
            h1 { text-align: center; color: #10b981; font-size: 1.5rem; font-weight: 700; margin-bottom: 20px; }
            .product-name { font-size: 1.2rem; font-weight: 600; color: white; text-align: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,0.1); }
            .section { background: rgba(0,0,0,0.3); border-radius: 20px; padding: 18px; margin-bottom: 16px; }
            .section-title { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 1px; color: #60a5fa; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
            .item-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
            .item-content { flex: 1; word-break: break-all; }
            .text-content { color: #e2e8f0; font-size: 0.85rem; line-height: 1.5; white-space: pre-wrap; }
            .chip-btn { background: #334155; border: none; padding: 6px 14px; border-radius: 40px; color: white; font-size: 0.7rem; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; transition: 0.2s; white-space: nowrap; }
            .chip-btn:hover { background: #3b82f6; transform: translateY(-2px); }
            .link-chip { background: #3b82f6; text-decoration: none; }
            .link-chip:hover { background: #2563eb; }
            .bonus-list { list-style: none; }
            .bonus-list li { color: #e2e8f0; font-size: 0.85rem; padding: 6px 0; display: flex; align-items: center; gap: 8px; }
            .bonus-list li i { color: #f59e0b; font-size: 0.7rem; }
            .footer-note { text-align: center; color: #475569; font-size: 0.65rem; margin-top: 20px; display: flex; align-items: center; justify-content: center; gap: 6px; }
            .btn-back { background: #334155; border: none; padding: 10px 20px; border-radius: 40px; color: white; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; transition: 0.2s; text-decoration: none; margin-top: 10px; }
            .btn-back:hover { background: #475569; transform: translateY(-2px); }
            @media (max-width: 480px) { .item-row { flex-direction: column; align-items: flex-start; } .chip-btn { align-self: flex-start; } }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="logo"><h2><i class="fas fa-store"></i> Yanto Store</h2></div>
            <div class="success-icon"><i class="fas fa-check-circle"></i></div>
            <h1>✅ TEST ORDER BERHASIL!</h1>
            <div class="product-name">${escapeHtml(product.name)}</div>
            ${itemHtml}
            ${bonusHtml}
            <div style="text-align: center; margin-top: 20px;">
                <a href="/" class="btn-back"><i class="fas fa-home"></i> Kembali ke Beranda</a>
            </div>
            <div class="footer-note"><i class="fas fa-flask"></i> Mode test - tidak mempengaruhi stok & database</div>
        </div>
        <script>
            function copyToClipboard(text) {
                try { navigator.clipboard.writeText(text); showToast('📋 Tersalin!'); } 
                catch(e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); showToast('📋 Tersalin!'); }
            }
            function showToast(msg) {
                const toast = document.createElement('div');
                toast.textContent = msg;
                toast.style.position = 'fixed';
                toast.style.bottom = '20px';
                toast.style.left = '50%';
                toast.style.transform = 'translateX(-50%)';
                toast.style.background = '#1e293b';
                toast.style.padding = '8px 16px';
                toast.style.borderRadius = '40px';
                toast.style.fontSize = '0.8rem';
                toast.style.zIndex = '2000';
                toast.style.color = 'white';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2000);
            }
            document.querySelectorAll('.copy-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const text = this.getAttribute('data-copy');
                    if (text) copyToClipboard(text);
                });
            });
            document.querySelectorAll('.preview-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const htmlContent = this.getAttribute('data-html');
                    if (htmlContent) {
                        const win = window.open();
                        if (win) {
                            win.document.write(htmlContent);
                            win.document.close();
                        } else {
                            alert('Popup diblokir browser! Izinkan popup untuk halaman ini.');
                        }
                    }
                });
            });
        </script>
    </body>
    </html>
  `);
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
    expiredAt: order.expiredAt,
    itemType: product?.itemType || 'text'
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
