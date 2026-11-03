"""Agentic Trip Planner: goal -> LLM plan -> Thought/Action/Observation loop -> approval -> summary.

Flow (see docs/workflow.md):
  1 understand_goal (LLM, JSON)   2 make_plan (LLM, JSON; fallback plan if invalid)
  3..n tools one by one with error recovery (retry once -> alternative -> skip/fail)
  over budget -> re-plan (cheaper hotel / budget daily spend) -> recalculate
  book_hotel -> PAUSE (waiting_for_approval) -> resume(approve|reject)
  last: write_summary (LLM, checked against facts; template if the LLM invents numbers)
"""
import re
import time
from datetime import date, timedelta

from pydantic import ValidationError

import llm
from state import AgentState, PlanStep, StepRecord, TripParams, now
from tools import SIMULATE, TOOLS, ToolError, cached_weather, preview_booking, run_tool, WeatherArgs

MAX_STEPS = 10            # max tool actions per run (LLM steps not counted)
HOTEL_SHARE = 0.7         # at most 70% of the budget goes to the hotel
DAILY_SPEND = 1000        # food + transport + tickets, per person per day (Rs)
BUDGET_DAILY_SPEND = 700  # cheaper "budget mode" used when re-planning
START_IN_DAYS = 7         # trips start one week from today
TOOL_ORDER = list(TOOLS)  # get_weather, search_hotels, find_attractions, calculate_budget, create_itinerary, book_hotel
REQUIRED = {"search_hotels", "find_attractions", "calculate_budget", "create_itinerary"}
LABELS = {"understand_goal": "Understand the goal", "make_plan": "Make a plan", "get_weather": "Check the weather",
          "search_hotels": "Search hotels in budget", "find_attractions": "Pick top attractions",
          "calculate_budget": "Calculate total budget", "create_itinerary": "Build day-by-day itinerary",
          "book_hotel": "Book hotel (needs approval)", "write_summary": "Write final summary"}
KNOWN_CITIES = ["Goa", "Jaipur", "Mumbai", "Delhi", "Bengaluru", "Udaipur", "Kochi", "Manali", "Chennai", "Varanasi"]
WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8}


# ---------------------------------------------------------------- goal understanding
def rule_parse(goal: str) -> dict:
    """Regex fallback / cross-check for the LLM extraction."""
    g, out = goal.lower(), {}
    if m := re.search(r"(\d+|" + "|".join(WORDS) + r")[- ]?days?", g):
        out["days"] = int(WORDS.get(m.group(1), m.group(1)))
    if re.search(r"\b(solo|alone|myself|just me)\b", g):
        out["guests"] = 1
    elif re.search(r"\bcouple\b", g):
        out["guests"] = 2
    elif m := re.search(r"for (\d+|" + "|".join(WORDS) + r") ?(people|persons|adults|guests|travell?ers|friends|of us)", g):
        out["guests"] = int(WORDS.get(m.group(1), m.group(1)))
    if m := re.search(r"(?:rs\.?|inr|₹|under|budget(?: of)?)\s*([\d,]+)\s*(k\b)?", g):
        out["budget"] = float(m.group(1).replace(",", "")) * (1000 if m.group(2) else 1)
    city = next((c for c in KNOWN_CITIES if c.lower() in g), None)
    if not city and (m := re.search(r"\b(?:to|in|visit)\s+([A-Z][a-zA-Z]+)", goal)):
        city = m.group(1)
    if city:
        out["city"] = city
    out["book"] = bool(re.search(r"\bbook\b", g))
    if m := re.search(r"\bbook\b.*?\bfor\s+([A-Z][a-z]{1,30})\b", goal):
        out["guest_name"] = m.group(1)
    return out


