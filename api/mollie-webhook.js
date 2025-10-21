export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const mollie = req.body;

  // ✅ Vereist: Mollie moet metadata bevatten
  const { shopify_customer_id, shopify_order_id } = mollie.metadata || {};
  const mollie_customer_id = mollie.customerId;
  const mandate_id = mollie.mandateId;
  const payment_id = mollie.id;
  const sequence = mollie.sequenceType; // 'first' of 'recurring'

  if (!shopify_customer_id || !shopify_order_id) {
    return res.status(400).json({ error: 'Missing Shopify IDs in Mollie metadata' });
  }

  const shop = process.env.SHOPIFY_SHOP;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;

  const headers = {
    'X-Shopify-Access-Token': token,
    'Content-Type': 'application/json',
  };

  // 👤 1. customer_id
  await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/customers/${shopify_customer_id}/metafields.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metafield: {
        namespace: 'mollie',
        key: 'customer_id',
        value: mollie_customer_id,
        type: 'single_line_text_field',
      }
    })
  });

  // 👤 2. mandate_id
  await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/customers/${shopify_customer_id}/metafields.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metafield: {
        namespace: 'mollie',
        key: 'mandate_id',
        value: mandate_id,
        type: 'single_line_text_field',
      }
    })
  });

  // 📦 3. payment_id
  await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/orders/${shopify_order_id}/metafields.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metafield: {
        namespace: 'mollie',
        key: 'payment_id',
        value: payment_id,
        type: 'single_line_text_field',
      }
    })
  });

  // 📦 4. sequence (first/recurring)
  await fetch(`https://${shop}.myshopify.com/admin/api/2023-10/orders/${shopify_order_id}/metafields.json`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      metafield: {
        namespace: 'mollie',
        key: 'sequence',
        value: sequence,
        type: 'single_line_text_field',
      }
    })
  });

  res.status(200).json({ status: 'ok' });
}
