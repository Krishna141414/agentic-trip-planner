"use strict";
/* Agentic Trip Planner - showcase page. Plain JS, no framework.
   Demo mode replays real precomputed runs (web/demo_runs.json); "Run live" talks to python app.py. */

/* ===== ALL timings live here (ms) ===== */
const SPEED = {
  slow:   { step: 2600, beat: 1100, fade: 900, typeChar: 45, typeMax: 8000, countUp: 1800, tour: 5200 },
  medium: { step: 1700, beat: 700,  fade: 700, typeChar: 30, typeMax: 6000, countUp: 1400, tour: 3600 },
  fast:   { step: 650,  beat: 300,  fade: 350, typeChar: 12, typeMax: 2500, countUp: 800,  tour: 1800 },
};
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
let speedKey = "medium";
const T = () => (REDUCED ? { ...SPEED[speedKey], fade: 0, typeChar: 0, countUp: 0 } : SPEED[speedKey]);

/* ===== helpers ===== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => (n == null || isNaN(n) ? "–" : Math.round(Number(n)).toLocaleString("en-IN"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cancelled extends Error {}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
async function getJSON(url) { const r = await fetch(url, { cache: "no-store" }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
async function postJSON(url, body) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`); return d;
}
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

let DEMO = null, RESULTS = null, BACKEND = false, MODE = "demo";

/* ===== static content ===== */
const TOOL_META = [
  { name: "get_weather", ico: "☁️", purpose: "Live forecast for the trip days (Open-Meteo, free, no key).", args: "city, days", out: "daily min/max °C, rain %, condition", fail: "API timeout/down → retry → cached climate → skip" },
  { name: "search_hotels", ico: "🏨", purpose: "Hotels in the city under a nightly price that fit the guests (sample data).", args: "city, max_price_per_night, guests", out: "matching hotels, best rated first", fail: "none under limit → retry → +20% limit; unknown city → stop" },
  { name: "find_attractions", ico: "📍", purpose: "Top-rated sights for the city (sample data).", args: "city, top_n", out: "attractions with rating, indoor flag, fee", fail: "unknown city → skip (optional)" },
  { name: "calculate_budget", ico: "🧮", purpose: "Hotel + daily spend vs. the user's budget.", args: "hotel_price, nights, guests, daily_spend, budget", out: "total, difference, under/over", fail: "invalid args → rebuilt args; over budget → re-plan" },
  { name: "create_itinerary", ico: "🗓️", purpose: "Day-by-day plan; indoor sights on rainy days.", args: "city, days, attractions, weather", out: "days with morning/afternoon/evening slots", fail: "invalid args → retry" },
  { name: "book_hotel", ico: "✅", purpose: "Books the hotel and saves it to data/bookings.json. IMPORTANT ACTION.", args: "hotel_id, guest_name, check_in, check_out, guests", out: "booking id + details", fail: "needs human approval; rule check at run time", appr: true },
];
const REQS = [
  { ico: "🧭", t: "Realistic workflow", d: "Plan a trip from one sentence and book the hotel.", tab: "live" },
  { ico: "🧰", t: "Multiple tools", d: "6 tools with Pydantic argument schemas.", tab: "tools" },
  { ico: "💾", t: "State / history", d: "One AgentState per run, saved as JSON, replayable.", tab: "state" },
  { ico: "🔁", t: "Multi-step execution", d: "LLM plan → Thought → Action → Observation, max 10 steps.", tab: "live" },
  { ico: "🛟", t: "Error recovery", d: "Retry once → alternative → skip; over budget → re-plan.", tab: "recovery" },
  { ico: "✋", t: "Human approval", d: "Pauses before book_hotel; Approve or Reject.", tab: "approval" },
  { ico: "📘", t: "Documented workflow", d: "Diagram, tool table, state fields, example trace.", tab: "how" },
];
const EX_ORDER = ["normal", "tight", "weather_down", "unknown", "approve", "reject"];
const SNIPPETS = [
  { file: "agent.py · call_tool() - error recovery", code: `for kind, a in [("original", args), ("retry", None)]:
    if a is None:  # retry: same args, or repaired args if invalid
        a = repair() if isinstance(err, ValidationError) else args
    try:
        rec.result = run_tool(item.tool, a); break
    except (ToolError, ValidationError) as e:
        err = e; state.errors.append(...)
else:  # both failed -> alternative (cached weather / +20% limit)
    alt = alternative(err)
    ...
    rec.status = "skipped" if optional else "failed"` },
  { file: "agent.py · step_book_request() - human approval", code: `# Important action: do NOT book yet
summary = preview_booking(BookArgs(**args))   # validate only
state.pending_approval = summary
state.status = "waiting_for_approval"
state.save()          # paused; resume(run_id, "approve"|"reject")

def resume(run_id, decision):
    state = AgentState.load(run_id)
    if decision == "approve": call_tool(... "book_hotel" ...)
    else: record "rejected" - nothing is booked` },
  { file: "agent.py · make_plan() - LLM plan + fallback", code: `plan = llm.extract_json(llm.chat(system, user, 80))
steps = [t for t in plan if t in TOOLS]          # known tools only
valid = REQUIRED <= set(steps) and deps_in_order(steps)
return (steps, "llm plan") if valid \\
       else (DEFAULT_PLAN, "fallback plan")` },
  { file: "state.py · AgentState", code: `class AgentState(BaseModel):
    run_id: str; goal: str; status: str = "running"
    params: TripParams | None      # city, days, guests, budget
    plan: list[PlanStep]           # steps + status
    current_step: int = 0
    history: list[StepRecord]      # thought, tool, args, result,
                                   # status, attempts, time
    errors: list[dict]; approvals: list[dict]
    pending_approval: dict | None
    final_answer: str | None
    def save(self): ...  # -> state/<run_id>.json` },
];

/* ===== speed + tabs ===== */
function setSpeed(k) {
  speedKey = k; store.set("speed", k);
  document.documentElement.style.setProperty("--fade", T().fade + "ms");
  $$(".seg.speed button").forEach((b) => b.classList.toggle("on", b.dataset.speed === k));
}
function showTab(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  $$(".view").forEach((v) => v.classList.toggle("on", v.id === "tab-" + name));
  if (name === "results") animateResults();
  if (name === "state") loadRuns();
  if (name === "approval") loadApprovals();
}

/* ===== overview ===== */
function renderOverview() {
  const ring = $("#orbitRing");
  TOOL_META.forEach((t, i) => {
    const o = el("div", "orb", `<div>${t.ico}<small>${t.name.split("_")[0]}</small></div>`);
    o.style.transform = `rotate(${i * 60}deg) translate(var(--r, 140px)) rotate(${-i * 60}deg)`;
    ring.append(o);
  });
  const fit = () => $(".orbit").style.setProperty("--r", Math.round($(".orbit").clientWidth * 0.41) + "px");
  fit(); addEventListener("resize", fit);
  $("#reqGrid").innerHTML = REQS.map((r, i) => `<div class="card req" data-go="${r.tab}" style="animation-delay:${i * 70}ms">
    <span class="ico">${r.ico}</span><h5>${r.t}</h5><p>${r.d}</p><span class="go">Open ${r.tab} tab →</span></div>`).join("");
}

