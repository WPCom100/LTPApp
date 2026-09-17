"""CI guard: no in-app navigation may follow a queued goBack().

`goBack()` (router.js) calls `history.back()` when this session created the
previous entry. That traversal is ASYNCHRONOUS and targets the entry captured
when it was called. Any navigation issued after it in the same handler is
therefore undone: the push lands, then the traversal fires and walks back past
it, dropping the user somewhere upstream.

That is a silent, plausible-looking pattern — "close the modal, then go to the
record" — and it shipped: clicking a quote or invoice inside a project's detail
modal called `ctx.setSelectedProjectId(null)` (which is now goBack) and then
navigated, so the user landed on the projects list instead of the document.

Nothing else can see it. The JS suites render components rather than driving a
history stack, and a browser test only covers the handlers someone thought to
click. So this reads the source instead.

The rule: a handler that leaves a URL-bound modal for somewhere else should
just navigate. The modal is derived from the route, so changing the route
already closes it.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCAN_DIRS = ("modules", "components")

# Setters that resolve to goBack() when handed a falsy id.
CLOSERS = (
    "setSelectedProjectId",
    "setSelectedCompanyId",
    "setEditContactId",
    "setEditCompanyId",
    "setEditProjectId",
)
# A close, then anything that changes the route, in one statement sequence.
NAV_AFTER_CLOSE = re.compile(
    r"\b(?:%s)\(\s*(?:null|undefined|0|false)\s*\)\s*;\s*"
    r"(?:[A-Za-z_$][\w$]*\.)?(?:localNav|nav|navigate|goBack|set(?:%s))\s*\("
    % ("|".join(CLOSERS), "|".join(c[3:] for c in CLOSERS))
)
# Two goBack-capable closes back to back — two queued traversals, one intent.
DOUBLE_BACK = re.compile(r"goBack\(\)\s*;\s*(?:[A-Za-z_$][\w$]*\.)?goBack\(")


def _sources():
    for d in SCAN_DIRS:
        base = os.path.join(ROOT, d)
        for name in sorted(os.listdir(base)):
            if name.endswith(".js"):
                path = os.path.join(base, name)
                with open(path, encoding="utf-8") as fh:
                    yield os.path.join(d, name), fh.read()


def _hits(pattern):
    out = []
    for rel, src in _sources():
        for m in pattern.finditer(src):
            out.append("%s:%d  %s" % (rel, src.count("\n", 0, m.start()) + 1,
                                      m.group(0).strip()[:90]))
    return out


def test_no_navigation_after_a_queued_goback():
    hits = _hits(NAV_AFTER_CLOSE)
    assert not hits, (
        "these close a URL-bound modal and then navigate; the queued "
        "history.back() undoes the navigation and strands the user upstream. "
        "Drop the close — changing the route already unmounts the modal:\n  "
        + "\n  ".join(hits)
    )


def test_no_two_gobacks_in_one_handler():
    hits = _hits(DOUBLE_BACK)
    assert not hits, (
        "two queued history traversals for one user action walks back twice:\n  "
        + "\n  ".join(hits)
    )


def test_project_tab_urls_cover_every_tab_the_modal_renders():
    """#/projects/:id/<tab> must reach the tab it names.

    modules/projects.js whitelists which URL segments are project tabs; anything
    outside it falls back to Overview without a word. That list silently drifted
    behind the tabs CRMProjectDetail renders, so #/projects/:id/invoices opened
    Overview instead.
    """
    with open(os.path.join(ROOT, "modules", "projects.js"), encoding="utf-8") as fh:
        whitelist = re.search(r"var PROJECT_TABS = \{([^}]*)\}", fh.read())
    assert whitelist, "PROJECT_TABS not found in modules/projects.js"
    allowed = set(re.findall(r"(\w+)\s*:", whitelist.group(1)))

    with open(os.path.join(ROOT, "modules", "crm-projects.js"), encoding="utf-8") as fh:
        body = fh.read()
    tabs_call = re.search(r"LTPTabs, \{ tabs: \[(.*?)\], active:", body, re.S)
    assert tabs_call, "could not find the LTPTabs list in modules/crm-projects.js"
    rendered = set(re.findall(r'id: "(\w+)"', tabs_call.group(1)))

    missing = sorted(rendered - allowed)
    assert not missing, (
        "CRMProjectDetail renders these tabs but modules/projects.js will not "
        "route to them, so their URL opens Overview instead: " + ", ".join(missing)
    )