def understand_goal(goal: str) -> tuple[TripParams, str]:
    """LLM extracts JSON; each field is validated and cross-checked against the rule parser."""
    system = ("Extract trip details from the user goal. Reply with ONLY a JSON object with keys: city (string), "
              "days (integer), guests (integer), budget (number, in rupees), book (true if the user asks to book "
              "a hotel), guest_name (string or null).")
    raw = llm.extract_json(llm.chat(system, goal, 120))
    raw = raw if isinstance(raw, dict) else {}
    rules = rule_parse(goal)
    merged, used_rules = {}, False
    for key in ("city", "days", "guests", "budget", "book", "guest_name"):
        v = raw.get(key)
        ok = v not in (None, "", "null")
        if ok and key == "city":
            ok = isinstance(v, str) and v.lower() in goal.lower()       # reject hallucinated cities
        if ok and key in ("days", "guests", "budget"):
            try:
                v = float(str(v).replace(",", ""))
                ok = key not in rules or v == rules[key]                # numbers must agree with the text
            except ValueError:
                ok = False
        if ok and key == "book":
            ok = isinstance(v, bool) and v == rules["book"]
        if ok and key == "guest_name":
            ok = isinstance(v, str) and v in goal
        if ok:
            merged[key] = int(v) if key in ("days", "guests") else v
        elif key in rules:
            merged[key], used_rules = rules[key], True
    merged.setdefault("guests", 2)  # sensible default: a couple
    source = "rules (fallback)" if not raw else ("llm + rules" if used_rules else "llm")
    return TripParams(**{k: v for k, v in merged.items() if v is not None}), source


# ---------------------------------------------------------------- planning
def make_plan(p: TripParams) -> tuple[list[str], str]:
    """LLM proposes the tool order. Invalid/unsafe plan -> fixed rule-based default ("fallback plan")."""
    system = ("You are a trip-planning agent. Choose the tools needed for the goal and order them.\n"
              "Tools:\n- get_weather: forecast for the trip\n- search_hotels: hotels under a price\n"
              "- find_attractions: top sights\n- calculate_budget: total cost (needs a hotel)\n"
              "- create_itinerary: day plan (needs weather and attractions)\n"
              "- book_hotel: books the hotel, only if the user asks\n"
              "Reply with ONLY a JSON array of tool names.\n"
              "Example goal: 2-day trip to Delhi for 1 person, budget Rs 9,000. Book the hotel.\n"
              'Example answer: ["get_weather", "search_hotels", "find_attractions", "calculate_budget", '
              '"create_itinerary", "book_hotel"]')
    user = f"Goal: {p.days}-day trip to {p.city} for {p.guests} people, budget Rs {p.budget:,.0f}." + \
           (" Book the hotel." if p.book else " Do not book anything.")
    plan = llm.extract_json(llm.chat(system, user, 80))
    default = [t for t in TOOL_ORDER if t != "book_hotel" or p.book]
    if not isinstance(plan, list):
        return default, "fallback plan"
    steps = list(dict.fromkeys(t for t in plan if isinstance(t, str) and t in TOOLS))  # known tools, no repeats
    steps = [t for t in steps if t != "book_hotel"] + (["book_hotel"] if p.book else [])  # booking only if asked, last
    pos = {t: i for i, t in enumerate(steps)}
    deps = [("search_hotels", "calculate_budget"), ("find_attractions", "create_itinerary"),
            ("get_weather", "create_itinerary"), ("calculate_budget", "book_hotel")]
    valid = REQUIRED <= set(steps) and all(pos[a] < pos[b] for a, b in deps if a in pos and b in pos)
    return (steps, "llm plan") if valid else (default, "fallback plan")


# ---------------------------------------------------------------- tool call with error recovery
def call_tool(state: AgentState, item: PlanStep, thought: str, args: dict,
              repair=None, alternative=None, optional=False) -> StepRecord:
    """Thought -> Action -> Observation, with recovery: retry once -> alternative -> skip (optional) / fail."""
    rec = StepRecord(plan_id=item.id, thought=thought, tool=item.tool, args=args)
    t0 = _ms()
    tries = [("original", args), ("retry", None)]
    err = None
    for kind, a in tries:
        if a is None:  # retry: same args, or repaired args if they were invalid
            a = repair() if (repair and isinstance(err, ValidationError)) else args
        try:
            rec.result = run_tool(item.tool, a)
            rec.attempts.append({"kind": kind, "args": a, "ok": True})
            rec.args = a
            rec.status = "done" if kind == "original" else "recovered"
            if kind == "retry":
                rec.recovery = "Fixed the invalid arguments and retried - success." if isinstance(err, ValidationError) \
                    else "Retried once - success."
            break
        except (ToolError, ValidationError) as e:
            err = e
            msg = _err_text(e)
            rec.attempts.append({"kind": kind, "args": a, "ok": False, "error": msg})
            state.errors.append({"step": item.id, "tool": item.tool, "attempt": kind, "error": msg, "time": now()})
    else:  # both tries failed -> alternative
        alt = alternative(err) if alternative else None
        if alt:
            desc, fn, a = alt
            try:
                rec.result = fn(a)
                rec.attempts.append({"kind": "alternative", "args": a if isinstance(a, dict) else a.model_dump(mode="json"),
                                     "ok": True, "note": desc})
                rec.status, rec.recovery = "recovered", f"Retry failed, so: {desc} - success."
            except (ToolError, ValidationError) as e:
                rec.attempts.append({"kind": "alternative", "ok": False, "note": desc, "error": _err_text(e)})
                state.errors.append({"step": item.id, "tool": item.tool, "attempt": "alternative",
                                     "error": _err_text(e), "time": now()})
        if rec.status != "recovered":
            rec.status = "skipped" if optional else "failed"
            rec.result = {"error": _err_text(err)}
            rec.recovery = "Optional step - skipped it and continued." if optional else "No alternative left - step failed."
    rec.duration_ms = _ms() - t0
    return rec