/* ===== typing ===== */
async function typeText(node, text, check) {
  const t = T(); text = String(text || "");
  if (!t.typeChar) { node.textContent = text; return; }
  const per = Math.min(t.typeChar, t.typeMax / Math.max(1, text.length));
  const chunk = Math.max(1, Math.round(16 / per));
  for (let i = 0; i < text.length; i += chunk) {
    node.textContent = text.slice(0, i + chunk);
    await sleep(per * chunk); check();
  }
  node.classList.remove("caret");
}

/* ===== LIVE AGENT: player ===== */
const live = { tok: 0, state: null, shown: 0, exKey: null, promise: null, waiting: false, runId: null, rows: {} };
const liveCheck = (tok) => () => { if (tok !== live.tok) throw new Cancelled(); };
const pauseL = async (ms, tok) => { await sleep(ms); liveCheck(tok)(); };

function resetLive() {
  live.state = null; live.shown = 0; live.waiting = false; live.runId = null; live.rows = {};
  $("#timeline").innerHTML = ""; $("#trace").innerHTML = ""; $("#summary").hidden = true;
  $("#stateView").innerHTML = '<span class="muted">Starting…</span>'; $("#planSource").textContent = "–";
  closeModal();
}
function runExample(key) {
  const ex = DEMO.examples[key];
  $("#goal").value = ex.goal;
  $$("#examples .btn").forEach((b) => b.classList.toggle("on", b.dataset.ex === key));
  if (MODE === "live") $("#simSel").value = ex.simulate[0] || "";
  return startRun(key);
}
function startRun(key) {
  live.promise = doRun(key).catch((e) => { if (!(e instanceof Cancelled)) traceNotice(`⚠ ${esc(e.message)}`, "bad"); });
  return live.promise;
}
async function doRun(key) {
  const tok = ++live.tok; resetLive();
  const goal = $("#goal").value.trim();
  if (MODE === "live") {
    const sim = $("#simSel").value;
    $("#working").hidden = false;
    try {
      const { run_id } = await postJSON("/api/run", { goal, simulate: sim ? [sim] : [] });
      live.runId = run_id; live.exKey = null;
      await pollPlay(run_id, tok);
    } finally { if (tok === live.tok) $("#working").hidden = true; }
    return;
  }
  key = key || Object.keys(DEMO.examples).find((k) => DEMO.examples[k].goal === goal);
  if (!key) { traceNotice("Instant demo replays the example goals only. Start <code>python app.py</code> and switch to <b>Run live</b> to try your own goal.", "warn"); return; }
  live.exKey = key;
  await play(DEMO.examples[key].states.initial, tok);
}
async function pollPlay(runId, tok, untilNot = "running") {
  for (;;) {
    const s = await getJSON(`/api/runs/${runId}`); liveCheck(tok)();
    if (s.status === untilNot && untilNot === "waiting_for_approval") { await pauseL(600, tok); continue; }
    await play(s, tok);
    if (s.status !== "running") break;
    await pauseL(1000, tok);
  }
}
async function play(state, tok) {
  live.state = state; const check = liveCheck(tok);
  $("#planSource").textContent = state.plan_source || "planning…";
  $("#planSource").className = "chip " + (state.plan_source === "fallback plan" ? "warn" : state.plan_source ? "ok" : "");
  while (live.shown < state.history.length) {
    const i = live.shown, rec = state.history[i];
    renderTimeline(state, i, rec.plan_id);
    renderState(state, i, true);
    await animateStep(rec, i, check);
    live.shown++;
    renderTimeline(state, live.shown); renderState(state, live.shown);
    if (live.shown < state.history.length || state.status !== "running") await pauseL(T().step, tok);
  }
  renderTimeline(state, live.shown); renderState(state, live.shown);
  if (state.status === "waiting_for_approval") { live.waiting = true; openModal(state); }
  else if (state.status !== "running") showSummary(state);
}
function traceNotice(html, cls) { $("#trace").append(el("div", "tstep " + (cls === "bad" ? "failed" : "waiting"), html)); }

/* timeline: plan steps light up pending -> running -> done/failed/recovered */
const ICON = { pending: "", running: "…", done: "✓", recovered: "↻", failed: "✕", skipped: "–", waiting: "⏸", rejected: "✕" };
function renderTimeline(state, shown, runningId) {
  const all = shown >= state.history.length, last = {};
  state.history.slice(0, shown).forEach((h) => (last[h.plan_id] = h.status));
  const items = state.plan.filter((p, i) => i < 2 || all || (shown >= 2 && (!p.added_by_replan || last[p.id] || p.id === runningId)));
  const ol = $("#timeline");
  ol.querySelector(".empty")?.remove();
  items.forEach((p, idx) => {
    let st = p.id === runningId ? "running" : all ? p.status : last[p.id] || "pending";
    if (all && st === "running" && state.status !== "running") st = "pending";
    let li = live.rows[p.id];
    if (!li) { li = live.rows[p.id] = el("li"); }
    const tool = p.tool === "llm" ? "LLM" : p.tool === "write_summary" ? "LLM" : p.tool;
    li.className = st + (p.added_by_replan ? " replan" : "");
    li.innerHTML = `<span class="dot">${ICON[st] || idx + 1}</span><span class="lbl">${esc(p.label)}<small>${esc(tool)}</small></span><span class="st">${st}</span>`;
    if (ol.children[idx] !== li) ol.insertBefore(li, ol.children[idx] || null);
  });
}

