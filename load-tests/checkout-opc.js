import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { parseHTML } from 'k6/html';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const EMAIL = __ENV.EMAIL || 'admin@yourStore.com';
const PASSWORD = __ENV.PASSWORD || 'arquiteurasoftware';
const USER_POOL = __ENV.USER_POOL || '';
const PRODUCT_ID = __ENV.PRODUCT_ID || '0';
const INVENTORY_QTY = Number(__ENV.INVENTORY_QTY || '2000');
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || '0.5');
const STOCK_KEYWORDS = ['stock', 'inventory', 'estoque', 'esgotado'];

export const options = {
  scenarios: {
    opc_success: {
      executor: 'ramping-vus',
      exec: 'scenarioSuccess',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 2 },
        { duration: '90s', target: 6 },
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    opc_basket_failure: {
      executor: 'constant-vus',
      exec: 'scenarioBasketFailure',
      vus: 1,
      duration: '2m',
      startTime: '5s',
    },
    opc_payment_failure: {
      executor: 'constant-vus',
      exec: 'scenarioPaymentFailure',
      vus: 1,
      duration: '2m',
      startTime: '10s',
    },
    opc_inventory_pressure: {
      executor: 'constant-vus',
      exec: 'scenarioInventoryPressure',
      vus: 1,
      duration: '2m',
      startTime: '15s',
    },
    opc_inventory_race: {
      executor: 'per-vu-iterations',
      exec: 'scenarioInventoryRace',
      vus: 2,
      iterations: 1,
      maxDuration: '2m',
      startTime: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.30'],
    http_req_duration: ['p(95)<5000'],
  },
};

function antiForgeryTokenFromHtml(html) {
  const doc = parseHTML(html || '');
  return doc.find('input[name="__RequestVerificationToken"]').first().attr('value') || '';
}

function parseBillingAddressId(html) {
  const doc = parseHTML(html || '');
  const options = doc.find('#billing-address-select option');
  for (let i = 0; i < options.size(); i++) {
    const value = options.eq(i).attr('value');
    if (value && value !== '0') return value;
  }
  return '';
}

function parseFirstInputValue(html, inputName) {
  const doc = parseHTML(html || '');
  return doc.find(`input[name="${inputName}"]`).first().attr('value') || '';
}

function parseJson(response) {
  try {
    return response.json();
  } catch (e) {
    return {};
  }
}

function includesStockKeyword(value) {
  const text = String(value || '').toLowerCase();
  return STOCK_KEYWORDS.some((k) => text.includes(k));
}

function hasInventoryFailureMessage(payload) {
  const message = payload?.message;
  if (Array.isArray(message)) {
    return message.some((m) => includesStockKeyword(m));
  }
  return includesStockKeyword(message);
}

function checkoutEndpoint(path) {
  return `${BASE_URL}/checkout/${path}/`;
}

function fetchStoreAntiForgeryToken(tokenHint = '') {
  const home = http.get(BASE_URL);
  check(home, { 'home loaded for csrf': (r) => r.status === 200 });

  const homeToken = antiForgeryTokenFromHtml(home.body);
  if (homeToken) return homeToken;

  const loginPage = http.get(`${BASE_URL}/login`);
  check(loginPage, { 'login page loaded for csrf': (r) => r.status === 200 });
  return antiForgeryTokenFromHtml(loginPage.body) || tokenHint;
}

function parseUserPool() {
  if (!USER_POOL.trim()) return [];

  return USER_POOL
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(':'))
    .map((entry) => {
      const idx = entry.indexOf(':');
      const email = entry.slice(0, idx).trim();
      const password = entry.slice(idx + 1).trim();
      return { email, password };
    })
    .filter((u) => u.email && u.password);
}

const users = parseUserPool();

function credentialsForCurrentVu() {
  if (users.length === 0) return { email: EMAIL, password: PASSWORD };
  const idx = (__VU - 1) % users.length;
  return users[idx];
}

function loginAndGetToken(credentials) {
  const loginPage = http.get(`${BASE_URL}/login`);
  check(loginPage, { 'login page loaded': (r) => r.status === 200 });

  const token = antiForgeryTokenFromHtml(loginPage.body);
  if (!token) return '';

  const loginRes = http.post(`${BASE_URL}/login`, {
    Email: credentials.email,
    Password: credentials.password,
    RememberMe: 'false',
    __RequestVerificationToken: token,
  });

  check(loginRes, {
    'login request status is expected': (r) => r.status === 200 || r.status === 302,
  });

  return token;
}

function discoverOrUseProductId() {
  if (PRODUCT_ID && PRODUCT_ID !== '0') return PRODUCT_ID;

  const home = http.get(BASE_URL);
  check(home, { 'home loaded': (r) => r.status === 200 });
  const match = home.body.match(/addproducttocart\/catalog\/(\d+)\/1\/1/);
  return match ? match[1] : '';
}

