"""Inputs for the fab tool install program simulator.

Every number is either a cited public figure or a labeled planning assumption.
Assumptions are meant to be replaced with contractor bids or historical install data.
"""

# ---- Labor rates (cited) ----------------------------------------------------
# BLS OEWS mean hourly wages, Boise City, ID MSA (May 2025 release, 6/26/2026),
# Millwright uses May 2023, the latest Boise figure published for SOC 49-9044.
WAGES = {
    "millwright": 28.67,
    "electrician": 31.67,
    "pipefitter": 28.66,
    "laborer": 23.52,
    "supervisor": 38.50,
}
# BLS ECEC June 2026, construction & extraction: benefits $15.21 / wages $32.25
LABOR_BURDEN = 15.21 / 32.25
SUPERVISION_RATIO = 0.10  # assumption: 1 foreman hour per 10 craft hours

# ---- Work content per tool (planning assumptions) ----------------------------
# Craft hours for one mid-size process tool, same baseline as the Excel model.
# Tasks form a dependency network: set -> (electrical || piping) -> closeout -> qual
TASKS = [
    # name,              trade,         craft hours, predecessors
    ("rig_and_set",       "millwright",   80, []),
    ("electrical_hookup", "electrician", 120, ["rig_and_set"]),
    ("process_piping",    "pipefitter",  160, ["rig_and_set"]),
    ("closeout",          "laborer",      40, ["electrical_hookup", "process_piping"]),
    ("qualification",     None,           20, ["closeout"]),  # owner/OEM step, no craft cost
]
CREW_SIZE = {"millwright": 4, "electrician": 3, "pipefitter": 4, "laborer": 2}
BASE_CREWS = {"millwright": 2, "electrician": 3, "pipefitter": 3, "laborer": 2}

# Duration uncertainty multiplier on planned hours, triangular(low, mode, high).
# Right-skewed because install overruns are more common than underruns (assumption).
DURATION_RISK = (0.85, 1.00, 1.50)

# ---- Program shape (assumptions) ---------------------------------------------
N_TOOLS = 50
HOURS_PER_DAY = 10
DAYS_PER_WEEK = 5
TOOLS_PER_WEEK = 3              # planned delivery cadence from the OEM
DELIVERY_SLIP_DAYS = (0, 0, 5)  # triangular late-delivery risk per tool
LAST_DELIVERY_WEEK = (N_TOOLS - 1) // TOOLS_PER_WEEK
TARGET_BUFFER_WEEKS = 3.5       # commitment: all tools qualified 3.5 weeks after final delivery
TARGET_WEEKS = LAST_DELIVERY_WEEK + TARGET_BUFFER_WEEKS

# ---- Execution strategies ------------------------------------------------------
# Markups follow the Excel model (Buildern 2026 overhead/profit ranges).
# Handoff delay = idle time between one trade finishing and the next starting,
# triangular hours. Lower when one party owns coordination (assumption).
OH, PROFIT = 0.12, 0.065
STRATEGIES = {
    "A_single_GC": {
        "label": "Single general contractor",
        "summary": "One GC subcontracts every trade and owns coordination. Two layers of overhead and profit.",
        "multiplier": (1 + OH) * (1 + PROFIT) * (1 + OH) * (1 + PROFIT),
        "handoff_hours": (0, 4, 8),
        "extra_crews": {},
    },
    "B_direct_trades": {
        "label": "Direct multi-trade contracting",
        "summary": "The owner contracts each trade directly. One markup layer plus a 6% owner coordination cost, but longer gaps between trades.",
        "multiplier": (1 + OH) * (1 + PROFIT) * (1 + 0.06),
        "handoff_hours": (4, 12, 32),
        "extra_crews": {},
    },
    "C_trade_alliance": {
        "label": "Regional trade alliance",
        "summary": "A volume agreement with local trades. Lower markups, shared coordination, and one extra pipefitter crew on call.",
        "multiplier": (1 + 0.10) * (1 + 0.05) * (1 + 0.06),
        "handoff_hours": (2, 8, 16),
        # assumption: volume agreement guarantees one extra pipefitter crew on call
        "extra_crews": {"pipefitter": 1},
    },
}

N_RUNS = 5000
SEED = 42
