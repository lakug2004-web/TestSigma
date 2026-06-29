# Sample Output — Blast-Radius Report

This is the report PullGuard auto-posts onto a real Pull Request, written for a **QA lead who knows the product but not the code**. It is the exact shape produced by `pr_review.py::render_comment` and posted by the GitHub App.

**Repo:** `lakug2004-web/TODO` · **PR #4 — "Redesign Streamlit UI + document it in README"** · reasoned by Gemini 2.5 Flash.

> Why this PR? It's a **233-line visual overhaul of the Streamlit UI** (`src/streamlit_app.py`) with **zero engine changes** — the perfect blast-radius case. The risk is entirely in the *presentation* layer, and the report has to say that clearly: the look changed everywhere, the logic changed nowhere, so the action is "click through the UI," not "re-test the engine." The app's own docs confirm the shape: `docs/12-streamlit-ui.md` says the UI "contains **no business logic** — every action calls a service method and re-renders."

---

<!-- pullguard:begin -->
## 🛡️ Blast-radius report

**💬 Review notes** · 

This PR is a full visual redesign of the to-do app's web screen — new dashboard banner, live metric row, a completion progress bar, redesigned task cards with status pills / priority badges / due-date badges / tag chips, per-task actions moved into a popover, filters collapsed into an expander, and a restyled stats and order view. **It changes how everything looks and where the controls live, but it does not change what the app does** — the underlying engine (adding, completing, ordering tasks) is untouched and its tests still pass. So the exposure is almost entirely in the UI: every screen and control was rewritten and only a "does it load" check was run. Functionally promised behaviour stays covered; *presentationally*, everything is new and unverified.

### 🎯 UI elements at risk
- **Task cards** — the biggest rewrite. Status pills, priority badges, due-date badges, tag chips, strikethrough-on-complete: all new rendering, none of it UI-tested.
- **Hero dashboard** — metric row (total / active / done / overdue) + completion progress bar. New aggregation display; numbers could read wrong even though the engine is correct.
- **Per-task action popover (⚙)** — complete · set status · delete now live inside a popover. The actions are the same; the *way you reach them* moved.
- **Filters expander** and the **Stats** / **Order** tabs — restyled, so layout/labels may have shifted.

### 🔀 User flows affected
- **Add a task → see it appear** — still wired to the same service call, but the input/submit UI moved; smoke-test it.
- **Complete a task → it greys out / strikes through** — the completion *display* is new even though the completion *logic* isn't.
- **Set status / delete via the popover** — the controls relocated; verify they still fire.
- **Filter & sort** — filters now live in an expander; confirm the filtered list still matches.

### 📋 Requirements losing coverage
- _none lose coverage._ The engine is unchanged and its 14 tests are green, so every logic-level promised behaviour stays covered. ⚠️ But note: these behaviours are only verified at the **engine** level — there are **no automated UI tests**, so the redesigned screens themselves rely on a manual click-through.

### 🔧 What the code change does
- Rewrites `src/streamlit_app.py` (+233 / −106) — visual overhaul only.
- Adds **Web UI** and **Documentation** sections to `README.md` (+18).
- Explicitly **no engine / business-logic changes**.

### Issues addressed
- _none linked in the PR body._

### Suggestions
- Before merge: **do one manual pass** of add → complete → set-status → delete → filter → check stats. A 233-line UI rewrite shipping on an import-only smoke test is the one real gap here.
- Consider a lightweight UI smoke test (even a Streamlit `AppTest` script) so the *next* redesign isn't a blind merge.
- Sanity-check the metric row and progress bar against a known task set — display math is the easiest thing to get subtly wrong.

🔗 [Knowledge graph for this repo](https://console.neo4j.io) (per-repo subgraph)

<sub>Layers used: ✅ Requirements · ✅ DOM/UI (Streamlit app crawled at localhost:8501) · ✅ Code + graph — reasoned by Gemini 2.5 Flash.</sub>
<!-- pullguard:end -->

---

## How to read this (for the QA lead)

- **Risk band** (🟢/🟡/🔴) is the one-glance signal. 🟡 here = "safe to merge, but click through the UI first" — big surface change, no UI tests.
- **The three "at risk" sections** answer, in order: *what can a user see break*, *what journeys break*, *what promised behaviour is now unverified.* This PR is the textbook split — the first two light up (it's a UI redesign) while the third stays clean (the engine didn't move).
- **The footer is the trust line.** All three layers informed this report, so "engine safe / UI exposed" is a confident call, not a guess from partial data.

## The trace behind the report

PullGuard reaches the verdict by walking the graph from the changed file outward:

```
src/streamlit_app.py  (the only code file in the diff)
        │  RENDERS
        ▼
the to-do screen(s)  ──in──▶  add / complete / filter / stats flows
        │  COVERED_BY
        ▼
the product requirements those flows satisfy
```

Because the diff stops at `streamlit_app.py` and never reaches `todoapp/service.py`, `models.py`, or the rest of the engine, the requirement nodes stay covered — the blast radius is bounded to the Presentation layer. That boundary *is* the headline.