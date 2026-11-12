"""Command-line run of the default scenario: print the comparison and write outputs/strategy_summary.csv.

Uses the same code path as the web app, so the numbers match what the browser shows.
For the interactive version, start the web app instead:  uvicorn app.main:app --port 8765
"""
import csv
from pathlib import Path

from app.main import SimulationIn, default_inputs, run_simulation

OUT = Path(__file__).parent / "outputs"


def main():
    r = run_simulation(SimulationIn(**default_inputs()))
    print(f"Planned direct labor per tool: ${r['direct_labor_per_tool']:,.0f}")
    print(f"Commitment: every tool qualified by week {r['target_weeks']} · {r['n_runs']:,} runs per strategy\n")

    rows = [{
        "strategy": s["label"],
        "p50_weeks": round(s["p50_weeks"], 1),
        "p80_weeks": round(s["p80_weeks"], 1),
        "on_time_prob": round(s["on_time_prob"], 3),
        "p50_cost_per_tool": round(s["p50_cost_per_tool"]),
        "p80_cost_per_tool": round(s["p80_cost_per_tool"]),
        "savings_vs_baseline": round(s["savings_vs_first"], 4),
        "bottleneck_trade": s["bottleneck"],
        "bottleneck_util": round(s["utilization"][s["bottleneck"]], 3),
        "on_time_plus_hookup_crews": round(s["levers"]["plus_hookup_crews"]["on_time_prob"], 3),
        "on_time_half_handoff": round(s["levers"]["half_handoff"]["on_time_prob"], 3),
    } for s in r["strategies"]]

    OUT.mkdir(exist_ok=True)
    with open(OUT / "strategy_summary.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

    cols = ["strategy", "p50_cost_per_tool", "p80_weeks", "on_time_prob", "on_time_plus_hookup_crews", "on_time_half_handoff"]
    widths = {k: max(len(k), *(len(str(row[k])) for row in rows)) for k in cols}
    print("  ".join(k.rjust(widths[k]) for k in cols))
    for row in rows:
        print("  ".join(str(row[k]).rjust(widths[k]) for k in cols))

    rec = next(s for s in r["strategies"] if s["key"] == r["recommended"])
    print(f"\nRecommended: {rec['label']} ({rec['savings_vs_first']:.1%} below baseline, "
          f"{rec['on_time_prob']:.0%} on time, bar {r['min_on_time']:.0%})")
    print("CSV written to", OUT / "strategy_summary.csv")


if __name__ == "__main__":
    main()
