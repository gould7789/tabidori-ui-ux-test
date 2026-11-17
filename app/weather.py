"""날씨 — Open-Meteo 시간별 강수확률(무료·키 불필요, 설계노트 4절·25-1).

- 예보는 오늘 포함 16일까지만 있다 → 그보다 먼 날짜는 판정하지 않는다(설계도 '강수는 16일 안 예보만 판정').
- 가까운 스팟끼리 묶어(위경도 0.1도 칸) 한 번에 여러 좌표를 조회한다(설계 10/20: 스팟이 있는 지역마다).
- 받은 값은 30분만 들고 있다(세션 동안 임시 보관 원칙과 같은 숫자).
"""
import datetime as dt
import os
import time

import httpx

from .data import SPOTS

OPEN_METEO_URL = os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast")
FORECAST_DAYS = 16
TTL = 30 * 60
_cache: dict[tuple, tuple[float, dict[int, int]]] = {}


def _cell(sid: str) -> tuple[float, float]:
    s = SPOTS[sid]
    return round(s["lat"], 1), round(s["lng"], 1)


async def rain_for(ids: list[str], date: dt.date, today: dt.date | None = None) -> tuple[dict | None, str]:
    """반환: (스팟 id → {시: 강수확률%}, 상태). 상태 = ok | too_far | error.
    too_far·error면 첫 값은 None(비 판정을 하지 않음)."""
    today = today or dt.date.today()
    if (date - today).days >= FORECAST_DAYS:
        return None, "too_far"
    cells = sorted({_cell(i) for i in ids if SPOTS[i].get("outdoor")})
    now = time.time()
    need = [c for c in cells if not ((date.isoformat(), *c) in _cache and now - _cache[(date.isoformat(), *c)][0] < TTL)]
    if need:
        params = {
            "latitude": ",".join(str(c[0]) for c in need),
            "longitude": ",".join(str(c[1]) for c in need),
            "hourly": "precipitation_probability",
            "timezone": "Asia/Tokyo",
            "start_date": date.isoformat(), "end_date": date.isoformat(),
        }
        try:
            async with httpx.AsyncClient() as client:
                r = await client.get(OPEN_METEO_URL, params=params, timeout=6)
            r.raise_for_status()
            body = r.json()
            items = body if isinstance(body, list) else [body]
            if len(items) != len(need):
                raise ValueError("좌표 수와 응답 수가 다름")
            for c, it in zip(need, items):
                h = it["hourly"]
                hours = {int(t[11:13]): p for t, p in zip(h["time"], h["precipitation_probability"]) if p is not None}
                _cache[(date.isoformat(), *c)] = (now, hours)
        except Exception as e:  # 네트워크·형식 오류 → 이번엔 비 판정 없이 진행
            print(f"[tabidori] 날씨 조회 실패 → 비 판정 생략: {type(e).__name__}: {str(e)[:120]}")
            return None, "error"
    out = {i: _cache[(date.isoformat(), *_cell(i))][1] for i in ids if SPOTS[i].get("outdoor")}
    return out, "ok"
