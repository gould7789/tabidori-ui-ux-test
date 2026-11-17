"""타비도리 일정 화면(입력 → 검증 → 결과를 한 화면의 상태로) — FastAPI + Jinja2 + htmx + Google Maps JavaScript API.

실행:  uv run uvicorn app.main:app --reload
"""
import asyncio
import datetime as dt
import itertools
import time
import zlib
import json
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import data
from .routes_client import build_travel_table, ensure_pairs, pair_key
from .schedule import ORDER_FREE, compute_schedule, default_modes
from .weather import rain_for

BASE = Path(__file__).resolve().parent.parent
load_dotenv(BASE / ".env")

# 키 이름: 지금은 GOOGLE_MAPS_API_KEY 하나로 지도와 Routes API를 같이 쓴다.
# 나중에 브라우저용·서버용 키를 나누면 GOOGLE_MAPS_BROWSER_KEY / GOOGLE_MAPS_SERVER_KEY를 넣으면 그쪽이 우선한다.
MAPS_BROWSER_KEY = (os.getenv("GOOGLE_MAPS_BROWSER_KEY") or os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()

DOW_KO = ["월", "화", "수", "목", "금", "토", "일"]  # Python weekday() 순서
HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def parse_date(s: str | None) -> dt.date | None:
    """여행 날짜. 비었거나 형식이 틀리면 None — 날짜가 없으면 휴무를 판정하지 않는다(설계노트 16-1).
    (예전에는 기본 날짜로 몰래 바꿔 판정했음 — 11/17 점검에서 오류로 확인해 고침)"""
    try:
        return dt.date.fromisoformat(s) if s else None
    except ValueError:
        return None


def today() -> dt.date:
    return dt.date.today()


def wd(d: dt.date | None) -> int | None:
    return d.weekday() if d else None


# ---------- 임시휴무 확인(Loop A) — 시연용 ----------
# 실서비스: (장소, 날짜) 장부를 먼저 잡은 요청만 실행하고 나머지는 합류, 결과는 24시간 재사용(설계도 결정).
# 여기서는 같은 규칙을 메모리 dict로 흉내 내고, 판정은 data.loopa_demo(정해 둔 값)로 한다.
LOOPA_REUSE = 24 * 3600
LOOPA_DELAY_SCALE = float(os.getenv("LOOPA_DEMO_DELAY", "1"))   # 0이면 바로 끝남(테스트용)
_loopa: dict[tuple[str, str], dict] = {}
_loopa_running: dict[tuple[str, str], asyncio.Task] = {}


async def _run_loopa(sid: str, date: dt.date) -> dict:
    delay = (1.2 + (zlib.crc32(f"{sid}{date}".encode()) % 33) / 10) * LOOPA_DELAY_SCALE   # 1.2~4.4초
    await asyncio.sleep(delay)
    res = {**data.loopa_demo(sid, date), "checked_at": time.time()}
    _loopa[(sid, date.isoformat())] = res
    return res


async def loopa_result(sid: str, date: dt.date, force: bool = False) -> dict:
    key = (sid, date.isoformat())
    hit = _loopa.get(key)
    if hit and not force and hit["badge"] != "gray" and time.time() - hit["checked_at"] < LOOPA_REUSE:
        return hit
    task = _loopa_running.get(key)
    if task is None or task.done():          # 실행 중이면 합류
        task = asyncio.create_task(_run_loopa(sid, date))
        _loopa_running[key] = task
    return await task


def loopa_known(ids: list[str], date: dt.date | None) -> dict:
    """검증 계산에 쓸 이미 끝난 결과. 끝나지 않은 스팟은 없음 = 정기 정보로만 판정(⚪와 같음)."""
    if not date:
        return {}
    return {i: _loopa[(i, date.isoformat())] for i in ids if (i, date.isoformat()) in _loopa}

STATE: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    tt = await build_travel_table(data.INITIAL_ORDER)
    STATE["tt"] = tt
    src = {v["source"] for legs in tt.table.values() for v in legs.values()}
    print(f"[tabidori] 이동시간 출처: {sorted(src)}")
    yield


app = FastAPI(title="Tabidori", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")


# 다른 순서 패턴 계산(설계노트 9/9: 유효한 순서가 여럿이면 이동시간 기준 상위만 보여줌).
# 스팟 수가 적어(권장 상한 6) 모든 순서를 직접 계산해도 빠르다. 7곳을 넘으면 대안 계산을 건너뛴다.
MAX_PERMUTE = 7
ALT_KEYS = ["A", "B"]


def verify_patterns(order: list[str], dwell: dict[str, int], start: str, weekday: int | None,
                    allowed: list[str] | None = None, end_limit: str | None = None,
                    rain: dict | None = None, loopa: dict | None = None) -> tuple[dict, dict]:
    """반환: (패턴들, 메모). 메모 = {removed: 순서로 안 풀려서 뺀 스팟, alt_skipped: 스팟이 많아 계산 생략}."""
    tt = STATE["tt"]
    calc = lambda o, m: compute_schedule(tt, o, m, dwell, start, weekday, end_limit, rain, loopa)
    mine_modes = default_modes(tt, order, allowed)
    mine = calc(order, mine_modes)
    pats = {"mine": {"label": "내 패턴", "order": order, "modes": mine_modes, "schedule": mine}}
    # 휴무처럼 순서로 안 풀리는 위반이 있으면, 그 스팟을 전부 뺀 순서로 대안을 만든다(설계노트 18-3)
    removed = [i for i in order if mine["violations"].get(i, {}).get("type") in ORDER_FREE]
    base = [i for i in order if i not in removed]
    memo = {"removed": removed, "alt_skipped": False}
    alts = []
    if len(base) > MAX_PERMUTE:
        memo["alt_skipped"] = True     # 순서가 너무 많아 계산하지 않음 — 화면에서 "찾지 못했다"고 말하지 않는다
    elif len(base) >= 2:
        for perm in itertools.permutations(base):
            p = list(perm)
            if p == order:
                continue
            m = default_modes(tt, p, allowed)
            sch = calc(p, m)
            if sch["violation_count"]:      # 위반 없는 순서만 대안으로 제시
                continue
            alts.append((sch["total_travel"], sch["end"], p, m, sch))
        alts.sort(key=lambda x: (x[0], x[1]))
    for key, (_, _, p, m, sch) in zip(ALT_KEYS, alts):
        pats[key] = {"label": f"패턴 {key}", "order": p, "modes": m, "schedule": sch,
                     "removed": removed}
    return pats, memo


@app.get("/", response_class=HTMLResponse)
async def result_page(request: Request):
    tt = STATE["tt"]
    trip = {**data.TRIP, "date": data.default_date(today()).isoformat()}
    boot = {
        "trip": trip,
        "today": today().isoformat(),
        "maxSpots": data.MAX_SPOTS, "recommendedSpots": data.RECOMMENDED_SPOTS,
        "badges": data.BADGES,
        "spots": data.SPOTS,
        "demoOrder": data.INITIAL_ORDER,
        "travel": tt.as_json(),
        "modeLabel": data.MODE_LABEL,
        "modeIcon": data.MODE_ICON,
    }
    return templates.TemplateResponse(request, "plan.html", {
        "boot_json": json.dumps(boot, ensure_ascii=False).replace("</", "<\\/"),
        "maps_key": MAPS_BROWSER_KEY,
        "map_id": os.getenv("GOOGLE_MAPS_MAP_ID", "DEMO_MAP_ID"),
        "trip": trip,
        "today": today().isoformat(),
        "examples": data.EXAMPLE_PROMPTS,
    })


class ScheduleReq(BaseModel):
    order: list[str]
    modes: list[str] | None = None
    allowed: list[str] | None = None   # 입력화면에서 고른 '쓸 수 있는 이동수단'. 자동 배정에만 쓰고, 결과화면의 구간별 수동 선택은 막지 않는다
    dwell: dict[str, int] = {}
    start: str | None = None
    end: str | None = None             # 마감 시각(선택). 정하면 총 소요시간 초과를 판정
    date: str | None = None


def _check_order(order: list[str]) -> None:
    if not order or any(s not in data.SPOTS for s in order) or len(set(order)) != len(order):
        raise HTTPException(400, "잘못된 스팟 순서")
    if len(order) > data.MAX_SPOTS:
        raise HTTPException(400, f"스팟은 {data.MAX_SPOTS}곳까지 검증할 수 있어요")


def _allowed(req) -> list[str]:
    a = [m for m in (getattr(req, "allowed", None) or []) if m in data.MODES]
    return a or list(data.MODES)


def _clean(req) -> tuple[dict[str, int], str, str | None]:
    dwell = {k: max(0, min(600, v)) for k, v in req.dwell.items() if k in data.SPOTS}
    start = req.start if req.start and HHMM.match(req.start) else data.TRIP["start"]
    end = req.end if getattr(req, "end", None) and HHMM.match(req.end) else None
    return dwell, start, end


async def _conditions(ids: list[str], date: dt.date | None) -> tuple[dict | None, str, dict]:
    """날씨(비 판정)와 이미 끝난 임시휴무 확인 결과."""
    if not date:
        return None, "nodate", {}
    rain, wstatus = await rain_for(ids, date, today())
    return rain, wstatus, loopa_known(ids, date)


@app.post("/api/schedule")
async def api_schedule(req: ScheduleReq):
    tt = STATE["tt"]
    _check_order(req.order)
    await ensure_pairs(tt, req.order)
    modes = req.modes
    if not modes or len(modes) != len(req.order) - 1 or any(m not in data.MODES for m in modes):
        modes = default_modes(tt, req.order, _allowed(req))
    dwell, start, end = _clean(req)
    date = parse_date(req.date)
    rain, wstatus, loopa = await _conditions(req.order, date)
    sched = compute_schedule(tt, req.order, modes, dwell, start, wd(date), end, rain, loopa)
    return {"modes": modes, "weather": wstatus, **sched}


class VerifyReq(BaseModel):
    order: list[str]
    allowed: list[str] | None = None
    dwell: dict[str, int] = {}
    start: str | None = None
    end: str | None = None
    date: str | None = None


@app.post("/api/verify")
async def api_verify(req: VerifyReq):
    """검증하기: 내 순서를 그대로 판정하고, 위반 없는 다른 순서를 이동시간 기준 최대 2개 더 계산한다."""
    _check_order(req.order)
    tt = STATE["tt"]
    date = parse_date(req.date)
    if not date:
        raise HTTPException(400, "날짜를 먼저 선택해주세요")      # 검증하기만 날짜가 필요(설계노트 16-1)
    if date < today():
        raise HTTPException(400, "지난 날짜는 검증할 수 없어요")
    await ensure_pairs(tt, req.order)   # 큐레이션에서 담은 스팟의 구간은 이때 처음 계산
    dwell, start, end = _clean(req)
    rain, wstatus, loopa = await _conditions(req.order, date)
    pats, memo = verify_patterns(req.order, dwell, start, wd(date), _allowed(req), end, rain, loopa)
    ids = req.order
    travel = {pk: tt.table[pk] for pk in {pair_key(a, b) for i, a in enumerate(ids) for b in ids[i + 1:]}}
    return {"patterns": pats, "travel": travel, "weather": wstatus, **memo}


class LoopAReq(BaseModel):
    spot: str
    date: str
    force: bool = False


@app.post("/api/loopa")
async def api_loopa(req: LoopAReq):
    """임시휴무 확인(시연용). 담을 때·[지금 확인]·검증하기 직전에 부른다. 같은 (장소, 날짜)는 합류·24시간 재사용."""
    date = parse_date(req.date)
    if req.spot not in data.SPOTS or not date:
        raise HTTPException(400, "잘못된 요청")
    res = await loopa_result(req.spot, date, req.force)
    return {**res, "badge_info": data.BADGES[res["badge"]]}


# ---------- htmx 조각 ----------

@app.get("/partials/curation", response_class=HTMLResponse)
async def partial_curation(request: Request, q: str = "", tags: str = "", hide_closed: str = "", date: str = "",
                           added: str = ""):
    active = [t for t in tags.split(",") if t]
    in_tray = [t for t in added.split(",") if t]
    ql = q.strip().lower()
    day = wd(parse_date(date))

    def closed(sp):   # 날짜가 없으면 휴무 판정을 하지 않는다
        return day is not None and day in sp.get("closed_dow", [])

    counts: dict[str, int] = {}
    for sp in data.CURATION:
        for t in sp["tags"]:
            counts[t] = counts.get(t, 0) + 1
    items = [sp for sp in data.CURATION
             if (not ql or ql in sp["name"].lower() or any(ql in t for t in sp["tags"]))
             and (not active or any(t in active for t in sp["tags"]))]
    n_closed = sum(1 for sp in items if closed(sp))
    if hide_closed:
        items = [sp for sp in items if not closed(sp)]
    items.sort(key=closed)
    return templates.TemplateResponse(request, "partials/curation_grid.html", {
        "items": [{**sp, "closed": closed(sp), "added": sp["id"] in in_tray} for sp in items],
        "counts": counts, "active": active, "q": q, "nodate": day is None,
        "dow": DOW_KO[day] if day is not None else "", "hidden_closed": n_closed if hide_closed else 0,
    })


@app.post("/partials/chat", response_class=HTMLResponse)
async def partial_chat(request: Request):
    form = await request.form()
    text = str(form.get("text", "")).strip()
    ex = form.get("example")
    if ex is not None and str(ex).isdigit() and int(ex) < len(data.EXAMPLE_PROMPTS):
        p = data.EXAMPLE_PROMPTS[int(ex)]
        user, reply = p["user"], p["advisor"]
    elif text:
        user = text
        reply = "확인했어요 — 대화 응답(LangGraph Agent)은 아직 이 화면에 연결되지 않았어요. 지금은 지도·일정 계산만 실제로 동작해요."
    else:
        return HTMLResponse("")
    return templates.TemplateResponse(request, "partials/chat_pair.html", {"user": user, "reply": reply})
