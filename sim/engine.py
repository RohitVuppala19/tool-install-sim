"""Resource-constrained schedule + Monte Carlo engine for a multi-tool install program.

All Monte Carlo runs are simulated together: every random draw and every
scheduling step is a numpy array with one entry per run. Crews of each trade are
an (n_runs, n_crews) array of "free at" times; taking the earliest-free crew and
handing it back busy until the task ends is the same as popping and pushing a
min-heap, done for every run at once.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from . import config as C


# ---- Inputs -------------------------------------------------------------------

def _cfg(name):
    """Default factory that reads config at construction time (so tests can patch it)."""
    def factory():
        value = getattr(C, name)
        return dict(value) if isinstance(value, dict) else value
    return field(default_factory=factory)


@dataclass(frozen=True)
class Program:
    """Everything about the install program that is shared by all strategies."""
    n_tools: int = _cfg("N_TOOLS")
    tools_per_week: int = _cfg("TOOLS_PER_WEEK")
    hours_per_day: float = _cfg("HOURS_PER_DAY")
    days_per_week: int = _cfg("DAYS_PER_WEEK")
    target_buffer_weeks: float = _cfg("TARGET_BUFFER_WEEKS")
    delivery_slip_days: tuple = _cfg("DELIVERY_SLIP_DAYS")
    duration_risk: tuple = _cfg("DURATION_RISK")
    tasks: list = _cfg("TASKS")
    crew_size: dict = _cfg("CREW_SIZE")
    base_crews: dict = _cfg("BASE_CREWS")
    wages: dict = _cfg("WAGES")
    labor_burden: float = _cfg("LABOR_BURDEN")
    supervision_ratio: float = _cfg("SUPERVISION_RATIO")

    @property
    def hours_per_week(self) -> float:
        return self.hours_per_day * self.days_per_week

    @property
    def last_delivery_week(self) -> int:
        return (self.n_tools - 1) // self.tools_per_week

    @property
    def target_weeks(self) -> float:
        return self.last_delivery_week + self.target_buffer_weeks

    @property
    def trades(self) -> list[str]:
        return [t for t in self.crew_size]

    def burdened_rate(self, trade: str) -> float:
        return self.wages[trade] * (1 + self.labor_burden)


def tri(rng: np.random.Generator, lo: float, mode: float, hi: float, size=None):
    """Triangular draw that also accepts a fixed value (lo == hi)."""
    if hi == lo:
        return lo if size is None else np.full(size, float(lo))
    return rng.triangular(lo, mode, hi, size)


def burdened_rate(trade: str, program: Program | None = None) -> float:
    return (program or Program()).burdened_rate(trade)


def direct_labor_per_tool(program: Program | None = None) -> float:
    """Planned direct labor $ per tool, including foreman supervision."""
    p = program or Program()
    craft = sum(h * p.burdened_rate(t) for _, t, h, _ in p.tasks if t)
    craft_hours = sum(h for _, t, h, _ in p.tasks if t)
    return craft + craft_hours * p.supervision_ratio * p.burdened_rate("supervisor")


# ---- Simulation ---------------------------------------------------------------

@dataclass
class BatchResult:
    finish_hours: np.ndarray     # (n_runs,) last tool qualified, working hours from start
    cost: np.ndarray             # (n_runs,) total installed labor cost, $
    busy_hours: dict             # trade -> (n_runs,) crew busy hours
    crews: dict                  # crew count by trade
    tool_finish: np.ndarray      # (n_runs, n_tools) finish time of each tool


@dataclass
class RunResult:
    finish_hours: float
    cost: float
    busy_hours: dict
    crews: dict
    tool_finish: np.ndarray


def resolve_crews(strategy: dict, program: Program, crews: dict | None = None) -> dict:
    out = dict(crews or program.base_crews)
    for t, k in strategy.get("extra_crews", {}).items():
        out[t] = out.get(t, 0) + k
    return out


def simulate_batch(strategy: dict, rng: np.random.Generator, n_runs: int,
                   program: Program | None = None, crews: dict | None = None) -> BatchResult:
    p = program or Program()
    crews = resolve_crews(strategy, p, crews)
    for trade in {t for _, t, _, _ in p.tasks if t}:
        if crews.get(trade, 0) < 1:
            raise ValueError(f"need at least one {trade} crew")

    free = {t: np.zeros((n_runs, n)) for t, n in crews.items()}
    busy = {t: np.zeros(n_runs) for t in crews}
    rows = np.arange(n_runs)
    lo, mode, hi = p.duration_risk
    hlo, hmode, hhi = strategy["handoff_hours"]
    slo, smode, shi = p.delivery_slip_days
    last_task = p.tasks[-1][0]

    tool_finish = np.zeros((n_runs, p.n_tools))
    craft_hours = np.zeros(n_runs)
    cost = np.zeros(n_runs)
    for i in range(p.n_tools):
        planned_arrival = (i // p.tools_per_week) * p.hours_per_week
        arrival = planned_arrival + tri(rng, slo, smode, shi, n_runs) * p.hours_per_day
        done = {}
        for name, trade, hours, preds in p.tasks:
            ready = arrival
            for pred in preds:
                ready = np.maximum(ready, done[pred])
            actual_hours = hours * tri(rng, lo, mode, hi, n_runs)
            if trade is None:                      # owner/OEM step: no crew, no craft cost
                done[name] = ready + actual_hours
                continue
            if preds:                              # idle gap between one trade and the next
                ready = ready + tri(rng, hlo, hmode, hhi, n_runs)
            slots = free[trade]
            k = slots.argmin(axis=1)               # earliest-free crew in each run
            start = np.maximum(ready, slots[rows, k])
            duration = actual_hours / p.crew_size[trade]
            done[name] = start + duration
            slots[rows, k] = done[name]
            busy[trade] += duration
            craft_hours += actual_hours
            cost += actual_hours * p.burdened_rate(trade)
        tool_finish[:, i] = done[last_task]
    cost += craft_hours * p.supervision_ratio * p.burdened_rate("supervisor")
    cost *= strategy["multiplier"]
    return BatchResult(tool_finish.max(axis=1), cost, busy, crews, tool_finish)


def simulate_once(strategy: dict, rng: np.random.Generator, crews: dict | None = None,
                  program: Program | None = None) -> RunResult:
    b = simulate_batch(strategy, rng, 1, program, crews)
    return RunResult(float(b.finish_hours[0]), float(b.cost[0]),
                     {t: float(v[0]) for t, v in b.busy_hours.items()}, b.crews, b.tool_finish[0])


def monte_carlo(strategy: dict, n_runs: int = C.N_RUNS, seed: int = C.SEED,
                crews: dict | None = None, program: Program | None = None) -> dict:
    p = program or Program()
    b = simulate_batch(strategy, np.random.default_rng(seed), n_runs, p, crews)
    weeks = b.finish_hours / p.hours_per_week
    util = {t: float(np.mean(b.busy_hours[t] / (b.crews[t] * b.finish_hours)))
            for t in b.crews if b.crews[t] > 0}
    return {
        "weeks": weeks,
        "cost": b.cost,
        "crews": b.crews,
        "p50_weeks": float(np.percentile(weeks, 50)),
        "p80_weeks": float(np.percentile(weeks, 80)),
        "on_time_prob": float(np.mean(weeks <= p.target_weeks)),
        "p50_cost_per_tool": float(np.percentile(b.cost, 50) / p.n_tools),
        "p80_cost_per_tool": float(np.percentile(b.cost, 80) / p.n_tools),
        "utilization": util,
        "bottleneck": max(util, key=util.get),
    }


def crew_vs_handoff(strategy: dict, n_runs: int = 1000, seed: int = C.SEED,
                    program: Program | None = None, crews: dict | None = None) -> dict:
    """Compare two recovery levers for a strategy that misses its target:
    one more crew for each hookup trade vs. halving trade-to-trade handoff time."""
    p = program or Program()
    base = dict(crews or p.base_crews)
    out = {"baseline": monte_carlo(strategy, n_runs, seed, base, p)}
    more = dict(base)
    for t in ("electrician", "pipefitter"):
        more[t] = more.get(t, 0) + 1
    out["plus_hookup_crews"] = monte_carlo(strategy, n_runs, seed, more, p)
    lo, mode, hi = strategy["handoff_hours"]
    faster = {**strategy, "handoff_hours": (lo / 2, mode / 2, hi / 2)}
    out["half_handoff"] = monte_carlo(faster, n_runs, seed, base, p)
    return out


def recommend(results: dict, min_on_time: float) -> str | None:
    """Cheapest strategy (P50 cost) that meets the on-time bar; else the most reliable one."""
    if not results:
        return None
    ok = [k for k, r in results.items() if r["on_time_prob"] >= min_on_time]
    if ok:
        return min(ok, key=lambda k: results[k]["p50_cost_per_tool"])
    return max(results, key=lambda k: (results[k]["on_time_prob"], -results[k]["p50_cost_per_tool"]))


__all__ = ["Program", "tri", "burdened_rate", "direct_labor_per_tool",
           "simulate_batch", "simulate_once", "monte_carlo", "crew_vs_handoff", "recommend"]
