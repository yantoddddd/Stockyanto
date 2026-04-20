const crypto = require('crypto');

const WEBHOOK_SECRET = 'whsec_AVu3fFLUBVMLjo6OdCWq7I3qdQ2CJ6e2';

// Telegram Config
const TELEGRAM_BOT_TOKEN = '8622926718:AAFgjPx774euFGn3NFdekbMfF9NyJgBNUWs';
const TELEGRAM_CHAT_ID = '-5260518165';

// GitHub Config
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
    body: JSON.stringify({ message: 'Update db via webhook', content: updatedContent, sha: oldSha })
  });
  if (!res.ok) throw new Error('GitHub save failed');
  const data = await res.json();
  return data.content.sha;
}

async function sendTelegramNotification(order, bonusContent) {
  try {
    let bonusText = '';
    if (bonusContent && bonusContent !== '') {
      bonusText = `\n\n🎁 *BONUS:*\n${bonusContent}`;
    }
    
    const message = `
✅ *PEMBAYARAN BERHASIL!* (via Webhook)

📦 *Produk:* ${order.productName}
👤 *Pembeli:* ${order.customerName}
💰 *Total:* Rp ${order.totalAmount.toLocaleString()}
🆔 *Order ID:* ${order.orderCode}
📅 *Waktu:* ${new Date().toLocaleString('id-ID')}

🔑 *Kode Item:* 
${order.productCode || 'Tidak ada kode'}${bonusText}
    `;
    
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });
    
    const result = await response.json();
    if (result.ok) {
      console.log('✅ Telegram notifikasi terkirim');
    } else {
      console.error('❌ Telegram error:', result);
    }
  } catch (err) {
    console.error('❌ Telegram exception:', err);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  console.log('📨 Webhook received at:', new Date().toISOString());
  console.log('📦 Body:', JSON.stringify(req.body, null, 2));

  // ========== VERIFIKASI SIGNATURE (DIAMANKAN) ==========
  const signature = req.headers['x-qrispy-signature'];
  const payload = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
  
  if (signature !== expected) {
    console.log('⚠️ Invalid signature! Expected:', expected, 'Got:', signature);
    return res.status(401).json({ error: 'Invalid signature' });
  }
  console.log('✅ Signature valid');

  try {
    const { event, data } = req.body;
    
    if (event === 'payment.received') {
      const qrisId = data.qris_id;
      console.log(`💰 Payment received for qrisId: ${qrisId}`);
      
      const db = await getDB();
      const order = db.orders.find(o => o.qrisId === qrisId);
      
      if (!order) {
        console.log('❌ Order tidak ditemukan untuk qrisId:', qrisId);
        return res.status(200).end();
      }
      
      if (order.status === 'paid') {
        console.log('✅ Order sudah paid sebelumnya');
        return res.status(200).end();
      }
      
      console.log('✅ Order ditemukan:', order.orderCode);
      
      // Kurangi stok
      const product = db.products.find(p => p.id == order.productId);
      if (product && product.stock > 0) {
        product.stock -= 1;
        console.log(`📦 Stok ${product.name} berkurang jadi ${product.stock}`);
      }
      
      // Update status order
      order.status = 'paid';
      order.paidAt = data.paid_at || new Date().toISOString();
      
      // Ambil bonus dari produk
      let bonusContent = '';
      if (product && product.bonusContent && product.bonusContent !== '') {
        bonusContent = product.bonusContent;
      }
      
      await setDB(db.products, db.orders, db.sha);
      console.log('💾 Database updated');
      
      // Kirim notifikasi Telegram dengan bonus
      await sendTelegramNotification(order, bonusContent);
      
      console.log(`🎉 Order ${order.orderCode} completed!`);
    } else {
      console.log('📌 Unhandled event type:', event);
    }
    
    res.status(200).end();
  } catch (err) {
    console.error('❌ Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
};
