"""타비도리 결과화면 — FastAPI + Jinja2 + htmx + Google Maps JavaScript API.

실행:  uv run uvicorn app.main:app --reload
"""
import datetime as dt
import json
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from . import data
from .routes_client import build_travel_table
from .schedule import compute_schedule, default_modes

BASE = Path(__file__).resolve().parent.parent
load_dotenv(BASE / ".env")

# 키 이름: 지금은 GOOGLE_MAPS_API_KEY 하나로 지도와 Routes API를 같이 쓴다.
# 나중에 브라우저용·서버용 키를 나누면 GOOGLE_MAPS_BROWSER_KEY / GOOGLE_MAPS_SERVER_KEY를 넣으면 그쪽이 우선한다.
MAPS_BROWSER_KEY = (os.getenv("GOOGLE_MAPS_BROWSER_KEY") or os.getenv("GOOGLE_MAPS_API_KEY") or "").strip()

DOW_KO = ["월", "화", "수", "목", "금", "토", "일"]  # Python weekday() 순서
TRIP_DATE = dt.date.fromisoformat(data.TRIP["date"])
DATE_LABEL = f"{TRIP_DATE.month}월 {TRIP_DATE.day}일({DOW_KO[TRIP_DATE.weekday()]})"

STATE: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    tt = await build_travel_table()
    STATE["tt"] = tt
    src = {v["source"] for legs in tt.table.values() for v in legs.values()}
    print(f"[tabidori] 이동시간 출처: {sorted(src)}")
    for e in tt.errors:
        print(f"[tabidori] Routes API 실패 → 고정값 사용: {e}")
    yield


app = FastAPI(title="Tabidori", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")


def _patterns():
    tt = STATE["tt"]
    pats = {"mine": {"label": "내 패턴", "order": data.INITIAL_ORDER}}
    pats.update(data.ALT_PATTERNS)
    return {k: {"label": p["label"], "order": p["order"], "modes": default_modes(tt, p["order"])}
            for k, p in pats.items()}


@app.get("/", response_class=HTMLResponse)
async def result_page(request: Request):
    tt = STATE["tt"]
    boot = {
        "trip": {**data.TRIP, "date_label": DATE_LABEL},
        "spots": data.SPOTS,
        "patterns": _patterns(),
        "travel": tt.as_json(),
        "modeLabel": data.MODE_LABEL,
        "modeIcon": data.MODE_ICON,
    }
    return templates.TemplateResponse(request, "result.html", {
        "boot_json": json.dumps(boot, ensure_ascii=False).replace("</", "<\\/"),
        "maps_key": MAPS_BROWSER_KEY,
        "map_id": os.getenv("GOOGLE_MAPS_MAP_ID", "DEMO_MAP_ID"),
        "trip": data.TRIP, "date_label": DATE_LABEL,
        "examples": data.EXAMPLE_PROMPTS,
        "routes_api_on": any(v["source"] == "routes_api"
                             for legs in tt.table.values() for v in legs.values()),
    })


class ScheduleReq(BaseModel):
    order: list[str]
    modes: list[str] | None = None
    dwell: dict[str, int] = {}


@app.post("/api/schedule")
async def api_schedule(req: ScheduleReq):
    tt = STATE["tt"]
    if not req.order or any(s not in data.SPOTS for s in req.order) or len(set(req.order)) != len(req.order):
        raise HTTPException(400, "잘못된 스팟 순서")
    modes = req.modes
    if not modes or len(modes) != len(req.order) - 1 or any(m not in data.MODES for m in modes):
        modes = default_modes(tt, req.order)
    dwell = {k: max(0, min(600, v)) for k, v in req.dwell.items() if k in data.SPOTS}
    sched = compute_schedule(tt, req.order, modes, dwell, data.TRIP["start"])
    return {"modes": modes, **sched}


# ---------- htmx 조각 ----------

@app.get("/partials/curation", response_class=HTMLResponse)
async def partial_curation(request: Request, q: str = "", tags: str = "", hide_closed: str = ""):
    active = [t for t in tags.split(",") if t]
    ql = q.strip().lower()
    wd = TRIP_DATE.weekday()

    def closed(sp):
        return wd in sp.get("closed_dow", [])

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
        "items": [{**sp, "closed": closed(sp)} for sp in items],
        "counts": counts, "active": active, "q": q,
        "dow": DOW_KO[wd], "hidden_closed": n_closed if hide_closed else 0,
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
