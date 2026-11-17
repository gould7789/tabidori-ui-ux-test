"""데모 여행 데이터 (교토 — 추천 4곳 + 큐레이션 목록 5곳).

- 좌표는 위키백과 등 공개 좌표 기준(대표 지점). 니넨자카·산넨자카는 공식 좌표를 찾지 못해 대략 위치다.
  실제 서비스에서는 Places API의 place_id로 관리한다.
- 니시키시장 일요일 휴무는 휴무 표시를 보여주기 위한 시연용 값이다(실제 휴무일 아님).
- 청수사 마감 17:10은 위반 시나리오를 보여주기 위한 데모 값이다(실제 영업시간 아님).
- outdoor(실외형)는 비 올 때 실외 판정(하드 제약 ④)에 쓰는 값 — 실서비스는 큐레이션 때 팀이 정한다. 지금은 데모 값.
- FALLBACK_TRAVEL은 Routes API를 못 쓸 때(키 없음·호출 실패) 쓰는 고정값이다(와이어프레임 v17과 같은 값).
- LOOPA_DEMO는 임시휴무 확인(Loop A)의 시연용 결과다. 화면 흐름(⏳ → 배지 6종, 검증이 기다림, 🔴🟠 위반, 🔵 병목 해제)을
  실제 규칙대로 보여주려고 정해 둔 값이고, Claude는 부르지 않는다. 청수사 가을 야간 특별 배관(11/21~11/30)만 실제 공지 기반(9/30 실측).
"""
import datetime as dt

TRIP = {
    "title": "교토 당일치기",
    "start": "09:00",   # 설계노트 16-3: 출발 기본값 09:00
    "end": "",          # 마감 시각은 선택 — 정하면 총 소요시간 초과를 판정
}
MAX_SPOTS = 10            # 백엔드 하드 리밋(설계노트 2-1: 10~12). 권장은 6곳
RECOMMENDED_SPOTS = 6


def default_date(today: dt.date | None = None) -> dt.date:
    """기본 여행 날짜 = 다가오는 일요일(내일 이후). 16일 안이라 날씨 판정이 되고, 니시키시장 휴무 시연도 된다."""
    today = today or dt.date.today()
    d = today + dt.timedelta(days=1)
    while d.weekday() != 6:
        d += dt.timedelta(days=1)
    return d


SPOTS = {
    "gion": {
        "id": "gion", "outdoor": True, "name": "기온거리", "kind": "street", "lat": 35.00362, "lng": 135.77503,
        "source": "팀 큐레이션 DB",
        "desc": "전통 마치야 거리, 저녁 산책과 사진 명소.", "dwell": 30, "close": None,
    },
    "yasaka": {
        "id": "yasaka", "outdoor": True, "name": "야사카진자", "kind": "shrine", "lat": 35.00361, "lng": 135.77861,
        "source": "팀 큐레이션 DB",
        "desc": "기온의 상징적 신사, 야간 조명 운영.", "dwell": 20, "close": None,
    },
    "maru": {
        "id": "maru", "outdoor": True, "name": "마루야마공원", "kind": "park", "lat": 35.00333, "lng": 135.78139,
        "source": "팀 큐레이션 DB",
        "desc": "벚꽃·단풍 명소, 야사카진자 바로 옆.", "dwell": 25, "close": None,
    },
    "cheong": {
        "id": "cheong", "outdoor": True, "name": "청수사", "kind": "temple", "lat": 34.99472, "lng": 135.78500,
        "source": "Google Places (정기 영업시간)",
        "desc": "교토 대표 사찰, 무대에서 보는 시내 전망.", "dwell": 40, "close": "17:10",
    },
    # ---- 큐레이션 목록 스팟(모달에서 담기). 이동시간은 담을 때 필요한 구간만 계산한다(routes_client.ensure_pairs) ----
    "fushimi": {
        "id": "fushimi", "outdoor": True, "name": "후시미이나리타이샤", "kind": "shrine", "lat": 34.96722, "lng": 135.77278,
        "source": "팀 큐레이션 DB",
        "desc": "천 개의 붉은 도리이 — 교토 대표 명소.", "dwell": 60, "close": None,
    },
    "arashi": {
        "id": "arashi", "outdoor": True, "name": "아라시야마 대나무숲", "kind": "park", "lat": 35.0168, "lng": 135.6716,
        "source": "팀 큐레이션 DB",
        "desc": "초록빛 대나무길 산책, 인생샷 명소.", "dwell": 40, "close": None,
    },
    "kinkaku": {
        "id": "kinkaku", "outdoor": True, "name": "킨카쿠지(금각사)", "kind": "temple", "lat": 35.0395, "lng": 135.7285,
        "source": "팀 큐레이션 DB",
        "desc": "금박 누각과 연못이 어우러진 정원.", "dwell": 40, "close": None,
    },
    "nishiki": {
        "id": "nishiki", "outdoor": False, "name": "니시키시장", "kind": "street", "lat": 35.0050, "lng": 135.7640,
        "source": "팀 큐레이션 DB",
        "desc": "\"교토의 부엌\" — 먹거리 골목 도보 관광.", "dwell": 45, "close": None,
        "closed_dow": [6],   # Python weekday(월=0). 일요일 휴무 — 시연용 값
    },
    "ninen": {
        "id": "ninen", "outdoor": True, "name": "니넨자카·산넨자카", "kind": "street", "lat": 34.9980, "lng": 135.7808,
        "source": "팀 큐레이션 DB",
        "desc": "청수사 아래쪽 전통 돌계단 거리, 찻집·기념품점 밀집.", "dwell": 30, "close": None,
    },
}

