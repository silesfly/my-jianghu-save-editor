# 몽강호 세이브 에디터 v1.0 (`MyJianghuSaveEditor`)

《몽강호 (My Jianghu, Steam AppID `1471180`)》의 `Save.sav` 바이너리 세이브 파일을 무손실로 읽고 편집하는 한국어 세이브 에디터입니다.

## 주요 특징

- **3-Surface 단일 코드베이스 아키텍처**
  1. **오프라인 단일 HTML 번들** (`dist/MyJianghuSaveEditor-v1.0.html`): 외부 네트워크 연결 없이 브라우저에서 바로 열어 `Save.sav` 파일을 끌어다 놓고 편집·내려받기 가능 (`CSP default-src 'none'; connect-src 'none'`).
  2. **Windows 네이티브 데스크톱 실행 파일** (`dist/MyJianghuSaveEditor-v1.0.exe`): 별도 설치 없이 Steam 설치 경로(`steamapps\common\xiake\Save.sav` 및 `SaveFile\*\Save.sav`) 자동 탐색, NTFS 심볼릭 링크·정션·하드링크·대체 데이터 스트림(ADS) 차단, 게임 실행(`DreamRivakes.exe`) 감지 시 덮어쓰기 차단, SHA-256 검증 자동 백업(`.bak`) 및 원자적 교체 지원.
  3. **무의존성 Python 3 CLI 및 로컬 루프백 서버** (`myjh_editor.py`): 외부 패키지 없이 표준 라이브러리만으로 동작하며 명령줄 일괄 편집과 `127.0.0.1` 전용 보안 웹 서버(`X-MYJH-Token` 상수 시간 검증, 슬롯별 프로세스·스레드 배타 잠금) 제공.
- **내장 한국어 도감**: 물품 `3,851`종, 무학 `920`종, 천부 `2,874`종, 등장 인물 `3,239`명의 한국어 명칭·등급·계열 정보를 내장하여 번호를 몰라도 이름 검색으로 즉시 추가·편집 가능.
- **100% 무손실 왕복 직렬화**: `0x2F8`(760바이트) 머리말과 62개 고정 순서 테이블(`T00`~`T61`)의 모든 미편집 바이트를 원본 그대로 보존하여 편집하지 않은 영역의 변조가 발생하지 않음.

## 지원 편집 항목

| 탭 / 범주 | 상세 편집 항목 |
| --- | --- |
| **빠른 설정 (4종)** | 풍족한 강호행 / 주인공 능력치 극대화 / 보유 무학 30등급 달성 / 모든 인연 호감도 100 |
| **개요·재화** | 경맥 등급, 업적 점수, 주인공 이름(UTF-8 최대 30바이트), 동전, 배낭 추가 용량, 난이도(1~25), 무학·레벨·동료·무학 수량 상한, 제조·재주조 숙련도, 계정 공용 재화 10종(은정·금정·백보서 잔엽·정철·완벽분·천공추·통영옥·하/중/상급 잔문) |
| **주인공·능력치** | 레벨(1~99), 경험치, 남은 능력치 포인트, 음식 섭취 상한, 전투 수치(최대 생명·최대 진기·방어·무학 공격), 6대 자질(역도·영교·내경·체질·정력·오성), 8대 무학 정통(권장·검법·도법·퇴법·기문·암기·의술·내공) |
| **보유 물품** | 보유 물품 검색, 수량 변경(1~999,999), 도감 검색 기반 신규 물품 추가(`T01` 최대 ID 자동 동기화) 및 삭제 |
| **무학·천부** | 보유 무학 등급(1~30)·경험치 수정, 신규 무학·천부 도감 추가(`T01` 최대 ID 자동 동기화) 및 삭제 |
| **인물 호감도** | 등장 인물별 주인공 호감도(`-100`~`100`) 개별 수정 및 전체 일괄 설정 |
| **원시 테이블** | 62개 전체 테이블(`T00`~`T61`) 레코드 조회 및 32비트 부호 없는 정수(`+0x10` 이후 오프셋) 직접 편집 |

## 사용 방법

### 1. Windows 데스크톱 앱 (`.exe`)
1. 게임을 완전히 종료합니다.
2. `MyJianghuSaveEditor-v1.0.exe`를 실행합니다.
3. 상단 슬롯 목록에서 `자동 저장 (Save.sav)` 또는 수동 슬롯을 선택해 불러옵니다(또는 `파일 열기`로 직접 선택).
4. 원하는 수치를 수정한 뒤 **슬롯 저장**을 누르면 원본 파일 옆에 `.backup-<시각>-<PID>-<난수>.bak` 백업이 생성되고 원자적으로 저장됩니다.

### 2. 오프라인 단일 HTML (`.html`)
1. `MyJianghuSaveEditor-v1.0.html`을 웹 브라우저(Chrome, Edge, Firefox, Safari)로 엽니다.
2. `xiake\Save.sav` 파일을 화면에 끌어다 놓거나 **파일 열기**로 불러옵니다(미리 둘러보려면 **예시 세이브** 클릭).
3. 편집 후 **파일 내려받기**로 저장된 `Save.sav`를 원본 위치에 덮어씁니다(덮어쓰기 전 원본 백업 권장).

### 3. Python 3 CLI 및 로컬 서버 (`myjh_editor.py`)

```bash
# 로컬 루프백 웹 에디터 서버 실행 (127.0.0.1 전용)
python3 myjh_editor.py serve

# 설치된 세이브 슬롯 자동 탐색 및 세이브 요약 조회
python3 myjh_editor.py discover
python3 myjh_editor.py info "/path/to/xiake/Save.sav"

# 명령줄에서 재화·능력치·물품 편집 (자동 백업 포함)
python3 myjh_editor.py edit "/path/to/xiake/Save.sav" \
  --coin 777777 --silver 88888 --gold 99999 \
  --set-attr maxHp 88888 --add-item 1005 50
```

## 빌드 및 검증

```bash
# 단일 파일 HTML 번들 생성 및 오프라인 무결성(CSP·외부 URL·문자셋) 검사
python3 build.py
python3 build.py --check

# 코덱·세션 단위 테스트 및 Python CLI/서버 보안 테스트
node tests/test_editor.cjs
python3 myjh_editor.py --self-test
python3 -W error -B -m unittest discover -s tests -v

# Playwright 오프라인(file://) 및 루프백 서버 E2E 검증
node tests/test_playwright_e2e.cjs
```

## 라이선스

[MIT License](LICENSE)
