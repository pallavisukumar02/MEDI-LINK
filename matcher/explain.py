"""Plain-language "why this plan" text: template always; optional LLM rewrite (LLM_PROVIDER=openai-compatible or aicore)."""
import json
import os
import re
import time

import httpx


def template(plan, qty, best=None):
    legs = plan["legs"]
    near = [l for leg in legs for l in leg["lots"] if l.get("nearExpiry")]
    if len(legs) == 1:
        leg = legs[0]
        lead = ("Nearest eligible hospital" if plan["rank"] == 1 else "Alternative") + f": {leg['hospitalName']} ({leg['distanceKm']} km, ~{leg['etaMin']} min)."
        cover = f" One transfer covers {'all ' + str(qty) if plan['fullyCovers'] else str(plan['totalQty']) + ' of ' + str(qty)} doses."
    else:
        names = " and ".join(f"{l['hospitalName']} ({l['distanceKm']} km)" for l in legs)
        lead = ("Best combination" if plan["rank"] == 1 else "Alternative") + f": {len(legs)} transfers from {names}."
        cover = f" Together they cover {'all ' + str(qty) if plan['fullyCovers'] else str(plan['totalQty']) + ' of ' + str(qty)} doses."
    waste = ""
    if near:
        n = near[0]
        waste = f" Uses near-expiry batch {n['batchNo']} (expires in {n['daysToExpiry']} days), cutting waste."
    delta = ""
    if best is not None and plan["rank"] > 1:
        d = round(sum(l["distanceKm"] for l in legs) - sum(l["distanceKm"] for l in best["legs"]), 1)
        if d > 0:
            delta = f" {d} km further than plan 1."
    partial = "" if plan["fullyCovers"] else " No eligible hospital holds more genuine surplus."
    return (lead + cover + waste + delta + partial).strip()


_NUM = re.compile(r"\d+(?:\.\d+)?")


def numbers_preserved(original, rewritten):
    """Guard: an LLM rewrite must keep exactly the same numbers (km, minutes, doses, days)."""
    return sorted(_NUM.findall(original)) == sorted(_NUM.findall(rewritten))


_tok = {"v": None, "exp": 0}
_dep = {"url": None}


def _aicore_key():
    path = os.environ.get("AICORE_SERVICE_KEY_PATH", "")
    for p in [path, os.path.join(os.path.dirname(__file__), "..", "backend", path.lstrip("./"))]:
        if p and os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    return None


def _provider():
    return os.environ.get("LLM_PROVIDER", "none").lower()


def llm_enabled():
    if _provider() == "openai-compatible":
        return bool(os.environ.get("LLM_BASE_URL") and os.environ.get("LLM_MODEL"))
    return _provider() == "aicore" and bool(os.environ.get("AICORE_MODEL_NAME")) and _aicore_key() is not None


def _openai_compatible(msg):
    """Any OpenAI-style POST {LLM_BASE_URL}/chat/completions (same settings as the CAP backend)."""
    key = os.environ.get("LLM_API_KEY")
    r = httpx.post(f"{os.environ['LLM_BASE_URL'].rstrip('/')}/chat/completions", headers={"Authorization": f"Bearer {key}"} if key else {},
                   json={"model": os.environ["LLM_MODEL"], "messages": msg, "max_tokens": 120, "temperature": 0}, timeout=20)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _aicore(msg):
    """SAP AI Core generative AI hub: service key file (AICORE_SERVICE_KEY_PATH) + a RUNNING deployment of AICORE_MODEL_NAME."""
    k = _aicore_key()
    rg = os.environ.get("AICORE_RESOURCE_GROUP", "default")
    if not _tok["v"] or _tok["exp"] < time.time() + 30:
        r = httpx.post(f"{k['url']}/oauth/token", data={"grant_type": "client_credentials"}, auth=(k["clientid"], k["clientsecret"]), timeout=10)
        r.raise_for_status()
        _tok.update(v=r.json()["access_token"], exp=time.time() + r.json().get("expires_in", 3600))
    h = {"Authorization": f"Bearer {_tok['v']}", "AI-Resource-Group": rg}
    if not _dep["url"]:
        r = httpx.get(f"{k['serviceurls']['AI_API_URL']}/v2/lm/deployments", params={"status": "RUNNING"}, headers=h, timeout=10)
        r.raise_for_status()
        model = os.environ["AICORE_MODEL_NAME"]
        d = next(x for x in r.json().get("resources", []) if model in json.dumps(x.get("details", {})))
        _dep["url"] = d["deploymentUrl"]
    r = httpx.post(f"{_dep['url']}/chat/completions", params={"api-version": "2024-02-01"}, headers=h, json={"messages": msg, "max_tokens": 120, "temperature": 0}, timeout=20)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def llm_rewrite(text, facts):
    """Returns a rewritten sentence or None. Never changes the ranking."""
    if not llm_enabled():
        return None
    msg = [{"role": "system", "content": "Rewrite the explanation for a hospital pharmacist in one or two plain sentences. Keep every number exactly. Do not add facts."},
           {"role": "user", "content": f"Explanation: {text}\nFacts: {json.dumps(facts)}"}]
    try:
        out = (_openai_compatible if _provider() == "openai-compatible" else _aicore)(msg).strip()
        return out if out and numbers_preserved(text, out) else None
    except Exception:  # noqa: BLE001 - LLM is optional; template stays
        return None