/* trace: Thought -> Action -> Observation */
async function animateStep(rec, i, check) {
  const t = T();
  const card = el("div", "tstep running");
  card.innerHTML = `<div class="thead">${toolChip(rec.tool)}<span class="n muted tiny">step ${i + 1}</span><span class="st"><span class="spin-sm"></span></span></div>
    <div class="trow"><span>Thought</span><div class="thought caret"></div></div>`;
  const trace = $("#trace"); trace.append(card); trace.scrollTop = trace.scrollHeight;
  await typeText($(".thought", card), rec.thought, check);
  await sleep(t.beat); check();
  card.append(el("div", "trow obs", `<span>Action</span><div class="chips">${toolChip(rec.tool)}${argChips(rec)}</div>`));
  trace.scrollTop = trace.scrollHeight;
  await sleep(t.beat); check();
  card.append(el("div", "trow obs", `<span>Observation</span><div>${obsHTML(rec)}</div>`));
  card.className = "tstep " + rec.status;
  $(".thead .st", card).innerHTML = statusChip(rec.status);
  trace.scrollTop = trace.scrollHeight;
}
function toolChip(tool) {
  if (tool === "llm") return '<span class="chip ok">🧠 LLM</span>';
  if (tool === "re_plan") return '<span class="chip warn">↻ re-plan</span>';
  return `<span class="chip tool">${esc(tool)}</span>`;
}
function statusChip(s) {
  const cls = { done: "ok", recovered: "warn", waiting: "warn", failed: "bad", rejected: "bad", skipped: "" }[s] ?? "";
  return `<span class="chip ${cls}">${ICON[s] || ""} ${esc(s)}</span>`;
}
function short(v) {
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (v && typeof v === "object") return "{…}";
  if (typeof v === "number") return v >= 1000 ? fmt(v) : String(v);
  const s = String(v); return s.length > 34 ? s.slice(0, 32) + "…" : s;
}
function argChips(rec) {
  const a = rec.args || {};
  if (rec.tool === "llm" && !Object.keys(a).length) return '<span class="chip">Qwen2.5-0.5B · JSON</span>';
  if (rec.tool === "re_plan") return '<span class="chip">update plan</span>';
  return Object.entries(a).map(([k, v]) => `<span class="chip k"><b>${esc(k)}:</b> ${esc(short(v))}</span>`).join("");
}
function obsHTML(rec) {
  const r = rec.result || {}; let h = "";
  if (r.error) h = `<span class="coral">✕ ${esc(r.error)}</span>`;
  else if (r.params) h = `<div class="chips">${Object.entries(r.params).map(([k, v]) => `<span class="chip k"><b>${k}:</b> ${esc(k === "budget" ? "Rs " + fmt(v) : v)}</span>`).join("")}</div>
      <div class="tiny muted" style="margin-top:4px">source: <span class="${r.source === "llm" ? "teal" : "amber"}">${esc(r.source)}</span></div>`;
  else if (r.plan) h = `<div class="chips">${r.plan.map((p) => `<span class="chip">${esc(p)}</span>`).join("→")}</div><div class="tiny" style="margin-top:4px"><span class="${r.source === "llm plan" ? "teal" : "amber"}">${esc(r.source)}</span></div>`;
  else if (r.days && r.source) h = `<b>${esc(r.source)}</b><ul>${r.days.map((d) => `<li>${esc(d.date)}: ${esc(d.condition)}, ${Math.round(d.min_c)}–${Math.round(d.max_c)} °C, rain ${d.rain_chance_pct}%</li>`).join("")}</ul>`;
  else if (r.hotels) h = `${r.count} hotel(s) fit · chosen <b class="amber">${esc(r.chosen)}</b><ul>${r.hotels.slice(0, 3).map((x) => `<li>${esc(x.name)} – Rs ${fmt(x.price_per_night)}/night · ★${x.rating}</li>`).join("")}</ul>`;
  else if (r.attractions) h = `<ul>${r.attractions.map((a) => `<li>${esc(a.name)} ★${a.rating}${a.indoor ? " · indoor" : ""}</li>`).join("")}</ul>`;
  else if (r.total != null) h = `Total <b class="amber">Rs ${fmt(r.total)}</b> vs budget Rs ${fmt(r.budget)} → <span class="chip ${r.status === "under" ? "ok" : "bad"}">${r.status} by Rs ${fmt(Math.abs(r.difference))}</span><div class="tiny muted">${esc(r.formula)}</div>`;
  else if (r.change) h = `<b>${esc(r.change)}</b>: ${esc(r.from)} → <span class="teal">${esc(r.to)}</span>`;
  else if (r.days && r.city) h = r.days.map((d) => `<div><b>Day ${d.day}</b> <span class="muted tiny">${esc(d.weather)}</span> – ${d.slots.slice(0, 2).map((s) => esc(s.activity)).join(" · ")}</div>`).join("");
  else if (r.waiting_for_approval) h = `<span class="amber">⏸ Paused for human approval:</span> ${esc(r.waiting_for_approval.question)}`;
  else if (r.booking_id) h = `<span class="teal">✓ Booked <b>${esc(r.booking_id)}</b></span> – ${esc(r.hotel_name)}, Rs ${fmt(r.total_inr)} · saved to data/bookings.json`;
  else if (r.booked === false) h = `<span class="coral">${esc(r.message)}</span>`;
  else if (r.summary) h = `${esc(r.summary)}<div class="tiny muted" style="margin-top:4px">written by: ${r.source === "llm" ? "local LLM (checked against facts)" : "template (LLM text failed the fact check)"}</div>`;
  else h = `<pre class="json">${esc(JSON.stringify(r, null, 1).slice(0, 600))}</pre>`;
  const att = rec.attempts || [];
  if (att.some((a) => !a.ok)) h += `<div class="attempts">${att.map((a) => `<div class="attempt ${a.ok ? "ok" : ""}">${a.ok ? "✓" : "✕"} ${a.kind}${a.note ? " – " + esc(a.note) : ""}${a.error ? ": " + esc(a.error) : ""}</div>`).join("")}</div>`;
  if (rec.recovery) h += `<div class="recov">↻ ${esc(rec.recovery)}</div>`;
  return `<div class="box">${h}</div>`;
}

/* state panel (snapshot = what the agent knew at that point) */
function snapshot(state, shown) {
  const all = shown >= state.history.length;
  return { ...state, history: state.history.slice(0, shown), status: all ? state.status : "running",
    final_answer: all ? state.final_answer : null, pending_approval: all ? state.pending_approval : null,
    approvals: all ? state.approvals : state.approvals.filter((a) => state.history.slice(0, shown).some((h) => h.status === "rejected" || h.tool === "book_hotel" && h.status === "done")) };
}
let lastStateVals = {};
function renderState(state, shown) {
  const s = snapshot(state, shown), p = s.params;
  const tools = new Set(s.history.map((h) => h.tool));
  const mem = { get_weather: "weather", search_hotels: "hotels, chosen_hotel", find_attractions: "attractions", calculate_budget: "budget", create_itinerary: "itinerary" };
  const memKeys = Object.entries(mem).filter(([t]) => tools.has(t)).map(([, k]) => k).join(", ").split(", ").filter(Boolean);
  if (s.history.some((h) => h.tool === "book_hotel" && h.status === "done")) memKeys.push("booking");
  const errs = s.history.reduce((n, h) => n + (h.attempts || []).filter((a) => !a.ok).length, 0);
  const vals = {
    run_id: `<code>${esc(s.run_id)}</code>`, status: `<span class="status ${s.status}">${s.status}</span>`,
    goal: `<span class="tiny">${esc(s.goal)}</span>`,
    params: p && shown > 0 ? `<div class="chips"><span class="chip">${esc(p.city)}</span><span class="chip">${p.days} days</span><span class="chip">${p.guests} guests</span><span class="chip">Rs ${fmt(p.budget)}</span>${p.book ? '<span class="chip warn">book</span>' : ""}</div>` : "–",
    plan: shown >= 2 ? `${s.plan.length} steps · <span class="${s.plan_source === "llm plan" ? "teal" : "amber"}">${esc(s.plan_source)}</span>` : "–",
    current_step: `<span class="num">${Math.min(shown + (s.status === "running" ? 1 : 0), s.plan.length)}</span> / ${s.plan.length}`,
    history: `<span class="num">${s.history.length}</span> records`,
    errors: errs ? `<span class="coral">${errs} failed attempt(s)</span>` : "0",
    approvals: s.pending_approval ? '<span class="amber">pending…</span>' : s.approvals.length ? s.approvals.map((a) => `<span class="chip ${a.decision === "approve" ? "ok" : "bad"}">${a.decision}</span>`).join("") : "–",
    memory: memKeys.length ? `<div class="chips">${memKeys.map((k) => `<span class="chip">${k}</span>`).join("")}</div>` : "{}",
    final_answer: s.final_answer ? '<span class="teal">✓ written (see summary)</span>' : "–",
  };
  const box = $("#stateView");
  if (!box.querySelector(".kv")) box.innerHTML = '<div class="kv"></div>';
  const kv = box.querySelector(".kv"); kv.classList.remove("muted"); box.classList.remove("muted");
  kv.innerHTML = Object.entries(vals).map(([k, v]) => `<span>${k}</span><div data-k="${k}" class="${lastStateVals[k] && lastStateVals[k] !== v ? "flash" : ""}">${v}</div>`).join("");
  lastStateVals = vals;
}

