"""Flask server: serves the showcase page (web/) and a small JSON API for the live agent.

python app.py  ->  http://127.0.0.1:5000  (page at /web/)
The page works in instant demo mode without the model; "Run live" uses the endpoints below.
"""
import json
import threading
from pathlib import Path

from flask import Flask, abort, jsonify, redirect, request, send_from_directory
from pydantic import ValidationError

import agent
import llm
from state import STATE_DIR, AgentState, list_runs
from tools import SIMULATE, TOOLS, ToolError, preview_booking, run_tool

ROOT = Path(__file__).parent
SIM_OPTIONS = {"weather_down", "no_hotels", "bad_args"}
app = Flask(__name__, static_folder=None)


def _bg(fn, *args):
    """Run agent work in a background thread; the page polls /api/runs/<id> to watch progress."""
    threading.Thread(target=fn, args=args, daemon=True).start()


@app.get("/")
def home():
    return redirect("/web/")


@app.get("/web/")
def index():
    return send_from_directory(ROOT / "web", "index.html")


@app.get("/web/<path:path>")
def web(path):
    return send_from_directory(ROOT / "web", path)


@app.get("/docs/<path:path>")
def docs(path):
    return send_from_directory(ROOT / "docs", path, mimetype="text/plain")


@app.get("/api/health")
def health():
    return jsonify(ok=True, model_loaded=llm.is_loaded())


@app.post("/api/run")
def start_run():
    body = request.get_json(force=True, silent=True) or {}
    goal = str(body.get("goal", "")).strip()
    if not 5 <= len(goal) <= 300:
        return jsonify(error="Please enter a goal (5-300 characters)."), 400
    simulate = [s for s in body.get("simulate", []) if s in SIM_OPTIONS]
    state = agent.start(goal, simulate)
    _bg(agent.run, state)
    return jsonify(run_id=state.run_id)


@app.get("/api/runs")
def runs():
    return jsonify(list_runs())


@app.get("/api/runs/<run_id>")
def get_run(run_id):
    if not run_id.replace("-", "").isalnum() or not (STATE_DIR / f"{run_id}.json").exists():
        abort(404)
    return jsonify(json.loads((STATE_DIR / f"{run_id}.json").read_text(encoding="utf-8")))


@app.post("/api/runs/<run_id>/<decision>")
def decide(run_id, decision):
    if decision not in ("approve", "reject") or not run_id.replace("-", "").isalnum() or not (STATE_DIR / f"{run_id}.json").exists():
        abort(404)
    state = AgentState.load(run_id)
    if state.status != "waiting_for_approval":
        return jsonify(error=f"Run is not waiting for approval (status: {state.status})."), 409
    _bg(agent.resume, run_id, decision)
    return jsonify(run_id=run_id, decision=decision)


@app.get("/api/approvals")
def approvals():
    return jsonify([r for r in list_runs() if r["status"] == "waiting_for_approval"])


@app.post("/api/tools/<name>")
def tool(name):
    """Run ONE tool directly (Tools tab). book_hotel only previews: real bookings need the approval flow."""
    if name not in TOOLS:
        abort(404)
    body = request.get_json(force=True, silent=True) or {}
    args = body.get("args", {})
    SIMULATE.set({"flags": {s for s in body.get("simulate", []) if s in SIM_OPTIONS}})
    try:
        if name == "book_hotel":
            out = {"needs_approval": True, "preview": preview_booking(TOOLS[name]["schema"](**args)),
                   "note": "Not booked: book_hotel only runs after a human approves it in an agent run."}
        else:
            out = run_tool(name, args)
        return jsonify(ok=True, input=args, output=out)
    except (ToolError, ValidationError) as e:
        return jsonify(ok=False, input=args, error=agent._err_text(e))


if __name__ == "__main__":
    print("Agentic Trip Planner -> http://127.0.0.1:5000/web/")
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
