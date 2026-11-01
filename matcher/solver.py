"""
Plan ranking with Google OR-Tools CP-SAT.

Decision variables
  x_l  units taken from eligible lot l          (0..maxQty_l)
  y_h  1 if hospital h supplies (one transfer)

Constraints
  x_l <= maxQty_l * y_h(l)                  lot only used if its hospital is used
  sum_{l in h} x_l <= cap_h                 hospital-level genuine surplus
  sum_l x_l <= qty

Objective (lexicographic via weights, in 10-metre units)
  BIG * unfilled                             fill the request first
  + sum_h y_h * (W_TRANSFER + W_KM * km_h)   nearest first, fewest transfers
  + sum_l x_l * expiry_penalty_l             near-expiry surplus preferred (cuts waste)

Alternative plans: re-solve with a no-good cut on the set of supplying hospitals.
"""
from ortools.sat.python import cp_model

BIG = 1_000_000
DEFAULT_WEIGHTS = {"perKm": 100, "perTransfer": 300, "nonNearExpiryPerUnit": 20, "perMonthToExpiry": 1}


def _expiry_penalty(c, w):
    if c.get("nearExpiry"):
        return 0
    return w["nonNearExpiryPerUnit"] + w["perMonthToExpiry"] * min(int(c.get("daysToExpiry", 365)), 365) // 30


TIME_LIMIT_S = 2.0  # per CP-SAT solve; app.MAX_PLANS solves at most per request


def rank(qty, candidates, hospital_caps=None, max_plans=3, weights=None, time_limit_s=TIME_LIMIT_S):
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    hospital_caps = hospital_caps or {}
    cands = [c for c in candidates if int(c.get("maxQty", 0)) > 0]
    if not cands or qty <= 0:
        return []
    hospitals = sorted({c["hospitalId"] for c in cands})
    km = {h: min(float(c["distanceKm"]) for c in cands if c["hospitalId"] == h) for h in hospitals}
    plans, cuts = [], []
    for _ in range(max_plans):
        m = cp_model.CpModel()
        x = {i: m.NewIntVar(0, int(c["maxQty"]), f"x{i}") for i, c in enumerate(cands)}
        y = {h: m.NewBoolVar(f"y_{h}") for h in hospitals}
        for i, c in enumerate(cands):
            m.Add(x[i] <= int(c["maxQty"]) * y[c["hospitalId"]])
        for h in hospitals:
            idx = [i for i, c in enumerate(cands) if c["hospitalId"] == h]
            cap = hospital_caps.get(h)
            if cap is not None:
                m.Add(sum(x[i] for i in idx) <= int(cap))
            m.Add(sum(x[i] for i in idx) >= y[h])  # a used hospital must send something
        total = sum(x.values())
        m.Add(total <= int(qty))
        for used in cuts:  # no-good: differ from every earlier plan's hospital set
            m.Add(sum(1 - y[h] for h in used) + sum(y[h] for h in hospitals if h not in used) >= 1)
        cost = (BIG * (int(qty) - total)
                + sum(y[h] * (w["perTransfer"] + int(round(w["perKm"] * km[h]))) for h in hospitals)
                + sum(x[i] * _expiry_penalty(c, w) for i, c in enumerate(cands)))
        m.Minimize(cost)
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = time_limit_s
        s.parameters.num_search_workers = 1  # deterministic
        status = s.Solve(m)
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            break
        used = [h for h in hospitals if s.Value(y[h])]
        if not used:
            break
        legs = []
        for h in sorted(used, key=lambda h: km[h]):
            lots = [{"lotId": c["lotId"], "batchNo": c.get("batchNo"), "brandName": c.get("brandName"), "qty": s.Value(x[i]),
                     "expiryDate": c.get("expiryDate"), "daysToExpiry": c.get("daysToExpiry"), "nearExpiry": bool(c.get("nearExpiry"))}
                    for i, c in enumerate(cands) if c["hospitalId"] == h and s.Value(x[i]) > 0]
            first = next(c for c in cands if c["hospitalId"] == h)
            legs.append({"hospitalId": h, "hospitalName": first.get("hospitalName", h), "distanceKm": km[h],
                         "etaMin": int(first.get("etaMin") or 0), "qty": sum(l["qty"] for l in lots), "lots": lots})
        tq = sum(l["qty"] for l in legs)
        plans.append({"rank": len(plans) + 1, "legs": legs, "totalQty": tq, "transfers": len(legs), "fullyCovers": tq >= qty,
                      "score": round((s.ObjectiveValue() - BIG * (qty - tq)) / 100.0, 3), "status": s.StatusName(status)})
        cuts.append(set(used))
    # keep fully-covering plans ahead of partial ones, then by score
    plans.sort(key=lambda p: (not p["fullyCovers"], -p["totalQty"], p["score"]))
    for i, p in enumerate(plans):
        p["rank"] = i + 1
    return plans
