"""Precompute real agent runs for every example button -> web/demo_runs.json.

The showcase page replays these step by step, so it works instantly without loading the model.
Runs that pause for approval are saved three times: waiting, after approve, after reject.
"""
import json
from datetime import datetime
from pathlib import Path

import agent
from state import STATE_DIR
from tools import SIMULATE, TOOLS, ToolError, preview_booking, run_tool

OUT = Path(__file__).parent / "web" / "demo_runs.json"

# key: (button label, goal, simulate flags)
EXAMPLES = {
    "normal": ("Normal trip", "Plan a 3-day trip to Jaipur for 2 people under Rs 20,000.", []),
    "tight": ("Tight budget -> re-plan", "Plan a 3-day trip to Goa for 2 people under Rs 15,000.", []),
    "weather_down": ("Weather API down -> recovery", "Plan a 3-day trip to Manali for 2 people under Rs 18,000.", ["weather_down"]),
    "unknown": ("Unknown city", "Plan a 2-day trip to Zorbania for 2 people under Rs 10,000.", []),
    "approve": ("Approve booking", "Plan a 2-day trip to Udaipur for 2 people under Rs 16,000 and book the hotel for Krishna.", []),
    "reject": ("Reject booking", "Plan a 3-day trip to Kochi for 2 people under Rs 16,000 and book the hotel.", []),
    "no_hotels": ("No hotels under budget", "Plan a 3-day trip to Varanasi for 2 people under Rs 14,000.", ["no_hotels"]),
    "bad_args": ("Invalid arguments", "Plan a 2-day trip to Chennai for 2 people under Rs 14,000.", ["bad_args"]),
}

# Pre-filled examples for the Tools tab (one per tool).
TOOL_EXAMPLES = {
    "get_weather": {"city": "Goa", "days": 3},
    "search_hotels": {"city": "Goa", "max_price_per_night": 5250, "guests": 2},
    "find_attractions": {"city": "Jaipur", "top_n": 4},
    "calculate_budget": {"hotel_price": 5200, "nights": 2, "guests": 2, "daily_spend": 1000, "budget": 15000},
    "create_itinerary": {"city": "Goa", "days": 2, "attractions": [
        {"name": "Basilica of Bom Jesus", "indoor": True, "rating": 4.7},
        {"name": "Baga & Calangute Beach", "indoor": False, "rating": 4.6},
        {"name": "Fort Aguada", "indoor": False, "rating": 4.5},
        {"name": "Goa Science Centre", "indoor": True, "rating": 4.1}],
        "weather": [{"date": "2026-12-10", "min_c": 23, "max_c": 32, "rain_chance_pct": 10, "condition": "mainly clear"},
                    {"date": "2026-12-11", "min_c": 23, "max_c": 29, "rain_chance_pct": 80, "condition": "rain showers"}]},
    "book_hotel": {"hotel_id": "H02", "guest_name": "Asha", "check_in": "2026-12-10", "check_out": "2026-12-12", "guests": 2},
}


def run_example(goal, simulate):
    s = agent.run_goal(goal, simulate)
    out = {"initial": s.model_dump(mode="json")}
    if s.status == "waiting_for_approval":
        path = STATE_DIR / f"{s.run_id}.json"
        waiting = path.read_text(encoding="utf-8")
        for decision in ("approve", "reject"):
            path.write_text(waiting, encoding="utf-8")  # rewind to the paused state, then decide
            out[decision] = agent.resume(s.run_id, decision).model_dump(mode="json")
    return out


def run_tool_example(name, args):
    SIMULATE.set({"flags": set()})
    try:
        if name == "book_hotel":
            out = {"needs_approval": True, "preview": preview_booking(TOOLS[name]["schema"](**args)),
                   "note": "Not booked: book_hotel only runs after a human approves it in an agent run."}
        else:
            out = run_tool(name, args)
        return {"ok": True, "input": args, "output": out}
    except Exception as e:  # noqa: BLE001 - shown on the page
        return {"ok": False, "input": args, "error": str(e)}


if __name__ == "__main__":
    data = {"generated_at": datetime.now().isoformat(timespec="seconds"), "examples": {}, "tools": {}}
    for key, (label, goal, sim) in EXAMPLES.items():
        print(f"running {key}: {goal} {sim}")
        data["examples"][key] = {"label": label, "goal": goal, "simulate": sim, "states": run_example(goal, sim)}
        print("   ->", data["examples"][key]["states"]["initial"]["status"])
    for name, args in TOOL_EXAMPLES.items():
        data["tools"][name] = run_tool_example(name, args)
    OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    print("saved", OUT)
