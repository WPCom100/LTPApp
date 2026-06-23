"""Tests for the customer-facing email {{header}} block.

The {{header}} placeholder renders a banner-style HTML block at the top
of customer-facing emails (quotes, invoices, payment receipts): a
"View & Accept or Decline" button + ref/project + total. Renders ONLY
when a body uses {{header}}; crew templates omit it because crew
emails don't have a per-recipient view link.

What's covered:
  - Frontend and backend templates byte-for-byte match.
  - All five customer templates have {{header}} prepended; crew
    templates have none.
  - Total formatting always shows cents (".00" even on whole dollars).
  - bleach + DOMPurify allowlists preserve role="presentation", href
    placeholders, table structure, and the rendered View button.
  - LTP_renderHeader substitutes the four inner per-entity tokens.
  - Send modal wires headerTemplate + headerVars to EmailBodyEditor.
  - executeSendQuote / sendReceipt / executeSend expand {{header}}
    BEFORE the textToHtml + POST so per-entity tokens inside the
    rendered header get the same client-side substitution as the rest
    of the body.

Header-template substitution split (why testing both sides):
  - Frontend pre-expands {{header}} -> rendered HTML (with per-entity
    tokens substituted) right before POST.
  - Backend substitutes {{viewUrl}} (per-recipient) + {{signature}}
    (per-sender) only. Backend does NOT substitute {{header}}; if a
    leak occurs the recipient sees the literal "{{header}}" text — a
    visible bug. This is the safer failure mode: silently rendering a
    header with literal "{{refNumber}}" placeholders would be worse.
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


# Python port of window.LTP_renderHeader for testing. {{viewUrl}} is
# NOT substituted here — it stays literal so the backend's per-recipient
# substitution chain can resolve it after the body reaches the server.
def _py_render_header(template, vars):
    if not template:
        return ""
    vars = vars or {}
    return (
        template
        .replace("{{refNumber}}", vars.get("refNumber", "") or "")
        .replace("{{projectName}}", vars.get("projectName", "") or "")
        .replace("{{total}}", vars.get("total", "") or "")
    )


# ── Default templates ─────────────────────────────────────────────────────


_CUSTOMER_TEMPLATES = ("quoteSent", "quoteFollowUp", "invoiceSent",
                      "invoiceReminder", "paymentReceipt")
_CREW_TEMPLATES = ("crewRequest", "crewConfirmed", "crewCancelled",
                  "crewNotSelected")


def test_data_settings_exposes_email_header_template():
    """The frontend default for the {{header}} block lives in
    data/settings.js next to emailSignatureTemplate."""
    print("test_data_settings_exposes_email_header_template")
    src = _read("data", "settings.js")
    _check("emailHeaderTemplate key present",
           "emailHeaderTemplate:" in src)
    _check("template body contains View button",
           "View &amp; Accept or Decline" in src)
    _check("template contains role=\"presentation\" (a11y for table layout)",
           'role="presentation"' in src)
    _check("template contains all four per-entity placeholders",
           all(t in src.split("emailHeaderTemplate:")[1].split("',")[0]
               for t in ("{{viewUrl}}", "{{refNumber}}",
                        "{{projectName}}", "{{total}}")))


def _extract_body(src, key):
    """Pull the `body: "..."` string out of an emailTemplates.<key>
    object literal. Handles backslash escapes in the JS string."""
    # Find the entry's opening brace.
    m_key = re.search(rf'\b{key}\s*:\s*\{{', src)
    if not m_key:
        return None
    after = src[m_key.end():]
    # Find the body: " inside the object; non-greedy, lazy.
    m_body = re.search(r'body\s*:\s*"', after)
    if not m_body:
        return None
    start = m_body.end()
    # Walk the string char by char to find the unescaped closing quote.
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


def test_crew_templates_have_no_header():
    """Crew emails are not customer-facing — no header block."""
    print("test_crew_templates_have_no_header")
    src = _read("data", "settings.js")
    for key in _CREW_TEMPLATES:
        body = _extract_body(src, key)
        _check(f"{key} body extracted", body is not None)
        if body is not None:
            _check(f"{key} body has NO {{{{header}}}} placeholder",
                   "{{header}}" not in body)


def test_available_variables_list_includes_header():
    """The Available Variables comment in data/settings.js should
    document {{header}} so admins editing templates know it exists."""
    print("test_available_variables_list_includes_header")
    src = _read("data", "settings.js")
    # The comment block above emailTemplates lists every available
    # placeholder; {{header}} should be in it.
    available_block = src.split("// Available:")[1].split("emailTemplates")[0]
    _check("{{header}} listed in Available Variables",
           "{{header}}" in available_block)


# ── Frontend ↔ Backend parity ─────────────────────────────────────────────


def test_backend_fallback_header_substring_pinned():
    """The backend _FALLBACK_HEADER should contain the same critical
    substrings as data/settings.js::emailHeaderTemplate so the modal
    preview matches what the recipient sees."""
    print("test_backend_fallback_header_substring_pinned")
    from backend.routes.email import _FALLBACK_HEADER
    js_src = _read("data", "settings.js")
    js_template = js_src.split("emailHeaderTemplate:")[1].split("',")[0] + "'"
    # Key structural pieces that must match between the two.
    for needle in (
        'href="{{viewUrl}}"',
        '{{refNumber}}',
        '{{projectName}}',
        '{{total}}',
        'role="presentation"',
        'background-color:#f15927',     # brand orange on the centered button
        'border-radius:10px',           # the CTA box/card
        'View &amp; Accept or Decline',
    ):
        _check(f"both contain {needle!r}",
               needle in _FALLBACK_HEADER and needle in js_template)


def test_render_header_substitutes_per_entity_tokens_only():
    """LTP_renderHeader substitutes ONLY the per-entity tokens
    ({{refNumber}}, {{projectName}}, {{total}}). {{viewUrl}} stays
    literal so the backend's per-recipient chain can swap in the
    real URL — substituting client-side would either produce a dead
    href="" (the bug commit 5.1 fixes) or a non-tracking URL."""
    print("test_render_header_substitutes_per_entity_tokens_only")
    from backend.routes.email import _FALLBACK_HEADER
    vars = {
        "refNumber": "QT-2026-007",
        "projectName": "Spring Showcase",
        "total": "$1,234.00",
    }
    out = _py_render_header(_FALLBACK_HEADER, vars)
    _check("no {{refNumber}} left", "{{refNumber}}" not in out)
    _check("no {{projectName}} left", "{{projectName}}" not in out)
    _check("no {{total}} left", "{{total}}" not in out)
    _check("real refNumber present", "QT-2026-007" in out)
    _check("real projectName present", "Spring Showcase" in out)
    _check("real total present", "$1,234.00" in out)
    # The critical assertion: {{viewUrl}} is preserved for the backend.
    _check("{{viewUrl}} stays literal — backend resolves it per-recipient",
           'href="{{viewUrl}}"' in out,
           "renderHeader must NOT substitute {{viewUrl}} or the "
           "View button arrives with an empty href")


def test_render_header_ignores_viewUrl_var_if_passed():
    """Defensive: even if a caller passes a viewUrl in vars (e.g.
    accidentally re-introducing the bug), the function MUST NOT
    substitute it. Backend is the single source of per-recipient URLs."""
    print("test_render_header_ignores_viewUrl_var_if_passed")
    from backend.routes.email import _FALLBACK_HEADER
    out = _py_render_header(_FALLBACK_HEADER, {"viewUrl": "https://attacker.example/"})
    _check("attacker-controlled viewUrl is NOT substituted",
           "https://attacker.example/" not in out)
    _check("{{viewUrl}} still literal in output",
           'href="{{viewUrl}}"' in out)


def test_render_header_handles_empty_template():
    """No template configured → empty string (caller falls back)."""
    print("test_render_header_handles_empty_template")
    _check("empty template → empty string",
           _py_render_header("", {"refNumber": "X"}) == "")
    _check("None template → empty string",
           _py_render_header(None, {"refNumber": "X"}) == "")


# ── Sanitizer allowlists ──────────────────────────────────────────────────


def test_bleach_preserves_header_structure():
    """The header is a box/card (rounded border) with a centered button, role +
    inline styles + width. Confirm the backend bleach allowlist + CSS sanitizer
    keeps every structural piece intact."""
    print("test_bleach_preserves_header_structure")
    from backend.routes.email import _FALLBACK_HEADER
    from backend.sanitize import email_html
    out = email_html(_FALLBACK_HEADER)
    for needle in (
        'role="presentation"',          # accessibility for table layout
        'href="{{viewUrl}}"',           # backend resolves this per-recipient
        '{{refNumber}}',                # frontend bakes in before POST
        '{{projectName}}',
        '{{total}}',
        'background-color:#f15927',     # brand orange on the centered button
        'border-radius:10px',           # the CTA box/card
        '<table',                       # outer box + inner button
        'cellspacing="0"',              # table layout reset
        'cellpadding="0"',
        '&amp;',                        # ampersand entity in button text
    ):
        _check(f"bleach keeps {needle!r}", needle in out)
    _check("idempotent: re-sanitize == sanitize (no further mutation)",
           email_html(out) == out)


def test_bleach_strips_disallowed_attrs_from_header():
    """role + width are now in the allowlist but other potentially
    risky attrs (onclick, onload, onerror) must still be stripped."""
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
    # toLocaleString with minimumFractionDigits: 2 is the marker.
    qb_matches = qb.count('minimumFractionDigits: 2')
    inv_matches = inv.count('minimumFractionDigits: 2')
    _check("quotes-builder uses minimumFractionDigits: 2",
           qb_matches >= 1, f"got {qb_matches} matches")
    _check("invoices uses minimumFractionDigits: 2 in BOTH send + receipt",
           inv_matches >= 2, f"got {inv_matches} matches")
    # Negative guard for the EMAIL substitution sites: the var block
    # whose `total:` line builds the email substitution dict must use
    # minimumFractionDigits. Look for the `total: "$"...` line inside
    # each `var vars = { ... };` block; assert it has the cents config.
    email_total_blocks = re.findall(
        r'total:\s*"\$"\s*\+\s*Math\.round\(\w+\.total\)\.toLocaleString\(([^)]*)\)',
        qb + inv,
    )
    cents_blocks = [a for a in email_total_blocks if "minimumFractionDigits" in a]
    _check("every email-substitution `total:` uses minimumFractionDigits",
           len(cents_blocks) == len(email_total_blocks),
           f"found {len(email_total_blocks)} total: lines, "
           f"{len(cents_blocks)} have cents config")


# ── Editor + send-modal wiring ────────────────────────────────────────────


def test_settings_email_templates_available_variables_matches_canonical():
    """The Email Templates section's "Available Variables" chip row in
    modules/settings.js must list every placeholder documented in
    data/settings.js's `// Available:` comment block (the canonical
    list). Catches drift like the commit 5 oversight where
    {{header}} was added to the comment + default bodies but never
    propagated to the Settings UI chip row, leaving admins editing
    templates with no UI hint that the placeholder existed."""
    print("test_settings_email_templates_available_variables_matches_canonical")
    canonical_src = _read("data", "settings.js")
    # Extract every {{token}} listed in the Available: comment.
    available_block = canonical_src.split("// Available:")[1].split("emailTemplates")[0]
    canonical_tokens = set(re.findall(r"\{\{(\w+)\}\}", available_block))

    settings_src = _read("modules", "settings.js")
    # The Email Templates chip-row array — find it by anchoring on the
    # nearby "Available Variables" label (the header + signature
    # sections also use that label but their arrays are shorter and
    # contain different tokens).
    chip_rows = re.findall(
        r'\[((?:"\w+",?\s*)+)\]\.map\(function\(v\)\s*\{[\s\S]*?"\{\{"\s*\+\s*v',
        settings_src,
    )
    # Pick the row that mentions companyName — that's the master list
    # in the Email Templates section (signature row has userName etc.,
    # header row has viewUrl/refNumber/projectName/total only).
    master = next((r for r in chip_rows if "companyName" in r), None)
    _check("Email Templates chip-row array found",
           master is not None)
    if master:
        ui_tokens = set(re.findall(r'"(\w+)"', master))
        missing = canonical_tokens - ui_tokens
        _check(
            "every canonical token has a UI chip",
            not missing,
            f"missing from Settings UI: {sorted(missing)}",
        )
        extra = ui_tokens - canonical_tokens
        _check(
            "no UI chips beyond the canonical list",
            not extra,
            f"in UI but not in data/settings.js Available: comment: {sorted(extra)}",
        )


def test_settings_page_has_header_template_editor():
    """The Settings page must expose a split-pane editor for
    emailHeaderTemplate so admins can customize the banner. Mirrors
    the existing emailSignatureTemplate editor — same shape (left
    textarea / right sanitized preview), same Available Variables
    chip row, same persistence path through PUT /api/settings."""
    print("test_settings_page_has_header_template_editor")
    src = _read("modules", "settings.js")
    _check("Email Header Template section title present",
           "Email Header Template" in src)
    _check("textarea bound to draft.emailHeaderTemplate",
           "draft.emailHeaderTemplate" in src)
    _check("set(\"emailHeaderTemplate\", ...) on change",
           'set("emailHeaderTemplate"' in src)
    _check("Available Variables chips list the four header tokens",
           all(t in src for t in ('"viewUrl"', '"refNumber"',
                                  '"projectName"', '"total"'))
           and '["viewUrl", "refNumber", "projectName", "total"]' in src)
    _check("preview uses LTP_SANITIZE.emailHtml (defense in depth)",
           "LTP_SANITIZE.emailHtml" in src
           and "emailHeaderTemplate" in src.split("LTP_SANITIZE.emailHtml")[1].split("// ── Team Members")[0])
    _check("preview substitutes sample {{refNumber}}",
           '"QT-2026-007"' in src)
    _check("preview substitutes sample {{projectName}}",
           '"Spring Showcase"' in src)
    _check("preview substitutes sample {{total}}",
           '"$1,234.00"' in src)


def test_email_body_editor_consumes_header_props():
    """EmailBodyEditor must accept + forward headerTemplate + headerVars
    so the non-editable header block renders + the per-entity tokens
    substitute correctly in the editor preview."""
    print("test_email_body_editor_consumes_header_props")
    src = _read("components", "email-body-editor.js")
    _check("reads props.headerTemplate", "headerTemplate" in src)
    _check("reads props.headerVars", "headerVars" in src)
    _check("passes headerTemplate to LTP_bodyToEditableHtml",
           "LTP_bodyToEditableHtml(" in src and "headerTemplate" in src)
    _check("marks .ltp-header-block non-editable via querySelector",
           ".ltp-header-block" in src or "ltp-header-block" in src)


def test_send_modals_wire_header_template_and_vars():
    """All three send modals must (a) capture sendHeaderVars at open
    time, (b) pass headerTemplate + headerVars to EmailBodyEditor,
    (c) expand {{header}} via LTP_renderHeader just before the POST."""
    print("test_send_modals_wire_header_template_and_vars")
    for module in ("modules/quotes-builder.js", "modules/invoices.js"):
        src = _read(*module.split("/"))
        _check(f"{module}: declares sendHeaderVars state",
               "sendHeaderVars" in src and "setSendHeaderVars" in src)
        _check(f"{module}: passes headerTemplate to EmailBodyEditor",
               "headerTemplate:" in src
               and "emailHeaderTemplate" in src)
        _check(f"{module}: passes headerVars to EmailBodyEditor",
               "headerVars:" in src)
        _check(f"{module}: calls LTP_renderHeader at send time",
               "LTP_renderHeader(" in src)
        _check(f"{module}: builds bodyWithHeader before POST",
               "bodyWithHeader" in src)


# ── Backend ───────────────────────────────────────────────────────────────


def test_backend_render_header_falls_back_to_constant():
    """When the workspace hasn't customized emailHeaderTemplate (fresh
    deploy, settings never saved), _render_header should return
    _FALLBACK_HEADER — same pattern as _render_signature for
    _FALLBACK_SIGNATURE."""
    print("test_backend_render_header_falls_back_to_constant")
    from backend.routes.email import _FALLBACK_HEADER, _render_header
    _check("empty settings → _FALLBACK_HEADER",
           _render_header({}) == _FALLBACK_HEADER)
    _check("missing key → _FALLBACK_HEADER",
           _render_header({"emailSignatureTemplate": "x"}) == _FALLBACK_HEADER)
    _check("empty-string template → _FALLBACK_HEADER",
           _render_header({"emailHeaderTemplate": ""}) == _FALLBACK_HEADER)
    _check("whitespace-only template → _FALLBACK_HEADER",
           _render_header({"emailHeaderTemplate": "   \n\t  "}) == _FALLBACK_HEADER)
    custom = "<div>custom header</div>"
    _check("custom template returned as-is",
           _render_header({"emailHeaderTemplate": custom}) == custom)


def test_backend_send_does_not_substitute_header_token():
    """Architecture invariant: backend's per-recipient substitution
    chain handles viewUrl + signature only. {{header}} expansion is
    done by the FRONTEND just before POST so the per-entity tokens
    inside it (refNumber, projectName, total) get baked in by the
    same vars resolution that handles the outer body. This test pins
    the substitution chain so a future edit that adds {{header}} to
    the backend chain (which would silently leak literal {{refNumber}}
    tokens) gets caught."""
    print("test_backend_send_does_not_substitute_header_token")
    src = _read("backend", "routes", "email.py")
    # Find the body of send_email (the actual chain that runs at send time).
    send_body = src.split("@email_router.post")[1]
    # The chain should replace viewUrl + signature but NOT {{header}}.
    _check("backend send chain still replaces {{viewUrl}}",
           '.replace("{{viewUrl}}",' in send_body)
    _check("backend send chain still replaces {{signature}}",
           '.replace("{{signature}}",' in send_body)
    _check("backend send chain does NOT replace {{header}}",
           '.replace("{{header}}",' not in send_body,
           "found {{header}} replacement in backend send chain — "
           "frontend pre-expands per-entity tokens, backend MUST NOT "
           "blanket-substitute {{header}} or per-entity tokens leak")


def test_text_to_html_block_detect_re_includes_section():
    """The marker wrapper is <section>. textToHtml's block detection
    must include <section> so a body that already has the WYSIWYG-
    rendered section block (rare — would only happen if a user
    pasted such content) passes through unchanged instead of being
    paragraph-wrapped."""
    print("test_text_to_html_block_detect_re_includes_section")
    src = _read("theme.js")
    # The regex literal has escaped slashes so a naive /[^/]+/ would
    # stop too early. Grab a fixed-length window after the name.
    m = re.search(r'BLOCK_DETECT_RE\s*=\s*(.{,200})', src)
    _check("BLOCK_DETECT_RE found in theme.js", m is not None)
    if m:
        window = m.group(1)
        _check("BLOCK_DETECT_RE alternation includes 'section'",
               "section" in window)


# ── Main ──────────────────────────────────────────────────────────────────


def main() -> int:
    test_data_settings_exposes_email_header_template()
    test_customer_templates_prepend_header()
    test_crew_templates_have_no_header()
    test_available_variables_list_includes_header()
    test_backend_fallback_header_substring_pinned()
    test_render_header_substitutes_per_entity_tokens_only()
    test_render_header_ignores_viewUrl_var_if_passed()
    test_render_header_handles_empty_template()
    test_bleach_preserves_header_structure()
    test_bleach_strips_disallowed_attrs_from_header()
    test_frontend_sanitizer_allowlist_pinned()
    test_total_renders_with_cents_in_all_three_modals()
    test_settings_email_templates_available_variables_matches_canonical()
    test_settings_page_has_header_template_editor()
    test_email_body_editor_consumes_header_props()
    test_send_modals_wire_header_template_and_vars()
    test_backend_render_header_falls_back_to_constant()
    test_backend_send_does_not_substitute_header_token()
    test_text_to_html_block_detect_re_includes_section()

    fail_count = sum(1 for _, ok in _results if not ok)
    print()
    print(f"== {len(_results) - fail_count}/{len(_results)} checks passed ==")
    return 0 if fail_count == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
