"""Quick check: run 6 goals end to end with the real agent and record what happened.

Saves results.md (table) and web/results.json (for the Results tab).
"""
import json
import time
from pathlib import Path

import agent

ROOT = Path(__file__).parent
# (name, goal, simulate, approval decision or None, expected final status)
CASES = [
    ("Normal trip", "Plan a 3-day trip to Jaipur for 2 people under Rs 20,000.", [], None, "completed"),
    ("Tight budget -> re-plan", "Plan a 3-day trip to Goa for 2 people under Rs 15,000.", [], None, "completed"),
    ("Unknown city", "Plan a 2-day trip to Zorbania for 2 people under Rs 10,000.", [], None, "failed"),
    ("Weather API failure", "Plan a 3-day trip to Manali for 2 people under Rs 18,000.", ["weather_down"], None, "completed"),
    ("User rejects booking", "Plan a 3-day trip to Kochi for 2 people under Rs 16,000 and book the hotel.", [], "reject", "rejected"),
    ("User approves booking", "Plan a 2-day trip to Udaipur for 2 people under Rs 16,000 and book the hotel for Krishna.", [], "approve", "completed"),
]


def check(name, s) -> bool:
    """Case-specific behaviour we expect to see (beyond the final status)."""
    tools = [h.tool for h in s.history]
    if "re-plan" in name:
        return "re_plan" in tools and s.memory["budget"]["status"] == "under"
    if "Weather" in name:
        return any(h.tool == "get_weather" and h.status == "recovered" for h in s.history)
    if "Unknown" in name:
        return "Available cities" in (s.final_answer or "")
    if "rejects" in name:
        return "booking" not in s.memory and s.approvals[-1]["decision"] == "reject"
    if "approves" in name:
        return s.memory.get("booking", {}).get("status") == "confirmed"
    return s.memory.get("budget", {}).get("status") == "under"


def main():
    rows = []
    for name, goal, sim, decision, expected in CASES:
        t0 = time.time()
        s = agent.run_goal(goal, sim)
        approval = "n/a"
        if s.status == "waiting_for_approval":
            approval = f"paused -> {decision}"
            s = agent.resume(s.run_id, decision)
        recoveries = sum(h.status in ("recovered", "skipped") for h in s.history) + sum(h.tool == "re_plan" for h in s.history)
        ok = s.status == expected and check(name, s)
        rows.append({"case": name, "goal": goal, "simulate": sim, "steps": len(s.history),
                     "tools": sorted({h.tool for h in s.history if h.tool in agent.TOOLS}),
                     "recoveries": recoveries, "approval": approval, "status": s.status, "expected": expected,
                     "plan_source": s.plan_source, "params_source": s.params_source, "pass": ok,
                     "seconds": round(time.time() - t0, 1), "run_id": s.run_id})
        print(f"{'PASS' if ok else 'FAIL'}  {name:24} status={s.status:10} steps={len(s.history)} recoveries={recoveries}")

    passed = sum(r["pass"] for r in rows)
    md = ["# Evaluation results", "",
          f"`python evaluate.py` - {passed}/{len(rows)} cases behaved as expected. "
          "Local model: Qwen2.5-0.5B-Instruct (CPU). Hotel/attraction data is sample data.", "",
          "| Case | Steps | Tools used | Recoveries | Approval | Final status | Plan | Pass | Time (s) |",
          "|---|---|---|---|---|---|---|---|---|"]
    for r in rows:
        md.append(f"| {r['case']} | {r['steps']} | {len(r['tools'])} | {r['recoveries']} | {r['approval']} | "
                  f"{r['status']} | {r['plan_source']} | {'yes' if r['pass'] else 'NO'} | {r['seconds']} |")
    md += ["", "Steps = history entries (LLM steps + tool actions + re-plans). "
           "Recoveries = retries/alternatives that saved a step, skipped optional steps, and over-budget re-plans."]
    (ROOT / "results.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    (ROOT / "web" / "results.json").write_text(json.dumps({"passed": passed, "total": len(rows), "rows": rows}, indent=1),
                                               encoding="utf-8")
    print(f"{passed}/{len(rows)} passed - saved results.md and web/results.json")


if __name__ == "__main__":
    main()
