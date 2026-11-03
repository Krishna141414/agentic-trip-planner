"""AgentState: everything the agent knows about one run, saved as JSON in state/<run_id>.json.

Because the whole run lives in this file, a run can be listed, replayed, and
resumed later (e.g. after a human approves or rejects the booking).
"""
import json
import uuid
from datetime import datetime
from pathlib import Path

from pydantic import BaseModel, Field

STATE_DIR = Path(__file__).parent / "state"


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class TripParams(BaseModel):
    """What the agent extracted from the goal."""
    city: str
    days: int = Field(ge=1, le=9)
    guests: int = Field(ge=1, le=10)
    budget: float = Field(gt=0)
    book: bool = False  # did the user ask us to book?
    guest_name: str = "Traveller"


class PlanStep(BaseModel):
    id: str
    tool: str            # tool name, or "llm" / "re_plan" for non-tool steps
    label: str
    status: str = "pending"   # pending | running | done | failed | recovered | skipped | waiting | rejected
    added_by_replan: bool = False


class StepRecord(BaseModel):
    """One Thought -> Action -> Observation entry in the history."""
    plan_id: str
    thought: str
    tool: str
    args: dict = {}
    result: dict | list | str | None = None
    status: str = "done"
    attempts: list[dict] = []   # every try: {kind: original|retry|alternative, args, ok, error}
    recovery: str | None = None  # what the agent did to recover, in plain words
    time: str = Field(default_factory=now)
    duration_ms: int = 0


class AgentState(BaseModel):
    run_id: str = Field(default_factory=lambda: datetime.now().strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4])
    goal: str
    simulate: list[str] = []
    status: str = "running"  # running | waiting_for_approval | completed | rejected | failed
    created_at: str = Field(default_factory=now)
    updated_at: str = Field(default_factory=now)
    params: TripParams | None = None
    params_source: str | None = None   # "llm" | "llm + rules" | "rules (fallback)"
    plan: list[PlanStep] = []
    plan_source: str | None = None     # "llm plan" | "fallback plan"
    current_step: int = 0
    history: list[StepRecord] = []
    errors: list[dict] = []
    approvals: list[dict] = []
    pending_approval: dict | None = None
    memory: dict = {}   # working memory: weather, hotels, chosen_hotel, budget, itinerary, booking ...
    final_answer: str | None = None

    def save(self) -> None:
        STATE_DIR.mkdir(exist_ok=True)
        self.updated_at = now()
        (STATE_DIR / f"{self.run_id}.json").write_text(self.model_dump_json(indent=2), encoding="utf-8")

    @classmethod
    def load(cls, run_id: str) -> "AgentState":
        return cls.model_validate_json((STATE_DIR / f"{run_id}.json").read_text(encoding="utf-8"))


def list_runs() -> list[dict]:
    """Short summary of every saved run, newest first."""
    out = []
    for p in sorted(STATE_DIR.glob("*.json"), reverse=True):
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
            out.append({k: d.get(k) for k in ("run_id", "goal", "status", "created_at", "simulate", "plan_source")}
                       | {"steps": len(d.get("history", []))})
        except (OSError, json.JSONDecodeError):
            continue
    return out
