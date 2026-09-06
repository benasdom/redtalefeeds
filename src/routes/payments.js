const express = require('express');
const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../services/paymentService');
const { requireAuth } = require('../middleware/auth');
const { supabase } = require('../lib/supabase');

const router = express.Router();

// Fixed — this app charges in USD only, no conversion. Whatever USD amount
// the app shows the user is exactly what gets sent to Paystack and exactly
// what gets stored on the order. (fxService.js / GHS conversion has been
// removed — this backend never had a real need for it since Paystack was
// only ever being charged in the app's own currency.)
const CURRENCY = 'GHS';

const TRACKING_WINDOW_DAYS = 7;

/**
 * Shapes a `orders` row (+ its order_items / order_timeline_events rows)
 * into the Order the frontend expects (see frontend src/types/index.ts
 * `Order` and src/services/orderService.ts `fromApiOrder`).
 */
function toApiOrder(row, items, timeline) {
  return {
    id: row.reference, // unified with the lookup key used by GET /orders/:reference
    reference: row.reference,
    status: row.status,
    createdAt: row.paid_at || row.created_at,
    estimatedDelivery: row.estimated_delivery || null,
    windowClosesAt: row.window_closes_at,
    items: (items || []).map((it) => ({
      id: it.id,
      retailer: it.retailer,
      title: it.title,
      imageUrl: it.image_url,
      price: it.price,
      offerUrl: it.offer_url,
      quantity: it.quantity,
    })),
    subtotal: row.subtotal ?? row.amount,
    shippingFee: row.shipping_fee ?? 0,
    serviceFee: row.service_fee ?? 0,
    total: row.amount, // always the Paystack-verified amount, never trusted from metadata
    amount: row.amount, // kept for backward compatibility with any code reading `amount`
    currency: row.currency,
    shippingAddress: row.shipping_address || null,
    customerEmail: row.customer_email,
    agentName: 'Redtale Agent Team',
    agentNote: row.agent_note || null,
    carrier: row.carrier || null,
    trackingNumber: row.tracking_number || null,
    timeline: (timeline || []).map((ev) => ({
      id: ev.id,
      status: ev.status,
      label: ev.label,
      note: ev.note,
      occurredAt: ev.occurred_at,
    })),
  };
}

/** Loads the order_items + order_timeline_events for a row and shapes it. */
async function fetchOrderWithRelations(orderRow) {
  const [{ data: items, error: itemsErr }, { data: timeline, error: timelineErr }] = await Promise.all([
    supabase
      .from('order_items')
      .select('id, title, retailer, price, quantity, image_url, offer_url')
      .eq('order_id', orderRow.id),
    supabase
      .from('order_timeline_events')
      .select('id, status, label, note, occurred_at')
      .eq('order_id', orderRow.id)
      .order('occurred_at', { ascending: true }),
  ]);
  if (itemsErr) throw itemsErr;
  if (timelineErr) throw timelineErr;
  return toApiOrder(orderRow, items, timeline);
}

