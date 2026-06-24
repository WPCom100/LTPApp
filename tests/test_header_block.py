"""Tests for the customer-facing email {{header}} block.

The {{header}} placeholder renders a branded "action box" at the top of
customer-facing emails (quotes, invoices, payment receipts): a card with
refNumber/projectName/total and a single centered CTA button. It is
generated PER EMAIL TYPE by theme.js::LTP_renderHeader — there is no longer
a single editable header template in Settings, because each type needs its
own button wording:
    quote   -> "View & Accept or Decline"
    invoice -> "View & Download"
    receipt -> "View Receipt"
Crew templates omit {{header}} (crew emails get their own server-rendered
box in backend/routes/crew.py).

What's covered:
  - The shared editable header template is GONE (data/settings.js default +
    Settings UI editor), replaced by the per-type generator.
  - LTP_renderHeader builds the box per kind, substitutes the per-entity
    tokens, and leaves {{viewUrl}} literal for the backend.
  - Per-type CTA labels are wired (theme.js LTP_HEADER_CTA + each modal).
  - All customer templates keep {{header}}; crew templates have none.
  - bleach preserves the generated header structure.
  - Send modals pass headerKind + headerVars and expand {{header}} via
    LTP_renderHeader before POST; EmailBodyEditor consumes headerKind.
  - Backend's per-recipient chain still does NOT substitute {{header}};
    the dead _FALLBACK_HEADER / _render_header mirror is removed.

Header substitution split (why it matters):
  - Frontend pre-expands {{header}} -> rendered HTML (per-entity tokens
    baked in) right before POST.
  - Backend substitutes {{viewUrl}} (per-recipient) + {{signature}}
    (per-sender) only. If a {{header}} leak reaches the backend the
    recipient sees the literal "{{header}}" text — a visible bug, the
    safer failure mode vs. silently shipping literal {{refNumber}}.
"""
import os
import re
import sys

_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _root)

_results = []


def _check(label, ok, detail=""):
    status = "PASS" if ok else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{status}] {label}{suffix}")
    _results.append((label, ok))


# ── Helpers ───────────────────────────────────────────────────────────────


def _read(*parts):
    path = os.path.join(_root, *parts)
    with open(path, encoding="utf-8") as f:
        return f.read()


# Per-type CTA labels — MUST match theme.js::LTP_HEADER_CTA.
_CTA = {
    "quote": "View &amp; Accept or Decline",
    "invoice": "View &amp; Download",
    "receipt": "View Receipt",
}


# Python port of window.LTP_renderHeader (theme.js). Builds the per-type
# action box. {{viewUrl}} is left literal — the backend resolves it
# per-recipient after the body reaches the server. Unknown/empty kinds fall
# back to the quote label so a header never renders an empty button. Invoice
# emails emphasize the financials: a larger reference + total plus a due-date
# line (quotes/receipts keep the standard sizing and have no due date).
def _py_render_header(kind, vars):
    vars = vars or {}
    cta = _CTA.get(kind) or _CTA["quote"]
    invoice = (kind == "invoice")
    ref_px = 14 if invoice else 12
    total_px = 17 if invoice else 14
    total_weight = "font-weight:bold;" if invoice else ""
    has_due = bool(invoice and vars.get("dueDate"))
    total_gap = 2 if has_due else 18
    due_line = (
        '<div style="font-size:14px;color:#233038;margin-bottom:18px">Due '
        + (vars.get("dueDate") or "") + '</div>'
    ) if has_due else ""
    return (
        '<div style="padding:0px">'
        '<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" '
        'style="width:100%;margin-top:5px;background-color:#f7f9fa;border:1px solid #eceef0;border-radius:10px">'
        '<tbody><tr><td style="padding:22px;text-align:center">'
        '<div style="font-size:' + str(ref_px) + 'px;color:#8a949e;text-transform:uppercase;letter-spacing:0.06em">'
        + (vars.get("refNumber", "") or "") + '</div>'
        '<div style="font-size:19px;font-weight:bold;color:#233038;margin:4px 0 2px">'
        + (vars.get("projectName", "") or "") + '</div>'
        '<div style="font-size:' + str(total_px) + 'px;color:#233038;' + total_weight + 'margin-bottom:' + str(total_gap) + 'px">'
        + (vars.get("total", "") or "") + '</div>'
        + due_line
        + '<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:0 auto">'
        '<tbody><tr><td style="background-color:#f15927;border-radius:7px">'
        '<a href="{{viewUrl}}" style="display:inline-block;padding:14px 38px;font-size:15px;'
        'font-weight:bold;color:#ffffff;text-decoration:none">' + cta + '</a>'
        '</td></tr></tbody></table>'
        '</td></tr></tbody></table></div>'
    )


