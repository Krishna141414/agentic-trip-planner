# SHOWCASE.md - Task 11 "Mission Control" showcase page (follow exactly)

ONE polished, animated web app (tabs, not one long scroll) that shows **what Task 11 asks and how this agent does each part**. It's for a video demo, so it must look good and explain itself. Only build what is here.

## Theme - "Mission Control"
- Background `#0A0E14`, surfaces `#121826`, accents: coral `#FF6B6B` (agent actions / errors), teal `#2DD4BF` (success), amber `#FACC15` (waiting for approval / key numbers), soft white text.
- Google Font Inter + a monospace font for traces. Rounded glassy cards, soft glow on the active step. Responsive. Plain HTML/CSS/JS + Chart.js from CDN, no frameworks.

## Layout - tabs, NOT one long scroll
A top header (title "Agentic Trip Planner", "Task 11" badge, one-line description) + a tab bar. Each tab is its own view with its own ready-made examples:
1. **Overview** - animated hero (tool icons orbiting an agent node), the 7 requirement cards (Realistic workflow, Multiple tools, State/history, Multi-step execution, Error recovery, Human approval, Documented workflow); clicking a card opens the tab that shows it.
2. **Live Agent** (main demo) - goal input + example buttons ("Normal trip", "Tight budget -> re-plan", "Weather API down -> recovery", "Unknown city", "Approve booking", "Reject booking"). Three panels: **Plan timeline** (steps light up pending -> running -> done/failed/recovered), **Agent trace** (Thought -> Action (tool + args chips) -> Observation result cards, typing effect), **State panel** (live AgentState + "View JSON"). Final trip summary card.
3. **Tools** - the 6 tools as cards; each has a "Run" button with a pre-filled example that calls just that tool and shows input -> output.
4. **State & History** - list of past runs (saved state files); open one to replay its step history.
5. **Error Recovery** - buttons to simulate each failure (API down, no hotels under budget, invalid args) and watch fail -> retry -> alternative -> success.
6. **Human Approval** - pending approvals list; booking summary with Approve / Reject; shows what happens in each case.
7. **Results** - count-up tiles + Chart.js chart + evaluate.py table + key findings.
8. **How it works** - workflow diagram (boxes/arrows), tool table, 3-4 code snippets with file names, link to docs/workflow.md, limitations.

## Guided Tour (for the video)
- Floating tour bar: **Start Tour, ◀ Back, ⏸ Pause / ▶ Play, Next ▶, step "3 / 15", speed Slow / Medium / Fast (default Medium), Exit**.
- One tour script (JS array) visits every tab in order; each step switches tab, spotlights the element (dim the rest), shows a caption naming which requirement it proves, and runs the action (clicks an example, runs a tool, triggers a failure, opens the approval modal and approves/rejects).
- Auto mode advances at the chosen speed (Medium ≈ 3-4 s per step, waits for running steps to finish). Pause stops; Next/Back move manually. Keyboard: Space = pause/play, arrows = back/next.

## Behaviour
- **Instant demo mode (default):** precompute full runs for every example button into `web/demo_runs.json` (via a script) so the page works instantly without the model; replay them step by step with the animations.
- **"Run live" toggle:** when `python app.py` is running, send the goal to the real agent; show "Agent working... (CPU model, ~10-30 s per LLM step)". The approval modal calls the real approve/reject endpoint. Hide the toggle if the backend isn't available.

## Speed (important)
- Medium pace: ~1.5-2 s between steps; results fade/slide in over ~0.6-0.8 s; typing ~25-35 ms per character (max ~6 s per text); count-ups/charts ~1.2-1.5 s.
- All timings in ONE `const SPEED = {...}` object at the top of the JS + a **Slow / Medium / Fast** toggle near the demo (default Medium). Respect `prefers-reduced-motion`.

## Done means
- Start the server yourself, open every tab, run every example (incl. approve, reject and a failure) and the full Guided Tour (auto + pause + manual). No errors in the server log. Don't say it works unless you saw real responses.
- README gets a "Showcase page" section (how to open it).
- Commit and push. Short summary, then stop.
