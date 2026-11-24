#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""몽강호 세이브 에디터 v1.1.1 — Python CLI 및 로컬 루프백 서버 (표준 라이브러리 전용)."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import http.server
import json
import os
import secrets
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler
from pathlib import Path

HEADER_SIZE = 0x2F8
TABLE_COUNT = 62
MAX_RECORDS = 500_000

TABLE_SIZES = [
    0x2280, 0x18, 0x20, 0x20, 0x20, 0x18, 0x38, 0x28, 0x80, 0x18, 0x20, 0x20,
    0x68, 0x350, 0x20, 0x20, 0x48, 0x18, 0x18, 0x28, 0x48, 0x260, 0x120, 0x28,
    0x60, 0x38, 0x270, 0x30, 0x38, 0x28, 0x40, 0x20, 0x28, 0x20, 0x20, 0x168,
    0x88, 0x138, 0x38, 0x48, 0x30, 0x28, 0x28, 0x20, 0x20, 0x18, 0x28, 0x20,
    0x20, 0x20, 0x20, 0x2A0, 0x180, 0xB8, 0x30, 0x30, 0x28, 0x60, 0x30, 0xB8,
    0x320, 0x28,
]

T00, T01, T21, T23, T25, T28, T31, T61 = 0, 1, 21, 23, 25, 28, 31, 61
ITEM_OBJ_TYPE, MARTIAL_OBJ_TYPE, GIFT_OBJ_TYPE = 7, 8, 10
DEFAULT_NPC_TARGET = 1000001260
MIN_SAV = HEADER_SIZE + TABLE_COUNT * 4
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400

ATTR_KEYS = {
    "maxHp": 0, "maxMp": 1, "defence": 2,
    "lidao": 3, "lingqiao": 4, "neijin": 5, "tizhi": 6, "jingli": 7, "wuxing": 8,
    "martialAtk": 11,
    "quanzhang": 12, "jianfa": 13, "daofa": 14, "tuifa": 15, "qimen": 16,
    "anqi": 17, "yishu": 18, "neigong": 19,
}

CURRENCY_KEYS = {
    "silver": 2, "gold": 3, "treasurePage": 4, "lowIncomplete": 33,
    "midIncomplete": 34, "highIncomplete": 35, "heavenHammer": 37,
    "refinedIron": 38, "perfectPowder": 39, "tonglingyu": 73,
}

PRESET_IDS = ["rich_resources", "max_role_stats", "all_martials_lv30", "all_npcs_100"]


class MyjhError(Exception):
    """기본 에디터 예외."""


class ValidationError(MyjhError):
    """세이브 구조 또는 값 범위 오류."""


class UnsafePathError(MyjhError):
    """심볼릭 링크·재분석 지점·비허용 경로 오류."""


class GameRunningError(MyjhError):
    """게임 프로세스 실행 중 쓰기 차단 오류."""


class ShaMismatchError(MyjhError):
    """디스크 파일 SHA-256 불일치 오류."""


def _u8(b: bytes | bytearray | memoryview, o: int) -> int:
    return b[o]


def _u16(b: bytes | bytearray | memoryview, o: int) -> int:
    return struct.unpack_from("<H", b, o)[0]


def _u32(b: bytes | bytearray | memoryview, o: int) -> int:
    return struct.unpack_from("<I", b, o)[0]


def _i32(b: bytes | bytearray | memoryview, o: int) -> int:
    return struct.unpack_from("<i", b, o)[0]


def _put_u8(b: bytearray | memoryview, o: int, v: int) -> None:
    b[o] = v & 0xFF


def _put_u16(b: bytearray | memoryview, o: int, v: int) -> None:
    struct.pack_into("<H", b, o, v & 0xFFFF)


def _put_u32(b: bytearray | memoryview, o: int, v: int) -> None:
    struct.pack_into("<I", b, o, v & 0xFFFFFFFF)


def _put_fixed_str(buf: bytearray | memoryview, offset: int, length: int, text: str, encoding: str = "utf-8", max_bytes: int | None = None) -> None:
    raw = text.encode(encoding)
    limit = length - 1 if max_bytes is None else min(length - 1, max_bytes)
    if len(raw) > limit:
        raise ValidationError(f"문자열 길이가 최대 {limit}바이트를 초과합니다.")
    for i in range(length):
        buf[offset + i] = 0
    buf[offset:offset + len(raw)] = raw


def _read_fixed_str(buf: bytes | bytearray | memoryview, offset: int, length: int, encoding: str = "utf-8") -> str:
    raw = bytes(buf[offset:offset + length]).split(b"\0", 1)[0]
    return raw.decode(encoding, "replace")