MODES = ["walk", "bike", "transit", "car"]
MODE_LABEL = {"walk": "도보", "bike": "자전거", "transit": "전철", "car": "렌터카"}
MODE_ICON = {"walk": "🚶", "bike": "🚲", "transit": "🚇", "car": "🚗"}

# 분 단위. 키는 정렬된 "a|b". 여기 없는 구간은 직선거리로 추정한다(routes_client.estimate_travel)
FALLBACK_TRAVEL = {
    "gion|yasaka": {"walk": 5, "transit": 9, "car": 6, "bike": 6},
    "gion|maru": {"walk": 8, "transit": 12, "car": 7, "bike": 8},
    "cheong|gion": {"walk": 20, "transit": 24, "car": 10, "bike": 12},
    "maru|yasaka": {"walk": 3, "transit": 6, "car": 5, "bike": 3},
    "cheong|yasaka": {"walk": 17, "transit": 21, "car": 9, "bike": 10},
    "cheong|maru": {"walk": 18, "transit": 22, "car": 9, "bike": 10},
}

# 입력화면 예시 대화의 "추천 4곳 한 번에 담기"가 쓰는 순서(데모). 다른 순서 패턴(A·B)은 /api/verify가 직접 계산한다.
INITIAL_ORDER = ["gion", "yasaka", "maru", "cheong"]

