import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { parseHTML } from 'k6/html';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const USER_AGENT =
  __ENV.USER_AGENT ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

const EMAIL = __ENV.EMAIL || 'admin@yourStore.com';
const PASSWORD = __ENV.PASSWORD || 'arquiteurasoftware';
const SUCCESS_EMAIL = __ENV.SUCCESS_EMAIL || EMAIL;
const SUCCESS_PASSWORD = __ENV.SUCCESS_PASSWORD || PASSWORD;
const SUCCESS_ACCOUNTS = (__ENV.SUCCESS_ACCOUNTS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex === -1) return null;

    const email = entry.slice(0, separatorIndex).trim();
    const password = entry.slice(separatorIndex + 1).trim();
    if (!email || !password) return null;

    return { email, password };
  })
  .filter(Boolean);
const BASKET_FAILURE_EMAIL = __ENV.BASKET_FAILURE_EMAIL || '';
const BASKET_FAILURE_PASSWORD = __ENV.BASKET_FAILURE_PASSWORD || '';

const PRODUCT_ID = __ENV.PRODUCT_ID || '18';
const SUCCESS_PRODUCT_ID = __ENV.SUCCESS_PRODUCT_ID || PRODUCT_ID;
const INVENTORY_PRODUCT_ID = __ENV.INVENTORY_PRODUCT_ID || '48';
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || '1');
const SUCCESS_THINK_TIME_SECONDS = Number(__ENV.SUCCESS_THINK_TIME_SECONDS || '65');

const SUCCESS_STAGE_1_DURATION = __ENV.SUCCESS_STAGE_1_DURATION || '30s';
const SUCCESS_STAGE_1_TARGET = Number(__ENV.SUCCESS_STAGE_1_TARGET || '1');
const SUCCESS_STAGE_2_DURATION = __ENV.SUCCESS_STAGE_2_DURATION || '90s';
const SUCCESS_STAGE_2_TARGET = Number(__ENV.SUCCESS_STAGE_2_TARGET || '1');
const SUCCESS_STAGE_3_DURATION = __ENV.SUCCESS_STAGE_3_DURATION || '30s';
const SUCCESS_STAGE_3_TARGET = Number(__ENV.SUCCESS_STAGE_3_TARGET || '0');

const FAILURE_DURATION = __ENV.FAILURE_DURATION || '2m';
const BASKET_FAILURE_START_TIME = __ENV.BASKET_FAILURE_START_TIME || '5s';
const INVENTORY_FAILURE_START_TIME = __ENV.INVENTORY_FAILURE_START_TIME || '15s';
const BASKET_FAILURE_VUS = Number(__ENV.BASKET_FAILURE_VUS || '0');
const INVENTORY_FAILURE_VUS = Number(__ENV.INVENTORY_FAILURE_VUS || '0');

const DEFAULT_REQUEST_PARAMS = {
  headers: {
    'User-Agent': USER_AGENT,
  },
};

export const options = {
  scenarios: {
    opc_success: {
      executor: 'ramping-vus',
      exec: 'scenarioSuccess',
      startVUs: SUCCESS_STAGE_1_TARGET > 0 ? SUCCESS_STAGE_1_TARGET : 0,
      stages: [
        { duration: SUCCESS_STAGE_1_DURATION, target: SUCCESS_STAGE_1_TARGET },
        { duration: SUCCESS_STAGE_2_DURATION, target: SUCCESS_STAGE_2_TARGET },
        { duration: SUCCESS_STAGE_3_DURATION, target: SUCCESS_STAGE_3_TARGET },
      ],
      gracefulRampDown: '10s',
    },
    ...(BASKET_FAILURE_VUS > 0
      ? {
          opc_basket_failure: {
            executor: 'constant-vus',
            exec: 'scenarioBasketFailure',
            vus: BASKET_FAILURE_VUS,
            duration: FAILURE_DURATION,
            startTime: BASKET_FAILURE_START_TIME,
          },
        }
      : {}),
    ...(INVENTORY_FAILURE_VUS > 0
      ? {
          opc_inventory_failure: {
            executor: 'constant-vus',
            exec: 'scenarioInventoryFailure',
            vus: INVENTORY_FAILURE_VUS,
            duration: FAILURE_DURATION,
            startTime: INVENTORY_FAILURE_START_TIME,
          },
        }
      : {}),
  },
  thresholds: {
    http_req_failed: ['rate<0.30'],
    http_req_duration: ['p(95)<5000'],
  },
};

