import numpy as np

from sim import config as C
from sim.engine import direct_labor_per_tool, monte_carlo, simulate_once

NO_RISK = {"label": "test", "multiplier": 1.0, "handoff_hours": (0, 0, 0), "extra_crews": {}}


def test_direct_labor_matches_excel_model():
    # Excel model: $19,367 direct labor per tool with the same inputs
    assert abs(direct_labor_per_tool() - 19367) < 1


def test_single_tool_follows_critical_path(monkeypatch):
    monkeypatch.setattr(C, "N_TOOLS", 1)
    monkeypatch.setattr(C, "DURATION_RISK", (1, 1, 1))
    monkeypatch.setattr(C, "DELIVERY_SLIP_DAYS", (0, 0, 0))
    r = simulate_once(NO_RISK, np.random.default_rng(0))
    # set 80/4 = 20h, then piping 160/4 = 40h (longer than electrical 120/3 = 40h tie),
    # closeout 40/2 = 20h, qualification 20h -> 100h critical path
    assert r.finish_hours == 100


def test_dependencies_never_violated(monkeypatch):
    monkeypatch.setattr(C, "N_TOOLS", 5)
    r = simulate_once(C.STRATEGIES["B_direct_trades"], np.random.default_rng(1))
    assert np.all(r.tool_finish > 0)
    assert r.finish_hours == r.tool_finish.max()


def test_strategy_cost_ranking_matches_markups():
    res = {k: monte_carlo(s, n_runs=200) for k, s in C.STRATEGIES.items()}
    assert res["C_trade_alliance"]["p50_cost_per_tool"] < res["B_direct_trades"]["p50_cost_per_tool"]
    assert res["B_direct_trades"]["p50_cost_per_tool"] < res["A_single_GC"]["p50_cost_per_tool"]


def test_crews_never_double_booked(monkeypatch):
    # With one crew per trade and no randomness, every tool queues behind the last:
    # the single pipefitter crew (40h per tool) sets the pace after the first tool.
    monkeypatch.setattr(C, "N_TOOLS", 3)
    monkeypatch.setattr(C, "TOOLS_PER_WEEK", 3)
    monkeypatch.setattr(C, "DURATION_RISK", (1, 1, 1))
    monkeypatch.setattr(C, "DELIVERY_SLIP_DAYS", (0, 0, 0))
    one = {t: 1 for t in C.BASE_CREWS}
    r = simulate_once(NO_RISK, np.random.default_rng(0), crews=one)
    # tool 3: set ends 60h, piping waits for tool 2 (ends 100h) -> 140h, closeout 160h, qual 180h
    assert r.finish_hours == 180


def test_program_overrides_do_not_touch_config():
    from sim.engine import Program
    p = Program(n_tools=10, tools_per_week=5)
    r = monte_carlo(C.STRATEGIES["A_single_GC"], n_runs=50, program=p)
    assert p.target_weeks == 1 + C.TARGET_BUFFER_WEEKS
    assert C.N_TOOLS == 50 and r["weeks"].shape == (50,)


def test_same_seed_is_reproducible():
    a = monte_carlo(C.STRATEGIES["A_single_GC"], n_runs=100)
    b = monte_carlo(C.STRATEGIES["A_single_GC"], n_runs=100)
    assert a["p80_weeks"] == b["p80_weeks"]