/* final summary card */
function showSummary(state) {
  const m = state.memory || {}, h = m.chosen_hotel, b = m.budget, it = m.itinerary;
  const head = { completed: m.booking ? "✓ Trip planned & hotel booked" : "✓ Trip planned", rejected: "Trip planned – booking rejected, nothing booked", failed: "Stopped politely" }[state.status] || state.status;
  const facts = [];
  if (h) facts.push(["Hotel", `${esc(h.name)}<div class="tiny muted">${esc(h.area)} · Rs ${fmt(h.price_per_night)}/night · ★${h.rating}</div>`]);
  if (b) facts.push(["Total vs budget", `<span class="amber">Rs ${fmt(b.total)}</span> / Rs ${fmt(b.budget)}<div class="tiny ${b.status === "under" ? "teal" : "coral"}">${b.status} by Rs ${fmt(Math.abs(b.difference))}</div>`]);
  facts.push(["Weather", m.weather ? esc(m.weather.source) : '<span class="muted">skipped</span>']);
  facts.push(["Booking", m.booking ? `<span class="teal">${esc(m.booking.booking_id)} confirmed</span>` : state.status === "rejected" ? '<span class="coral">rejected by user</span>' : '<span class="muted">not requested</span>']);
  const card = $("#summary");
  card.innerHTML = `<h3 class="${state.status === "failed" ? "coral" : "teal"}">${head}</h3><p>${esc(state.final_answer)}</p>
    ${state.status !== "failed" ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><small>${k}</small><b>${v}</b></div>`).join("")}</div>` : ""}
    ${it ? `<div class="days">${it.days.map((d) => `<div class="day"><h5>Day ${d.day} <span class="tiny muted">${esc(d.date || "")}</span></h5><div class="tiny muted">${esc(d.weather)}${d.rainy_day_plan ? " · rainy-day plan" : ""}</div><ul>${d.slots.map((s) => `<li><b>${s.time}:</b> ${esc(s.activity)}</li>`).join("")}</ul></div>`).join("")}</div>` : ""}`;
  card.hidden = false;
  card.style.animation = "none"; void card.offsetWidth; card.style.animation = "";
}

/* approval modal */
function bookingKV(a) {
  return `<div class="kv">
    <span>hotel</span><div><b>${esc(a.hotel_name)}</b> <span class="muted">(${esc(a.hotel_id)})</span></div>
    <span>where</span><div>${esc(a.area)}, ${esc(a.city)}</div>
    <span>guest</span><div>${esc(a.guest_name)} · ${a.guests} guest(s)</div>
    <span>dates</span><div>${esc(a.check_in)} → ${esc(a.check_out)} (${a.nights} night${a.nights > 1 ? "s" : ""})</div>
    <span>hotel cost</span><div class="num">Rs ${fmt(a.total_inr)}</div>
    <span>trip total</span><div>Rs ${fmt(a.trip_total)} of Rs ${fmt(a.budget)} ${a.over_budget ? '<span class="chip bad">over budget</span>' : '<span class="chip ok">within budget</span>'}</div></div>`;
}
function openModal(state) {
  const a = state.pending_approval; if (!a) return;
  $("#modalBody").innerHTML = `<h3 style="margin:0 0 6px">${esc(a.question)}</h3>
    <p class="tiny muted" style="margin:0 0 12px">book_hotel is an important action. The agent saved its state and is waiting for you.</p>${bookingKV(a)}
    <p class="tiny muted" style="margin:12px 0 0"><b class="teal">Approve</b> → book_hotel runs and saves to data/bookings.json. <b class="coral">Reject</b> → nothing is booked; the run ends politely.</p>`;
  $("#modal").hidden = false;
}
function closeModal() { $("#modal").hidden = true; }
function decide(decision) {
  if (!live.waiting) return Promise.resolve();
  live.waiting = false; closeModal();
  const tok = live.tok;
  live.promise = (async () => {
    if (MODE === "live" && live.runId) {
      $("#working").hidden = false;
      try { await postJSON(`/api/runs/${live.runId}/${decision}`); await pollPlay(live.runId, tok, "waiting_for_approval"); }
      finally { if (tok === live.tok) $("#working").hidden = true; }
    } else await play(DEMO.examples[live.exKey].states[decision], tok);
  })().catch((e) => { if (!(e instanceof Cancelled)) traceNotice(`⚠ ${esc(e.message)}`, "bad"); });
  return live.promise;
}

/* ===== TOOLS tab ===== */
function renderTools() {
  $("#toolGrid").innerHTML = TOOL_META.map((t) => `<div class="card tool-card" id="tool-${t.name}">
    <h5>${t.ico} ${t.name}${t.appr ? '<span class="tag-appr">needs approval</span>' : ""}</h5><p>${t.purpose}</p>
    <p class="tiny"><b>args:</b> <code>${t.args}</code></p>
    <textarea spellcheck="false">${esc(JSON.stringify(DEMO.tools[t.name].input, null, 1))}</textarea>
    <div><button class="btn sm primary" data-run="${t.name}">▶ Run</button> <span class="tiny muted">${BACKEND ? "calls the real tool via the API" : "shows the precomputed real output"}</span></div>
    <div class="io-out"></div></div>`).join("");
}
async function runToolCard(name) {
  const card = $("#tool-" + name), out = $(".io-out", card), ta = $("textarea", card);
  let args;
  try { args = JSON.parse(ta.value); } catch (e) { out.innerHTML = `<div class="io"><pre class="err">Invalid JSON: ${esc(e.message)}</pre></div>`; return; }
  out.innerHTML = `<div class="io"><pre>${esc(JSON.stringify(args, null, 1))}</pre><i>→</i><pre><span class="spin-sm"></span> running ${name}…</pre></div>`;
  let res;
  try {
    if (BACKEND) res = await postJSON(`/api/tools/${name}`, { args });
    else if (JSON.stringify(args) === JSON.stringify(DEMO.tools[name].input)) res = DEMO.tools[name];
    else res = { ok: false, error: "Edited arguments need the backend - run python app.py." };
  } catch (e) { res = { ok: false, error: e.message }; }
  await sleep(T().beat);
  const body = res.ok ? JSON.stringify(res.output, null, 1) : "✕ " + res.error;
  out.innerHTML = `<div class="io"><pre>${esc(JSON.stringify(args, null, 1))}</pre><i>→</i><pre class="${res.ok ? "" : "err"}">${esc(body)}</pre></div>`;
}

