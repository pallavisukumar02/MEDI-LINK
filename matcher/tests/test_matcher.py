import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["LLM_PROVIDER"] = "none"
os.environ["ORS_API_KEY"] = ""

from fastapi.testclient import TestClient  # noqa: E402

import routing  # noqa: E402
import solver  # noqa: E402
from app import app  # noqa: E402

client = TestClient(app)


def cand(lot, h, qty, km, dte=200, near=False, name=None):
    return {"lotId": lot, "hospitalId": h, "hospitalName": name or h, "maxQty": qty, "distanceKm": km, "etaMin": int(20 + km * 3),
            "daysToExpiry": dte, "nearExpiry": near, "batchNo": "B-" + lot, "expiryDate": "2027-01-01"}


def test_nearest_single_supplier_ranks_first():
    plans = solver.rank(16, [cand("a", "H5", 20, 4.9), cand("b", "H2", 30, 21.0)])
    assert plans[0]["legs"][0]["hospitalId"] == "H5"
    assert plans[0]["fullyCovers"] and plans[0]["transfers"] == 1
    assert plans[1]["legs"][0]["hospitalId"] == "H2"


def test_near_expiry_lot_preferred_within_hospital():
    plans = solver.rank(10, [cand("old", "H5", 12, 4.9, dte=45, near=True), cand("new", "H5", 20, 4.9, dte=300)])
    lots = {l["lotId"]: l["qty"] for l in plans[0]["legs"][0]["lots"]}
    assert lots == {"old": 10}


def test_fewest_transfers_beats_two_slightly_nearer():
    plans = solver.rank(10, [cand("a", "HA", 5, 2.0), cand("b", "HB", 5, 2.0), cand("c", "HC", 10, 3.0)])
    assert [l["hospitalId"] for l in plans[0]["legs"]] == ["HC"]


def test_combination_when_no_single_supplier_has_enough():
    plans = solver.rank(16, [cand("a", "H5", 10, 4.9), cand("b", "H2", 10, 21.0)])
    assert plans[0]["transfers"] == 2 and plans[0]["totalQty"] == 16 and plans[0]["fullyCovers"]


def test_hospital_cap_limits_joint_lots():
    plans = solver.rank(16, [cand("a", "H5", 12, 4.9), cand("b", "H5", 12, 4.9)], hospital_caps={"H5": 14})
    assert plans[0]["totalQty"] == 14 and not plans[0]["fullyCovers"]


def test_partial_plans_rank_after_full_ones():
    plans = solver.rank(16, [cand("a", "H5", 8, 1.0), cand("b", "H2", 16, 30.0)])
    assert plans[0]["fullyCovers"] and plans[0]["legs"][0]["hospitalId"] == "H2"


def test_distinct_plans_and_no_candidates():
    plans = solver.rank(5, [cand("a", "H1", 10, 1), cand("b", "H2", 10, 2), cand("c", "H3", 10, 3)], max_plans=3)
    sets = [tuple(l["hospitalId"] for l in p["legs"]) for p in plans]
    assert len(set(sets)) == len(sets) == 3
    assert solver.rank(5, []) == []


def test_haversine_fallback():
    r = routing.fallback({"lat": 12.9299, "long": 77.5826}, {"lat": 12.9255, "long": 77.5468})
    assert 4 < r["distanceKm"] < 6 and r["provider"] == "haversine"


def test_rank_endpoint_template_reason_and_routing_fill():
    body = {"qty": 16, "receiver": {"lat": 12.9299, "long": 77.5826},
            "candidates": [{"lotId": "H5-CARB-A", "hospitalId": "H5", "hospitalName": "Banashankari Care Hospital", "lat": 12.9255, "long": 77.5468,
                            "maxQty": 12, "daysToExpiry": 45, "nearExpiry": True, "batchNo": "SOL24B077"},
                           {"lotId": "H5-CARB-B", "hospitalId": "H5", "hospitalName": "Banashankari Care Hospital", "lat": 12.9255, "long": 77.5468,
                            "maxQty": 20, "daysToExpiry": 320, "batchNo": "SOL25A015"}],
            "hospitalCaps": {"H5": 25}}
    r = client.post("/rank", json=body)
    assert r.status_code == 200
    p = r.json()["plans"][0]
    assert p["totalQty"] == 16 and p["reasonSource"] == "template"
    assert "Nearest eligible hospital" in p["reason"] and "SOL24B077" in p["reason"] and "all 16" in p["reason"]
    assert {l["lotId"]: l["qty"] for l in p["legs"][0]["lots"]} == {"H5-CARB-A": 12, "H5-CARB-B": 4}


