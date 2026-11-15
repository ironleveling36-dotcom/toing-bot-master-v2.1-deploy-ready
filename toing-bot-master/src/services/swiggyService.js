const axios = require('axios');

const SWIGGY_BASE = 'https://www.swiggy.com';

class SwiggyService {
  static parseSetCookie(setCookieArray = [], existingCookies = {}) {
    const bag = { ...(existingCookies || {}) };
    if (!Array.isArray(setCookieArray)) return bag;

    for (const raw of setCookieArray) {
      const firstPart = String(raw).split(';')[0];
      const eqIdx = firstPart.indexOf('=');
      if (eqIdx > 0) {
        const k = firstPart.slice(0, eqIdx).trim();
        const v = firstPart.slice(eqIdx + 1).trim();
        bag[k] = v;
      }
    }
    return bag;
  }

  static serializeCookies(account) {
    const baseCookies = {
      _device_id: account.deviceId,
      _swuid: account.swuid,
      _guest_tid: account.tid || '',
      _sid: account.sid || '',
      ...(account.cookies || {})
    };
    return Object.entries(baseCookies)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  static buildHeaders(account, isMutation = false) {
    const headers = {
      'User-Agent': account.userAgent || 'Swiggy-Android/4.52.0 (SM-S918B; Android 13; SDK 33)',
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'X-Device-Id': account.deviceId,
      'deviceId': account.deviceId,
      'swuid': account.swuid,
      'tid': account.tid || 'null',
      'sid': account.sid || 'null',
      'version-code': '1165',
      'app-version': '4.52.0',
      'os-version': '13',
      'pl-name': 'Android',
      'Origin': SWIGGY_BASE,
      'Referer': `${SWIGGY_BASE}/`,
      'Cookie': this.serializeCookies(account)
    };

    if (isMutation && account.csrfToken) {
      headers['csrf-token'] = account.csrfToken;
      headers['x-csrf-token'] = account.csrfToken;
    }
    return headers;
  }

  static async captureSessionMeta(account, response) {
    if (!response || !response.headers) return;

    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
      account.cookies = this.parseSetCookie(setCookie, account.cookies);
      if (account.cookies._sid) account.sid = account.cookies._sid;
      if (account.cookies._guest_tid && !account.tid) account.tid = account.cookies._guest_tid;
    }

    const body = response.data;
    if (body && typeof body === 'object') {
      if (body.tid) account.tid = body.tid;
      if (body.sid) account.sid = body.sid;
      if (body.csrfToken) account.csrfToken = body.csrfToken;
    }

    account.markModified('cookies');
    await account.save();
  }

  static async warmSession(account) {
    const res = await axios.get(`${SWIGGY_BASE}/dapi/restaurants/list/v5`, {
      params: {
        lat: account.lat || '13.0827',
        lng: account.lng || '80.2707',
        'is-seo-homepage-enabled': true,
        page_type: 'DESKTOP_WEB_LISTING'
      },
      headers: this.buildHeaders(account, false),
      timeout: 15000,
      validateStatus: () => true
    });

    await this.captureSessionMeta(account, res);
    if (!account.csrfToken && res.data?.csrfToken) {
      account.csrfToken = res.data.csrfToken;
      await account.save();
    }
    return account;
  }

  static async sendOtp(account, forceNewDevice = false) {
    if (forceNewDevice || !account.deviceId || !account.swuid) {
      account.rotateDevice();
      await account.save();
    }

    if (!account.tid || !account.csrfToken) {
      await this.warmSession(account);
    }

    const payload = {
      mobile: account.phone,
      _csrf: account.csrfToken || undefined
    };

    const res = await axios.post(
      `${SWIGGY_BASE}/dapi/auth/sms-otp`,
      payload,
      {
        headers: this.buildHeaders(account, true),
        timeout: 15000,
        validateStatus: () => true
      }
    );

    await this.captureSessionMeta(account, res);

    const statusCode = res.data?.statusCode;
    const statusMessage = res.data?.statusMessage || '';

    if (
      statusCode !== 0 &&
      /multiple|device|limit|exceeded/i.test(statusMessage) &&
      !forceNewDevice
    ) {
      account.rotateDevice();
      await account.save();
      return this.sendOtp(account, true);
    }

    return {
      ok: statusCode === 0,
      statusCode,
      message: statusMessage || (statusCode === 0 ? 'OTP sent' : 'OTP send failed'),
      deviceId: account.deviceId,
      swuid: account.swuid,
      raw: res.data
    };
  }

