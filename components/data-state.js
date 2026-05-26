// LTP Persistent State — shared localStorage wrapper.
//
// All app state that persists across sessions goes through this module.
// Provides both imperative helpers (loadState/saveState) for non-React code
// and a React hook (usePersistentState) that handles load + auto-save via effect.
//
// Key naming convention: "ltp_<slice>" (e.g. "ltp_quotes", "ltp_equipment").
// Failed localStorage reads/writes silently fall back (private mode, quota exceeded, etc.)
(function() {
  function loadState(key, fallback) {
    try {
      var d = localStorage.getItem("ltp_" + key);
      return d ? JSON.parse(d) : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function saveState(key, val) {
    try {
      localStorage.setItem("ltp_" + key, JSON.stringify(val));
    } catch (e) {}
  }

  // React hook — returns [value, setValue] that auto-persists to localStorage.
  // Initial load happens once on mount; every subsequent change syncs.
  function usePersistentState(key, fallback) {
    var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;
    var pair = useState(function() { return loadState(key, fallback); });
    var value = pair[0], setValue = pair[1];
    var staleRef = useRef(false);
    useEffect(function() { saveState(key, value); }, [value]);
    // Detect cross-tab changes
    useEffect(function() {
      function onStorage(e) {
        if (e.key === "ltp_" + key && !staleRef.current) {
          staleRef.current = true;
          // Don't auto-reload — just flag it. Modules can check window.__LTP_STALE_KEYS
          if (!window.__LTP_STALE_KEYS) window.__LTP_STALE_KEYS = {};
          window.__LTP_STALE_KEYS[key] = true;
        }
      }
      window.addEventListener("storage", onStorage);
      return function() { window.removeEventListener("storage", onStorage); };
    }, [key]);
    return [value, setValue];
  }

  window.LTP_STATE = {
    loadState: loadState,
    saveState: saveState,
    usePersistentState: usePersistentState,
  };
})();