# 큐레이션 모달 후보 (사진: Wikimedia Commons). 니시키시장 일요일 휴무는 시연용 임의값.
CURATION = [
    {"id": "fushimi", "name": "후시미이나리타이샤", "tags": ["전통", "사진"], "meta": "천 개의 붉은 도리이 — 교토 대표 명소",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Fushimi_Inari-taisha_senbon-torii,_August_2019.jpg?width=400"},
    {"id": "arashi", "name": "아라시야마 대나무숲", "tags": ["자연", "사진"], "meta": "초록빛 대나무길 산책, 인생샷 명소",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Bamboo_Grove,_Arashiyama,_Kyoto,_Japan.jpg?width=400"},
    {"id": "kinkaku", "name": "킨카쿠지(금각사)", "tags": ["전통", "사진"], "meta": "금박 누각과 연못이 어우러진 정원",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Kinkaku-ji_(Golden_Pavillon).jpg?width=400"},
    {"id": "nishiki", "name": "니시키시장", "tags": ["전통", "사진"], "meta": "\"교토의 부엌\" — 먹거리 골목 도보 관광", "closed_dow": [6],
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Nishiki_ichiba_kyoto.jpg?width=400"},
    {"id": "ninen", "name": "니넨자카·산넨자카", "tags": ["전통", "사진"], "meta": "청수사 근처 전통 돌계단 거리, 찻집·기념품점 밀집",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Ninenzaka-kyoto.JPG?width=400"},
]
FOOD_SUGGEST = ["라멘", "말차 디저트", "오코노미야키", "이자카야"]

EXAMPLE_PROMPTS = [
    {"label": "저녁 추천", "user": "저녁 먹을 곳 추천해줘",
     "advisor": "식당 추천은 아직 이 화면에 연결되지 않았어요 <i>(시연 응답)</i>. 연결되면 큐레이션 목록과 Google 장소 검색으로 <b>실제로 있는 곳만</b> 후보 카드로 보여드리고, 제 지식으로 고른 곳에는 'AI 추천' 표시를 붙여요. 지금은 아래 <b>\"+\"</b> 버튼으로 직접 추가해 보세요."},
    {"label": "패턴 B 특징", "user": "패턴 B는 뭐가 다른거야?",
     "advisor": "패턴 A·B는 담은 스팟으로 만들 수 있는 순서 중 <b>위반이 없는 순서</b>를 이동시간이 짧은 순으로 고른 거예요. 휴무처럼 순서로 안 풀리는 문제가 있으면 그 스팟을 뺀 순서예요. 위쪽 패턴 탭에서 눌러보면 이동시간과 종료 시각을 바로 비교할 수 있어요."},
    {"label": "비 오면?", "user": "비 오면 어떻게 돼?",
     "advisor": "비 판정은 <b>검증하기</b>에서 해요. 여행 날짜가 16일 안이면 방문 시간대 강수확률이 70% 이상인 실외 스팟을 위반(☔)으로 표시하고, 그보다 먼 날짜는 판정하지 않아요. 실내 대안을 찾아 바꾸는 대화는 에이전트 연결 후 동작해요 <i>(시연 응답)</i>."},
]

# ---------- 임시휴무 확인(Loop A) 시연용 결과 ----------
# 배지는 코드가 고정 매핑(개발노트 8-2): 판정 종류 × 확인 경로
BADGES = {
    "red":    {"emoji": "🔴", "label": "휴관", "short": "휴관"},
    "orange": {"emoji": "🟠", "label": "일부 휴관", "short": "일부 휴관"},
    "blue":   {"emoji": "🔵", "label": "특별 개관·연장", "short": "특별 개관"},
    "green":  {"emoji": "🟢", "label": "공식 공지 확인 · 변동 없음", "short": "변동 없음"},
    "amber":  {"emoji": "🟡", "label": "예외 공지 없음 (검색 기준)", "short": "예외 없음(검색)"},
    "gray":   {"emoji": "⚪", "label": "확인 불가", "short": "확인 불가"},
}


def badge_of(kind: str, path: str) -> str:
    if kind == "closed":
        return "red"
    if kind == "partial":
        return "orange"
    if kind == "special":
        return "blue"
    if kind == "none":
        return "green" if path == "official" else "amber"
    return "gray"


def loopa_demo(sid: str, date: dt.date) -> dict:
    """정해 둔 시연용 판정. kind: closed / partial / special / none / unknown, path: official / search."""
    wd = date.weekday()
    r = {"kind": "none", "path": "official", "quote": "", "url": "", "note": "시연용 결과"}
    if sid == "cheong" and dt.date(2026, 11, 21) <= date <= dt.date(2026, 11, 30):
        r.update(kind="special", quote="秋の夜間特別拝観 11月21日〜11月30日（21:30受付終了）",
                 url="https://www.kiyomizudera.or.jp/", close_override="21:30",
                 note="실제 공지 기반(9/30 실측) — 시각은 확인 필요")
    elif sid == "kinkaku" and wd == 3:
        r.update(kind="closed", quote="(시연용 가정) 本日は臨時休業いたします", note="시연용 가정 — 목요일")
    elif sid == "arashi" and wd == 2:
        r.update(kind="partial", quote="(시연용 가정) 竹林の小径 一部区間 通行止め", note="시연용 가정 — 수요일")
    elif sid in ("fushimi", "yasaka"):
        r.update(path="search")
    elif sid == "nishiki":
        r.update(kind="unknown", path="search")
    r["badge"] = badge_of(r["kind"], r["path"])
    return r
