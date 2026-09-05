// Phone name-fit for the online quote/invoice view (modules/client-view.js).
// Every item keeps to one line: the document's item names share the largest
// size, at most 11px, at which the widest name still fits the ITEM column,
// never below 9px — past that the name ends in an ellipsis. A name that could
// not fit even at 9px is left out of the fit (it gets its ellipsis whatever
// the size) so one hopeless outlier does not shrink every other name.
//
//   node tests/test_client_view_fit.js
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
global.React = { createElement: function () {}, useState: function () {}, useEffect: function () {}, useRef: function () {}, useLayoutEffect: function () {} };
global.window = {};
global.document = { createElement: function () { return { getContext: function () { return null; } }; } };
(0, eval)(fs.readFileSync(path.join(ROOT, "modules", "client-view.js"), "utf8"));
const fit = global.window.LTP_fitNameFont;

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (got === want) { pass++; } else { fail++; console.log("FAIL " + label + ": got " + JSON.stringify(got) + ", want " + JSON.stringify(want)); }
}

// Column of 148px (a 390px phone) → 146px of room.
eq("F1 everything fits at the base size → 11", fit([120, 90, 60], 148), 11);
eq("F2 exactly at the edge (2px slack) still 11", fit([146], 148), 11);
eq("F3 just past the slack shrinks", fit([147], 148), 10.9);
eq("F4 proportional: 135px name in a 118px column → 9.4", fit([135, 80], 118), 9.4);
eq("F5 rounds down to a tenth of a pixel", fit([150], 148), 10.7);
eq("F6 a name that fits only at the floor → 9", fit([116 * 11 / 9], 118), 9);

// Outliers: a name that will not fit even at 9px is ignored by the fit.
eq("F7 one hopeless name does not shrink the rest", fit([255, 135, 80], 148), 11);
eq("F8 …but a rescuable long name still shrinks", fit([255, 140, 80], 130), 10);
eq("F9 every name hopeless → base (all get an ellipsis)", fit([400, 300], 118), 11);
eq("F10 far too long, alone → base, not the floor", fit([400], 118), 11);

// Guards.
eq("F11 column not measured yet (0) → base", fit([135], 0), 11);
eq("F12 NaN column → base", fit([135], NaN), 11);
eq("F13 no names → base", fit([], 118), 11);
eq("F14 undefined widths → base", fit(undefined, 118), 11);
eq("F15 custom base and floor honoured", fit([160], 102, 13, 8), 8.1);

console.log("client-view fit suite — PASS: " + pass + "   FAIL: " + fail);
if (fail) process.exit(1); else console.log("All " + pass + " assertions passed.");