def _err_text(e: Exception) -> str:
    if isinstance(e, ValidationError):
        return "invalid arguments: " + "; ".join(f"{'.'.join(map(str, x['loc']))} {x['msg']}" for x in e.errors())
    return str(e)


def _ms() -> int:
    return int(time.perf_counter() * 1000)


# ---------------------------------------------------------------- step handlers
def _record(state, item, rec):
    state.history.append(rec)
    item.status = rec.status
    state.save()


def step_weather(state, item):
    p, m = state.params, state.memory
    args = {"city": p.city, "days": p.days, "start_date": m["check_in"]}

    def alternative(err):  # API down -> cached typical climate (unknown city -> no cache -> skip)
        return ("used cached typical-climate data", cached_weather, WeatherArgs(**args))
    rec = call_tool(state, item, f"I need the weather in {p.city} for the {p.days} trip days so the itinerary can "
                    "avoid rain. Weather is optional: if it fails I can still plan.", args,
                    alternative=alternative, optional=True)
    m["weather"] = rec.result if rec.status != "skipped" else None
    _record(state, item, rec)


def step_hotels(state, item):
    p, m = state.params, state.memory
    cap = round(p.budget * HOTEL_SHARE / m["nights"])
    args = {"city": p.city, "max_price_per_night": cap, "guests": p.guests}

    def alternative(err):  # nothing under budget -> raise the nightly limit by 20%
        if getattr(err, "kind", "") != "no_match":
            return None
        new = {**args, "max_price_per_night": round(cap * 1.2)}
        return (f"raised the nightly limit by 20% to Rs {new['max_price_per_night']:,}",
                lambda a: run_tool("search_hotels", a), new)
    thought = (f"Hotel gets at most {HOTEL_SHARE:.0%} of the budget: Rs {p.budget:,.0f} x {HOTEL_SHARE} / "
               f"{m['nights']} nights = Rs {cap:,}/night. Search {p.city} hotels for {p.guests} guests under that.")
    if "bad_args" in state.simulate:  # simulated bad arguments from the model
        args = {"city": p.city, "max_price_per_night": -cap, "guests": "two"}
        thought += " (simulated: the model produced broken arguments)"
    rec = call_tool(state, item, thought, args, alternative=alternative,
                    repair=lambda: {"city": p.city, "max_price_per_night": cap, "guests": p.guests})
    if rec.status in ("done", "recovered"):
        m["hotels"] = rec.result["hotels"]
        m["chosen_hotel"] = rec.result["hotels"][0]  # best rated within the limit
        rec.result = {**rec.result, "chosen": m["chosen_hotel"]["name"]}
    _record(state, item, rec)


def step_attractions(state, item):
    p = state.params
    rec = call_tool(state, item, f"Pick the top-rated sights in {p.city} - about 2 per day for {p.days} days.",
                    {"city": p.city, "top_n": min(10, 2 * p.days)}, optional=True)
    state.memory["attractions"] = rec.result.get("attractions", []) if rec.status != "skipped" else []
    _record(state, item, rec)


