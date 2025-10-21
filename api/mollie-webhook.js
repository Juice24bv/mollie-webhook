export const config = { runtime: "edge" }; // snellere cold starts

async function mollieGet(paymentId, apiKey) {
  const r = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!r.ok) throw new Error("Mollie fetch failed: " + r.status);
  return r.json();
}

export default async (req) => {
  // Mollie post x-www-form-urlencoded: id=tr_xxx
  const url = new URL(req.url);
  const secret = url.pathname.split("/").pop();
  if (secret !== process.env.WEBHOOK_SECRET) {
    return new Response("Forbidden", { status: 403 });
  }

  const ct = req.headers.get("content-type") || "";
  let paymentId = null;
  if (ct.includes("application/x-www-form-urlencoded")) {
    const body = await req.text();
    const params = new URLSearchParams(body);
    paymentId = params.get("id");
  } else if (ct.includes("application/json")) {
    const j = await req.json();
    paymentId = j.id;
  }
  if (!paymentId) return new Response("Missing id", { status: 400 });

  // Idempotency via KV? Gebruik Vercel KV / Upstash voor productie.
  // Voor demo: skip idempotency.

  try {
    const payment = await mollieGet(paymentId, process.env.MOLLIE_API_KEY);
    if (payment.status !== "paid" || payment.sequenceType !== "recurring") {
      return new Response("Ignored", { status: 200 });
    }

    const meta = payment.metadata || {};
    const variantId = meta.variantId || process.env.DEFAULT_VARIANT_ID;
    const customerId = meta.shopifyCustomerId ? Number(meta.shopifyCustomerId) : undefined;

    const orderBody = {
      order: {
        line_items: [{ variant_id: Number(variantId), quantity: 1 }],
        financial_status: "paid",
        customer: customerId ? { id: customerId } : undefined,
        tags: "subscription-renewal,mollie",
        note: `Renewal – Mollie ${payment.id} – €${payment.amount?.value || "0.00"}`
      }
    };

    const r = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2024-07/orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderBody)
    });
    if (!r.ok) {
      const t = await r.text();
      return new Response("Shopify error: " + t, { status: 500 });
    }

    return new Response("OK", { status: 200 });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500 });
  }
};