def _extract_body(src, key):
    """Pull the `body: "..."` string out of an emailTemplates.<key>
    object literal. Handles backslash escapes in the JS string."""
    m_key = re.search(rf'\b{key}\s*:\s*\{{', src)
    if not m_key:
        return None
    after = src[m_key.end():]
    m_body = re.search(r'body\s*:\s*"', after)
    if not m_body:
        return None
    start = m_body.end()
    out = []
    i = start
    while i < len(after):
        c = after[i]
        if c == "\\":
            out.append(after[i:i + 2])
            i += 2
            continue
        if c == '"':
            return "".join(out)
        out.append(c)
        i += 1
    return None


_CUSTOMER_TEMPLATES = ("quoteSent", "quoteFollowUp", "invoiceSent",
                       "invoiceReminder", "paymentReceipt")
# crewRequest ALSO carries {{header}}, but it's the SERVER-rendered crew
# accept/decline box (backend/routes/crew.py) — a different path from the
# frontend customer box. The remaining crew templates are plain
# notifications with no header at all.
_CREW_NO_HEADER_TEMPLATES = ("crewConfirmed", "crewCancelled", "crewNotSelected")


# ── Removal of the shared editable header template ─────────────────────────


def test_no_editable_header_template_in_settings():
    """The shared editable header template is removed — each type generates
    its own header. data/settings.js must not define emailHeaderTemplate,
    and the Settings UI must not carry the editor section."""
    print("test_no_editable_header_template_in_settings")
    data = _read("data", "settings.js")
    _check("data/settings.js no longer defines emailHeaderTemplate",
           "emailHeaderTemplate" not in data)
    settings_ui = _read("modules", "settings.js")
    _check("Settings UI 'Email Header Template' editor section removed",
           "Email Header Template" not in settings_ui)
    _check("Settings UI no longer binds draft.emailHeaderTemplate",
           "emailHeaderTemplate" not in settings_ui)


# ── Template bodies ────────────────────────────────────────────────────────


def test_customer_templates_prepend_header():
    """All five customer-facing default templates start with {{header}}."""
    print("test_customer_templates_prepend_header")
    src = _read("data", "settings.js")
    for key in _CUSTOMER_TEMPLATES:
        body = _extract_body(src, key)
        _check(f"{key} body extracted", body is not None,
               f"could not find body: for {key}")
        if body is not None:
            _check(f"{key} body begins with {{{{header}}}}\\n\\n",
                   body.startswith(r"{{header}}\n\n"),
                   f"got: {body[:40]!r}")


def test_crew_header_paths():
    """crewRequest carries {{header}} but it's the SERVER-rendered crew
    accept/decline box (backend/routes/crew.py), NOT the frontend customer
    box. The other crew templates are plain notifications with no header."""
    print("test_crew_header_paths")
    src = _read("data", "settings.js")
    req = _extract_body(src, "crewRequest")
    _check("crewRequest body extracted", req is not None)
    if req is not None:
        _check("crewRequest uses {{header}} (server-rendered crew box)",
               "{{header}}" in req)
    for key in _CREW_NO_HEADER_TEMPLATES:
        body = _extract_body(src, key)
        _check(f"{key} body extracted", body is not None)
        if body is not None:
            _check(f"{key} body has NO {{{{header}}}} placeholder",
                   "{{header}}" not in body)


