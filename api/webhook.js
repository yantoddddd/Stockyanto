const crypto = require('crypto');

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'yantoddddd/stockyanto';
const GITHUB_PATH = 'database.json';
const ENCRYPT_KEY = process.env.ENCRYPT_KEY;

function encrypt(text) { if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset'); const iv = crypto.randomBytes(16); const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv); let encrypted = cipher.update(text, 'utf8', 'hex'); encrypted += cipher.final('hex'); return iv.toString('hex') + ':' + encrypted; }
function decrypt(encryptedText) { if (!ENCRYPT_KEY) throw new Error('ENCRYPT_KEY belum diset'); const parts = encryptedText.split(':'); const iv = Buffer.from(parts[0], 'hex'); const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPT_KEY, 'hex'), iv); let decrypted = decipher.update(parts[1], 'hex', 'utf8'); decrypted += decipher.final('utf8'); return decrypted; }
function parseCookies(cookieHeader) { const cookies = {}; if (!cookieHeader) return cookies; cookieHeader.split(';').forEach(function(cookie) { var parts = cookie.trim().split('='); var name = parts[0]; var value = parts.slice(1).join('='); if (name) cookies[name] = value; }); return cookies; }
function getRefFromCookie(cookieHeader) { var c = parseCookies(cookieHeader); return c['yanto_ref'] || null; }
function getReferralFromDB(db, customerName) { if (!customerName) return null; var nameLower = customerName.toLowerCase(); var visitors = db.referralVisitors || []; for (var i = 0; i < visitors.length; i++) { if (visitors[i].visitorName.toLowerCase() === nameLower) return visitors[i].referralCode; } var users = db.users || []; for (var j = 0; j < users.length; j++) { if (users[j].name.toLowerCase() === nameLower && users[j].referredBy) return users[j].referredBy; } return null; }

async function processReferralReward(db, order, cookieHeader) { if (!order || order.referralRewarded || order.referralStatus) return; var refCode = null; if (order.referralCode) refCode = order.referralCode; if (!refCode && cookieHeader) refCode = getRefFromCookie(cookieHeader); if (!refCode) refCode = getReferralFromDB(db, order.customerName); if (!refCode) return; var referrer = (db.users || []).find(function(u) { return u.referralCode === refCode; }); if (!referrer) return; order.referralStatus = 'pending'; order.referralRewarded = false; order.referrerName = referrer.name; order.referrerCode = refCode; }

async function getDB() { try { var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, { headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Accept': 'application/vnd.github.v3+json' } }); if (!res.ok) return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null }; var data = await res.json(); var content = Buffer.from(data.content, 'base64').toString('utf8'); var parsed; try { parsed = JSON.parse(content); } catch(e) { parsed = JSON.parse(decrypt(content)); } return { ...parsed, sha: data.sha }; } catch(err) { return { products: [], orders: [], users: [], withdrawals: [], deposits: [], referralVisitors: [], sha: null }; } }
async function setDB(products, orders, oldSha, retryCount) { if (!retryCount) retryCount = 0; if (retryCount > 5) throw new Error('Save failed'); var db = await getDB(); var content = { products: products || db.products || [], orders: orders || db.orders || [], users: db.users || [], withdrawals: db.withdrawals || [], deposits: db.deposits || [], referralVisitors: db.referralVisitors || [], adminIP: db.adminIP || null, adminIPs: db.adminIPs || [], maintenance: db.maintenance || false, encrypted: true, updatedAt: new Date().toISOString() }; var encryptedContent = encrypt(JSON.stringify(content)); var updatedContent = Buffer.from(encryptedContent).toString('base64'); var res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_PATH, { method: 'PUT', headers: { 'Authorization': 'token ' + GITHUB_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Update db via webhook', content: updatedContent, sha: oldSha }) }); if (!res.ok) { var e = await res.json().catch(function() { return {}; }); if (e.message && e.message.includes('SHA')) { await new Promise(function(r) { setTimeout(r, 800); }); var f = await getDB(); return setDB(products, orders, f.sha, retryCount + 1); } throw new Error('Save failed'); } var d = await res.json(); return d.content.sha; }

async function sendTelegramNotification(order, bonusContent) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        var bonusText = bonusContent ? '\n\n🎁 BONUS:\n' + bonusContent : '';
        var refInfo = order.referralCode ? '\n🔗 Kode Ref: ' + order.referralCode + '\n👑 Referrer: ' + (order.referrerName || '-') + '\n📌 Status: ' + (order.referralStatus || 'pending') : '';
        var message = '✅ PEMBAYARAN BERHASIL! (via Webhook)\n\n📦 Produk: ' + order.productName + '\n👤 Pembeli: ' + order.customerName + '\n💰 Total: Rp ' + (order.totalAmount || order.price || 0).toLocaleString() + '\n🆔 Order: ' + order.orderCode + '\n📅 Waktu: ' + new Date().toLocaleString('id-ID') + refInfo + '\n\n🔑 Kode Item:\n' + (order.productCode || 'Tidak ada kode') + bonusText;
        await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }) });
    } catch(err) {}
}

module.exports = async function(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    if (!WEBHOOK_SECRET) return res.status(500).json({ error: 'Webhook secret not configured' });
    var signature = req.headers['x-qrispy-signature']; var payload = JSON.stringify(req.body);
    var expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
    if (signature !== expected) return res.status(401).json({ error: 'Invalid signature' });
    try {
        var event = req.body.event, data = req.body.data;
        if (event === 'payment.received') {
            var qrisId = data.qris_id; var db = await getDB();
            var order = (db.orders || []).find(function(o) { return o.qrisId === qrisId; });
            if (order) {
                if (order.status === 'paid') return res.status(200).end();
                if (order.items) { order.items.forEach(function(item) { var p = (db.products || []).find(function(x) { return x.id == item.productId; }); if (p && p.stock > 0) p.stock -= item.quantity || 1; }); }
                else { var p = (db.products || []).find(function(x) { return x.id == order.productId; }); if (p && p.stock > 0) p.stock -= 1; }
                order.status = 'paid'; order.paidAt = data.paid_at || new Date().toISOString();
                await processReferralReward(db, order, req.headers.cookie);
                await setDB(db.products, db.orders, db.sha);
                var bonusContent = ''; var prod = (db.products || []).find(function(x) { return x.id == order.productId; }); if (prod && prod.bonusContent) bonusContent = prod.bonusContent;
                await sendTelegramNotification(order, bonusContent);
            } else {
                // Check deposit
                var dep = (db.deposits || []).find(function(d) { return d.qrisId === qrisId; });
                if (dep && dep.status === 'pending') {
                    dep.status = 'paid'; dep.paidAt = data.paid_at || new Date().toISOString();
                    var user = (db.users || []).find(function(u) { return u.id === dep.userId; });
                    if (user) { user.discountBalance = (user.discountBalance || 0) + dep.amount; }
                    await setDB(db.products, db.orders, db.sha);
                    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID && user) {
                        await fetch('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: '✅ DEPOSIT VIA WEBHOOK\n\n👤 ' + user.name + '\n💰 Rp ' + dep.amount.toLocaleString() + '\n📅 ' + new Date().toLocaleString('id-ID'), parse_mode: 'HTML' }) });
                    }
                }
            }
        }
        res.status(200).end();
    } catch(err) { res.status(500).json({ error: err.message }); }
};
