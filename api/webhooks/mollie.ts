// Mollie webhook: payment ID binnen -> payment refetchen -> acties uitvoeren.

import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const API_VER = process.env.SHOPIFY_API_VERSION || '2025-10';
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY!;

async function shopifyFetch(path: string, init?: RequestInit) {
  const url = `https://${SHOP}/admin/api/${API_VER}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': SHOP_TOKEN,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Shopify ${r.status}: ${t}`);
  }
  return r.json();
}

async function upsertCustomerMetafield(customerId: number, key: string, value: string) {
  const body = { metafield: { namespace: 'mollie', key, type: 'single_line_text_field', value } };
  await shopifyFetch(`/customers/${customerId}/metafields.json`, { method: 'POST', body: JSON.stringify(body) });
}

async function addOrderNote(orderId: number, note: string, tags?: string) {
  await shopifyFetch(`/orders/${orderId}.json`, {
    method: 'PUT',
    body: JSON.stringify({ order: { id: orderId, note, ...(tags ? { tags } : {}) } })
  });
}

async function markOrderPaid(orderId: number, paymentId: string) {
  const body = {
    transaction: {
      kind: 'sale',
      status: 'success',
      gateway: 'Mollie SEPA',
      authorization: paymentId
    }
  };
  await fetch(`https://${SHOP}/admin/api/${API_VER}/orders/${orderId}/transactions.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': SHOP_TOKEN,
      'Content-Type': 'application/json',
      'Idempotency-Key': paymentId
    },
    body: JSON.stringify(body)
  });
}

async function fetchPayment(paymentId: string) {
  const r = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` }
  });
  if (!r.ok) throw new Error(`Mollie fetch payment failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function listMandates(customerId: string) {
  const r = await fetch(`https://api.mollie.com/v2/customers/${customerId}/mandates`, {
    headers: { Authorization: `Bearer ${MOLLIE_API_KEY}` }
  });
  if (!r.ok) throw new Error(`Mollie list mandates failed: ${r.status} ${await r.text()}`);
  return r.json();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    if (req.method !== 'POST') return res.status(405).send('Method not allowed');

    const paymentId = (req.body && (req.body.id || req.body.paymentId)) || (req.query?.id as string);
    if (!paymentId) return res.status(400).send('no id');

    const payment = await fetchPayment(paymentId);
    const status: string = payment.status; // open|paid|failed|canceled|expired
    const seq: string = payment.sequenceType; // first|recurring
    const mollieCustomerId: string = payment.customerId;
    const metadata = payment.metadata || {};
    const orderId: number | undefined = metadata.orderId;
    const shopifyCustomerId: number | undefined = metadata.shopifyCustomerId;

    if (status === 'paid' && seq === 'first' && mollieCustomerId && shopifyCustomerId) {
      const mandates = await listMandates(mollieCustomerId);
      const active = mandates?._embedded?.mandates?.find((m: any) => m.status === 'valid');
      if (active?.id) await upsertCustomerMetafield(Number(shopifyCustomerId), 'mandate_id', String(active.id));
    }

    if (status === 'paid' && seq === 'recurring' && orderId) {
      await markOrderPaid(Number(orderId), paymentId);
    }

    if ((status === 'failed' || status === 'canceled' || status === 'expired') && orderId) {
      await addOrderNote(Number(orderId), `Payment ${status} via Mollie: ${paymentId}`, 'dunning');
    }

    return res.status(200).send('OK');
  } catch (e) {
    console.error(e);
    // Antwoord toch 200 om onnodige retries te voorkomen; je cron vangt op.
    return res.status(200).send('OK');
  }
}