def test_available_variables_list_includes_header():
    """The Available Variables comment in data/settings.js still documents
    {{header}} (it's a valid body token even though it's now auto-generated
    per type rather than stored as an editable template)."""
    print("test_available_variables_list_includes_header")
    src = _read("data", "settings.js")
    available_block = src.split("// Available:")[1].split("emailTemplates")[0]
    _check("{{header}} listed in Available Variables",
           "{{header}}" in available_block)


# ── LTP_renderHeader: per-type box ─────────────────────────────────────────


def test_render_header_per_type_cta():
    """LTP_renderHeader builds the box with the right CTA per kind, and
    theme.js declares those labels in LTP_HEADER_CTA."""
    print("test_render_header_per_type_cta")
    theme = _read("theme.js")
    _check("theme.js declares LTP_HEADER_CTA", "LTP_HEADER_CTA" in theme)
    for kind, label in _CTA.items():
        _check(f"theme.js carries the {kind} CTA label", label in theme)
    for kind, label in _CTA.items():
        out = _py_render_header(kind, {})
        _check(f"{kind} header renders its CTA label", label in out)
    # Each kind's button is distinct from the others.
    _check("quote != invoice button text",
           _CTA["quote"] not in _py_render_header("invoice", {}))
    # Unknown / empty kind falls back to the quote label (never an empty button).
    _check("unknown kind falls back to the quote CTA",
           _CTA["quote"] in _py_render_header("nope", {}))
    _check("empty kind falls back to the quote CTA",
           _CTA["quote"] in _py_render_header("", {}))


def test_render_header_substitutes_per_entity_tokens_only():
    """The header bakes in refNumber/projectName/total but leaves
    {{viewUrl}} literal so the backend resolves it per-recipient."""
    print("test_render_header_substitutes_per_entity_tokens_only")
    out = _py_render_header("quote", {
        "refNumber": "QT-2026-007",
        "projectName": "Spring Showcase",
        "total": "$1,234.00",
    })
    _check("real refNumber present", "QT-2026-007" in out)
    _check("real projectName present", "Spring Showcase" in out)
    _check("real total present", "$1,234.00" in out)
    _check("no {{refNumber}} left", "{{refNumber}}" not in out)
    _check("no {{projectName}} left", "{{projectName}}" not in out)
    _check("no {{total}} left", "{{total}}" not in out)
    _check("{{viewUrl}} stays literal — backend resolves it per-recipient",
           'href="{{viewUrl}}"' in out,
           "the View button must arrive with {{viewUrl}} intact")


def test_render_header_ignores_viewUrl_var():
    """Defensive: even if a caller passes a viewUrl in vars, the function
    MUST NOT substitute it. Backend is the single source of per-recipient
    URLs."""
    print("test_render_header_ignores_viewUrl_var")
    out = _py_render_header("quote", {"viewUrl": "https://attacker.example/"})
    _check("attacker-controlled viewUrl is NOT substituted",
           "https://attacker.example/" not in out)
    _check("{{viewUrl}} still literal in output",
           'href="{{viewUrl}}"' in out)