/* ===== STATE & HISTORY tab ===== */
const hist = { tok: 0, entries: [] };
function demoFinal(key) { const s = DEMO.examples[key].states; return key === "reject" ? s.reject : key === "approve" ? s.approve : s.initial; }
async function loadRuns() {
  const entries = [];
  if (BACKEND) {
    try { (await getJSON("/api/runs")).slice(0, 30).forEach((r) => entries.push({ src: "live", ...r })); } catch { /* ignore */ }
  }
  Object.keys(DEMO.examples).forEach((k) => { const s = demoFinal(k); entries.push({ src: "demo", key: k, run_id: s.run_id, goal: s.goal, status: s.status, steps: s.history.length, simulate: s.simulate }); });
  hist.entries = entries;
  $("#runsSrc").textContent = BACKEND ? "state/ + demo" : "demo";
  $("#runList").innerHTML = entries.map((r, i) => `<li data-i="${i}" style="animation-delay:${Math.min(i, 12) * 40}ms"><span class="status ${r.status}">${r.status}</span>
    <span class="g">${esc(r.goal)}</span><small>${esc(r.run_id)}.json · ${r.steps} steps${r.simulate?.length ? " · sim: " + r.simulate.join(",") : ""} · ${r.src}</small></li>`).join("");
}
async function openRun(i) {
  const r = hist.entries[i]; if (!r) return;
  $$("#runList li").forEach((li) => li.classList.toggle("on", +li.dataset.i === i));
  const tok = ++hist.tok;
  const s = r.src === "live" ? await getJSON(`/api/runs/${r.run_id}`) : demoFinal(r.key);
  if (tok !== hist.tok) return;
  hist.current = s; $("#replayJson").hidden = false;
  const p = s.params;
  const box = $("#replay"); box.classList.remove("muted");
  box.innerHTML = `<div style="margin-bottom:10px"><b>${esc(s.goal)}</b><div class="chips" style="margin-top:6px"><span class="status ${s.status}">${s.status}</span>
    ${p ? `<span class="chip">${esc(p.city)} · ${p.days}d · ${p.guests}p · Rs ${fmt(p.budget)}</span>` : ""}<span class="chip">${esc(s.plan_source || "no plan")}</span>
    ${s.approvals.map((a) => `<span class="chip ${a.decision === "approve" ? "ok" : "bad"}">approval: ${a.decision}</span>`).join("")}<span class="chip">${s.errors.length} error log entries</span></div></div><div class="hist"></div>`;
  const list = $(".hist", box);
  for (const [n, h] of s.history.entries()) {
    list.append(el("div", "hrow", `<span class="n">${n + 1}</span><span>${toolChip(h.tool)}<div class="tiny muted">${esc((h.time || "").slice(11))} · ${h.duration_ms} ms</div></span>
      <span>${esc(h.thought)}${h.recovery ? `<span class="rc">↻ ${esc(h.recovery)}</span>` : ""}</span><span>${statusChip(h.status)}</span>`));
    await sleep(T().beat / 2); if (tok !== hist.tok) return;
  }
  if (s.final_answer) list.append(el("div", "hrow", `<span class="n">★</span><span class="chip ok">final_answer</span><span style="grid-column: span 2">${esc(s.final_answer)}</span>`));
}
const openFirstRun = () => { showTab("state"); return loadRuns().then(() => openRun(hist.entries.findIndex((e) => e.key === "tight") >= 0 ? hist.entries.findIndex((e) => e.key === "tight") : 0)); };

/* ===== ERROR RECOVERY tab ===== */
const recv = { tok: 0 };
async function simulate(kind) {
  const tok = ++recv.tok; const check = () => { if (tok !== recv.tok) throw new Cancelled(); };
  $$("#simButtons .btn").forEach((b) => b.classList.toggle("on", b.dataset.sim === kind));
  const log = $("#recLog"); log.innerHTML = "";
  const line = (txt, cls = "") => { log.append(el("div", "l " + cls, esc(txt))); };
  $$("#pipeline .pnode").forEach((n) => { n.className = "pnode"; }); $$("#pipeline > i").forEach((x) => x.classList.remove("lit"));
  $('#pipeline [data-k="outcome"] span').textContent = "Outcome"; $('#pipeline [data-k="alternative"] span').textContent = "Alternative";
  try {
    let state;
    if (MODE === "live" && BACKEND) {
      const ex = DEMO.examples[kind];
      line(`Running the real agent: "${ex.goal}" simulate=${JSON.stringify(ex.simulate)} … (CPU model, ~10-30 s per LLM step)`, "warn");
      const { run_id } = await postJSON("/api/run", { goal: ex.goal, simulate: ex.simulate });
      do { await sleep(1500); check(); state = await getJSON(`/api/runs/${run_id}`); } while (state.status === "running");
    } else state = DEMO.examples[kind].states.initial;
    const recs = state.history.filter((h) => (h.attempts || []).some((a) => !a.ok));
    for (const rec of recs) {
      $$("#pipeline .pnode").forEach((n) => { n.className = "pnode"; }); $$("#pipeline > i").forEach((x) => x.classList.remove("lit"));
      line(`▶ ${rec.tool}: ${rec.thought}`);
      const nodes = $$("#pipeline .pnode"), links = $$("#pipeline > i");
      for (const [i, a] of rec.attempts.entries()) {
        const idx = { original: 0, retry: 1, alternative: 2 }[a.kind];
        nodes[idx].classList.add("active"); await sleep(T().beat); check();
        nodes[idx].className = "pnode " + (a.ok ? "ok" : "fail");
        if (a.kind === "alternative") $('#pipeline [data-k="alternative"] span').textContent = a.note || "Alternative";
        line(`${a.ok ? "✓" : "✕"} ${a.kind}: ${a.ok ? (a.note || "success") : a.error}`, a.ok ? "ok" : "bad");
        if (i < rec.attempts.length - 1 || !a.ok) links[idx]?.classList.add("lit");
        await sleep(T().step * 0.6); check();
      }
      if (!rec.attempts.some((a) => a.kind === "alternative")) {
        nodes[2].className = "pnode skip"; links[2].classList.add("lit");
        $('#pipeline [data-k="alternative"] span').textContent = rec.status === "recovered" ? "not needed" : "none available";
      }
      const out = nodes[3]; const label = { recovered: "Recovered ✓", skipped: "Skipped (optional)", failed: "Stopped politely" }[rec.status] || rec.status;
      out.className = "pnode " + (rec.status === "recovered" ? "ok" : rec.status === "skipped" ? "active" : "fail");
      $("span", out).textContent = label;
      line(`↻ ${rec.recovery}`, "warn");
      await sleep(T().step); check();
    }
    line(`Run finished with status "${state.status}". ${state.final_answer ? state.final_answer.slice(0, 220) : ""}`, state.status === "failed" ? "bad" : "ok");
  } catch (e) { if (!(e instanceof Cancelled)) line("⚠ " + e.message, "bad"); }
}

