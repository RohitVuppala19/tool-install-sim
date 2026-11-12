# Fab Tool Install Program Simulator

A Monte Carlo web app for a 50-tool semiconductor equipment install program. It schedules every tool through a dependency network of craft tasks, under limited crews, uncertain task durations, late OEM deliveries and trade-to-trade handoff delays. It then compares three ways of contracting the work on cost and schedule risk.

Change any input in the browser and the simulation re-runs in under a second. It shows completion curves, cost against schedule, crew bottlenecks and recovery levers, and recommends a strategy.

## The program question

A fab receives 3 process tools per week (50 total). Each tool goes through rigging and setting, then electrical hookup and process piping in parallel, then closeout and qualification. The commitment is every tool qualified within 3.5 weeks of the final delivery (week 19.5).

Which way of contracting the install hits that date with the most confidence and the lowest cost?

## Results with the default inputs (5,000 runs per strategy, seed 42)

| Strategy | P50 cost per tool | P80 weeks | On-time probability |
|---|---|---|---|
| Single general contractor | $30,777 | 19.3 | 98% |
| Direct multi-trade contracting | $27,351 (11.1% lower) | 19.8 | 26% |
| Regional trade alliance | $26,483 (14.0% lower) | 19.4 | 88% |

- **The alliance gives the best balance.** It costs 14.0% less per tool than a single general contractor and still has an 88% chance of finishing on time.
- **Direct contracting loses its savings to schedule risk.** Coordination gaps between trades push its on-time probability down to 26%.
- **The fix for direct contracting is handoffs, not headcount.**
  - Adding one electrician crew and one pipefitter crew lifts on-time probability only to 47%.
  - Halving the handoff time between trades lifts it to 88%.

## Run it locally

Requires Python 3.13.

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --port 8765
```

Open http://localhost:8765. Choose any free port if 8765 is taken. Add `--reload` while editing code.

Other commands:

```bash
python3 -m pytest -q   # engine and API tests
python3 run.py         # print the default comparison and write outputs/strategy_summary.csv
```

## Deploy it

The app is a single Python web service. `Dockerfile` runs it on any container host, and the host sets the port through `$PORT`.

**Render (free tier):**
1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and pick the repository. `render.yaml` sets up the service and its health check.
3. Render builds the image and gives you a public `https://….onrender.com` URL.

Free Render services sleep when idle, so the first visit after a while takes about 30 seconds to wake up.

**Other hosts:** Railway, Fly.io and Google Cloud Run all deploy straight from the `Dockerfile`. To test the container locally:

```bash
docker build -t tool-install-sim .
docker run -p 8765:8000 tool-install-sim
```

Each request is capped at 10,000 runs and 200 tools, so one visitor can't tie up a small server.

## How it works

- `sim/config.py` holds every default input, each one either cited or labeled as an assumption.
- `sim/engine.py` holds the scheduling and simulation logic:
  - **Scheduling:** each task starts when its predecessors finish, plus a handoff delay, and a crew of the right trade is free.
  - **Speed:** all runs are simulated at once as numpy arrays. Each trade's crews are an array of "free at" times, and every task takes the earliest-free crew in each run.
  - **Uncertainty:** task durations draw a right-skewed triangular multiplier (0.85 / 1.00 / 1.50) on planned hours. OEM deliveries can slip 0 to 5 days.
  - **Cost:** actual craft hours are priced at burdened BLS wages. Foreman supervision is added, then each strategy's contractor markup is applied.
- `app/main.py` is the FastAPI service. `POST /api/simulate` validates the inputs, runs every strategy plus its recovery levers, and returns summary statistics and chart data. Interactive API docs are at `/api/docs`.
- `app/static/` is the front end, plain HTML, CSS and JavaScript with Chart.js. It has light and dark themes and works on phones. **Copy link** saves the current scenario in the URL so you can share it.
- `tests/` checks:
  - critical-path timing
  - that no crew is ever double-booked
  - the strategy cost ranking
  - reproducibility with the same seed
  - API validation
  - that labor cost matches the companion Excel should-cost model ($19,367 per tool)

## Sources and assumptions

- **Wages:** BLS OEWS mean hourly wages, Boise City, ID MSA, May 2025. Millwright uses May 2023, the latest Boise figure published.
- **Labor burden:** BLS ECEC, June 2026, construction and extraction occupations.
- **Contractor overhead and profit ranges:** Buildern, *Typical Contractor Overhead and Profit*, 2026.
- **Planning assumptions:** craft hours per tool, crew sizes, handoff delays, delivery slip and duration risk. Replace them with contractor bids or historical install records.