class SaveDoc:
    """Save.sav 무손실 메모리 모델."""

    def __init__(self, header: bytes | bytearray, tables: list[list[bytearray]]) -> None:
        self.header = bytearray(header)
        self.tables = [[bytearray(r) for r in rows] for rows in tables]

    @classmethod
    def parse(cls, data: bytes | bytearray | memoryview) -> "SaveDoc":
        if not isinstance(data, (bytes, bytearray, memoryview)):
            raise ValidationError("세이브 데이터는 바이트 형식이어야 합니다.")
        raw = bytes(data)
        if len(raw) < MIN_SAV:
            raise ValidationError(f"파일 크기가 최소 길이({MIN_SAV}바이트)보다 작습니다.")
        header = raw[:HEADER_SIZE]
        off = HEADER_SIZE
        tables: list[list[bytearray]] = []
        for i in range(TABLE_COUNT):
            if off + 4 > len(raw):
                raise ValidationError(f"테이블 T{i:02d} 레코드 개수 영역이 잘렸습니다.")
            count = _u32(raw, off)
            off += 4
            if count > MAX_RECORDS:
                raise ValidationError(f"테이블 T{i:02d} 레코드 개수({count})가 허용 상한을 초과합니다.")
            sz = TABLE_SIZES[i]
            total = count * sz
            if off + total > len(raw):
                raise ValidationError(f"테이블 T{i:02d} 본문 영역이 잘렸습니다.")
            rows = [bytearray(raw[off + r * sz: off + (r + 1) * sz]) for r in range(count)]
            tables.append(rows)
            off += total
        if off != len(raw):
            raise ValidationError(f"파일 끝 오프셋이 일치하지 않습니다 (예상 {off}, 실제 {len(raw)}).")
        return cls(header, tables)

    def serialize(self) -> bytes:
        self.validate()
        parts = [bytes(self.header)]
        for i in range(TABLE_COUNT):
            rows = self.tables[i]
            parts.append(struct.pack("<I", len(rows)))
            for r in rows:
                parts.append(bytes(r))
        return b"".join(parts)

    def validate(self) -> None:
        if len(self.header) != HEADER_SIZE:
            raise ValidationError("머리말 크기가 올바르지 않습니다.")
        if len(self.tables) != TABLE_COUNT:
            raise ValidationError("테이블 개수가 62개가 아닙니다.")
        for i in range(TABLE_COUNT):
            rows = self.tables[i]
            if len(rows) > MAX_RECORDS:
                raise ValidationError(f"테이블 T{i:02d} 레코드 수가 상한을 초과합니다.")
            for r in rows:
                if len(r) != TABLE_SIZES[i]:
                    raise ValidationError(f"테이블 T{i:02d} 레코드 크기가 올바르지 않습니다.")

    def record_count(self, tbl: int) -> int:
        return len(self.tables[tbl])

    def record(self, tbl: int, idx: int) -> bytearray:
        if idx < 0 or idx >= len(self.tables[tbl]):
            raise ValidationError("레코드 번호가 범위를 벗어났습니다.")
        return self.tables[tbl][idx]

    def records(self, tbl: int):
        return enumerate(self.tables[tbl])

    def add_record(self, tbl: int) -> int:
        if self.record_count(tbl) >= MAX_RECORDS:
            raise ValidationError("레코드 수 상한에 도달했습니다.")
        self.tables[tbl].append(bytearray(TABLE_SIZES[tbl]))
        return len(self.tables[tbl]) - 1

    def remove_record(self, tbl: int, idx: int) -> None:
        if idx < 0 or idx >= len(self.tables[tbl]):
            raise ValidationError("레코드 번호가 범위를 벗어났습니다.")
        del self.tables[tbl][idx]

    @property
    def has_script(self) -> bool:
        return self.record_count(T00) > 0

    @property
    def account_name(self) -> str:
        return _read_fixed_str(self.header, 0x10, 0x20)

    @property
    def alive_days(self) -> int:
        return _u32(self.header, 0x9C)

    @property
    def meridians_lvl(self) -> int:
        return _u32(self.header, 0x2DC)

    @meridians_lvl.setter
    def meridians_lvl(self, v: int) -> None:
        if not 0 <= v <= 2_000_000_000:
            raise ValidationError("경맥 등급 범위 오류")
        _put_u32(self.header, 0x2DC, v)

    @property
    def achieve_point(self) -> int:
        return _u32(self.header, 0x2E0)

    @achieve_point.setter
    def achieve_point(self, v: int) -> None:
        if not 0 <= v <= 2_000_000_000:
            raise ValidationError("업적 점수 범위 오류")
        _put_u32(self.header, 0x2E0, v)

    @property
    def t00(self) -> bytearray:
        if not self.has_script:
            raise ValidationError("타이틀 화면 세이브에는 시나리오 진행 데이터가 없습니다.")
        return self.tables[T00][0]

    @property
    def main_role_id(self) -> int:
        return _u32(self.t00, 0x14) if self.has_script else 0

    @property
    def main_role_name(self) -> str:
        return _read_fixed_str(self.t00, 0x5C, 0x20) if self.has_script else ""

    @main_role_name.setter
    def main_role_name(self, v: str) -> None:
        if not v or not v.strip():
            raise ValidationError("주인공 이름은 비워둘 수 없습니다.")
        _put_fixed_str(self.t00, 0x5C, 0x20, v, max_bytes=30)

    @property
    def coin(self) -> int:
        return _u32(self.t00, 0x38) if self.has_script else 0

    @coin.setter
    def coin(self, v: int) -> None:
        if not 0 <= v <= 2_000_000_000:
            raise ValidationError("동전 값은 0~2,000,000,000 범위여야 합니다.")
        _put_u32(self.t00, 0x38, v)

    @property
    def bag_extra_cap(self) -> int:
        return _u32(self.t00, 0x28) if self.has_script else 0

    @bag_extra_cap.setter
    def bag_extra_cap(self, v: int) -> None:
        if not 0 <= v <= 99_999:
            raise ValidationError("배낭 추가 용량 범위 오류")
        _put_u32(self.t00, 0x28, v)

    def _next_object_id(self, obj_type: int, scan_tbl: int) -> int:
        cur_max = 0
        found_slot = None
        for _, rec in self.records(T01):
            if _u32(rec, 0x10) == obj_type:
                cur_max = max(cur_max, _u32(rec, 0x14))
                found_slot = rec
        for _, rec in self.records(scan_tbl):
            cur_max = max(cur_max, _u32(rec, 0x10))
        if cur_max >= 0xFFFFFFFF:
            raise ValidationError("객체 고유번호 상한을 초과했습니다.")
        new_id = cur_max + 1
        if found_slot is not None:
            _put_u32(found_slot, 0x14, new_id)
        else:
            idx = self.add_record(T01)
            slot = self.record(T01, idx)
            _put_u32(slot, 0x10, obj_type)
            _put_u32(slot, 0x14, new_id)
        return new_id

    def _t21_rec(self, role_id: int | None = None):
        rid = role_id if role_id is not None else self.main_role_id
        for _, rec in self.records(T21):
            if _u32(rec, 0x10) == rid:
                return rec
        if role_id is None and self.record_count(T21) > 0:
            return self.record(T21, 0)
        return None

    def set_role_level(self, level: int, role_id: int | None = None) -> None:
        if not 1 <= level <= 99:
            raise ValidationError("레벨은 1~99 범위여야 합니다.")
        rec = self._t21_rec(role_id)
        if rec is None:
            raise ValidationError("인물 레코드를 찾을 수 없습니다.")
        _put_u8(rec, 0x52, level)

    def parse_attr_key(self, key: str | int) -> int:
        if isinstance(key, int):
            idx = key
        else:
            s = key.strip()
            if s in ATTR_KEYS:
                return ATTR_KEYS[s]
            try:
                idx = int(s)
            except ValueError as exc:
                raise ValidationError(f"알 수 없는 능력치 이름: {key}") from exc
        if not 0 <= idx <= 25:
            raise ValidationError(f"능력치 번호 범위 초과: {idx}")
        return idx

    def set_role_attr(self, key: str | int, value: int, role_id: int | None = None) -> None:
        if not 0 <= value <= 2_000_000_000:
            raise ValidationError("능력치 값은 0~2,000,000,000 범위여야 합니다.")
        rec = self._t21_rec(role_id)
        if rec is None:
            raise ValidationError("인물 레코드를 찾을 수 없습니다.")
        idx = self.parse_attr_key(key)
        raw = _read_fixed_str(rec, 0x53, 0x100, "ascii")
        tokens = raw.split("|") if raw else []
        if idx >= len(tokens):
            raise ValidationError("능력치 토큰 개수를 초과하는 인덱스입니다.")
        tokens[idx] = str(value)
        _put_fixed_str(rec, 0x53, 0x100, "|".join(tokens), "ascii", max_bytes=255)

    def role_attrs(self, role_id: int | None = None) -> dict[str, int]:
        rec = self._t21_rec(role_id)
        if rec is None:
            return {}
        raw = _read_fixed_str(rec, 0x53, 0x100, "ascii")
        tokens = raw.split("|") if raw else []
        return {name: int(tokens[idx]) if idx < len(tokens) and tokens[idx] else 0 for name, idx in ATTR_KEYS.items()}

    def set_item_count(self, item_id: int, count: int) -> None:
        if not 1 <= count <= 999_999:
            raise ValidationError("물품 수량은 1~999,999 범위여야 합니다.")
        for _, rec in self.records(T23):
            if _u32(rec, 0x10) == item_id:
                _put_u32(rec, 0x1C, count)
                return
        raise ValidationError(f"물품 #{item_id}을(를) 찾을 수 없습니다.")

    def add_item(self, base_id: int, count: int = 1, owner: int | None = None) -> int:
        if base_id < 1 or not 1 <= count <= 999_999:
            raise ValidationError("물품 기본 번호 또는 수량이 올바르지 않습니다.")
        rid = owner if owner is not None else (self.main_role_id or 0)
        flag_a, flag_b = (2, 2) if rid > 0 else (0, 0)
        for _, existing in self.records(T23):
            if _u32(existing, 0x14) == rid:
                flag_a, flag_b = existing[0x24], existing[0x25]
                break
        new_id = self._next_object_id(ITEM_OBJ_TYPE, T23)
        idx = self.add_record(T23)
        rec = self.record(T23, idx)
        _put_u32(rec, 0x10, new_id)
        _put_u32(rec, 0x14, rid)
        _put_u32(rec, 0x18, base_id)
        _put_u32(rec, 0x1C, count)
        rec[0x24] = flag_a
        rec[0x25] = flag_b
        return new_id

    def remove_item(self, item_id: int) -> None:
        for i, rec in self.records(T23):
            if _u32(rec, 0x10) == item_id:
                self.remove_record(T23, i)
                return
        raise ValidationError(f"물품 #{item_id}을(를) 찾을 수 없습니다.")

    def find_storage_overflows(self, limit_map: dict[int, int] | None = None) -> list[dict]:
        lmap = load_item_limit_map() if limit_map is None else limit_map
        groups: dict[int, dict] = {}
        for idx, rec in self.records(T23):
            if _u32(rec, 0x14) != 0:
                continue
            base_id = _u32(rec, 0x18)
            count = _u32(rec, 0x1C)
            grp = groups.setdefault(
                base_id,
                {"baseId": base_id, "limitNum": lmap.get(base_id, 9900), "total": 0, "recordIds": []},
            )
            grp["total"] += count
            grp["recordIds"].append(_u32(rec, 0x10))
        return [g for g in groups.values() if g["total"] > g["limitNum"]]

    def fix_storage_overflows(self, limit_map: dict[int, int] | None = None) -> dict:
        lmap = load_item_limit_map() if limit_map is None else limit_map
        overflows = self.find_storage_overflows(lmap)
        details: list[dict] = []
        removed = 0
        for ov in overflows:
            base_id = ov["baseId"]
            remain = ov["limitNum"]
            del_indices: list[int] = []
            for idx, rec in self.records(T23):
                if _u32(rec, 0x14) != 0 or _u32(rec, 0x18) != base_id:
                    continue
                count = _u32(rec, 0x1C)
                keep = min(count, remain)
                remain -= keep
                if keep <= 0:
                    del_indices.append(idx)
                elif keep != count:
                    _put_u32(rec, 0x1C, keep)
            for idx in sorted(del_indices, reverse=True):
                self.remove_record(T23, idx)
            removed += len(del_indices)
            details.append({"baseId": base_id, "totalBefore": ov["total"], "totalAfter": ov["limitNum"], "removed": len(del_indices)})
        return {"fixedItems": len(details), "removedRecords": removed, "details": details}

    def add_martial(self, base_id: int, level: int = 1, role_id: int | None = None) -> int:
        if base_id < 1 or not 1 <= level <= 30:
            raise ValidationError("무학 번호 또는 레벨(1~30)이 올바르지 않습니다.")
        rid = role_id if role_id is not None else (self.main_role_id or 8)
        new_id = self._next_object_id(MARTIAL_OBJ_TYPE, T25)
        idx = self.add_record(T25)
        rec = self.record(T25, idx)
        _put_u32(rec, 0x10, new_id)
        _put_u32(rec, 0x14, rid)
        _put_u32(rec, 0x18, level)
        _put_u32(rec, 0x20, base_id)
        rec[0x2C], rec[0x2D], rec[0x2E], rec[0x2F] = 2, 2, 0, 6
        return new_id

    def remove_martial(self, martial_id: int) -> None:
        for i, rec in self.records(T25):
            if _u32(rec, 0x10) == martial_id:
                self.remove_record(T25, i)
                return
        raise ValidationError(f"무학 #{martial_id}을(를) 찾을 수 없습니다.")

    def set_all_martial_levels(self, level: int = 30) -> None:
        if not 1 <= level <= 30:
            raise ValidationError("무학 레벨은 1~30 범위여야 합니다.")
        for _, rec in self.records(T25):
            _put_u32(rec, 0x18, level)

    def add_gift(self, base_id: int, role_id: int | None = None) -> int:
        if base_id < 1:
            raise ValidationError("천부 기본 번호가 올바르지 않습니다.")
        rid = role_id if role_id is not None else (self.main_role_id or 8)
        new_id = self._next_object_id(GIFT_OBJ_TYPE, T31)
        idx = self.add_record(T31)
        rec = self.record(T31, idx)
        _put_u32(rec, 0x10, new_id)
        _put_u32(rec, 0x14, base_id)
        _put_u32(rec, 0x18, rid)
        _put_u8(rec, 0x1C, 2)
        return new_id

    def remove_gift(self, gift_id: int) -> None:
        for i, rec in self.records(T31):
            if _u32(rec, 0x10) == gift_id:
                self.remove_record(T31, i)
                return
        raise ValidationError(f"천부 #{gift_id}을(를) 찾을 수 없습니다.")

    def get_currency(self, key: str | int) -> int:
        k = CURRENCY_KEYS[key] if isinstance(key, str) else key
        for _, rec in self.records(T61):
            if _u32(rec, 0x10) == k and _u32(rec, 0x14) == k:
                return _u32(rec, 0x18)
        return 0

    def set_currency(self, key: str | int, value: int) -> None:
        if isinstance(key, str):
            if key not in CURRENCY_KEYS:
                raise ValidationError(f"알 수 없는 공용 재화: {key}")
            k = CURRENCY_KEYS[key]
        else:
            k = key
        if not 0 <= value <= 2_000_000_000:
            raise ValidationError("재화 값은 0~2,000,000,000 범위여야 합니다.")
        for _, rec in self.records(T61):
            if _u32(rec, 0x10) == k and _u32(rec, 0x14) == k:
                _put_u32(rec, 0x18, value)
                return
        new_rec = bytearray(TABLE_SIZES[T61])
        _put_u32(new_rec, 0x10, k)
        _put_u32(new_rec, 0x14, k)
        _put_u32(new_rec, 0x18, value)
        insert_at = len(self.tables[T61])
        for i, rec in self.records(T61):
            if _u32(rec, 0x10) > 0x10000:
                insert_at = i
                break
        self.tables[T61].insert(insert_at, new_rec)

    def set_all_npc_dispositions(self, value: int) -> None:
        if not -100 <= value <= 100:
            raise ValidationError("호감도는 -100~100 범위여야 합니다.")
        main_rec = self._t21_rec()
        target_tpl = _u32(main_rec, 0x14) if main_rec is not None else DEFAULT_NPC_TARGET
        for _, rec in self.records(T28):
            pair_count = min(3, _u32(rec, 0x18))
            for s in range(pair_count):
                base = 0x1C + s * 8
                if _u32(rec, base) == target_tpl:
                    struct.pack_into("<i", rec, base + 4, value)

    def apply_preset(self, preset_id: str) -> None:
        if preset_id not in PRESET_IDS:
            raise ValidationError(f"알 수 없는 빠른 설정: {preset_id}")
        if preset_id == "rich_resources":
            if self.has_script:
                self.coin = max(self.coin, 9_999_999)
                self.bag_extra_cap = max(self.bag_extra_cap, 500)
                self.t00[0x51] = max(self.t00[0x51], 20)
                self.t00[0x52] = max(self.t00[0x52], 30)
                self.t00[0x55] = max(self.t00[0x55], 30)
            targets = {
                "silver": 999_999, "gold": 999_999,
                "refinedIron": 99_999, "perfectPowder": 99_999,
                "heavenHammer": 99_999, "tonglingyu": 99_999,
                "lowIncomplete": 99_999, "midIncomplete": 99_999, "highIncomplete": 99_999,
            }
            for cid, cval in targets.items():
                self.set_currency(cid, max(self.get_currency(cid), cval))
        elif preset_id == "max_role_stats":
            rec = self._t21_rec()
            if rec is not None:
                _put_u8(rec, 0x52, max(_u8(rec, 0x52), 30))
                _put_u16(rec, 0x48, max(_u16(rec, 0x48), 500))
                _put_u16(rec, 0x50, max(_u16(rec, 0x50), 999))
                cur = self.role_attrs()
                high = {"maxHp": 99_999, "maxMp": 99_999, "defence": 9_999, "martialAtk": 9_999}
                for name in ATTR_KEYS:
                    goal = high.get(name, 999)
                    self.set_role_attr(name, max(cur.get(name, 0), goal))
        elif preset_id == "all_martials_lv30":
            self.set_all_martial_levels(30)
        elif preset_id == "all_npcs_100":
            self.set_all_npc_dispositions(100)

    def summary(self) -> dict:
        return {
            "hasScript": self.has_script,
            "accountName": self.account_name,
            "mainRoleId": self.main_role_id,
            "mainRoleName": self.main_role_name,
            "coin": self.coin,
            "aliveDays": self.alive_days,
            "meridiansLvl": self.meridians_lvl,
            "achievePoint": self.achieve_point,
            "currencies": {k: self.get_currency(k) for k in CURRENCY_KEYS},
            "itemCount": self.record_count(T23),
            "storageOverflowCount": len(self.find_storage_overflows()),
            "martialCount": self.record_count(T25),
            "giftCount": self.record_count(T31),
            "npcCount": self.record_count(T28),
            "attrs": self.role_attrs(),
        }


