// Error Boundary — catches render failures per-module with diagnostics
(function() {
  var h = React.createElement;

  // Global error log — accessible from console or settings
  window.__LTP_ERROR_LOG = window.__LTP_ERROR_LOG || [];

  function logError(moduleName, error, errorInfo) {
    var entry = {
      module: moduleName,
      message: error ? error.message : "Unknown error",
      stack: error ? error.stack : "",
      componentStack: errorInfo ? errorInfo.componentStack : "",
      timestamp: new Date().toISOString(),
    };
    window.__LTP_ERROR_LOG.push(entry);
    // Keep last 50 errors
    if (window.__LTP_ERROR_LOG.length > 50) window.__LTP_ERROR_LOG.shift();
    // Also log to console for dev tools
    console.error("[LTP Error in " + moduleName + "]", error, errorInfo);
  }

  // Class component — hooks can't catch render errors
  var ErrorBoundary = (function(_super) {
    function EB(props) {
      _super.call(this, props);
      this.state = { hasError: false, error: null, showDetails: false };
    }
    EB.prototype = Object.create(_super.prototype);
    EB.prototype.constructor = EB;

    EB.getDerivedStateFromError = function(error) {
      return { hasError: true, error: error };
    };

    EB.prototype.componentDidCatch = function(error, errorInfo) {
      logError(this.props.name || "Unknown", error, errorInfo);
    };

    EB.prototype.render = function() {
      var B = window.LTP_THEME || {};
      var self = this;

      if (this.state.hasError) {
        var err = this.state.error;
        var name = this.props.name || "Module";
        return h("div", { style: { background: (B.danger || "#e74c3c") + "08", border: "1px solid " + (B.danger || "#e74c3c") + "33", borderRadius: "8px", padding: "20px 24px", margin: "8px 0" } },
          h("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 12 } },
            h("div", { style: { width: 28, height: 28, borderRadius: "50%", background: (B.danger || "#e74c3c") + "22", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 } },
              h("span", { style: { fontSize: "14px", fontWeight: 700, color: B.danger || "#e74c3c" } }, "!")),
            h("div", null,
              h("div", { style: { fontSize: "13px", fontWeight: 700, color: B.text || "#fff" } }, name + " failed to load"),
              h("div", { style: { fontSize: "11px", color: B.textMut || "#666", marginTop: 2 } }, "An error occurred while rendering this section."))),

          h("div", { style: { display: "flex", gap: 8, marginBottom: this.state.showDetails ? 12 : 0 } },
            h("button", { onClick: function() { self.setState({ hasError: false, error: null, showDetails: false }); },
              style: { background: B.accent || "#E8731A", border: "none", borderRadius: "4px", padding: "5px 14px", color: "#000", fontSize: "11px", fontWeight: 700, cursor: "pointer", fontFamily: "inherit" } }, "\u21bb Retry"),
            h("button", { onClick: function() { self.setState({ showDetails: !self.state.showDetails }); },
              style: { background: "transparent", border: "1px solid " + (B.border || "#333"), borderRadius: "4px", padding: "5px 14px", color: B.textMut || "#666", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" } }, self.state.showDetails ? "Hide Details" : "Show Details"),
            h("button", { onClick: function() {
              var log = window.__LTP_ERROR_LOG || [];
              var last = log[log.length - 1];
              if (last) {
                var text = "Module: " + last.module + "\nTime: " + last.timestamp + "\nError: " + last.message + "\n\nStack:\n" + last.stack + "\n\nComponent:\n" + last.componentStack;
                if (navigator.clipboard) { navigator.clipboard.writeText(text); }
              }
            }, style: { background: "transparent", border: "1px solid " + (B.border || "#333"), borderRadius: "4px", padding: "5px 14px", color: B.textMut || "#666", fontSize: "11px", cursor: "pointer", fontFamily: "inherit" } }, "\u2398 Copy Error")),

          this.state.showDetails && h("div", { style: { background: (B.bg || "#000"), border: "1px solid " + (B.border || "#333"), borderRadius: "6px", padding: "10px 12px", overflow: "auto", maxHeight: 200 } },
            h("div", { style: { fontSize: "10px", fontWeight: 700, color: B.danger || "#e74c3c", marginBottom: 6 } }, err ? err.message : "Unknown error"),
            h("pre", { style: { fontSize: "9px", color: B.textMut || "#666", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all", lineHeight: 1.5 } },
              err && err.stack ? err.stack.split("\n").slice(1, 8).join("\n") : "No stack trace available"))
        );
      }

      return this.props.children;
    };

    return EB;
  })(React.Component);

  window.LTPErrorBoundary = ErrorBoundary;

  // Global unhandled error handler for non-render errors
  window.addEventListener("error", function(e) {
    logError("Global", e.error || new Error(e.message), null);
  });

  window.addEventListener("unhandledrejection", function(e) {
    logError("Promise", e.reason || new Error("Unhandled promise rejection"), null);
  });
})();
