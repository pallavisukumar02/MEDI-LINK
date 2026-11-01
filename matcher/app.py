"""MediLink matcher: FastAPI POST /rank using Google OR-Tools (CP-SAT). Hard rules are applied by CAP first."""
from typing import Dict, List, Optional

import hmac
import os

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

import explain
import routing
import solver

app = FastAPI(title="MediLink matcher", version="1.0.0")


class Candidate(BaseModel):
    lotId: str
    hospitalId: str
    hospitalName: Optional[str] = None
    lat: Optional[float] = None
    long: Optional[float] = None
    maxQty: int
    distanceKm: Optional[float] = None
    etaMin: Optional[int] = None
    expiryDate: Optional[str] = None
    daysToExpiry: int = 365
    nearExpiry: bool = False
    batchNo: Optional[str] = None
    brandName: Optional[str] = None


class Point(BaseModel):
    id: Optional[str] = None
    lat: float
    long: float


class RankRequest(BaseModel):
    requestId: Optional[str] = None
    qty: int = Field(gt=0)
    neededBy: Optional[str] = None
    receiver: Optional[Point] = None
    drug: Optional[dict] = None
    candidates: List[Candidate]
    hospitalCaps: Dict[str, int] = {}
    maxPlans: int = 3
    nearExpiryDays: int = 60
    weights: Optional[Dict[str, int]] = None


@app.get("/health")
def health():
    return {"status": "UP", "engine": "ortools-cp-sat", "llm": explain.llm_enabled()}


def _check_token(token: Optional[str]):
    """If MATCHER_TOKEN is set (deployed), CAP must send it in X-Matcher-Token. Unset = open (local dev)."""
    expected = os.environ.get("MATCHER_TOKEN", "")
    if expected and not hmac.compare_digest(expected, token or ""):
        raise HTTPException(status_code=401, detail="MATCHER_TOKEN_INVALID")


@app.post("/rank")
def rank(body: RankRequest, x_matcher_token: Optional[str] = Header(default=None)):
    _check_token(x_matcher_token)
    cands = [c.model_dump() for c in body.candidates]
    route_cache = {}
    for c in cands:  # fill distance/ETA if CAP did not send them
        if c["distanceKm"] is None and body.receiver and c["lat"] is not None:
            key = c["hospitalId"]
            route_cache.setdefault(key, routing.route({"lat": c["lat"], "long": c["long"]}, body.receiver.model_dump()))
            c["distanceKm"], c["etaMin"] = route_cache[key]["distanceKm"], route_cache[key]["etaMin"]
        if c["distanceKm"] is None:
            c["distanceKm"] = 0.0
    plans = solver.rank(body.qty, cands, body.hospitalCaps, body.maxPlans, body.weights)
    best = plans[0] if plans else None
    for p in plans:
        p["reason"] = explain.template(p, body.qty, best)
        p["reasonSource"] = "template"
        rewritten = explain.llm_rewrite(p["reason"], {"plan": p, "qty": body.qty})
        if rewritten:
            p["reason"], p["reasonSource"] = rewritten, "llm"
    return {"engine": "ortools-cp-sat", "requestId": body.requestId, "plans": plans}


if __name__ == "__main__":  # python app.py: any Python host; listens on $PORT (default 5001)
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=int(os.environ.get("PORT", "5001")), log_level="warning")
