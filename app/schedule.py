"""일정 계산 — 하드 제약 4개(설계노트 2-1·25-1)와 임시휴무 확인(Loop A) 결과를 반영한다.

스팟별 위반(한 스팟에 하나, 우선순위 순):
  tempClosed(🔴 임시 휴관) > closedDay(정기 휴무) > partialClosed(🟠 일부 휴관) > closeAfter(마감 뒤 도착) > rainOutdoor(비 올 때 실외)
일정 전체 위반: overTime(마감 시각을 정했을 때만, 총 소요시간 초과)
순서와 무관한 위반(ORDER_FREE)은 순서를 바꿔도 풀리지 않는다 → 다른 순서 패턴은 그 스팟을 뺀 순서로 만든다(설계노트 18-3).
🔵 특별 개관은 공식 페이지에서 확인된 경우에만 휴무·마감을 풀어 준다(개발노트 8-6 ⓒ).
"""
from .data import SPOTS

RAIN_THRESHOLD = 70   # 설계노트 25-1: 방문 시간대 강수확률 70% 이상
ORDER_FREE = {"tempClosed", "closedDay", "partialClosed"}
from .routes_client import TravelTable


def hhmm_to_min(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: int) -> str:
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


# 도보 우선 기준(2026-11-15 결정): 도보가 이 시간 이하면 더 빠른 수단이 있어도 도보를 배정한다.
# 실측값을 넣자 300m 구간에 렌터카(4분)가 배정되는 문제가 생겨, 시내 관광 동선에 맞게 바꿨다.
WALK_FIRST_MAX_MIN = 15


ALL_MODES = ["walk", "bike", "transit", "car"]


def fastest_mode(tt: TravelTable, a: str, b: str, allowed: list[str] | None = None) -> str:
    """구간별 이동수단 자동 배정. allowed = 입력화면에서 고른 '쓸 수 있는 이동수단'(11/17, 기본 도보+전철).
    1) 도보를 쓸 수 있고 도보가 WALK_FIRST_MAX_MIN분 이하면 도보.
    2) 아니면 쓸 수 있는 수단 중 가장 빠른 것. 그중 도보가 아닌 수단에 실측값(Routes API)이 있으면 실측값끼리만 비교한다
       — 고정값(전철 등)이 실측값을 이기며 자동 배정되는 일을 막기 위함(11/15).
       단, 도보 말고는 고정값 수단뿐이면(예: 도보+전철) 고정값도 비교에 넣는다 — 안 그러면 전철이 영영 배정되지 않는다."""
    allowed = [m for m in ALL_MODES if m in (allowed or ALL_MODES)] or ALL_MODES
    if "walk" in allowed and tt.minutes(a, b, "walk") <= WALK_FIRST_MAX_MIN:
        return "walk"
    live = [m for m in allowed if tt.get(a, b, m)["source"] == "routes_api"]
    pool = live if any(m != "walk" for m in live) else allowed
    opts = {m: tt.minutes(a, b, m) for m in pool}
    # 동률이면 도보 > 자전거 > 전철 > 렌터카 순으로 선호
    return min(opts, key=lambda m: (opts[m], ALL_MODES.index(m)))


def default_modes(tt: TravelTable, order: list[str], allowed: list[str] | None = None) -> list[str]:
    return [fastest_mode(tt, order[i], order[i + 1], allowed) for i in range(len(order) - 1)]


def compute_schedule(tt: TravelTable, order: list[str], modes: list[str],
                     dwell: dict[str, int], start: str, weekday: int | None = None,
                     end_limit: str | None = None, rain: dict | None = None,
                     loopa: dict | None = None) -> dict:
    """weekday: 여행 날짜의 Python weekday(월=0). None이면 휴관일 판정을 하지 않는다.
    rain: 스팟 id → {시(0~23): 강수확률%}. None이면 비 판정을 하지 않는다(날짜가 16일 밖이거나 조회 실패).
    loopa: 스팟 id → 임시휴무 확인 결과(kind·path·close_override). 없으면 정기 정보로만 판정."""
    t = hhmm_to_min(start)
    rows, violations = [], {}
    for i, sid in enumerate(order):
        s = SPOTS[sid]
        ex = (loopa or {}).get(sid) or {}
        lifted = ex.get("kind") == "special" and ex.get("path") == "official"
        close = ex.get("close_override") if lifted and ex.get("close_override") else s["close"]
        arrive = t
        d = dwell.get(sid, s["dwell"])
        depart = arrive + d
        v = None
        if ex.get("kind") == "closed":
            v = {"type": "tempClosed", "quote": ex.get("quote", "")}
        elif weekday is not None and weekday in s.get("closed_dow", []) and not lifted:
            v = {"type": "closedDay", "dow": weekday}
        elif ex.get("kind") == "partial":
            v = {"type": "partialClosed", "quote": ex.get("quote", "")}
        elif close and arrive > hhmm_to_min(close):
            v = {"type": "closeAfter", "over_by": arrive - hhmm_to_min(close), "close": close}
        elif rain is not None and s.get("outdoor") and sid in rain:
            hours = range(arrive // 60, min(23, (max(arrive, depart - 1)) // 60) + 1)
            worst = max(((rain[sid].get(h), h) for h in hours if rain[sid].get(h) is not None), default=None)
            if worst and worst[0] >= RAIN_THRESHOLD:
                v = {"type": "rainOutdoor", "prob": worst[0], "hour": worst[1]}
        if v:
            violations[sid] = v
        row = {"id": sid, "arrive": min_to_hhmm(arrive), "depart": min_to_hhmm(depart), "dwell": d}
        if lifted:
            row["lifted"] = close or True
        if i < len(order) - 1:
            nxt = order[i + 1]
            mode = modes[i]
            leg = tt.get(sid, nxt, mode)
            row["to_next"] = {"mode": mode, "min": leg["min"], "source": leg["source"]}
            t = depart + leg["min"]
        else:
            t = depart
        rows.append(row)
    over_time = None
    if end_limit and t > hhmm_to_min(end_limit):
        over_time = {"type": "overTime", "end": min_to_hhmm(t), "limit": end_limit, "over_by": t - hhmm_to_min(end_limit)}
    return {
        "rows": rows,
        "violations": violations,
        "over_time": over_time,
        "violation_count": len(violations) + (1 if over_time else 0),
        "end": min_to_hhmm(t),
        "total_travel": sum(r["to_next"]["min"] for r in rows if "to_next" in r),
    }
