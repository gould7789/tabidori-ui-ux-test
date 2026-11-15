"""데모 여행 데이터 (교토 당일치기 4곳).

- 좌표는 위키백과 등 공개 좌표 기준(대표 지점). 실제 서비스에서는 Places API의 place_id로 관리한다.
- 청수사 마감 17:10은 위반 시나리오를 보여주기 위한 데모 값이다(실제 영업시간 아님).
- FALLBACK_TRAVEL은 Routes API를 못 쓸 때(키 없음·호출 실패) 쓰는 고정값이다(와이어프레임 v17과 같은 값).
"""

TRIP = {
    "title": "교토 당일치기",
    "date": "2026-09-20",  # 일요일, 검증 후 잠긴 날짜
    "start": "16:00",
}

SPOTS = {
    "gion": {
        "id": "gion", "name": "기온거리", "lat": 35.00362, "lng": 135.77503,
        "badge": "green", "badge_short": "🟢 큐레이션 DB 확인됨",
        "badge_source": "출처: 팀 큐레이션 DB",
        "desc": "전통 마치야 거리, 저녁 산책과 사진 명소.", "dwell": 30, "close": None,
    },
    "yasaka": {
        "id": "yasaka", "name": "야사카진자", "lat": 35.00361, "lng": 135.77861,
        "badge": "green", "badge_short": "🟢 큐레이션 DB 확인됨",
        "badge_source": "출처: 팀 큐레이션 DB",
        "desc": "기온의 상징적 신사, 야간 조명 운영.", "dwell": 20, "close": None,
    },
    "maru": {
        "id": "maru", "name": "마루야마공원", "lat": 35.00333, "lng": 135.78139,
        "badge": "green", "badge_short": "🟢 큐레이션 DB 확인됨",
        "badge_source": "출처: 팀 큐레이션 DB",
        "desc": "벚꽃·단풍 명소, 야사카진자 바로 옆.", "dwell": 25, "close": None,
    },
    "cheong": {
        "id": "cheong", "name": "청수사", "lat": 34.99472, "lng": 135.78500,
        "badge": "amber", "badge_short": "🟡 정기정보만 확인됨",
        "badge_source": "출처: Google Places API(구조화 데이터) · 정기 영업시간만 확인, 임시휴관 미확인",
        "desc": "교토 대표 사찰, 무대에서 보는 시내 전망.", "dwell": 40, "close": "17:10",
    },
}

MODES = ["walk", "bike", "transit", "car"]
MODE_LABEL = {"walk": "도보", "bike": "자전거", "transit": "전철", "car": "렌터카"}
MODE_ICON = {"walk": "🚶", "bike": "🚲", "transit": "🚇", "car": "🚗"}

# 분 단위. 키는 정렬된 "a|b"
FALLBACK_TRAVEL = {
    "gion|yasaka": {"walk": 5, "transit": 9, "car": 6, "bike": 6},
    "gion|maru": {"walk": 8, "transit": 12, "car": 7, "bike": 8},
    "cheong|gion": {"walk": 20, "transit": 24, "car": 10, "bike": 12},
    "maru|yasaka": {"walk": 3, "transit": 6, "car": 5, "bike": 3},
    "cheong|yasaka": {"walk": 17, "transit": 21, "car": 9, "bike": 10},
    "cheong|maru": {"walk": 18, "transit": 22, "car": 9, "bike": 10},
}

INITIAL_ORDER = ["gion", "yasaka", "maru", "cheong"]
ALT_PATTERNS = {
    "A": {"label": "패턴 A", "order": ["cheong", "maru", "yasaka", "gion"]},
    "B": {"label": "패턴 B", "order": ["cheong", "yasaka", "maru", "gion"]},
}

# 큐레이션 모달 후보 (사진: Wikimedia Commons). 니시키시장 일요일 휴무는 시연용 임의값.
CURATION = [
    {"name": "후시미이나리타이샤", "tags": ["전통", "사진"], "meta": "천 개의 붉은 도리이 — 교토 대표 명소",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Fushimi_Inari-taisha_senbon-torii,_August_2019.jpg?width=400"},
    {"name": "아라시야마 대나무숲", "tags": ["자연", "사진"], "meta": "초록빛 대나무길 산책, 인생샷 명소",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Bamboo_Grove,_Arashiyama,_Kyoto,_Japan.jpg?width=400"},
    {"name": "킨카쿠지(금각사)", "tags": ["전통", "사진"], "meta": "금박 누각과 연못이 어우러진 정원",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Kinkaku-ji_(Golden_Pavillon).jpg?width=400"},
    {"name": "니시키시장", "tags": ["전통", "사진"], "meta": "\"교토의 부엌\" — 먹거리 골목 도보 관광", "closed_dow": [6],
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Nishiki_ichiba_kyoto.jpg?width=400"},
    {"name": "니넨자카·산넨자카", "tags": ["전통", "사진"], "meta": "청수사 근처 전통 돌계단 거리, 찻집·기념품점 밀집",
     "img": "https://commons.wikimedia.org/wiki/Special:FilePath/Ninenzaka-kyoto.JPG?width=400"},
]
FOOD_SUGGEST = ["라멘", "말차 디저트", "오코노미야키", "이자카야"]

EXAMPLE_PROMPTS = [
    {"label": "저녁 추천", "user": "저녁 먹을 곳 추천해줘",
     "advisor": "기온 골목 두부요리집이나 야사카진자 옆 오반자이 식당이 평이 좋아요. 다만 지금 일정엔 저녁 식사 슬롯이 따로 없어서, 추가해드릴까요? 아래 <b>\"+\"</b> 버튼으로 스팟을 추가하면 이동시간까지 다시 계산해드려요."},
    {"label": "패턴 B 특징", "user": "패턴 B는 뭐가 다른거야?",
     "advisor": "패턴 B는 <b>청수사→야사카→마루야마→기온</b> 순서예요. 위쪽 패턴 탭에서 눌러보면 이동시간과 종료 시각을 바로 비교할 수 있어요."},
    {"label": "비 오면?", "user": "오늘 비 온대, 실내 위주로 바꿔줘",
     "advisor": "지금 일정엔 실외 스팟(마루야마공원)이 하나 있어요. 날씨 연동(Open-Meteo)은 아직 이 화면에 연결되지 않았어요 — 연결되면 강수 시 실외 스팟을 제약 위반으로 표시하고 실내 대안을 먼저 제안하게 돼요."},
]
