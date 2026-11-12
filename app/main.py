"""Web app: a JSON API around the simulator plus the static front end.

Run locally:  uvicorn app.main:app --port 8765
"""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator, model_validator

from sim import config as C
from sim.engine import Program, crew_vs_handoff, direct_labor_per_tool, monte_carlo, recommend

STATIC = Path(__file__).parent / "static"
TRADES = list(C.CREW_SIZE)

# Upper bounds keep one request to a few seconds of CPU on a small server.
MAX_RUNS = 10_000
MAX_TOOLS = 200


def _check_triangle(v: list[float], name: str) -> list[float]:
    lo, mode, hi = v
    if not lo <= mode <= hi:
        raise ValueError(f"{name}: needs min <= most likely <= max")
    return v


class StrategyIn(BaseModel):
    key: str = Field(min_length=1, max_length=40, pattern=r"^[A-Za-z0-9_-]+$")
    label: str = Field(min_length=1, max_length=60)
    markup_pct: float = Field(ge=0, le=200, description="Total markup on direct labor, %")
    handoff_hours: list[float] = Field(min_length=3, max_length=3)
    extra_crews: dict[str, int] = Field(default_factory=dict)

    @field_validator("handoff_hours")
    @classmethod
    def _handoff(cls, v):
        if any(x < 0 or x > 200 for x in v):
            raise ValueError("handoff hours must be between 0 and 200")
        return _check_triangle(v, "handoff hours")

    @field_validator("extra_crews")
    @classmethod
    def _extra(cls, v):
        for t, k in v.items():
            if t not in TRADES:
                raise ValueError(f"unknown trade {t!r}")
            if not 0 <= k <= 10:
                raise ValueError("extra crews must be between 0 and 10")
        return v


class SimulationIn(BaseModel):
    n_tools: int = Field(ge=1, le=MAX_TOOLS)
    tools_per_week: int = Field(ge=1, le=20)
    target_buffer_weeks: float = Field(ge=0, le=52)
    delivery_slip_days: list[float] = Field(min_length=3, max_length=3)
    duration_risk: list[float] = Field(min_length=3, max_length=3)
    crews: dict[str, int]
    min_on_time: float = Field(ge=0.01, le=1.0)
    n_runs: int = Field(ge=100, le=MAX_RUNS)
    seed: int = Field(ge=0, le=2**32 - 1)
    strategies: list[StrategyIn] = Field(min_length=1, max_length=3)

    @field_validator("delivery_slip_days")
    @classmethod
    def _slip(cls, v):
        if any(x < 0 or x > 60 for x in v):
            raise ValueError("delivery slip must be between 0 and 60 days")
        return _check_triangle(v, "delivery slip")

    @field_validator("duration_risk")
    @classmethod
    def _risk(cls, v):
        if any(x <= 0 or x > 5 for x in v):
            raise ValueError("duration multipliers must be between 0 and 5")
        return _check_triangle(v, "duration risk")

    @field_validator("crews")
    @classmethod
    def _crews(cls, v):
        if set(v) != set(TRADES):
            raise ValueError(f"crews must list exactly {TRADES}")
        if any(not 1 <= k <= 20 for k in v.values()):
            raise ValueError("crews per trade must be between 1 and 20")
        return v

    @model_validator(mode="after")
    def _unique_keys(self):
        keys = [s.key for s in self.strategies]
        if len(set(keys)) != len(keys):
            raise ValueError("strategy keys must be unique")
        return self


def default_inputs() -> dict:
    return {
        "n_tools": C.N_TOOLS,
        "tools_per_week": C.TOOLS_PER_WEEK,
        "target_buffer_weeks": C.TARGET_BUFFER_WEEKS,
        "delivery_slip_days": list(C.DELIVERY_SLIP_DAYS),
        "duration_risk": list(C.DURATION_RISK),
        "crews": dict(C.BASE_CREWS),
        "min_on_time": 0.8,
        "n_runs": C.N_RUNS,
        "seed": C.SEED,
        "strategies": [
            {
                "key": key,
                "label": s["label"],
                "markup_pct": round((s["multiplier"] - 1) * 100, 2),
                "handoff_hours": list(s["handoff_hours"]),
                "extra_crews": {t: s["extra_crews"].get(t, 0) for t in TRADES},
            }
            for key, s in C.STRATEGIES.items()
        ],
    }


def _summaries() -> dict:
    return {key: s.get("summary", "") for key, s in C.STRATEGIES.items()}


