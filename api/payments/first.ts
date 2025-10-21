// Eerste betaling (iDEAL) starten -> mandate vastleggen na webhook.
// Body: { shopifyCustomerId:number, amount:string("9.99"), description?:string, returnUrl:string }

import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const API_VER = process.env.SHOPIFY_API_VERSION || '2025-10';
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY!;
const BASE = process.env.APP_BASE_URL!;
const APP_WEBHOOK_SECRET = process.env.APP_WEBHOOK_SECRET!;

function requireEnv(...keys: string[]) {
  for (const k of keys) if (!process.env[k]) throw new Error(`Missing env: ${k}`);
}

function twoDecimals(value: string | number) {
  return Number(value).toFixed(2);
}

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

async function getShopifyCustomer(id: number) {
  const j = await shopifyFetch(`/customers/${id}.json`);
  return j.customer;
}

async function getCustomerMetafields(id: number) {
  const j = await shopifyFetch(`/customers/${id}/metafields.json?namespace=mollie`);
  const arr = (j.metafields || []) as any[];
  return {
    customerId: arr.find(m => m.key === 'customer_id')?.value || null,
    mandateId: arr.find(m => m.key === 'mandate_id')?.value || null
  };
}

async function upsertCustomerMetafield(id: number, key: string, value: string) {
  const body = { metafield: { namespace: 'mollie', key, type: 'single_line_text_field', value } };
  await shopifyFetch(`/customers/${id}/metafields.json`, { method: 'POST', body: JSON.stringify(body) });
}

function signBody(body: string) {
  return crypto.createHmac('sha256', APP_WEBHOOK_SECRET).update(body).digest('hex');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    requireEnv('SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'MOLLIE_API_KEY', 'APP_BASE_URL', 'APP_WEBHOOK_SECRET');

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { shopifyCustomerId, amount, description, returnUrl } = req.body || {};
    if (!shopifyCustomerId || !amount || !returnUrl) return res.status(400).json({ error: 'Missing params' });

    const customer = await getShopifyCustomer(Number(shopifyCustomerId));
    const email = customer?.email || undefined;
    const name = [customer?.first_name, customer?.last_name].filter(Boolean).join(' ') || undefined;

    // Mollie customer
    let { customerId: mollieCustomerId } = await getCustomerMetafields(Number(shopifyCustomerId));
    if (!mollieCustomerId) {
      const rc = await fetch('https://api.mollie.com/v2/customers', {
        method: 'POST',
        headers: { Authorization: `Bearer ${MOLLIE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email })
      });
      if (!rc.ok) throw new Error(`Mollie customer create failed: ${rc.status} ${await rc.text()}`);
      const cj = await rc.json();
      mollieCustomerId = cj.id;
      await upsertCustomerMetafield(Number(shopifyCustomerId), 'customer_id', mollieCustomerId);
    }

    // First payment via iDEAL
    const payload = {
      amount: { currency: 'EUR', value: twoDecimals(amount) },
      description: description || 'Subscription first payment',
      redirectUrl: returnUrl,
      webhookUrl: `${BASE}/api/webhooks/mollie`,
      method: 'ideal',
      customerId: mollieCustomerId,
      sequenceType: 'first',
      metadata: { shopifyCustomerId: Number(shopifyCustomerId) }
    };
    const sig = signBody(JSON.stringify(payload)); // interne HMAC (optioneel voor debugging)
    const rp = await fetch('https://api.mollie.com/v2/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${MOLLIE_API_KEY}`, 'Content-Type': 'application/json', 'X-App-Signature': sig },
      body: JSON.stringify(payload)
    });
    if (!rp.ok) throw new Error(`Mollie payment create failed: ${rp.status} ${await rp.text()}`);
    const p = await rp.json();

    return res.status(200).json({ checkoutUrl: p?._links?.checkout?.href || null, paymentId: p?.id || null });
  } catch (e: any) {
    return res.status(500).json({ error: e.message || 'Internal error' });
  }
}
