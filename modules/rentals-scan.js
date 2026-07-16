// Rentals — Barcode Scan Import session (SERIALIZED equipment only)
//
// The workflow: create the base product once, mark it serialized, then open
// this session to bulk-add per-unit records by scanning barcodes with the
// phone camera (or a Bluetooth/USB "keyboard-wedge" scanner, or typing). A
// collapsible "persistent info" panel holds the fields that repeat across a
// batch (purchase date, vendor, cost, status, location); every scan mints one
// unit carrying the scanned code in `barcode` plus the active persistent info.
// Change the panel whenever a new batch starts (different vendor/PO) and keep
// scanning — the running list shows batch dividers so the boundary is visible.
//
// Persistence-agnostic: this component owns only the on-screen session list and
// calls onAddUnit / onRemoveUnit; the parent decides how to store (the detail
// route persists each unit immediately into equipment.units; the create form
// stages them in its local units state until the form is saved).
//
// Depends on: rentals-utils.js (LTP_RENTALS.{VendorSearch,buildScannedUnit,
//   isDuplicateCode,batchLabel,Field,INP,LBL}), components/ui.js (LTPModal, Btn),
//   theme.js (LTP_THEME), and the vendored ZXing decoder (assets/vendor/zxing.min.js).
(function() {
  var h = React.createElement;
  var useState = React.useState, useRef = React.useRef, useEffect = React.useEffect;

  // ── Lazy ZXing-C++ (WASM) loader ────────────────────────────────────────────
  // The strong decoder: ZXing-C++ compiled to WebAssembly (zxing-wasm). It reads
  // small / rotated / glossy labels far better than the pure-JS decoder — proven
  // to decode real asset tags the JS build couldn't. It's ~1 MB (glue + .wasm),
  // so we load it lazily on the first scan (never at app startup) and memoize the
  // promise. The IIFE build exposes window.ZXingWASM; we point its loader at the
  // self-hosted binary. Preferred only when the browser has no native
  // BarcodeDetector (see setupNativeDetector) — on Android the OS decoder is used
  // instead and this 1 MB is never fetched.
  var SCANNER_URL = "/assets/vendor/zxing-wasm-reader.js";
  var WASM_URL = "/assets/vendor/zxing_reader.wasm";
  var _scannerPromise = null;

  // A <script> onerror carries no detail, so on failure we probe the URL to say
  // WHY — the two common causes are a 404 or (the self-host trap) the server
  // returning the SPA index.html for an un-allowlisted path, which nosniff then
  // refuses to execute as a script. Returns a human-readable reason string.
  function _diagnoseScannerFailure() {
    return fetch(SCANNER_URL, { credentials: "same-origin" }).then(function(r) {
      var ct = (r.headers.get("content-type") || "").toLowerCase();
      if (!r.ok) return "server returned HTTP " + r.status + " for " + SCANNER_URL;
      if (ct.indexOf("javascript") === -1) {
        return "server served " + SCANNER_URL + " as “" + (ct || "no content-type") +
               "”, not JavaScript (is assets/vendor/*.js allow-listed on the server?)";
      }
      return "script fetched OK (" + r.status + " " + ct + ") but wouldn't execute — possibly a CSP block";
    }).catch(function(e) {
      return "could not reach " + SCANNER_URL + " (" + ((e && e.message) || "network error") + ") — offline?";
    });
  }

  function _configureWasm() {
    // Point the module at the self-hosted .wasm (default would be a CDN URL the
    // strict connect-src blocks). Must be set before the first readBarcodes().
    try {
      window.ZXingWASM.setZXingModuleOverrides({
        locateFile: function(path, prefix) {
          return path.slice(-5) === ".wasm" ? WASM_URL : (prefix + path);
        },
      });
    } catch (e) { /* older/newer API shapes — locateFile default may still work */ }
  }

  function ensureScanner() {
    if (window.ZXingWASM) { _configureWasm(); return Promise.resolve(window.ZXingWASM); }
    if (_scannerPromise) return _scannerPromise;
    _scannerPromise = new Promise(function(resolve, reject) {
      var s = document.createElement("script");
      s.src = SCANNER_URL;
      s.async = true;
      s.onload = function() {
        if (window.ZXingWASM) { _configureWasm(); resolve(window.ZXingWASM); }
        else reject(new Error("scanner script loaded but window.ZXingWASM is undefined"));
      };
      s.onerror = function() {
        _diagnoseScannerFailure().then(function(why) {
          reject(new Error("Barcode scanner didn't load — " + why + "."));
        });
      };
      document.head.appendChild(s);
    // Clear the cached promise on failure so the next "Start camera" retries the
    // load (a transient offline blip shouldn't wedge the scanner permanently).
    }).catch(function(e) { _scannerPromise = null; throw e; });
    return _scannerPromise;
  }

  // ── Audible + haptic feedback (best-effort; silently no-ops if unsupported) ─
  var _audioCtx = null;
  function tone(freq, ms, type) {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!_audioCtx) _audioCtx = new AC();
      if (_audioCtx.state === "suspended") _audioCtx.resume();
      var osc = _audioCtx.createOscillator(), gain = _audioCtx.createGain();
      osc.type = type || "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.05;
      osc.connect(gain); gain.connect(_audioCtx.destination);
      osc.start();
      osc.stop(_audioCtx.currentTime + (ms || 90) / 1000);
    } catch (e) { /* audio is a nicety, never a hard dependency */ }
  }
  function vibrate(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {} }
  function feedbackOk()  { tone(880, 80, "sine");   vibrate(35); }
  function feedbackDup() { tone(300, 170, "square"); vibrate([25, 40, 25]); }

  function cameraErrMsg(e) {
    var name = e && e.name;
    if (name === "NotAllowedError" || name === "SecurityError")
      return "Camera permission was denied. Use the manual field below, or allow camera access and tap Start again.";
    if (name === "NotFoundError" || name === "OverconstrainedError")
      return "No usable camera was found. You can still add units with the manual field below.";
    return "Couldn't start the camera. You can still add units with the manual field below.";
  }

  // ── The session component ───────────────────────────────────────────────────
  // Props:
  //   eq            the equipment being scanned into (for the title)
  //   existingUnits units that already exist BEFORE this session (snapshotted
  //                 once for duplicate detection + id allocation)
  //   vendors       CRM vendor companies for the vendor picker
  //   onAddUnit(u)  persist one new unit (parent decides how)
  //   onRemoveUnit(id) undo one unit
  //   onClose()     close the session
  window.RentalsScanSession = function(props) {
    var eq = props.eq || {};
    var vendors = props.vendors || [];
    var onAddUnit = props.onAddUnit, onRemoveUnit = props.onRemoveUnit, onClose = props.onClose;
    var R = window.LTP_RENTALS, B = window.LTP_THEME;
    var isMobile = window.LTP_useIsMobile();
    var fmt = window.LTP_formatDate;

    // Pre-existing units are snapshotted ONCE so that units the parent persists
    // during the session (which may flow back in via props) don't double-count
    // in duplicate checks or id allocation — this session's own additions live
    // in `sessionUnits`.
    var baselineRef = useRef(null);
    if (baselineRef.current === null) baselineRef.current = (props.existingUnits || []).slice();

    var piPair = useState({ purchaseDate: R.today(), purchaseVendorId: null, purchaseCost: "", status: "available", location: "" });
    var persistentInfo = piPair[0], setPersistentInfo = piPair[1];
    var suPair = useState([]);                 // units scanned THIS session (chronological)
    var sessionUnits = suPair[0], setSessionUnits = suPair[1];
    var collapsePair = useState(false);
    var panelCollapsed = collapsePair[0], setPanelCollapsed = collapsePair[1];
    var dupPair = useState(false);
    var allowDup = dupPair[0], setAllowDup = dupPair[1];
    var camPair = useState(false);
    var cameraOn = camPair[0], setCameraOn = camPair[1];
    var loadingPair = useState(false);
    var cameraLoading = loadingPair[0], setCameraLoading = loadingPair[1];
    var errPair = useState("");
    var cameraError = errPair[0], setCameraError = errPair[1];
    var torchPair = useState(false);
    var torchSupported = torchPair[0], setTorchSupported = torchPair[1];
    var torchOnPair = useState(false);
    var torchOn = torchOnPair[0], setTorchOn = torchOnPair[1];
    var zoomCapsPair = useState(null);         // {min,max,step} when the camera supports zoom, else null
    var zoomCaps = zoomCapsPair[0], setZoomCaps = zoomCapsPair[1];
    var zoomValPair = useState(1);
    var zoomVal = zoomValPair[0], setZoomVal = zoomValPair[1];
    var flashPair = useState(null);            // { kind:"ok"|"dup", code, at } — last-scan banner
    var flash = flashPair[0], setFlash = flashPair[1];
    var typedPair = useState("");
    var typed = typedPair[0], setTyped = typedPair[1];
    var diagPair = useState(false);
    var showDiag = diagPair[0], setShowDiag = diagPair[1];
    var decoderPair = useState("");            // "native" | "zxing" | "" — which decoder is running
    var decoderName = decoderPair[0], setDecoderName = decoderPair[1];

    var videoRef = useRef(null);
    var readerRef = useRef(null);              // ZXing-C++ WASM reader (fallback path; has readBarcodes)
    var detectorRef = useRef(null);            // native BarcodeDetector (preferred path)
    var streamRef = useRef(null);
    var loopRef = useRef(null);                // decode-loop interval id
    var busyRef = useRef(false);               // guards the async native detect() against overlap
    var cropCanvasRef = useRef(null);          // reusable offscreen canvas for the centre crop
    var lastCodeRef = useRef("");
    var lastTimeRef = useRef(0);
    var cancelledRef = useRef(false);
    var typedInputRef = useRef(null);

    function setPI(k, v) { setPersistentInfo(function(p) { var o = {}; o[k] = v; return Object.assign({}, p, o); }); }

    // ── Core: turn a scanned/typed code into a unit ──────────────────────────
    // Kept in a ref so the continuous ZXing callback (captured once when the
    // camera starts) always runs against the LATEST persistent info / session
    // state rather than a stale closure.
    var handleRef = useRef(null);
    handleRef.current = function(rawCode, source) {
      var code = (rawCode == null ? "" : String(rawCode)).trim();
      if (!code) return;
      var now = Date.now();
      // The camera re-reads the same code every frame it stays in view; ignore
      // repeats within 1.5 s. Manual/wedge entries are deliberate, so they skip
      // the debounce (but still get duplicate-checked below).
      if (source === "camera" && code === lastCodeRef.current && (now - lastTimeRef.current) < 1500) return;
      lastCodeRef.current = code; lastTimeRef.current = now;

      var known = baselineRef.current.concat(sessionUnits);
      if (!allowDup && R.isDuplicateCode(code, known)) {
        feedbackDup();
        setFlash({ kind: "dup", code: code, at: now });
        return;
      }
      var unit = R.buildScannedUnit(code, persistentInfo, known.map(function(u) { return u.id; }));
      setSessionUnits(function(prev) { return prev.concat([unit]); });
      onAddUnit(unit);
      feedbackOk();
      setFlash({ kind: "ok", code: code, at: now });
    };

    function removeSessionUnit(id) {
      setSessionUnits(function(prev) { return prev.filter(function(u) { return u.id !== id; }); });
      if (onRemoveUnit) onRemoveUnit(id);
    }

    // ── Camera lifecycle ─────────────────────────────────────────────────────
    // Inspect the live track for optional camera controls and turn on continuous
    // autofocus — the combination that makes a small/close barcode (e.g. a short
    // Code-128 asset tag) decode reliably. All best-effort: Android Chrome
    // exposes these; iOS Safari mostly doesn't, and scanning still works without.
    function tuneTrack(stream) {
      var track;
      try { track = stream && stream.getVideoTracks && stream.getVideoTracks()[0]; } catch (e) { track = null; }
      if (!track) { setTorchSupported(false); setZoomCaps(null); return; }
      var caps = {};
      try { caps = track.getCapabilities ? track.getCapabilities() : {}; } catch (e) { caps = {}; }
      setTorchSupported(!!(caps && caps.torch));
      // Zoom: a slider lets the user fill the frame with a small label without
      // pushing the phone past its minimum focus distance (which just blurs it).
      if (caps && caps.zoom && typeof caps.zoom.max === "number" && caps.zoom.max > (caps.zoom.min || 1)) {
        setZoomCaps({ min: caps.zoom.min || 1, max: caps.zoom.max, step: caps.zoom.step || 0.1 });
        var cur = 1;
        try { var st = track.getSettings ? track.getSettings() : {}; if (typeof st.zoom === "number") cur = st.zoom; } catch (e) {}
        setZoomVal(cur);
      } else {
        setZoomCaps(null);
      }
      // Continuous autofocus so a close label snaps sharp on its own.
      try {
        var fm = caps && caps.focusMode;
        if (fm && fm.indexOf && fm.indexOf("continuous") !== -1) {
          track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(function() {});
        }
      } catch (e) {}
    }

    // Grab the current frame as ImageData, downscaled so the long side is at most
    // `maxSide` — keeps WASM decode fast while leaving plenty of resolution (the
    // decoder reads a small tag even when it's a modest fraction of the frame).
    function grabFrame(maxSide) {
      var v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return null;
      var vw = v.videoWidth, vh = v.videoHeight;
      var scale = (maxSide && Math.max(vw, vh) > maxSide) ? maxSide / Math.max(vw, vh) : 1;
      var dw = Math.max(1, Math.round(vw * scale)), dh = Math.max(1, Math.round(vh * scale));
      var canvas = cropCanvasRef.current || (cropCanvasRef.current = document.createElement("canvas"));
      canvas.width = dw; canvas.height = dh;
      var ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, dw, dh);
      return ctx.getImageData(0, 0, dw, dh);
    }

    function onHit(text) { if (text && handleRef.current) handleRef.current(text, "camera"); }

    // WASM readerOptions — try hard, and try rotations/inversions so a 90°-rotated
    // or dark-on-light label still reads. Empty formats = every supported symbology.
    var WASM_OPTS = { tryHarder: true, tryRotate: true, tryInvert: true, tryDownscale: true, formats: [], maxNumberOfSymbols: 1 };

    // Native path: the platform BarcodeDetector reads the FULL frame — it's
    // rotation-invariant and strong on small/angled/glare codes.
    function tickNative() {
      if (busyRef.current || !detectorRef.current) return;
      var v = videoRef.current;
      if (!v || !v.videoWidth) return;
      busyRef.current = true;
      detectorRef.current.detect(v).then(function(codes) {
        busyRef.current = false;
        if (codes && codes.length) onHit(codes[0].rawValue);
      }).catch(function() { busyRef.current = false; });
    }

    // Fallback path: ZXing-C++ (WASM) decodes the frame ImageData.
    function tickWasm() {
      if (busyRef.current || !readerRef.current) return;
      var imgData = grabFrame(2000);
      if (!imgData) return;
      busyRef.current = true;
      readerRef.current.readBarcodes(imgData, WASM_OPTS).then(function(results) {
        busyRef.current = false;
        if (results && results.length && results[0].text) onHit(results[0].text);
      }).catch(function() { busyRef.current = false; });
    }

    function startLoop(tick, ms) { stopLoop(); loopRef.current = setInterval(tick, ms || 140); }
    function stopLoop() {
      if (loopRef.current) { clearInterval(loopRef.current); loopRef.current = null; }
      busyRef.current = false;
    }

    // Prefer the native BarcodeDetector when it supports a format we care about.
    function setupNativeDetector() {
      if (!("BarcodeDetector" in window) || !window.BarcodeDetector.getSupportedFormats) return Promise.resolve(null);
      var wanted = ["code_128", "code_39", "code_93", "codabar", "itf",
                    "ean_13", "ean_8", "upc_a", "upc_e",
                    "qr_code", "data_matrix", "aztec", "pdf417"];
      return window.BarcodeDetector.getSupportedFormats().then(function(sup) {
        var use = wanted.filter(function(f) { return sup.indexOf(f) !== -1; });
        if (!use.length) return null;
        try { return new window.BarcodeDetector({ formats: use }); } catch (e) { return null; }
      }).catch(function() { return null; });
    }

    function startCamera() {
      setCameraError("");
      setCameraLoading(true);
      var md = navigator.mediaDevices;
      if (!md || !md.getUserMedia) {
        setCameraError("This browser can't open the camera. Use the manual field below.");
        setCameraLoading(false);
        return;
      }
      // Ask for the highest resolution available (up to 4K): a given barcode
      // spans ~2x the pixels at 4K vs 1080p, which is the difference between
      // "must be an inch away" and "reads at arm's length". Ideal (not exact)
      // so a device that tops out lower simply gives its best.
      var constraints = { audio: false, video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 30 },
      } };
      md.getUserMedia(constraints).then(function(stream) {
        if (cancelledRef.current) { stream.getTracks().forEach(function(t) { t.stop(); }); return; }
        streamRef.current = stream;
        var v = videoRef.current;
        if (!v) { stream.getTracks().forEach(function(t) { t.stop(); }); return; }
        v.srcObject = stream;
        var pp = v.play ? v.play() : null;
        if (pp && pp.catch) pp.catch(function() {});
        tuneTrack(stream);
        setupNativeDetector().then(function(detector) {
          if (cancelledRef.current) { stopCamera(); return; }
          if (detector) {
            detectorRef.current = detector;
            setDecoderName("native");
            startLoop(tickNative, 120);         // native detect is fast/async
            setCameraOn(true); setCameraLoading(false);
            return;
          }
          // No native decoder → load the ZXing-C++ WASM decoder.
          ensureScanner().then(function(zxw) {
            if (cancelledRef.current) { stopCamera(); return; }
            readerRef.current = zxw;             // exposes readBarcodes()
            setDecoderName("wasm");
            startLoop(tickWasm, 250);            // WASM decode is heavier — pace it slower
            setCameraOn(true); setCameraLoading(false);
          }).catch(function(e) {
            setCameraError(e.message || "Could not load the scanner.");
            stopCamera(); setCameraLoading(false);
          });
        });
      }).catch(function(e) {
        setCameraError(cameraErrMsg(e));
        setCameraOn(false); setCameraLoading(false);
      });
    }

    function stopCamera() {
      stopLoop();
      detectorRef.current = null;
      try { if (readerRef.current && readerRef.current.reset) readerRef.current.reset(); } catch (e) {}
      readerRef.current = null;
      // Stop every track so the camera light never lingers.
      try {
        var s = streamRef.current;
        if (s && s.getTracks) s.getTracks().forEach(function(t) { try { t.stop(); } catch (e) {} });
      } catch (e) {}
      try { if (videoRef.current) videoRef.current.srcObject = null; } catch (e) {}
      streamRef.current = null;
      setTorchOn(false);
      setTorchSupported(false);
      setZoomCaps(null);
      setZoomVal(1);
      setDecoderName("");
      setCameraOn(false);
    }

    function toggleTorch() {
      try {
        var track = streamRef.current && streamRef.current.getVideoTracks()[0];
        if (!track) return;
        var next = !torchOn;
        track.applyConstraints({ advanced: [{ torch: next }] }).then(function() { setTorchOn(next); }).catch(function() {});
      } catch (e) {}
    }

    function applyZoom(v) {
      v = Number(v);
      setZoomVal(v);
      try {
        var track = streamRef.current && streamRef.current.getVideoTracks()[0];
        if (track) track.applyConstraints({ advanced: [{ zoom: v }] }).catch(function() {});
      } catch (e) {}
    }

    // Stop the camera when the session unmounts (route change / Done / Close).
    useEffect(function() {
      cancelledRef.current = false;
      return function() { cancelledRef.current = true; stopCamera(); };
    }, []); // eslint-disable-line

    // Keep the manual field focused when the camera is off, so a Bluetooth/USB
    // wedge scanner (which types the code + Enter) lands in it with no extra tap.
    useEffect(function() {
      if (!cameraOn && typedInputRef.current) { try { typedInputRef.current.focus(); } catch (e) {} }
    }, [cameraOn]);

    function submitTyped() {
      var code = (typed || "").trim();
      if (!code) return;
      if (handleRef.current) handleRef.current(code, "typed");
      setTyped("");
    }

    function closeSession() { stopCamera(); if (onClose) onClose(); }

    // ── Derived display ──────────────────────────────────────────────────────
    var currentBatch = R.batchLabel(persistentInfo, vendors);
    var batchCount = sessionUnits.filter(function(u) { return R.batchLabel(u, vendors) === currentBatch; }).length;
    var statusOpts = [["available", "Available"], ["under-maintenance", "Under Maintenance"], ["retired", "Retired"]];

    var panel = h("div", { style: { background: B.raised, borderRadius: 10, padding: "12px 14px", border: "1px solid " + B.border } },
      h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer" }, onClick: function() { setPanelCollapsed(!panelCollapsed); } },
        h("div", { style: { fontSize: "11px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em" } }, "Batch info · applies to every scan"),
        h("span", { style: { fontSize: "11px", color: B.accent, fontWeight: 600 } }, panelCollapsed ? "Edit ▾" : "Hide ▴")
      ),
      panelCollapsed
        ? h("div", { style: { fontSize: "12px", color: B.textSec, marginTop: 6 } }, currentBatch)
        : h("div", { style: { display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "1fr 1fr 1fr 1fr", gap: 10, marginTop: 12 } },
            R.Field("Purchase Date", h("input", { type: "date", value: persistentInfo.purchaseDate || "", onChange: function(e) { setPI("purchaseDate", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Vendor (CRM)", h(R.VendorSearch, { vendors: vendors, value: persistentInfo.purchaseVendorId || null, onChange: function(id) { setPI("purchaseVendorId", id); } })),
            R.Field("Cost ($)", h("input", { type: "number", min: 0, step: "0.01", value: persistentInfo.purchaseCost, onChange: function(e) { setPI("purchaseCost", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
            R.Field("Status", h("select", { value: persistentInfo.status, onChange: function(e) { setPI("status", e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
              statusOpts.map(function(s) { return h("option", { key: s[0], value: s[0] }, s[1]); }))),
            R.Field("Location", h("input", { value: persistentInfo.location, onChange: function(e) { setPI("location", e.target.value); }, placeholder: "Warehouse A", style: Object.assign({}, R.INP, { width: "100%" }) }))
          )
    );

    // Camera viewport (or its start button / error state).
    var camera = h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
      h("div", { style: { position: "relative", background: "#000", borderRadius: 10, overflow: "hidden", border: "1px solid " + B.border, aspectRatio: "4 / 3", display: cameraOn ? "block" : "none" } },
        h("video", { ref: videoRef, playsInline: true, muted: true, autoPlay: true, style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }),
        // Aiming reticle — a guide to center the label. The whole frame is
        // decoded, so a slightly off-center code still reads.
        h("div", { style: { position: "absolute", inset: "20% 10%", border: "2px solid " + B.accent, borderRadius: 8, boxShadow: "0 0 0 100vmax rgba(0,0,0,0.25)", pointerEvents: "none" } }),
        torchSupported && h("button", { onClick: toggleTorch, style: { position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,0.55)", border: "1px solid " + B.border, borderRadius: 8, color: torchOn ? B.warn : "#fff", fontSize: "18px", padding: "6px 10px", cursor: "pointer" } }, torchOn ? "🔦" : "🔦")
      ),
      // Zoom slider — lets the user fill the frame with a small label instead of
      // pushing the phone closer than it can focus. Shown only where the camera
      // reports a zoom range (Android Chrome); hidden on iOS Safari etc.
      cameraOn && zoomCaps && h("div", { style: { display: "flex", alignItems: "center", gap: 10 } },
        h("span", { style: { fontSize: "15px" } }, "🔍"),
        h("input", { type: "range", min: zoomCaps.min, max: zoomCaps.max, step: zoomCaps.step, value: zoomVal,
          onChange: function(e) { applyZoom(e.target.value); },
          style: { flex: 1, accentColor: B.accent } }),
        h("span", { style: { fontSize: "11px", color: B.textMut, minWidth: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" } }, (Math.round(zoomVal * 10) / 10) + "×")
      ),
      cameraOn && h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "center" } },
        "Center the barcode in the box and hold steady a moment. Still not reading? " +
        (zoomCaps ? "Zoom in" : "Move a little closer") +
        (torchSupported ? " or tap the flash for glossy labels." : ".")),
      !cameraOn && h("button", { onClick: startCamera, disabled: cameraLoading,
        style: { background: B.raised, border: "1px dashed " + B.border, borderRadius: 10, color: B.accent, cursor: cameraLoading ? "default" : "pointer", padding: "20px", fontSize: "13px", fontWeight: 700, width: "100%", textAlign: "center" } },
        cameraLoading ? "Starting camera…" : "📷  Start camera"),
      cameraOn && h("div", { style: { display: "flex", justifyContent: "flex-end" } },
        h("button", { onClick: stopCamera, style: { background: "none", border: "1px solid " + B.border, borderRadius: 8, color: B.textMut, cursor: "pointer", padding: "6px 12px", fontSize: "11px", fontWeight: 600 } }, "Stop camera")),
      cameraError && h("div", { style: { background: B.warnBg, border: "1px solid " + B.warnBd, borderRadius: 8, padding: "8px 12px", color: B.warn, fontSize: "12px", lineHeight: 1.4, wordBreak: "break-word" } }, cameraError)
    );

    // Diagnostics — a live readout of the environment prerequisites, so an
    // on-device failure (camera blocked, insecure origin, scanner not served)
    // is self-explaining instead of a generic error. Collapsed by default.
    // Active video resolution — confirms the high-res request actually took
    // effect on the device (the key lever for small-barcode decoding).
    var camRes = "";
    try {
      var _t = streamRef.current && streamRef.current.getVideoTracks && streamRef.current.getVideoTracks()[0];
      var _s = _t && _t.getSettings ? _t.getSettings() : null;
      if (_s && _s.width && _s.height) camRes = _s.width + "×" + _s.height;
    } catch (e) {}
    var diagRows = [
      ["Secure context (HTTPS)", window.isSecureContext ? "yes" : "NO — camera needs HTTPS", !window.isSecureContext],
      ["Camera API (getUserMedia)", (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? "available" : "MISSING", !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)],
      ["Native BarcodeDetector", ("BarcodeDetector" in window) ? "available" : "no (WASM used)", false],
      ["Active decoder", decoderName === "native" ? "BarcodeDetector (native)" : decoderName === "wasm" ? "ZXing-C++ (WASM)" : "—", false],
      ["Camera state", cameraOn ? "on" : (cameraError ? "error" : "off"), !!cameraError],
      ["Video resolution", camRes || "—", false],
      ["Zoom", zoomCaps ? ((Math.round(zoomVal * 10) / 10) + "× (max " + zoomCaps.max + "×)") : "unsupported", false],
    ];
    var diagnostics = h("div", null,
      h("button", { onClick: function() { setShowDiag(!showDiag); },
        style: { background: "none", border: "none", color: B.textMut, cursor: "pointer", fontSize: "11px", fontWeight: 600, padding: 0, textDecoration: "underline" } },
        showDiag ? "Hide diagnostics" : "🔧 Diagnostics"),
      showDiag && h("div", { style: { marginTop: 8, background: B.bg, border: "1px solid " + B.border, borderRadius: 8, padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5 } },
        diagRows.map(function(r, i) {
          return h("div", { key: i, style: { display: "flex", justifyContent: "space-between", gap: 12, fontSize: "11px" } },
            h("span", { style: { color: B.textMut } }, r[0]),
            h("span", { style: { color: r[2] ? B.danger : B.textSec, fontWeight: 600, fontFamily: "monospace", textAlign: "right" } }, r[1]));
        }),
        cameraError && h("div", { style: { fontSize: "11px", color: B.danger, marginTop: 4, wordBreak: "break-word", lineHeight: 1.4 } }, "Last error: " + cameraError),
        h("div", { style: { fontSize: "10px", color: B.textMut, marginTop: 4, wordBreak: "break-all" } }, "Scanner URL: " + SCANNER_URL)
      )
    );

    // Manual / hardware-scanner entry.
    var manual = h("div", { style: { display: "flex", gap: 8, alignItems: "stretch" } },
      h("input", { ref: typedInputRef, value: typed,
        onChange: function(e) { setTyped(e.target.value); },
        onKeyDown: function(e) { if (e.key === "Enter") { e.preventDefault(); submitTyped(); } },
        placeholder: "Scan or type a barcode, then Enter",
        style: Object.assign({}, R.INP, { flex: 1, width: "100%" }) }),
      h(window.Btn, { small: true, onClick: submitTyped }, "Add")
    );

    // Last-scan banner.
    var banner = flash && h("div", { style: {
        background: flash.kind === "ok" ? B.successBg : B.warnBg,
        border: "1px solid " + (flash.kind === "ok" ? B.successBd : B.warnBd),
        borderRadius: 8, padding: "8px 12px",
        color: flash.kind === "ok" ? B.success : B.warn, fontSize: "12px", fontWeight: 600 } },
      flash.kind === "ok" ? ("✓ Added " + flash.code) : ("⚠ Already in this item: " + flash.code + (allowDup ? "" : " (skipped)")));

    // Running list (newest first) with batch dividers.
    var listRows = [];
    var rev = sessionUnits.slice().reverse();
    var prevLabel = null;
    rev.forEach(function(u) {
      var label = R.batchLabel(u, vendors);
      if (label !== prevLabel) {
        listRows.push(h("div", { key: "b-" + u.id, style: { fontSize: "10px", fontWeight: 700, color: B.textMut, textTransform: "uppercase", letterSpacing: "0.06em", padding: "8px 2px 4px" } }, label));
        prevLabel = label;
      }
      var sub = [u.status !== "available" ? u.status : null, u.purchaseCost ? "$" + Number(u.purchaseCost).toLocaleString() : null, u.purchaseDate && fmt ? fmt(u.purchaseDate) : u.purchaseDate].filter(Boolean).join(" · ");
      listRows.push(h("div", { key: u.id, style: { display: "flex", justifyContent: "space-between", alignItems: "center", background: B.raised, borderRadius: 8, padding: "10px 12px", border: "1px solid " + B.border } },
        h("div", null,
          h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text } }, u.barcode || u.serial || ("Unit " + u.id)),
          sub && h("div", { style: { fontSize: "11px", color: B.textMut, marginTop: 2 } }, sub)),
        h("button", { onClick: function() { removeSessionUnit(u.id); }, title: "Remove", style: { background: "none", border: "none", color: B.danger, cursor: "pointer", fontSize: "16px", lineHeight: 1 } }, "×")
      ));
    });

    return h(window.LTPModal, { title: "Scan Units — " + (eq.name || "Equipment"), onClose: closeSession, wide: true, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        h("div", { style: { fontSize: "12px", color: B.textMut } },
          "Each scan creates one unit with the code as its Barcode / Asset # plus the batch info below. Adjust the batch info whenever a new group starts."),
        panel,
        camera,
        manual,
        // Advanced: allow re-adding a code that already exists on this item.
        h("label", { style: { display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "11px", color: B.textMut } },
          h("input", { type: "checkbox", checked: allowDup, onChange: function(e) { setAllowDup(e.target.checked); }, style: { accentColor: B.accent } }),
          "Allow duplicate codes (skip the double-scan guard)"),
        diagnostics,
        banner,
        h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4 } },
          h("div", { style: { fontSize: "12px", color: B.textSec, fontWeight: 600 } },
            batchCount + " in this batch · " + sessionUnits.length + " this session"),
          h(window.Btn, { small: true, onClick: closeSession }, "Done")
        ),
        sessionUnits.length === 0
          ? h("div", { style: { fontSize: "12px", color: B.textMut, fontStyle: "italic", padding: "8px 2px" } }, "No units scanned yet.")
          : h("div", { style: { display: "flex", flexDirection: "column", gap: 6 } }, listRows)
      )
    );
  };
})();