def create_demo_save() -> bytes:
    header = bytearray(HEADER_SIZE)
    _put_fixed_str(header, 0x10, 0x20, "Player1")
    struct.pack_into("<HHBBBB", header, 0x40, 2026, 11, 18, 10, 0, 0)
    struct.pack_into("<HHBBBB", header, 0x50, 2026, 11, 18, 12, 0, 0)
    _put_u32(header, 0x9C, 7)
    _put_u32(header, 0x2DC, 5)
    _put_u32(header, 0x2E0, 1200)

    tables: list[list[bytearray]] = [[] for _ in range(TABLE_COUNT)]
    t00 = bytearray(TABLE_SIZES[T00])
    _put_u32(t00, 0x10, 2)
    _put_u32(t00, 0x14, 8)
    _put_u32(t00, 0x18, 60)
    _put_u32(t00, 0x28, 50)
    _put_u32(t00, 0x38, 1500)
    _put_u8(t00, 0x50, 1)
    _put_u8(t00, 0x51, 2)
    _put_u8(t00, 0x52, 2)
    _put_u8(t00, 0x54, 5)
    _put_u8(t00, 0x55, 10)
    _put_fixed_str(t00, 0x5C, 0x20, "소하", max_bytes=30)
    _put_u32(t00, 0x88, 100)
    _put_u32(t00, 0x8C, 50)
    tables[T00] = [t00]

    t21 = bytearray(TABLE_SIZES[T21])
    _put_u32(t21, 0x10, 8)
    _put_u32(t21, 0x14, DEFAULT_NPC_TARGET)
    _put_u32(t21, 0x24, 200)
    _put_u16(t21, 0x48, 10)
    _put_u8(t21, 0x4E, 0)
    _put_u16(t21, 0x50, 10)
    _put_u8(t21, 0x52, 5)
    _put_fixed_str(
        t21, 0x53, 0x100,
        "5200|1100|150|5|5|5|5|5|5|1|1|850|80|120|75|60|30|25|70|90|10000|1000|2500|90|10000|3",
        "ascii", max_bytes=255,
    )
    tables[T21] = [t21]

    doc = SaveDoc(header, tables)
    doc.add_item(1001, 5, 8)
    doc.add_item(1106, 3, 8)
    doc.add_item(70108, 1, 8)
    doc.add_martial(12213, 3, 8)
    doc.add_martial(12214, 2, 8)
    doc.add_gift(332, 8)
    doc.add_gift(127, 8)

    for idx_npc, (npc_base, disp) in enumerate([(1020101001, 50), (1020101004, 30)], start=1):
        ri = doc.add_record(T28)
        rec = doc.record(T28, ri)
        _put_u32(rec, 0x10, idx_npc)
        _put_u32(rec, 0x14, npc_base)
        _put_u32(rec, 0x18, 1)
        _put_u32(rec, 0x1C, DEFAULT_NPC_TARGET)
        struct.pack_into("<i", rec, 0x20, disp)

    doc.set_currency("silver", 500)
    doc.set_currency("gold", 100)
    doc.set_currency("refinedIron", 20)
    return doc.serialize()


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_save_bytes(data: bytes) -> list[str]:
    try:
        SaveDoc.parse(data).validate()
        return []
    except Exception as exc:
        return [str(exc)]


