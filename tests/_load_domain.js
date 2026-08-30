// Shared loader for the theme + domain layer under Node.
//
// theme.js used to be one 2,739-line file, and six test files each did
//   global.window = {}; (0, eval)(fs.readFileSync(".../theme.js"))
// with their own copy of the shim. Splitting it into components/domain-*.js
// would have meant editing that copy-pasted preamble six times, and again on
// every future split — so the load list lives here once.
//
// The order is READ OUT OF index.html rather than restated, for the same reason
// tests/check_shell_version.py reads backend/main.py's allowlist instead of
// duplicating it: a hand-maintained second copy is a copy that drifts, and the
// failure mode here is silent (a symbol simply undefined at call time). If a
// domain file is added to index.html, these tests pick it up with no edit.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

/** Script srcs from index.html, in document order: theme.js + components/domain-*.js. */
function domainScripts() {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const srcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const out = srcs.filter((s) => s === "theme.js" || /^components\/domain-[\w-]+\.js$/.test(s));
  if (!out.length || out[0] !== "theme.js") {
    throw new Error("index.html: expected theme.js followed by components/domain-*.js, got "
      + JSON.stringify(out));
  }
  return out;
}

/**
 * Install a minimal browser shim on `global` and evaluate the domain layer into it.
 * Returns the shim's `window`. Extra globals a caller needs (React, document)
 * should be set before calling.
 */
function loadDomain(windowSeed) {
  global.window = windowSeed || {};
  for (const rel of domainScripts()) {
    (0, eval)(fs.readFileSync(path.join(ROOT, rel), "utf8"));
  }
  return global.window;
}

module.exports = { ROOT, domainScripts, loadDomain };