/* ===== HUMAN APPROVAL tab ===== */
const appr = { handled: new Set(), items: [], tok: 0 };
async function loadApprovals() {
  const items = [];
  if (BACKEND) { try { (await getJSON("/api/approvals")).forEach((r) => items.push({ src: "live", run_id: r.run_id, goal: r.goal })); } catch { /* ignore */ } }
  ["approve", "reject"].filter((k) => !appr.handled.has(k)).forEach((k) => items.push({ src: "demo", key: k, run_id: DEMO.examples[k].states.initial.run_id, goal: DEMO.examples[k].goal }));
  appr.items = items;
  $("#apprSrc").textContent = BACKEND ? "state/ + demo" : "demo";
  $("#apprList").innerHTML = items.length ? items.map((r, i) => `<li data-i="${i}"><span class="status waiting_for_approval">waiting_for_approval</span><span class="g">${esc(r.goal)}</span><small>${esc(r.run_id)} · ${r.src}</small></li>`).join("")
    : '<li class="muted">No pending approvals. Run a goal that says “book the hotel”.</li>';
}
async function openApproval(i) {
  const it = appr.items[i]; if (!it) return;
  $$("#apprList li").forEach((li) => li.classList.toggle("on", +li.dataset.i === i));
  const s = it.src === "live" ? await getJSON(`/api/runs/${it.run_id}`) : DEMO.examples[it.key].states.initial;
  const a = s.pending_approval; if (!a) return;
  appr.current = it;
  $("#apprView").classList.remove("muted");
  $("#apprView").innerHTML = `<div class="booking"><div><b>${esc(a.question)}</b><div class="tiny muted">run ${esc(s.run_id)} · status <span class="amber">waiting_for_approval</span></div></div>${bookingKV(a)}
    <div class="modal-actions" style="justify-content:flex-start"><button class="btn approve" data-decide="approve">✓ Approve</button><button class="btn reject" data-decide="reject">✕ Reject</button></div><div id="apprOut"></div></div>`;
}
async function decideApproval(decision) {
  const it = appr.current; if (!it) return;
  const out = $("#apprOut"); $$("#apprView [data-decide]").forEach((b) => (b.disabled = true));
  out.innerHTML = `<div class="outcome"><span class="spin-sm"></span> ${decision === "approve" ? "Approved - running book_hotel…" : "Rejected - finishing without booking…"}</div>`;
  let s;
  if (it.src === "live") {
    await postJSON(`/api/runs/${it.run_id}/${decision}`);
    do { await sleep(1500); s = await getJSON(`/api/runs/${it.run_id}`); } while (["running", "waiting_for_approval"].includes(s.status));
  } else { await sleep(T().step); s = DEMO.examples[it.key].states[decision]; appr.handled.add(it.key); }
  const bk = s.memory.booking;
  out.innerHTML = decision === "approve" && bk
    ? `<div class="outcome ok"><b class="teal">✓ book_hotel executed → ${esc(bk.booking_id)}</b> saved to data/bookings.json · status <code>${s.status}</code><p class="tiny">${esc(s.final_answer)}</p></div>`
    : `<div class="outcome no"><b class="coral">✕ Not booked.</b> The agent did not call book_hotel · status <code>${s.status}</code><p class="tiny">${esc(s.final_answer)}</p></div>`;
  const keepView = $("#apprView").innerHTML; await loadApprovals(); $("#apprView").innerHTML = keepView;
}
const openFirstApproval = async () => { appr.handled.clear(); await loadApprovals(); await openApproval(appr.items.findIndex((x) => x.src === "demo")); await sleep(T().step); await decideApproval("approve"); };

