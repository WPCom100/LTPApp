// LTP Auth — current-user state for the SPA.
//
// On script load, fires GET /auth/me to determine whether the user is signed
// in. Result lands in window.LTP_AUTH_USER:
//
//   undefined → auth check still in flight (initial state)
//   null      → definitively NOT signed in (401 from /auth/me)
//   {…}       → signed in; object is { id, email, name, pictureUrl, role }
//
// app.js reads this to decide whether to render the sign-in screen, the
// loading gate, or the main shell. A "ltp-auth-ready" CustomEvent fires
// when the state transitions from `undefined` to its final value.
//
// Exposes window.LTP_AUTH:
//   getCurrentUser() → the user object or null
//   isAdmin()        → boolean (false until ready)
//   logout()         → POSTs /auth/logout then reloads
(function() {
  window.LTP_AUTH_USER = undefined;  // sentinel: not yet known

  function dispatchReady() {
    try {
      window.dispatchEvent(new CustomEvent("ltp-auth-ready", { detail: window.LTP_AUTH_USER }));
    } catch (e) { /* CustomEvent unsupported in very old browsers */ }
  }

  // Public client-view routes (#view/quote/<token>, #view/invoice/<token>)
  // are intentionally unauthenticated — the share_token is the credential.
  // Don't fire /auth/me on those: it'd 401, costing a round-trip and
  // (more importantly) data-state.js would see a 401 and bounce to
  // /auth/login, breaking the public page for the actual client.
  var hash = (window.location.hash || "").replace(/^#\/?/, "");
  if (hash.indexOf("view/") === 0) {
    window.LTP_AUTH_USER = null;
    // Defer so listeners attached later this tick still see the event.
    setTimeout(dispatchReady, 0);
    // Skip the /auth/me fetch entirely.
  } else {
    fireAuthCheck();
  }

  function fireAuthCheck() {
    fetch("/auth/me", { credentials: "include" })
      .then(function(r) {
        if (r.status === 401) return null;
        if (!r.ok) {
          console.error("[LTP] /auth/me unexpected status:", r.status);
          return null;
        }
        return r.json();
      })
      .then(function(data) {
        window.LTP_AUTH_USER = data;  // either user object or null
        dispatchReady();
      })
      .catch(function(e) {
        console.error("[LTP] /auth/me failed:", e);
        // Network error → treat as not signed in so the user sees the
        // sign-in screen rather than a stuck loading state. They can
        // retry by reloading.
        window.LTP_AUTH_USER = null;
        dispatchReady();
      });
  }

  window.LTP_AUTH = {
    getCurrentUser: function() {
      var u = window.LTP_AUTH_USER;
      return (u && typeof u === "object") ? u : null;
    },
    isAdmin: function() {
      var u = window.LTP_AUTH_USER;
      return !!(u && u.role === "admin");
    },
    logout: function() {
      return fetch("/auth/logout", { method: "POST", credentials: "include" })
        .catch(function(e) { console.warn("[LTP] logout request failed:", e); })
        .then(function() {
          // Reload regardless — clearing the cookie locally would require
          // server cooperation anyway; a full reload re-runs the auth check.
          window.location.href = "/";
        });
    },
  };
})();
