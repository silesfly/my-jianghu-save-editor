(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MyjhCodec = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADER_SIZE = 0x2f8;
  const TABLE_COUNT = 62;
  const MAX_RECORDS = 500000;
  const TABLE_SIZES = [
    0x2280, 0x18, 0x20, 0x20, 0x20, 0x18, 0x38, 0x28, 0x80, 0x18, 0x20, 0x20,
    0x68, 0x350, 0x20, 0x20, 0x48, 0x18, 0x18, 0x28, 0x48, 0x260, 0x120, 0x28,
    0x60, 0x38, 0x270, 0x30, 0x38, 0x28, 0x40, 0x20, 0x28, 0x20, 0x20, 0x168,
    0x88, 0x138, 0x38, 0x48, 0x30, 0x28, 0x28, 0x20, 0x20, 0x18, 0x28, 0x20,
    0x20, 0x20, 0x20, 0x2a0, 0x180, 0xb8, 0x30, 0x30, 0x28, 0x60, 0x30,
    0xb8, 0x320, 0x28
  ];
  const TABLE_NAMES_KO = {
    0: '주인공 시나리오(T00)', 1: '객체 최대 ID(T01)', 2: '해금 정보(T02)',
    3: '업적 달성(T03)', 6: '경맥 정보(T06)', 8: '백보서 기본(T08)',
    12: '협객행 추첨(T12)', 14: '영물 카드(T14)', 15: '캐릭터 카드(T15)',
    16: '문파 건물(T16)', 21: '캐릭터 능력치(T21)', 22: '맵 상태(T22)',
    23: '보유 물품(T23)', 24: '장비 부가속성(T24)', 25: '보유 무학(T25)',
    26: '임무 진행(T26)', 27: '비플레이어 인물(T27)', 28: '인물 호감도(T28)',
    29: '캐릭터 일러스트(T29)', 31: '보유 천부(T31)', 32: '동적 보너스 능력치(T32)',
    33: '상점 상태(T33)', 34: '출전 진형(T34)', 35: '도시 정보(T35)',
    36: '미궁 상태(T36)', 40: '문파 정보(T40)', 43: '임무 동적 변수(T43)',
    44: '임무 분기(T44)', 48: '태그 플래그(T48)', 51: '시나리오 경기장(T51)',
    55: '회차 누적(T55)', 56: '소원 임무(T56)', 57: '외형 정보(T57)',
    61: '계정 공용 재화(T61)'
  };

  const ROLE_SCRIPT_TABLE = 0;
  const MAXID_TABLE = 1;
  const ROLE_TABLE = 21;
  const ITEM_TABLE = 23;
  const MARTIAL_TABLE = 25;
  const NPC_CONTACT_TABLE = 28;
  const GIFT_TABLE = 31;
  const COMMON_FUNC_TABLE = 61;
  const ITEM_OBJ_TYPE = 7;
  const MARTIAL_OBJ_TYPE = 8;
  const GIFT_OBJ_TYPE = 10;
  const DEFAULT_NPC_TARGET = 1000001260;

  const COMMON_CURRENCIES = [
    { key: 2, id: 'silver', label: '은자' },
    { key: 3, id: 'gold', label: '금자' },
    { key: 4, id: 'treasurePage', label: '백보서 잔페이지' },
    { key: 38, id: 'refinedIron', label: '정철' },
    { key: 39, id: 'perfectPowder', label: '완벽분' },
    { key: 37, id: 'heavenHammer', label: '천공추' },
    { key: 73, id: 'tonglingyu', label: '금강옥' },
    { key: 33, id: 'lowIncomplete', label: '하급 무학 잔문' },
    { key: 34, id: 'midIncomplete', label: '중급 무학 잔문' },
    { key: 35, id: 'highIncomplete', label: '상급 무학 잔문' }
  ];

  const ATTR_FIELDS = [
    { index: 0, key: 'maxHp', label: '최대 생명력' },
    { index: 1, key: 'maxMp', label: '최대 진기' },
    { index: 2, key: 'defence', label: '방어' },
    { index: 11, key: 'martialAtk', label: '무학 공격' },
    { index: 3, key: 'lidao', label: '근력' },
    { index: 4, key: 'lingqiao', label: '민첩' },
    { index: 5, key: 'neijin', label: '내경' },
    { index: 6, key: 'tizhi', label: '체질' },
    { index: 7, key: 'jingli', label: '정력' },
    { index: 8, key: 'wuxing', label: '오성' },
    { index: 12, key: 'quanzhang', label: '권장 정통' },
    { index: 13, key: 'jianfa', label: '검법 정통' },
    { index: 14, key: 'daofa', label: '도법 정통' },
    { index: 15, key: 'tuifa', label: '퇴법 정통' },
    { index: 16, key: 'qimen', label: '기문 정통' },
    { index: 17, key: 'anqi', label: '암기 정통' },
    { index: 18, key: 'yishu', label: '의술 정통' },
    { index: 19, key: 'neigong', label: '내공 정통' }
  ];

  const ENCODER = new TextEncoder();
  const DECODER = new TextDecoder('utf-8', { fatal: false });

  function toBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
      return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    throw new Error('바이트 배열 또는 버퍼가 필요합니다.');
  }

  function readU16(bytes, off) {
    return bytes[off] | (bytes[off + 1] << 8);
  }

  function readU32(bytes, off) {
    return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) |
      (bytes[off + 3] << 24)) >>> 0;
  }

  function readI32(bytes, off) {
    return readU32(bytes, off) | 0;
  }

  function writeU16(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
  }

  function writeU32(bytes, off, value) {
    bytes[off] = value & 0xff;
    bytes[off + 1] = (value >>> 8) & 0xff;
    bytes[off + 2] = (value >>> 16) & 0xff;
    bytes[off + 3] = (value >>> 24) & 0xff;
  }

  function writeI32(bytes, off, value) {
    writeU32(bytes, off, value >>> 0);
  }

  function decodeCString(bytes, off, len) {
    let end = off;
    const limit = off + len;
    while (end < limit && bytes[end] !== 0) end++;
    return DECODER.decode(bytes.subarray(off, end));
  }

  function writeCString(bytes, off, len, text, maxBytes) {
    const encoded = ENCODER.encode(text);
    if (encoded.length > maxBytes) {
      throw new Error(`문자열은 UTF-8 기준 최대 ${maxBytes}바이트 이하여야 합니다.`);
    }
    bytes.fill(0, off, off + len);
    bytes.set(encoded, off);
  }

  function assertInt(value, min, max, label) {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${label} 값은 ${min}부터 ${max}까지의 정수여야 합니다.`);
    }
  }

  function tableName(index) {
    return TABLE_NAMES_KO[index] || `테이블 T${String(index).padStart(2, '0')}`;
  }

  function readTime(headerBytes, off) {
    return {
      year: readU16(headerBytes, off),
      month: readU16(headerBytes, off + 2),
      day: headerBytes[off + 4],
      hour: headerBytes[off + 5],
      minute: headerBytes[off + 6],
      second: headerBytes[off + 7]
    };
  }

  function findRecordIndexById(records, id, offset) {
    const at = offset === undefined ? 0x10 : offset;
    const target = id >>> 0;
    for (let i = 0; i < records.length; i++) {
      if (readU32(records[i], at) === target) return i;
    }
    return -1;
  }

  function validate(input) {
    const errors = [];
    let bytes;
    try {
      bytes = toBytes(input);
    } catch (e) {
      return { ok: false, errors: [e.message] };
    }
    const minSize = HEADER_SIZE + TABLE_COUNT * 4;
    if (bytes.length < minSize) {
      return { ok: false, errors: [`파일 길이가 최소 크기 ${minSize}바이트보다 작습니다.`] };
    }
    let off = HEADER_SIZE;
    for (let i = 0; i < TABLE_COUNT; i++) {
      if (off + 4 > bytes.length) {
        errors.push(`T${String(i).padStart(2, '0')} 레코드 수 영역이 잘렸습니다.`);
        break;
      }
      const count = readU32(bytes, off);
      off += 4;
      if (count > MAX_RECORDS) {
        errors.push(`T${String(i).padStart(2, '0')} 레코드 수가 최대치를 넘습니다.`);
        break;
      }
      const areaSize = count * TABLE_SIZES[i];
      if (off + areaSize > bytes.length) {
        errors.push(`T${String(i).padStart(2, '0')} 레코드 영역이 잘렸습니다.`);
        break;
      }
      off += areaSize;
    }
    if (!errors.length && off !== bytes.length) {
      errors.push(`파일 끝 위치가 맞지 않습니다. 예상 ${off}, 실제 ${bytes.length}.`);
    }
    return { ok: errors.length === 0, errors };
  }

  function parse(input) {
    const bytes = toBytes(input);
    const check = validate(bytes);
    if (!check.ok) throw new Error(check.errors.join(' '));
    const model = {
      headerBytes: new Uint8Array(bytes.subarray(0, HEADER_SIZE)),
      tables: []
    };
    let off = HEADER_SIZE;
    for (let i = 0; i < TABLE_COUNT; i++) {
      const count = readU32(bytes, off);
      off += 4;
      const recordSize = TABLE_SIZES[i];
      const records = [];
      for (let r = 0; r < count; r++) {
        records.push(new Uint8Array(bytes.subarray(off, off + recordSize)));
        off += recordSize;
      }
      model.tables.push({ index: i, recordSize, nameKo: tableName(i), records });
    }
    refreshDerived(model);
    return model;
  }

  function serialize(model) {
    let total = HEADER_SIZE + TABLE_COUNT * 4;
    for (let i = 0; i < TABLE_COUNT; i++) {
      const table = model.tables[i];
      total += table.records.length * table.recordSize;
    }
    const out = new Uint8Array(total);
    out.set(model.headerBytes.subarray(0, HEADER_SIZE), 0);
    let off = HEADER_SIZE;
    for (let i = 0; i < TABLE_COUNT; i++) {
      const table = model.tables[i];
      writeU32(out, off, table.records.length);
      off += 4;
      for (let r = 0; r < table.records.length; r++) {
        out.set(table.records[r].subarray(0, table.recordSize), off);
        off += table.recordSize;
      }
    }
    return out;
  }

  function refreshDerived(model) {
    const hb = model.headerBytes;
    model.header = {
      accountName: decodeCString(hb, 0x10, 32),
      createTime: readTime(hb, 0x40),
      saveTime: readTime(hb, 0x50),
      aliveDays: readU32(hb, 0x9c),
      meridiansLvl: readU32(hb, 0x2dc),
      achievePoint: readU32(hb, 0x2e0)
    };
    model.accountName = model.header.accountName;
    model.saveTime = model.header.saveTime;
    model.meridiansLvl = model.header.meridiansLvl;
    model.achievePoint = model.header.achievePoint;

    const scriptTable = model.tables[ROLE_SCRIPT_TABLE];
    model.hasScript = scriptTable.records.length > 0;
    if (model.hasScript) {
      const rec = scriptTable.records[0];
      model.scriptId = readU32(rec, 0x10);
      model.mainRoleId = readU32(rec, 0x14);
      model.curMap = readU32(rec, 0x18);
      model.bagExtraCap = readU32(rec, 0x28);
      model.coin = readU32(rec, 0x38);
      model.difficulty = rec[0x50];
      model.martialLvMaxBonus = rec[0x51];
      model.roleLvMaxBonus = rec[0x52];
      model.teamMax = rec[0x54];
      model.martialNumMax = rec[0x55];
      model.mainRoleName = decodeCString(rec, 0x5c, 32);
      model.forgeExp = readU32(rec, 0x88);
      model.reforgeExp = readU32(rec, 0x8c);
    } else {
      model.scriptId = 0;
      model.mainRoleId = 0;
      model.curMap = 0;
      model.bagExtraCap = 0;
      model.coin = 0;
      model.difficulty = 1;
      model.martialLvMaxBonus = 0;
      model.roleLvMaxBonus = 0;
      model.teamMax = 1;
      model.martialNumMax = 8;
      model.mainRoleName = '';
      model.forgeExp = 0;
      model.reforgeExp = 0;
    }

    model.maxIds = {};
    for (const rec of model.tables[MAXID_TABLE].records) {
      model.maxIds[readU32(rec, 0x10)] = readU32(rec, 0x14);
    }

    model.commonCurrencies = {};
    for (const currency of COMMON_CURRENCIES) {
      model.commonCurrencies[currency.id] = 0;
      for (const rec of model.tables[COMMON_FUNC_TABLE].records) {
        if (readU32(rec, 0x10) === currency.key && readU32(rec, 0x14) === currency.key) {
          model.commonCurrencies[currency.id] = readU32(rec, 0x18);
          break;
        }
      }
    }

    model.roles = [];
    const roleRecords = model.tables[ROLE_TABLE].records;
    for (let ri = 0; ri < roleRecords.length; ri++) {
      const rec = roleRecords[ri];
      const id = readU32(rec, 0x10);
      const templateId = readU32(rec, 0x14);
      const attrText = decodeCString(rec, 0x53, 256);
      const attrTokens = attrText.length ? attrText.split('|') : [];
      const attrs = ATTR_FIELDS.map((field) => {
        const token = attrTokens[field.index];
        const value = token !== undefined && token !== '' && Number.isFinite(Number(token))
          ? Number(token) : 0;
        return { index: field.index, key: field.key, label: field.label, value };
      });
      model.roles.push({
        id,
        templateId,
        exp: readU32(rec, 0x24),
        remainAttrPoint: readU16(rec, 0x48),
        eatFoodNum: rec[0x4e],
        eatFoodMaxNum: readU16(rec, 0x50),
        level: rec[0x52],
        isMain: id === model.mainRoleId,
        attrTokens,
        attrs,
        recordIndex: ri
      });
    }
    model.mainRole = model.roles.find((r) => r.isMain) || model.roles[0] || null;
    model.mainRoleTemplateId = model.mainRole ? model.mainRole.templateId : 0;
    model.attrs = model.mainRole
      ? { values: model.mainRole.attrTokens.slice(), fields: model.mainRole.attrs }
      : null;

    model.items = [];
    const itemRecords = model.tables[ITEM_TABLE].records;
    for (let ri = 0; ri < itemRecords.length; ri++) {
      const rec = itemRecords[ri];
      model.items.push({
        id: readU32(rec, 0x10),
        owner: readU32(rec, 0x14),
        baseId: readU32(rec, 0x18),
        count: readU32(rec, 0x1c),
        dueTime: readU32(rec, 0x20),
        flagA: rec[0x24],
        flagB: rec[0x25],
        recordIndex: ri
      });
    }

    model.martials = [];
    const martialRecords = model.tables[MARTIAL_TABLE].records;
    for (let ri = 0; ri < martialRecords.length; ri++) {
      const rec = martialRecords[ri];
      model.martials.push({
        id: readU32(rec, 0x10),
        roleId: readU32(rec, 0x14),
        level: readU32(rec, 0x18),
        exp: readU32(rec, 0x1c),
        baseId: readU32(rec, 0x20),
        recordIndex: ri
      });
    }

    model.gifts = [];
    const giftRecords = model.tables[GIFT_TABLE].records;
    for (let ri = 0; ri < giftRecords.length; ri++) {
      const rec = giftRecords[ri];
      model.gifts.push({
        id: readU32(rec, 0x10),
        baseId: readU32(rec, 0x14),
        roleId: readU32(rec, 0x18),
        flag: rec[0x1c],
        recordIndex: ri
      });
    }

    model.npcDispositions = [];
    const npcRecords = model.tables[NPC_CONTACT_TABLE].records;
    const target = model.mainRoleTemplateId || DEFAULT_NPC_TARGET;
    for (let ri = 0; ri < npcRecords.length; ri++) {
      const rec = npcRecords[ri];
      const pairCount = Math.min(3, readU32(rec, 0x18));
      for (let s = 0; s < pairCount; s++) {
        const off = 0x1c + s * 8;
        if (readU32(rec, off) === target) {
          model.npcDispositions.push({
            id: readU32(rec, 0x10),
            npcBaseId: readU32(rec, 0x14),
            slotIndex: s,
            disposition: readI32(rec, off + 4),
            recordIndex: ri
          });
        }
      }
    }
    return model;
  }

  function setHeaderField(model, field, value) {
    const map = { meridiansLvl: 0x2dc, achievePoint: 0x2e0 };
    if (!(field in map)) throw new Error('알 수 없는 머리말 항목입니다.');
    assertInt(value, 0, 2000000000, field === 'meridiansLvl' ? '경맥 등급' : '업적 점수');
    writeU32(model.headerBytes, map[field], value);
    return refreshDerived(model);
  }

  function getRequiredScriptRecord(model) {
    if (!model.tables[ROLE_SCRIPT_TABLE].records.length) {
      throw new Error('시나리오 진행 데이터가 없는 세이브입니다.');
    }
    return model.tables[ROLE_SCRIPT_TABLE].records[0];
  }

  function setScriptField(model, field, value) {
    const specs = {
      coin: { off: 0x38, min: 0, max: 2000000000, label: '동전' },
      bagExtraCap: { off: 0x28, min: 0, max: 99999, label: '배낭 추가 용량' },
      difficulty: { off: 0x50, min: 1, max: 25, label: '난이도', u8: true },
      martialLvMaxBonus: { off: 0x51, min: 0, max: 99, label: '무학 등급 상한 보너스', u8: true },
      roleLvMaxBonus: { off: 0x52, min: 0, max: 99, label: '레벨 상한 보너스', u8: true },
      teamMax: { off: 0x54, min: 1, max: 20, label: '출전 동료 상한', u8: true },
      martialNumMax: { off: 0x55, min: 0, max: 99, label: '무학 수량 상한', u8: true },
      forgeExp: { off: 0x88, min: 0, max: 2000000000, label: '제조 숙련도' },
      reforgeExp: { off: 0x8c, min: 0, max: 2000000000, label: '재주조 숙련도' }
    };
    const spec = specs[field];
    if (!spec) throw new Error('알 수 없는 시나리오 항목입니다.');
    assertInt(value, spec.min, spec.max, spec.label);
    const rec = getRequiredScriptRecord(model);
    if (spec.u8) rec[spec.off] = value;
    else writeU32(rec, spec.off, value);
    return refreshDerived(model);
  }

  function setMainRoleName(model, name) {
    if (typeof name !== 'string' || !name.trim().length) {
      throw new Error('주인공 이름은 비워둘 수 없습니다.');
    }
    const rec = getRequiredScriptRecord(model);
    writeCString(rec, 0x5c, 32, name, 30);
    return refreshDerived(model);
  }

  function resolveCurrency(keyOrId) {
    if (typeof keyOrId === 'number') {
      return COMMON_CURRENCIES.find((c) => c.key === keyOrId) || null;
    }
    if (typeof keyOrId === 'string') {
      return COMMON_CURRENCIES.find((c) => c.id === keyOrId) || null;
    }
    return null;
  }

  function setCommonCurrency(model, keyOrId, value) {
    const currency = resolveCurrency(keyOrId);
    if (!currency) throw new Error('알 수 없는 공용 재화입니다.');
    assertInt(value, 0, 2000000000, currency.label);
    const records = model.tables[COMMON_FUNC_TABLE].records;
    let target = -1;
    for (let i = 0; i < records.length; i++) {
      if (readU32(records[i], 0x10) === currency.key &&
        readU32(records[i], 0x14) === currency.key) {
        target = i;
        break;
      }
    }
    if (target >= 0) {
      writeU32(records[target], 0x18, value);
    } else {
      const rec = new Uint8Array(TABLE_SIZES[COMMON_FUNC_TABLE]);
      writeU32(rec, 0x10, currency.key);
      writeU32(rec, 0x14, currency.key);
      writeU32(rec, 0x18, value);
      let insertAt = records.length;
      for (let i = 0; i < records.length; i++) {
        if (readU32(records[i], 0x10) > 0x10000) {
          insertAt = i;
          break;
        }
      }
      records.splice(insertAt, 0, rec);
    }
    return refreshDerived(model);
  }

  function nextObjectId(model, objType, scanTableIdx) {
    assertInt(objType, 0, 0xffffffff, '객체 종류');
    if (!Number.isInteger(scanTableIdx) || scanTableIdx < 0 || scanTableIdx >= TABLE_COUNT) {
      throw new Error('검색 테이블 번호가 범위를 벗어났습니다.');
    }
    let max = 0;
    const maxRecords = model.tables[MAXID_TABLE].records;
    for (const rec of maxRecords) {
      if (readU32(rec, 0x10) === objType) max = Math.max(max, readU32(rec, 0x14));
    }
    for (const rec of model.tables[scanTableIdx].records) {
      max = Math.max(max, readU32(rec, 0x10));
    }
    if (max >= 0xffffffff) {
      throw new Error('객체 고유번호 상한을 초과했습니다.');
    }
    const newId = max + 1;
    let found = false;
    for (const rec of maxRecords) {
      if (readU32(rec, 0x10) === objType) {
        writeU32(rec, 0x14, newId);
        found = true;
        break;
      }
    }
    if (!found) {
      const rec = new Uint8Array(TABLE_SIZES[MAXID_TABLE]);
      writeU32(rec, 0x10, objType);
      writeU32(rec, 0x14, newId);
      maxRecords.push(rec);
    }
    refreshDerived(model);
    return newId;
  }

  function setRoleMeta(model, roleId, field, value) {
    const specs = {
      level: { off: 0x52, min: 1, max: 99, u8: true, label: '레벨' },
      exp: { off: 0x24, min: 0, max: 2000000000, label: '경험치' },
      remainAttrPoint: { off: 0x48, min: 0, max: 60000, u16: true, label: '남은 능력치 포인트' },
      eatFoodMaxNum: { off: 0x50, min: 0, max: 60000, u16: true, label: '음식 섭취 상한' }
    };
    const spec = specs[field];
    if (!spec) throw new Error('알 수 없는 인물 항목입니다.');
    assertInt(value, spec.min, spec.max, spec.label);
    const records = model.tables[ROLE_TABLE].records;
    const idx = findRecordIndexById(records, roleId);
    if (idx < 0) throw new Error('인물 레코드를 찾지 못했습니다.');
    const rec = records[idx];
    if (spec.u8) rec[spec.off] = value;
    else if (spec.u16) writeU16(rec, spec.off, value);
    else writeU32(rec, spec.off, value);
    return refreshDerived(model);
  }

  function writeAttrTokenString(rec, attrTokens) {
    const text = attrTokens.join('|');
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > 0x7f) throw new Error('능력치 문자열은 아스키 문자만 사용할 수 있습니다.');
      bytes.push(code);
    }
    if (bytes.length > 255) throw new Error('능력치 문자열은 255바이트 이하여야 합니다.');
    rec.fill(0, 0x53, 0x153);
    rec.set(bytes, 0x53);
  }

  function setRoleAttr(model, roleId, attrIndex, value) {
    assertInt(attrIndex, 0, 255, '능력치 번호');
    assertInt(value, 0, 2000000000, '능력치 값');
    const records = model.tables[ROLE_TABLE].records;
    const idx = findRecordIndexById(records, roleId);
    if (idx < 0) throw new Error('인물 레코드를 찾지 못했습니다.');
    const rec = records[idx];
    const text = decodeCString(rec, 0x53, 256);
    const tokens = text.length ? text.split('|') : [];
    if (attrIndex >= tokens.length) throw new Error('능력치 토큰 수를 바꿀 수 없습니다.');
    tokens[attrIndex] = String(value);
    writeAttrTokenString(rec, tokens);
    return refreshDerived(model);
  }

  function setAttr(model, attrIndex, value) {
    if (!model.mainRole) throw new Error('주인공 인물 레코드가 없습니다.');
    return setRoleAttr(model, model.mainRole.id, attrIndex, value);
  }

  function setItemCount(model, itemId, count) {
    assertInt(count, 1, 999999, '물품 수량');
    const records = model.tables[ITEM_TABLE].records;
    const idx = findRecordIndexById(records, itemId);
    if (idx < 0) throw new Error('물품 레코드를 찾지 못했습니다.');
    writeU32(records[idx], 0x1c, count);
    return refreshDerived(model);
  }

  function addItem(model, baseId, count, owner) {
    const resolvedOwner = owner === undefined || owner === null ? (model.mainRoleId || 0) : owner;
    assertInt(baseId, 1, 0xffffffff, '물품 기본 번호');
    assertInt(count, 1, 999999, '물품 수량');
    assertInt(resolvedOwner, 0, 0xffffffff, '물품 소유자');
    const newId = nextObjectId(model, ITEM_OBJ_TYPE, ITEM_TABLE);
    const rec = new Uint8Array(TABLE_SIZES[ITEM_TABLE]);
    const existing = model.tables[ITEM_TABLE].records.find((r) => readU32(r, 0x14) === resolvedOwner);
    if (existing) {
      rec[0x24] = existing[0x24];
      rec[0x25] = existing[0x25];
    } else if (resolvedOwner > 0) {
      rec[0x24] = 2;
      rec[0x25] = 2;
    }
    writeU32(rec, 0x10, newId);
    writeU32(rec, 0x14, resolvedOwner);
    writeU32(rec, 0x18, baseId);
    writeU32(rec, 0x1c, count);
    model.tables[ITEM_TABLE].records.push(rec);
    refreshDerived(model);
    return newId;
  }

  function removeItem(model, itemId) {
    const records = model.tables[ITEM_TABLE].records;
    const idx = findRecordIndexById(records, itemId);
    if (idx < 0) throw new Error('물품 레코드를 찾지 못했습니다.');
    records.splice(idx, 1);
    return refreshDerived(model);
  }

  function setMartial(model, martialId, patch) {
    const records = model.tables[MARTIAL_TABLE].records;
    const idx = findRecordIndexById(records, martialId);
    if (idx < 0) throw new Error('무학 레코드를 찾지 못했습니다.');
    const rec = records[idx];
    if (patch && patch.level !== undefined) {
      assertInt(patch.level, 1, 30, '무학 등급');
      writeU32(rec, 0x18, patch.level);
    }
    if (patch && patch.exp !== undefined) {
      assertInt(patch.exp, 0, 2000000000, '무학 경험치');
      writeU32(rec, 0x1c, patch.exp);
    }
    return refreshDerived(model);
  }

  function addMartial(model, baseId, level, roleId) {
    const resolvedRole = roleId === undefined || roleId === null ? (model.mainRoleId || 8) : roleId;
    const resolvedLv = level === undefined || level === null ? 1 : level;
    assertInt(baseId, 1, 0xffffffff, '무학 기본 번호');
    assertInt(resolvedLv, 1, 30, '무학 등급');
    assertInt(resolvedRole, 0, 0xffffffff, '무학 소유 인물');
    const newId = nextObjectId(model, MARTIAL_OBJ_TYPE, MARTIAL_TABLE);
    const rec = new Uint8Array(TABLE_SIZES[MARTIAL_TABLE]);
    writeU32(rec, 0x10, newId);
    writeU32(rec, 0x14, resolvedRole);
    writeU32(rec, 0x18, resolvedLv);
    writeU32(rec, 0x20, baseId);
    rec[0x2c] = 2;
    rec[0x2d] = 2;
    rec[0x2e] = 0;
    rec[0x2f] = 6;
    model.tables[MARTIAL_TABLE].records.push(rec);
    refreshDerived(model);
    return newId;
  }

  function removeMartial(model, martialId) {
    const records = model.tables[MARTIAL_TABLE].records;
    const idx = findRecordIndexById(records, martialId);
    if (idx < 0) throw new Error('무학 레코드를 찾지 못했습니다.');
    records.splice(idx, 1);
    return refreshDerived(model);
  }

  function addGift(model, baseId, roleId) {
    const resolvedRole = roleId === undefined || roleId === null ? (model.mainRoleId || 8) : roleId;
    assertInt(baseId, 1, 0xffffffff, '천부 기본 번호');
    assertInt(resolvedRole, 0, 0xffffffff, '천부 소유 인물');
    const newId = nextObjectId(model, GIFT_OBJ_TYPE, GIFT_TABLE);
    const rec = new Uint8Array(TABLE_SIZES[GIFT_TABLE]);
    writeU32(rec, 0x10, newId);
    writeU32(rec, 0x14, baseId);
    writeU32(rec, 0x18, resolvedRole);
    rec[0x1c] = 2;
    model.tables[GIFT_TABLE].records.push(rec);
    refreshDerived(model);
    return newId;
  }

  function removeGift(model, giftId) {
    const records = model.tables[GIFT_TABLE].records;
    const idx = findRecordIndexById(records, giftId);
    if (idx < 0) throw new Error('천부 레코드를 찾지 못했습니다.');
    records.splice(idx, 1);
    return refreshDerived(model);
  }

  function setNpcDisposition(model, contactId, slotIndex, value) {
    assertInt(slotIndex, 0, 2, '호감도 슬롯 번호');
    assertInt(value, -100, 100, '호감도');
    const records = model.tables[NPC_CONTACT_TABLE].records;
    const idx = findRecordIndexById(records, contactId);
    if (idx < 0) throw new Error('인물 호감도 레코드를 찾지 못했습니다.');
    const rec = records[idx];
    const pairCount = Math.min(3, readU32(rec, 0x18));
    if (slotIndex >= pairCount) throw new Error('호감도 슬롯 번호가 범위를 벗어났습니다.');
    writeI32(rec, 0x1c + slotIndex * 8 + 4, value);
    return refreshDerived(model);
  }

  function setAllNpcDispositions(model, value) {
    assertInt(value, -100, 100, '호감도');
    const target = model.mainRoleTemplateId || DEFAULT_NPC_TARGET;
    const records = model.tables[NPC_CONTACT_TABLE].records;
    for (const rec of records) {
      const pairCount = Math.min(3, readU32(rec, 0x18));
      for (let s = 0; s < pairCount; s++) {
        const off = 0x1c + s * 8;
        if (readU32(rec, off) === target) {
          writeI32(rec, off + 4, value);
        }
      }
    }
    return refreshDerived(model);
  }

  function listRecords(model, tableIdx) {
    if (!Number.isInteger(tableIdx) || tableIdx < 0 || tableIdx >= TABLE_COUNT) {
      throw new Error('테이블 번호가 범위를 벗어났습니다.');
    }
    const table = model.tables[tableIdx];
    return table.records.map((rec, recordIndex) => {
      const u32 = [];
      for (let off = 0x10; off + 4 <= rec.length; off += 4) u32.push(readU32(rec, off));
      return { recordIndex, key: readU32(rec, 0x10), u32 };
    });
  }

  function getU32(model, tableIdx, recordIndex, byteOffset) {
    if (!Number.isInteger(tableIdx) || tableIdx < 0 || tableIdx >= TABLE_COUNT) {
      throw new Error('테이블 번호가 범위를 벗어났습니다.');
    }
    const rec = model.tables[tableIdx].records[recordIndex];
    if (!rec) throw new Error('레코드 번호가 범위를 벗어났습니다.');
    if (!Number.isInteger(byteOffset) || byteOffset < 0 || byteOffset + 4 > rec.length) {
      throw new Error('바이트 위치가 범위를 벗어났습니다.');
    }
    return readU32(rec, byteOffset);
  }

  function setU32(model, tableIdx, recordIndex, byteOffset, value) {
    if (!Number.isInteger(tableIdx) || tableIdx < 0 || tableIdx >= TABLE_COUNT) {
      throw new Error('테이블 번호가 범위를 벗어났습니다.');
    }
    const rec = model.tables[tableIdx].records[recordIndex];
    if (!rec) throw new Error('레코드 번호가 범위를 벗어났습니다.');
    if (!Number.isInteger(byteOffset) || byteOffset < 0x10 || byteOffset % 4 !== 0 ||
      byteOffset + 4 > rec.length) {
      throw new Error('바이트 위치는 0x10 이상이며 4의 배수여야 합니다.');
    }
    assertInt(value, 0, 0xffffffff, '32비트 부호 없는 정수');
    writeU32(rec, byteOffset, value);
    return refreshDerived(model);
  }

  function createDemoSave() {
    const model = {
      headerBytes: new Uint8Array(HEADER_SIZE),
      tables: []
    };
    for (let i = 0; i < TABLE_COUNT; i++) {
      model.tables.push({
        index: i,
        recordSize: TABLE_SIZES[i],
        nameKo: tableName(i),
        records: []
      });
    }
    const hb = model.headerBytes;
    hb.set(ENCODER.encode('Player1'), 0x10);
    writeU32(hb, 0x9c, 7);
    writeU32(hb, 0x2dc, 5);
    writeU32(hb, 0x2e0, 1200);
    writeU16(hb, 0x40, 2026);
    writeU16(hb, 0x42, 11);
    hb[0x44] = 18;
    hb[0x45] = 10;
    writeU16(hb, 0x50, 2026);
    writeU16(hb, 0x52, 11);
    hb[0x54] = 18;
    hb[0x55] = 12;

    const script = new Uint8Array(TABLE_SIZES[ROLE_SCRIPT_TABLE]);
    writeU32(script, 0x10, 2);
    writeU32(script, 0x14, 8);
    writeU32(script, 0x18, 60);
    writeU32(script, 0x28, 50);
    writeU32(script, 0x38, 1500);
    script[0x50] = 1;
    script[0x51] = 2;
    script[0x52] = 2;
    script[0x54] = 5;
    script[0x55] = 10;
    script.set(ENCODER.encode('소하'), 0x5c);
    writeU32(script, 0x88, 100);
    writeU32(script, 0x8c, 50);
    model.tables[ROLE_SCRIPT_TABLE].records.push(script);

    const role = new Uint8Array(TABLE_SIZES[ROLE_TABLE]);
    writeU32(role, 0x10, 8);
    writeU32(role, 0x14, DEFAULT_NPC_TARGET);
    writeU32(role, 0x24, 200);
    writeU16(role, 0x48, 10);
    role[0x4e] = 0;
    writeU16(role, 0x50, 10);
    role[0x52] = 5;
    role.set(
      ENCODER.encode('5200|1100|150|5|5|5|5|5|5|1|1|850|80|120|75|60|30|25|70|90|10000|1000|2500|90|10000|3'),
      0x53
    );
    model.tables[ROLE_TABLE].records.push(role);

    refreshDerived(model);
    addItem(model, 1001, 5, 8);
    addItem(model, 1106, 3, 8);
    addItem(model, 70108, 1, 8);
    addMartial(model, 12213, 3, 8);
    addMartial(model, 12214, 2, 8);
    addGift(model, 332, 8);
    addGift(model, 127, 8);

    const npcBases = [1020101001, 1020101004];
    const dispositions = [50, 30];
    for (let i = 0; i < 2; i++) {
      const rec = new Uint8Array(TABLE_SIZES[NPC_CONTACT_TABLE]);
      writeU32(rec, 0x10, i + 1);
      writeU32(rec, 0x14, npcBases[i]);
      writeU32(rec, 0x18, 1);
      writeU32(rec, 0x1c, DEFAULT_NPC_TARGET);
      writeI32(rec, 0x20, dispositions[i]);
      model.tables[NPC_CONTACT_TABLE].records.push(rec);
    }

    setCommonCurrency(model, 'silver', 500);
    setCommonCurrency(model, 'gold', 100);
    setCommonCurrency(model, 'refinedIron', 20);
    return serialize(model);
  }

  return {
    HEADER_SIZE,
    TABLE_COUNT,
    MAX_RECORDS,
    TABLE_SIZES,
    TABLE_NAMES_KO,
    COMMON_CURRENCIES,
    ATTR_FIELDS,
    ROLE_SCRIPT_TABLE,
    MAXID_TABLE,
    ROLE_TABLE,
    ITEM_TABLE,
    MARTIAL_TABLE,
    NPC_CONTACT_TABLE,
    GIFT_TABLE,
    COMMON_FUNC_TABLE,
    ITEM_OBJ_TYPE,
    MARTIAL_OBJ_TYPE,
    GIFT_OBJ_TYPE,
    DEFAULT_NPC_TARGET,
    validate,
    parse,
    serialize,
    refreshDerived,
    setHeaderField,
    setScriptField,
    setMainRoleName,
    setCommonCurrency,
    nextObjectId,
    setRoleMeta,
    setRoleAttr,
    setAttr,
    setItemCount,
    addItem,
    removeItem,
    setMartial,
    addMartial,
    removeMartial,
    addGift,
    removeGift,
    setNpcDisposition,
    setAllNpcDispositions,
    listRecords,
    getU32,
    setU32,
    createDemoSave
  };
});