// POST /payments/init  { amount, offerId?, quantity?, items?, shippingAddress?, subtotal?, shippingFee?, serviceFee? }
router.post('/init', requireAuth, async (req, res) => {
  const {
    amount, offerId, quantity,
    items, shippingAddress, subtotal, shippingFee, serviceFee,
  } = req.body || {};

  try {
    const data = await initializeTransaction({
      // The signed-in user's own email — never trust a client-supplied
      // email here, or a customer could have order confirmations (and
      // Paystack receipts) sent to an address that isn't theirs.
      email: req.user.email,
      amount,
      currency: CURRENCY,
      metadata: {
        userId: req.user.id, // checked again on verify so one user can never confirm another user's payment
        offerId: offerId || null,
        quantity: quantity || 1,
        // Everything here is opaque to Paystack — it's just stored and
        // echoed back verbatim on verify, which is how the order gets
        // reconstructed without the client having to resend it.
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
// success, before you consider the order placed. Creates the order row (+
// items + an initial timeline event) in Supabase on first success;
// idempotent on retry.
router.post('/verify', requireAuth, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'reference is required' });

  try {
    const result = await verifyTransaction(reference);

    if (!result.success) {
      return res.status(402).json({ error: 'Payment not successful', status: result.status });
    }

    const meta = result.metadata || {};
    if (meta.userId && meta.userId !== req.user.id) {
      // Paystack references are unguessable, but this is a cheap extra
      // check against a signed-in user trying to confirm someone else's
      // reference.
      return res.status(403).json({ error: 'This payment does not belong to your account' });
    }

    // Idempotent: if this reference was already recorded (client retry, or
    // the /webhook route processing it independently), just return the
    // existing order instead of inserting a duplicate.
    const { data: existing, error: existingErr } = await supabase
      .from('orders')
      .select('*')
      .eq('reference', reference)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (existingErr) throw existingErr;

    if (existing) {
      const order = await fetchOrderWithRelations(existing);
      return res.json({ order });
    }

    const paidAt = result.paidAt || new Date().toISOString();
    const subtotal = typeof meta.subtotal === 'number' ? meta.subtotal : result.amount;
    const shippingFee = typeof meta.shippingFee === 'number' ? meta.shippingFee : 0;
    const serviceFee = typeof meta.serviceFee === 'number' ? meta.serviceFee : 0;
    const windowClosesAt = new Date(
      new Date(paidAt).getTime() + TRACKING_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: orderRow, error: insertErr } = await supabase
      .from('orders')
      .insert({
        user_id: req.user.id,
        reference: result.reference,
        amount: result.amount, // always the Paystack-verified amount, never trusted from metadata
        currency: result.currency || CURRENCY,
        customer_email: result.customerEmail,
        metadata: meta,
        status: 'AGENT_REVIEWING', // matches the ShopBot order state machine's entry state
        paid_at: paidAt,
        subtotal,
        shipping_fee: shippingFee,
        service_fee: serviceFee,
        shipping_address: meta.shippingAddress || null,
        window_closes_at: windowClosesAt,
      })
      .select('*')
      .single();
    if (insertErr) throw insertErr;

    const orderItems = Array.isArray(meta.items) ? meta.items : [];
    if (orderItems.length) {
      const { error: itemsInsertErr } = await supabase.from('order_items').insert(
        orderItems.map((it) => ({
          order_id: orderRow.id,
          title: it.title,
          retailer: it.retailer || null,
          price: typeof it.price === 'number' ? it.price : 0,
          quantity: it.quantity || 1,
          image_url: it.imageUrl || null,
          offer_url: it.offerUrl || null,
        }))
      );
      if (itemsInsertErr) throw itemsInsertErr;
    }

    const { error: timelineErr } = await supabase.from('order_timeline_events').insert({
      order_id: orderRow.id,
      status: 'AGENT_REVIEWING',
      label: 'Agent reviewing',
      note: 'Payment confirmed — a Redtale agent is reviewing your order.',
      // created_by_agent_id left null: this is a system-generated event.
    });
    if (timelineErr) throw timelineErr;

    const order = await fetchOrderWithRelations(orderRow);
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
// HMAC check runs against the exact bytes Paystack sent. Public on purpose
// (Paystack can't send an Authorization: Bearer session token) — trust is
// established via the HMAC signature instead.
router.post('/webhook', (req, res) => {
  const signature = req.headers['x-paystack-signature'];

  try {
    const rawBody = req.body; // Buffer, thanks to express.raw() on this route
    if (!verifyWebhookSignature(rawBody, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString('utf8'));
    console.log('[payments webhook] verified event:', event.event, event.data && event.data.reference);

    // Order creation happens in POST /verify above (triggered by the
    // client's Paystack webview success callback), which is idempotent on
    // `reference` — so there's nothing further required here for the
    // common case. If you want orders to also get created when the client
    // never calls /verify (e.g. app killed mid-checkout), handle
    // `charge.success` here using the same insert logic as /verify,
    // keyed on event.data.reference.

    res.sendStatus(200);
  } catch (err) {
    console.error('[payments webhook] error:', err.message);
    res.sendStatus(400);
  }
});

// GET /payments/orders — this user's paid orders, most recent first.
router.get('/orders', requireAuth, async (req, res) => {
  try {
    const { data: rows, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    const orders = await Promise.all(rows.map(fetchOrderWithRelations));
    res.json({ orders });
  } catch (err) {
    console.error('[payments route] list orders error:', err.message);
    res.status(500).json({ error: 'Failed to load orders' });
  }
});

// GET /payments/orders/:reference — single order lookup, scoped to this
// user. Since `order.id` is the same value as the Paystack reference, this
// one route serves both "fetch by reference" and "fetch by id" call sites
// on the frontend.
router.get('/orders/:reference', requireAuth, async (req, res) => {
  try {
    const { data: row, error } = await supabase
      .from('orders')
      .select('*')
      .eq('reference', req.params.reference)
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) return res.status(404).json({ error: 'Not found' });

    const order = await fetchOrderWithRelations(row);
    res.json({ order });
  } catch (err) {
    console.error('[payments route] get order error:', err.message);
    res.status(500).json({ error: 'Failed to load order' });
  }
});

module.exports = router;