def _ensure_not_symlink(path: os.PathLike[str] | str) -> Path:
    try:
        p = Path(os.path.abspath(os.fspath(path)))
    except OSError as exc:
        raise UnsafePathError(f"올바르지 않은 경로입니다: {path}") from exc
    parts = [p]
    cur = p
    while True:
        parent = cur.parent
        if parent == cur:
            break
        parts.append(parent)
        cur = parent
    for comp in reversed(parts):
        try:
            st = os.lstat(comp)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise UnsafePathError(f"경로 상태를 확인할 수 없습니다 ({comp}): {exc}") from exc
        if stat.S_ISLNK(st.st_mode) or (getattr(st, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT):
            raise UnsafePathError(f"심볼릭 링크 또는 재분석 지점 경로는 거부됩니다: {comp}")
    return p


def game_is_running() -> bool:
    env = os.environ.get("MYJH_SIMULATE_GAME_RUNNING", "").strip().lower()
    if env in ("1", "true", "yes", "on"):
        return True
    if os.name != "nt":
        return False
    try:
        out = subprocess.check_output(["tasklist", "/FO", "CSV", "/NH"], stderr=subprocess.DEVNULL, timeout=8)
    except (OSError, subprocess.SubprocessError):
        return False
    return "dreamrivakes.exe" in out.decode("utf-8", "replace").lower()


def require_game_not_running() -> None:
    if game_is_running():
        raise GameRunningError("게임(DreamRivakes.exe)이 실행 중이므로 세이브 덮어쓰기를 차단했습니다.")


def _steam_library_roots() -> list[Path]:
    roots: list[Path] = []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES"):
        base = os.environ.get(env)
        if base:
            roots.append(Path(base) / "Steam")
    home = Path.home()
    roots.extend([home / ".steam" / "steam", home / ".local" / "share" / "Steam"])
    found: list[Path] = []
    for r in roots:
        vdf = r / "steamapps" / "libraryfolders.vdf"
        if vdf.is_file():
            try:
                for line in vdf.read_text(encoding="utf-8", errors="replace").splitlines():
                    if '"path"' in line:
                        parts = line.strip().split('"')
                        if len(parts) >= 4:
                            found.append(Path(parts[3].replace("\\\\", "\\")))
            except OSError:
                pass
        if r.is_dir():
            found.append(r)
    return found


def discover_saves(explicit_dir: str | os.PathLike[str] | None = None) -> list[dict]:
    candidates: list[Path] = []
    explicit = explicit_dir or os.environ.get("MYJH_SAVE_DIR")
    if explicit:
        candidates.append(Path(explicit).expanduser())
    for root in _steam_library_roots():
        candidates.append(root / "steamapps" / "common" / "xiake")
    results: list[dict] = []
    seen: set[str] = set()

    def _try_add(sv: Path, label: str, is_auto: bool) -> None:
        try:
            checked = _ensure_not_symlink(sv)
            if not checked.is_file():
                return
            key = os.path.normcase(str(checked))
            if key in seen:
                return
            raw = checked.read_bytes()
            if validate_save_bytes(raw):
                return
            st = checked.stat()
            seen.add(key)
            results.append({
                "path": str(checked),
                "name": label,
                "isAuto": is_auto,
                "size": len(raw),
                "modifiedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(st.st_mtime)),
                "sha256": sha256_bytes(raw),
            })
        except (UnsafePathError, OSError):
            return

    for root in candidates:
        try:
            root_checked = _ensure_not_symlink(root)
        except UnsafePathError:
            continue
        if not root_checked.is_dir():
            continue
        _try_add(root_checked / "Save.sav", "자동 저장 (Save.sav)", True)
        sfd = root_checked / "SaveFile"
        try:
            if sfd.exists() and not stat.S_ISLNK(os.lstat(sfd).st_mode) and sfd.is_dir():
                for sub in sorted(sfd.iterdir()):
                    if not stat.S_ISLNK(os.lstat(sub).st_mode) and sub.is_dir():
                        _try_add(sub / "Save.sav", f"슬롯 {sub.name} (Save.sav)", False)
        except OSError:
            continue
    return results


_SLOT_LOCKS_GUARD = threading.Lock()
_SLOT_LOCKS: dict[str, threading.Lock] = {}


@contextmanager
def _slot_lock(save_path: Path):
    key = os.path.normcase(os.path.abspath(os.fspath(save_path)))
    with _SLOT_LOCKS_GUARD:
        inproc_lock = _SLOT_LOCKS.setdefault(key, threading.Lock())
    with inproc_lock:
        lock_path = Path(str(save_path) + ".lock")
        _ensure_not_symlink(lock_path)
        flags = os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(lock_path, flags, 0o600)
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
            else:
                import fcntl
                fcntl.flock(fd, fcntl.LOCK_EX)
            yield
        finally:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(fd, 0, os.SEEK_SET)
                    msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_UN)
            finally:
                os.close(fd)


