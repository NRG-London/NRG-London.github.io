# Sprint reports

These are the verbatim implementation and verification reports, plus the
controller ledger (`sprint-ledger.md`), from the August 2026 morph prototype
sprint on branch `labs/morph`.

**Both prototypes have shipped.** V1's value-morph went to production on
2026-08-16 (`?v=10`); V3's GPU crack-warp on 2026-08-17 (`?v=11`, build
`425f758b6f`). The port is done, not pending, so nothing here is a decision
waiting to be taken — these files are the **historical record** of how the two
were built and what was measured on the way. Read them as dated evidence, and
do not update them when the production page moves; the live account of what
ships lives in `investigations/london_population/DEPLOY_NOTES.md` §§8–9 in the
Crime Data project, and the port itself is written up there in
`morph_port_report.md` and `morph_v3_port_report.md`.

Which of them still gets read:

* `flicker-investigation.md` and `v3-report.md` are the **current-era
  references** — the one-frame reveal flash and the warm-commit cure, and the
  shader warp with its concurrency, frame-rate and endpoint measurements. Both
  describe mechanisms that are in the shipped page. Their numbers are the
  lab's machine, and several are ranges across runs on purpose; production
  re-measures its own on every gate run.
* `task-3-report.md` listed three production tickets for the port. Two shipped
  with V1 — the `polyData(T)` cache that stops a `redraw()` restarting an
  in-flight transition, and the curtain timer capturing its values into the
  closure — and both are written up as traps in `DEPLOY_NOTES.md` §6. The
  third, `RANKS` being cached on `T.key + ":" + m.key` and so serving stale
  ranks across a year or change switch, is **still open in the production
  template** as of 2026-08-17. It has no pixel effect at rest.
* `task-4-report.md` holds the deck.gl transition-blanking finding
  (`getPolygon` transitions silently blanking a `SolidPolygonLayer`). That
  finding still stands, and it is what forced V3 into the vertex shader rather
  than into deck.gl's own transitions. It is a limit on deck.gl's attribute
  transitions, not on animating a change of geography — V3 shipped that.
* `task-1-report.md`, `task-2-report.md` and `sprint-ledger.md` are the build
  record of the crosswalk, the v0/v1 harnesses and the controller's own log.
