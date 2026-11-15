const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const connectDB = require('../config/db');

const ANDROID_MODELS = [
  { build: 'SM-S918B; Build/TP1A.220624.014', ua: 'Swiggy-Android/4.52.0 (SM-S918B; Android 13; SDK 33)' },
  { build: 'Pixel 7 Pro; Build/TQ3A.230805.001', ua: 'Swiggy-Android/4.52.0 (Pixel 7 Pro; Android 13; SDK 33)' },
  { build: 'OnePlus 11 5G; Build/SKQ1.221119.001', ua: 'Swiggy-Android/4.52.0 (CPH2447; Android 13; SDK 33)' },
  { build: '2210132G; Build/TKQ1.220829.002', ua: 'Swiggy-Android/4.52.0 (2210132G; Android 13; SDK 33)' },
  { build: 'SM-A546E; Build/TP1A.220624.014', ua: 'Swiggy-Android/4.52.0 (SM-A546E; Android 13; SDK 33)' }
];

function generateDeviceFingerprint() {
  const model = ANDROID_MODELS[Math.floor(Math.random() * ANDROID_MODELS.length)];
  const deviceId = crypto.randomUUID();
  const swuid = crypto.randomBytes(8).toString('hex');
  return {
    deviceId,
    swuid,
    userAgent: model.ua,
    deviceModel: model.build
  };
}

const AccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: { type: String, default: '' },
  email: { type: String, default: '' },

  deviceId: { type: String, required: true },
  swuid: { type: String, required: true },
  userAgent: { type: String, required: true },
  deviceModel: { type: String, default: '' },

  tid: { type: String, default: '' },
  sid: { type: String, default: '' },
  csrfToken: { type: String, default: '' },
  cookies: { type: Object, default: {} },
  isLoggedIn: { type: Boolean, default: false },

  lat: { type: String, default: '13.0827' },
  lng: { type: String, default: '80.2707' },

  cartState: {
    cartId: { type: String, default: '' },
    items: { type: Array, default: [] },
    totalAmount: { type: Number, default: 0 },
    restaurantName: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  },

  paymentState: {
    orderId: { type: String, default: '' },
    transactionId: { type: String, default: '' },
    status: { type: String, default: 'IDLE' },
    paymentMethod: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    upiIntentUrl: { type: String, default: '' },
    updatedAt: { type: Date, default: null }
  }
}, { timestamps: true });

function applyRotateDevice(target) {
  const fp = generateDeviceFingerprint();
  target.deviceId = fp.deviceId;
  target.swuid = fp.swuid;
  target.userAgent = fp.userAgent;
  target.deviceModel = fp.deviceModel;
  target.tid = '';
  target.sid = '';
  target.csrfToken = '';
  target.cookies = {};
  target.isLoggedIn = false;
  return target;
}

AccountSchema.statics.generateFingerprint = generateDeviceFingerprint;
AccountSchema.methods.rotateDevice = function () {
  return applyRotateDevice(this);
};

const MongoAccount = mongoose.model('Account', AccountSchema);

// --- Built-in JSON + Memory Fallback Store (if MongoDB is not configured) ---
const DATA_DIR = path.join(__dirname, '../../data');
const DATA_FILE = path.join(DATA_DIR, 'accounts.json');
const memoryMap = new Map();

function loadDiskStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        for (const item of raw) {
          if (item && item.phone) memoryMap.set(item.phone, item);
        }
      }
    }
  } catch (_) {}
}

function flushDiskStore() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const arr = Array.from(memoryMap.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (_) {}
}

loadDiskStore();

class LocalAccountDoc {
  constructor(data = {}) {
    const fp = generateDeviceFingerprint();
    this.phone = String(data.phone || '');
    this.name = data.name || '';
    this.email = data.email || '';
    this.deviceId = data.deviceId || fp.deviceId;
    this.swuid = data.swuid || fp.swuid;
    this.userAgent = data.userAgent || fp.userAgent;
    this.deviceModel = data.deviceModel || fp.deviceModel;
    this.tid = data.tid || '';
    this.sid = data.sid || '';
    this.csrfToken = data.csrfToken || '';
    this.cookies = data.cookies || {};
    this.isLoggedIn = Boolean(data.isLoggedIn);
    this.lat = data.lat || '13.0827';
    this.lng = data.lng || '80.2707';
    this.cartState = data.cartState || {
      cartId: '',
      items: [],
      totalAmount: 0,
      restaurantName: '',
      updatedAt: null
    };
    this.paymentState = data.paymentState || {
      orderId: '',
      transactionId: '',
      status: 'IDLE',
      paymentMethod: '',
      amount: 0,
      upiIntentUrl: '',
      updatedAt: null
    };
    this.createdAt = data.createdAt ? new Date(data.createdAt) : new Date();
    this.updatedAt = data.updatedAt ? new Date(data.updatedAt) : new Date();
  }

  rotateDevice() {
    return applyRotateDevice(this);
  }

  markModified() {}

  async save() {
    this.updatedAt = new Date();
    memoryMap.set(this.phone, { ...this });
    flushDiskStore();
    return this;
  }
}

const HybridAccount = {
  generateFingerprint,

  async findOne(query = {}) {
    if (connectDB.isMongoConnected()) {
      return MongoAccount.findOne(query);
    }
    if (query.phone) {
      const found = memoryMap.get(String(query.phone));
      return found ? new LocalAccountDoc(found) : null;
    }
    return null;
  },

  async create(data = {}) {
    if (connectDB.isMongoConnected()) {
      return MongoAccount.create(data);
    }
    const doc = new LocalAccountDoc(data);
    await doc.save();
    return doc;
  },

  find() {
    if (connectDB.isMongoConnected()) {
      return MongoAccount.find();
    }
    const list = Array.from(memoryMap.values()).map((d) => new LocalAccountDoc(d));
    return {
      sort: async () => list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    };
  }
};

module.exports = HybridAccount;
