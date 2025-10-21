// Vercel Serverless Function (Node runtime, géén Edge)
// Verifieert Mollie webhooks via HMAC (Mollie-Signature) i.p.v. secret in de URL.

import crypto from "crypto";

async function getRawBody(req) {
  return await new Promise((resolve, reject) => {
    try {
      let data = [];
      req.on("data", chunk => data.push(chunk));
      req.on("end", () => resolve(Buffer.concat(data)));
      req.on("error", reject);
    } catch (e) { reject(e); }
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).send("Method Not Allowed");
    }

    // 1) Lees RÁW body (exact zoals gestuurd) en headers
    const raw = await getRawBody(req);              // Buffer
    const bodyStr = raw.toString("utf8");           // Mollie tekent over de raw string
    const ct = (req.headers["content-type"] || "").toLowerCase();

    // 2) HMAC-validatie (Mollie-Signature, sha256 over raw body met je signing secret)
    const provided = req.headers["mollie-signature"];
    const secret = process.env.MOLLIE_SIGNING_SECRET; // Zet dit in Vercel ENV (uit Mollie Dashboard)
    if (!provided || !secret) {
      return res.status(400).send("Missing signature or signing secret");
    }
    const expected = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");
    if (provided !== expected) {
      return res.status(403).send("Invalid signature");
    }

    // 3) Parse payment id uit body (Mollie post meestal x-www-form-urlencoded)
    let paymentId = null;
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(bodyStr);
      paymentId = params.get("id");
    } else if (ct.includes("application/json")) {
      const j = JSON.parse(bodyStr || "{}");
      paymentId = j.id;
    }
    if (!paymentId) {
      return res.status(400).send("Missing id");
    }

    // 4) Haal betaling op bij Mollie
    const mr = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MOLLIE_API_KEY}` }
    });
    if (!mr.ok) {
      const txt = await mr.text();
      // 502 zodat Mollie later kan retrypen
      return res.status(502).send(`Mollie fetch failed: ${mr.status} ${txt}`);
    }
    const payment = await mr.json();

    // 5) Verwerk alléén recurring + paid
    if (payment.status !== "paid" || payment.sequenceType !== "recurring") {
      return res.status(200).send(`Ignored: status=${payment.status}, seq=${payment.sequenceType}`);
    }

    // 6) Metadata → bepaal Shopify order
    const meta = payment.metadata || {};
    const variantId = Number(meta.variantId || process.env.DEFAULT_VARIANT_ID);
    if (!variantId) return res.status(400).send("Missing variantId (metadata or DEFAULT_VARIANT_ID)");

    const shopifyCustomerId = meta.shopifyCustomerId ? Number(meta.shopifyCustomerId) : undefined;
    const amountValue = (payment.amount && payment.amount.value) || meta.amountOverride || "0.00";

    const orderBody = {
      order: {
        line_items: [{ variant_id: variantId, quantity: 1 }],
        financial_status: "paid",
        customer: shopifyCustomerId ? { id: shopifyCustomerId } : undefined,
        tags: "subscription-renewal,mollie",
        note: `Renewal – Mollie ${payment.id} – €${amountValue}`
      }
    };

    // 7) Maak order in Shopify
    const sr = await fetch(`https://${process.env.SHOPIFY_STORE}/admin/api/2024-07/orders.json`, {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(orderBody)
    });

    if (!sr.ok) {
      const txt = await sr.text();
      return res.status(500).send(`Shopify error: ${sr.status} ${txt}`);
    }

    return res.status(200).send("OK");
  } catch (e) {
    return res.status(500).send("Error: " + e.message);
  }
}