def step_budget(state, item):
    p, m = state.params, state.memory
    h, spend = m["chosen_hotel"], m.get("daily_spend", DAILY_SPEND)
    args = {"hotel_price": h["price_per_night"], "nights": m["nights"], "guests": p.guests,
            "daily_spend": spend, "budget": p.budget}
    rec = call_tool(state, item, f"Check the total: {h['name']} (Rs {h['price_per_night']:,}/night) for "
                    f"{m['nights']} nights + Rs {spend}/person/day spending, against Rs {p.budget:,.0f}.", args)
    if rec.status in ("done", "recovered"):
        m["budget"] = rec.result
        if rec.result["status"] == "over":
            _insert_replan(state, item, rec.result)
    _record(state, item, rec)


def _insert_replan(state, item, budget):
    """Over budget -> insert a re-plan step + a recalculation right after this step."""
    m, over = state.memory, -budget["difference"]
    cheaper = [h for h in m["hotels"] if h["price_per_night"] < m["chosen_hotel"]["price_per_night"]]
    if cheaper:
        change = {"type": "cheaper_hotel", "to": min(cheaper, key=lambda h: (-h["rating"], h["price_per_night"]))}
    elif m.get("daily_spend", DAILY_SPEND) > BUDGET_DAILY_SPEND:
        change = {"type": "budget_spend"}
    else:
        m.setdefault("warnings", []).append(f"Still Rs {over:,} over budget - this is the cheapest option we have.")
        return
    i = state.plan.index(item)
    n = len(state.plan)
    state.plan[i + 1:i + 1] = [
        PlanStep(id=f"s{n + 1}", tool="re_plan", label="Re-plan: over budget", added_by_replan=True),
        PlanStep(id=f"s{n + 2}", tool="calculate_budget", label="Recalculate budget", added_by_replan=True)]
    m["pending_change"] = {**change, "over_by": over}


def step_replan(state, item):
    m = state.memory
    ch = m.pop("pending_change")
    old = m["chosen_hotel"]
    if ch["type"] == "cheaper_hotel":
        m["chosen_hotel"] = ch["to"]
        thought = f"Over budget by Rs {ch['over_by']:,}. Re-plan: swap {old['name']} for the cheaper {ch['to']['name']}."
        result = {"change": "cheaper hotel", "from": f"{old['name']} (Rs {old['price_per_night']:,})",
                  "to": f"{ch['to']['name']} (Rs {ch['to']['price_per_night']:,})"}
    else:
        m["daily_spend"] = BUDGET_DAILY_SPEND
        thought = f"Over budget by Rs {ch['over_by']:,} and no cheaper hotel. Re-plan: budget mode spending."
        result = {"change": "budget daily spend", "from": f"Rs {DAILY_SPEND}/person/day", "to": f"Rs {BUDGET_DAILY_SPEND}/person/day"}
    _record(state, item, StepRecord(plan_id=item.id, thought=thought, tool="re_plan", args={}, result=result,
                                    status="done", recovery="Over budget triggered a re-plan."))


def step_itinerary(state, item):
    p, m = state.params, state.memory
    weather = (m.get("weather") or {}).get("days", [])
    args = {"city": p.city, "days": p.days, "attractions": m.get("attractions", []), "weather": weather}
    note = "using the forecast to move indoor sights to rainy days" if weather else "no weather data, so plain order"
    rec = call_tool(state, item, f"Build a {p.days}-day plan for {p.city}, {note}.", args)
    m["itinerary"] = rec.result if rec.status != "failed" else None
    _record(state, item, rec)


def booking_args(state) -> dict:
    p, m = state.params, state.memory
    return {"hotel_id": m["chosen_hotel"]["id"], "guest_name": p.guest_name, "check_in": m["check_in"],
            "check_out": m["check_out"], "guests": p.guests}


def step_book_request(state, item):
    """Important action: do NOT book yet - build a summary and pause for a human."""
    args = booking_args(state)
    rec = StepRecord(plan_id=item.id, tool="book_hotel", args=args, status="waiting",
                     thought="Booking spends the user's money, so I must not do it alone. Pausing for human approval.")
    try:
        summary = preview_booking(TOOLS["book_hotel"]["schema"](**args))
    except (ToolError, ValidationError) as e:
        rec.status, rec.result = "failed", {"error": _err_text(e)}
        state.errors.append({"step": item.id, "tool": "book_hotel", "attempt": "preview", "error": _err_text(e), "time": now()})
        _record(state, item, rec)
        return
    b = state.memory.get("budget", {})
    summary |= {"trip_total": b.get("total"), "budget": b.get("budget"), "over_budget": b.get("status") == "over",
                "question": f"Book {summary['hotel_name']} for {summary['nights']} night(s), Rs {summary['total_inr']:,}?"}
    rec.result = {"waiting_for_approval": summary}
    state.pending_approval = summary
    state.status = "waiting_for_approval"
    _record(state, item, rec)


