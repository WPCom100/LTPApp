// LTPSearchSelect — the searchable replacement for a native <select>.
//
// WHY
//   Native dropdowns are fine for a frozen list of four statuses and miserable
//   for a forty-person crew roster: no filtering, and on a long list you scroll
//   blind. This is the one control every GROWING list uses, so "pick the role",
//   "pick the crew member", and "pick the project" all behave the same way.
//
//   Deliberately NOT everything. Short frozen enums (Status, Unit, Department,
//   Category, Net terms) keep the native <select> — typing to narrow four
//   options is slower, not faster — as do the QuickBooks account pickers, where
//   seeing the whole list at once is the point, and the selects wedged into
//   quote/invoice line-item rows, where a popover fights the row layout.
//
// SHAPE
//   Drop-in for window.LTPSelect: same label / value / onChange / options, same
//   closed-state box. onChange hands back the option's `value` UNTOUCHED, so a
//   call site keeps whatever type it already used.
//
//     h(window.LTPSearchSelect, {
//       label: "Role",
//       value: pos.serviceId || "",
//       onChange: function (v) { ... },
//       options: [{ value: "", label: "Role…" },
//                 { value: 3, label: "L2", sublabel: "Lighting" }],
//     })
//
// TIERS — `moreOptions`
//   Some lists want a short, relevant primary list plus a deliberate escape
//   hatch rather than one long pile. Crew drove it: show the people tagged with
//   the role being filled, and put everyone else behind an "Other crew" row you
//   have to actually click. Search stays inside the primary tier until you open
//   the second one, so the qualified people aren't buried under a name match
//   from another department.
//
// THINGS THAT WOULD BITE A NAIVER VERSION
//   * The panel is PORTALED to <body> with fixed coords. Several call sites sit
//     inside `overflow:hidden` cards (the Assignments booking rows) that would
//     otherwise clip an absolutely-positioned dropdown.
//   * The selected option is always rendered, even when the query or the
//     caller's own filtering excludes it — a native <select> whose value
//     matches no option silently displays option 0, which is how an assigned
//     but now-inactive crew member came to look unassigned.
//   * Value matching coerces, because call sites mix numeric ids against string
//     option values and vice versa.
//   * The search input is 16px on phones. Below that, iOS zooms the whole page
//     on focus — and this control focuses on open.
//   * No internal copy of `value`. The caller can decline a pick (the crew
//     pickers raise confirm dialogs and may never commit) and the field just
//     keeps showing what it showed before.
(function () {
  var h = React.createElement;
  var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
  var B = window.LTP_THEME;

  // Match window.LTPSelect's closed-state box exactly — these sit beside native
  // selects that are staying native, so any drift is visible.
  var BOX = {
    width: "100%", minWidth: 0, boxSizing: "border-box", background: B.bg,
    border: "1px solid " + B.border, borderRadius: "8px", padding: "8px 12px",
    color: B.text, fontSize: "13px", fontFamily: "inherit", outline: "none",
    transition: "border-color 0.15s", textAlign: "left",
    display: "flex", alignItems: "center", gap: 8, minHeight: 37,
  };

  // Call sites mix types freely: numeric ids bound against numeric option
  // values (pos.crewId), numeric state against string option values, and
  // string sentinels ("all"). Null and "" both mean "nothing picked".
  function same(a, b) {
    var x = (a == null) ? "" : a, y = (b == null) ? "" : b;
    return x === y || String(x) === String(y);
  }

  function findOpt(list, value) {
    for (var i = 0; i < (list || []).length; i++) {
      if (same(list[i].value, value)) return list[i];
    }
    return null;
  }

  function matches(opt, q) {
    if (!q) return true;
    var hay = String(opt.label || "") + " " + String(opt.sublabel || "");
    return hay.toLowerCase().indexOf(q) !== -1;
  }

  window.LTPSearchSelect = function (props) {
    var options = props.options || [];
    var moreOptions = props.moreOptions || null;
    var value = props.value;
    var disabled = !!props.disabled;
    var isMobile = window.LTP_useIsMobile();

    var openPair = useState(false), open = openPair[0], setOpen = openPair[1];
    var qPair = useState(""), query = qPair[0], setQuery = qPair[1];
    var actPair = useState(0), active = actPair[0], setActive = actPair[1];
    // The second tier stays shut until deliberately opened, and re-shuts on
    // close so the next open starts from the short, relevant list again.
    var morePair = useState(false), moreOpen = morePair[0], setMoreOpen = morePair[1];
    var rectPair = useState(null), rect = rectPair[0], setRect = rectPair[1];

    var rootRef = useRef(null);
    var panelRef = useRef(null);
    var inputRef = useRef(null);
    var listRef = useRef(null);

    var q = query.trim().toLowerCase();
    var primary = options.filter(function (o) { return matches(o, q); });
    var secondary = (moreOpen && moreOptions) ? moreOptions.filter(function (o) { return matches(o, q); }) : [];

    // Whatever is currently selected stays on screen even when the query would
    // hide it, so the open list never contradicts the closed field.
    //
    // Two rules keep that from getting in the way. Sentinels are exempt —
    // "(none)", "Unassigned", "Role…", "All Projects" are the current value in
    // a technical sense, but they aren't a record you'd lose track of, and
    // holding them in a filtered list is just clutter. And the pinned row goes
    // at the END, never the top, so the keyboard cursor still starts on a
    // genuine match and Enter can't commit a no-op.
    var selected = findOpt(options, value) || findOpt(moreOptions, value);
    var valueIsSentinel = same(value, "") || (selected && selected.sentinel);
    if (selected && !valueIsSentinel && q && !matches(selected, q)) {
      primary = primary.concat([selected]);
    }

    var flat = primary.concat(secondary);

    // A value with no matching option at all must not render blank — that reads
    // as "nothing selected" while the state still holds an id.
    var shownLabel = selected ? selected.label
      : (same(value, "") ? null : (props.missingLabel || String(value)));
    var isEmpty = same(value, "") || (!selected && !props.missingLabel && value == null);

    function close() { setOpen(false); setQuery(""); setActive(0); setMoreOpen(false); }

    function choose(opt) {
      if (!opt || opt.disabled || opt.header) return;
      props.onChange(opt.value);
      close();
    }

    // Fixed coords measured from the trigger. Recomputed on scroll (capture, so
    // inner scrollers count) and resize while open.
    function measure() {
      var el = rootRef.current; if (!el) return;
      var r = el.getBoundingClientRect();
      var below = window.innerHeight - r.bottom;
      var wantUp = below < 260 && r.top > below;
      setRect({
        left: r.left, width: r.width, top: r.bottom, bottomGap: window.innerHeight - r.top,
        up: wantUp, space: Math.max(140, (wantUp ? r.top : below) - 16),
      });
    }

    function toggle() {
      if (disabled) return;
      if (open) { close(); return; }
      measure();
      setOpen(true); setQuery(""); setMoreOpen(false);
      // Start on the selected row so ↓ moves from where you are.
      var idx = 0;
      for (var i = 0; i < options.length; i++) { if (same(options[i].value, value)) { idx = i; break; } }
      setActive(idx);
    }

    useEffect(function () {
      if (!open) return undefined;
      function onDoc(e) {
        var inRoot = rootRef.current && rootRef.current.contains(e.target);
        var inPanel = panelRef.current && panelRef.current.contains(e.target);
        if (!inRoot && !inPanel) close();
      }
      function onMove() { measure(); }
      document.addEventListener("mousedown", onDoc);
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
      return function () {
        document.removeEventListener("mousedown", onDoc);
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      };
    }, [open]);

    // Keyboard-first: the search box takes focus the moment the panel opens.
    useEffect(function () { if (open && inputRef.current) inputRef.current.focus(); }, [open]);

    // Keep the active row in view while arrowing through a long roster.
    useEffect(function () {
      if (!open || !listRef.current) return;
      var el = listRef.current.querySelector('[data-active="1"]');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }, [active, open, moreOpen, query]);

    function onKeyDown(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault(); setActive(function (i) { return Math.min(i + 1, Math.max(flat.length - 1, 0)); });
      } else if (e.key === "ArrowUp") {
        e.preventDefault(); setActive(function (i) { return Math.max(i - 1, 0); });
      } else if (e.key === "Home") {
        e.preventDefault(); setActive(0);
      } else if (e.key === "End") {
        e.preventDefault(); setActive(Math.max(flat.length - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        // Enter with nothing left to pick opens the second tier rather than
        // dead-ending the keyboard path.
        if (flat.length === 0 && moreOptions && !moreOpen) { setMoreOpen(true); setActive(0); return; }
        choose(flat[active]);
      } else if (e.key === "Escape") {
        e.preventDefault(); close();     // cancels without changing the value
      } else if (e.key === "Tab") {
        close();
      }
    }

    function row(opt, idx) {
      var isActive = idx === active;
      var isSel = same(opt.value, value);
      return h("div", {
        key: "o" + idx + ":" + String(opt.value),
        "data-active": isActive ? "1" : "0",
        role: "option", "aria-selected": isSel ? "true" : "false",
        onMouseDown: function (e) { e.preventDefault(); },
        onMouseEnter: function () { setActive(idx); },
        onClick: function () { choose(opt); },
        style: {
          padding: "9px 12px", fontSize: "12px",
          cursor: opt.disabled ? "default" : "pointer",
          color: opt.disabled ? B.textMut : (isSel ? B.accent : B.text),
          background: isActive && !opt.disabled ? B.raised : "transparent",
          borderBottom: "1px solid " + B.border,
          opacity: opt.disabled ? 0.55 : 1,
        },
      },
        h("div", { style: { fontWeight: isSel ? 700 : 500, display: "flex", alignItems: "center", gap: 6 } },
          isSel ? h("span", { style: { fontSize: "10px" } }, "✓") : null,
          h("span", null, opt.label)),
        opt.sublabel ? h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 1 } }, opt.sublabel) : null);
    }

    var panel = null;
    if (open && rect) {
      var wide = Math.max(rect.width, props.panelMinWidth || 0);
      var left = Math.max(8, Math.min(rect.left, (window.innerWidth || 0) - wide - 8));
      panel = h("div", {
        ref: panelRef, role: "listbox",
        style: Object.assign({
          position: "fixed", left: left, minWidth: wide, maxWidth: "calc(100vw - 16px)",
          zIndex: 3000, background: B.surface, border: "1px solid " + B.border,
          borderRadius: "8px", boxShadow: "0 12px 32px rgba(0,0,0,0.45)", overflow: "hidden",
        }, rect.up ? { bottom: rect.bottomGap + 2 } : { top: rect.top + 2 }),
      },
        h("input", {
          ref: inputRef, type: "text", value: query,
          placeholder: props.searchPlaceholder || "Type to search…",
          onChange: function (e) { setQuery(e.target.value); setActive(0); },
          onKeyDown: onKeyDown,
          style: {
            width: "100%", boxSizing: "border-box", background: B.bg,
            border: "none", borderBottom: "1px solid " + B.border,
            padding: "10px 12px", color: B.text,
            // 16px on phones or iOS zooms the page when this autofocuses.
            fontSize: isMobile ? "16px" : "13px",
            fontFamily: "inherit", outline: "none",
          },
        }),
        h("div", { ref: listRef, style: { maxHeight: Math.min(280, rect.space), overflowY: "auto" } },
          primary.map(function (o, i) { return row(o, i); }),
          // The second tier's header doubles as the reveal control, so the
          // roster behind it is always one deliberate click away and never
          // mixed into the primary results.
          moreOptions && moreOptions.length > 0 && !moreOpen
            ? h("div", {
                key: "_more",
                onMouseDown: function (e) { e.preventDefault(); },
                onClick: function () { setMoreOpen(true); setActive(primary.length); if (inputRef.current) inputRef.current.focus(); },
                style: {
                  padding: "10px 12px", fontSize: "12px", cursor: "pointer",
                  color: B.accent, fontWeight: 600, background: B.accentMuted,
                  display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6,
                },
              },
                h("span", null, props.moreLabel || "Other…"),
                h("span", { style: { fontSize: "11px" } }, "▾"))
            : null,
          moreOpen && moreOptions
            ? h("div", { key: "_morehdr", style: { padding: "6px 12px", fontSize: "10px", fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: B.textMut, background: B.raised, borderBottom: "1px solid " + B.border } },
                props.moreLabel || "Other…")
            : null,
          secondary.map(function (o, i) { return row(o, primary.length + i); }),
          flat.length === 0 && !(moreOptions && moreOptions.length > 0 && !moreOpen)
            ? h("div", { key: "_none", style: { padding: "14px 12px", fontSize: "12px", color: B.textMut, fontStyle: "italic", textAlign: "center" } },
                (options.length === 0 && props.emptyText) ? props.emptyText : (props.noMatchText || "No matches."))
            : null));
    }

    return h("div", { style: Object.assign({ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }, props.style) },
      // An empty-string label still reserves the row — the manual-shift form
      // labels only its first row and relies on the rest lining up under it.
      (props.label != null || props.labelAction) && h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: props.labelAction ? 26 : undefined } },
        h("label", { style: { fontSize: "11px", fontWeight: 600, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, props.label || ""),
        props.labelAction || null),
      h("div", { ref: rootRef, style: { position: "relative", minWidth: 0 } },
        h("button", {
          type: "button", onClick: toggle, disabled: disabled,
          "aria-haspopup": "listbox", "aria-expanded": open ? "true" : "false",
          title: shownLabel || undefined,
          // triggerStyle lets a caller match the surrounding density (the
          // schedule editor's rows run at 10px with 3px padding) without this
          // component knowing about any particular screen.
          style: Object.assign({}, BOX, {
            borderColor: open ? B.accent : B.border,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.55 : 1,
          }, props.triggerStyle),
        },
          h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isEmpty ? B.textMut : B.text } },
            shownLabel || props.placeholder || "Select…"),
          h("span", { style: { flexShrink: 0, color: B.textMut, fontSize: "10px" } }, "▾")),
        // Portaled to <body>: several call sites sit inside overflow:hidden
        // cards that would clip an in-place dropdown, and this has to paint
        // above LTPModal (1000) and the entity-form stack (2000+).
        panel && ReactDOM.createPortal(panel, document.body)));
  };

  // ── Option builders ───────────────────────────────────────────────────────
  // Shared so every crew picker in the app offers the same two tiers and the
  // same subtitles. All three crew dropdowns used to rebuild their own
  // "role-tagged first, then everyone else" option list, and they had drifted.
  //
  //   opts.crew        active crew to choose from
  //   opts.role        the role being filled; only crew tagged with it are shown
  //   opts.leading     entries pinned above the list ("Crew…", "Unassigned")
  //   opts.selectedId  who is currently assigned (see below)
  //   opts.allContacts every contact, used to resolve selectedId
  //
  // Returns { options, moreOptions, moreLabel }. Everyone NOT tagged with the
  // role goes in moreOptions, behind a click, so a name match from another
  // department can't bury the people actually qualified. With no role being
  // filled, everyone is "matching" and there's no second tier — an unfiltered
  // list is the honest answer, not an empty one.
  //
  // selectedId guards a case the old native selects got wrong: crew who go
  // inactive (or lose the role tag) drop out of the list while still assigned.
  // A <select> whose value matches no option displays its FIRST option, so the
  // row read "Crew…" — indistinguishable from unassigned — while the position
  // was still held. They're pinned into the list instead, and marked.
  window.LTP_crewSelectOptions = function (opts) {
    opts = opts || {};
    var H = window.LTP_HELPERS;
    var role = opts.role, selectedId = opts.selectedId;
    function opt(c, note) {
      var roles = (c.crewRoles || []).join(", ");
      var dept = (c.crewDepartments || []).join(", ");
      var sub = [roles, dept].filter(Boolean).join(" · ");
      return {
        value: c.id,
        label: H.contactName(c) + (note ? " — " + note : ""),
        sublabel: sub || undefined,
      };
    }
    function tagged(c) { return !!role && (c.crewRoles || []).indexOf(role) !== -1; }

    var list = (opts.crew || []).slice().sort(function (a, b) {
      return H.contactName(a).localeCompare(H.contactName(b));
    });
    var lead = (opts.leading || []).slice();

    var picked = (selectedId != null && selectedId !== "") ? selectedId : null;

    if (!role) {
      var flat = list.map(function (c) { return opt(c); });
      // Nobody is filtered out, so the only way to be missing is to have left
      // the roster entirely (gone inactive).
      if (picked && !list.some(function (c) { return c.id === picked; })) {
        var goneWho = H.findById(opts.allContacts, picked);
        if (goneWho) flat = flat.concat([opt(goneWho, "inactive")]);
      }
      return { options: lead.concat(flat), moreOptions: null, moreLabel: null };
    }

    var hit = list.filter(tagged).map(function (c) { return opt(c); });
    var rest = list.filter(function (c) { return !tagged(c); }).map(function (c) { return opt(c); });

    // Whoever is currently assigned belongs in the FIRST tier, whatever the
    // role filter says — opening the list must show who holds the position
    // without first expanding "Other crew". They're flagged so it's clear why
    // they're there, and lifted out of the second tier so they appear once.
    if (picked && !hit.some(function (o) { return o.value === picked; })) {
      var inRest = null;
      rest = rest.filter(function (o) {
        if (o.value !== picked) return true;
        inRest = o; return false;
      });
      if (inRest) {
        hit = hit.concat([{ value: inRest.value, label: inRest.label + " — not tagged for this role", sublabel: inRest.sublabel }]);
      } else {
        var who = H.findById(opts.allContacts, picked);
        if (who) hit = hit.concat([opt(who, who.crewStatus === "inactive" ? "inactive" : "not tagged for this role")]);
      }
    }

    return {
      options: lead.concat(hit),
      moreOptions: rest.length ? rest : null,
      moreLabel: "Other crew (" + rest.length + ") — not tagged for this role",
    };
  };
})();
