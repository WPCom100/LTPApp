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
(function() {
  var h = React.createElement;
  var B = window.LTP_THEME;
  var nav = window.LTPRouter.navigate;

  window.RentalsView = function({ projects, companies, route, equipment, setEquipment, allocations, setAllocations, containers, setContainers, kits, setKits }) {
    var R = window.LTP_RENTALS;
    var isMobile = window.LTP_useIsMobile();

    var vendors = (companies || []).filter(function(c) { return c.isVendor; });

    // ── Route-derived state (NO local state for modals) ─────────────────────
    var sub    = route.sub;
    var id     = route.id;
    var action = route.action;

    var activeTab        = sub === "equipment" ? "equipment" : sub === "containers" ? "containers" : sub === "kits" ? "kits" : "availability";
    var openEqId         = activeTab === "equipment"  && id && !action ? id : null;
    var openContainerId  = activeTab === "containers" && id && !action ? id : null;
    var openKitId        = activeTab === "kits"       && id && !action ? id : null;
    var showAddEq        = activeTab === "equipment"  && action === "new";
    var editEqId         = activeTab === "equipment"  && id && action === "edit" ? id : null;
    var showAddContainer = activeTab === "containers" && action === "new";
    var editContainerId  = activeTab === "containers" && id && action === "edit" ? id : null;
    var showAddKit       = activeTab === "kits"       && action === "new";
    var editKitId        = activeTab === "kits"       && id && action === "edit" ? id : null;

    var openEq        = openEqId       ? equipment.find(function(e) { return e.id === openEqId; })        : null;
    var openContainer = openContainerId? containers.find(function(c) { return c.id === openContainerId; }) : null;
    var openKit       = openKitId      ? kits.find(function(k) { return k.id === openKitId; })             : null;
    var editEq        = editEqId       ? equipment.find(function(e) { return e.id === editEqId; })        : null;
    var editContainer = editContainerId? containers.find(function(c) { return c.id === editContainerId; }) : null;
    var editKit       = editKitId      ? kits.find(function(k) { return k.id === editKitId; })             : null;

    // ── Navigation helpers ───────────────────────────────────────────────────
    function goList()        { nav("rentals/" + (activeTab === "containers" ? "containers" : activeTab === "kits" ? "kits" : "equipment")); }
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
      setContainers(function(prev) { return prev.map(function(c) {
        return Object.assign({}, c, { defaultForEquipment: (c.defaultForEquipment || []).filter(function(x) { return x !== eid; }) });
      }); });
      nav("rentals/equipment");
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
    var titleMap = { equipment: "Equipment List", containers: "Containers List", kits: "Kits & Packages", availability: "Availability Checker" };

    return h("div", null,
      // Kits renders its own title + search row on mobile, so suppress the shell
      // header there; every other tab keeps the shell title (its only label
      // once the sub-tabs are gone on a phone).
      !(isMobile && activeTab === "kits") && h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 } },
        h("h2", { style: { fontSize: "20px", fontWeight: 700, color: B.text, margin: 0 } }, titleMap[activeTab]),
        activeTab === "equipment"  && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/equipment/new"); } }, "+ Add Equipment"),
        activeTab === "containers" && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/containers/new"); } }, "+ Add Container"),
        activeTab === "kits"       && !isMobile && h(window.Btn, { small: true, onClick: function() { nav("rentals/kits/new"); } }, "+ Create Kit")
      ),
      activeTab === "equipment"  && isMobile && h(window.LTPFab, { label: "Add equipment", onClick: function() { nav("rentals/equipment/new"); } }),
      activeTab === "containers" && isMobile && h(window.LTPFab, { label: "Add container", onClick: function() { nav("rentals/containers/new"); } }),
      activeTab === "kits"       && isMobile && h(window.LTPFab, { label: "Create kit", onClick: function() { nav("rentals/kits/new"); } }),

      activeTab === "availability" && h(window.RentalsAvailabilityView, { equipment: equipment, allocations: allocations, projects: projects || [], onOpenEquipment: openEquip }),
      activeTab === "equipment"   && h(window.RentalsInventoryView,    { equipment: equipment, allocations: allocations, onOpenEquipment: openEquip }),
      activeTab === "containers"  && h(window.RentalsContainersView,   { containers: containers, equipment: equipment, onOpenContainer: openCont }),
      activeTab === "kits"        && h(window.RentalsKitsView,         { kits: kits, equipment: equipment, onOpenKit: function(kid) { nav("rentals/kits/" + kid); } }),

      // Equipment detail popup
      openEq && h(window.RentalsEquipmentDetail, {
        eq: openEq, allocations: allocations, projects: projects || [], vendors: vendors, containers: containers,
        onClose:              function() { nav("rentals/equipment"); },
        onEdit:               function() { editEquip(openEq.id); },
        onDelete:             function() { deleteEquipment(openEq.id); },
        onOpenContainer:      function(cid) { openCont(cid); },
        onMainLog:            function(log, uid) { logMaintenance(openEq.id, log, uid); },
        onMainResolve:        function(lid, uid) { resolveMaintenance(openEq.id, lid, uid); },
        onSetUnderMaintenance:function(uid)      { setUnderMaintenance(openEq.id, uid); },
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
      })
    );
  };
})();
