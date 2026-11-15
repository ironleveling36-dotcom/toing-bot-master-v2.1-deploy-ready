const TelegramBot = require('node-telegram-bot-api');
const Account = require('./models/Account');
const SwiggyService = require('./services/swiggyService');

function initBot() {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!token) {
    console.log('[Bot] TELEGRAM_BOT_TOKEN not set, skipping bot startup');
    return null;
  }

  try {
    const bot = new TelegramBot(token, { polling: true });
    console.log('[Bot] Telegram bot polling started');

    bot.onText(/\/start/, (msg) => {
      bot.sendMessage(
        msg.chat.id,
        'Commands:\n/otp <phone> - Send OTP\n/spoof <phone> - Generate new Device ID & send OTP\n/verify <phone> <otp> - Verify OTP\n/sync <phone> - Sync live cart & payment'
      );
    });

    bot.onText(/\/spoof\s+(\d{10})/, async (msg, match) => {
      const phone = match[1];
      try {
        let acc = await Account.findOne({ phone });
        if (!acc) acc = await Account.create({ phone, ...Account.generateFingerprint() });
        const res = await SwiggyService.sendOtp(acc, true);
        bot.sendMessage(msg.chat.id, `New Device: ${res.deviceId}\nStatus: ${res.message}`);
      } catch (e) {
        bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
      }
    });

    bot.onText(/\/otp\s+(\d{10})/, async (msg, match) => {
      const phone = match[1];
      try {
        let acc = await Account.findOne({ phone });
        if (!acc) acc = await Account.create({ phone, ...Account.generateFingerprint() });
        const res = await SwiggyService.sendOtp(acc, false);
        bot.sendMessage(msg.chat.id, `Device: ${res.deviceId}\nStatus: ${res.message}`);
      } catch (e) {
        bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
      }
    });

    bot.onText(/\/verify\s+(\d{10})\s+(\d{4,6})/, async (msg, match) => {
      const [, phone, otp] = match;
      try {
        const acc = await Account.findOne({ phone });
        if (!acc) return bot.sendMessage(msg.chat.id, 'Request OTP first');
        const res = await SwiggyService.verifyOtp(acc, otp);
        if (res.ok) {
          await Promise.allSettled([
            SwiggyService.syncCart(acc),
            SwiggyService.syncPaymentStatus(acc)
          ]);
        }
        bot.sendMessage(msg.chat.id, `Verify: ${res.message}`);
      } catch (e) {
        bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
      }
    });

    bot.onText(/\/sync\s+(\d{10})/, async (msg, match) => {
      const phone = match[1];
      try {
        const acc = await Account.findOne({ phone });
        if (!acc || !acc.isLoggedIn) return bot.sendMessage(msg.chat.id, 'Account not logged in');
        const [cart, pay] = await Promise.all([
          SwiggyService.syncCart(acc),
          SwiggyService.syncPaymentStatus(acc)
        ]);
        bot.sendMessage(
          msg.chat.id,
          `Cart Total: ₹${cart.cartState.totalAmount} (${cart.cartState.items.length} items)\nPayment: ${pay.paymentState.status} (Order: ${pay.paymentState.orderId || 'None'})`
        );
      } catch (e) {
        bot.sendMessage(msg.chat.id, `Error: ${e.message}`);
      }
    });

    return bot;
  } catch (err) {
    console.warn('[Bot] Failed to initialize Telegram bot:', err.message);
    return null;
  }
}

module.exports = { initBot };