function withDefaultParams(params = {}) {
  return {
    ...params,
    headers: {
      ...DEFAULT_REQUEST_PARAMS.headers,
      ...(params.headers || {}),
    },
  };
}

function antiForgeryTokenFromHtml(html) {
  const doc = parseHTML(html || '');
  return doc.find('input[name="__RequestVerificationToken"]').first().attr('value') || '';
}

function parseSelectedOrFirstOptionValue(selection) {
  const selected = selection.find('option[selected]').first().attr('value');
  if (selected) return selected;
  return selection.find('option').first().attr('value') || '';
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

function parseCartItemIds(html) {
  const ids = [];
  const seen = {};
  const regex = /name="itemquantity(\d+)"/g;
  let match = null;

  while ((match = regex.exec(html || '')) !== null) {
    const id = match[1];
    if (!seen[id]) {
      seen[id] = true;
      ids.push(id);
    }
  }

  return ids;
}

function parseJson(response) {
  try {
    return response.json();
  } catch (e) {
    return {};
  }
}

function parseProductDetailsForm(html, productId, qty = 1) {
  const doc = parseHTML(html || '');
  const payload = {};

  const inputs = doc.find('#product-details-form input');
  for (let i = 0; i < inputs.size(); i++) {
    const input = inputs.eq(i);
    const name = input.attr('name');
    if (!name) continue;

    const type = String(input.attr('type') || 'text').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      if (input.attr('checked')) payload[name] = input.attr('value') || 'on';
      continue;
    }

    payload[name] = input.attr('value') || '';
  }

  const selects = doc.find('#product-details-form select');
  for (let i = 0; i < selects.size(); i++) {
    const select = selects.eq(i);
    const name = select.attr('name');
    if (!name) continue;
    payload[name] = parseSelectedOrFirstOptionValue(select);
  }

  const textareas = doc.find('#product-details-form textarea');
  for (let i = 0; i < textareas.size(); i++) {
    const textarea = textareas.eq(i);
    const name = textarea.attr('name');
    if (!name) continue;
    payload[name] = textarea.text() || '';
  }

  payload[`addtocart_${productId}.EnteredQuantity`] = String(qty);
  payload.__RequestVerificationToken = antiForgeryTokenFromHtml(html);
  return payload;
}

function parseCartUpdatePayload(html) {
  const doc = parseHTML(html || '');
  const payload = {
    updatecart: 'updatecart',
    __RequestVerificationToken: antiForgeryTokenFromHtml(html),
  };

  const qtyInputs = doc.find('#shopping-cart-form input[name^="itemquantity"]');
  for (let i = 0; i < qtyInputs.size(); i++) {
    const input = qtyInputs.eq(i);
    const name = input.attr('name');
    if (!name) continue;
    payload[name] = input.attr('value') || '1';
  }

  const attributeInputs = doc.find(
    '#shopping-cart-form input[name^="checkout_attribute_"], #shopping-cart-form textarea[name^="checkout_attribute_"]'
  );
  for (let i = 0; i < attributeInputs.size(); i++) {
    const input = attributeInputs.eq(i);
    const name = input.attr('name');
    if (!name) continue;

    const type = String(input.attr('type') || 'text').toLowerCase();
    if (type === 'radio' || type === 'checkbox') {
      if (input.attr('checked')) payload[name] = input.attr('value') || 'on';
      continue;
    }

    payload[name] = input.attr('value') || input.text() || '';
  }

  const attributeSelects = doc.find('#shopping-cart-form select[name^="checkout_attribute_"]');
  for (let i = 0; i < attributeSelects.size(); i++) {
    const select = attributeSelects.eq(i);
    const name = select.attr('name');
    if (!name) continue;
    payload[name] = parseSelectedOrFirstOptionValue(select);
  }

  return payload;
}

function checkoutEndpoint(path) {
  return `${BASE_URL}/checkout/${path}/`;
}

function credentialsForScenario(scenarioName) {
  if (scenarioName === 'opc_basket_failure' && BASKET_FAILURE_EMAIL && BASKET_FAILURE_PASSWORD) {
    return { email: BASKET_FAILURE_EMAIL, password: BASKET_FAILURE_PASSWORD };
  }

  return { email: SUCCESS_EMAIL, password: SUCCESS_PASSWORD };
}

