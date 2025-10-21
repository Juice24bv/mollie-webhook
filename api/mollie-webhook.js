import crypto from "crypto";

// Helper: lees RAW body (no bodyParser!)
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    } catch (e) { reject(e); }
  });
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    // 1) Lees raw body en headers
    const raw = await getRawBody(req);
    const bodyStr = raw.toString("utf8");
    const ct = (req.headers["content-type"] || "").toLowerCase();

    // 2) HMAC-verificatie (Mollie-Signature)
    const provided = req.headers["mollie-signature"];
    const secret = process.env.MOLLIE_SIGNING_SECRET;
    if (!provided || !secret) return res.status(400).send("Missing signature or signing secret");

    const expected = crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");
    if (provided !== expected) {
      console.error("❌ Invalid Mollie signature");
      return res.status(403).send("Invalid signature");
    }

    // 3) Extract payment id
    let paymentId = null;
    if (ct.includes("application/x-www-form-urlencoded")) {
      const params = new URLSearchParams(bodyStr);
      paymentId = params.get("id");
    } else if (ct.includes("application/json")) {
      try { paymentId = JSON.parse(bodyStr)?.id; } catch (_) { /* ignore */ }
    }
    if (!paymentId) return res.status(400).send("Missing id");

    console.log("➡️ Fetching payment", {
      paymentId,
      keyType: process.env.MOLLIE_API_KEY?.startsWith("live_") ? "live" : "test"
    });

    // 4) Haal betaling op bij Mollie
    const mr = await fetch(`https://api.mollie.com/v2/payments/${paymentId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${process.env.MOLLIE_API_KEY}`,
        "Accept": "application/json"
      }
    });

    const respText = await mr.text();
    if (!mr.ok) {
      console.error("❌ Mollie fetch error", { status: mr.status, body: respText });
      // Geef fouttekst terug voor debug, maar 502 zodat Mollie retried
      return res.status(502).send(`Mollie fetch failed: ${mr.status} ${respText}`);
    }

    const payment = JSON.parse(respText);

    // 5) Alleen recurring + paid verwerken
    if (payment.status !== "paid" || payment.sequenceType !== "recurring") {
      console.log("ℹ️ Ignored payment", { status: payment.status, seq: payment.sequenceType });
      return res.status(200).send(`Ignored: ${payment.status}/${payment.sequenceType}`);
    }

    // 6) Metadata → Shopify order
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

    // 7) Post naar Shopify
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
      console.error("❌ Shopify error", { status: sr.status, body: txt });
      return res.status(500).send(`Shopify error: ${sr.status} ${txt}`);
    }

    console.log("✅ Order created in Shopify", { paymentId: payment.id });
    return res.status(200).send("OK");
  } catch (e) {
    console.error("❌ Webhook error", e);
    return res.status(500).send("Error: " + e.message);
  }
}