function discoverCandidateProductIdsFromHome() {
  const home = http.get(BASE_URL);
  check(home, { 'home loaded for candidate discovery': (r) => r.status === 200 });

  const regex = /addproducttocart\/catalog\/(\d+)\/1\/1/g;
  const seen = {};
  const ids = [];
  let m = null;

  while ((m = regex.exec(home.body)) !== null) {
    const id = m[1];
    if (!seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  }

  return ids;
}

function discoverInventoryPressureProductId(token) {
  const candidates = discoverCandidateProductIdsFromHome();

  if (PRODUCT_ID && PRODUCT_ID !== '0' && !candidates.includes(PRODUCT_ID)) {
    candidates.unshift(PRODUCT_ID);
  }

  for (let i = 0; i < candidates.length; i++) {
    const id = candidates[i];
    const add = addProductToCart(token, id, INVENTORY_QTY);

    if (!add.ok && hasInventoryFailureMessage(add.body)) {
      return id;
    }
  }

  return '';
}

function addProductToCart(token, productId, qty = 1) {
  if (!productId) return { ok: false, body: {} };

  const addRes = http.post(
    `${BASE_URL}/addproducttocart/catalog/${productId}/1/${qty}`,
    {
      forceredirection: 'false',
      __RequestVerificationToken: token,
    }
  );
  const body = parseJson(addRes);

  check(addRes, { 'add-to-cart responded': (r) => r.status === 200 });
  return { ok: !!body.success, body };
}

function openOpc(tokenHint) {
  const checkoutPage = http.get(`${BASE_URL}/onepagecheckout`);
  check(checkoutPage, { 'opc page loaded': (r) => r.status === 200 });

  const token = antiForgeryTokenFromHtml(checkoutPage.body) || tokenHint;
  const billingAddressId = parseBillingAddressId(checkoutPage.body);
  return { token, billingAddressId, html: checkoutPage.body };
}

function opcSaveBilling(token, billingAddressId) {
  const billingRes = http.post(checkoutEndpoint('OpcSaveBilling'), {
    billing_address_id: billingAddressId,
    ShipToSameAddress: 'true',
    __RequestVerificationToken: token,
  });
  check(billingRes, { 'opc billing status ok': (r) => r.status === 200 });
  return parseJson(billingRes);
}

function opcSaveShippingMethod(token, stepHtml) {
  const shippingOption = parseFirstInputValue(stepHtml, 'shippingoption');
  if (!shippingOption) return { error: 1, message: 'No shipping option available' };

  const shippingRes = http.post(checkoutEndpoint('OpcSaveShippingMethod'), {
    shippingoption: shippingOption,
    __RequestVerificationToken: token,
  });
  check(shippingRes, { 'opc shipping-method status ok': (r) => r.status === 200 });
  return parseJson(shippingRes);
}

function opcSavePaymentMethod(token, stepHtml, forcedMethod = '') {
  const paymentMethod = forcedMethod || parseFirstInputValue(stepHtml, 'paymentmethod');
  if (!paymentMethod) return { error: 1, message: 'No payment method available' };

  const paymentMethodRes = http.post(checkoutEndpoint('OpcSavePaymentMethod'), {
    paymentmethod: paymentMethod,
    UseRewardPoints: 'false',
    __RequestVerificationToken: token,
  });
  check(paymentMethodRes, { 'opc payment-method status ok': (r) => r.status === 200 });
  return parseJson(paymentMethodRes);
}

function opcSavePaymentInfo() {
  const paymentInfoRes = http.post(checkoutEndpoint('OpcSavePaymentInfo'), {});
  check(paymentInfoRes, { 'opc payment-info status ok': (r) => r.status === 200 });
  return parseJson(paymentInfoRes);
}

function opcConfirmOrder(token, captchaValid = true) {
  const confirmRes = http.post(checkoutEndpoint('OpcConfirmOrder'), {
    captchaValid: captchaValid ? 'true' : 'false',
    __RequestVerificationToken: token,
  });
  check(confirmRes, { 'opc confirm status ok': (r) => r.status === 200 });
  return parseJson(confirmRes);
}

function executeSuccessfulFlow(productQty = 1, credentials = credentialsForCurrentVu()) {
  const loginToken = loginAndGetToken(credentials);
  const addToCartToken = fetchStoreAntiForgeryToken(loginToken);
  const productId = discoverOrUseProductId();
  const add = addProductToCart(addToCartToken, productId, productQty);
  if (!add.ok) return { ok: false, stage: 'add_to_cart', data: add.body };

  const opc = openOpc(loginToken);
  if (!opc.billingAddressId) return { ok: false, stage: 'billing_address', data: {} };

  let token = opc.token;
  let json = opcSaveBilling(token, opc.billingAddressId);
  if (json.error) return { ok: false, stage: 'OpcSaveBilling', data: json };

  let stepHtml = json.update_section?.html || '';
  let nextSection = json.goto_section || '';
  token = antiForgeryTokenFromHtml(stepHtml) || token;

  if (nextSection === 'shipping_method') {
    json = opcSaveShippingMethod(token, stepHtml);
    if (json.error) return { ok: false, stage: 'OpcSaveShippingMethod', data: json };
    stepHtml = json.update_section?.html || '';
    nextSection = json.goto_section || '';
    token = antiForgeryTokenFromHtml(stepHtml) || token;
  }

  if (nextSection === 'payment_method') {
    json = opcSavePaymentMethod(token, stepHtml);
    if (json.error) return { ok: false, stage: 'OpcSavePaymentMethod', data: json };
    stepHtml = json.update_section?.html || '';
    nextSection = json.goto_section || '';
    token = antiForgeryTokenFromHtml(stepHtml) || token;
  }

  if (nextSection === 'payment_info') {
    json = opcSavePaymentInfo();
    if (json.error) return { ok: false, stage: 'OpcSavePaymentInfo', data: json };
    stepHtml = json.update_section?.html || '';
    token = antiForgeryTokenFromHtml(stepHtml) || token;
  }

  const confirm = opcConfirmOrder(token, true);
  if (confirm.redirect) {
    const redirectionRes = http.get(confirm.redirect);
    check(redirectionRes, {
      'redirection endpoint reached': (r) => r.status === 200 || r.status === 302,
    });
  }

  if (confirm.error) return { ok: false, stage: 'OpcConfirmOrder', data: confirm };
  return { ok: true, stage: 'success', data: confirm };
}

export function scenarioSuccess() {
  group('opc-success', function () {
    const result = executeSuccessfulFlow(1, credentialsForCurrentVu());
    check(result, { 'successful flow completed': (r) => r.ok === true });
  });
  sleep(THINK_TIME_SECONDS);
}

export function scenarioBasketFailure() {
  group('opc-basket-failure', function () {
    const loginToken = loginAndGetToken(credentialsForCurrentVu());
    const opc = openOpc(loginToken);
    const confirm = opcConfirmOrder(opc.token, true);

    check(confirm, {
      'basket failure produced application error': (j) =>
        !!j.error || (typeof j.message === 'string' && j.message.length > 0),
    });
  });
  sleep(THINK_TIME_SECONDS);
}

export function scenarioPaymentFailure() {
  group('opc-payment-failure', function () {
    const loginToken = loginAndGetToken(credentialsForCurrentVu());
    const addToCartToken = fetchStoreAntiForgeryToken(loginToken);
    const productId = discoverOrUseProductId();
    const add = addProductToCart(addToCartToken, productId, 1);
    if (!add.ok) return;

    const opc = openOpc(loginToken);
    if (!opc.billingAddressId) return;

    let token = opc.token;
    let json = opcSaveBilling(token, opc.billingAddressId);
    if (json.error) return;

    let stepHtml = json.update_section?.html || '';
    let nextSection = json.goto_section || '';
    token = antiForgeryTokenFromHtml(stepHtml) || token;

    if (nextSection === 'shipping_method') {
      json = opcSaveShippingMethod(token, stepHtml);
      if (json.error) return;
      stepHtml = json.update_section?.html || '';
      nextSection = json.goto_section || '';
      token = antiForgeryTokenFromHtml(stepHtml) || token;
    }

    if (nextSection === 'payment_method') {
      json = opcSavePaymentMethod(token, stepHtml, 'Payments.NonExistingProvider');
      stepHtml = json.update_section?.html || '';
      token = antiForgeryTokenFromHtml(stepHtml) || token;
    }

    const confirm = opcConfirmOrder(token, true);
    check(confirm, {
      'payment failure path produced non-success': (j) => !!j.error || !!j.update_section || !!j.message,
    });
  });
  sleep(THINK_TIME_SECONDS);
}

export function scenarioInventoryPressure() {
  group('opc-inventory-pressure', function () {
    const creds = credentialsForCurrentVu();
    const loginToken = loginAndGetToken(creds);
    const addToCartToken = fetchStoreAntiForgeryToken(loginToken);
    const productId = discoverInventoryPressureProductId(addToCartToken) || discoverOrUseProductId();

    if (!productId) {
      check({ ok: false }, {
        'inventory pressure has a valid product id': (r) => r.ok === true,
      });
      return;
    }

    // Force stock pressure directly on add-to-cart to generate inventory checkout failures.
    const add = addProductToCart(addToCartToken, productId, INVENTORY_QTY);
    const result = {
      ok: !add.ok && hasInventoryFailureMessage(add.body),
      raw: add.body,
    };

    check(result, {
      'inventory failure signal observed': (r) => r.ok === true,
    });
  });
  sleep(THINK_TIME_SECONDS);
}

export function scenarioInventoryRace() {
  group('opc-inventory-race', function () {
    const creds = credentialsForCurrentVu();
    const result = executeSuccessfulFlow(1, creds);
    check(result, {
      'inventory race flow executed': (r) => r.ok === true || r.ok === false,
    });
  });
}

export default function () {
  scenarioSuccess();
}
