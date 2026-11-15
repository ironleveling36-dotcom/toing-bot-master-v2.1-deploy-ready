const express = require('express');
const router = express.Router();
const Account = require('../models/Account');
const SwiggyService = require('../services/swiggyService');
const connectDB = require('../config/db');

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

async function getOrCreateAccount(phone) {
  const cleanPhone = normalizePhone(phone);
  if (cleanPhone.length !== 10) {
    throw new Error('Valid 10-digit phone number required');
  }
  let account = await Account.findOne({ phone: cleanPhone });
  if (!account) {
    const fp = Account.generateFingerprint();
    account = await Account.create({
      phone: cleanPhone,
      ...fp
    });
  }
  return account;
}

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    status: 'UP',
    storage: connectDB.isMongoConnected() ? 'mongodb' : 'local-persistent',
    timestamp: Date.now()
  });
});

router.get('/accounts', async (req, res) => {
  try {
    const accounts = await Account.find().sort({ updatedAt: -1 });
    res.json({ ok: true, accounts });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/auth/spoof-device', async (req, res) => {
  try {
    const account = await getOrCreateAccount(req.body.phone);
    account.rotateDevice();
    await account.save();
    await SwiggyService.warmSession(account);

    res.json({
      ok: true,
      phone: account.phone,
      deviceId: account.deviceId,
      swuid: account.swuid,
      userAgent: account.userAgent,
      tid: account.tid
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/send-otp', async (req, res) => {
  try {
    const { phone, spoofDevice = false, lat, lng } = req.body;
    const account = await getOrCreateAccount(phone);
    if (lat) account.lat = String(lat);
    if (lng) account.lng = String(lng);
    await account.save();

    const result = await SwiggyService.sendOtp(account, Boolean(spoofDevice));
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!otp) return res.status(400).json({ ok: false, error: 'OTP required' });

    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.verifyOtp(account, otp);

    if (result.ok) {
      await Promise.allSettled([
        SwiggyService.syncCart(account),
        SwiggyService.syncPaymentStatus(account)
      ]);
    } else if (result.isMultipleDeviceError) {
      account.rotateDevice();
      await account.save();
      await SwiggyService.warmSession(account);
      result.newDeviceIdGenerated = account.deviceId;
    }

    res.json({
      ...result,
      account
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/cart/sync', async (req, res) => {
  try {
    const { phone, cartPayload = null } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncCart(account, cartPayload);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.post('/payment/sync', async (req, res) => {
  try {
    const { phone, orderId = null } = req.body;
    const account = await getOrCreateAccount(phone);
    const result = await SwiggyService.syncPaymentStatus(account, orderId);
    res.json(result);
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

router.get('/live/:phone', async (req, res) => {
  const cleanPhone = normalizePhone(req.params.phone);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;

  const pushUpdate = async () => {
    if (closed) return;
    try {
      const account = await Account.findOne({ phone: cleanPhone });
      if (!account || !account.isLoggedIn) {
        res.write(`data: ${JSON.stringify({ ok: false, reason: 'NOT_LOGGED_IN' })}\n\n`);
        return;
      }

      await Promise.allSettled([
        SwiggyService.syncCart(account),
        SwiggyService.syncPaymentStatus(account)
      ]);

      const payload = {
        ok: true,
        phone: account.phone,
        deviceId: account.deviceId,
        swuid: account.swuid,
        cartState: account.cartState,
        paymentState: account.paymentState,
        timestamp: Date.now()
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (e) {
      res.write(`data: ${JSON.stringify({ ok: false, error: e.message })}\n\n`);
    }
  };

  await pushUpdate();
  const intervalId = setInterval(pushUpdate, 4000);

  req.on('close', () => {
    closed = true;
    clearInterval(intervalId);
  });
});

module.exports = router;