def save_with_backup(path: os.PathLike[str] | str, data_bytes: bytes, expected_sha256: str | None = None, dry_run: bool = False) -> dict:
    p = _ensure_not_symlink(Path(path).expanduser())
    _ensure_not_symlink(p.parent)
    SaveDoc.parse(data_bytes).validate()
    if p.exists() and p.is_dir():
        raise UnsafePathError(f"대상 경로가 디렉터리입니다: {p}")
    new_sha = sha256_bytes(data_bytes)
    if dry_run:
        if p.exists() and expected_sha256 and expected_sha256.strip():
            actual_sha = sha256_file(p)
            if actual_sha.lower() != expected_sha256.strip().lower():
                raise ShaMismatchError(f"파일 해시 불일치: 예상 {expected_sha256.strip().lower()}, 실제 {actual_sha.lower()}")
        return {"ok": True, "dryRun": True, "path": str(p), "sha256": new_sha, "size": len(data_bytes)}

    require_game_not_running()
    with _slot_lock(p):
        require_game_not_running()
        _ensure_not_symlink(p)
        actual_sha = None
        if p.exists():
            if p.is_dir():
                raise UnsafePathError(f"대상 경로가 디렉터리입니다: {p}")
            actual_sha = sha256_file(p)
            if expected_sha256 and expected_sha256.strip():
                if actual_sha.lower() != expected_sha256.strip().lower():
                    raise ShaMismatchError(f"파일 해시 불일치: 예상 {expected_sha256.strip().lower()}, 실제 {actual_sha.lower()}")

        backup_path = None
        if p.exists() and actual_sha is not None:
            stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            backup_candidate = p.with_name(f"{p.name}.backup-{stamp}-{os.getpid()}-{secrets.token_hex(4)}.bak")
            _ensure_not_symlink(backup_candidate)
            h = hashlib.sha256()
            with open(backup_candidate, "xb") as bf, open(p, "rb") as src:
                for chunk in iter(lambda: src.read(1024 * 1024), b""):
                    h.update(chunk)
                    bf.write(chunk)
                bf.flush()
                os.fsync(bf.fileno())
            if h.hexdigest().lower() != actual_sha.lower():
                try:
                    backup_candidate.unlink()
                except OSError:
                    pass
                raise MyjhError("백업 SHA-256 검증에 실패했습니다.")
            backup_path = backup_candidate

        fd, tmp_name = tempfile.mkstemp(prefix=f".{p.name}.pending-", dir=str(p.parent))
        tmp = Path(tmp_name)
        own_tmp = True
        try:
            with os.fdopen(fd, "wb") as tf:
                tf.write(data_bytes)
                tf.flush()
                os.fsync(tf.fileno())
            _ensure_not_symlink(tmp)
            os.replace(tmp, p)
            own_tmp = False
        finally:
            if own_tmp:
                try:
                    tmp.unlink()
                except OSError:
                    pass

    return {
        "ok": True,
        "path": str(p),
        "sha256": new_sha,
        "backupPath": str(backup_path) if backup_path else None,
        "size": len(data_bytes),
    }