def test_invoice_header_due_date_and_larger_fonts():
    """Invoice emails get a due-date line plus a larger reference + total;
    quotes and receipts keep the standard sizing and have no due date."""
    print("test_invoice_header_due_date_and_larger_fonts")
    v = {"refNumber": "INV-2026-014", "projectName": "Spring Showcase",
         "total": "$1,234.00", "dueDate": "July 1st, 2026"}
    inv = _py_render_header("invoice", v)
    _check("invoice reference is larger (14px)",
           "font-size:14px;color:#8a949e" in inv)
    _check("invoice total is larger + bold (17px)",
           "font-size:17px;color:#233038;font-weight:bold;" in inv)
    _check("invoice shows the due-date line",
           ">Due July 1st, 2026</div>" in inv)
    # Quotes/receipts are untouched even if a dueDate is (wrongly) passed.
    for kind in ("quote", "receipt"):
        out = _py_render_header(kind, v)
        _check(f"{kind} reference stays 12px",
               "font-size:12px;color:#8a949e" in out)
        _check(f"{kind} total stays 14px, not bold",
               "font-size:14px;color:#233038;margin-bottom:18px" in out)
        _check(f"{kind} has NO due-date line", ">Due " not in out)
    # Invoice with no due date set: larger sizes still apply, line omitted.
    no_due = _py_render_header("invoice", {"refNumber": "INV-1", "total": "$5.00"})
    _check("invoice w/o due date keeps the larger sizes",
           "font-size:14px;color:#8a949e" in no_due and "font-size:17px" in no_due)
    _check("invoice w/o due date omits the due-date line", ">Due " not in no_due)
    # Source-level: the variant is gated to kind === "invoice" in theme.js.
    theme = _read("theme.js")
    _check('theme.js gates the invoice variant on kind === "invoice"',
           'kind === "invoice"' in theme)
    _check("theme.js renders a 'Due ' line for invoices", ">Due " in theme)


# ── Sanitizer allowlists ──────────────────────────────────────────────────


def test_bleach_preserves_header_structure():
    """The header box (rounded border + centered button) must survive the
    backend bleach allowlist + CSS sanitizer, with {{viewUrl}} and the
    structural pieces preserved for downstream substitution."""
    print("test_bleach_preserves_header_structure")
    from backend.sanitize import email_html
    out = email_html(_py_render_header("quote", {}))
    for needle in (
        'role="presentation"',          # accessibility for table layout
        'href="{{viewUrl}}"',           # backend resolves this per-recipient
        'background-color:#f15927',     # brand orange on the centered button
        'border-radius:10px',           # the CTA box/card
        '<table',                       # outer box + inner button
        'cellspacing="0"',              # table layout reset
        'cellpadding="0"',
        '&amp;',                        # ampersand entity in the quote button
    ):
        _check(f"bleach keeps {needle!r}", needle in out)
    _check("idempotent: re-sanitize == sanitize (no further mutation)",
           email_html(out) == out)


def test_bleach_strips_disallowed_attrs_from_header():
    """role + width are in the allowlist but risky handlers (onclick,
    onload, onerror) must still be stripped."""
    print("test_bleach_strips_disallowed_attrs_from_header")
    from backend.sanitize import email_html
    src = '<div onclick="alert(1)" style="padding:0px"><table role="presentation" onload="x()">foo</table></div>'
    out = email_html(src)
    _check("onclick stripped", "onclick" not in out)
    _check("onload stripped", "onload" not in out)
    _check("role kept", 'role="presentation"' in out)
    _check("style kept", 'padding:0px' in out)


def test_frontend_sanitizer_allowlist_pinned():
    """DOMPurify EMAIL_ALLOWED_TAGS + EMAIL_ALLOWED_ATTR must keep
    section (the marker wrapper) + role (header table). The frontend
    sanitizer runs before innerHTML write in the editor."""
    print("test_frontend_sanitizer_allowlist_pinned")
    src = _read("components", "sanitize.js")
    _check("EMAIL_ALLOWED_TAGS includes 'section'",
           '"section"' in src and "EMAIL_ALLOWED_TAGS" in src)
    _check("EMAIL_ALLOWED_ATTR includes 'role'",
           '"role"' in src.split("EMAIL_ALLOWED_ATTR")[1].split("EMAIL_CONFIG")[0])


# ── Total formatting ──────────────────────────────────────────────────────