def test_rank_endpoint_validates_qty():
    assert client.post("/rank", json={"qty": 0, "candidates": []}).status_code == 422


def test_llm_rewrite_must_keep_every_number():
    import explain
    t = "Nearest eligible hospital: X (4.2 km, ~31 min). One transfer covers all 16 doses."
    assert explain.numbers_preserved(t, "X is 4.2 km away, about 31 min; one delivery covers all 16 doses.")
    assert not explain.numbers_preserved(t, "X is 4 km away, about 31 min; covers all 16 doses.")
    assert explain.llm_rewrite(t, {}) is None  # LLM_PROVIDER=none -> template stays


def test_llm_rewrite_openai_compatible(monkeypatch):
    import explain
    t = "Nearest eligible hospital: X (4.2 km, ~31 min). One transfer covers all 16 doses."
    seen = {}

    class Res:
        def __init__(self, content): self.content = content
        def raise_for_status(self): pass
        def json(self): return {"choices": [{"message": {"content": self.content}}]}

    def fake_post(url, headers=None, json=None, timeout=None, answer="X: 4.2 km, ~31 min; one transfer covers all 16 doses."):
        seen.update(url=url, headers=headers, model=json["model"])
        return Res(seen.get("answer", answer))

    monkeypatch.setattr(explain.httpx, "post", fake_post)
    for k, v in {"LLM_PROVIDER": "openai-compatible", "LLM_BASE_URL": "http://llm.test/v1/", "LLM_MODEL": "m1", "LLM_API_KEY": "k1"}.items():
        monkeypatch.setenv(k, v)
    assert explain.llm_rewrite(t, {}) == "X: 4.2 km, ~31 min; one transfer covers all 16 doses."
    assert seen["url"] == "http://llm.test/v1/chat/completions" and seen["headers"] == {"Authorization": "Bearer k1"} and seen["model"] == "m1"
    seen["answer"] = "X: 5 km away; covers all 16 doses."  # a changed number -> template stays
    assert explain.llm_rewrite(t, {}) is None


def test_rank_requires_token_when_configured(monkeypatch):
    from fastapi.testclient import TestClient
    import app as matcher_app
    c = TestClient(matcher_app.app)
    body = {"qty": 1, "candidates": [{"lotId": "L1", "hospitalId": "H2", "maxQty": 1, "distanceKm": 3}]}
    monkeypatch.setenv("MATCHER_TOKEN", "s3cret")
    assert c.post("/rank", json=body).status_code == 401
    assert c.post("/rank", json=body, headers={"X-Matcher-Token": "s3cret"}).status_code == 200
    monkeypatch.delenv("MATCHER_TOKEN")
    assert c.post("/rank", json=body).status_code == 200


def test_production_requires_token_and_plans_are_capped(monkeypatch):
    from fastapi.testclient import TestClient
    import app as matcher_app
    c = TestClient(matcher_app.app)
    cands = [{"lotId": f"L{i}", "hospitalId": f"H{i}", "maxQty": 1, "distanceKm": i} for i in range(1, 12)]
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.delenv("MATCHER_TOKEN", raising=False)
    assert c.post("/rank", json={"qty": 1, "candidates": cands}).status_code == 503  # fails closed without a token
    monkeypatch.setenv("MATCHER_TOKEN", "s3cret")
    r = c.post("/rank", json={"qty": 1, "candidates": cands, "maxPlans": 1000}, headers={"X-Matcher-Token": "s3cret"})
    assert r.status_code == 200 and len(r.json()["plans"]) == matcher_app.MAX_PLANS
    assert c.post("/rank", json={"qty": 1, "candidates": cands, "maxPlans": 0}, headers={"X-Matcher-Token": "s3cret"}).status_code == 422
