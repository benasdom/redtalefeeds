const express = require('express');
const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../services/paymentService');

const router = express.Router();

// In-memory "orders" so verify has something to attach to — swap for real
// order creation once you wire a DB back in. Keyed by the Paystack
// reference, which also doubles as the order's public `id` (see
// buildOrderFromVerification) so there's a single identifier throughout —
// no separate "internal id" that the client would have to know how to
// translate back into a reference.
const paidOrders = new Map(); // reference -> order

const TRACKING_WINDOW_DAYS = 7;

/**
 * Turns a verified Paystack transaction into the full Order shape the
 * frontend expects (see frontend src/types/index.ts `Order` and
 * src/services/orderService.ts `fromApiOrder`). The only things trusted
 * from the client are what the payment gateway itself echoes back on a
 * verified transaction (result.amount, result.currency, result.metadata) —
 * never a client-supplied total.
 *
 * Exported standalone so it can be unit-tested without touching the
 * network or Paystack.
 */
function buildOrderFromVerification(result) {
  const meta = result.metadata || {};
  const paidAt = result.paidAt || new Date().toISOString();
  const windowClosesAt = new Date(
    new Date(paidAt).getTime() + TRACKING_WINDOW_DAYS * 24 * 60 * 60 * 1000
  ).toISOString();

  return {
    id: result.reference, // unified with the lookup key used by GET /orders/:reference
    reference: result.reference,
    status: 'AGENT_REVIEWING', // matches the ShopBot order state machine's entry state
    createdAt: paidAt,
    windowClosesAt,
    items: Array.isArray(meta.items) ? meta.items : [],
    subtotal: typeof meta.subtotal === 'number' ? meta.subtotal : result.amount,
    shippingFee: typeof meta.shippingFee === 'number' ? meta.shippingFee : 0,
    serviceFee: typeof meta.serviceFee === 'number' ? meta.serviceFee : 0,
    total: result.amount, // always the Paystack-verified amount, never trusted from metadata
    amount: result.amount, // kept for backward compatibility with any code reading `amount`
    currency: result.currency,
    shippingAddress: meta.shippingAddress || null,
    customerEmail: result.customerEmail,
    agentName: 'Redtale Agent Team',
    agentNote: null,
    timeline: [
      {
        id: 'evt_0',
        status: 'AGENT_REVIEWING',
        label: 'agent reviewing',
        note: 'Payment confirmed — a Redtale agent is reviewing your order.',
        occurredAt: paidAt,
      },
    ],
  };
}

// POST /payments/init  { email, amount, currency?, offerId?, quantity?, items?, shippingAddress?, subtotal?, shippingFee?, serviceFee? }
router.post('/init', async (req, res) => {
  const {
    email, amount, currency, offerId, quantity,
    items, shippingAddress, subtotal, shippingFee, serviceFee,
  } = req.body || {};

  try {
    const data = await initializeTransaction({
      email,
      amount,
      currency, // undefined falls back to initializeTransaction's 'NGN' default
      metadata: {
        offerId: offerId || null,
        quantity: quantity || 1,
        // Everything here is opaque to Paystack — it's just stored and
        // echoed back verbatim on verify, which is how buildOrderFromVerification
        // reconstructs the full order without a database.
        items: Array.isArray(items) ? items : [],
        shippingAddress: shippingAddress || null,
        subtotal: typeof subtotal === 'number' ? subtotal : null,
        shippingFee: typeof shippingFee === 'number' ? shippingFee : null,
        serviceFee: typeof serviceFee === 'number' ? serviceFee : null,
      },
    });
    res.json({ authorizationUrl: data.authorization_url, reference: data.reference, accessCode: data.access_code });
  } catch (err) {
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'PAYSTACK_SECRET_KEY is not set on the server' });
    }
    console.error('[payments route] init error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /payments/verify  { reference }
// This is the ONLY place an "order" gets marked paid — never trust a client
// callback alone. Call this after the client's Paystack webview reports
// success, before you consider the order placed.
router.post('/verify', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const result = await verifyTransaction(reference);

    if (!result.success) {
      return res.status(402).json({ error: 'Payment not successful', status: result.status });
    }

    const order = buildOrderFromVerification(result);
    paidOrders.set(reference, order);

    res.json({ order });
  } catch (err) {
    if (err.code === 'PAYSTACK_NOT_CONFIGURED') {
      return res.status(501).json({ error: 'PAYSTACK_SECRET_KEY is not set on the server' });
    }
    console.error('[payments route] verify error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// POST /payments/webhook — Paystack calls this async, independent of the
// client. Requires express.raw() body parsing (wired in server.js) so the
// HMAC check runs against the exact bytes Paystack sent.
router.post('/webhook', (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  try {
    const rawBody = req.body; // Buffer, thanks to express.raw() on this route
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('[payments webhook] verified event:', event.event, event.data && event.data.reference);

    // e.g. if (event.event === 'charge.success') { ...update order... }

    res.sendStatus(200);
  } catch (err) {
    console.error('[payments webhook] error:', err.message);
    res.sendStatus(400);
  }
});

// GET /payments/orders — list all paid orders, most recent first.
// Matches orderService.fetchOrders() on the frontend, which previously had
// no corresponding route at all.
router.get('/orders', (req, res) => {
  const orders = Array.from(paidOrders.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
  res.json({ orders });
});

// GET /payments/orders/:reference — single order lookup. Since `order.id`
// is now the same value as the Paystack reference, this one route serves
// both "fetch by reference" and "fetch by id" call sites on the frontend.
router.get('/orders/:reference', (req, res) => {
  const order = paidOrders.get(req.params.reference);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json({ order });
});

module.exports = router;
module.exports.buildOrderFromVerification = buildOrderFromVerification; // exported for tests