def run_simulation(req: SimulationIn) -> dict:
    t0 = time.perf_counter()
    program = Program(
        n_tools=req.n_tools,
        tools_per_week=req.tools_per_week,
        target_buffer_weeks=req.target_buffer_weeks,
        delivery_slip_days=tuple(req.delivery_slip_days),
        duration_risk=tuple(req.duration_risk),
    )
    results, levers = {}, {}
    for s in req.strategies:
        strat = {
            "label": s.label,
            "multiplier": 1 + s.markup_pct / 100,
            "handoff_hours": tuple(s.handoff_hours),
            "extra_crews": {t: k for t, k in s.extra_crews.items() if k},
        }
        results[s.key] = monte_carlo(strat, req.n_runs, req.seed, req.crews, program)
        levers[s.key] = crew_vs_handoff(strat, req.n_runs, req.seed, program, req.crews)

    # Shared week grid so every strategy's curve lines up on one x axis.
    all_weeks = np.concatenate([r["weeks"] for r in results.values()])
    lo = min(float(all_weeks.min()), program.target_weeks) - 0.2
    hi = max(float(all_weeks.max()), program.target_weeks) + 0.2
    grid = np.linspace(lo, hi, 121)
    edges = np.linspace(lo, hi, 51)

    first = req.strategies[0].key
    base_cost = results[first]["p50_cost_per_tool"]
    out = []
    for s in req.strategies:
        r = results[s.key]
        w = np.sort(r["weeks"])
        hist, _ = np.histogram(w, bins=edges)
        out.append({
            "key": s.key,
            "label": s.label,
            "summary": _summaries().get(s.key, ""),
            "markup_pct": s.markup_pct,
            "crews": r["crews"],
            "p50_weeks": r["p50_weeks"],
            "p80_weeks": r["p80_weeks"],
            "on_time_prob": r["on_time_prob"],
            "p50_cost_per_tool": r["p50_cost_per_tool"],
            "p80_cost_per_tool": r["p80_cost_per_tool"],
            "p50_total_cost": r["p50_cost_per_tool"] * program.n_tools,
            "savings_vs_first": 1 - r["p50_cost_per_tool"] / base_cost,
            "bottleneck": r["bottleneck"],
            "utilization": r["utilization"],
            "cdf": (np.searchsorted(w, grid, side="right") / len(w)).round(4).tolist(),
            "hist": (hist / len(w)).round(4).tolist(),
            "levers": {
                name: {"on_time_prob": v["on_time_prob"], "p80_weeks": v["p80_weeks"],
                       "p50_cost_per_tool": v["p50_cost_per_tool"]}
                for name, v in levers[s.key].items()
            },
        })

    return {
        "target_weeks": program.target_weeks,
        "last_delivery_week": program.last_delivery_week,
        "n_tools": program.n_tools,
        "n_runs": req.n_runs,
        "min_on_time": req.min_on_time,
        "direct_labor_per_tool": direct_labor_per_tool(program),
        "recommended": recommend(results, req.min_on_time),
        "baseline_key": first,
        "grid": grid.round(3).tolist(),
        "hist_edges": edges.round(3).tolist(),
        "strategies": out,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000),
    }


app = FastAPI(title="Fab Tool Install Simulator", docs_url="/api/docs", redoc_url=None,
              openapi_url="/api/openapi.json")


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/defaults")
def defaults():
    program = Program()
    return {
        "inputs": default_inputs(),
        "summaries": _summaries(),
        "limits": {"max_runs": MAX_RUNS, "max_tools": MAX_TOOLS},
        "reference": {
            "trades": TRADES,
            "tasks": [{"name": n, "trade": t, "hours": h, "after": p} for n, t, h, p in C.TASKS],
            "crew_size": C.CREW_SIZE,
            "wages": C.WAGES,
            "labor_burden": C.LABOR_BURDEN,
            "supervision_ratio": C.SUPERVISION_RATIO,
            "hours_per_day": C.HOURS_PER_DAY,
            "days_per_week": C.DAYS_PER_WEEK,
            "direct_labor_per_tool": direct_labor_per_tool(program),
        },
    }


@app.post("/api/simulate")
def simulate(req: SimulationIn):
    # Sync handler: FastAPI runs it in a worker thread, so the server stays responsive.
    try:
        return run_simulation(req)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@app.get("/", include_in_schema=False)
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
