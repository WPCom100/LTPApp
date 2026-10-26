# Sending quotes when sales tax is unavailable

A quote can now be sent when the sender cannot calculate sales tax in
QuickBooks. This allows a proposal to reach the client before tax is final.
Taxable invoices still require the existing QuickBooks tax calculation.

## Sending a quote

Select **Send Quote** or **Resend** in the email composer. If tax cannot be
calculated because of permissions, a disconnected QuickBooks account, or a
calculation failure, the **Sales Tax Unavailable** dialog offers two choices:

- **Send Quote Anyway** sends the quote using its saved totals. The warning
  explains that sales tax may be missing or out of date.
- **Cancel** returns to the composer and keeps the recipients and message.

Confirmation applies to one send only. Resending requires confirmation again.
It does not change the client's tax settings or QuickBooks permissions.
Admins still calculate tax normally when QuickBooks is available.

Save quote changes before opening the composer. Before sending, the app checks
that the saved quote matches the quote used in the email. If a save is pending,
verification fails, or the saved quote has changed, sending stops with guidance
to save or reload and compose the email again. This prevents unsaved edits from
producing an email total that differs from the shared quote or PDF.

## Implementation and testing

The change reuses the quote confirmation dialog and email sender in
`modules/quotes-builder.js`. The confirmation appears above the email composer.
The app cache version advances from v122 to v123 so clients receive the update.
No backend or database changes are required.

Local verification passed:

- Quote regression tests: confirmation, cancellation, resends, tax calculation
  success and failure, saved-quote mismatches, and failed verification.
- 45 backend tests covering sales tax and email sending.
- JavaScript syntax, diff, and app cache version checks.
- Desktop and phone browser checks: cancellation sends nothing, confirmation
  sends once, unsaved edits block sending, and saved edits produce matching
  email and quote totals. Taxable invoices remain blocked without an override.

Gmail and QuickBooks were stubbed for local testing; live delivery was not
exercised. The saved-quote check does not lock the document against another
edit arriving between verification and sending. Unusual formatting differences
in saved data may require a reload and save before sending.