/* ===== RESULTS tab ===== */
const SHORT = { "Normal trip": "Normal", "Tight budget -> re-plan": "Re-plan", "Unknown city": "Unknown city", "Weather API failure": "Weather down", "User rejects booking": "Reject", "User approves booking": "Approve" };
let chart = null; const resTok = { v: 0 };
function countUp(node, to, suffix = "", decimals = 0) {
  const dur = T().countUp, t0 = performance.now(), tok = resTok.v;
  const tick = (now) => { if (tok !== resTok.v) return; const k = dur ? Math.min(1, (now - t0) / dur) : 1; const e = 1 - Math.pow(1 - k, 3);
    node.textContent = (to * e).toFixed(decimals) + suffix; if (k < 1) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function animateResults() {
  if (!RESULTS) return; resTok.v++;
  const rows = RESULTS.rows;
  const sum = (f) => rows.reduce((n, r) => n + f(r), 0);
  const tiles = [["Goals passed", RESULTS.passed, ` / ${RESULTS.total}`], ["Steps executed", sum((r) => r.steps), ""], ["Recoveries", sum((r) => r.recoveries), ""],
    ["Approvals handled", rows.filter((r) => r.approval !== "n/a").length, ""], ["Avg seconds / goal", sum((r) => r.seconds) / rows.length, " s", 1]];
  $("#tiles").innerHTML = tiles.map(([l]) => `<div class="card tile"><div class="v">0</div><small>${l}</small></div>`).join("");
  $$("#tiles .v").forEach((n, i) => countUp(n, tiles[i][1], tiles[i][2], tiles[i][3] || 0));
  $("#resTable").innerHTML = `<thead><tr><th>Case</th><th>Steps</th><th>Tools used</th><th>Recoveries</th><th>Approval</th><th>Final status</th><th>Plan</th><th>Pass</th><th>Time</th></tr></thead><tbody>${rows.map((r) =>
    `<tr><td><b>${esc(r.case)}</b><div class="tiny muted">${esc(r.goal)}</div></td><td>${r.steps}</td><td>${r.tools.length}</td><td>${r.recoveries}</td><td>${esc(r.approval)}</td>
     <td><span class="status ${r.status}">${r.status}</span></td><td class="tiny">${esc(r.plan_source)}</td><td>${r.pass ? '<span class="teal">✓</span>' : '<span class="coral">✕</span>'}</td><td>${r.seconds}s</td></tr>`).join("")}</tbody>`;
  const llmPlans = rows.filter((r) => r.plan_source === "llm plan").length;
  $("#findings").innerHTML = [
    `<b>${RESULTS.passed}/${RESULTS.total}</b> test goals ended with the expected status and behaviour.`,
    "Tight budget: the best-rated hotel under the limit went over budget → the agent re-planned to a cheaper hotel and recalculated.",
    "Weather API down: the retry also failed → cached climate data was used and the trip was still planned.",
    "Unknown city: the optional weather step was skipped; hotel search failed after one retry → the agent stopped politely and listed the supported cities.",
    "book_hotel ran only after Approve. Reject ended with status <code>rejected</code> and nothing written to bookings.json.",
    `The 0.5B model produced a valid plan in <b>${llmPlans}/${rows.length}</b> runs; the rest used the rule-based fallback plan, so the run never breaks.`,
  ].map((x) => `<li>${x}</li>`).join("");
  if (window.Chart) {
    chart?.destroy();
    Chart.defaults.color = "#8C97AA"; Chart.defaults.font.family = "Inter";
    chart = new Chart($("#chart"), { type: "bar",
      data: { labels: rows.map((r) => SHORT[r.case] || r.case), datasets: [
        { label: "Steps", data: rows.map((r) => r.steps), backgroundColor: "rgba(45,212,191,.75)", borderRadius: 6 },
        { label: "Recoveries", data: rows.map((r) => r.recoveries), backgroundColor: "rgba(255,107,107,.8)", borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, animation: { duration: T().countUp },
        scales: { x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: false } },
          y: { beginAtZero: true, grid: { color: "rgba(255,255,255,.06)" }, ticks: { precision: 0 } } },
        plugins: { legend: { labels: { boxWidth: 12 } } } } });
  }
}

/* ===== HOW IT WORKS tab ===== */
function renderHow() {
  $("#howTools").innerHTML = `<thead><tr><th>Tool</th><th>Purpose</th><th>Args</th><th>Output</th><th>Can fail how → recovery</th></tr></thead><tbody>${TOOL_META.map((t) =>
    `<tr><td><code>${t.name}</code></td><td>${t.purpose}</td><td class="tiny"><code>${t.args}</code></td><td class="tiny">${t.out}</td><td class="tiny">${t.fail}</td></tr>`).join("")}</tbody>`;
  $("#snips").innerHTML = SNIPPETS.map((s) => `<div class="card snip"><div class="fn">${s.file}</div><pre>${esc(s.code)}</pre></div>`).join("");
  if (BACKEND) $("#docsLink").insertAdjacentHTML("afterend", ' · <a href="/docs/workflow.md" target="_blank" rel="noopener">local copy</a>');
}

/* ===== JSON viewer ===== */
function showJSON(title, obj) { $("#jsonTitle").textContent = title; $("#jsonPre").textContent = JSON.stringify(obj, null, 2); $("#jsonModal").hidden = false; }

/* ===== GUIDED TOUR ===== */
async function decideLive(key, decision) {
  if (!(live.waiting && live.exKey === key)) {
    if (live.exKey === key && live.promise) await live.promise;
    if (!(live.waiting && live.exKey === key)) await runExample(key);
  }
  await sleep(T().tour * 0.6);
  if (live.waiting) { $(decision === "approve" ? "#approveBtn" : "#rejectBtn").classList.add("on"); await decide(decision); }
}
const TOUR = [
  { tab: "overview", el: "#hero", req: "Realistic workflow", cap: "One real-world goal – plan a trip and book the hotel. The agent breaks it into steps and completes them one by one." },
  { tab: "overview", el: "#reqGrid", req: "All 7 requirements", cap: "Each Task 11 requirement has a card. Clicking a card opens the tab that proves it." },
  { tab: "live", el: "#liveGrid", req: "Multi-step execution · Multiple tools", cap: "Normal trip: understand goal → LLM plan → weather → hotels → attractions → budget → itinerary → summary.", act: () => runExample("normal") },
  { tab: "live", el: "#statePanel", req: "State / history", cap: "Every step updates ONE AgentState object (params, plan, history, errors, approvals), saved as JSON after each step." },
  { tab: "live", el: "#liveGrid", req: "Error recovery · re-plan", cap: "Tight budget: the best-rated hotel breaks the budget, so the agent re-plans with a cheaper hotel and recalculates.", act: () => runExample("tight") },
  { tab: "live", el: "#liveGrid", req: "Error recovery", cap: "Weather API down: the call fails, the retry fails, so the agent uses cached climate data and keeps going.", act: () => runExample("weather_down") },
  { tab: "live", el: "#liveGrid", req: "Human approval", cap: "This goal asks to book. Booking spends money, so the agent pauses with status waiting_for_approval.", act: () => runExample("approve") },
  { tab: "live", el: "#modalCard", req: "Human approval", cap: "The human reviews the booking summary and approves. Only now does book_hotel run.", act: () => decideLive("approve", "approve") },
  { tab: "live", el: "#summary", req: "Multi-step execution", cap: "The final summary is written by the local LLM and checked against the real numbers. The booking id is included." },
  { tab: "live", el: "#liveGrid", req: "Human approval", cap: "Same flow for Kochi, but this time the human will reject the booking.", act: () => runExample("reject") },
  { tab: "live", el: "#modalCard", req: "Human approval", cap: "Reject → nothing is booked. The run ends politely with status rejected.", act: () => decideLive("reject", "reject") },
  { tab: "tools", el: "#tool-get_weather", req: "Multiple tools", cap: "Six tools, each with a Pydantic argument schema. get_weather calls the free Open-Meteo API.", act: () => runToolCard("get_weather") },
  { tab: "tools", el: "#tool-calculate_budget", req: "Multiple tools", cap: "calculate_budget returns the total and whether it is over or under the budget.", act: () => runToolCard("calculate_budget") },
  { tab: "state", el: "#tab-state .split", req: "State / history", cap: "Every run is saved in state/. Opening one replays its full step history, including the re-plan.", act: () => openFirstRun() },
  { tab: "recovery", el: "#tab-recovery .card", req: "Error recovery", cap: "No hotels under budget: fail → retry → raise the nightly limit by 20% → success.", act: () => simulate("no_hotels") },
  { tab: "recovery", el: "#tab-recovery .card", req: "Error recovery", cap: "Invalid arguments: Pydantic rejects them, so the agent rebuilds the arguments from its state and retries.", act: () => simulate("bad_args") },
  { tab: "approval", el: "#tab-approval .split", req: "Human approval", cap: "Pending approvals are listed here too. Approve runs book_hotel; Reject ends the run with nothing booked.", act: () => openFirstApproval() },
  { tab: "results", el: "#tab-results", req: "Evaluation", cap: "evaluate.py ran 6 goals end to end: steps, tools, recoveries, approvals and final status.", act: () => sleep(T().countUp) },
  { tab: "how", el: "#diagram", req: "Documented workflow", cap: "The workflow, tools, state and recovery rules are documented here and in docs/workflow.md. Thanks for watching!" },
];
const tour = { on: false, i: 0, playing: true, tok: 0, done: false, el: null, timer: null };
function placeSpot() {
  if (!tour.on || !tour.el) return;
  const target = tour.el === "#modalCard" && $("#modal").hidden ? null : $(tour.el);
  const spot = $("#spot"); if (!target || !target.offsetParent && target.id !== "modalCard") { spot.hidden = true; return; }
  const r = target.getBoundingClientRect(), pad = 8, top = Math.max(r.top - pad, 4), bottom = Math.min(r.bottom + pad, innerHeight - 4);
  Object.assign(spot.style, { top: top + "px", left: Math.max(r.left - pad, 4) + "px", width: Math.min(r.width + pad * 2, innerWidth - 8) + "px", height: Math.max(bottom - top, 30) + "px" });
  spot.hidden = false;
}
function updateBar() {
  $("#tourCount").textContent = `${tour.i + 1} / ${TOUR.length}`;
  $("#tourPlay").textContent = tour.playing ? "⏸ Pause" : "▶ Play";
  $("#tourBack").disabled = tour.i === 0; $("#tourNext").disabled = tour.i >= TOUR.length - 1;
}
async function tourGo(i) {
  if (i < 0 || i >= TOUR.length) return;
  clearTimeout(tour.timer); tour.i = i; const tok = ++tour.tok; tour.done = false;
  const s = TOUR[i]; tour.el = s.el;
  $("#jsonModal").hidden = true;
  showTab(s.tab); updateBar();
  $("#capReq").textContent = s.req; $("#capText").textContent = s.cap; $("#caption").hidden = false;
  await sleep(T().fade); if (tok !== tour.tok) return;  // let the tab fade in before measuring
  const target = $(s.el); if (target && target.id !== "modalCard") target.scrollIntoView({ block: "center", behavior: REDUCED ? "auto" : "smooth" });
  placeSpot();
  try { if (s.act) await s.act(); } catch (e) { if (!(e instanceof Cancelled)) console.warn(e); }
  if (tok !== tour.tok) return;
  tour.done = true; placeSpot(); scheduleNext();
}
function scheduleNext() {
  clearTimeout(tour.timer);
  if (!tour.on || !tour.playing || !tour.done) return;
  const tok = tour.tok;
  tour.timer = setTimeout(() => { if (tok !== tour.tok || !tour.playing) return; if (tour.i < TOUR.length - 1) tourGo(tour.i + 1); else { tour.playing = false; updateBar(); } }, T().tour);
}
function startTour() {
  tour.on = true; tour.playing = true; document.body.classList.add("touring");
  if (MODE !== "demo") setMode("demo");
  $("#tourStart").hidden = true; $("#tourCtl").hidden = false;
  tour.spotTimer = setInterval(placeSpot, 250);
  tourGo(0);
}
function exitTour() {
  tour.on = false; tour.tok++; clearTimeout(tour.timer); clearInterval(tour.spotTimer);
  document.body.classList.remove("touring");
  $("#spot").hidden = true; $("#caption").hidden = true; $("#tourStart").hidden = false; $("#tourCtl").hidden = true;
}
function togglePlay() { tour.playing = !tour.playing; updateBar(); if (tour.playing) scheduleNext(); else clearTimeout(tour.timer); }

/* ===== mode ===== */
function setMode(m) {
  MODE = m;
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === m));
  $("#simWrap").hidden = m !== "live";
  $("#modePill").textContent = m === "live" ? "● Live agent (local CPU model)" : "Instant demo";
  $("#modePill").classList.toggle("live", m === "live");
  $("#modeHint").innerHTML = m === "live" ? "Live: your goal goes to the real agent in <code>app.py</code>. Approve/Reject call the real endpoints."
    : BACKEND ? "Instant demo replays real precomputed runs. Switch to <b>Run live</b> to send any goal to the real agent." : "Instant demo replays real precomputed runs. Start <code>python app.py</code> to unlock “Run live”.";
}

