const express = require('express');
const crypto = require('crypto');
const router = express.Router();

// Ini nanti di-mount di index.js dengan: app.use('/api', require('./customer.js'))

module.exports = function(getDB, setDB, parseCookies, sanitize, hashPassword, verifyPassword, generateReferralCode, validateAge, getRefFromCookie, processReferralReward, QRISPY_TOKEN, QRISPY_API_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, sendTelegramMessage) {

    // ========== AUTH ==========
    router.post('/register', async function(req, res) {
        var name = req.body.name, birthDate = req.body.birthDate, password = req.body.password;
        if (!name || !birthDate || !password) return res.status(400).json({ error: 'Data tidak lengkap' });
        if (!validateAge(birthDate)) return res.status(400).json({ error: 'Minimal umur 12 tahun' });
        for (var attempt = 1; attempt <= 3; attempt++) {
            try {
                var db = await getDB();
                if (!db.users) db.users = [];
                if (db.users.find(function(u) { return u.name.toLowerCase() === name.toLowerCase(); })) return res.status(400).json({ error: 'Nama sudah terdaftar' });
                var refCode = getRefFromCookie(req.headers.cookie);
                var user = { id: Date.now(), name: sanitize(name), birthDate: birthDate, password: hashPassword(password), referralCode: generateReferralCode(name), referredBy: refCode || null, referralCount: 0, referralClicks: 0, discountBalance: 0, createdAt: new Date().toISOString() };
                db.users.push(user);
                await setDB(null, db.orders, db.sha);
                return res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: 0, referralClicks: 0, discountBalance: 0 } });
            } catch(e) { if (attempt < 3) await new Promise(function(r) { setTimeout(r, 500); }); }
        }
        res.status(500).json({ error: 'Save failed' });
    });

    router.post('/login', async function(req, res) {
        var name = req.body.name, password = req.body.password;
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.name.toLowerCase() === name.toLowerCase(); });
        if (!user || !verifyPassword(password, user.password)) return res.status(401).json({ error: 'Nama atau password salah' });
        var token = crypto.randomBytes(32).toString('hex');
        user.token = token;
        if (!user.referredBy) { var refCode = getRefFromCookie(req.headers.cookie); if (refCode) user.referredBy = refCode; }
        await setDB(null, db.orders, db.sha);
        res.setHeader('Set-Cookie', 'yanto_token=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + (7 * 24 * 60 * 60));
        res.json({ success: true, user: { id: user.id, name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0 } });
    });

    router.post('/logout', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (token) { var db = await getDB(); var user = (db.users || []).find(function(u) { return u.token === token; }); if (user) { user.token = null; await setDB(null, db.orders, db.sha); } }
        res.setHeader('Set-Cookie', 'yanto_token=; Path=/; Max-Age=0');
        res.json({ success: true });
    });

    router.get('/user/profile', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        res.json({ success: true, user: { name: user.name, referralCode: user.referralCode, referralCount: user.referralCount || 0, referralClicks: user.referralClicks || 0, discountBalance: user.discountBalance || 0 } });
    });

    router.get('/user/orders', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        var orders = (db.orders || []).filter(function(o) { return o.customerName.toLowerCase() === user.name.toLowerCase(); });
        res.json({ success: true, orders: orders.slice(0, 50).map(function(o) { return { id: o.id, orderCode: o.orderCode, productName: o.productName, totalAmount: o.totalAmount || o.price, status: o.status, createdAt: o.createdAt }; }) });
    });

    // ========== DEPOSIT ==========
    router.post('/user/deposit', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        if (!QRISPY_TOKEN) return res.status(500).json({ error: 'QRISPY not configured' });
        var amount = parseInt(req.body.amount);
        if (!amount || amount < 1000) return res.status(400).json({ error: 'Minimal deposit Rp 1.000' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        try {
            var qrisRes = await fetch(QRISPY_API_URL + '/api/payment/qris/generate', { method: 'POST', headers: { 'X-API-Token': QRISPY_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amount }) });
            var qrisData = await qrisRes.json();
            if (qrisData.status !== 'success') throw new Error(qrisData.message || 'Gagal generate QRIS');
            if (!db.deposits) db.deposits = [];
            var depId = Date.now();
            db.deposits.unshift({ id: depId, userId: user.id, userName: user.name, amount: amount, qrisId: qrisData.data.qris_id, qrisImage: qrisData.data.qris_image_url, expiredAt: qrisData.data.expired_at, status: 'pending', createdAt: new Date().toISOString() });
            await setDB(null, db.orders, db.sha);
            res.json({ success: true, depId: depId, qrisImage: qrisData.data.qris_image_url, amount: amount, expiredAt: qrisData.data.expired_at });
        } catch(e) { res.status(500).json({ error: e.message }); }
    });

    router.get('/user/deposits', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        var deps = (db.deposits || []).filter(function(d) { return d.userId === user.id; });
        res.json({ success: true, deposits: deps });
    });

    // ========== CHANGE PASSWORD ==========
    router.post('/user/change-password', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        var oldPassword = req.body.oldPassword, newPassword = req.body.newPassword;
        if (!oldPassword || !newPassword) return res.status(400).json({ error: 'Data tidak lengkap' });
        if (newPassword.length < 4) return res.status(400).json({ error: 'Password minimal 4 karakter' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        if (!verifyPassword(oldPassword, user.password)) return res.status(400).json({ error: 'Password lama salah' });
        user.password = hashPassword(newPassword);
        await setDB(null, db.orders, db.sha);
        res.json({ success: true });
    });

    // ========== WITHDRAW ==========
    router.post('/user/withdraw', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        var amount = parseInt(req.body.amount), paymentMethod = req.body.paymentMethod, paymentNumber = req.body.paymentNumber;
        if (!amount || amount < 2000) return res.status(400).json({ error: 'Minimal WD Rp 2.000' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        if ((user.discountBalance || 0) < amount) return res.status(400).json({ error: 'Saldo gak cukup' });
        if (!db.withdrawals) db.withdrawals = [];
        db.withdrawals.unshift({ id: Date.now(), userId: user.id, userName: user.name, amount: amount, paymentMethod: paymentMethod || 'DANA', paymentNumber: paymentNumber || '-', status: 'pending', createdAt: new Date().toISOString() });
        user.discountBalance -= amount;
        await setDB(null, db.orders, db.sha);
        if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) sendTelegramMessage('💰 WITHDRAW\n\n👤 ' + user.name + '\n💵 Rp ' + amount.toLocaleString() + '\n🏦 ' + (paymentMethod || 'DANA') + '\n📱 ' + (paymentNumber || '-'));
        res.json({ success: true });
    });

    router.get('/user/withdrawals', async function(req, res) {
        var cookies = parseCookies(req.headers.cookie);
        var token = cookies['yanto_token'];
        if (!token) return res.status(401).json({ error: 'Login dulu' });
        var db = await getDB();
        var user = (db.users || []).find(function(u) { return u.token === token; });
        if (!user) return res.status(401).json({ error: 'Unauthorized' });
        res.json({ success: true, withdrawals: (db.withdrawals || []).filter(function(w) { return w.userId === user.id; }) });
    });

    return router;
};
