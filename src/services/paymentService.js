/**
 * paymentService.js
 *
 * Server-side Paystack integration. Two calls only:
 *   1. initializeTransaction — starts a transaction, returns an authorization_url
 *      + reference for the client's Paystack webview/checkout.
 *   2. verifyTransaction — the ONLY source of truth for "did this payment
 *      succeed". Never trust a client-supplied "success" flag or amount.
 *
 * Requires PAYSTACK_SECRET_KEY in .env. Amount is passed in the currency's
 * base unit (whole USD, e.g. 24.99) and converted to the smallest unit
 * (cents) here, since that's what Paystack's API expects — callers never do
 * that math.
 *
 * Currency is always USD — there is no conversion step. The amount the app
 * shows the user is exactly the amount charged and exactly the amount
 * stored on the order.
 */

const fetch = require('node-fetch');

const PAYSTACK_BASE = 'https://api.paystack.co';
const DEFAULT_CURRENCY = 'USD';

function requireKey() {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) {
    const err = new Error('PAYSTACK_SECRET_KEY is not set in .env');
    err.code = 'PAYSTACK_NOT_CONFIGURED';
    throw err;
  }
  return key;
}

/**
 * @param {object} params
 * @param {string} params.email - customer email (Paystack requires this)
 * @param {number} params.amount - amount in the currency's base unit, e.g. 24.99 USD
 * @param {string} [params.currency] - defaults to USD; this app does not convert currency
 * @param {object} [params.metadata] - anything you want echoed back on verify (e.g. offerId, quantity)
 */
async function initializeTransaction({ email, amount, currency = DEFAULT_CURRENCY, metadata = {} }) {
  const key = requireKey();

  if (!email) throw new Error('email is required to initialize a Paystack transaction');
  if (!amount || amount <= 0) throw new Error('amount must be a positive number');

  const res = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: Math.round(amount * 100), // USD -> cents
      currency,
      metadata,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(`Paystack init failed: ${data.message || res.statusText}`);
  }

  // data.data => { authorization_url, access_code, reference }
  return data.data;
}

/**
 * Independently re-checks a transaction with Paystack. This is what actually
 * decides whether an order gets created — never trust the client's callback
 * alone.
 * @param {string} reference
 */
async function verifyTransaction(reference) {
  const key = requireKey();
  if (!reference) throw new Error('reference is required to verify a Paystack transaction');

  const res = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });

  const data = await res.json();
  if (!res.ok || !data.status) {
    throw new Error(`Paystack verify failed: ${data.message || res.statusText}`);
  }

  const tx = data.data; // { status, amount (cents), currency, reference, customer, metadata, ... }
  return {
    success: tx.status === 'success',
    status: tx.status,
    amount: tx.amount / 100, // back to base unit
    currency: tx.currency,
    reference: tx.reference,
    paidAt: tx.paid_at,
    customerEmail: tx.customer && tx.customer.email,
    metadata: tx.metadata,
    raw: tx,
  };
}

/**
 * Verifies the HMAC signature Paystack sends on the `x-paystack-signature`
 * header for webhook calls. Use this before trusting a webhook body.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const crypto = require('crypto');
  const key = requireKey();
  const hash = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
  return hash === signatureHeader;
}

module.exports = { initializeTransaction, verifyTransaction, verifyWebhookSignature };
