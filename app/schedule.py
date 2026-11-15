"""일정 계산 — 와이어프레임에서 브라우저 JS가 흉내 내던 부분을 서버(파이썬)로 옮긴 것.

하드 제약 4개 중 이 화면에서는 '폐관 후 도착(closeAfter)'만 판정한다.
휴관일·총소요시간 초과·강수 시 실외는 데이터 연결 후 같은 자리에 추가한다.
"""
from .data import SPOTS
from .routes_client import TravelTable


def hhmm_to_min(s: str) -> int:
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def min_to_hhmm(m: int) -> str:
    return f"{(m // 60) % 24:02d}:{m % 60:02d}"


# 도보 우선 기준(2026-11-15 결정): 도보가 이 시간 이하면 더 빠른 수단이 있어도 도보를 배정한다.
# 실측값을 넣자 300m 구간에 렌터카(4분)가 배정되는 문제가 생겨, 시내 관광 동선에 맞게 바꿨다.
WALK_FIRST_MAX_MIN = 15


def fastest_mode(tt: TravelTable, a: str, b: str) -> str:
    """구간별 이동수단 자동 배정.
    1) 도보가 WALK_FIRST_MAX_MIN분 이하면 도보.
    2) 아니면 가장 빠른 수단. 실측값(Routes API)이 하나라도 있으면 실측값끼리만 비교한다
       — 고정값(전철 등)이 실측값을 이기며 자동 배정되는 일을 막기 위함. 고정값 수단은 유저가 직접 고를 수 있다."""
    if tt.minutes(a, b, "walk") <= WALK_FIRST_MAX_MIN:
        return "walk"
    all_modes = ["walk", "bike", "transit", "car"]
    live = [m for m in all_modes if tt.get(a, b, m)["source"] == "routes_api"]
    opts = {m: tt.minutes(a, b, m) for m in (live or all_modes)}
    # 동률이면 도보 > 자전거 > 전철 > 렌터카 순으로 선호
    return min(opts, key=lambda m: (opts[m], all_modes.index(m)))


def default_modes(tt: TravelTable, order: list[str]) -> list[str]:
    return [fastest_mode(tt, order[i], order[i + 1]) for i in range(len(order) - 1)]


def compute_schedule(tt: TravelTable, order: list[str], modes: list[str],
                     dwell: dict[str, int], start: str) -> dict:
    t = hhmm_to_min(start)
    rows, violations = [], {}
    for i, sid in enumerate(order):
        s = SPOTS[sid]
        arrive = t
        if s["close"]:
            close_min = hhmm_to_min(s["close"])
            if arrive > close_min:
                violations[sid] = {"type": "closeAfter", "over_by": arrive - close_min,
                                   "close": s["close"]}
        d = dwell.get(sid, s["dwell"])
        depart = arrive + d
        row = {"id": sid, "arrive": min_to_hhmm(arrive), "depart": min_to_hhmm(depart), "dwell": d}
        if i < len(order) - 1:
            nxt = order[i + 1]
            mode = modes[i]
            leg = tt.get(sid, nxt, mode)
            row["to_next"] = {"mode": mode, "min": leg["min"], "source": leg["source"]}
            t = depart + leg["min"]
        else:
            t = depart
        rows.append(row)
    return {
        "rows": rows,
        "violations": violations,
        "end": min_to_hhmm(t),
        "total_travel": sum(r["to_next"]["min"] for r in rows if "to_next" in r),
    }
