from fastapi.testclient import TestClient

from app.main import app, default_inputs

client = TestClient(app)


def test_index_and_static_served():
    assert client.get("/").status_code == 200
    assert "Tool Install Simulator" in client.get("/").text
    for path in ("/static/app.js", "/static/styles.css"):
        assert client.get(path).status_code == 200


def test_defaults_round_trip_through_simulate():
    d = client.get("/api/defaults").json()
    assert d["inputs"] == default_inputs()
    body = {**d["inputs"], "n_runs": 500}
    r = client.post("/api/simulate", json=body)
    assert r.status_code == 200
    out = r.json()
    assert out["target_weeks"] == 19.5
    assert [s["key"] for s in out["strategies"]] == ["A_single_GC", "B_direct_trades", "C_trade_alliance"]
    for s in out["strategies"]:
        assert len(s["cdf"]) == len(out["grid"])
        assert len(s["hist"]) == len(out["hist_edges"]) - 1
        assert s["cdf"][-1] == 1.0
        assert set(s["levers"]) == {"baseline", "plus_hookup_crews", "half_handoff"}
    assert out["recommended"] in {s["key"] for s in out["strategies"]}


def test_default_recommendation_is_trade_alliance():
    r = client.post("/api/simulate", json={**default_inputs(), "n_runs": 2000}).json()
    assert r["recommended"] == "C_trade_alliance"


def test_bad_inputs_rejected():
    bad_triangle = {**default_inputs(), "duration_risk": [1.5, 1.0, 0.8]}
    assert client.post("/api/simulate", json=bad_triangle).status_code == 422
    too_many_runs = {**default_inputs(), "n_runs": 1_000_000}
    assert client.post("/api/simulate", json=too_many_runs).status_code == 422
    zero_crews = {**default_inputs(), "crews": {**default_inputs()["crews"], "electrician": 0}}
    assert client.post("/api/simulate", json=zero_crews).status_code == 422