def step_summary(state, item):
    facts = summary_facts(state)
    text, source = facts, "template"
    try:
        out = llm.chat("Rewrite these trip facts as a friendly 3-4 sentence summary for the traveller. "
                       "Use ONLY the facts and numbers given. No markdown.", facts, 180)
        nums = lambda s: {x.replace(",", "") for x in re.findall(r"\d[\d,]*", s)}  # noqa: E731
        if state.params.city.lower() in out.lower() and len(out) > 60 and nums(out) <= nums(facts):
            text, source = out, "llm"
    except Exception as e:  # model problem -> template summary
        state.errors.append({"step": item.id, "tool": "llm", "attempt": "summary", "error": str(e), "time": now()})
    state.final_answer = text
    _record(state, item, StepRecord(plan_id=item.id, tool="llm", status="done", result={"summary": text, "source": source},
                                    thought="Everything is done. Write a short summary for the user (checked against the facts)."))


def summary_facts(state) -> str:
    p, m = state.params, state.memory
    h, b = m.get("chosen_hotel", {}), m.get("budget", {})
    lines = [f"Trip: {p.days} days in {p.city} for {p.guests} people, from {m['check_in']} to {m['check_out']}.",
             f"Hotel: {h.get('name')} in {h.get('area')}, Rs {h.get('price_per_night', 0):,} per night, rating {h.get('rating')}.",
             f"Estimated total: Rs {b.get('total', 0):,} of the Rs {p.budget:,.0f} budget ({b.get('status', '?')} budget)."]
    sights = [a["name"] for a in m.get("attractions", [])[:3]]
    if sights:
        lines.append("Highlights: " + ", ".join(sights) + ".")
    w = (m.get("weather") or {}).get("days")
    if w:
        lines.append(f"Weather: {w[0]['condition']}, {w[0]['min_c']:.0f} to {w[0]['max_c']:.0f} C.")
    bk = m.get("booking")
    if bk:
        lines.append(f"Booking confirmed: {bk['booking_id']}.")
    elif state.approvals and state.approvals[-1]["decision"] == "reject":
        lines.append("The hotel was NOT booked because the user rejected the booking.")
    for wmsg in m.get("warnings", []):
        lines.append("Warning: " + wmsg)
    return " ".join(lines)


HANDLERS = {"get_weather": step_weather, "search_hotels": step_hotels, "find_attractions": step_attractions,
            "calculate_budget": step_budget, "re_plan": step_replan, "create_itinerary": step_itinerary,
            "book_hotel": step_book_request, "write_summary": step_summary}


# ---------------------------------------------------------------- the loop
def start(goal: str, simulate: list[str] | None = None) -> AgentState:
    state = AgentState(goal=goal.strip(), simulate=sorted(set(simulate or [])))
    state.plan = [PlanStep(id="s1", tool="llm", label=LABELS["understand_goal"]),
                  PlanStep(id="s2", tool="llm", label=LABELS["make_plan"])]
    state.save()
    return state


def run(state: AgentState) -> AgentState:
    """Execute plan steps from state.current_step until done, failed, or paused for approval."""
    SIMULATE.set({"flags": set(state.simulate)})
    try:
        if state.params is None:
            _understand_and_plan(state)
        while state.status == "running" and state.current_step < len(state.plan):
            item = state.plan[state.current_step]
            if item.status in ("done", "recovered", "rejected"):   # already finished (e.g. after resume)
                state.current_step += 1
                continue
            if sum(h.tool not in ("llm",) for h in state.history) >= MAX_STEPS:
                _fail(state, "Step limit reached (max 10 tool actions).")
                break
            item.status = "running"
            state.save()
            HANDLERS[item.tool](state, item)
            if item.status == "failed" and item.tool not in ("get_weather", "find_attractions"):
                _fail(state, f"Couldn't finish '{item.label}': {state.history[-1].result.get('error')}")
                break
            if state.status == "waiting_for_approval":
                return state  # paused - resume() continues later
            state.current_step += 1
        if state.status == "running":
            rejected = any(a["decision"] == "reject" for a in state.approvals)
            state.status = "rejected" if rejected else "completed"
    except Exception as e:  # never crash the server: record and stop
        _fail(state, f"Unexpected error: {type(e).__name__}: {e}")
    state.save()
    return state


