// Rentals Shell — URL-driven routing. All persistent state (equipment, allocations,
// containers, kits) lives in app.js and flows in via props. This module owns no data.
//
// URL schema:
//   #/rentals                          Availability Checker
//   #/rentals/equipment                Equipment List
//   #/rentals/equipment/new            Add Equipment form
//   #/rentals/equipment/:id            Equipment detail popup
//   #/rentals/equipment/:id/edit       Equipment edit form
//   #/rentals/containers               Containers List
//   #/rentals/containers/new           Add Container form
//   #/rentals/containers/:id           Container detail popup
//   #/rentals/containers/:id/edit      Container edit form
//   #/rentals/kits                     Kits / Packages list
//   #/rentals/kits/new                 Create kit form
//   #/rentals/kits/:id                 Kit detail popup
//   #/rentals/kits/:id/edit            Kit edit form
//   #/rentals/cross-rentals            Cross rentals (orders of gear rented in)
//   #/rentals/cross-rentals/new        New order (?equipmentId=&start=&end=&vendorId= prefill)
//   #/rentals/cross-rentals/:id        Order detail popup
//   #/rentals/cross-rentals/:id/edit   Order edit form
(function() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;

  window.RentalsView = function({ projects, companies, route, equipment, setEquipment, allocations, setAllocations, containers, setContainers, kits, setKits, vendorRates, setVendorRates, crossRentals, setCrossRentals }) {
    var R = window.LTP_RENTALS;
    var isMobile = window.LTP_useIsMobile();

    var vendors = (companies || []).filter(function(c) { return c.isVendor; });

    // ── Route-derived state (NO local state for modals) ─────────────────────
    var sub    = route.sub;
    var id     = route.id;
    var action = route.action;

    var activeTab        = sub === "equipment" ? "equipment" : sub === "containers" ? "containers" : sub === "kits" ? "kits"
                         : sub === "cross-rentals" ? "cross" : "availability";
    var openEqId         = activeTab === "equipment"  && id && !action ? id : null;
    var openContainerId  = activeTab === "containers" && id && !action ? id : null;
    var openKitId        = activeTab === "kits"       && id && !action ? id : null;
    var showAddEq        = activeTab === "equipment"  && action === "new";
    var editEqId         = activeTab === "equipment"  && id && action === "edit" ? id : null;
    var scanEqId         = activeTab === "equipment"  && id && action === "scan" ? id : null;
    var showAddContainer = activeTab === "containers" && action === "new";
    var editContainerId  = activeTab === "containers" && id && action === "edit" ? id : null;
    var showAddKit       = activeTab === "kits"       && action === "new";
    var editKitId        = activeTab === "kits"       && id && action === "edit" ? id : null;
    var openCrossId      = activeTab === "cross"      && id && !action ? id : null;
    var showAddCross     = activeTab === "cross"      && action === "new";
    var editCrossId      = activeTab === "cross"      && id && action === "edit" ? id : null;

    var openEq        = openEqId       ? equipment.find(function(e) { return e.id === openEqId; })        : null;
    var openContainer = openContainerId? containers.find(function(c) { return c.id === openContainerId; }) : null;
    var openKit       = openKitId      ? kits.find(function(k) { return k.id === openKitId; })             : null;
    var editEq        = editEqId       ? equipment.find(function(e) { return e.id === editEqId; })        : null;
    var scanEq        = scanEqId       ? equipment.find(function(e) { return e.id === scanEqId; })        : null;
    var editContainer = editContainerId? containers.find(function(c) { return c.id === editContainerId; }) : null;
    var editKit       = editKitId      ? kits.find(function(k) { return k.id === editKitId; })             : null;
    var openCross     = openCrossId    ? (crossRentals || []).find(function(o) { return o.id === openCrossId; }) : null;
    var editCross     = editCrossId    ? (crossRentals || []).find(function(o) { return o.id === editCrossId; }) : null;
    // The checker and the quote picker open a new order with the item, the
    // dates and a chosen vendor already filled in (router.js parses the query).
    var crossPrefill = showAddCross ? (function(qs) {
      qs = qs || {};
      return { equipmentId: qs.equipmentId ? Number(qs.equipmentId) : null, vendorCompanyId: qs.vendorId ? Number(qs.vendorId) : null,
               startDate: qs.start || "", endDate: qs.end || "", qty: qs.qty ? Number(qs.qty) : 1 };
    })(route.query) : null;

    // ── Navigation helpers ───────────────────────────────────────────────────
    function goList()        { nav("rentals/" + (activeTab === "containers" ? "containers" : activeTab === "kits" ? "kits" : activeTab === "cross" ? "cross-rentals" : "equipment")); }
    function openEquip(eid)  { nav("rentals/equipment/" + eid); }
    function editEquip(eid)  { nav("rentals/equipment/" + eid + "/edit"); }
    function openCont(cid)   { nav("rentals/containers/" + cid); }
    function editCont(cid)   { nav("rentals/containers/" + cid + "/edit"); }

    // ── Equipment CRUD ──────────────────────────────────────────────────────
    function saveEquipment(data) {
      var saved;
      if (data.id) {
        saved = data;
        setEquipment(function(prev) { return prev.map(function(e) { return e.id === data.id ? data : e; }); });
      } else {
        var newId = Math.max.apply(null, equipment.map(function(e) { return e.id; }).concat([0])) + 1;
        saved = Object.assign({ id: newId }, data);
        setEquipment(function(prev) { return prev.concat([saved]); });
      }
      return saved.id;
    }

    function deleteEquipment(eid) {
      setEquipment(function(prev) { return prev.filter(function(e) { return e.id !== eid; }); });
      setAllocations(function(prev) { return prev.filter(function(a) { return a.equipmentId !== eid; }); });
      // A cross-rental line naming the item keeps its name as a cost record
      // but stops counting toward availability; the vendor's prices for it
      // go (the DB cascades them too).
      if (setCrossRentals) setCrossRentals(function(prev) { return prev.map(function(o) {
        if (!(o.lines || []).some(function(l) { return l.equipmentId === eid; })) return o;
        return Object.assign({}, o, { lines: o.lines.map(function(l) { return l.equipmentId === eid ? Object.assign({}, l, { equipmentId: null }) : l; }) });
      }); });
      if (setVendorRates) setVendorRates(function(prev) { return prev.filter(function(v) { return v.equipmentId !== eid; }); });
      setContainers(function(prev) { return prev.map(function(c) {
        return Object.assign({}, c, { defaultForEquipment: (c.defaultForEquipment || []).filter(function(x) { return x !== eid; }) });
      }); });
      nav("rentals/equipment");
    }

    // ── Scan-import: append/remove one serialized unit, persisting immediately ─
    // Each scanned unit lands in the DB as it's captured (the persistence hook
    // diff-syncs equipment.units), so a dropped phone or closed tab mid-session
    // never loses work. qty is kept == units.length (serialized items treat qty
    // as the unit count — see backend/models.py Equipment docstring).
    function addScannedUnit(eqId, unit) {
      setEquipment(function(prev) { return prev.map(function(e) {
        if (e.id !== eqId) return e;
        var units = (e.units || []).concat([unit]);
        return Object.assign({}, e, { units: units, qty: units.length });
      }); });
    }
    function removeScannedUnit(eqId, unitId) {
      setEquipment(function(prev) { return prev.map(function(e) {
        if (e.id !== eqId) return e;
        var units = (e.units || []).filter(function(u) { return u.id !== unitId; });
        return Object.assign({}, e, { units: units, qty: units.length });
      }); });
    }

    // ── Container CRUD ──────────────────────────────────────────────────────
    function saveContainer(data) {
      var saved;
      if (data.id) {
        saved = data;
        setContainers(function(prev) { return prev.map(function(c) { return c.id === data.id ? data : c; }); });
      } else {
        var newId = Math.max.apply(null, containers.map(function(c) { return c.id; }).concat([0])) + 1;
        saved = Object.assign({ id: newId }, data);
        setContainers(function(prev) { return prev.concat([saved]); });
      }
      return saved.id;
    }

    function deleteContainer(cid) {
      setContainers(function(prev) {
        return prev.filter(function(c) { return c.id !== cid; }).map(function(c) {
          return Object.assign({}, c, { canNestIds: (c.canNestIds || []).filter(function(x) { return x !== cid; }) });
        });
      });
      setEquipment(function(prev) { return prev.map(function(e) {
        return e.defaultContainerId === cid ? Object.assign({}, e, { defaultContainerId: null }) : e;
      }); });
      nav("rentals/containers");
    }

    // ── Kit CRUD ─────────────────────────────────────────────────────────────
    function saveKit(data) {
      var saved;
      if (data.id) {
        saved = data;
        setKits(function(prev) { return prev.map(function(k) { return k.id === data.id ? data : k; }); });
      } else {
        var newId = Math.max.apply(null, kits.map(function(k) { return k.id; }).concat([0])) + 1;
        saved = Object.assign({ id: newId }, data);
        setKits(function(prev) { return prev.concat([saved]); });
      }
      return saved.id;
    }

    function deleteKit(kid) {
      setKits(function(prev) { return prev.filter(function(k) { return k.id !== kid; }); });
      nav("rentals/kits");
    }

    // ── Cross-rental CRUD ────────────────────────────────────────────────────
    // Saving an order with "remember these prices" on refreshes the vendor's
    // price rows for every catalog-item line whose rates differ from what is
    // on file (or that has no row yet), stamped with today's quoted date. A
    // line still at the price on file leaves the row — and its date — alone,
    // so re-saving an old order to mark it returned never re-dates a price.
    function rememberVendorRates(order) {
      if (!order.rememberRates || order.vendorCompanyId == null || !setVendorRates) return;
      var todayStr = R.today();
      setVendorRates(function(prev) {
        var next = prev.slice();
        var nextId = Math.max.apply(null, next.map(function(v) { return v.id; }).concat([0])) + 1;
        (order.lines || []).forEach(function(l) {
          if (l.equipmentId == null) return;
          var rates = l.rates || {};
          if (!R.RATE_KEYS.some(function(k) { return (Number(rates[k]) || 0) > 0; })) return;
          var idx = -1;
          for (var i = 0; i < next.length; i++) {
            if (next[i].vendorCompanyId === order.vendorCompanyId && next[i].equipmentId === l.equipmentId) { idx = i; break; }
          }
          if (idx === -1) {
            next.push({ id: nextId++, vendorCompanyId: order.vendorCompanyId, equipmentId: l.equipmentId,
                        rates: { threeDay: Number(rates.threeDay) || 0, week: Number(rates.week) || 0, month: Number(rates.month) || 0 },
                        vendorItem: "", quotedDate: todayStr, preferred: false, active: true, notes: "" });
          } else {
            var cur = next[idx].rates || {};
            var same = R.RATE_KEYS.every(function(k) { return (Number(cur[k]) || 0) === (Number(rates[k]) || 0); });
            if (!same) next[idx] = Object.assign({}, next[idx], {
              rates: { threeDay: Number(rates.threeDay) || 0, week: Number(rates.week) || 0, month: Number(rates.month) || 0 },
              quotedDate: todayStr, active: true });
          }
        });
        return next;
      });
    }

    function saveCrossRental(data) {
      var saved;
      if (data.id) {
        saved = data;
        setCrossRentals(function(prev) { return prev.map(function(o) { return o.id === data.id ? data : o; }); });
      } else {
        var newId = Math.max.apply(null, (crossRentals || []).map(function(o) { return o.id; }).concat([0])) + 1;
        saved = Object.assign({ id: newId }, data);
        setCrossRentals(function(prev) { return prev.concat([saved]); });
      }
      rememberVendorRates(saved);
      return saved.id;
    }

    function setCrossStatus(oid, status) {
      setCrossRentals(function(prev) { return prev.map(function(o) { return o.id === oid ? Object.assign({}, o, { status: status }) : o; }); });
    }

    function deleteCrossRental(oid) {
      setCrossRentals(function(prev) { return prev.filter(function(o) { return o.id !== oid; }); });
      nav("rentals/cross-rentals");
    }
    function logMaintenance(eqId, log, unitId) {
      setEquipment(function(prev) { return prev.map(function(e) {
        if (e.id !== eqId) return e;
        if (!unitId) return Object.assign({}, e, { maintenanceLogs: (e.maintenanceLogs || []).concat([log]) });
        return Object.assign({}, e, { units: (e.units || []).map(function(u) {
          return u.id === unitId ? Object.assign({}, u, { maintenanceLogs: (u.maintenanceLogs || []).concat([log]) }) : u;
        })});
      }); });
    }

    function resolveMaintenance(eqId, logId, unitId) {
      setEquipment(function(prev) { return prev.map(function(e) {
        if (e.id !== eqId) return e;
        if (!unitId) {
          var logs = (e.maintenanceLogs || []).map(function(l) { return l.id === logId ? Object.assign({}, l, { status: "resolved", resolvedDate: R.today() }) : l; });
          return Object.assign({}, e, { maintenanceLogs: logs, status: (!logs.some(function(l) { return l.status === "open"; }) && e.status === "under-maintenance") ? "available" : e.status });
        }
        return Object.assign({}, e, { units: (e.units || []).map(function(u) {
          if (u.id !== unitId) return u;
          var logs = (u.maintenanceLogs || []).map(function(l) { return l.id === logId ? Object.assign({}, l, { status: "resolved", resolvedDate: R.today() }) : l; });
          return Object.assign({}, u, { maintenanceLogs: logs, status: (!logs.some(function(l) { return l.status === "open"; }) && u.status === "under-maintenance") ? "available" : u.status });
        })});
      }); });
    }

    function setUnderMaintenance(eqId, unitId) {
      setEquipment(function(prev) { return prev.map(function(e) {
        if (e.id !== eqId) return e;
        if (!unitId) return Object.assign({}, e, { status: "under-maintenance" });
        return Object.assign({}, e, { units: (e.units || []).map(function(u) { return u.id === unitId ? Object.assign({}, u, { status: "under-maintenance" }) : u; })});
      }); });
    }

    // ── Container Maintenance ────────────────────────────────────────────────
    function logContainerMaintenance(cId, log, unitId) {
      setContainers(function(prev) { return prev.map(function(c) {
        if (c.id !== cId) return c;
        if (!unitId) return Object.assign({}, c, { maintenanceLogs: (c.maintenanceLogs || []).concat([log]) });
        return Object.assign({}, c, { units: (c.units || []).map(function(u) { return u.id === unitId ? Object.assign({}, u, { maintenanceLogs: (u.maintenanceLogs || []).concat([log]) }) : u; })});
      }); });
    }

    function resolveContainerMaintenance(cId, logId, unitId) {
      setContainers(function(prev) { return prev.map(function(c) {
        if (c.id !== cId) return c;
        if (!unitId) {
          var logs = (c.maintenanceLogs || []).map(function(l) { return l.id === logId ? Object.assign({}, l, { status: "resolved", resolvedDate: R.today() }) : l; });
          return Object.assign({}, c, { maintenanceLogs: logs, status: (!logs.some(function(l) { return l.status === "open"; }) && c.status === "under-maintenance") ? "available" : c.status });
        }
        return Object.assign({}, c, { units: (c.units || []).map(function(u) {
          if (u.id !== unitId) return u;
          var logs = (u.maintenanceLogs || []).map(function(l) { return l.id === logId ? Object.assign({}, l, { status: "resolved", resolvedDate: R.today() }) : l; });
          return Object.assign({}, u, { maintenanceLogs: logs, status: (!logs.some(function(l) { return l.status === "open"; }) && u.status === "under-maintenance") ? "available" : u.status });
        })});
      }); });
    }

    function setContainerUnderMaintenance(cId, unitId) {
      setContainers(function(prev) { return prev.map(function(c) {
        if (c.id !== cId) return c;
        if (!unitId) return Object.assign({}, c, { status: "under-maintenance" });
        return Object.assign({}, c, { units: (c.units || []).map(function(u) { return u.id === unitId ? Object.assign({}, u, { status: "under-maintenance" }) : u; })});
      }); });
    }

    // ── Render ───────────────────────────────────────────────────────────────
    var titleMap = { equipment: "Equipment List", containers: "Containers List", kits: "Kits & Packages", availability: "Availability Checker", cross: "Cross Rentals" };

    return h("div", null,
      // Kits renders its own title + search row on mobile, so suppress the shell
      // header there; every other tab keeps the shell title (its only label
      // once the sub-tabs are gone on a phone).
      !(isMobile && activeTab === "kits") && h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } },
        h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: 0 } }, titleMap[activeTab]),
        activeTab === "equipment"  && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/equipment/new"); } }, "+ Add Equipment"),
        activeTab === "containers" && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/containers/new"); } }, "+ Add Container"),
        activeTab === "kits"       && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/kits/new"); } }, "+ Create Kit"),
        activeTab === "cross"      && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/cross-rentals/new"); } }, "+ Cross Rental")
      ),
      activeTab === "equipment"  && isMobile && h(window.LTPFab, { label: "Add equipment", onClick: function() { nav("rentals/equipment/new"); } }),
      activeTab === "containers" && isMobile && h(window.LTPFab, { label: "Add container", onClick: function() { nav("rentals/containers/new"); } }),
      activeTab === "kits"       && isMobile && h(window.LTPFab, { label: "Create kit", onClick: function() { nav("rentals/kits/new"); } }),
      activeTab === "cross"      && isMobile && h(window.LTPFab, { label: "New cross rental", onClick: function() { nav("rentals/cross-rentals/new"); } }),

      activeTab === "availability" && h(window.RentalsAvailabilityView, { equipment: equipment, allocations: allocations, crossRentals: crossRentals || [], vendorRates: vendorRates || [], companies: companies || [], projects: projects || [], onOpenEquipment: openEquip }),
      activeTab === "equipment"   && h(window.RentalsInventoryView,    { equipment: equipment, allocations: allocations, onOpenEquipment: openEquip }),
      activeTab === "containers"  && h(window.RentalsContainersView,   { containers: containers, equipment: equipment, onOpenContainer: openCont }),
      activeTab === "kits"        && h(window.RentalsKitsView,         { kits: kits, equipment: equipment, onOpenKit: function(kid) { nav("rentals/kits/" + kid); } }),
      activeTab === "cross"       && h(window.RentalsCrossView,        { crossRentals: crossRentals || [], companies: companies || [], equipment: equipment, projects: projects || [], onOpen: function(oid) { nav("rentals/cross-rentals/" + oid); } }),

      // Equipment detail popup
      openEq && h(window.RentalsEquipmentDetail, {
        eq: openEq, allocations: allocations, projects: projects || [], vendors: vendors, containers: containers,
        onClose:              function() { nav("rentals/equipment"); },
        onEdit:               function() { editEquip(openEq.id); },
        onDelete:             function() { deleteEquipment(openEq.id); },
        onScan:               function() { nav("rentals/equipment/" + openEq.id + "/scan"); },
        onOpenContainer:      function(cid) { openCont(cid); },
        onMainLog:            function(log, uid) { logMaintenance(openEq.id, log, uid); },
        onMainResolve:        function(lid, uid) { resolveMaintenance(openEq.id, lid, uid); },
        onSetUnderMaintenance:function(uid)      { setUnderMaintenance(openEq.id, uid); },
      }),

      // Barcode scan-import session (serialized equipment only). Each scan
      // persists immediately into equipment.units via addScannedUnit.
      scanEq && scanEq.serialized && h(window.RentalsScanSession, {
        eq: scanEq, existingUnits: scanEq.units || [], vendors: vendors,
        onAddUnit:    function(unit) { addScannedUnit(scanEq.id, unit); },
        onRemoveUnit: function(uid)  { removeScannedUnit(scanEq.id, uid); },
        onClose:      function() { nav("rentals/equipment/" + scanEq.id); },
      }),

      // Container detail popup
      openContainer && h(window.RentalsContainerDetail, {
        container: openContainer, equipment: equipment, containers: containers,
        onClose:              function() { nav("rentals/containers"); },
        onEdit:               function() { editCont(openContainer.id); },
        onDelete:             function() { deleteContainer(openContainer.id); },
        onOpenEquipment:      function(eid) { openEquip(eid); },
        onOpenContainer:      function(cid) { openCont(cid); },
        onMainLog:            function(log, uid) { logContainerMaintenance(openContainer.id, log, uid); },
        onMainResolve:        function(lid, uid) { resolveContainerMaintenance(openContainer.id, lid, uid); },
        onSetUnderMaintenance:function(uid)      { setContainerUnderMaintenance(openContainer.id, uid); },
      }),

      // Add Equipment
      showAddEq && h(window.RentalsEquipmentForm, {
        vendors: vendors,
        onClose: function() { nav("rentals/equipment"); },
        onSave:  function(data) { var newId = saveEquipment(data); nav("rentals/equipment/" + newId); },
      }),

      // Edit Equipment
      editEq && h(window.RentalsEquipmentForm, {
        initial: editEq, vendors: vendors,
        onClose: function() { nav("rentals/equipment/" + editEqId); },
        onSave:  function(data) { saveEquipment(Object.assign({ id: editEqId }, data)); nav("rentals/equipment/" + editEqId); },
      }),

      // Add Container
      showAddContainer && h(window.RentalsContainerForm, {
        equipment: equipment, containers: containers,
        onClose: function() { nav("rentals/containers"); },
        onSave:  function(data) { var newId = saveContainer(data); nav("rentals/containers/" + newId); },
      }),
      editContainer && h(window.RentalsContainerForm, {
        initial: editContainer, equipment: equipment, containers: containers,
        onClose: function() { nav("rentals/containers/" + editContainerId); },
        onSave:  function(data) { saveContainer(Object.assign({ id: editContainerId }, data)); nav("rentals/containers/" + editContainerId); },
      }),

      // Kit detail
      openKit && h(window.RentalsKitDetail, {
        kit: openKit, equipment: equipment,
        onClose:  function() { nav("rentals/kits"); },
        onEdit:   function() { nav("rentals/kits/" + openKit.id + "/edit"); },
        onDelete: function() { deleteKit(openKit.id); },
      }),

      // Add Kit
      showAddKit && h(window.RentalsKitForm, {
        equipment: equipment,
        onClose: function() { nav("rentals/kits"); },
        onSave:  function(data) { var newId = saveKit(data); nav("rentals/kits/" + newId); },
      }),

      // Edit Kit
      editKit && h(window.RentalsKitForm, {
        initial: editKit, equipment: equipment,
        onClose: function() { nav("rentals/kits/" + editKitId); },
        onSave:  function(data) { saveKit(Object.assign({ id: editKitId }, data)); nav("rentals/kits/" + editKitId); },
      }),

      // Cross rental detail
      openCross && h(window.RentalsCrossDetail, {
        order: openCross, companies: companies || [], equipment: equipment, projects: projects || [], vendorRates: vendorRates || [],
        onClose:  function() { nav("rentals/cross-rentals"); },
        onEdit:   function() { nav("rentals/cross-rentals/" + openCross.id + "/edit"); },
        onDelete: function() { deleteCrossRental(openCross.id); },
        onStatus: function(st) { setCrossStatus(openCross.id, st); },
        onOpenEquipment: function(eid) { openEquip(eid); },
      }),

      // New cross rental (prefilled from the checker / quote picker when opened there)
      showAddCross && h(window.RentalsCrossForm, {
        prefill: crossPrefill, vendors: vendors, companies: companies || [], equipment: equipment, projects: projects || [], vendorRates: vendorRates || [],
        onClose: function() { nav("rentals/cross-rentals"); },
        onSave:  function(data) { var newId = saveCrossRental(data); nav("rentals/cross-rentals/" + newId); },
      }),

      // Edit cross rental
      editCross && h(window.RentalsCrossForm, {
        initial: editCross, vendors: vendors, companies: companies || [], equipment: equipment, projects: projects || [], vendorRates: vendorRates || [],
        onClose: function() { nav("rentals/cross-rentals/" + editCrossId); },
        onSave:  function(data) { saveCrossRental(Object.assign({ id: editCrossId }, data)); nav("rentals/cross-rentals/" + editCrossId); },
      })
    );
  };
})();