def load_item_limit_map() -> dict[int, int]:
    """내장 도감(src/catalog-data.js)에서 물품별 창고 상한(limitNum)을 불러온다."""
    out: dict[int, int] = {}
    for base in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        c = base / "src" / "catalog-data.js"
        if not c.is_file():
            continue
        try:
            text = c.read_text(encoding="utf-8")
            marker = text.find("return {")
            if marker < 0:
                continue
            payload, _ = json.JSONDecoder().raw_decode(text, marker + len("return "))
            for entry in payload.get("items", []):
                if isinstance(entry, dict) and isinstance(entry.get("id"), int):
                    lim = entry.get("limitNum")
                    if isinstance(lim, int) and lim > 0:
                        out[entry["id"]] = lim
            return out
        except (OSError, ValueError, TypeError):
            continue
    return out


def _find_html_path(explicit_html: str | None = None) -> Path:
    if explicit_html:
        p = Path(explicit_html).expanduser().resolve()
        if p.is_file():
            return p
        raise MyjhError(f"지정한 HTML 파일을 찾을 수 없습니다: {p}")
    rel = Path("dist") / "MyJianghuSaveEditor-v1.1.1.html"
    for base in (Path(__file__).resolve().parent, Path.cwd().resolve()):
        c = base / rel
        if c.is_file():
            return c
    raise MyjhError(f"번들 HTML 파일을 찾을 수 없습니다: {rel}")


def _prepare_served_html(html_bytes: bytes, token: str) -> bytes:
    guarded = token.replace("\\", "\\\\").replace('"', '\\"')
    injection = (
        f'<script>window.__MYJH_TOKEN__ = "{guarded}"; '
        f'window.__MYJH_SERVER__ = {{token: "{guarded}", mode: "python"}};</script>'
    )
    text = html_bytes.decode("utf-8")
    text = text.replace("connect-src 'none'", "connect-src 'self'")
    if "</head>" in text:
        text = text.replace("</head>", injection + "</head>", 1)
    else:
        text = injection + text
    return text.encode("utf-8")


def _json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Connection", "close")
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