function successCredentialsForCurrentIteration() {
  if (SUCCESS_ACCOUNTS.length === 0) {
    return credentialsForScenario('opc_success');
  }

  const index = ((__VU - 1) + __ITER) % SUCCESS_ACCOUNTS.length;
  return SUCCESS_ACCOUNTS[index];
}

function loginAndGetToken(credentials) {
  const loginPage = http.get(`${BASE_URL}/login`, withDefaultParams());
  check(loginPage, { 'login page loaded': (r) => r.status === 200 });

  const token = antiForgeryTokenFromHtml(loginPage.body);
  if (!token) return '';

  const loginRes = http.post(
    `${BASE_URL}/login`,
    {
      Email: credentials.email,
      Password: credentials.password,
      RememberMe: 'false',
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );

  check(loginRes, {
    'login request status is expected': (r) => r.status === 200 || r.status === 302,
  });

  return token;
}

function clearShoppingCart() {
  const cartPage = http.get(`${BASE_URL}/cart`, withDefaultParams());
  check(cartPage, { 'cart page loaded': (r) => r.status === 200 });

  const token = antiForgeryTokenFromHtml(cartPage.body);
  const ids = parseCartItemIds(cartPage.body);
  if (!token || ids.length === 0) return;

  const payload = {
    removefromcart: ids.join(','),
    updatecart: 'updatecart',
    __RequestVerificationToken: token,
  };

  ids.forEach((id) => {
    payload[`itemquantity${id}`] = '0';
  });

  const updateRes = http.post(`${BASE_URL}/cart`, payload, withDefaultParams());
  check(updateRes, { 'cart cleared update status ok': (r) => r.status === 200 });
}

function addProductToCart(productId, qty = 1, expectBusinessSuccess = true) {
  if (!productId) return { ok: false, body: {} };

  const home = http.get(BASE_URL, withDefaultParams());
  check(home, { 'home loaded for csrf': (r) => r.status === 200 });

  const token = antiForgeryTokenFromHtml(home.body);
  const addRes = http.post(
    `${BASE_URL}/addproducttocart/catalog/${productId}/1/${qty}`,
    {
      forceredirection: 'false',
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );

  let body = parseJson(addRes);
  check(addRes, { 'add-to-cart responded': (r) => r.status === 200 });

  if (body.redirect) {
    const detailsPage = http.get(`${BASE_URL}${body.redirect}`, withDefaultParams());
    check(detailsPage, { 'product details page loaded': (r) => r.status === 200 });

    const detailsPayload = parseProductDetailsForm(detailsPage.body, productId, qty);
    const detailsRes = http.post(
      `${BASE_URL}/addproducttocart/details/${productId}/1`,
      detailsPayload,
      withDefaultParams()
    );
    body = parseJson(detailsRes);
    check(detailsRes, { 'details add-to-cart responded': (r) => r.status === 200 });
  }

  if (expectBusinessSuccess) {
    check(body, { 'add-to-cart business success': (b) => !!b.success });
  }
  return { ok: !!body.success, body };
}

function saveCartCheckoutAttributes() {
  const cartPage = http.get(`${BASE_URL}/cart`, withDefaultParams());
  check(cartPage, { 'cart page loaded for checkout attrs': (r) => r.status === 200 });

  const payload = parseCartUpdatePayload(cartPage.body);
  if (!payload.__RequestVerificationToken) return;

  const updateRes = http.post(`${BASE_URL}/cart`, payload, withDefaultParams());
  check(updateRes, { 'cart checkout attributes saved': (r) => r.status === 200 });
}

function openOpc(tokenHint = '') {
  const checkoutPage = http.get(`${BASE_URL}/onepagecheckout`, withDefaultParams());
  check(checkoutPage, { 'opc page loaded': (r) => r.status === 200 });

  return {
    token: antiForgeryTokenFromHtml(checkoutPage.body) || tokenHint,
    billingAddressId: parseBillingAddressId(checkoutPage.body),
  };
}

function opcSaveBilling(token, billingAddressId) {
  const response = http.post(
    checkoutEndpoint('OpcSaveBilling'),
    {
      billing_address_id: billingAddressId,
      ShipToSameAddress: 'true',
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );
  check(response, { 'opc billing status ok': (r) => r.status === 200 });
  return parseJson(response);
}

function opcSaveShippingMethod(token, stepHtml) {
  const shippingOption = parseFirstInputValue(stepHtml, 'shippingoption');
  if (!shippingOption) return { error: 1, message: 'No shipping option available' };

  const response = http.post(
    checkoutEndpoint('OpcSaveShippingMethod'),
    {
      shippingoption: shippingOption,
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );
  check(response, { 'opc shipping-method status ok': (r) => r.status === 200 });
  return parseJson(response);
}

function opcSavePaymentMethod(token, stepHtml) {
  const paymentMethod = parseFirstInputValue(stepHtml, 'paymentmethod');
  if (!paymentMethod) return { error: 1, message: 'No payment method available' };

  const response = http.post(
    checkoutEndpoint('OpcSavePaymentMethod'),
    {
      paymentmethod: paymentMethod,
      UseRewardPoints: 'false',
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );
  check(response, { 'opc payment-method status ok': (r) => r.status === 200 });
  return parseJson(response);
}

function opcSavePaymentInfo() {
  const response = http.post(checkoutEndpoint('OpcSavePaymentInfo'), {}, withDefaultParams());
  check(response, { 'opc payment-info status ok': (r) => r.status === 200 });
  return parseJson(response);
}

function opcConfirmOrder(token) {
  const response = http.post(
    checkoutEndpoint('OpcConfirmOrder'),
    {
      captchaValid: 'true',
      termsofservice: 'true',
      TermsOfService: 'true',
      __RequestVerificationToken: token,
    },
    withDefaultParams()
  );
  check(response, { 'opc confirm status ok': (r) => r.status === 200 });
  return parseJson(response);
}

function executeSuccessfulFlow(credentials, productId) {
  const loginToken = loginAndGetToken(credentials);
  clearShoppingCart();

  const add = addProductToCart(productId, 1, true);
  if (!add.ok) return { ok: false, stage: 'add_to_cart', data: add.body };

  saveCartCheckoutAttributes();

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

  const confirm = opcConfirmOrder(token);
  if (confirm.error) return { ok: false, stage: 'OpcConfirmOrder', data: confirm };
  return { ok: true, stage: 'success', data: confirm };
}

function executeSuccessfulFlowWithFallback(credentials) {
  const candidates = [];
  if (SUCCESS_PRODUCT_ID) candidates.push(SUCCESS_PRODUCT_ID);
  if (PRODUCT_ID && !candidates.includes(PRODUCT_ID)) candidates.push(PRODUCT_ID);

  if (candidates.length === 0) return { ok: false, stage: 'product_discovery', data: {} };

  let last = { ok: false, stage: 'unknown', data: {} };
  for (let i = 0; i < candidates.length; i++) {
    last = executeSuccessfulFlow(credentials, candidates[i]);
    if (last.ok) return last;
  }

  return last;
}

export function scenarioSuccess() {
  group('opc-success', function () {
    const result = executeSuccessfulFlowWithFallback(successCredentialsForCurrentIteration());
    check(result, { 'successful flow completed': (r) => r.ok === true });
  });
  // nopCommerce rate-limits order placement per customer, so single-account tests need a longer pause.
  // When multiple success accounts are configured, we can reduce the wait and still produce valid orders.
  sleep(SUCCESS_ACCOUNTS.length > 0 ? THINK_TIME_SECONDS : SUCCESS_THINK_TIME_SECONDS);
}

export function scenarioBasketFailure() {
  group('opc-basket-failure', function () {
    let loginToken = '';
    if (BASKET_FAILURE_EMAIL && BASKET_FAILURE_PASSWORD) {
      loginToken = loginAndGetToken(credentialsForScenario('opc_basket_failure'));
    }

    clearShoppingCart();
    const opc = openOpc(loginToken);
    const confirm = opcConfirmOrder(opc.token);

    check(confirm, {
      'basket failure produced application error': (j) =>
        !!j.error || (typeof j.message === 'string' && j.message.length > 0),
    });
  });
  sleep(THINK_TIME_SECONDS);
}

export function scenarioInventoryFailure() {
  group('opc-inventory-failure', function () {
    clearShoppingCart();
    const add = addProductToCart(INVENTORY_PRODUCT_ID, 1, false);

    check(add, {
      'inventory failure produced non-success': (r) => r.ok === false,
    });
  });
  sleep(THINK_TIME_SECONDS);
}

export default function () {
  scenarioSuccess();
}