/* ===== wiring ===== */
function wire() {
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, [data-go], li[data-i]"); if (!t) return;
    if (t.dataset.tab) showTab(t.dataset.tab);
    else if (t.dataset.go) showTab(t.dataset.go);
    else if (t.dataset.speed) { setSpeed(t.dataset.speed); if (tour.on) scheduleNext(); }
    else if (t.dataset.ex) runExample(t.dataset.ex);
    else if (t.dataset.mode) setMode(t.dataset.mode);
    else if (t.dataset.run) runToolCard(t.dataset.run);
    else if (t.dataset.sim) simulate(t.dataset.sim);
    else if (t.dataset.decide) decideApproval(t.dataset.decide);
    else if (t.matches("#runList li")) openRun(+t.dataset.i);
    else if (t.matches("#apprList li")) openApproval(+t.dataset.i);
  });
  $("#runBtn").onclick = () => { $$("#examples .btn").forEach((b) => b.classList.remove("on")); startRun(null); };
  $("#goal").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#runBtn").click(); });
  $("#approveBtn").onclick = () => decide("approve");
  $("#rejectBtn").onclick = () => decide("reject");
  $("#modalX").onclick = closeModal;
  $("#jsonX").onclick = () => ($("#jsonModal").hidden = true);
  $("#viewJson").onclick = () => live.state ? showJSON("AgentState (live snapshot)", snapshot(live.state, live.shown)) : showJSON("AgentState", { note: "No run yet" });
  $("#replayJson").onclick = () => hist.current && showJSON(`state/${hist.current.run_id}.json`, hist.current);
  $("#heroTour").onclick = startTour; $("#tourStart").onclick = startTour; $("#tourExit").onclick = exitTour;
  $("#tourPlay").onclick = togglePlay;
  $("#tourNext").onclick = () => tourGo(tour.i + 1); $("#tourBack").onclick = () => tourGo(tour.i - 1);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("#jsonModal").hidden = true; }
    if (!tour.on || e.target.matches("input, textarea, select")) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowRight") { e.preventDefault(); tourGo(tour.i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); tourGo(tour.i - 1); }
  });
  addEventListener("resize", placeSpot); addEventListener("scroll", placeSpot, { passive: true });
}

async function init() {
  setSpeed(SPEED[store.get("speed")] ? store.get("speed") : "medium");
  wire(); renderOverview();
  try { [DEMO, RESULTS] = await Promise.all([getJSON("demo_runs.json"), getJSON("results.json").catch(() => null)]); }
  catch (e) { $("#trace").innerHTML = `<div class="tstep failed">Could not load demo_runs.json (${esc(e.message)}). Open the page via <code>python app.py</code>.</div>`; return; }
  try { const ctl = new AbortController(); setTimeout(() => ctl.abort(), 1500); BACKEND = (await (await fetch("/api/health", { signal: ctl.signal })).json()).ok === true; } catch { BACKEND = false; }
  $("#modeSeg").hidden = !BACKEND;
  setMode("demo");
  $("#examples").innerHTML = EX_ORDER.map((k) => `<button class="btn ex" data-ex="${k}">${esc(DEMO.examples[k].label.replace("->", "→"))}</button>`).join("");
  renderTools(); renderHow();
}
init();