def create_http_server(port: int = 0, save_dir: str | None = None, html_path: str | None = None, token: str | None = None, host: str = "127.0.0.1"):
    if host != "127.0.0.1":
        raise MyjhError("보안을 위해 루프백 주소(127.0.0.1)에만 바인딩할 수 있습니다.")
    html_file = _find_html_path(html_path)
    active_token = token if token is not None else secrets.token_urlsafe(24)
    served = _prepare_served_html(html_file.read_bytes(), active_token)

    class Handler(BaseHTTPRequestHandler):
        server_version = "MyjhEditor/1.1"
        sys_version = ""

        def log_message(self, fmt: str, *args: object) -> None:
            return

        def _reject(self, status: int, msg: str) -> None:
            _json_response(self, status, {"ok": False, "error": msg})

        def _check_security(self) -> bool:
            bound_port = self.server.server_address[1]
            allowed_hosts = {f"127.0.0.1:{bound_port}", f"localhost:{bound_port}"}
            if (self.headers.get("Host") or "").strip() not in allowed_hosts:
                self._reject(403, "허용되지 않은 Host 헤더입니다.")
                return False
            origin = (self.headers.get("Origin") or "").strip()
            if origin and origin not in {f"http://127.0.0.1:{bound_port}", f"http://localhost:{bound_port}"}:
                self._reject(403, "허용되지 않은 Origin 헤더입니다.")
                return False
            sfs = (self.headers.get("Sec-Fetch-Site") or "").strip()
            if sfs and sfs not in ("same-origin", "none"):
                self._reject(403, "허용되지 않은 Sec-Fetch-Site 헤더입니다.")
                return False
            return True

        def _check_token(self) -> bool:
            provided = self.headers.get("X-MYJH-Token") or ""
            if not provided or not hmac.compare_digest(provided, active_token):
                self._reject(401, "유효하지 않은 인증 토큰입니다.")
                return False
            return True

        def _read_json(self) -> dict:
            try:
                length = int(self.headers.get("Content-Length") or "0")
            except ValueError as exc:
                raise ValidationError("잘못된 Content-Length입니다.") from exc
            if length <= 0 or length > (16 * 1024 * 1024):
                raise ValidationError("요청 본문 크기가 허용 범위를 벗어났습니다.")
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValidationError("요청 본문이 불완전합니다.")
            try:
                obj = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                raise ValidationError(f"JSON 파싱 오류: {exc}") from exc
            if not isinstance(obj, dict):
                raise ValidationError("JSON 본문은 객체여야 합니다.")
            return obj

        def do_GET(self) -> None:
            path = self.path.split("?", 1)[0]
            if not self._check_security():
                return
            if path == "/":
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(served)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    self.wfile.write(served)
                except (BrokenPipeError, ConnectionResetError):
                    pass
                return
            if path == "/api/slots":
                if not self._check_token():
                    return
                _json_response(self, 200, {"ok": True, "slots": discover_saves(self.server.save_dir)})
                return
            self._reject(404, "찾을 수 없는 경로입니다.")

        def do_POST(self) -> None:
            path = self.path.split("?", 1)[0]
            if not self._check_security():
                return
            if not path.startswith("/api/"):
                self._reject(404, "찾을 수 없는 경로입니다.")
                return
            if not self._check_token():
                return
            if path == "/api/load":
                try:
                    payload = self._read_json()
                    raw_path = payload.get("path")
                    if not isinstance(raw_path, str) or not raw_path.strip():
                        raise ValidationError("경로(path)가 누락되었습니다.")
                    p = _ensure_not_symlink(Path(raw_path).expanduser())
                    if p.suffix.lower() != ".sav":
                        raise UnsafePathError(".sav 확장자 파일만 열 수 있습니다.")
                    if not p.is_file():
                        raise ValidationError(f"파일을 찾을 수 없습니다: {p}")
                    raw = p.read_bytes()
                    SaveDoc.parse(raw).validate()
                    _json_response(self, 200, {
                        "ok": True,
                        "path": str(p),
                        "name": p.name,
                        "dataBase64": base64.b64encode(raw).decode("ascii"),
                        "sha256": sha256_bytes(raw),
                        "size": len(raw),
                    })
                except UnsafePathError as exc:
                    self._reject(403, str(exc))
                except Exception as exc:
                    self._reject(400, str(exc))
                return
            if path == "/api/save":
                try:
                    payload = self._read_json()
                    raw_path = payload.get("path")
                    data_b64 = payload.get("dataBase64")
                    expected = payload.get("expectedSha256") or ""
                    if not isinstance(raw_path, str) or not raw_path.strip():
                        raise ValidationError("경로(path)가 누락되었습니다.")
                    if not isinstance(data_b64, str):
                        raise ValidationError("데이터(dataBase64)가 누락되었습니다.")
                    p = _ensure_not_symlink(Path(raw_path).expanduser())
                    if p.suffix.lower() != ".sav":
                        raise UnsafePathError(".sav 확장자 파일만 저장할 수 있습니다.")
                    try:
                        data_bytes = base64.b64decode(data_b64.encode("ascii"), validate=True)
                    except Exception as exc:
                        raise ValidationError(f"Base64 디코딩 실패: {exc}") from exc
                    res = save_with_backup(p, data_bytes, expected_sha256=expected, dry_run=False)
                    _json_response(self, 200, res)
                except UnsafePathError as exc:
                    self._reject(403, str(exc))
                except (ShaMismatchError, GameRunningError) as exc:
                    self._reject(409, str(exc))
                except Exception as exc:
                    self._reject(400, str(exc))
                return
            self._reject(404, "찾을 수 없는 경로입니다.")

    httpd = http.server.ThreadingHTTPServer((host, port), Handler)
    httpd.save_dir = save_dir  # type: ignore[attr-defined]
    httpd.html_path = str(html_file)  # type: ignore[attr-defined]
    httpd.token = active_token  # type: ignore[attr-defined]
    url = f"http://127.0.0.1:{httpd.server_address[1]}/"
    return httpd, url


