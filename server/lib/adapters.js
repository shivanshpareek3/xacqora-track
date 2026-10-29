// Platform adapters: normalize every incoming webhook payload into
// { client_id, event_type, phone, email, name, city, amount, currency,
//   product, gateway_txn_id, status, visitor_id, fbclid, fbc, ts, extra }
// The router (handleWebhook) then creates the lead + events.
const { normPhone, normEmail } = require('./shared');

// field map lookup: client-specific mapping overrides default keys
function pick(payload, map, keys) {
  for (const k of keys) if (payload[k] != null && payload[k] !== '') return payload[k];
  for (const [k, v] of Object.entries(map || {})) if (payload[v] != null && payload[v] !== '') return payload[v];
  return null;
}

const ADAPTERS = {
  // ----- Meta leadgen (Instant Forms) -----
  meta_leadgen(tx, { client_id, payload, map }) {
    const data = payload.data && payload.data[0] ? payload.data[0] : payload;
    const fd = data.leadgen_form_data || data;
    const phone = pick(fd, map, ['phone_number', 'phone', 'PHONE']);
    const email = pick(fd, map, ['email', 'EMAIL']);
    const name = pick(fd, map, ['full_name', 'first_name', 'name', 'NAME']);
    const city = pick(fd, map, ['city', 'CITY']);
    const out = {
      client_id,
      event_type: 'meta_form_lead',
      phone, email, name, city,
      ad_id: data.ad_id || null, adset_id: data.adset_id || null, campaign_id: data.campaign_id || null,
      form_id: data.form_id || null,
      source_ref: data.id || null,
      extra: { ad_id: data.ad_id, adset_id: data.adset_id, campaign_id: data.campaign_id, form_id: data.form_id },
      ts: payload.time || new Date().toISOString(),
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
    // create a touchpoint for the ad that generated this lead
    if (out.ad_id) out.touchpoint = { ad_id: out.ad_id, adset_id: out.adset_id, campaign_id: out.campaign_id, utm_medium: 'paid', utm_source: 'facebook', utm_campaign: data.campaign_id };
    return out;
  },

  // ----- TagMango: course / workshop purchases -----
  tagmango(tx, { client_id, payload, map }) {
    const p = payload.data || payload;
    const amount = pick(p, map, ['amount', 'price', 'total']);
    return {
      client_id,
      event_type: 'payment_success',
      phone: pick(p, map, ['phone', 'mobile', 'customer_phone', 'phone_number']),
      email: pick(p, map, ['email', 'customer_email']),
      name: pick(p, map, ['name', 'customer_name', 'first_name']),
      amount: amount ? Number(amount) : null,
      currency: 'INR',
      product: pick(p, map, ['product', 'course', 'item_title']) || 'TagMango order',
      gateway: 'tagmango',
      gateway_txn_id: pick(p, map, ['order_id', 'transaction_id', 'txn_id']) || null,
      status: 'success',
      ts: payload.created_at || new Date().toISOString(),
      source_ref: pick(p, map, ['order_id']) || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Razorpay -----
  razorpay(tx, { client_id, payload, map }) {
    // payload.event is a string ("payment.captured"); the entity is nested under payload.payload.payment
    const p = (payload.payload && payload.payload.payment && payload.payload.payment.entity)
      ? payload.payload.payment.entity : (payload.entity || payload);
    const notes = p.notes || {};
    const failed = payload.event === 'payment.failed' || p.status === 'failed';
    const refund = payload.event === 'payment.refunded';
    return {
      client_id,
      event_type: refund ? 'refund' : failed ? 'payment_failed' : 'payment_success',
      phone: notes.phone_number || notes.phone || null,
      email: p.email || notes.email || null,
      name: p.contact_name || notes.customer_name || null,
      amount: p.amount ? p.amount / 100 : null,
      currency: 'INR',
      product: notes.product || p.method || null,
      gateway: 'razorpay',
      gateway_txn_id: p.id,
      status: failed ? 'failed' : 'success',
      ts: p.created_at ? new Date(p.created_at * 1000).toISOString() : new Date().toISOString(),
      source_ref: p.id,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Cashfree -----
  cashfree(tx, { client_id, payload, map }) {
    const p = payload.payload || payload;
    const ev = payload.event || '';
    const refund = ev === 'REFUND_SETTLED' || p.orderRefunded === true;
    return {
      client_id,
      event_type: refund ? 'refund' : 'payment_success',
      phone: p.phone || p.custom || null,
      email: p.email || null,
      name: p.name || null,
      amount: p.amount ? Number(p.amount) : null,
      currency: 'INR',
      product: p.productName || p.orderId || null,
      gateway: 'cashfree',
      gateway_txn_id: p.transactionId,
      ts: p.dateTime || new Date().toISOString(),
      source_ref: p.transactionId,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Cosmofeed: purchases -----
  cosmofeed(tx, { client_id, payload, map }) {
    const p = payload.data || payload;
    return {
      client_id,
      event_type: 'payment_success',
      phone: pick(p, map, ['phone', 'mobile', 'customer_phone']),
      email: pick(p, map, ['email']),
      name: pick(p, map, ['name', 'customer_name']),
      amount: pick(p, map, ['amount', 'total_price', 'order_amount']) ? Number(pick(p, map, ['amount', 'total_price', 'order_amount'])) : null,
      currency: 'INR',
      product: pick(p, map, ['product', 'product_name']) || 'Cosmofeed order',
      gateway: 'cosmofeed',
      gateway_txn_id: pick(p, map, ['order_id', 'transaction_id']) || null,
      ts: new Date().toISOString(),
      source_ref: pick(p, map, ['order_id']) || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Aevent: webinar registration / attendance -----
  aevent(tx, { client_id, payload, map }) {
    const action = (payload.action || payload.type || '').toLowerCase();
    const p = payload.data || payload;
    let type = 'registered';
    if (action.includes('join') || action.includes('attend')) type = 'webinar_joined';
    else if (action.includes('leave')) type = 'webinar_left';
    else if (action.includes('replay')) type = 'replay_watched';
    let minutes = null;
    if (type === 'webinar_left') minutes = pick(p, map, ['watch_time_minutes', 'minutes_watched']);
    return {
      client_id,
      event_type: type,
      phone: pick(p, map, ['phone', 'mobile', 'phone_number']),
      email: pick(p, map, ['email']),
      name: pick(p, map, ['name', 'first_name', 'user_name']),
      extra: type === 'webinar_left' ? { minutes_watched: minutes } : null,
      ts: payload.timestamp || new Date().toISOString(),
      source_ref: p.id || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Zoom -----
  zoom(tx, { client_id, payload, map }) {
    const t = payload.object || 'registration';
    const p = payload.object_value || payload.data || payload;
    let type = 'registered';
    if (t === 'attendee' || p.attendee_status === 'JOINED' || p.status === 'joined') type = 'webinar_joined';
    else if (p.status === 'left' || t === 'leave') type = 'webinar_left';
    return {
      client_id,
      event_type: type,
      phone: pick(p, map, ['phone', 'mobile_phone', 'attributes.phone_number']),
      email: pick(p, map, ['email']),
      name: pick(p, map, ['name', 'display_name']),
      ts: payload.created_at || new Date().toISOString(),
      source_ref: p.id || p.uuid || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Calendly -----
  calendly(tx, { client_id, payload, map }) {
    const a = payload.event === 'invitee_created' || payload.type === 'call_booked' ? 'call_booked' :
      (payload.event === 'invitee_canceled' || payload.type === 'call_cancelled' ? 'call_cancelled' : 'call_booked');
    const i = payload.invitee || payload;
    const phone = pick(i, map, ['phone_number', 'phone']);
    const email = pick(i, map, ['email', 'email_address']);
    return {
      client_id,
      event_type: a,
      phone, email,
      name: pick(i, map, ['first_name', 'full_name', 'name']),
      extra: a === 'call_booked' ? { start_time: i.start_time || i.utm || null } : null,
      ts: payload.created_at || new Date().toISOString(),
      source_ref: i.uid || i.id || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- FlexiFunnels: opt-ins and orders -----
  flexifunnels(tx, { client_id, payload, map }) {
    const p = payload.data || payload;
    const isOrder = p.order_id || p.amount || p.payment_status;
    return {
      client_id,
      event_type: isOrder ? 'payment_success' : 'registered',
      phone: pick(p, map, ['phone', 'mobile', 'phone_number', 'contact_number']),
      email: pick(p, map, ['email', 'mail']),
      name: pick(p, map, ['name', 'full_name', 'first_name']),
      amount: isOrder ? (pick(p, map, ['amount', 'total', 'order_amount']) ? Number(pick(p, map, ['amount', 'total', 'order_amount'])) : null) : null,
      currency: 'INR',
      product: pick(p, map, ['product', 'funnel_name']) || 'FlexiFunnels',
      gateway: 'flexifunnels',
      gateway_txn_id: p.order_id || null,
      ts: new Date().toISOString(),
      source_ref: p.order_id || p.id || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Pabbly: anything, plus WhatsApp flows -----
  pabbly(tx, { client_id, payload, map }) {
    const p = payload.data || payload;
    const ev = (payload.type || p.event_type || '').toLowerCase();
    let type = 'note_added';
    if (ev.includes('whatsapp') && ev.includes('reply')) type = 'whatsapp_replied';
    else if (ev.includes('whatsapp') || ev.includes('sent')) type = 'whatsapp_sent';
    else if (ev.includes('payment') || ev.includes('order')) type = 'payment_success';
    else if (ev.includes('call')) type = 'call_booked';
    else if (ev.includes('register')) type = 'registered';
    const amount = pick(p, map, ['amount', 'price']);
    return {
      client_id,
      event_type: type,
      phone: pick(p, map, ['phone', 'mobile', 'number', 'whatsapp_number']),
      email: pick(p, map, ['email']),
      name: pick(p, map, ['name', 'contact_name']),
      amount: amount ? Number(amount) : null,
      currency: 'INR',
      product: ev || null,
      gateway: 'pabbly',
      source_ref: p.id || null,
      ts: payload.created_at || new Date().toISOString(),
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- WhatsApp providers (WATI / Interakt / AiSensy / Periskope) -----
  whatsapp(tx, { client_id, payload, map }) {
    const p = payload.data || payload;
    const inbound = p.type === 'inbound' || p.direction === 'in' || p.from !== undefined && p.to !== undefined && !p.session_id;
    const type = p.message_type === 'reply' || inbound ? 'whatsapp_replied' : 'whatsapp_sent';
    const num = p.from || p.to || p.phone || p.whatsapp_number;
    return {
      client_id,
      event_type: type,
      phone: num,
      email: null,
      name: p.name || null,
      extra: { text: p.text ? String(p.text).slice(0, 300) : null, provider: p.provider || 'whatsapp' },
      ts: p.timestamp || new Date().toISOString(),
      source_ref: p.message_id || null,
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },

  // ----- Google Sheets / CSV upload -----
  google_sheets(tx, { client_id, payload, map }) {
    // payload: { rows: [ {name, phone, email, stage, amount, ...} ] }
    return {
      client_id,
      event_type: 'imported',
      rows: payload.rows || [],
      raw_payload: JSON.stringify(payload).slice(0, 20000),
    };
  },
};

module.exports = { ADAPTERS };