def test_total_renders_with_cents_in_all_three_modals():
    """{{total}} must always render with two decimal places (e.g.
    $197.00, $0.00). Three call sites: quotes-builder.js openQuoteSendModal,
    invoices.js openSendModal, invoices.js openReceiptModal."""
    print("test_total_renders_with_cents_in_all_three_modals")
    qb = _read("modules", "quotes-builder.js")
    inv = _read("modules", "invoices.js")
    qb_matches = qb.count('minimumFractionDigits: 2')
    inv_matches = inv.count('minimumFractionDigits: 2')
    _check("quotes-builder uses minimumFractionDigits: 2",
           qb_matches >= 1, f"got {qb_matches} matches")
    _check("invoices uses minimumFractionDigits: 2 in BOTH send + receipt",
           inv_matches >= 2, f"got {inv_matches} matches")
    email_total_blocks = re.findall(
        r'total:\s*"\$"\s*\+\s*Math\.round\(\w+\.total\)\.toLocaleString\(([^)]*)\)',
        qb + inv,
    )
    cents_blocks = [a for a in email_total_blocks if "minimumFractionDigits" in a]
    _check("every email-substitution `total:` uses minimumFractionDigits",
           len(cents_blocks) == len(email_total_blocks),
           f"found {len(email_total_blocks)} total: lines, "
           f"{len(cents_blocks)} have cents config")


def test_settings_email_templates_available_variables_matches_canonical():
    """The Email Templates section's "Available Variables" chip row in
    modules/settings.js must list every placeholder documented in
    data/settings.js's `// Available:` comment block (the canonical list)."""
    print("test_settings_email_templates_available_variables_matches_canonical")
    canonical_src = _read("data", "settings.js")
    # Scope to the `// Available:` list ONLY — the comment lines up to the
    # blank "//" separator. Splitting on "emailTemplates" would over-capture
    # the prose comments below (e.g. the {{shifts}} mention in the {{header}}
    # note), polluting the canonical set with tokens that aren't body vars.
    m_avail = re.search(r'// Available:(.*?)\n\s*//\s*\n', canonical_src, re.DOTALL)
    available_block = m_avail.group(1) if m_avail else ""
    canonical_tokens = set(re.findall(r"\{\{(\w+)\}\}", available_block))

    settings_src = _read("modules", "settings.js")
    chip_rows = re.findall(
        r'\[((?:"\w+",?\s*)+)\]\.map\(function\(v\)\s*\{[\s\S]*?"\{\{"\s*\+\s*v',
        settings_src,
    )
    master = next((r for r in chip_rows if "companyName" in r), None)
    _check("Email Templates chip-row array found", master is not None)
    if master:
        ui_tokens = set(re.findall(r'"(\w+)"', master))
        missing = canonical_tokens - ui_tokens
        _check("every canonical token has a UI chip", not missing,
               f"missing from Settings UI: {sorted(missing)}")
        extra = ui_tokens - canonical_tokens
        _check("no UI chips beyond the canonical list", not extra,
               f"in UI but not in data/settings.js Available: comment: {sorted(extra)}")


# ── Editor + send-modal wiring ────────────────────────────────────────────


def test_send_modals_wire_header():
    """Each send modal expands {{header}} for its own type and passes
    headerKind + headerVars to EmailBodyEditor."""
    print("test_send_modals_wire_header")
    qb = _read("modules", "quotes-builder.js")
    _check("quotes-builder declares sendHeaderVars state",
           "sendHeaderVars" in qb and "setSendHeaderVars" in qb)
    _check("quotes-builder expands {{header}} as a quote",
           'LTP_renderHeader("quote"' in qb)
    _check('quotes-builder passes headerKind: "quote" to the editor',
           'headerKind: "quote"' in qb)
    _check("quotes-builder builds bodyWithHeader before POST",
           "bodyWithHeader" in qb)

    inv = _read("modules", "invoices.js")
    _check("invoices declares sendHeaderVars state",
           "sendHeaderVars" in inv and "setSendHeaderVars" in inv)
    _check("invoices expands the invoice header",
           'LTP_renderHeader("invoice"' in inv)
    _check("invoices expands the receipt header",
           'LTP_renderHeader("receipt"' in inv)
    _check('invoices passes headerKind: "invoice" (send modal)',
           'headerKind: "invoice"' in inv)
    _check('invoices passes headerKind: "receipt" (receipt modal)',
           'headerKind: "receipt"' in inv)
    _check("invoices builds bodyWithHeader in both paths",
           inv.count("bodyWithHeader") >= 2)
    _check("no modal references the removed emailHeaderTemplate",
           "emailHeaderTemplate" not in qb and "emailHeaderTemplate" not in inv)


