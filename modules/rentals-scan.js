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
//   cleanScanCode,isDuplicateCode,batchLabel,Field,INP,LBL}), components/ui.js
//   (LTPModal, Btn), theme.js (LTP_THEME), and the vendored ZXing-C++ WASM
//   decoder (assets/vendor/zxing-wasm-reader.js + zxing_reader.wasm).
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

  // ── Label OCR fallback (Claude via the backend) ─────────────────────────────
  // When the barcode decoders miss, the serial PRINTED under the bars usually
  // still reads — so frames/stills can fall back to /api/scan/ocr, where the
  // server asks Claude to extract the printed code. Feature-flagged server-side
  // on ANTHROPIC_API_KEY; the status probe below gates every OCR affordance so
  // the UI never offers what the deploy can't serve. The key never reaches the
  // browser.
  var OCR_STATUS_URL = "/api/scan/ocr/status";
  var OCR_URL = "/api/scan/ocr";
  var _ocrAvailable = null;   // null = not yet probed; boolean thereafter (per page load)
  function checkOcrAvailable() {
    if (_ocrAvailable !== null) return Promise.resolve(_ocrAvailable);
    return fetch(OCR_STATUS_URL, { credentials: "same-origin" })
      .then(function(r) { return r.ok ? r.json() : { available: false }; })
      .then(function(d) { _ocrAvailable = !!(d && d.available); return _ocrAvailable; })
      .catch(function() { return false; });   // transient failure: don't cache, just skip OCR for now
  }
  function ocrRead(jpegB64) {
    return fetch(OCR_URL, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: jpegB64, mediaType: "image/jpeg" }),
    }).then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) { return (d && d.code) ? d.code : null; })
      .catch(function() { return null; });
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
    var decoderPair = useState("");            // "native" | "wasm" | "" — which decoder is running
    var decoderName = decoderPair[0], setDecoderName = decoderPair[1];
    var snapBusyPair = useState(false);        // true while a snapped photo is being decoded
    var snapBusy = snapBusyPair[0], setSnapBusy = snapBusyPair[1];
    var camCountPair = useState(0);            // number of video-input devices (shows the switch button when >1)
    var camCount = camCountPair[0], setCamCount = camCountPair[1];
    var attemptsPair = useState(0);            // live decode attempts (diagnostics: proves the loop is running)
    var attempts = attemptsPair[0], setAttempts = attemptsPair[1];
    var camLabelPair = useState("");           // active camera's human label (e.g. "Back Ultra Wide Camera")
    var camLabel = camLabelPair[0], setCamLabel = camLabelPair[1];
    var ocrOnPair = useState(false);           // server has ANTHROPIC_API_KEY → label-OCR affordances active
    var ocrOn = ocrOnPair[0], setOcrOn = ocrOnPair[1];
    var ocrBusyPair = useState(false);         // a live-view escalation call is in flight (viewfinder indicator)
    var ocrBusy = ocrBusyPair[0], setOcrBusy = ocrBusyPair[1];
    var shutterPair = useState(false);         // in-viewfinder capture decode in flight
    var shutterBusy = shutterPair[0], setShutterBusy = shutterPair[1];

    var videoRef = useRef(null);
    var readerRef = useRef(null);              // ZXing-C++ WASM reader (fallback path; has readBarcodes)
    var detectorRef = useRef(null);            // native BarcodeDetector (preferred path)
    var streamRef = useRef(null);
    var loopRef = useRef(null);                // decode-loop interval id
    var busyRef = useRef(false);               // guards the async native detect() against overlap
    var cropCanvasRef = useRef(null);          // reusable offscreen canvas for the centre crop
    var tickNRef = useRef(0);                  // live-loop tick counter (alternates frame treatments)
    var attemptsRef = useRef(0);               // raw attempt count — mirrored to state only when diagnostics is open
    var showDiagRef = useRef(false);           // lets the decode ticks see diagnostics visibility without re-rendering
    var camsRef = useRef([]);                  // videoinput deviceIds (for the camera-switch button)
    var camIdxRef = useRef(0);                 // index into camsRef of the active camera
    var fileInputRef = useRef(null);           // hidden <input type=file capture> for the Snap path
    var ocrOnRef = useRef(false);              // mirrors ocrOn for the decode ticks (no re-render reads)
    var ocrBusyRef = useRef(false);            // one escalation call at a time
    var stallStartRef = useRef(0);             // when the current run of failed live decodes began
    var lastOcrAtRef = useRef(0);              // last escalation attempt (min-interval throttle)
    var captureBusyRef = useRef(false);        // shutter capture in progress — live ticks pause
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
      var code = R.cleanScanCode ? R.cleanScanCode(rawCode) : (rawCode == null ? "" : String(rawCode)).trim();
      if (!code) return;
      var now = Date.now();
      // Something readable is in view — the live loop isn't stalled, so push
      // the Claude-escalation window out (see maybeEscalate).
      stallStartRef.current = now;
      // The camera re-reads the same code every frame it stays in view — and a
      // snap of the label the live loop just caught can race the dup guard's
      // stale closure — so debounce same-code repeats within 1.5 s for BOTH
      // camera and photo sources. Manual/wedge entries are deliberate and skip
      // the debounce (but still get duplicate-checked below).
      if (source !== "typed" && code === lastCodeRef.current && (now - lastTimeRef.current) < 1500) return;
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
      setFlash({ kind: "ok", code: code + (source === "ocr" ? "  ·  🤖 read from label text" : ""), at: now });
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

    // Draw a source rect of a video/image element to the reusable offscreen
    // canvas (downscaled so the long side is at most maxSide). The single
    // primitive behind the live loop, Snap mode, and the OCR upload — callers
    // must consume the canvas (getImageData / toDataURL) before drawing again.
    function drawToCanvas(el, sx, sy, sw, sh, maxSide) {
      var scale = (maxSide && Math.max(sw, sh) > maxSide) ? maxSide / Math.max(sw, sh) : 1;
      var dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
      var canvas = cropCanvasRef.current || (cropCanvasRef.current = document.createElement("canvas"));
      canvas.width = dw; canvas.height = dh;
      canvas.getContext("2d", { willReadFrequently: true }).drawImage(el, sx, sy, sw, sh, 0, 0, dw, dh);
      return canvas;
    }

    function drawToImageData(el, sx, sy, sw, sh, maxSide) {
      var canvas = drawToCanvas(el, sx, sy, sw, sh, maxSide);
      return canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
    }

    // JPEG base64 (no data: prefix) for the OCR upload — ~1280px @ q0.72 keeps
    // a frame around 100-200 KB, plenty for Claude to read printed text.
    function canvasToJpegB64(canvas) {
      return canvas.toDataURL("image/jpeg", 0.72).split(",")[1];
    }

    // Full current frame, downscaled to maxSide.
    function grabFrame(maxSide) {
      var v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return null;
      return drawToImageData(v, 0, 0, v.videoWidth, v.videoHeight, maxSide);
    }

    // Reticle-sized centre of the current frame at NATIVE resolution (no
    // resampling → zero aliasing on the bars). Matches the on-screen reticle
    // inset (20% vertical, 10% horizontal); capped only to bound worst cases.
    function grabReticleCrop() {
      var v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return null;
      var vw = v.videoWidth, vh = v.videoHeight;
      var sx = Math.floor(vw * 0.10), sy = Math.floor(vh * 0.20);
      return drawToImageData(v, sx, sy, vw - sx * 2, vh - sy * 2, 3200);
    }

    // Live-loop hit. A detect()/readBarcodes promise already in flight when the
    // user taps Stop camera / Done resolves AFTER stopLoop cleared the interval —
    // drop those results (loopRef is null once stopped; cancelledRef after
    // unmount) so a stale frame can't add a unit to a stopped or closed session.
    function onHit(text) {
      if (cancelledRef.current || !loopRef.current) return;
      if (text && handleRef.current) handleRef.current(text, "camera");
    }

    // WASM readerOptions. tryHarder + rotate + invert so a 90°-rotated or
    // dark-on-light label still reads. The BINARIZER is the key lever for printed
    // asset tags: they're high-contrast black-on-white, and a glossy laminate's
    // glare defeats the adaptive default — a FixedThreshold cuts straight through
    // it (verified reading real glossy tags the adaptive binarizer couldn't). We
    // try Fixed first, then fall back to LocalAverage for low-contrast / unevenly
    // lit codes where the adaptive approach wins.
    var WASM_OPTS_FIXED = { tryHarder: true, tryRotate: true, tryInvert: true, binarizer: "FixedThreshold", formats: [], maxNumberOfSymbols: 1 };
    var WASM_OPTS_LOCAL = { tryHarder: true, tryRotate: true, tryInvert: true, binarizer: "LocalAverage", formats: [], maxNumberOfSymbols: 1 };

    // Native path: the platform BarcodeDetector reads the FULL frame — it's
    // rotation-invariant and strong on small/angled/glare codes.
    // Live-view Claude escalation. When the user has clearly been AIMING at
    // something that won't decode (>2.5s of continuous misses), send ONE
    // reticle-crop frame to the label-OCR endpoint and let Claude read the
    // printed serial. Cost stays negligible by construction: never concurrent,
    // ≥4s between attempts, only while stalled, stops the moment anything
    // reads (every accepted code resets stallStartRef in handleRef).
    function maybeEscalate() {
      if (!ocrOnRef.current || ocrBusyRef.current || captureBusyRef.current) return;
      if (cancelledRef.current || !loopRef.current) return;
      var now = Date.now();
      if (!stallStartRef.current) { stallStartRef.current = now; return; }
      if (now - stallStartRef.current < 2500) return;
      if (now - lastOcrAtRef.current < 4000) return;
      var v = videoRef.current;
      if (!v || !v.videoWidth) return;
      var b64;
      try {
        var vw = v.videoWidth, vh = v.videoHeight;
        var sx = Math.floor(vw * 0.10), sy = Math.floor(vh * 0.20);
        b64 = canvasToJpegB64(drawToCanvas(v, sx, sy, vw - sx * 2, vh - sy * 2, 1280));
      } catch (e) { return; }
      lastOcrAtRef.current = now;
      ocrBusyRef.current = true;
      setOcrBusy(true);
      ocrRead(b64).then(function(code) {
        ocrBusyRef.current = false;
        if (cancelledRef.current) return;
        setOcrBusy(false);
        stallStartRef.current = Date.now();      // fresh stall window either way
        if (code && loopRef.current && handleRef.current) handleRef.current(code, "ocr");
      });
    }

    function tickNative() {
      if (busyRef.current || captureBusyRef.current || !detectorRef.current) return;
      var v = videoRef.current;
      if (!v || !v.videoWidth) return;
      busyRef.current = true;
      attemptsRef.current++;
      // Only re-render for the counter while diagnostics is actually open —
      // otherwise a hidden number would rebuild the whole modal 4-8x/sec.
      if (showDiagRef.current) setAttempts(attemptsRef.current);
      detectorRef.current.detect(v).then(function(codes) {
        busyRef.current = false;
        if (codes && codes.length) onHit(codes[0].rawValue);
        else maybeEscalate();
      }).catch(function() { busyRef.current = false; });
    }

    // Fallback path: ZXing-C++ (WASM). Real tags proved maddeningly sensitive
    // to the exact (scale, binarizer) pairing — no single treatment reads them
    // all — so alternate treatments across ticks: even ticks decode the full
    // frame at ~2800px (the size that read real glossy tags), odd ticks decode
    // the reticle crop at native resolution (zero resampling on the bars).
    // Each tick runs FixedThreshold (cuts through glossy-laminate glare) then
    // LocalAverage (low-contrast/unevenly-lit codes) on the same pixels, so
    // within ~1s of aiming, four distinct treatments have seen the label.
    function tickWasm() {
      if (busyRef.current || captureBusyRef.current || !readerRef.current) return;
      tickNRef.current++;
      var imgData = (tickNRef.current % 2 === 0) ? grabReticleCrop() : grabFrame(2800);
      if (!imgData) return;
      var reader = readerRef.current;
      busyRef.current = true;
      attemptsRef.current++;
      // Only re-render for the counter while diagnostics is actually open —
      // otherwise a hidden number would rebuild the whole modal 4-8x/sec.
      if (showDiagRef.current) setAttempts(attemptsRef.current);
      reader.readBarcodes(imgData, WASM_OPTS_FIXED).then(function(results) {
        if (results && results.length && results[0].text) { busyRef.current = false; onHit(results[0].text); return; }
        return reader.readBarcodes(imgData, WASM_OPTS_LOCAL).then(function(r2) {
          busyRef.current = false;
          if (r2 && r2.length && r2[0].text) onHit(r2[0].text);
          else maybeEscalate();
        });
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

    // After permission is granted, device labels/ids become available. Cache the
    // video inputs so the 🔄 button can cycle lenses — on iPhone the MAIN lens
    // can't focus closer than ~6-8", but the ultra-wide can macro-focus, so
    // switching cameras is often what makes a close-up label snap sharp.
    function refreshCameraList() {
      var md = navigator.mediaDevices;
      if (!md || !md.enumerateDevices) return;
      md.enumerateDevices().then(function(devs) {
        var vids = devs.filter(function(d) { return d.kind === "videoinput" && d.deviceId; });
        // The selfie camera is never useful for scanning a label — drop
        // front-facing devices from the cycle when any other camera remains.
        // (Labels are localized; this heuristic catches English iOS/Android.
        // Worst case an exotic locale keeps the front cam as one extra hop.)
        var back = vids.filter(function(d) { return !/front|face ?time|user/i.test(d.label || ""); });
        var use = back.length ? back : vids;
        var cams = use.map(function(d) { return d.deviceId; });
        camsRef.current = cams;
        // Track which entry is live so the next 🔄 press advances from it, and
        // surface the active lens name so switching isn't blind.
        try {
          var track = streamRef.current && streamRef.current.getVideoTracks()[0];
          var cur = track && track.getSettings ? track.getSettings().deviceId : null;
          var idx = cams.indexOf(cur);
          if (idx >= 0) camIdxRef.current = idx;
          setCamLabel((track && track.label) || "");
        } catch (e) {}
        setCamCount(cams.length);
      }).catch(function() {});
    }

    function switchCamera() {
      var cams = camsRef.current || [];
      if (cams.length < 2) return;
      camIdxRef.current = (camIdxRef.current + 1) % cams.length;
      startCamera(cams[camIdxRef.current]);
    }

    function startCamera(deviceId) {
      if (typeof deviceId !== "string") deviceId = null;   // tolerate onClick's event arg
      stopCamera();                              // release any current stream first (camera switch)
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
      var video = {
        width:  { ideal: 3840 },
        height: { ideal: 2160 },
        frameRate: { ideal: 30 },
      };
      if (deviceId) video.deviceId = { exact: deviceId };
      else video.facingMode = { ideal: "environment" };
      md.getUserMedia({ audio: false, video: video }).then(function(stream) {
        if (cancelledRef.current) { stream.getTracks().forEach(function(t) { t.stop(); }); return; }
        streamRef.current = stream;
        var v = videoRef.current;
        if (!v) { stream.getTracks().forEach(function(t) { t.stop(); }); return; }
        v.srcObject = stream;
        var pp = v.play ? v.play() : null;
        if (pp && pp.catch) pp.catch(function() {});
        tuneTrack(stream);
        refreshCameraList();
        // Fresh stall window: the Claude escalation timer starts counting from
        // camera start (and re-arms on every successful read / lens switch).
        stallStartRef.current = Date.now();
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
      setCamLabel("");
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

    // ── Snap mode: decode a NATIVE-CAMERA photo ─────────────────────────────
    // The most reliable path on phones, because it sidesteps the two things
    // that break live-video scanning: (1) getUserMedia is pinned to the main
    // lens, which can't focus closer than ~6-8" (the native camera app
    // auto-switches to the macro lens); (2) video frames are far softer than
    // stills (no multi-frame fusion). A photo taken through
    // <input type=file capture=environment> gets the full native pipeline —
    // and verified real label photos decode in ~100-170ms.
    //
    // The still is run through a ladder of (scale, binarizer) passes, stopping
    // at the first hit. Order reflects measured success on real tags: 2800px
    // first (fastest reliable), then bigger/smaller scales, each FixedThreshold
    // (glossy glare) before LocalAverage (uneven lighting). 4000 is the ceiling
    // — NOT native — because 24MP-default iPhones return 5712×4284 stills and
    // iOS Safari's 2D canvas area limit (~16.7M px) silently yields dead pixels
    // above roughly 4000×3000; a 4:3 frame at 4000 stays safely under it.
    var SNAP_PASSES = [
      { maxSide: 2800, opts: "fixed" },
      { maxSide: 2800, opts: "local" },
      { maxSide: 4000, opts: "fixed" },
      { maxSide: 4000, opts: "local" },
      { maxSide: 2200, opts: "fixed" },
      { maxSide: 2200, opts: "local" },
      { maxSide: 3400, opts: "fixed" },
      { maxSide: 3400, opts: "local" },
    ];

    // Load the snapped file into something drawImage accepts. Prefer
    // createImageBitmap: it decodes the Blob directly (no <img src=blob:…>, so
    // the CSP img-src is never involved) and applies EXIF orientation. Fall
    // back to an <img> + object URL for engines without it (img-src includes
    // blob: for exactly this path).
    function loadPhoto(file) {
      function viaImg() {
        var url = URL.createObjectURL(file);
        return new Promise(function(resolve, reject) {
          var img = new Image();
          img.onload = function() {
            resolve({ el: img, w: img.naturalWidth, h: img.naturalHeight,
                      done: function() { URL.revokeObjectURL(url); } });
          };
          img.onerror = function() { URL.revokeObjectURL(url); reject(new Error("Couldn't read that photo.")); };
          img.src = url;
        });
      }
      if (window.createImageBitmap) {
        return window.createImageBitmap(file).then(function(bmp) {
          return { el: bmp, w: bmp.width, h: bmp.height,
                   done: function() { try { bmp.close(); } catch (e) {} } };
        }).catch(viaImg);
      }
      return viaImg();
    }

    // Decode a loaded still ({el, w, h}) through the full battery: the free
    // platform BarcodeDetector first (Android — no 1 MB WASM download, works
    // offline), then the WASM (scale, binarizer) ladder. Resolves the barcode
    // text or null. Shared by Snap mode and the in-viewfinder shutter.
    function runStillLadder(p) {
      return setupNativeDetector().then(function(det) {
        if (!det) return null;
        return det.detect(p.el).then(function(codes) {
          return (codes && codes.length && codes[0].rawValue) ? codes[0].rawValue : null;
        }).catch(function() { return null; });
      }).then(function(nativeText) {
        if (nativeText) return nativeText;
        return ensureScanner().then(function(zxw) {
          var i = 0;
          function nextPass() {
            if (i >= SNAP_PASSES.length) return null;    // ladder exhausted — no code found
            var pass = SNAP_PASSES[i++];
            var imgData;
            // A pass can fail on canvas/memory limits for huge stills — skip it
            // and keep climbing the ladder rather than aborting the whole snap.
            try { imgData = drawToImageData(p.el, 0, 0, p.w, p.h, pass.maxSide); }
            catch (e) { return nextPass(); }
            var opts = (pass.opts === "local") ? WASM_OPTS_LOCAL : WASM_OPTS_FIXED;
            return zxw.readBarcodes(imgData, opts).then(function(results) {
              if (results && results.length && results[0].text) return results[0].text;
              return nextPass();
            }, function() { return nextPass(); });
          }
          return nextPass();
        });
      });
    }

    // Last resort for a still: Claude reads the serial PRINTED on the label
    // (the barcode ladder already came up empty). Resolves the code or null;
    // instantly null when the server has no key configured.
    function ocrStill(p) {
      if (!ocrOnRef.current) return Promise.resolve(null);
      var b64;
      try { b64 = canvasToJpegB64(drawToCanvas(p.el, 0, 0, p.w, p.h, 1280)); }
      catch (e) { return Promise.resolve(null); }
      return ocrRead(b64);
    }

    function decodePhoto(file) {
      setSnapBusy(true);
      setCameraError("");
      var photo = null;
      loadPhoto(file).then(function(p) {
        photo = p;
        if (!p.w || !p.h) throw new Error("Couldn't read that photo.");
        return runStillLadder(p);
      }).then(function(text) {
        if (text) return { code: text, via: "photo" };
        return ocrStill(photo).then(function(code) { return { code: code, via: "ocr" }; });
      }).then(function(res) {
        if (photo) photo.done();
        // Session closed while the decode was in flight — drop the result
        // rather than adding a unit to a dismissed session.
        if (cancelledRef.current) return;
        setSnapBusy(false);
        if (res && res.code) {
          if (handleRef.current) handleRef.current(res.code, res.via);
        } else {
          feedbackDup();
          setFlash({ kind: "err", code: "No " + (ocrOnRef.current ? "barcode or readable code" : "barcode") + " found in that photo — fill more of the frame with the label and retake.", at: Date.now() });
        }
      }).catch(function(e) {
        if (photo) photo.done();
        if (cancelledRef.current) return;
        setSnapBusy(false);
        setCameraError((e && e.message) || "Couldn't read that photo.");
      });
    }

    function onSnapFile(e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";                       // allow snapping the same label twice in a row
      if (f) decodePhoto(f);
    }

    // Copy the current video frame to its OWN canvas (not the shared one — the
    // ladder redraws that per pass) and wrap it like a loaded photo.
    function grabVideoStill() {
      var v = videoRef.current;
      if (!v || !v.videoWidth) return null;
      var c = document.createElement("canvas");
      c.width = v.videoWidth; c.height = v.videoHeight;
      c.getContext("2d").drawImage(v, 0, 0);
      return { el: c, w: c.width, h: c.height, done: function() {} };
    }

    // In-viewfinder shutter: one deliberate tap decodes what you SEE — the full
    // still ladder plus the Claude fallback — without leaving the app. Where
    // ImageCapture exists (Android Chrome) takePhoto() returns a true still at
    // photo resolution; elsewhere (iOS Safari) the current video frame is used.
    // For tiny labels 📸 Snap is still stronger: only the native camera app
    // gets macro-lens focus.
    function captureFrame() {
      if (captureBusyRef.current || cancelledRef.current) return;
      var v = videoRef.current;
      if (!v || !v.videoWidth) return;
      captureBusyRef.current = true;             // live ticks pause while we work
      setShutterBusy(true);
      var track = null;
      try { track = streamRef.current && streamRef.current.getVideoTracks()[0]; } catch (e) {}
      var stillP;
      if (window.ImageCapture && track) {
        stillP = new Promise(function(resolve) {
          var settled = false;
          function fallback() { if (!settled) { settled = true; resolve(grabVideoStill()); } }
          try {
            new window.ImageCapture(track).takePhoto().then(function(blob) {
              if (settled) return; settled = true;
              loadPhoto(blob).then(resolve, function() { resolve(grabVideoStill()); });
            }, fallback);
            setTimeout(fallback, 2000);          // takePhoto can hang on some devices
          } catch (e) { fallback(); }
        });
      } else {
        stillP = Promise.resolve(grabVideoStill());
      }
      var photo = null;
      stillP.then(function(p) {
        photo = p;
        if (!p) return null;
        return runStillLadder(p).then(function(text) {
          if (text) return { code: text, via: "photo" };
          return ocrStill(p).then(function(code) { return { code: code, via: "ocr" }; });
        });
      }).then(function(res) {
        if (photo && photo.done) photo.done();
        captureBusyRef.current = false;
        if (cancelledRef.current) return;
        setShutterBusy(false);
        stallStartRef.current = Date.now();      // a deliberate capture resets the escalation clock
        if (res && res.code) {
          if (handleRef.current) handleRef.current(res.code, res.via);
        } else {
          feedbackDup();
          setFlash({ kind: "err", code: "Couldn't read that capture — hold steady and fill the box, or use 📸 Snap photo.", at: Date.now() });
        }
      }).catch(function() {
        if (photo && photo.done) photo.done();
        captureBusyRef.current = false;
        if (cancelledRef.current) return;
        setShutterBusy(false);
      });
    }

    function openSnap() {
      if (snapBusy || !fileInputRef.current) return;
      // iOS has ONE camera pipeline: presenting the native camera over a live
      // getUserMedia stream interrupts the track, and on return the preview
      // often stays frozen/black with no event to recover from. Stop the live
      // camera first (also frees its memory before iOS backgrounds the page).
      // The user can tap Live scan again afterwards.
      if (cameraOn || cameraLoading) stopCamera();
      fileInputRef.current.click();
    }

    // Stop the camera when the session unmounts (route change / Done / Close).
    useEffect(function() {
      cancelledRef.current = false;
      // One cheap probe per page load: is label OCR (Claude) configured
      // server-side? Gates the escalation, the snap fallback, and the UI copy.
      checkOcrAvailable().then(function(ok) {
        if (cancelledRef.current) return;
        ocrOnRef.current = ok;
        setOcrOn(ok);
      });
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
      // Hidden native-camera input: capture="environment" makes iOS/Android open
      // the camera app directly. The still it returns gets the full native photo
      // pipeline (macro lens switching, focus, fusion) — the reliable Snap path.
      h("input", { ref: fileInputRef, type: "file", accept: "image/*", capture: "environment",
        onChange: onSnapFile, style: { display: "none" } }),
      h("div", { style: { position: "relative", background: "#000", borderRadius: 10, overflow: "hidden", border: "1px solid " + B.border, aspectRatio: "4 / 3", display: cameraOn ? "block" : "none" } },
        h("video", { ref: videoRef, playsInline: true, muted: true, autoPlay: true, style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }),
        // Aiming reticle — a guide to center the label. The whole frame is
        // decoded, so a slightly off-center code still reads.
        h("div", { style: { position: "absolute", inset: "20% 10%", border: "2px solid " + B.accent, borderRadius: 8, boxShadow: "0 0 0 100vmax rgba(0,0,0,0.25)", pointerEvents: "none" } }),
        torchSupported && h("button", { onClick: toggleTorch, style: { position: "absolute", top: 10, right: 10, background: "rgba(0,0,0,0.55)", border: "1px solid " + B.border, borderRadius: 8, color: torchOn ? B.warn : "#fff", fontSize: "18px", padding: "6px 10px", cursor: "pointer" } }, torchOn ? "🔦" : "🔦"),
        // Lens switch — on iPhone the main lens can't focus close; the
        // ultra-wide can. Cycling cameras is often what fixes close-up blur.
        camCount > 1 && h("button", { onClick: switchCamera, title: "Switch camera",
          style: { position: "absolute", top: 10, left: 10, background: "rgba(0,0,0,0.55)", border: "1px solid " + B.border, borderRadius: 8, color: "#fff", fontSize: "18px", padding: "6px 10px", cursor: "pointer" } }, "🔄"),
        // Shutter — capture what you see and decode it hard (full still ladder
        // + Claude fallback) without leaving the app.
        h("button", { onClick: captureFrame, disabled: shutterBusy, title: "Capture & read", "aria-label": "Capture and read barcode",
          style: { position: "absolute", left: "50%", bottom: 10, transform: "translateX(-50%)",
                   width: 54, height: 54, borderRadius: "50%", padding: 0,
                   background: shutterBusy ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.92)",
                   border: "4px solid rgba(0,0,0,0.35)", boxShadow: "0 0 0 3px rgba(255,255,255,0.6)",
                   cursor: shutterBusy ? "default" : "pointer" } }),
        // Busy indicator: a shutter decode or a live Claude escalation in flight.
        (shutterBusy || ocrBusy) && h("div", { style: { position: "absolute", top: 10, left: "50%", transform: "translateX(-50%)", background: "rgba(0,0,0,0.65)", color: "#fff", borderRadius: 8, padding: "4px 12px", fontSize: "11px", fontWeight: 600, whiteSpace: "nowrap" } },
          shutterBusy ? "Reading capture…" : "🤖 Reading label text…")
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
      cameraOn && h("div", { style: { fontSize: "11px", color: B.textMut, textAlign: "center", lineHeight: 1.5 } },
        (camLabel ? "Lens: " + camLabel + " · " : "") +
        "Center the barcode in the box and hold steady" +
        (ocrOn ? " — if the bars won't scan, the printed serial is read automatically" : "") +
        ". Tap the ⬤ shutter to capture & read what you see. Blurry up close? Back up a few inches" +
        (camCount > 1 ? " or tap 🔄 to switch lenses" : "") +
        (torchSupported ? "; the 🔦 flash helps glossy labels" : "") +
        ". 📸 Snap photo below is the sure path."),
      // Start camera + Snap photo, side by side. Snap works with or without the
      // live camera running (it opens the NATIVE camera, which focuses close).
      h("div", { style: { display: "flex", gap: 8 } },
        !cameraOn && h("button", { onClick: function() { startCamera(); }, disabled: cameraLoading,
          style: { flex: 1, background: B.raised, border: "1px dashed " + B.border, borderRadius: 10, color: B.accent, cursor: cameraLoading ? "default" : "pointer", padding: "20px 10px", fontSize: "13px", fontWeight: 700, textAlign: "center" } },
          cameraLoading ? "Starting camera…" : "📷  Live scan"),
        h("button", { onClick: openSnap, disabled: snapBusy,
          style: { flex: 1, background: B.raised, border: "1px dashed " + B.accent, borderRadius: 10, color: B.accent, cursor: snapBusy ? "default" : "pointer", padding: cameraOn ? "12px 10px" : "20px 10px", fontSize: "13px", fontWeight: 700, textAlign: "center" } },
          snapBusy ? "Reading photo…" : "📸  Snap photo")
      ),
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
      ["Cameras found", camCount ? String(camCount) : "—", false],
      ["Live decode attempts", String(attempts), false],
      ["Label OCR (Claude)", ocrOn ? "available" : "not configured", false],
    ];
    var diagnostics = h("div", null,
      h("button", { onClick: function() { var nv = !showDiag; showDiagRef.current = nv; setShowDiag(nv); if (nv) setAttempts(attemptsRef.current); },
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
      flash.kind === "ok" ? ("✓ Added " + flash.code)
        : flash.kind === "err" ? ("⚠ " + flash.code)
        : ("⚠ Already in this item: " + flash.code + (allowDup ? "" : " (skipped)")));

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
