// Rentals — Allocation Form Modal
// Depends on: rentals-utils.js
(function() {
  var h = React.createElement, useState = React.useState;

  window.RentalsAllocationForm = function({ equipment, allocations, projects, initial, equipmentId, onClose, onSave }) {
    var R = window.LTP_RENTALS;
    var B = window.LTP_THEME;

    var initEqId = initial ? initial.equipmentId : (equipmentId || "");
    var [eqId,   setEqId]   = useState(initEqId ? String(initEqId) : "");
    var [projId, setProjId] = useState(initial ? String(initial.projectId) : "");
    var [qty,    setQty]    = useState(initial ? String(initial.qty) : "1");
    var [start,  setStart]  = useState(initial ? initial.startDate : R.today());
    var [end,    setEnd]    = useState(initial ? initial.endDate : R.addDays(R.today(), 3));
    var [state,  setState]  = useState(initial ? initial.state : "reserved");
    var [notes,  setNotes]  = useState(initial ? initial.notes || "" : "");
    var [err,    setErr]    = useState("");

    var selEq = equipment.find(function(e) { return e.id === Number(eqId); });
    var avail = selEq && start && end
      ? R.availableQty(equipment, allocations, selEq.id, start, end, initial ? initial.id : null)
      : null;

    function save() {
      if (!eqId)          { setErr("Select an equipment item."); return; }
      if (!projId)        { setErr("Select a project."); return; }
      if (!start || !end) { setErr("Start and end dates are required."); return; }
      if (start > end)    { setErr("Start date must be before end date."); return; }
      var q = parseInt(qty) || 1;
      var maxAvail = avail !== null ? avail + (initial ? initial.qty : 0) : Infinity;
      if (q > maxAvail)   { setErr("Only " + maxAvail + " units available for this date range."); return; }
      onSave({ equipmentId: Number(eqId), projectId: Number(projId), qty: q, startDate: start, endDate: end, state: state, notes: notes.trim() || null });
    }

    return h(window.LTPModal, { title: initial ? "Edit Allocation" : "Add Allocation", onClose: onClose, disableBackdrop: true },
      h("div", { style: { display: "flex", flexDirection: "column", gap: 12 } },
        err && h("div", { style: { background: B.dangerBg, border: "1px solid " + B.dangerBd, borderRadius: 6, padding: "8px 12px", color: B.danger, fontSize: "12px" } }, err),

        R.Field("Equipment *", h("select", { value: eqId, onChange: function(e) { setEqId(e.target.value); setErr(""); }, style: Object.assign({}, R.INP, { width: "100%" }) },
          h("option", { value: "" }, "— Select equipment —"),
          equipment.filter(function(e) { return e.category !== "Accessories"; }).map(function(e) {
            return h("option", { key: e.id, value: e.id }, e.name + " (" + e.qty + " total)");
          })
        )),

        selEq && h("div", { style: { display: "flex", gap: 8, alignItems: "center" } },
          avail !== null && h("span", { style: { fontSize: "12px", color: avail > 0 ? B.success : B.danger, fontWeight: 600 } }, avail + " available for selected dates"),
          h("span", { style: { fontSize: "11px", color: B.textMut } }, "· $" + selEq.rates.day + "/day")
        ),

        R.Field("Project *", h("select", { value: projId, onChange: function(e) { setProjId(e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
          h("option", { value: "" }, "— Select project —"),
          projects.map(function(p) { return h("option", { key: p.id, value: p.id }, p.name); })
        )),

        h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr 80px", gap: 12 } },
          R.Field("Start Date", h("input", { type: "date", value: start, onChange: function(e) { setStart(e.target.value); setErr(""); }, style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("End Date",   h("input", { type: "date", value: end,   onChange: function(e) { setEnd(e.target.value); setErr(""); },   style: Object.assign({}, R.INP, { width: "100%" }) })),
          R.Field("Qty",        h("input", { type: "number", min: 1, value: qty, onChange: function(e) { setQty(e.target.value); setErr(""); }, style: Object.assign({}, R.INP, { width: "100%" }) }))
        ),

        R.Field("State", h("select", { value: state, onChange: function(e) { setState(e.target.value); }, style: Object.assign({}, R.INP, { width: "100%" }) },
          R.ALLOC_STATES.map(function(s) {
            return h("option", { key: s, value: s }, s.charAt(0).toUpperCase() + s.slice(1).replace("-", " "));
          })
        )),

        R.Field("Notes", h("textarea", { value: notes, onChange: function(e) { setNotes(e.target.value); }, rows: 2, placeholder: "Optional notes...", style: Object.assign({}, R.INP, { width: "100%", resize: "vertical" }) })),

        h("div", { style: { display: "flex", justifyContent: "flex-end", gap: 8 } },
          h(window.Btn, { variant: "ghost", onClick: onClose }, "Cancel"),
          h(window.Btn, { onClick: save }, initial ? "Save Changes" : "Add Allocation")
        )
      )
    );
  };
})();
