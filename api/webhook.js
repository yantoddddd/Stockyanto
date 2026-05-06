const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';
const ENCRYPT_KEY = process.env.ENCRYPT_KEY;

function encrypt(text) {
    if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset');
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}

function decrypt(encryptedText) {
    if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset');
    const parts = encryptedText.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv);
    let decrypted = decipher.update(parts[1], 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

async function getDB() {
    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
            headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], sha: null };
        const data = await res.json();
        const content = Buffer.from(data.content, 'base64').toString('utf8');
        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch(e) {
            const decrypted = decrypt(content);
            parsed = JSON.parse(decrypted);
        }
        return { ...parsed, sha: data.sha };
    } catch (err) {
        console.error('GetDB error:', err);
        return { products: [], orders: [], sha: null };
    }
}

async function setDB(products, orders, oldSha, retryCount) {
    if (!retryCount) retryCount = 0;
    if (retryCount > 5) throw new Error('Save failed after 5 retries');
    const db = await getDB();
    const content = {
        products: products || db.products || [],
        orders: orders || db.orders || [],
        adminIP: db.adminIP || null,
        adminIPs: db.adminIPs || [],
        maintenance: db.maintenance || false,
        encrypted: true,
        updatedAt: new Date().toISOString()
    };
    const encryptedContent = encrypt(JSON.stringify(content));
    const updatedContent = Buffer.from(encryptedContent).toString('base64');
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_PATH}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update db via webhook', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        if (e.message?.includes('SHA')) {
            await new Promise(r => setTimeout(r, 800));
            const f = await getDB();
            return setDB(products, orders, f.sha, retryCount + 1);
        }
        throw new Error('Save failed: ' + (e.message || res.status));
    }
    const d = await res.json();
    return d.content.sha;
}

async function sendTelegramNotification(order, bonusContent) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        let bonusText = '';
        if (bonusContent && bonusContent !== '') {
            bonusText = `\n\n🎁 BONUS:\n${bonusContent}`;
        }
        const message = `✅ PEMBAYARAN BERHASIL! (via Webhook)\n\n📦 Produk: ${order.productName}\n👤 Pembeli: ${order.customerName}\n💰 Total: Rp ${(order.totalAmount || order.price || 0).toLocaleString()}\n🆔 Order: ${order.orderCode}\n📅 Waktu: ${new Date().toLocaleString('id-ID')}\n\n🔑 Kode Item:\n${order.productCode || 'Tidak ada kode'}${bonusText}`;
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        const result = await response.json();
        if (result.ok) console.log('✅ Telegram notifikasi terkirim');
        else console.error('❌ Telegram error:', result);
    } catch (err) {
        console.error('❌ Telegram exception:', err);
    }
}

module.exports = async (req, res) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    console.log('📨 Webhook received at:', new Date().toISOString());
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));

    if (!WEBHOOK_SECRET) {
        console.log('⚠️ WEBHOOK_SECRET belum diset');
        return res.status(500).json({ error: 'Webhook secret not configured' });
    }

    const signature = req.headers['x-qrispy-signature'];
    const payload = JSON.stringify(req.body);
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    
    if (signature !== expected) {
        console.log('⚠️ Invalid signature!');
        return res.status(401).json({ error: 'Invalid signature' });
    }
    console.log('✅ Signature valid');

    try {
        const { event, data } = req.body;
        if (event === 'payment.received') {
            const qrisId = data.qris_id;
            console.log(`💰 Payment received for qrisId: ${qrisId}`);
            const db = await getDB();
            const order = (db.orders || []).find(o => o.qrisId === qrisId);
            if (!order) {
                console.log('❌ Order tidak ditemukan');
                return res.status(200).end();
            }
            if (order.status === 'paid') {
                console.log('✅ Order sudah paid');
                return res.status(200).end();
            }
            console.log('✅ Order ditemukan:', order.orderCode);
            const product = (db.products || []).find(p => p.id == order.productId);
            if (product && product.stock > 0) {
                product.stock -= 1;
                console.log(`📦 Stok ${product.name} berkurang jadi ${product.stock}`);
            }
            order.status = 'paid';
            order.paidAt = data.paid_at || new Date().toISOString();
            let bonusContent = '';
            if (product && product.bonusContent && product.bonusContent !== '') {
                bonusContent = product.bonusContent;
            }
            await setDB(db.products, db.orders, db.sha);
            console.log('💾 Database updated');
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
