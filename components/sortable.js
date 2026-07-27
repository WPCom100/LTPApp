// ═══════════════════════════════════════════════════════════════════════════
//   SORTABLE — pointer-driven, live-reordering drag & drop
// ═══════════════════════════════════════════════════════════════════════════
//
// Replaces the HTML5 drag-and-drop the quote builder used to run on. Native
// DnD gives a translucent browser-drawn snapshot, no feedback about where the
// row will land, no scrolling near the viewport edge, and it never fires on
// touch at all. This does the whole thing with pointer events:
//
//   • the row is picked up by its grab handle and a styled clone (the "ghost")
//     tracks the cursor;
//   • the list reorders LIVE underneath — every hit-test applies the move to
//     the caller's data, so the gap always sits exactly where the row will go;
//   • every row that shifts is FLIP-animated into its new spot, so the list
//     visibly makes room instead of teleporting;
//   • the nearest scrollable ancestor auto-scrolls near its edges, so a long
//     quote can be reordered top-to-bottom in one gesture;
//   • Escape cancels and the caller restores its snapshot.
//
// Because it's pointer-based it also works on iPad/hybrid touch screens, which
// native DnD never did. Phones (window.LTP_useIsMobile) keep the ▲▼ buttons —
// see LTPMoveArrows below — since a drag gesture there fights the page scroll.
// Those buttons route through `animate()` so a tap gets the same FLIP slide.
//
// ── Caller contract ────────────────────────────────────────────────────────
//   var S = window.LTP_useSortable({
//     enabled: !isMobile && !isLocked,      // gates the handles, not the FLIP
//     onMove: function(m) { ... },          // apply m to your data (see below)
//     onDragStart / onCancel / onDrop,      // optional
//     onKeyMove: function(kind, zone, id, dir) { ... },   // optional ▲▼ keys
//   });
//
//   h("div", Object.assign({ style: ... }, S.zoneProps(sec.id)),         // section
//     h("button", S.handleProps("section", sec.id, sec.id), "☰"),
//     h("div", Object.assign({ style: ... }, S.itemProps(sec.id, it.id)), // row
//       h("button", S.handleProps("item", sec.id, it.id), "☰")))
//
//   onMove receives { kind, id, fromZone, toZone, targetId, after }:
//   move `id` out of `fromZone` and insert it into `toZone` immediately
//   before (after=false) or after (after=true) `targetId`. A null targetId
//   means "append to the end of toZone" (dropping onto empty space).
//
// The DOM contract is data attributes — data-ltp-sort ("item"/"section"),
// data-ltp-id, data-ltp-zone, data-ltp-sort-inst — so hit-testing and FLIP
// need no element registry and survive React remounting rows across sections.
(function() {
  "use strict";
  var h = React.createElement;
  var useRef = React.useRef, useState = React.useState;
  var useEffect = React.useEffect, useLayoutEffect = React.useLayoutEffect;
  var B = window.LTP_THEME;

  var seq = 0;

  // Pointer travel (px, taxicab) before a press becomes a drag. Small enough to
  // feel instant, large enough that a click on the handle isn't a 1px drag.
  var START_SLOP = 5;
  // Minimum gap between two applied reorders. Rows have unequal heights, so
  // without a settle window a swap can put the pointer back over the row it
  // just displaced and the list oscillates.
  var MOVE_COOLDOWN_MS = 70;
  var EDGE = 64;          // auto-scroll trigger band, px from the scroller edge
  var EDGE_MAX_PX = 16;   // auto-scroll speed at the very edge, px per frame

  function isEl(n) { return n && n.nodeType === 1; }

  // Walk up from `el` to the nearest sortable of `kind` belonging to `inst`.
  // Attribute compare rather than closest() so ids never need CSS escaping.
  function closestSort(el, kind, inst) {
    while (isEl(el)) {
      if (el.getAttribute("data-ltp-sort-inst") === inst &&
          el.getAttribute("data-ltp-sort") === kind) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Nearest ancestor that actually scrolls vertically (the builder's centre
  // column). null → the window scrolls instead.
  function findScroller(el) {
    var n = el && el.parentElement;
    while (isEl(n) && n !== document.body && n !== document.documentElement) {
      var oy = "";
      try { oy = window.getComputedStyle(n).overflowY; } catch (e) {}
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 2) return n;
      n = n.parentElement;
    }
    return null;
  }

  // cloneNode copies attributes, not live form state — an un-fixed clone shows
  // blank qty/price boxes and reset selects. Mirror the values across.
  function copyFieldValues(src, dst) {
    var a = src.querySelectorAll("input, select, textarea");
    var b = dst.querySelectorAll("input, select, textarea");
    for (var i = 0; i < a.length && i < b.length; i++) {
      try {
        b[i].value = a[i].value;
        if (a[i].type === "checkbox" || a[i].type === "radio") b[i].checked = a[i].checked;
      } catch (e) {}
    }
  }

  window.LTP_useSortable = function(config) {
    config = config || {};

    var instRef = useRef(null);
    if (instRef.current == null) instRef.current = "sort" + (++seq);
    var inst = instRef.current;

    var cfgRef = useRef(config);
    cfgRef.current = config;

    var dragPair = useState(null);   // { kind, id } while a drag is live
    var drag = dragPair[0], setDrag = dragPair[1];

    var sess = useRef(null);         // mutable drag session (never re-renders)
    var flip = useRef(null);         // pre-mutation rects, consumed by the FLIP effect
    var alive = useRef(true);

    // ── FLIP ────────────────────────────────────────────────────────────────
    // captureRects() right before the data changes; the layout effect below
    // then plays every row from where it was to where it landed.
    function nodes() {
      return Array.prototype.slice.call(
        document.querySelectorAll('[data-ltp-sort][data-ltp-sort-inst="' + inst + '"]'));
    }
    function keyOf(el) {
      return el.getAttribute("data-ltp-sort") + ":" + el.getAttribute("data-ltp-id");
    }
    function findNode(kind, id) {
      var list = nodes();
      for (var i = 0; i < list.length; i++) {
        if (list[i].getAttribute("data-ltp-sort") === kind &&
            list[i].getAttribute("data-ltp-id") === String(id)) return list[i];
      }
      return null;
    }
    // Only one kind animates per reorder. Sections contain their rows, so
    // playing both would double every offset: a row inside a section that just
    // moved would slide by the section's delta *and* its own.
    function captureRects(kind) {
      var map = {};
      nodes().forEach(function(el) { map[keyOf(el)] = el.getBoundingClientRect(); });
      flip.current = { kind: kind || "item", rects: map };
    }

    useLayoutEffect(function() {
      var prev = flip.current;
      if (!prev) return;
      flip.current = null;
      nodes().forEach(function(el) {
        if (el.getAttribute("data-ltp-sort") !== prev.kind) return;
        var old = prev.rects[keyOf(el)];
        if (!old) return;                       // newly mounted — nothing to play from
        var now = el.getBoundingClientRect();
        var dx = old.left - now.left, dy = old.top - now.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.style.transition = "none";
        el.style.transform = "translate(" + dx + "px," + dy + "px)";
        el.getBoundingClientRect();             // reflow so the start frame sticks
        el.style.transition = "transform 200ms cubic-bezier(.2,.8,.25,1)";
        el.style.transform = "";
      });
    });

    // ── Ghost ───────────────────────────────────────────────────────────────
    function buildGhost(s) {
      var g = s.el.cloneNode(true);
      copyFieldValues(s.el, g);
      // Strip the sortable marks off the clone (and anything inside it, since a
      // section clone carries its rows) so it can't be hit-tested or FLIPped.
      g.removeAttribute("data-ltp-sort");
      g.removeAttribute("data-ltp-sort-inst");
      Array.prototype.forEach.call(g.querySelectorAll("[data-ltp-sort]"), function(n) {
        n.removeAttribute("data-ltp-sort");
        n.removeAttribute("data-ltp-sort-inst");
      });
      g.classList.add("ltp-sort-ghost");
      g.classList.remove("ltp-sort-dragging");
      g.style.position = "fixed";
      g.style.left = "0"; g.style.top = "0";
      g.style.width = s.w + "px";
      g.style.height = s.h + "px";
      g.style.margin = "0";
      g.style.zIndex = "9998";
      g.style.boxSizing = "border-box";
      document.body.appendChild(g);
      return g;
    }
    function positionGhost() {
      var s = sess.current;
      if (!s || !s.ghost) return;
      s.ghost.style.transform =
        "translate3d(" + (s.x - s.offX) + "px," + (s.y - s.offY) + "px,0) scale(1.015)";
    }

    // ── Hit-test → live reorder ─────────────────────────────────────────────
    function hitTest() {
      var s = sess.current;
      if (!s || !s.active) return;
      if (Date.now() - s.lastMoveAt < MOVE_COOLDOWN_MS) return;

      var under = document.elementFromPoint(s.x, s.y);
      if (!under) return;

      var target = closestSort(under, s.kind, inst);
      var toZone = s.zone, targetId = null, after = false;

      if (target) {
        if (target.getAttribute("data-ltp-id") === String(s.id)) return;  // over itself
        var r = target.getBoundingClientRect();
        targetId = target.getAttribute("data-ltp-id");
        after = s.y > r.top + r.height / 2;
        toZone = s.kind === "item" ? (target.getAttribute("data-ltp-zone") || s.zone) : s.zone;
      } else if (s.kind === "item") {
        // No row under the pointer — but we may be over a section's padding,
        // its header, or its empty-state box. Land in that section: before its
        // first row when the pointer is above it, at the end otherwise.
        var zoneEl = closestSort(under, "section", inst);
        if (!zoneEl) return;
        toZone = zoneEl.getAttribute("data-ltp-id");
        var rows = nodes().filter(function(n) {
          return n.getAttribute("data-ltp-sort") === "item" &&
                 n.getAttribute("data-ltp-zone") === toZone &&
                 n.getAttribute("data-ltp-id") !== String(s.id);
        });
        if (rows.length && s.y < rows[0].getBoundingClientRect().top) {
          targetId = rows[0].getAttribute("data-ltp-id");
          after = false;
        }
      } else {
        return;
      }

      var sig = toZone + "|" + targetId + "|" + (after ? 1 : 0);
      if (sig === s.lastSig) return;
      s.lastSig = sig;
      s.lastMoveAt = Date.now();

      captureRects(s.kind);
      if (cfgRef.current.onMove) {
        cfgRef.current.onMove({
          kind: s.kind, id: s.id,
          fromZone: s.zone, toZone: toZone,
          targetId: targetId, after: after,
        });
      }
      s.zone = toZone;   // cross-section move: subsequent removes come from here
    }

    // ── Auto-scroll ─────────────────────────────────────────────────────────
    function tick() {
      var s = sess.current;
      if (!s || !s.active) return;
      var top, bottom;
      if (s.scroller) {
        var r = s.scroller.getBoundingClientRect();
        top = r.top; bottom = r.bottom;
      } else {
        top = 0; bottom = window.innerHeight;
      }
      var dy = 0;
      if (s.y < top + EDGE) dy = -EDGE_MAX_PX * Math.min(1, (top + EDGE - s.y) / EDGE);
      else if (s.y > bottom - EDGE) dy = EDGE_MAX_PX * Math.min(1, (s.y - (bottom - EDGE)) / EDGE);
      if (dy) {
        if (s.scroller) s.scroller.scrollTop += dy;
        else window.scrollBy(0, dy);
        positionGhost();
        hitTest();
      }
      s.raf = window.requestAnimationFrame(tick);
    }

    // ── Session lifecycle ───────────────────────────────────────────────────
    function onPointerMove(e) {
      var s = sess.current;
      if (!s || (s.pointerId != null && e.pointerId !== s.pointerId)) return;
      s.x = e.clientX; s.y = e.clientY;
      if (!s.active) {
        if (Math.abs(e.clientX - s.startX) + Math.abs(e.clientY - s.startY) < START_SLOP) return;
        activate();
      }
      e.preventDefault();
      positionGhost();
      hitTest();
    }

    function onPointerUp(e) {
      var s = sess.current;
      if (!s || (s.pointerId != null && e.pointerId !== s.pointerId)) return;
      end(false);
    }

    function onWinKeyDown(e) {
      if (e.key !== "Escape") return;
      if (!sess.current) return;
      e.preventDefault();
      end(true);
    }

    // The handlers are re-created every render, so the session remembers the
    // exact identities it registered — otherwise a teardown from a later render
    // would call removeEventListener with functions that were never added.
    function listen(s) {
      s.handlers = [
        ["pointermove", onPointerMove], ["pointerup", onPointerUp],
        ["pointercancel", onPointerUp], ["keydown", onWinKeyDown],
      ];
      s.handlers.forEach(function(p) { window.addEventListener(p[0], p[1], true); });
    }
    function unlisten(s) {
      (s.handlers || []).forEach(function(p) { window.removeEventListener(p[0], p[1], true); });
      s.handlers = null;
    }

    function activate() {
      var s = sess.current;
      s.active = true;
      document.body.classList.add("ltp-sorting");
      s.ghost = buildGhost(s);
      positionGhost();
      s.raf = window.requestAnimationFrame(tick);
      setDrag({ kind: s.kind, id: s.id });
      if (cfgRef.current.onDragStart) {
        cfgRef.current.onDragStart({ kind: s.kind, id: s.id, zone: s.zone });
      }
    }

    // Land the ghost on the row's real resting place and fade it out as the
    // dimmed placeholder comes back to full strength — the two cross over, so
    // the row reads as having been set down rather than vanishing.
    function settleGhost(s) {
      var g = s.ghost;
      if (!g) return;
      var el = findNode(s.kind, s.id);
      if (!el) { if (g.parentNode) g.parentNode.removeChild(g); return; }
      var r = el.getBoundingClientRect();
      g.style.transition = "transform 170ms cubic-bezier(.2,.8,.25,1), opacity 170ms ease";
      g.style.transform = "translate3d(" + r.left + "px," + r.top + "px,0) scale(1)";
      g.style.opacity = "0";
      window.setTimeout(function() { if (g.parentNode) g.parentNode.removeChild(g); }, 220);
    }

    function end(cancelled) {
      var s = sess.current;
      sess.current = null;
      if (!s) return;
      unlisten(s);
      if (s.raf) window.cancelAnimationFrame(s.raf);
      document.body.classList.remove("ltp-sorting");
      if (!s.active) return;                       // never passed the slop — a plain click
      if (cancelled) {
        if (alive.current) captureRects(s.kind);
        if (cfgRef.current.onCancel) cfgRef.current.onCancel({ kind: s.kind, id: s.id });
        if (s.ghost && s.ghost.parentNode) s.ghost.parentNode.removeChild(s.ghost);
      } else {
        settleGhost(s);
        if (cfgRef.current.onDrop) cfgRef.current.onDrop({ kind: s.kind, id: s.id, zone: s.zone });
      }
      if (alive.current) setDrag(null);
    }

    function onHandleDown(kind, zoneId, id, e) {
      if (!cfgRef.current.enabled) return;
      if (e.button != null && e.button !== 0) return;   // primary button / touch only
      if (sess.current) end(false);
      var el = closestSort(e.target, kind, inst);
      if (!el) return;
      var rect = el.getBoundingClientRect();
      sess.current = {
        kind: kind, id: String(id), zone: zoneId, el: el,
        pointerId: e.pointerId != null ? e.pointerId : null,
        startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
        offX: e.clientX - rect.left, offY: e.clientY - rect.top,
        w: rect.width, h: rect.height,
        active: false, ghost: null, raf: 0, lastMoveAt: 0, lastSig: "",
        scroller: findScroller(el),
      };
      listen(sess.current);
      e.preventDefault();     // no text selection / native image drag
      e.stopPropagation();
    }

    // Handles are real buttons, so a keyboard user can tab to one and move the
    // row with ▲▼ — the same operation the drag performs, no pointer required.
    function onHandleKeyDown(kind, zoneId, id, e) {
      var dir = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
      if (!dir || !cfgRef.current.enabled || !cfgRef.current.onKeyMove) return;
      e.preventDefault();
      captureRects(kind);
      cfgRef.current.onKeyMove(kind, zoneId, id, dir);
    }

    // Drop the session if the host unmounts mid-drag.
    useEffect(function() {
      alive.current = true;
      return function() { alive.current = false; if (sess.current) end(true); };
    }, []);

    return {
      dragging: drag,
      isDragging: function(kind, id) {
        return !!drag && drag.kind === kind && drag.id === String(id);
      },

      // Run `fn` (any reorder) with the FLIP animation applied. This is what
      // gives the mobile ▲▼ buttons the same slide as a desktop drag, at zero
      // extra screen space. `kind` says which layer moved ("item"/"section").
      animate: function(fn, kind) { captureRects(kind); fn(); },

      // Marks a row. Always emitted (even when dragging is disabled) so FLIP
      // and hit-testing keep working for the ▲▼ path on phones.
      itemProps: function(zoneId, id) {
        var p = {
          "data-ltp-sort": "item",
          "data-ltp-id": String(id),
          "data-ltp-zone": String(zoneId),
          "data-ltp-sort-inst": inst,
        };
        if (drag && drag.kind === "item" && drag.id === String(id)) p.className = "ltp-sort-dragging";
        return p;
      },

      // Marks a section: both a sortable in its own right and the drop zone
      // its rows belong to.
      zoneProps: function(id) {
        var p = {
          "data-ltp-sort": "section",
          "data-ltp-id": String(id),
          "data-ltp-sort-inst": inst,
        };
        if (drag && drag.kind === "section" && drag.id === String(id)) p.className = "ltp-sort-dragging";
        return p;
      },

      // Props for the grab handle. Render it inside the element the matching
      // itemProps/zoneProps marked.
      handleProps: function(kind, zoneId, id, opts) {
        opts = opts || {};
        return {
          type: "button",
          className: "ltp-drag-handle",
          title: opts.title || "Drag to reorder (or focus and press ↑ / ↓)",
          "aria-label": opts.label || "Reorder",
          onPointerDown: function(e) { onHandleDown(kind, zoneId, id, e); },
          onKeyDown: function(e) { onHandleKeyDown(kind, zoneId, id, e); },
          onClick: function(e) { e.preventDefault(); },
          style: Object.assign({ fontSize: opts.fontSize || "13px", flexShrink: 0 }, opts.style || {}),
        };
      },
    };
  };

  // ── Mobile ▲▼ reorder buttons ──────────────────────────────────────────────
  // The touch path stays exactly what it was: two arrows, no extra rows, no
  // extra chrome. Shared here so the quote builder and the invoice builder
  // can't drift apart. `boxed` is the bordered 32px pair used in section
  // headers; the default is the borderless 40×44 pair used on line rows.
  window.LTPMoveArrows = function({ onMove, canUp, canDown, boxed, label }) {
    label = label || "item";
    var base = boxed
      ? { background: "transparent", border: "1px solid " + B.border, borderRadius: 4, color: B.textMut, fontSize: "11px", width: 32, height: 32, padding: 0 }
      : { background: "transparent", border: "none", color: B.textMut, fontSize: "16px", minWidth: 40, minHeight: 44, padding: 0 };
    function btn(dir, glyph, can) {
      return h("button", {
        onClick: function() { if (can) onMove(dir); },
        disabled: !can,
        "aria-label": "Move " + label + (dir < 0 ? " up" : " down"),
        className: "ltp-tap",
        style: Object.assign({}, base, {
          cursor: can ? "pointer" : "default",
          opacity: can ? 1 : 0.3,
          fontFamily: "inherit",
          flexShrink: 0,
        }),
      }, glyph);
    }
    return h("div", { style: { display: "flex", flexShrink: 0, gap: boxed ? 3 : 0 } },
      btn(-1, "▲", canUp !== false),
      btn(1, "▼", canDown !== false));
  };
})();
