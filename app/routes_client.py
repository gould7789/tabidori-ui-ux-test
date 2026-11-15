"""Google Routes API(computeRoutes) 호출 + 파일 캐시.

- 도보(WALK)·자전거(BICYCLE)·자동차(DRIVE)만 실제로 호출한다.
- 전철(TRANSIT)은 호출하지 않고 고정값을 쓴다. Google API는 일본 대중교통 경로를 돌려주지 않는 사례가
  보고되어 있어(ZERO_RESULTS), 설계상 대중교통은 NAVITIME을 쓰기로 했기 때문이다.
- 한 번 받은 결과는 .cache/routes.json에 저장해 같은 구간을 다시 호출하지 않는다(과금 방지).
- 구간 소요시간은 a→b 한 방향만 받아 양방향에 같이 쓴다(데모 단순화).
"""
import asyncio
import json
import os
from pathlib import Path

import httpx

from .data import FALLBACK_TRAVEL, SPOTS

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"
FIELD_MASK = "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline"
API_MODE = {"walk": "WALK", "bike": "BICYCLE", "car": "DRIVE"}
CACHE_PATH = Path(__file__).resolve().parent.parent / ".cache" / "routes.json"


def pair_key(a: str, b: str) -> str:
    return "|".join(sorted([a, b]))


def _load_cache() -> dict:
    if CACHE_PATH.exists():
        try:
            return json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return {}
    return {}


def _save_cache(cache: dict) -> None:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    CACHE_PATH.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


async def _compute_one(client: httpx.AsyncClient, key: str, a: str, b: str, mode: str) -> dict | None:
    sa, sb = SPOTS[a], SPOTS[b]
    body = {
        "origin": {"location": {"latLng": {"latitude": sa["lat"], "longitude": sa["lng"]}}},
        "destination": {"location": {"latLng": {"latitude": sb["lat"], "longitude": sb["lng"]}}},
        "travelMode": API_MODE[mode],
        "languageCode": "ko",
        "units": "METRIC",
    }
    if mode == "car":
        body["routingPreference"] = "TRAFFIC_UNAWARE"
    try:
        r = await client.post(
            ROUTES_URL, json=body,
            headers={"X-Goog-Api-Key": key, "X-Goog-FieldMask": FIELD_MASK},
            timeout=10,
        )
    except httpx.HTTPError as e:
        return {"error": f"network: {type(e).__name__}"}
    if r.status_code != 200:
        # 응답 본문에는 키가 들어 있지 않지만, 길게 남기지 않는다
        return {"error": f"http {r.status_code}: {r.text[:160]}"}
    routes = r.json().get("routes") or []
    if not routes:
        return {"error": "no route"}
    rt = routes[0]
    seconds = int(str(rt.get("duration", "0s")).rstrip("s") or 0)
    return {
        "min": max(1, round(seconds / 60)),
        "meters": rt.get("distanceMeters"),
        "polyline": (rt.get("polyline") or {}).get("encodedPolyline"),
    }


class TravelTable:
    """구간별·수단별 소요시간과 경로선. source: 'routes_api' | 'fallback'"""

    def __init__(self):
        self.table: dict[str, dict[str, dict]] = {}
        self.errors: list[str] = []

    def get(self, a: str, b: str, mode: str) -> dict:
        return self.table[pair_key(a, b)][mode]

    def minutes(self, a: str, b: str, mode: str) -> int:
        return self.get(a, b, mode)["min"]

    def as_json(self) -> dict:
        return self.table


async def build_travel_table(refresh: bool = False) -> TravelTable:
    # 서버용 키가 따로 없으면 공용 키(GOOGLE_MAPS_API_KEY)를 쓴다
    key = (os.getenv("GOOGLE_MAPS_SERVER_KEY") or os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()
    use_api = os.getenv("USE_ROUTES_API", "1") == "1" and bool(key)
    cache = {} if refresh else _load_cache()
    tt = TravelTable()

    ids = list(SPOTS.keys())
    pairs = sorted({pair_key(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]})

    todo = []
    for pk in pairs:
        for mode in API_MODE:
            ck = f"{pk}|{mode}"
            if use_api and ck not in cache:
                todo.append((pk, mode))

    if todo:
        async with httpx.AsyncClient() as client:
            results = await asyncio.gather(*[
                _compute_one(client, key, *pk.split("|"), mode) for pk, mode in todo
            ])
        for (pk, mode), res in zip(todo, results):
            if res and "error" not in res:
                cache[f"{pk}|{mode}"] = res
            else:
                tt.errors.append(f"{pk} {mode}: {res.get('error') if res else 'unknown'}")
        _save_cache(cache)

    for pk in pairs:
        tt.table[pk] = {}
        for mode in ["walk", "bike", "transit", "car"]:
            hit = cache.get(f"{pk}|{mode}") if mode in API_MODE else None
            if hit:
                tt.table[pk][mode] = {**hit, "source": "routes_api"}
            else:
                tt.table[pk][mode] = {"min": FALLBACK_TRAVEL[pk][mode], "polyline": None, "source": "fallback"}
    return tt
