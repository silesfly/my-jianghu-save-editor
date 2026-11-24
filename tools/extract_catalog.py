#!/usr/bin/env python3
"""Extract My Jianghu (몽강호) catalog data from REA Lua tables.

Outputs: src/catalog-data.js
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

REA_DIR = Path(
    os.environ.get(
        "MYJH_REA_DIR",
        "/home/jiyoung/workspace/무협위키/.local/graph/my-jianghu-data",
    )
)

KO_PATCH = Path(
    os.environ.get(
        "MYJH_KO_PATCH_DIR",
        str(REA_DIR / "ko_patch_v1_0" / "DreamRivakes_Data" / "StreamingAssets" / "LuaProject"),
    )
)
VANILLA = REA_DIR / "vanilla_lua"

KO_LANG_DIR = KO_PATCH / "data" / "language"
_ITEM_UPPER = KO_PATCH / "data" / "Item.lua.txt"
_ITEM_LOWER = KO_PATCH / "data" / "item.lua.txt"
ITEM_FILE = _ITEM_UPPER if _ITEM_UPPER.exists() else _ITEM_LOWER
MARTIAL_FILE = VANILLA / "Martial.lua"
GIFT_FILE = VANILLA / "Gift.lua"
ROLE_FILE = VANILLA / "Role.lua"

OUT_FILE = ROOT / "src" / "catalog-data.js"


# ---------------------------------------------------------------------------
# Hygiene rules
# ---------------------------------------------------------------------------

CJK_RE = re.compile(
    r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    r"\uff65-\uff9f\U00020000-\U0003134f]"
)
HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")
URL_RE = re.compile(r"https?://")

MARKUP_PATTERNS = [
    re.compile(r"<color=[^>]*>"),
    re.compile(r"<size=[^>]*>"),
    re.compile(r"</color>"),
    re.compile(r"</size>"),
    re.compile(r"<b>"),
    re.compile(r"</b>"),
    re.compile(r"<i>"),
    re.compile(r"</i>"),
    re.compile(r"<u>"),
    re.compile(r"</u>"),
]

DUMMY_NAMES = {"test", "dummy", "테스트", "더미", "폐기"}


def clean_name(name) -> str | None:
    if name is None:
        return None
    s = str(name)
    if not s:
        return None
    # Strip Lua template placeholders (e.g. {发布角色(Language)[Role.NameID]}) before CJK check.
    s = re.sub(r"\{[^}]*\}", "", s)
    for pat in MARKUP_PATTERNS:
        s = pat.sub("", s)
    s = CJK_RE.sub("", s)
    s = s.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return None
    if not HANGUL_RE.search(s):
        return None
    low = s.lower()
    if low in DUMMY_NAMES:
        return None
    return s


# ---------------------------------------------------------------------------
# Lua helpers
# ---------------------------------------------------------------------------


def unescape_lua_string(s: str) -> str:
    """Unescape a Lua string body WITHOUT using ``unicode_escape``.

    Preserves UTF-8 (Hangul etc.) intact, and maps common whitespace escapes
    to a space as required by the spec.
    """

    out: list[str] = []
    i = 0
    n = len(s)
    while i < n:
        c = s[i]
        if c == "\\" and i + 1 < n:
            nxt = s[i + 1]
            if nxt == "n":
                out.append(" ")
            elif nxt == "r":
                out.append(" ")
            elif nxt == "t":
                out.append(" ")
            elif nxt == '"':
                out.append('"')
            elif nxt == "'":
                out.append("'")
            elif nxt == "\\":
                out.append("\\")
            elif nxt == "0":
                out.append("")
            else:
                out.append(nxt)
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _skip_string(text: str, i: int, quote: str) -> int:
    """Return the index just past the closing quote of a Lua string."""

    n = len(text)
    i += 1
    while i < n:
        c = text[i]
        if c == "\\":
            i += 2
            continue
        if c == quote:
            return i + 1
        i += 1
    return n


def find_balanced_brace(text: str, open_idx: int) -> int:
    """Return index just past the matching '}' for the '{' at ``open_idx``."""

    depth = 0
    i = open_idx
    n = len(text)
    while i < n:
        c = text[i]
        if c == '"' or c == "'":
            i = _skip_string(text, i, c)
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    return n


def locate_table(text: str, name: str) -> str | None:
    """Locate ``name = { ... }`` (optionally prefixed by ``local``)."""

    patterns = [
        re.compile(rf"local\s+{re.escape(name)}\s*=\s*\{{"),
        re.compile(rf"(?<![\w.]){re.escape(name)}\s*=\s*\{{"),
    ]
    for pat in patterns:
        m = pat.search(text)
        if m:
            open_idx = m.end() - 1
            end_idx = find_balanced_brace(text, open_idx)
            return text[open_idx:end_idx]
    return None


NUM_KEY_ENTRY_RE = re.compile(r"\[\s*(\d+)\s*\]\s*=\s*\{")


def iter_entries(table_text: str):
    """Yield ``(base_id, body_text)`` for every ``[BaseID] = { ... }`` entry."""

    n = len(table_text)
    pos = 0
    while pos < n:
        m = NUM_KEY_ENTRY_RE.search(table_text, pos)
        if not m:
            break
        base_id = int(m.group(1))
        open_idx = m.end() - 1
        end_idx = find_balanced_brace(table_text, open_idx)
        body = table_text[open_idx:end_idx]
        yield base_id, body
        pos = end_idx


FIELD_VALUE_RE = re.compile(
    r'(?<![\w.]){field}\s*=\s*("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|[A-Za-z_][\w.]*)'
)


def parse_field(body: str, field: str):
    pat = re.compile(FIELD_VALUE_RE.pattern.format(field=re.escape(field)))
    m = pat.search(body)
    if not m:
        return None
    raw = m.group(1)
    if raw.startswith('"'):
        return unescape_lua_string(raw[1:-1])
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+(?:\.\d+)?", raw):
        return float(raw)
    return raw


# ---------------------------------------------------------------------------
# Korean language map
# ---------------------------------------------------------------------------

LANG_LINE_RE = re.compile(
    r'^\s*\[(\d+)\]\s*=\s*"((?:[^"\\]|\\.)*)"', re.MULTILINE
)


def load_ko_lang() -> dict[int, str]:
    lang: dict[int, str] = {}
    if not KO_LANG_DIR.exists():
        print(f"[warn] ko language dir missing: {KO_LANG_DIR}", file=sys.stderr)
        return lang

    files = sorted(KO_LANG_DIR.rglob("*.lua.txt"))
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            text = path.read_text(encoding="utf-8", errors="replace")
        for m in LANG_LINE_RE.finditer(text):
            key = int(m.group(1))
            value = unescape_lua_string(m.group(2))
            lang[key] = value
    return lang


# ---------------------------------------------------------------------------
# Enum mappers (strict Korean only)
# ---------------------------------------------------------------------------


def enum_suffix(value) -> str:
    if not value:
        return ""
    s = str(value)
    for prefix in ("RankType.", "ItemTypeDetail.", "ItemType.", "DepartEnumType."):
        if s.startswith(prefix):
            s = s[len(prefix):]
    return s


RANK_MAP = {
    "RT_White": "백색",
    "RT_Green": "녹색",
    "RT_Blue": "청색",
    "RT_Purple": "자색",
    "RT_Orange": "주황",
    "RT_Golden": "금색",
    "RT_Gold": "금색",
    "RT_DarkGolden": "암금",
    "RT_ThirdGearDarkGolden": "암금",
    "RT_SecondGearDarkGolden": "암금",
    "RT_FirstGearDarkGolden": "암금",
}


def map_rank(value) -> str:
    suffix = enum_suffix(value)
    return RANK_MAP.get(suffix, "백색")


ITEM_TYPE_RULES: list[tuple[tuple[str, ...], str]] = [
    (("IncompleteBook",), "잔장"),
    (("HeavenBook",), "천서"),
    (("SecretBook", "MartialBook", "Book"), "비급"),
    (("TreasureMap",), "보물지도"),
    (("Material", "Ore", "Herb", "Wood", "ClothMat", "Forge"), "재료"),
    (("Pill", "Medicinal"), "단약"),
    (("HiddenWeapon",), "암기"),
    (("Leechcraft",), "의술"),
    (("Formula",), "제조법"),
    (("Copper", "Gold", "Silve", "Money"), "화폐"),
    (("RolePieces",), "캐릭터 카드"),
    (("PetPieces",), "영물 카드"),
    (
        (
            "Weapon",
            "Sword",
            "Knife",
            "Blade",
            "Fist",
            "Leg",
            "Rod",
            "Needle",
            "Fan",
            "Whip",
            "Cane",
        ),
        "무기",
    ),
    (("Armor", "Cloth", "Clothes", "Hat", "Shoe", "Shoes", "Wing", "Mounts"), "방어구"),
    (
        ("Ornament", "Jewelry", "Ring", "Necklace", "Pendant"),
        "장신구",
    ),
    (("Dish",), "요리"),
    (("Food", "Wine", "Drink", "Tea"), "식량"),
    (("Task", "Quest"), "임무"),
    (("Goods",), "상품"),
    (("Box", "Gift", "Pack", "Treasure"), "보물상자"),
]


def map_item_type(value) -> str:
    suffix = enum_suffix(value)
    if not suffix:
        return "기타"
    low = suffix.lower()
    for keys, label in ITEM_TYPE_RULES:
        for k in keys:
            if k.lower() in low:
                return label
    return "기타"


DEPART_MAP = {
    "DET_Boxing": "권장",
    "DET_SwordMethod": "검법",
    "DET_BladeMethod": "도법",
    "DET_Knife": "도법",
    "DET_LegMethod": "퇴법",
    "DET_QiMen": "기문",
    "DET_HiddenWeapon": "암기",
    "DET_MedicalSkill": "의술",
    "DET_Medical": "의술",
    "DET_Soul": "내공",
    "DET_NeiGong": "내공",
    "DET_Inner": "내공",
}


def map_depart(value) -> str:
    suffix = enum_suffix(value)
    return DEPART_MAP.get(suffix, "내공")


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------


def load_items(ko_lang: dict[int, str]) -> list[dict]:
    if not ITEM_FILE.exists():
        print(f"[warn] item file missing: {ITEM_FILE}", file=sys.stderr)
        return []

    text = ITEM_FILE.read_text(encoding="utf-8", errors="replace")

    default_rank = "RT_White"
    default_max = 999
    default_limit = 9900
    default_body = locate_table(text, "ItemDefault")
    if default_body:
        raw_rank = parse_field(default_body, "Rank")
        if raw_rank:
            default_rank = str(raw_rank)
        raw_max = parse_field(default_body, "MaxNum")
        if isinstance(raw_max, int) and raw_max > 0:
            default_max = raw_max
        raw_limit = parse_field(default_body, "LimitNum")
        if isinstance(raw_limit, int) and raw_limit > 0:
            default_limit = raw_limit

    item_table = locate_table(text, "Item")
    if not item_table:
        print("[warn] Item table not found", file=sys.stderr)
        return []

    results: list[dict] = []
    seen_ids: set[int] = set()

    for base_id, body in iter_entries(item_table):
        name = parse_field(body, "ItemName")
        name_id = parse_field(body, "NameID")

        cleaned = clean_name(name)
        if cleaned is None and isinstance(name_id, int):
            alt = ko_lang.get(name_id)
            cleaned = clean_name(alt)
        if cleaned is None:
            continue

        rank_raw = parse_field(body, "Rank")
        if not rank_raw:
            rank_raw = default_rank
        item_type_raw = parse_field(body, "ItemType")
        max_num = parse_field(body, "MaxNum")
        if not isinstance(max_num, int) or max_num <= 0:
            max_num = default_max
        limit_num = parse_field(body, "LimitNum")
        if not isinstance(limit_num, int) or limit_num <= 0:
            limit_num = default_limit

        record = {
            "id": int(base_id),
            "name": cleaned,
            "rank": map_rank(rank_raw),
            "type": map_item_type(item_type_raw),
            "maxNum": int(max_num),
            "limitNum": int(limit_num),
        }
        if record["id"] in seen_ids:
            continue
        seen_ids.add(record["id"])
        results.append(record)

    results.sort(key=lambda r: r["id"])
    return results


# ---------------------------------------------------------------------------
# Martials
# ---------------------------------------------------------------------------


def load_martials(ko_lang: dict[int, str]) -> list[dict]:
    if not MARTIAL_FILE.exists():
        print(f"[warn] martial file missing: {MARTIAL_FILE}", file=sys.stderr)
        return []

    text = MARTIAL_FILE.read_text(encoding="utf-8", errors="replace")

    default_rank = "RT_White"
    default_depart = "DepartEnumType.DET_NeiGong"
    default_body = locate_table(text, "MartialDefault")
    if default_body:
        raw_rank = parse_field(default_body, "Rank")
        if raw_rank:
            default_rank = str(raw_rank)
        raw_depart = parse_field(default_body, "DepartEnum")
        if raw_depart:
            default_depart = str(raw_depart)

    martial_table = locate_table(text, "Martial")
    if not martial_table:
        print("[warn] Martial table not found", file=sys.stderr)
        return []

    results: list[dict] = []
    seen_ids: set[int] = set()

    for base_id, body in iter_entries(martial_table):
        name_id = parse_field(body, "NameID")
        name = None
        if isinstance(name_id, int):
            name = ko_lang.get(name_id)
        cleaned = clean_name(name)
        if cleaned is None:
            cleaned = clean_name(parse_field(body, "Name"))
        if cleaned is None:
            continue

        rank_raw = parse_field(body, "Rank") or default_rank
        depart_raw = parse_field(body, "DepartEnum") or default_depart

        record = {
            "id": int(base_id),
            "name": cleaned,
            "rank": map_rank(rank_raw),
            "depart": map_depart(depart_raw),
        }
        if record["id"] in seen_ids:
            continue
        seen_ids.add(record["id"])
        results.append(record)

    results.sort(key=lambda r: r["id"])
    return results


# ---------------------------------------------------------------------------
# Gifts
# ---------------------------------------------------------------------------


def load_gifts(ko_lang: dict[int, str]) -> list[dict]:
    if not GIFT_FILE.exists():
        print(f"[warn] gift file missing: {GIFT_FILE}", file=sys.stderr)
        return []

    text = GIFT_FILE.read_text(encoding="utf-8", errors="replace")

    default_rank = "RT_White"
    default_body = locate_table(text, "GiftDefault")
    if default_body:
        raw_rank = parse_field(default_body, "Rank")
        if raw_rank:
            default_rank = str(raw_rank)

    gift_table = locate_table(text, "Gift")
    if not gift_table:
        print("[warn] Gift table not found", file=sys.stderr)
        return []

    results: list[dict] = []
    seen_ids: set[int] = set()

    for base_id, body in iter_entries(gift_table):
        name_id = parse_field(body, "NameID")
        name = None
        if isinstance(name_id, int):
            name = ko_lang.get(name_id)
        cleaned = clean_name(name)
        if cleaned is None:
            cleaned = clean_name(parse_field(body, "Name"))
        if cleaned is None:
            continue

        rank_raw = parse_field(body, "Rank") or default_rank
        record = {
            "id": int(base_id),
            "name": cleaned,
            "rank": map_rank(rank_raw),
        }
        if record["id"] in seen_ids:
            continue
        seen_ids.add(record["id"])
        results.append(record)

    results.sort(key=lambda r: r["id"])
    return results


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


def load_roles(ko_lang: dict[int, str]) -> dict[str, str]:
    if not ROLE_FILE.exists():
        print(f"[warn] role file missing: {ROLE_FILE}", file=sys.stderr)
        return {}

    text = ROLE_FILE.read_text(encoding="utf-8", errors="replace")

    default_role_id = 1020101001
    default_body = locate_table(text, "RoleDefault")
    if default_body:
        raw_rid = parse_field(default_body, "RoleID")
        if isinstance(raw_rid, int):
            default_role_id = raw_rid

    role_table = locate_table(text, "Role")
    if not role_table:
        print("[warn] Role table not found", file=sys.stderr)
        return {}

    roles: dict[str, str] = {}

    for base_id, body in iter_entries(role_table):
        name_id = parse_field(body, "NameID")
        cleaned = None
        if isinstance(name_id, int):
            cleaned = clean_name(ko_lang.get(name_id))
        if cleaned is None:
            surname_id = parse_field(body, "SurnameID")
            given_id = parse_field(body, "GivennameID")
            surname = ko_lang.get(surname_id) if isinstance(surname_id, int) else ""
            given = ko_lang.get(given_id) if isinstance(given_id, int) else ""
            if surname or given:
                cleaned = clean_name(f"{surname or ''}{given or ''}".strip())
        if cleaned is None:
            cleaned = clean_name(parse_field(body, "Name"))
        if cleaned is None:
            continue

        role_id = parse_field(body, "RoleID")
        if not isinstance(role_id, int):
            role_id = default_role_id
        roles.setdefault(str(role_id), cleaned)
        roles.setdefault(str(base_id), cleaned)

    return roles


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def build_js(data: dict) -> str:
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if URL_RE.search(payload):
        raise RuntimeError("Generated payload contains an http(s) URL")

    return (
        "(function(root,factory){"
        'if(typeof module==="object"&&module.exports){module.exports=factory();}'
        "else{root.MYJH_CATALOG=factory();}"
        '})(typeof self!=="undefined"?self:this,function(){'
        f"return {payload};"
        "});\n"
    )


def main() -> int:
    if not REA_DIR.exists():
        print(f"[error] REA_DIR does not exist: {REA_DIR}", file=sys.stderr)
        return 1

    ko_lang = load_ko_lang()
    print(f"[info] ko_lang entries: {len(ko_lang)}")

    items = load_items(ko_lang)
    martials = load_martials(ko_lang)
    gifts = load_gifts(ko_lang)
    roles = load_roles(ko_lang)

    data = {
        "meta": {
            "gameVersion": "v1.3.4",
            "steamBuildId": "26893004",
            "krPatch": "v1.0",
        },
        "items": items,
        "martials": martials,
        "gifts": gifts,
        "roles": roles,
    }

    js = build_js(data)

    if CJK_RE.search(js):
        bad = CJK_RE.search(js)
        raise RuntimeError(
            f"Generated JS contains forbidden CJK/Kana codepoint near: {bad.group(0)!r}"
        )
    if "http://" in js or "https://" in js:
        raise RuntimeError("Generated JS contains an http(s) URL literal")

    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(js, encoding="utf-8")

    print(f"[ok] items={len(items)} martials={len(martials)} gifts={len(gifts)} roles={len(roles)}")
    print(f"[ok] wrote {OUT_FILE} ({OUT_FILE.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
