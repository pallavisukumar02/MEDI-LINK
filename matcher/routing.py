"""Distance / ETA: OpenRouteService (free key) with a Haversine fallback."""
import math
import os

import httpx

R = 6371.0


def haversine_km(a_lat, a_lon, b_lat, b_lon):
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = math.radians(b_lat - a_lat), math.radians(b_lon - a_lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def _env(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


def fallback(a, b):
    km = haversine_km(a["lat"], a["long"], b["lat"], b["long"]) * _env("ROAD_FACTOR", 1.3)
    eta = _env("ROUTE_HANDLING_MIN", 20) + km / _env("CITY_SPEED_KMH", 22) * 60
    return {"distanceKm": round(km, 2), "etaMin": int(round(eta)), "provider": "haversine"}


def route(a, b):
    key = os.environ.get("ORS_API_KEY", "").strip()
    if key:
        try:
            base = os.environ.get("ORS_BASE_URL", "https://api.openrouteservice.org")
            r = httpx.post(f"{base}/v2/directions/driving-car", headers={"Authorization": key},
                           json={"coordinates": [[a["long"], a["lat"]], [b["long"], b["lat"]]]}, timeout=6)
            r.raise_for_status()
            s = r.json()["routes"][0]["summary"]
            return {"distanceKm": round(s["distance"] / 1000, 2),
                    "etaMin": int(round(_env("ROUTE_HANDLING_MIN", 20) + s["duration"] / 60)), "provider": "ors"}
        except Exception:  # noqa: BLE001 - any ORS problem falls back to haversine
            pass
    return fallback(a, b)
