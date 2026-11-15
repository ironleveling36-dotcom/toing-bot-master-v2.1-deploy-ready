const mongoose = require('mongoose');

let isMongoConnected = false;

function sanitizeMongoUri(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let uri = raw.trim();
  // Strip accidental surrounding quotes from Railway/Render env vars
  uri = uri.replace(/^['"]+|['"]+$/g, '').trim();
  // Strip accidental "MONGODB_URI=" prefix if pasted into the value box
  if (uri.startsWith('MONGODB_URI=')) {
    uri = uri.slice('MONGODB_URI='.length).trim().replace(/^['"]+|['"]+$/g, '');
  }
  return uri;
}

async function connectDB() {
  const rawUri =
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    process.env.DATABASE_URL ||
    '';

  const uri = sanitizeMongoUri(rawUri);

  if (!uri || (!uri.startsWith('mongodb://') && !uri.startsWith('mongodb+srv://'))) {
    console.warn(
      '[DB] No valid mongodb:// or mongodb+srv:// URI found in env. Running in standalone persistent file/memory mode (zero crash).'
    );
    isMongoConnected = false;
    return false;
  }

  try {
    mongoose.set('strictQuery', false);
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000
    });
    isMongoConnected = true;
    console.log('[DB] MongoDB connected successfully');
    return true;
  } catch (err) {
    console.warn('[DB] MongoDB connection failed, falling back to standalone store:', err.message);
    isMongoConnected = false;
    return false;
  }
}

connectDB.isMongoConnected = () => isMongoConnected && mongoose.connection.readyState === 1;

module.exports = connectDB;
