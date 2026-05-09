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

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader) return cookies;
    cookieHeader.split(';').forEach(function(cookie) {
        var parts = cookie.trim().split('=');
        var name = parts[0];
        var value = parts.slice(1).join('=');
        if (name) cookies[name] = value;
    });
    return cookies;
}

function getRefFromCookie(cookieHeader) {
    var c = parseCookies(cookieHeader);
    return c['yanto_ref'] || null;
}

function getReferralFromDB(db, customerName) {
    if (!customerName) return null;
    var nameLower = customerName.toLowerCase();
    var visitors = db.referralVisitors || [];
    for (var i = 0; i < visitors.length; i++) {
        if (visitors[i].visitorName.toLowerCase() === nameLower) return visitors[i].referralCode;
    }
    var users = db.users || [];
    for (var j = 0; j < users.length; j++) {
        if (users[j].name.toLowerCase() === nameLower && users[j].referredBy) return users[j].referredBy;
    }
    return null;
}

async function processReferralReward(db, order, cookieHeader) {
    if (!order || order.referralRewarded) return;
    
    var refCode = null;
    var customerName = (order.customerName || '').toLowerCase();
    
    // 1. Cookie
    if (cookieHeader) {
        refCode = getRefFromCookie(cookieHeader);
        if (refCode) console.log('WEBHOOK REFERRAL COOKIE: ' + refCode);
    }
    
    // 2. Database
    if (!refCode) {
        refCode = getReferralFromDB(db, order.customerName);
        if (refCode) console.log('WEBHOOK REFERRAL DB: ' + refCode);
    }
    
    if (!refCode) return;
    
    var referrer = (db.users || []).find(function(u) { return u.referralCode === refCode; });
    if (!referrer) return;
    
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    referrer.discountBalance = (referrer.discountBalance || 0) + 500;
    order.referralRewarded = true;
    console.log('WEBHOOK REFERRAL AWARDED: ' + referrer.name + ' +Rp500 dari ' + customerName);
}

async function getDB() {
    try {
        var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, {
            headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' }
        });
        if (!res.ok) return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null };
        var data = await res.json();
        var content = Buffer.from(data.content, 'base64').toString('utf8');
        var parsed;
        try { parsed = JSON.parse(content); } catch(e) { parsed = JSON.parse(decrypt(content)); }
        return { ...parsed, sha: data.sha };
    } catch (err) { return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null }; }
}

async function setDB(products, orders, oldSha, retryCount) {
    if (!retryCount) retryCount = 0;
    if (retryCount > 5) throw new Error('Save failed after 5 retries');
    var db = await getDB();
    var content = {
        products: products || db.products || [],
        orders: orders || db.orders || [],
        users: db.users || [],
        withdrawals: db.withdrawals || [],
        deposits: db.deposits || [],
        referralVisitors: db.referralVisitors || [],
        adminIP: db.adminIP || null,
        adminIPs: db.adminIPs || [],
        maintenance: db.maintenance || false,
        encrypted: true,
        updatedAt: new Date().toISOString()
    };
    var encryptedContent = encrypt(JSON.stringify(content));
    var updatedContent = Buffer.from(encryptedContent).toString('base64');
    var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, {
        method: 'PUT',
        headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update db via webhook', content: updatedContent, sha: oldSha })
    });
    if (!res.ok) {
        var e = await res.json().catch(function() { return {}; });
        if (e.message && e.message.includes('SHA')) { await new Promise(function(r) { setTimeout(r, 800); }); var f = await getDB(); return setDB(products, orders, f.sha, retryCount + 1); }
        throw new Error('Save failed: ' + (e.message || res.status));
    }
    var d = await res.json();
    return d.content.sha;
}

async function sendTelegramNotification(order, bonusContent) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        var bonusText = '';
        if (bonusContent && bonusContent !== '') { bonusText = '\n\n🎁 BONUS:\n' + bonusContent; }
        var message = '✅ PEMBAYARAN BERHASIL! (via Webhook)\n\n📦 Produk: ' + order.productName + '\n👤 Pembeli: ' + order.customerName + '\n💰 Total: Rp ' + (order.totalAmount || order.price || 0).toLocaleString() + '\n🆔 Order: ' + order.orderCode + '\n📅 Waktu: ' + new Date().toLocaleString('id-ID') + '\n\n🔑 Kode Item:\n' + (order.productCode || 'Tidak ada kode') + bonusText;
        var response = await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
        });
        var result = await response.json();
        if (result.ok) console.log('✅ Telegram notifikasi terkirim');
        else console.error('❌ Telegram error:', result);
    } catch (err) { console.error('❌ Telegram exception:', err); }
}

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    console.log('📨 Webhook received at:', new Date().toISOString());
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));

    if (!WEBHOOK_SECRET) { console.log('⚠️ WEBHOOK_SECRET belum diset'); return res.status(500).json({ error: 'Webhook secret not configured' }); }

    var signature = req.headers['x-qrispy-signature'];
    var payload = JSON.stringify(req.body);
    var expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    
    if (signature !== expected) { console.log('⚠️ Invalid signature!'); return res.status(401).json({ error: 'Invalid signature' }); }
    console.log('✅ Signature valid');

    try {
        var event = req.body.event;
        var data = req.body.data;
        
        if (event === 'payment.received') {
            var qrisId = data.qris_id;
            console.log('💰 Payment received for qrisId: ' + qrisId);
            
            var db = await getDB();
            var order = (db.orders || []).find(function(o) { return o.qrisId === qrisId; });
            
            if (!order) { console.log('❌ Order tidak ditemukan'); return res.status(200).end(); }
            if (order.status === 'paid') { console.log('✅ Order sudah paid'); return res.status(200).end(); }
            console.log('✅ Order ditemukan: ' + order.orderCode);

            // Kurangi stok
            if (order.items && order.items.length > 0) {
                order.items.forEach(function(item) {
                    var product = (db.products || []).find(function(p) { return p.id == item.productId; });
                    if (product && product.stock > 0) product.stock -= (item.quantity || 1);
                });
            } else {
                var product = (db.products || []).find(function(p) { return p.id == order.productId; });
                if (product && product.stock > 0) {
                    product.stock -= 1;
                    console.log('📦 Stok ' + product.name + ' berkurang jadi ' + product.stock);
                }
            }

            order.status = 'paid';
            order.paidAt = data.paid_at || new Date().toISOString();

            // ✅ KOMISI REFERRAL
            await processReferralReward(db, order, req.headers.cookie);

            var bonusContent = '';
            var prod = (db.products || []).find(function(p) { return p.id == order.productId; });
            if (prod && prod.bonusContent && prod.bonusContent !== '') { bonusContent = prod.bonusContent; }

            await setDB(db.products, db.orders, db.sha);
            console.log('💾 Database updated');
            await sendTelegramNotification(order, bonusContent);
            console.log('🎉 Order ' + order.orderCode + ' completed!');
        } else {
            console.log('📌 Unhandled event type: ' + event);
        }
        res.status(200).end();
    } catch (err) {
        console.error('❌ Webhook error:', err);
        res.status(500).json({ error: err.message });
    }
};
