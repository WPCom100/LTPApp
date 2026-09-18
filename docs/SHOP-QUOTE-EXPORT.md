# Signed quote requirements feed for LTP Shop

`GET /api/shop-export/quotes` is a separately authenticated, read-only feed.
Configure `LTP_SHOP_QUOTE_EXPORT_TOKEN` with a random secret of at least 32 characters
and send it in `X-LTP-Shop-Token`. An unset/short secret disables the endpoint (503);
missing or wrong credentials return 401. Do not reuse an inventory export token.
Rotate the credential by replacing the environment value and restarting the service.

The `ltpapp.shop-quotes/1` envelope contains `generatedAt` and `quotes`. A quote is
included only when its activity contains a `client_accepted` event with a signature.
Manual acceptance alone is insufficient. The signature is represented by its SHA-256,
activity ID, and signing date/time; the image is never exported.

Each quote includes source ID/status/update time, project name and dates, operational
notes, and sectioned equipment/note lines. Prices, discounts, customer/contact records,
financial integrations, share tokens, and other activity records are excluded using
an explicit allowlist. The response is marked `Cache-Control: no-store`.

Previously signed quotes remain visible after recall or decline, so Shop can block
preparation and preserve its existing movement history. Removing a quote from this
feed must never be interpreted as proof that its physical gear has been returned.
The consumer should reject stale revisions and reconcile changes without losing scans.

Shop owns its local PM-user association, ready-by deadline, and inventory product
mapping; those fields do not currently exist on LTPApp quotes. Unresolved mappings
must be shown as outstanding work. Equipment IDs are source identities, not Shop UUIDs.

This source PR is one dependency of the Shop workflow. It does not deploy the feed,
configure credentials, or change LTPApp's quote UI or allocation policy.

Validation: `python -m unittest tests.test_shop_quote_export` (three focused tests,
no database or external service). Tests cover distinct credential scope, manual
acceptance exclusion, recalled quotes, and exclusion of financial/signature secrets.
