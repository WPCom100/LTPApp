// React mount — kept in its own file (not inline in index.html) so that
// the Content-Security-Policy header in backend/main.py can safely use
// `script-src 'self' https://cdnjs.cloudflare.com` WITHOUT `'unsafe-inline'`.
// An inline <script> would be blocked by that policy and the app wouldn't boot.
//
// Loads LAST in the script order (after app.js defines window.LTPApp).
var __ltp_root = ReactDOM.createRoot(document.getElementById("root"));
__ltp_root.render(React.createElement(window.LTPApp));