def _understand_and_plan(state: AgentState):
    s1, s2 = state.plan
    s1.status = "running"
    state.save()
    try:
        params, source = understand_goal(state.goal)
    except ValidationError as e:
        state.history.append(StepRecord(plan_id="s1", tool="llm", status="failed", result={"error": _err_text(e)},
                                        thought="Read the goal and extract city, days, guests and budget."))
        s1.status = "failed"
        _fail(state, "I couldn't understand the goal. Please mention a city, number of days, people and a budget, "
                     "e.g. 'Plan a 3-day trip to Goa for 2 people under Rs 15,000'.")
        return
    state.params, state.params_source = params, source
    nights = max(1, params.days - 1)
    check_in = date.today() + timedelta(days=START_IN_DAYS)
    state.memory.update({"nights": nights, "check_in": str(check_in), "check_out": str(check_in + timedelta(days=nights)),
                         "daily_spend": DAILY_SPEND})
    _record(state, s1, StepRecord(plan_id="s1", tool="llm", args={"goal": state.goal}, status="done",
                                  result={"params": params.model_dump(), "source": source},
                                  thought="Read the goal and extract city, days, guests and budget as JSON."))
    s2.status = "running"
    state.save()
    steps, plan_source = make_plan(params)
    state.plan_source = plan_source
    state.plan += [PlanStep(id=f"s{i + 3}", tool=t, label=LABELS[t]) for i, t in enumerate(steps)]
    state.plan.append(PlanStep(id=f"s{len(state.plan) + 1}", tool="write_summary", label=LABELS["write_summary"]))
    _record(state, s2, StepRecord(plan_id="s2", tool="llm", status="done",
                                  result={"plan": steps + ["write_summary"], "source": plan_source},
                                  thought="Break the goal into tool steps (JSON). If the plan is invalid, use the fixed default plan."))
    state.current_step = 2


def _fail(state: AgentState, message: str):
    state.status = "failed"
    state.final_answer = "Sorry - " + message[0].lower() + message[1:]
    for p in state.plan:
        if p.status in ("pending", "running"):
            p.status = "skipped"


def resume(run_id: str, decision: str) -> AgentState:
    """Human decision on the paused booking: 'approve' books it, 'reject' ends politely without booking."""
    state = AgentState.load(run_id)
    if state.status != "waiting_for_approval":
        raise ValueError(f"run {run_id} is not waiting for approval (status: {state.status})")
    item = state.plan[state.current_step]
    state.approvals.append({"action": "book_hotel", "decision": decision, "time": now(), "summary": state.pending_approval})
    state.pending_approval, state.status = None, "running"
    SIMULATE.set({"flags": set(state.simulate)})
    if decision == "approve":
        rec = call_tool(state, item, "The human approved - booking the hotel now.", booking_args(state))
        if rec.status in ("done", "recovered"):
            state.memory["booking"] = rec.result
        _record(state, item, rec)
        if rec.status == "failed":
            _fail(state, f"the booking failed: {rec.result.get('error')}")
            state.save()
            return state
    else:
        _record(state, item, StepRecord(plan_id=item.id, tool="book_hotel", args=booking_args(state), status="rejected",
                                        result={"booked": False, "message": "Not booked - the user rejected it."},
                                        thought="The human rejected the booking. I will not book; I'll finish politely."))
    state.current_step += 1
    return run(state)


def run_goal(goal: str, simulate: list[str] | None = None) -> AgentState:
    """Convenience: start + run (stops at approval if needed)."""
    return run(start(goal, simulate))


if __name__ == "__main__":
    import sys
    s = run_goal(" ".join(sys.argv[1:]) or "Plan a 3-day trip to Goa for 2 people under Rs 15,000 and book the hotel.")
    for h in s.history:
        print(f"[{h.status:9}] {h.tool:17} {h.thought}")
    print("STATUS:", s.status, "| run:", s.run_id)
    print(s.final_answer or s.pending_approval)