def test_email_body_editor_consumes_header_kind():
    """EmailBodyEditor accepts headerKind (not the removed headerTemplate)
    and forwards it to LTP_bodyToEditableHtml so the non-editable header
    block renders with the right CTA in the editor preview."""
    print("test_email_body_editor_consumes_header_kind")
    src = _read("components", "email-body-editor.js")
    _check("reads props.headerKind", "headerKind" in src)
    _check("no stale headerTemplate prop", "headerTemplate" not in src)
    _check("passes headerKind to LTP_bodyToEditableHtml",
           "LTP_bodyToEditableHtml(" in src and "headerKind" in src)
    _check("marks .ltp-header-block non-editable via querySelector",
           "ltp-header-block" in src)


# ── Backend ───────────────────────────────────────────────────────────────


def test_backend_send_does_not_substitute_header_token():
    """Architecture invariant: backend's per-recipient substitution chain
    handles viewUrl + signature only. {{header}} expansion is done by the
    FRONTEND just before POST so the per-entity tokens inside it get baked
    in by the same vars resolution that handles the outer body."""
    print("test_backend_send_does_not_substitute_header_token")
    src = _read("backend", "routes", "email.py")
    send_body = src.split("@email_router.post")[1]
    _check("backend send chain still replaces {{viewUrl}}",
           '.replace("{{viewUrl}}",' in send_body)
    _check("backend send chain still replaces {{signature}}",
           '.replace("{{signature}}",' in send_body)
    _check("backend send chain does NOT replace {{header}}",
           '.replace("{{header}}",' not in send_body,
           "frontend pre-expands per-entity tokens; backend MUST NOT "
           "blanket-substitute {{header}} or per-entity tokens leak")


def test_backend_no_longer_has_header_fallback():
    """The header is frontend-generated per type now; the backend no longer
    keeps a _FALLBACK_HEADER / _render_header mirror, and api.py no longer
    special-cases emailHeaderTemplate at settings-save time."""
    print("test_backend_no_longer_has_header_fallback")
    email_src = _read("backend", "routes", "email.py")
    _check("_FALLBACK_HEADER removed", "_FALLBACK_HEADER" not in email_src)
    _check("_render_header removed", "_render_header" not in email_src)
    api_src = _read("backend", "routes", "api.py")
    _check("api.py no longer sanitizes emailHeaderTemplate",
           "emailHeaderTemplate" not in api_src)


def test_text_to_html_block_detect_re_includes_section():
    """The marker wrapper is <section>. textToHtml's block detection must
    include <section> so a body that already has the WYSIWYG-rendered
    section block passes through unchanged instead of being paragraph-wrapped."""
    print("test_text_to_html_block_detect_re_includes_section")
    src = _read("theme.js")
    m = re.search(r'BLOCK_DETECT_RE\s*=\s*(.{,200})', src)
    _check("BLOCK_DETECT_RE found in theme.js", m is not None)
    if m:
        window = m.group(1)
        _check("BLOCK_DETECT_RE alternation includes 'section'",
               "section" in window)


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    test_no_editable_header_template_in_settings()
    test_customer_templates_prepend_header()
    test_crew_header_paths()
    test_available_variables_list_includes_header()
    test_render_header_per_type_cta()
    test_render_header_substitutes_per_entity_tokens_only()
    test_render_header_ignores_viewUrl_var()
    test_invoice_header_due_date_and_larger_fonts()
    test_bleach_preserves_header_structure()
    test_bleach_strips_disallowed_attrs_from_header()
    test_frontend_sanitizer_allowlist_pinned()
    test_total_renders_with_cents_in_all_three_modals()
    test_settings_email_templates_available_variables_matches_canonical()
    test_send_modals_wire_header()
    test_email_body_editor_consumes_header_kind()
    test_backend_send_does_not_substitute_header_token()
    test_backend_no_longer_has_header_fallback()
    test_text_to_html_block_detect_re_includes_section()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