def run_self_test() -> int:
    demo = create_demo_save()
    errs = validate_save_bytes(demo)
    if errs:
        raise MyjhError("데모 검증 실패: " + "; ".join(errs))
    doc = SaveDoc.parse(demo)
    if doc.serialize() != demo:
        raise MyjhError("왕복 직렬화 바이트 불일치")
    for pid in PRESET_IDS:
        doc.apply_preset(pid)
    doc.add_item(1005, 50)
    doc.add_item(1001, 6000, owner=0)
    doc.add_item(1001, 5000, owner=0)
    if len(doc.find_storage_overflows({1001: 9999})) != 1:
        raise MyjhError("창고 상한 초과 탐지 실패")
    fix_res = doc.fix_storage_overflows({1001: 9999})
    if fix_res["fixedItems"] != 1 or doc.find_storage_overflows({1001: 9999}):
        raise MyjhError("창고 상한 초과 정리 실패")
    doc.add_martial(12215, 10)
    doc.add_gift(409)
    mutated = doc.serialize()
    if validate_save_bytes(mutated):
        raise MyjhError("변이 세이브 검증 실패")

    with tempfile.TemporaryDirectory() as td:
        target = Path(td) / "Save.sav"
        target.write_bytes(demo)
        orig_sha = sha256_file(target)
        res = save_with_backup(target, mutated, expected_sha256=orig_sha)
        bak = res.get("backupPath")
        if not bak or not Path(bak).is_file() or sha256_file(Path(bak)) != orig_sha:
            raise MyjhError("자동 백업 생성 또는 해시 검증 실패")
        try:
            save_with_backup(target, demo, expected_sha256="0" * 64)
            raise MyjhError("ShaMismatchError 미발생")
        except ShaMismatchError:
            pass

        old_env = os.environ.get("MYJH_SIMULATE_GAME_RUNNING")
        try:
            os.environ["MYJH_SIMULATE_GAME_RUNNING"] = "1"
            try:
                save_with_backup(target, demo)
                raise MyjhError("GameRunningError 미발생")
            except GameRunningError:
                pass
        finally:
            if old_env is None:
                os.environ.pop("MYJH_SIMULATE_GAME_RUNNING", None)
            else:
                os.environ["MYJH_SIMULATE_GAME_RUNNING"] = old_env

    print("[OK] self-test passed")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="myjh_editor.py", description="몽강호 세이브 에디터 CLI 및 로컬 서버")
    parser.add_argument("--self-test", action="store_true", help="내장 무결성 자가 진단 실행")
    sub = parser.add_subparsers(dest="cmd")

    p_demo = sub.add_parser("demo", help="예시 Save.sav 생성")
    p_demo.add_argument("output", nargs="?", default=None)
    p_demo.add_argument("--out", default=None)
    p_demo.add_argument("--force", action="store_true")

    p_disc = sub.add_parser("discover", help="설치된 세이브 슬롯 탐색")
    p_disc.add_argument("--save-dir", "--dir", dest="save_dir", default=None)

    p_info = sub.add_parser("info", help="세이브 요약 정보 출력")
    p_info.add_argument("path")

    p_val = sub.add_parser("validate", help="세이브 바이너리 무결성 검증")
    p_val.add_argument("path")

    sub.add_parser("presets", help="사용 가능한 빠른 설정 목록")

    p_edit = sub.add_parser("edit", help="세이브 항목 편집 및 백업 저장")
    p_edit.add_argument("path")
    p_edit.add_argument("--out", default=None)
    p_edit.add_argument("--dry-run", action="store_true")
    p_edit.add_argument("--expected-sha256", default=None)
    p_edit.add_argument("--preset", action="append", default=None)
    p_edit.add_argument("--coin", type=int, default=None)
    p_edit.add_argument("--silver", type=int, default=None)
    p_edit.add_argument("--gold", type=int, default=None)
    p_edit.add_argument("--name", default=None)
    p_edit.add_argument("--level", "--set-role-level", dest="level", type=int, default=None)
    p_edit.add_argument("--set-attr", nargs=2, action="append", metavar=("KEY", "VAL"))
    p_edit.add_argument("--set-currency", nargs=2, action="append", metavar=("KEY", "VAL"))
    p_edit.add_argument("--set-item-count", nargs=2, action="append", metavar=("ID", "CNT"))
    p_edit.add_argument("--add-item", nargs=2, action="append", metavar=("BASE", "CNT"))
    p_edit.add_argument("--remove-item", type=int, action="append", default=None)
    p_edit.add_argument("--fix-storage-overflow", action="store_true", help="계정 창고(소유 0) 상한 초과 물품을 안전 상한으로 정리")
    p_edit.add_argument("--add-martial", nargs=2, action="append", metavar=("BASE", "LV"))
    p_edit.add_argument("--remove-martial", type=int, action="append", default=None)
    p_edit.add_argument("--add-gift", type=int, action="append", default=None)
    p_edit.add_argument("--remove-gift", type=int, action="append", default=None)
    p_edit.add_argument("--npc-all", "--set-npc-disp", dest="npc_all", type=int, default=None)

    p_serve = sub.add_parser("serve", help="로컬 루프백 웹 에디터 서버 실행")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=8765)
    p_serve.add_argument("--save-dir", "--dir", dest="save_dir", default=None)
    p_serve.add_argument("--html", default=None)
    p_serve.add_argument("--token", default=None)
    p_serve.add_argument("--no-browser", action="store_true")

    args = parser.parse_args(argv)
    try:
        if args.self_test:
            return run_self_test()
        if not args.cmd:
            parser.print_help()
            return 2

        if args.cmd == "demo":
            dst_str = args.out or args.output
            if not dst_str:
                raise MyjhError("출력 파일 경로를 지정하세요.")
            out = Path(dst_str).expanduser()
            if out.exists() and not args.force:
                raise MyjhError(f"기존 파일이 존재합니다 (--force 필요): {out}")
            data = create_demo_save()
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            print(json.dumps({"ok": True, "path": str(out), "size": len(data), "sha256": sha256_bytes(data)}, ensure_ascii=False))
            return 0

        if args.cmd == "discover":
            print(json.dumps({"ok": True, "slots": discover_saves(args.save_dir)}, ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "info":
            p = _ensure_not_symlink(Path(args.path).expanduser())
            raw = p.read_bytes()
            doc = SaveDoc.parse(raw)
            doc.validate()
            print(json.dumps({"ok": True, "path": str(p), "size": len(raw), "sha256": sha256_bytes(raw), "summary": doc.summary()}, ensure_ascii=False, indent=2))
            return 0

        if args.cmd == "validate":
            p = _ensure_not_symlink(Path(args.path).expanduser())
            errs = validate_save_bytes(p.read_bytes())
            print(json.dumps({"ok": not errs, "path": str(p), "errors": errs}, ensure_ascii=False))
            return 0 if not errs else 1

        if args.cmd == "presets":
            print(json.dumps({"presets": PRESET_IDS}, ensure_ascii=False))
            return 0

        if args.cmd == "edit":
            src = _ensure_not_symlink(Path(args.path).expanduser())
            doc = SaveDoc.parse(src.read_bytes())
            doc.validate()
            for pid in (args.preset or []):
                doc.apply_preset(pid)
            if args.coin is not None:
                doc.coin = args.coin
            if args.silver is not None:
                doc.set_currency("silver", args.silver)
            if args.gold is not None:
                doc.set_currency("gold", args.gold)
            if args.name is not None:
                doc.main_role_name = args.name
            if args.level is not None:
                doc.set_role_level(args.level)
            for key, val in (args.set_attr or []):
                doc.set_role_attr(key, int(val))
            for key, val in (args.set_currency or []):
                doc.set_currency(key, int(val))
            for iid, cnt in (args.set_item_count or []):
                doc.set_item_count(int(iid), int(cnt))
            for base, cnt in (args.add_item or []):
                doc.add_item(int(base), int(cnt))
            for iid in (args.remove_item or []):
                doc.remove_item(iid)
            if args.fix_storage_overflow:
                doc.fix_storage_overflows()
            for base, lv in (args.add_martial or []):
                doc.add_martial(int(base), int(lv))
            for mid in (args.remove_martial or []):
                doc.remove_martial(mid)
            for gid in (args.add_gift or []):
                doc.add_gift(gid)
            for gid in (args.remove_gift or []):
                doc.remove_gift(gid)
            if args.npc_all is not None:
                doc.set_all_npc_dispositions(args.npc_all)
            new_bytes = doc.serialize()
            dst = Path(args.out).expanduser() if args.out else src
            expected = args.expected_sha256
            if expected is None and dst.exists() and not args.dry_run:
                expected = sha256_file(dst)
            res = save_with_backup(dst, new_bytes, expected_sha256=expected, dry_run=args.dry_run)
            print(json.dumps(res, ensure_ascii=False))
            return 0

        if args.cmd == "serve":
            httpd, url = create_http_server(port=args.port, save_dir=args.save_dir, html_path=args.html, token=args.token, host=args.host)
            print(f"[서버 시작] {url}", flush=True)
            if not args.no_browser:
                try:
                    webbrowser.open(url)
                except Exception:
                    pass
            try:
                httpd.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                httpd.server_close()
            return 0
    except MyjhError as exc:
        sys.stderr.write(f"[오류] {exc}\n")
        return 1
    return 2


if __name__ == "__main__":
    sys.exit(main())