  static async verifyOtp(account, otp) {
    const payload = {
      otp: String(otp).trim(),
      _csrf: account.csrfToken || undefined
    };

    const res = await axios.post(
      `${SWIGGY_BASE}/dapi/auth/otp-verify`,
      payload,
      {
        headers: this.buildHeaders(account, true),
        timeout: 15000,
        validateStatus: () => true
      }
    );

    await this.captureSessionMeta(account, res);

    const statusCode = res.data?.statusCode;
    const statusMessage = res.data?.statusMessage || '';

    if (statusCode === 0) {
      account.isLoggedIn = true;
      if (res.data?.data?.name) account.name = res.data.data.name;
      if (res.data?.data?.email) account.email = res.data.data.email;
      await account.save();
    }

    return {
      ok: statusCode === 0,
      statusCode,
      message: statusMessage || (statusCode === 0 ? 'Logged in' : 'OTP verification failed'),
      deviceId: account.deviceId,
      isMultipleDeviceError: /multiple|device|limit|session/i.test(statusMessage),
      raw: res.data
    };
  }

  static async syncCart(account, cartPayload = null) {
    const url = `${SWIGGY_BASE}/dapi/cart`;

    const res = cartPayload
      ? await axios.post(url, { ...cartPayload, _csrf: account.csrfToken }, {
          headers: this.buildHeaders(account, true),
          timeout: 15000,
          validateStatus: () => true
        })
      : await axios.get(url, {
          headers: this.buildHeaders(account, false),
          timeout: 15000,
          validateStatus: () => true
        });

    await this.captureSessionMeta(account, res);

    const cartData = res.data?.data?.cartMeta || res.data?.data || {};
    const rawItems = cartData.cart_items || cartData.items || [];

    account.cartState = {
      cartId: String(cartData.cart_id || cartData.cartId || ''),
      items: rawItems.map(item => ({
        itemId: item.item_id || item.id,
        name: item.name || 'Item',
        quantity: Number(item.quantity || 1),
        total: Number(item.total || item.final_price || item.price || 0)
      })),
      totalAmount: Number(cartData.cart_total || cartData.order_total || 0),
      restaurantName: cartData.restaurant_details?.name || cartData.restaurant_name || '',
      updatedAt: new Date()
    };

    account.markModified('cartState');
    await account.save();

    return {
      ok: res.data?.statusCode === 0,
      cartState: account.cartState,
      raw: res.data
    };
  }

  static async syncPaymentStatus(account, orderId = null) {
    const targetOrderId = orderId || account.paymentState?.orderId;

    const url = targetOrderId
      ? `${SWIGGY_BASE}/dapi/order/track?order_id=${encodeURIComponent(targetOrderId)}`
      : `${SWIGGY_BASE}/dapi/order/all`;

    const res = await axios.get(url, {
      headers: this.buildHeaders(account, false),
      timeout: 15000,
      validateStatus: () => true
    });

    await this.captureSessionMeta(account, res);

    const data = res.data?.data || {};
    const latestOrder = targetOrderId
      ? (data.orders?.[0] || data)
      : (data.orders?.[0] || null);

    if (latestOrder && (latestOrder.order_id || targetOrderId)) {
      const rawStatus = String(
        latestOrder.payment_txn_status ||
        latestOrder.order_status ||
        latestOrder.post_status ||
        'PENDING'
      ).toUpperCase();

      let normalizedStatus = 'PENDING';
      if (/SUCCESS|PAID|CONFIRMED|DELIVERED|PROCESSING/.test(rawStatus)) {
        normalizedStatus = 'SUCCESS';
      } else if (/FAIL|CANCEL|ABORT|EXPIRE/.test(rawStatus)) {
        normalizedStatus = 'FAILED';
      }

      account.paymentState = {
        orderId: String(latestOrder.order_id || targetOrderId || ''),
        transactionId: String(latestOrder.payment_txn_id || latestOrder.pg_response_time || ''),
        status: normalizedStatus,
        paymentMethod: latestOrder.payment_method || account.paymentState?.paymentMethod || '',
        amount: Number(latestOrder.order_total || latestOrder.net_total || 0),
        upiIntentUrl: latestOrder.upi_intent_url || account.paymentState?.upiIntentUrl || '',
        updatedAt: new Date()
      };

      account.markModified('paymentState');
      await account.save();
    }

    return {
      ok: res.data?.statusCode === 0,
      paymentState: account.paymentState,
      raw: res.data
    };
  }
}

module.exports = SwiggyService;
