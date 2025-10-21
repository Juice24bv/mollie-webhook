# Shopify Subscriptions via Mollie (iDEAL first -> SEPA recurring)

## Install
1) Kopieer `api/` + `vercel.json` + `.env.example` naar je Vercel project.
2) Zet env vars (Settings -> Environment). Redeploy.

## Test
1) `POST /api/payments/first` met body:
   { "shopifyCustomerId": 1234567890, "amount": "9.99", "returnUrl":"https://example.com/success" }
   -> redirect klant naar `checkoutUrl`.
2) Na betaling: webhook schrijft `mollie.mandate_id` op Shopify customer.
3) Maak pending renewal order (en tag 'subscription').
4) Cron `/api/renewals/run` (of handmatig aanroepen) -> maakt recurring payment.
5) Webhook markeert order 'paid'. Mislukt? Tag 'dunning' + note.

## Notes
- iDEAL alleen voor **first**; renewals via **SEPA incasso**.
- Idempotency: transaction POST met header `Idempotency-Key: <molliePaymentId>`.
- Amount altijd als **string met 2 decimals**.
- Geen DB nodig: gebruik Shopify Metafields (namespace `mollie`).

## Env
Zie `.env.example`. Gebruik eerst `test_xxx`, daarna `live_xxx`.

