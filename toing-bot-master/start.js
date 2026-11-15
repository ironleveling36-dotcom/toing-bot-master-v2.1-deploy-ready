require('dotenv').config();
const connectDB = require('./src/config/db');
const app = require('./src/server');
const { initBot } = require('./src/bot');

const PORT = process.env.PORT || 3000;

async function bootstrap() {
  // 1. Start HTTP server immediately so Railway/Render healthcheck never crashes
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Listening on 0.0.0.0:${PORT}`);
  });

  // 2. Connect DB (auto-falls back to JSON/Memory store if MONGODB_URI is missing or invalid)
  await connectDB();

  // 3. Init optional Telegram Bot
  initBot();
}

bootstrap().catch((err) => {
  console.error('[Bootstrap Warning]', err.message);
});
