"""Google Routes API(computeRoutes) 호출 + 파일 캐시.

- 도보(WALK)·자전거(BICYCLE)·자동차(DRIVE)만 실제로 호출한다.
- 전철(TRANSIT)은 호출하지 않고 고정값을 쓴다. Google API는 일본 대중교통 경로를 돌려주지 않는 사례가
  보고되어 있어(ZERO_RESULTS), 설계상 대중교통은 NAVITIME을 쓰기로 했기 때문이다.
- 한 번 받은 결과는 .cache/routes.json에 저장해 같은 구간을 다시 호출하지 않는다(과금 방지).
- 구간 소요시간은 a→b 한 방향만 받아 양방향에 같이 쓴다(데모 단순화).
- 서버 시작 때는 추천 4곳의 구간만 받고, 큐레이션 목록에서 담은 스팟의 구간은 검증할 때 필요한 것만 받는다(ensure_pairs).
- API를 못 쓰는 구간은 FALLBACK_TRAVEL(고정값, source='fallback'), 그것도 없으면 직선거리로 추정한다(source='estimate').
"""
import asyncio
import json
import math
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


def estimate_travel(a: str, b: str) -> dict[str, int]:
    """고정값이 없는 구간의 추정치(분). 직선거리 × 우회 계수 ÷ 평균 속도 — 실측 아님."""
    sa, sb = SPOTS[a], SPOTS[b]
    la1, lo1, la2, lo2 = map(math.radians, [sa["lat"], sa["lng"], sb["lat"], sb["lng"]])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    km = 2 * 6371 * math.asin(math.sqrt(h))
    return {
        "walk": max(1, round(km * 1.3 / 4.5 * 60)),
        "bike": max(1, round(km * 1.3 / 13 * 60)),
        "car": max(1, round(km * 1.4 / 25 * 60) + 3),
        "transit": max(1, round(km * 1.3 / 20 * 60) + 10),
    }


class TravelTable:
    """구간별·수단별 소요시간과 경로선. source: 'routes_api'(실측) | 'fallback'(고정값) | 'estimate'(직선거리 추정)"""

    def __init__(self):
        self.table: dict[str, dict[str, dict]] = {}
        self.errors: list[str] = []
        self.key = ""
        self.use_api = False
        self.cache: dict = {}

    def get(self, a: str, b: str, mode: str) -> dict:
        return self.table[pair_key(a, b)][mode]

    def minutes(self, a: str, b: str, mode: str) -> int:
        return self.get(a, b, mode)["min"]

    def as_json(self) -> dict:
        return self.table


async def _fill(tt: TravelTable, pairs: list[str]) -> None:
    """빠진 구간을 채운다: 캐시 → (가능하면) Routes API → 고정값/추정치."""
    todo = [(pk, mode) for pk in pairs for mode in API_MODE
            if tt.use_api and f"{pk}|{mode}" not in tt.cache]
    if todo:
        async with httpx.AsyncClient() as client:
            results = await asyncio.gather(*[
                _compute_one(client, tt.key, *pk.split("|"), mode) for pk, mode in todo
            ])
        for (pk, mode), res in zip(todo, results):
            if res and "error" not in res:
                tt.cache[f"{pk}|{mode}"] = res
            else:
                msg = f"{pk} {mode}: {res.get('error') if res else 'unknown'}"
                tt.errors.append(msg)
                print(f"[tabidori] Routes API 실패 → 고정값 사용: {msg}")
        _save_cache(tt.cache)

    for pk in pairs:
        fixed = FALLBACK_TRAVEL.get(pk)
        approx, approx_src = (fixed, "fallback") if fixed else (estimate_travel(*pk.split("|")), "estimate")
        tt.table[pk] = {}
        for mode in ["walk", "bike", "transit", "car"]:
            hit = tt.cache.get(f"{pk}|{mode}") if mode in API_MODE else None
            if hit:
                tt.table[pk][mode] = {**hit, "source": "routes_api"}
            else:
                # fallback = 데모 고정값(와이어프레임 값), estimate = 직선거리 추정 — 화면에서 구분해서 보여준다
                tt.table[pk][mode] = {"min": approx[mode], "polyline": None, "source": approx_src}


async def ensure_pairs(tt: TravelTable, ids: list[str]) -> list[str]:
    """ids 사이의 모든 구간이 표에 있도록 채우고, 새로 채운 구간 키를 돌려준다."""
    pairs = sorted({pair_key(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]})
    missing = [pk for pk in pairs if pk not in tt.table]
    if missing:
        await _fill(tt, missing)
    return missing


async def build_travel_table(ids: list[str], refresh: bool = False) -> TravelTable:
    """서버 시작 때 호출. ids(추천 스팟) 사이 구간만 먼저 채운다."""
    tt = TravelTable()
    # 서버용 키가 따로 없으면 공용 키(GOOGLE_MAPS_API_KEY)를 쓴다
    tt.key = (os.getenv("GOOGLE_MAPS_SERVER_KEY") or os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()
    tt.use_api = os.getenv("USE_ROUTES_API", "1") == "1" and bool(tt.key)
    tt.cache = {} if refresh else _load_cache()
    await ensure_pairs(tt, ids)
    return tt
