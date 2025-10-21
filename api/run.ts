// Cron: zoek pending subscription-renewals -> start SEPA incasso (recurring).

import type { VercelRequest, VercelResponse } from '@vercel/node';

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SHOP_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN!;
const API_VER = process.env.SHOPIFY_API_VERSION || '2025-10';
const MOLLIE_API_KEY = process.env.MOLLIE_API_KEY!;
const BASE = process.env.APP_BASE_URL!;

async function shopify(path: string, init?: RequestInit) {
  const url = `https://${SHOP}/admin/api/${API_VER}${path}`;
  const r = await fetch(url, {
    ...init,
    headers: {
      'X-Shopify-Access-Token': SHOP_TOKEN,
      'Content-Type': 'application/json',
      ...(init?.headers || {})
    }
  });
  if (!r.ok) throw new Error(`Shopify ${r.status}: ${await r.text()}`);
  return r.json();
}

async function findPendingRenewalOrders() {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  // Pas 'tag' filter desnoods aan op je app (veel apps zetten 'subscription' of 'easy-subscriptions')
  const url = `/orders.json?financial_status=pending&status=open&created_at_min=${encodeURIComponent(
    since
  )}&limit=100&fields=id,name,customer,total_price,tags`;
  const { orders } = await shopify(url);
  return (orders as any[]).filter(o => (o.tags || '').toLowerCase().includes('subscription'));
}

async function getMollieMeta(customerId: number) {
  const j = await shopify(`/customers/${customerId}/metafields.json?namespace=mollie`);
  const arr = (j.metafields || []) as any[];
  return {
    customerId: arr.find(m => m.key === 'customer_id')?.value || null,
    mandateId: arr.find(m => m.key === 'mandate_id')?.value || null
  };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  try {
    const orders = await findPendingRenewalOrders();
    const created: any[] = [];

    for (const o of orders) {
      if (!o.customer?.id) continue;

      const meta = await getMollieMeta(o.customer.id);
      if (!meta.customerId || !meta.mandateId) {
        // Geen mandate -> laat staan voor dunning/mandaat vernieuwen
        continue;
      }

      const payload = {
        amount: { currency: 'EUR', value: Number(o.total_price).toFixed(2) },
        description: `Renewal ${o.name}`,
        customerId: meta.customerId,
        mandateId: meta.mandateId,
        sequenceType: 'recurring',
        webhookUrl: `${BASE}/api/webhooks/mollie`,
        metadata: { orderId: o.id }
      };

      const r = await fetch('https://api.mollie.com/v2/payments', {
        method: 'POST',
        headers: { Authorization: `Bearer ${MOLLIE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!r.ok) {
        // note the failure but continue
        await shopify(`/orders/${o.id}.json`, {
          method: 'PUT',
          body: JSON.stringify({ order: { id: o.id, note: `Recurring init failed: ${await r.text()}` } })
        });
        continue;
      }
      const p = await r.json();
      created.push({ orderId: o.id, paymentId: p.id });

      await shopify(`/orders/${o.id}.json`, {
        method: 'PUT',
        body: JSON.stringify({ order: { id: o.id, note: `Recurring payment initiated: ${p.id}` } })
      });
    }

    return res.status(200).json({ triggered: created.length, items: created });
  } catch (e: any) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
}
