# Live sync — open findings

Produced by an 11-agent adversarial audit (5 subsystem reviewers, 5 batch skeptics
prompted to refute, 1 completeness critic) run at the end of the live-sync work.
Every item below survived a skeptic whose instruction was to refute it and to
default to refuted when uncertain. 12 further findings were refuted and dropped.

**Nothing here is fixed.** The four merged PRs (#38 live sync, #39 editor notices +
unsaved-guard fix, #40 paid-day server guard, #41 all-editor coverage) are in `dev`.
This is what the audit found on top of them.

Counts: 14 confirmed by reviewers, 4 from the critic, 12 refuted.

---

## 1. [CRITICAL] refresh() adopts the server's fresh _rev for rows whose local edit the merge deliberately kept, defeating If-Match

`components/data-state.js:617` — found by reviewer (client-engine)

**How it fails**

Producer has project 5 open in window A with an edit that has not synced yet (inside the 400ms debounce, or a failed-and-pending write). A crew member accepts from their emailed link; backend/routes/crew.py::_respond writes Project.schedule[].positions[].status and publishes the `projects` stamp. A's SSE push fires refresh(). Line 617 runs `revsRef.current = Object.assign({}, revsRef.current, fetched.revs)` unconditionally, so revsRef[5] becomes the POST-accept rev r1. mergeRemote (line 620) then sees row 5 as locally modified (`wasBase !== undefined && !same(wasBase, mine)`) and takes the `out[at[id]] = mine` branch, keeping A's whole pre-accept row and discarding the acceptance from the merged value. prevSyncedRef becomes fetched.rows (line 632), so the next debounced sync diffs and PUTs row 5 with `If-Match: r1` — which is exactly what the server now holds, so backend/routes/api.py::_require_fresh returns without raising. 200 OK, acceptance silently reverted, no 409, no `conflicts` entry, no "Changed in another window" toast, nothing in LTP_API_ERRORS.

**Evidence**

mergeRemote's own comment states the contract: "A row changed on BOTH sides keeps the local edit here and resolves on write, where If-Match turns it into a visible 409 rather than a silent overwrite." That resolution is only possible if the If-Match token still names the revision the local edit was based on. Line 617 overwrites it with the server's newest rev for every row in the response, including the rows mergeRemote is about to resolve in favour of the local copy — so the guard can never fire for precisely the rows it was built for. The fix is to merge fetched.revs only for ids mergeRemote did NOT resolve locally (i.e. skip ids where the local row was kept). This is the exact failure the module docstring says If-Match exists to prevent, and backend/crew_integrity.py::enforce_status_floor only masks it for the one status column family.

**Skeptic's verdict** (tried to refute, could not)

Confirmed in code: data-state.js:617 merges fetched.revs for every id, including the ones mergeRemote (line 619) then resolves in favour of the local row, and line 632 sets prevSyncedRef to fetched.rows — so the already-armed debounce (which reads prevSyncedRef at fire time, line 671) PUTs the local row with the server's own current rev, _require_fresh (backend/routes/api.py:169) passes, and the other window's change to that row is silently overwritten instead of producing the 409 the mergeRemote comment and the module docstring promise; only the position-status family is masked by crew_integrity.enforce_status_floor, so any other field (rates, dates, notes, any non-project collection) is lost with no toast and no LTP_API_ERRORS entry.

---

## 2. [CRITICAL] CRMNoteEditor / CRMNoteViewer early-return before useState crashes the whole Projects module when a note or project is deleted in another window

`modules/crm-notes.js:112` — found by reviewer (editor-coverage)

**How it fails**

Window A opens a project note for editing (#/projects/7, editNote = {projectId:7, noteId:99}); CRMNoteEditor mounts and runs 3 useState hooks + LTP_useRecordWatch. Window B deletes that note (or deletes project 7 entirely). Live sync refetches `projects`, ProjectsView re-renders with a new array, and `editNote` is still truthy so modules/projects.js:323 renders the SAME CRMNoteEditor instance again. This time `project.notes.find(...)` returns undefined and the component hits `if (!note) return null;` at line 114 — before `useState(note.text)` at line 115. React throws "Rendered fewer hooks than expected", LTPErrorBoundary name="Projects" catches it and replaces the entire Projects page with the error screen. The user's typed note text is gone and they cannot get back to the project list without a reload. CRMNoteViewer has the identical shape at modules/crm-notes.js:64 (early return) vs :68 (`useState(false)`).

**Evidence**

These are the only two components in modules/ and components/ with a conditional `return null` positioned before their first hook (verified by scanning every top-level component in modules/*.js and components/*.js). Every other early return in the codebase is either in a hookless component (CRMCompanyDetail, CRMContactDetail) or explicitly placed after all hooks with a comment saying so (modules/projects.js:43-49 documents exactly this hazard for ProjectsView). The parent never unmounts the editor — `editNote` is local ProjectsView state that only a user action clears — so the same fiber really does re-render with a smaller hook count. The LTP_useRecordWatch call added at line 122 (with a pick() that deliberately returns null on deletion, so it would have warned) is unreachable: the early returns preempt it.

**Skeptic's verdict** (tried to refute, could not)

Confirmed in code: modules/crm-notes.js CRMNoteEditor returns null at the `if (!project)` / `if (!note)` guards BEFORE its three useState calls (and before LTP_useRecordWatch), while modules/projects.js:322-323 keeps rendering the same fiber because `editNote`/`viewNote` are local ProjectsView state that a remote delete never clears — so a project/note deleted in another window makes the component render fewer hooks than the previous render, React 18 throws, and the name="Projects" LTPErrorBoundary (app.js:418) blanks the whole Projects page with the typed note lost; CRMNoteViewer has the identical shape.

---

## 3. [HIGH] Client-facing and QuickBooks writes go through get_db but never call mark_dirty — quote accept/decline, email send, PDF stamp, QBO sync, bulk sync

`backend/routes/view.py:449` — found by reviewer (server-stamps)

**How it fails**

`grep -n livesync backend/routes/view.py backend/routes/email.py backend/routes/pdf.py backend/routes/qbo.py` returns nothing. All of these mutate synced collections on a get_db session, so the write commits and `livesync.flush()` finds an empty dirty set:

- view.py:449 `row.status = "accepted"` + client_accepted activity (post_accept); view.py:490 the decline twin.
- email.py:369-370 `entity.receipt_email_status`/`receipt_email_sent_at` plus the email_sent activity entry on the Quote/Invoice.
- pdf.py:58 the pdf-generated activity entry.
- qbo.py:337/352-353/423-430/915 `invoice.qb_sync_status`, `qb_invoice_id`, `qb_last_error`, `quote.qb_tax_signature`.
- api.py:826 `bulk_sync` wipes and repopulates every entity table.

A client clicking Accept on a quote share link is the canonical 'changed behind the producer's back' write — the exact case livesync.py's module docstring says the system exists for — and it produces no push at all. The producer's open window keeps rendering the quote as 'sent' until the 30s sweep happens to run; if they edit that quote in the meantime they get a spurious 409 stale_write instead of seeing the acceptance. Worse, because these paths depend on the sweep alone, they are exposed to the watermark inversion above: if any other quote is saved between the accept transaction's start and its commit (post_accept holds the transaction open across `_notify_quote_response` → webpush HTTP at view.py:451), the acceptance never surfaces at all.

**Evidence**

Verified by grep: `livesync` is imported only in backend/routes/api.py and backend/routes/crew.py. get_db (backend/database.py:62) publishes only what `take_dirty` returns, so an unmarked session broadcasts nothing.

**Skeptic's verdict** (tried to refute, could not)

Confirmed real: `grep` shows livesync is imported only in backend/routes/api.py and backend/routes/crew.py, so view.py:449/490 (quote accept/decline), email.py:369-370 (receipt_email_status + email_sent activity), pdf.py's pdf_generated entry, qbo.py:352-353/423-430/915 and api.py:826 bulk_sync all commit through get_db with an empty dirty set and publish nothing — a client accepting a quote (the case livesync.py's own docstring is written around) leaves every open window rendering it as 'sent' for up to the 30s sweep, and any producer edit to that quote inside that window comes back 409 stale_write whose handler adopts the server row and logs `discardedLocalEdit` (components/data-state.js:388-396), i.e. the producer's edit is silently thrown away.

---

## 4. [HIGH] DELETE bypasses the paid-day guard entirely — a project whose days are paid in QuickBooks can be destroyed with no 409, no override header and no admin check

`backend/routes/api.py:473` — found by reviewer (write-guards)

**How it fails**

Project 12 has crew days that were billed and paid (PayoutBill.qb_paid_at set, PayoutBillLine rows for those (contact_id, 12, date)). A producer opens Projects → Delete. modules/projects.js:141 raises the delete wizard because the schedule still has confirmed positions. Step 1 "Release Crew" (modules/projects.js:153-178) rewrites every confirmed position to {status:"open", crewId:null} and saves; that PUT correctly trips payouts.paid_day_conflicts (the crewId key disappears from `after`, so before != after) and is refused with 409 paid_day_conflict. Nothing in modules/projects.js listens for the `ltp-paid-day-conflict` event (only modules/schedule-builder.js:187-197 does, and it filters on its own project id), so the wizard simply sets crewReleased:true and enables the final button. wizardFinalDelete (modules/projects.js:217) drops the row from state, data-state.js:331-334 issues DELETE /api/projects/12, and `remove()` runs reconcile_project + db.delete with NO call to payouts.paid_day_conflicts and no _paid_day_override check. The Project.schedule JSON that is the ONLY server-side record of what was paid (payouts.load_projects_and_crew re-derives every payout view from it) is gone, while the QuickBooks bill and the PayoutBillLine ledger remain — the exact app-vs-accounts divergence the paid-day guard exists to prevent, reached by the same wizard the guard just blocked.

**Evidence**

remove() (backend/routes/api.py:473-492) contains only the crew_integrity.reconcile_project call and db.delete(row). payouts.paid_day_conflicts is referenced exactly once in the file, at line 419 inside update(). The paid-day docstring in backend/payouts.py:305-314 calls the server check "THE enforcement" that makes the client's stale paidDays map harmless, but it is only wired into PUT.

**Skeptic's verdict** (tried to refute, could not)

Confirmed in code: backend/routes/api.py::remove (473-492) calls only crew_integrity.reconcile_project + db.delete, and payouts.paid_day_conflicts appears exactly once in the file (line 419, inside update), so the delete wizard in modules/projects.js — whose step-1 wizardReleaseCrew PUT is correctly 409'd by the paid-day guard (and nothing in projects.js listens for `ltp-paid-day-conflict`; only schedule-builder.js:195 and labor.js:2076 do) — still enables wizardFinalDelete (line 217), which DELETEs the project and destroys the Project.schedule that payouts.load_projects_and_crew re-derives every paid day from, while the PayoutBill/PayoutBillLine rows for those days stay behind: the guard that update() calls "THE enforcement" is bypassed by the same wizard it just blocked.

---

## 5. [HIGH] _rev is computed over server-authoritative _READONLY_COLS, so a QuickBooks push invalidates the client's If-Match token and the very next write 409s and discards the user's edit

`backend/routes/api.py:150` — found by reviewer (write-guards)

**How it fails**

User opens invoice 40 and clicks "Send to QuickBooks". backend/qbo_sync.py:1148-1149 sets invoice.qb_sync_status="synced" and qb_synced_at (plus qb_invoice_id, qb_sync_token, qb_total_amt, qb_tax_total, qb_synced_signature). All of those are real columns, none is in _HIDDEN_COLS, so _row_to_dict includes them and _row_rev hashes them — the row's _rev changes. modules/invoices.js:1291-1297 then mirrors the returned qb* fields into state via setInvoices, which makes the row differ from prevSyncedRef, so data-state.js:363-366 issues PUT /api/invoices/40 carrying revsRef's PRE-push _rev as If-Match. _require_fresh (api.py:169-201) compares it against the post-push _rev, they differ, and it raises 409 stale_write. data-state.js:388-397 treats that as "someone else wrote this row", records discardedLocalEdit, and data-state.js:691-699 replaces the local row with the server row — so anything the user typed since the last successful sync (terms, PO number, a line item) is silently reverted — and a misleading "Changed in another window" toast fires (data-state.js:701) on every single QuickBooks push. The client cannot recover the fresh rev in time either: backend/qbo_sync.py and backend/qbo_receipts.py never call livesync.mark_dirty (grep shows mark_dirty only in routes/api.py and routes/crew.py), so no stamp is pushed and no refetch is triggered until the 30s sweep.

**Evidence**

_row_to_dict (api.py:144-151) skips only _HIDDEN_COLS = {created_at, updated_at}; every _READONLY_COLS entry (api.py:63-76) is hashed into _rev even though _dict_to_row (api.py:210) strips those same columns from any incoming write, so the client provably cannot be the cause of the change and its PUT is a no-op on those fields. The guard rejects a write that conflicts with nothing the client can touch.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: _row_to_dict (api.py:144-151) skips only _HIDDEN_COLS, so every _READONLY_COLS value is hashed into _rev, and a QuickBooks push (qbo_sync.py:1148-1149 sets qb_sync_status/qb_synced_at plus the qb_* block, committed by the route, with no livesync.mark_dirty anywhere in qbo_sync.py) changes the stored _rev while the client's revsRef still holds the pre-push token; modules/invoices.js:1291-1297 (and persistAndPushQbo:1348-1350) then setInvoices the qb-patched row, data-state.js:363-366 PUTs it with the stale If-Match, and _require_fresh 409s — data-state.js:388-397/691-701 adopts the server row and fires a false "Changed in another window" warning on every push, and in the sendToQuickBooks path (which does not save first and sets cleanRef/isDirty=false) that adoption silently reverts the user's unsaved editor edits via LTP_useRemoteEdits, all over columns _dict_to_row (api.py:210) strips from the incoming write anyway.

---

## 6. [HIGH] skipNextSyncRef is left stuck true when the initial GET fails, so the user's next edit is silently never synced

`components/data-state.js:556` — found by reviewer (client-engine)

**How it fails**

GET /api/projects fails on load (502 during a Railway redeploy, network blip, or any non-2xx). fetchCollection resolves null, so line 556 sets `adopted = fallback` — and `fallback` is `window.LTP_DATA_PROJECTS`, the very same object reference `useState(fallback)` initialised state with. Line 559 sets skipNextSyncRef.current = true and line 560 calls setValue(adopted); React's Object.is bailout means `value` keeps the identical reference, so the `[value]` effect at line 660 never re-runs and never consumes the flag. (setReady(true) does force a render, but the deps array is unchanged so the effect is still skipped.) The user sees an empty project list plus an error toast, creates a project, and the change-effect finally runs — hits `if (skipNextSyncRef.current) { skipNextSyncRef.current = false; return; }` at line 661 and returns before the debounce is ever armed. No POST is sent, no error is recorded. If the user closes the tab (or switches to a tab that re-renders from server data) the new project is gone with no indication it was never saved. Only a SECOND edit re-diffs from the fallback baseline and pushes both.

**Evidence**

The flag check at line 661 sits ahead of every other guard, and it is the only consumer of skipNextSyncRef. The mount path guarantees the flag is set to true immediately before a setValue that is provably a no-op on this branch: entity fallbacks in app.js:164-182 are stable module globals (data/projects.js:1 `window.LTP_DATA_PROJECTS = []`), passed by reference to both useState and the effect closure. The settings branch is immune because adoptSettings always builds a new object; only the 13 entity collections are exposed, and only on the fetch-failure / non-array branch. The invariant comment at line 470-476 assumes "The change-effect consumes (and resets) the flag exactly once per occurrence" — that assumption is violated whenever setValue is handed the current reference.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: the entity fallbacks really are stable module globals (data/projects.js:1 `window.LTP_DATA_PROJECTS = []`, passed by reference at app.js:164-182), so on the fetch-failure branch line 556 sets adopted to the identical reference React state already holds, setValue at line 560 is a no-op for the `[value]` effect, and skipNextSyncRef set at line 559 is never consumed — the user's next edit hits line 661, returns before the debounce is armed, and is never POSTed or recorded anywhere (only a second edit re-diffs from the fallback baseline and pushes both).

---

## 7. [HIGH] `recycling` is never cleared after a scheduled stream recycle, so the next real SSE failure is swallowed entirely

`components/live-sync.js:225` — found by reviewer (client-engine)

**How it fails**

backend/livesync.py::event_stream yields `_frame("bye", ...)` and then `return`s, so the client receives the bye message and the connection then EOFs. The bye handler (line 212) sets `recycling = true` and calls `es.close()`. Per the EventSource spec the reconnect task queued by the EOF aborts when readyState is already CLOSED, so no `error` event is ever dispatched for that stream — `recycling` stays true for the rest of the page's life (a tab open longer than MAX_STREAM_SECONDS = 30 min always ends up in this state). The next genuine stream failure — uvicorn restarting, the proxy cutting the connection — hits `if (recycling) { recycling = false; return; }` at line 225 and is swallowed whole: es is not closed, `source` still points at the dead EventSource, sseFailures is not incremented so startPolling() is never reached, and scheduleReconnect() is never called. Because connect() bails at line 182 on `if (source ...) return` and the visibilitychange recovery is gated on `if (!source)` at line 292, nothing in this module can re-open the stream. If the browser's own retry then stalls in CONNECTING (server accepting TCP but not answering, which is what a restarting container behind a proxy looks like), the window receives no push and no poll — it never learns about another change again unless the user re-focuses the tab, which is the only remaining path that calls revalidate().

**Evidence**

The bye handler is the only writer that sets recycling = true and the error handler at line 225 is the only writer that clears it; the code comment ("A recycle closes the socket itself, which also fires error") assumes an error event that close() provably suppresses. LTP_LIVE.status() will report `connected: true, polling: false, sseFailures: 0` in this state, so it looks healthy. Clearing the flag in the bye handler (or on the next `open`) rather than relying on a follow-up error is the fix.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: the bye handler (live-sync.js:212-220) sets recycling = true and calls es.close(), which per spec aborts the reconnect task the EOF queued so no error event ever clears it, and the flag is module-scoped, so the next genuine failure on the *new* stream is swallowed at line 225 without closing es, incrementing sseFailures, starting polling or scheduling a reconnect; when that failure is a non-retryable one (any non-200 — a proxy 502 during a redeploy, a 429 from the /api/stream rate-limit bucket) the EventSource stays CLOSED while `source` remains truthy, so connect() bails at line 182 and the visibilitychange recovery at line 292 never fires — the window silently stops receiving pushes with status() still reporting connected:true, sseFailures:0.

---

## 8. [HIGH] ManualShiftModal rebuilds the entire schedule array from a project copy captured when the modal opened, and its pick() excludes exactly the fields it clobbers

`modules/labor.js:728` — found by reviewer (editor-coverage)

**How it fails**

A producer clicks a manual shift's name on the Payouts tab (modules/labor.js:1201) — `setEditManualProject(pgProject)` stores a snapshot of the project object at that instant. While the modal is open, a crew member accepts their emailed request for that shift, so the server flips schedule[0].positions[n].status to "accepted" and live sync pushes the new project row. The producer changes the shift's end time and saves. updateManualShift (line 728-745) reads `var proj = editManualProject` (the stale snapshot), builds `newSchedule` from `proj.schedule` — including its stale positions and pay stamps — and writes `schedule: newSchedule` onto the live `prev` row. The acceptance is silently reverted to "open", and LTP_diffChangedShifts at line 746 also diffs against the stale `before`, so the notify tray gets the wrong crew list. No warning fires, because the pick() at modules/labor.js:455-458 returns only [p.name, p.startDate, p.venue, sh.title, sh.date, sh.time, sh.endTime, sh.notes] — positions are not in it.

**Evidence**

The pick()'s own comment says positions are excluded because "a crew member accepting there must not look like someone editing this form's shift out from under it" — which would be correct if the save left positions alone, but line 738-744 replaces the whole schedule array from the captured copy, not a surgical merge. Same for two fields the modal genuinely owns: it writes `siteAddress: form.location` (line 741) and `breaks` into shift0 (line 735), yet the pick watches `p.venue` (which LTP_manualShiftProject always sets to "" for internal projects, theme.js:996) and omits both `p.siteAddress` and `sh.breaks`. So a location or meal-break change made in another window is overwritten with no warning either.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: setEditManualProject(pgProject) (modules/labor.js:1201/1203) captures the project object at click time and updateManualShift (labor.js:728-745) rebuilds `schedule` wholesale from that snapshot onto the live row — the specific 'acceptance reverted to open' claim is actually healed server-side by crew_integrity.enforce_status_floor (wired at backend/routes/api.py:392), but a crewId assignment made meanwhile on the Assignments tab (labor.js:1299/1303, different crewId so the floor guard passes it through), the shift's `breaks`, `siteAddress`, and an admin's `work` pay snapshot are all silently clobbered, and the pick() at labor.js:455-458 watches `p.venue` (always "" for internal projects, theme.js:997) instead of `p.siteAddress` and omits `sh.breaks`, so no warning fires and If-Match cannot catch it (the row's _rev is already fresh after the live-sync refetch).

---

## 9. [HIGH] LTP_useRecordWatch's resetKey embeds the id, so deletion of a row whose `initial` is looked up live wipes the seen baseline instead of warning; the form then keeps accepting edits and saves nothing

`theme.js:266` — found by reviewer (editor-coverage)

**How it fails**

Window A opens #/projects/7/edit. modules/projects.js:313 passes `initial: projects.find(p => p.id === 7)`, and CRMProjectForm calls LTP_useRecordWatch("projects", initial && initial.id) (modules/crm-projects.js:297). Window B deletes project 7. Live sync refetches, `initial` becomes undefined, so the watch's id becomes null and the resetKey flips from "projects:7" to "projects:null". Because LTP_useRemoteEdits declares the reset effect FIRST (theme.js:157-160), it lands before the compare effect in the same commit and sets seenRef.current = null; the compare effect at theme.js:163 then sees `!record` with `seenRef.current === null` and returns without ever emitting the " deleted" notice. The form silently mutates in place — title becomes "Create Project", the Status select and schedule panel disappear, the button relabels to "Create Project" — and clicking it runs the EDIT onSave (modules/projects.js:316), whose `prev.map(x => x.id === editProjectId ? ... : x)` matches nothing. Nothing is created, nothing is saved, and the following nav() lands on a detail route with no row behind it. modules/crm-shell.js:250 (company edit) is identical.

**Evidence**

The "row deleted in another window — which is very much worth saying" branch at theme.js:166-169 is dead for every call site that derives its id from the record itself, which is all of the URL-driven edit forms. It only fires where the id survives the deletion: crm-notes.js:122 (id from ctx.editNote) and labor.js:246/452 (id from a captured state copy). The other live-lookup forms (components/entity-quick-form.js:326, modules/crm-contacts.js via CRMContactDetail:9) avoid the broken warning only because their parent returns null and unmounts the form outright — which also discards the user's typing with no message.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: LTP_useRecordWatch builds resetKey as collection+":"+id (theme.js:275) from `initial && initial.id` (modules/crm-projects.js:297), so a remote delete flips the key, the reset effect (declared first, theme.js:309-312) nulls seenRef before the compare effect runs, and the deleted branch at theme.js:315-321 returns silently; CRMProjectForm then morphs in place (title/Status select/schedule panel/button all gated on `initial`) into a 'Create Project' form whose click still runs the edit onSave (modules/projects.js:316), whose `p.map(x => x.id === editProjectId ...)` matches nothing — the user's edits vanish with no message and no row created.

---

## 10. [HIGH] SSE stream subscribes only after its snapshot is computed and the session commits — a write landing in that window is never pushed

`backend/routes/api.py:635` — found by reviewer (lifecycle-infra)

**How it fails**

`stream_changes` computes `initial = await livesync.ensure_seeded(db)` (api.py:635), then `await db.commit()` (api.py:636, a real round trip to Postgres), then exits the `async with async_session()` block and returns a `StreamingResponse`. `livesync.event_stream` is an async *generator*: its first statement `q = subscribe()` (livesync.py:422) does not execute until Starlette pulls the first chunk, several awaits later. Any `livesync.flush()` broadcast from another request that lands between the snapshot and the subscribe is fanned out to the existing subscribers only — this connection is not in `_subscribers` yet, and the snapshot it was already handed is pre-write. Concretely: window A opens a tab; while its `/api/stream` handshake is inside `await db.commit()`, window B PUTs a project. A's snapshot carries the old projects stamp, A never receives the frame for B's write, and because `refresh()` in components/data-state.js only fires on a stamp *change*, A shows the pre-write project row. The sweep cannot rescue it — `sweep_once` compares against `_stamps`, which B's flush already updated, so `after == before` and nothing is broadcast. A stays wrong until the next write to `projects`, a focus/visibilitychange revalidate, or the 30-minute stream recycle. I reproduced it against the real app: patching `ensure_seeded` to simulate a concurrent flush, the client's snapshot came back `1788064018000000:4:0` while the server's live stamp was the moved value — a silently missed update. Fix: call `subscribe()` before computing the snapshot (or pass the queue in and register it inside the route).

**Evidence**

Verified by running GET /api/stream through the app's own ASGI stack with a broadcast injected between ensure_seeded and the generator's first step; the delivered snapshot did not match livesync.current_map(). The window is not theoretical — it spans a full DB COMMIT round trip plus session teardown plus FastAPI/middleware response setup, all on the single event loop where the concurrent write's post-commit flush runs.

**Skeptic's verdict** (tried to refute, could not)

Confirmed in real code: api.py:635 copies the stamp map, then does a full `await db.commit()` round trip and response setup before livesync.py:422 registers the queue, so a concurrent post-commit `flush()` in that window reaches every subscriber except the connecting window — which then holds pre-write rows next to a matching stale stamp, and since data-state's refresh() only fires on a stamp change and sweep_once sees `after == before`, that window keeps showing stale data until an unrelated collection's broadcast, a sibling tab's BroadcastChannel ping, a focus/visibility revalidate, or the 30-minute recycle rescues it (the finding overstates the persistence, but the missed-notification race and its one-line fix are real).

---

## 11. [HIGH] A failed initial GET records the live stamp anyway, so that collection never refetches for the life of the page

`components/data-state.js:542` — found by completeness critic (critic)

**How it fails**

A window loads. `LTP_LIVE.ready()` (GET /api/versions) succeeds, so every hook gets a real stamp. Then all ~14 collection GETs fire at once (each `usePersistentState` mount effect fires the moment the shared `ready()` promise resolves) against a pool of 15 connections (`create_async_engine` in backend/database.py:39 sets no pool_size/max_overflow, so 5+10). One of them — say GET /api/contacts — returns 500 / times out / drops mid-response. `fetchCollection` swallows it and resolves null, line 556 sets `adopted = fallback` (an empty array from data/contacts.js), and the loading gate lifts. The window now shows ZERO contacts. Nothing ever fixes it: line 542 already set `stampRef.current = lv.stampFor('contacts')` BEFORE the fetch and never rolls it back on failure, so the `refresh()` guard at line 591 (`if (stampNow === stampRef.current) return; // already current`) short-circuits on every subsequent stamp map. SSE is connected and healthy; `revalidate()` on focus/visibility finds no stamp change and fires no notify. The contacts list stays empty until somebody happens to write to contacts (which moves the stamp) or the user hard-reloads. Every project's client name, every crew picker and the whole Crew Roster render blank in the meantime.

**Evidence**

The refetch path in the same file is written the other way round and knows why: line 604 is `if (!fetched) return; // failed; the stamp stays stale so we retry` and only line 605 advances `stampRef`. The hydration path at line 542 advances the stamp unconditionally, before the fetch, and the `finally` at line 572 that calls `refreshFnRef.current()` cannot recover it because `refresh()` compares against that already-advanced stamp. The known finding about `skipNextSyncRef` being stuck true after a failed initial GET is a different consequence of the same failed hydration (it breaks the WRITE path); this one silently pins the READ path.

---

## 12. [HIGH] Silent unmount destroys unsaved schedule work when the project is deleted in another window

`modules/projects.js:51` — found by completeness critic (critic)

**How it fails**

Producer A has #/projects/7/schedule open with an hour of unsaved schedule edits (ScheduleBuilder keeps them in its local `draft` + `isDirty`, and only writes to persisted state on Save). Producer B deletes project 7. Live sync pushes the projects stamp, data-state refetches, and row 7 is gone from the array. On the next render `projects.find(...)` at line 50 returns undefined, the `if (schedProject)` guard at line 51 fails, and ProjectsView falls through and renders the project LIST instead. ScheduleBuilder unmounts mid-edit: the draft is gone, `LTP_useUnsavedGuard`'s unmount effect (theme.js) resets `window.__LTP_UNSAVED = false`, and A is dumped on the list with no dialog, no toast and no explanation.

**Evidence**

Two safety nets that exist for exactly this both miss it. (1) `LTP_useRemoteEdits` has a dedicated deleted-record branch (theme.js: `incoming = " deleted"` when `!record`) that ScheduleBuilder wires up at modules/schedule-builder.js:86-91 — but it can never fire, because the parent stops rendering the child in the same commit, so the child's `[record]` effect never runs. (2) `mergeRemote`'s "Deleted in another window" toast (components/data-state.js, `removedOut`) only fires for a row that was locally edited IN THE PERSISTED ARRAY; the builder's edits live in a local draft, so `same(wasBase, mine)` is true, the row is skipped, and no toast is emitted. The quote and invoice builders do NOT have this hole — modules/invoices.js:2669 and modules/quotes-shell.js:63 route purely on `route.id` and stay mounted, so their `LTP_useRemoteEdits(isNew ? null : invoices.find(...))` reaches the deleted branch and warns. ProjectsView is the one existence-gated caller.

---

## 13. [MEDIUM] A stamp map that arrives after the hooks have already fetched is seeded silently, so the writes in between are invisible until the next unrelated change

`components/live-sync.js:116` — found by reviewer (client-engine)

**How it fails**

start() races the seeding revalidate() against READY_TIMEOUT_MS (line 278-281), and revalidate() swallows every failure into `return []` (line 149) without setting `seeded`. So on either a slow /api/versions (cold Railway container recomputing 15 collections through ensure_seeded) or a failed one (a 502 during a redeploy — exactly when windows reload), ready() resolves with `seeded === false` and an empty stamp map. Every usePersistentState hook then fetches blind at T_fetch with stampRef.current = undefined. The seed arrives later at T_seed — from the delayed /api/versions response, or from the SSE snapshot frame event_stream() emits on connect. applyStamps takes the `if (!seeded)` branch at line 116, records every stamp and returns [] WITHOUT calling notify. Any write another window or the crew-accept endpoint committed in (T_fetch, T_seed] is now baked into the stamp the client trusts, while the client holds pre-write rows. Nothing re-checks: the hydration mitigation at data-state.js:572 calls refresh(), but refresh() returns immediately on `if (stampNow === undefined) return` because in this scenario the stamps have not landed yet. The window stays wrong until some further, unrelated write moves that collection's stamp again — hours or days in a 2-3 user tool.

**Evidence**

applyStamps' first-map rule is documented as safe because "nothing has been fetched against an older stamp yet — data-state.js waits on ready() precisely so that stays true." The READY_TIMEOUT_MS escape hatch and revalidate()'s error swallow both break that premise by design, and the seeding branch has no compensating notify. Making applyStamps diff (rather than silently seed) when the seed is known to have landed after the hooks fetched, or having the hydration mitigation re-run once the seed actually resolves, would close it.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: revalidate() swallows failures into `return []` (line 149) and READY_TIMEOUT_MS (line 278-281) resolves ready() without stamps, so hooks fetch with stampRef undefined; when the stamp map finally lands applyStamps takes the `if (!seeded)` branch (line 116) and returns without notify, and the documented mitigation at data-state.js:569-572 is a no-op because refresh() bails on `stampNow === undefined` — nothing else re-fetches on seed (only labor.js subscribes, and focus revalidations see no diff), so a window that boots during a backend blip (fetch failed or a write landed between fetch and seed) holds stale/empty rows against a trusted stamp until some unrelated later write moves that collection.

---

## 14. [MEDIUM] FeeQuickNamesEditor seeds from settings once and writes the whole list back with no record watch, dropping another window's additions

`modules/quotes-fees.js:117` — found by reviewer (editor-coverage)

**How it fails**

Admin A opens Quotes → Fees. `useState(function() { return window.LTP_feeQuickNames(settings); })` captures the list at mount and is never re-seeded — there is no LTP_useRecordWatch/LTP_useRemoteEdits anywhere in this component. Admin B adds "Rush Fee" to the quick-add names; live sync pushes the new settings blob, and A's `settings` prop updates but `names` does not. A then adds "Overnight" and blurs the field: commitBlur → persist(namesRef.current) → setSettings(prev => Object.assign({}, prev, {feeQuickNames: normalized})) writes A's stale list plus "Overnight". "Rush Fee" is gone, with no warning at any point.

**Evidence**

This is the only setSettings/setFees/setProducts/... call site among the 108 collection writes in modules/ and components/ that writes a field from state captured earlier with no guard of any kind. The functional `prev =>` form protects the rest of the settings blob but not feeQuickNames itself, which is replaced wholesale. The fix is one line — LTP_useRecordWatch("settings", null, ...) works on the singleton branch at theme.js:257 — and the sibling editor in modules/settings.js:193 already uses LTP_useRemoteEdits for exactly this blob.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: modules/quotes-fees.js:117 seeds `names` from a lazy useState initializer that never re-runs and the component has no LTP_useRecordWatch/LTP_useRemoteEdits, so persist() (line 122-123) writes the whole stale feeQuickNames array back over the live settings blob — the server's shallow key merge replaces that key entirely, silently dropping a name another admin added, with no adopt and no warning.

---

## 15. [MEDIUM] Uvicorn's graceful shutdown blocks on open SSE streams for up to 30 minutes, so every deploy ends in SIGKILL

`railway.json:5` — found by reviewer (lifecycle-infra)

**How it fails**

The start command is `uvicorn backend.main:app --host 0.0.0.0 --port ${PORT:-8000}` with no `--timeout-graceful-shutdown`, and nothing sets `timeout_graceful_shutdown` anywhere in the repo. In uvicorn 0.34.2, `Server.shutdown()` calls `connection.shutdown()` on each open connection — which for an in-flight response only sets `cycle.keep_alive = False` and does NOT close the transport — then does `await asyncio.wait_for(self._wait_tasks_to_complete(), timeout=None)`, spinning until `server_state.connections` is empty. `livesync.event_stream` has no shutdown hook; it only exits on client disconnect or its own `MAX_STREAM_SECONDS` deadline (default 30*60). So with even one browser window open, SIGTERM makes uvicorn wait up to 30 minutes: it stops accepting connections, the lifespan `finally` in backend/main.py:180-189 (which cancels `_session_sweeper_loop`, both QBO pollers and `livesync.sweeper`) never runs, and Railway SIGKILLs the container when its grace window expires. Every deploy is therefore a hard kill with in-flight requests aborted mid-transaction rather than the graceful drain the lifespan block was written to provide.

**Evidence**

Confirmed against the installed uvicorn 0.34.2 source (server.py `shutdown` / `_wait_tasks_to_complete`, config default `timeout_graceful_shutdown: int | None = None`) and httptools_impl's `shutdown()`, which leaves a streaming response's transport open. MAX_STREAM_SECONDS defaults to 1800 in backend/livesync.py:156 and event_stream has no should_exit check.

**Skeptic's verdict** (tried to refute, could not)

Confirmed against the installed uvicorn 0.34.2 and the repo's start command: with no `--timeout-graceful-shutdown` and `timeout_graceful_shutdown` defaulting to None, `connection.shutdown()` leaves a streaming response's transport open, so `_wait_tasks_to_complete()` spins until every open `/api/stream` hits its 1800s deadline — one open browser tab makes SIGTERM hang the container (holding its Postgres pool and running the sweeper/pollers on a dead deployment) until the platform SIGKILLs it, and the lifespan `finally` drain never runs.

---

## 16. [MEDIUM] A 409 stale_write leaves the one-shot paid-day override armed, so it leaks onto the next write of that row

`components/data-state.js:389` — found by completeness critic (critic)

**How it fails**

Producer edits a day on project 7 in the schedule builder and saves. The server refuses with 409 paid_day_conflict; the dialog opens and the producer confirms, which calls `armWrite('projects', 7, {X-LTP-Paid-Day-Override: 1})` (modules/schedule-builder.js:174) and re-saves. This second PUT loses a different race and comes back 409 stale_write, because the other producer saved project 7 in between. The handler at lines 387-397 records the conflict, adopts the server row, discards the local edit and `return true` — but never calls `disarm(key, id)`; `disarm` is only wired to the success path at line 367. The override stays live for the full ARM_TTL_MS of 120s (line 142). Within those two minutes the producer makes a fresh, different edit that also reprices a paid day and saves; `peekArmed` (line 366) attaches the stale override header, the server skips the 409 entirely, applies the paid-day change with no prompt, and logs `payout-integrity: user ... overrode N paid-day change(s)` for a confirmation the producer never gave for that edit.

**Evidence**

The armed-header contract is stated in the file's own comment block (lines 138-141): "Armed headers expire, and clear on a successful write, so a confirmation can never leak onto an unrelated later save." The stale_write branch breaks it — it is the one 409 path treated as *handled* (`return true`, not a failure) while the write it was armed for was in fact discarded, so the confirmation outlives the edit it belonged to. backend/routes/api.py's `_paid_day_override` is a pure header check with no correlation to which change was confirmed, so nothing server-side catches the mismatch.

---

## 17. [MEDIUM] A failed refetch is never retried, contradicting the comment that says it is

`components/data-state.js:604` — found by completeness critic (critic)

**How it fails**

A crew member accepts from their emailed link. The server publishes the projects + crew-requests stamps, `applyStamps` fires `notify('projects')`, and the hook's `refresh()` issues GET /api/projects — which fails (one 502 from Railway's edge, a dropped connection, or one of the several concurrent collection GETs that a multi-collection stamp change kicks off in every open window exhausting the 15-connection pool). Line 604 correctly declines to advance `stampRef`, but nothing ever re-fires: `refresh` is only invoked from `lv.subscribe(key, refresh)`, and live-sync.js has ALREADY stored the new stamp in its own `stamps` map, so no further `notify('projects')` will ever be emitted for that value. `revalidate()` on focus/visibility/pageshow re-reads the same map and sees no change. The producer's Labor tab keeps showing the position as `requested` — the exact stale-acceptance bug the whole system exists to fix — until some unrelated later write moves the projects stamp again.

**Evidence**

The comment on that line asserts a retry ("the stamp stays stale so we retry") that no code implements. The only retry mechanism in the module is `refreshAgainRef` (line 603), which is set only when a stamp change lands *while a refresh is already in flight* — not when one fails. A single dropped request is enough to silently strand a collection until the next unrelated change to it.

---

## 18. [LOW] The `recycling` flag is never cleared by the recycle itself, so the first real SSE failure after any recycle is swallowed

`components/live-sync.js:225` — found by reviewer (lifecycle-infra)

**How it fails**

On a `bye` frame the handler sets `recycling = true`, calls `es.close()`, then `connect()` (lines 212-220). Because the client closes the EventSource itself, the browser fires no `error` on that socket (a CLOSED EventSource emits nothing), so `recycling` stays true indefinitely — the flag is only ever reset inside the error handler. The next genuine failure, on the *new* connection, hits `if (recycling) { recycling = false; return; }` (line 225) and is dropped: `es.close()` is skipped, `source` is left pointing at the dead EventSource, `sseFailures` is not incremented, and `scheduleReconnect()` is not called. Control passes to the browser's own fixed-interval EventSource retry — exactly the 'reconnect storm' the module's BACKOFF comment (lines 58-63) says it closes the socket to avoid. Failure case: a tab has been open 30+ minutes (so at least one recycle happened) and a deploy restarts the backend at the moment its stream reconnects — that window retries at the browser's default ~3s cadence with no backoff and no jitter against a down server, and never counts the failure toward `SSE_GIVE_UP_AFTER`, so the polling fallback is not armed either. It self-corrects on the second failure, but that is one extra unthrottled retry loop per window per outage.

**Evidence**

EventSource semantics: close() sets readyState to CLOSED and suppresses further events, so the bye handler's own close() prevents the error that would clear `recycling`. The error handler's early return provably skips close(), the failure counter, startPolling() and scheduleReconnect() — all four recovery steps — for that one event.

**Skeptic's verdict** (tried to refute, could not)

Confirmed: the `bye` handler at live-sync.js:212-220 closes the EventSource itself, and a CLOSED EventSource fires no error, so `recycling` — cleared only inside the error handler — stays true past the recycle and makes the next genuine failure on the new connection hit the early return at line 225, skipping `es.close()`, the `sseFailures` increment, `startPolling()` and `scheduleReconnect()`, so a tab open longer than 30 minutes falls back to the browser's fixed ~3s unjittered retry for one cycle and arms the polling fallback one failure late.

---

## Refuted and dropped

Recorded so nobody re-derives them. Each was judged not-real by a skeptic that read the code:

- **Sweep's max(updated_at) watermark is non-monotonic on Postgres (func.now() is transaction-start time), so an out-of-order commit is permanently invisible** — The mechanism is stated correctly (PG now() is transaction_timestamp, and livesync.refresh() line 233 `continue`s on an unchanged body), but the failure it describes is a coincidence race that the app cannot realistically hit and that self-heals: the receipt poller runs every 2 hours (main.py:93, QBO_RECEIPT_POLL_INTERVAL default 2*3600) and only holds a long transaction for the handful of invoices that actually get a receipt emailed, so the exposure is a few seconds per two hours, it requires a producer PUT to /api/invoices to commit inside exactly that window, AND it requires no further write to the invoices table afterwards — the very next invoices write (or any page load, which refetches every collection) republishes the stamp and delivers the missed row; the bill poller's long transaction writes only PayoutBill, which is not in _COLLECTION_MODELS at all, so it cannot produce this at all.
- **PUT/DELETE /api/projects marks crew-requests dirty unconditionally, discarding reconcile_project's change list — every project save forces every window to re-GET /api/crew-requests** — The mechanism is right (explicit mark_dirty bumps _seq even when the body is unchanged) but this is a deliberate, documented over-publish, not a defect: api.py:469-470 carries the comment explaining that reconcile_project can trim or auto-withdraw crew requests, and tests/test_livesync.py:154 pointedly omits "crew-requests" from the list of collections that must not move on a project write — the cost is one extra small GET /api/crew-requests in the windows that actually have the Labor tab mounted (modules/labor.js:2811/2831), no window ever ends up holding wrong state, and no refetch loop is possible because list_crew_requests gates its own mark_dirty on reconcile_all reporting a change.
- **GET /api/crew/{token} heals project position statuses but marks only crew-requests dirty — the collection that changed gets no push, the one that didn't gets a phantom one** — The code reading is accurate (reconcile_one → _heal_position_statuses can flag_modify project.schedule while crew.py:574 marks only "crew-requests"), but the concrete scenario offered — 'a stale producer save reverted their positions to open' — is exactly what crew_integrity.enforce_status_floor already prevents at the PUT (api.py:382-388 restores any same-crew status regression before the write lands), so the heal-only branch is residual cleanup for pre-guard drift rather than a live path, and when it does fire the project's updated_at moves normally so the 30s sweep publishes it — the harm is a bounded delay plus one wasted crew-requests refetch, not a state the app cannot recover from.
- **SSE snapshot is captured before the subscriber queue is registered; a broadcast landing in that gap is lost and the sweep cannot recover it** — The ordering gap between `initial = await livesync.ensure_seeded(db)` (api.py:635) and subscribe() inside event_stream (livesync.py:422) is real, but it is a few-millisecond window that only opens on an SSE (re)connect and requires a write to commit inside it; and it self-heals on the very next write to that same collection — which is the likely case, since a write to it just happened — because the client's stored stamp is the pre-write one, so the next published stamp differs and triggers a full refetch that also picks up the missed row. That is a theoretical race, not a defect with real consequences for a single-worker, two-to-three-user deployment.
- **All three project schedule guards are gated on isinstance(schedule, list) while the write itself is unconditional — PUT with schedule:null wipes paid days with no check** — The isinstance(...,list) gates are correct for the threat model the guards were written against — a stale but well-formed client — and no code path in the app produces a non-list schedule (grep finds no `schedule: null` anywhere in the JS, and JSON.stringify drops an undefined key so it never reaches _dict_to_row); reaching this needs a hand-forged body from an already-authenticated staff member, who in this app is granted outright DELETE on projects by design (api.py:486 "Deletes stay member-level by design"), so it is a speculative forged-request scenario rather than a defect the app can hit.
- **PUT /api/settings has no concurrency guard, and the server-side shallow merge protects nothing because the client PUTs the entire settings blob** — Not silent and not unwarned: modules/settings.js:193-198 wires LTP_useRemoteEdits with the notice "Another window updated settings while you were editing. Your unsaved changes are kept — saving will replace the newer values", i.e. the exact dirty-admin outcome the finding describes is the documented, user-visible behaviour (and when clean the blob is adopted outright), so what is actually wrong is only the stale comment at data-state.js:423-425 about the shallow merge composing — a comment defect, which is out of scope.
- **DELETE has no If-Match support at all, so every optimistic-concurrency protection is PUT-only** — DELETE never had a concurrency guard by design — _require_fresh's docstring scopes it to PUT, and the client deliberately encodes delete-wins semantics for exactly this race (data-state.js mergeRemote: "A delete is the more destructive intent and the harder one to notice was reverted, so it wins") — and the scenario requires a user to explicitly confirm deleting a row they picked, so this is a hardening wish (If-Match on DELETE) rather than a defect with a concrete wrong behaviour.
- **A stale GET can regress revsRef behind an already-acknowledged write, producing a spurious 409 that discards a real edit** — Refuted as a practical defect: the race requires the refresh GET to read pre-PUT rows yet answer after the PUT, and the code self-heals within one round trip because our own committed PUT publishes the collection stamp back to us — refresh() either re-fires immediately (stampRef was set to the sibling's stampAtFetch) or via refreshAgainRef (line 588-589), refetching r1 long before the 400 ms debounce of a further edit; the narrative is also not what the code does (with prevSyncedRef already advanced to snapshot, mergeRemote treats row 5 as untouched and takes the server row rather than leaving a local edit to be PUT with a stale rev).
- **revalidate()'s in-flight sharing can answer a "something just changed" trigger with a response computed before the change** — Refuted as a reportable defect: the stale-share window is one request duration and every affected caller is covered by another channel — a polling tab picks the sibling write up on the next POLL_MS tick (≤15 s) and an SSE tab gets a push, while the labor.js:2536-2539 self-heal only backs a "Syncing…" label whose underlying projects stamp change is delivered by SSE or the same poll; that is a bounded cosmetic delay, not lost or wrong data.
- **CRMProjectForm's record watch has no pick(), so it warns "saving will replace the newer version" on every unrelated schedule, position, pay or activity change to the project row** — The missing pick is real (theme.js:262 substitutes identity, so the whole project row is stringified) but the consequence is a single warn-only toast per editing session (warnedRef suppresses repeats) that errs in the conservative direction — no data is lost or overwritten, so this is warning noise, not a defect with real consequences.
- **ScheduleBuilder is silently unmounted, discarding unsaved schedule edits, when its project row disappears from the live array** — The fall-through at modules/projects.js:49-62 is real, but the project row it was editing no longer exists — ScheduleBuilder's save does setProjects(prev.map(...)) which matches nothing and issues no PUT, so the draft was unsavable the moment the row was deleted; the only gap is a missing explanatory toast, which is a UX nicety rather than a data-loss defect.
- **A hung GET /api/versions leaves the tab with no SSE, no polling and no stamps — permanently** — The only concrete trigger offered is impossible — `init_db()` runs in lifespan startup, which uvicorn awaits before it ever opens the listening socket, so a locked Alembic upgrade yields a refused connection or platform error, not an accepted-and-never-answered `/api/versions`; every settling outcome (including HTTP errors and network failures) passes through revalidate()'s `.catch`/final `.then`, clearing `inFlightRevalidate` and running `seeding.then(connect, connect)`. The remaining premise, a fetch that is accepted and then never settles nor errors for the life of the tab, is speculative, and even that is escaped by the visibilitychange `if (!source) connect()` path.

## Known and deliberately deferred (pre-loaded into the audit as out of scope)

- **The broadcast bus is in-process.** Correct for one uvicorn worker; a second worker or pod
  silently degrades push to the 30s sweep. Documented in `backend/livesync.py`.
- **`/api/qbo/status` and `/api/users` are not in the stamp feed.** They change only when an
  admin acts.
- **Client-assigned id collision on create.** New ids are `Math.max(ids)+1` from local state.
  Two windows creating at the same moment pick the same id; the second POST 409s and falls
  back to PUT, overwriting the first. The fix is to re-key on collision, which risks breaking
  references from other new local rows — it needs its own change and its own tests.
