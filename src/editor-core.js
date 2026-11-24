(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['./myjh-codec', './catalog-data'], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./myjh-codec'), require('./catalog-data'));
  } else {
    root.MyjhEditorCore = factory(root.MyjhCodec, root.MYJH_CATALOG);
  }
}(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function (MyjhCodec, catalog) {
  'use strict';

  catalog = catalog || {};
  var itemList = Array.isArray(catalog.items) ? catalog.items : [];
  var martialList = Array.isArray(catalog.martials) ? catalog.martials : [];
  var giftList = Array.isArray(catalog.gifts) ? catalog.gifts : [];
  var roleMap = catalog.roles || {};

  function makeIdMap(list) {
    var map = Object.create(null);
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      if (entry && entry.id != null) {
        map[String(entry.id)] = entry;
      }
    }
    return map;
  }

  var itemMap = makeIdMap(itemList);
  var martialMap = makeIdMap(martialList);
  var giftMap = makeIdMap(giftList);

  function getItemMeta(baseId) {
    var raw = itemMap[String(baseId)];
    if (!raw) {
      return { id: baseId, name: '미등록 물품 #' + baseId, rank: '일반', type: '기타', maxNum: 9999, limitNum: 9900 };
    }
    var maxNum = raw.maxNum == null ? 9999 : Number(raw.maxNum);
    if (!isFinite(maxNum) || maxNum <= 0) maxNum = 9999;
    var limitNum = raw.limitNum == null ? 9900 : Number(raw.limitNum);
    if (!isFinite(limitNum) || limitNum <= 0) limitNum = 9900;
    return {
      id: raw.id == null ? baseId : raw.id,
      name: raw.name == null ? '물품 #' + baseId : String(raw.name),
      rank: raw.rank == null ? '일반' : String(raw.rank),
      type: raw.type == null ? '기타' : String(raw.type),
      maxNum: maxNum,
      limitNum: limitNum
    };
  }

  function getMartialMeta(baseId) {
    var raw = martialMap[String(baseId)];
    if (!raw) {
      return { id: baseId, name: '미등록 무학 #' + baseId, rank: '일반', depart: '내공' };
    }
    return {
      id: raw.id == null ? baseId : raw.id,
      name: raw.name == null ? '무학 #' + baseId : String(raw.name),
      rank: raw.rank == null ? '일반' : String(raw.rank),
      depart: raw.depart == null ? '내공' : String(raw.depart)
    };
  }

  function getGiftMeta(baseId) {
    var raw = giftMap[String(baseId)];
    if (!raw) {
      return { id: baseId, name: '미등록 천부 #' + baseId, rank: '일반' };
    }
    return {
      id: raw.id == null ? baseId : raw.id,
      name: raw.name == null ? '천부 #' + baseId : String(raw.name),
      rank: raw.rank == null ? '일반' : String(raw.rank)
    };
  }

  function getRoleName(roleIdOrTpl) {
    if (roleIdOrTpl == null) return '';
    var name = roleMap[String(roleIdOrTpl)];
    return name == null ? '인물 #' + roleIdOrTpl : String(name);
  }

  function searchCatalog(kind, query, filter, limit) {
    var list = kind === 'items' ? itemList : (kind === 'martials' ? martialList : (kind === 'gifts' ? giftList : []));
    var q = query == null ? '' : String(query).trim().toLowerCase();
    var max = Number(limit) || 100;
    if (!isFinite(max) || max < 1) max = 100;
    var field = kind === 'items' ? 'type' : (kind === 'martials' ? 'depart' : 'rank');
    var f = filter == null ? '' : String(filter).trim().toLowerCase();
    var out = [];
    for (var i = 0; i < list.length && out.length < max; i += 1) {
      var entry = list[i];
      if (!entry) continue;
      var idText = String(entry.id);
      var nameText = String(entry.name == null ? '' : entry.name).toLowerCase();
      var hitName = q === '' || nameText.indexOf(q) !== -1;
      var hitId = q === '' || idText === q || idText.indexOf(q) === 0;
      if (!hitName && !hitId) continue;
      if (f !== '' && String(entry[field] == null ? '' : entry[field]).toLowerCase() !== f) continue;
      out.push(entry);
    }
    return out;
  }

  function cloneBytes(bytes) {
    var src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    var out = new Uint8Array(src.length);
    out.set(src);
    return out;
  }

  function pad2(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function formatSaveTime(st) {
    if (!st) return '-';
    if (typeof st === 'string') return st;
    if (typeof st === 'object' && st.year) {
      return st.year + '-' + pad2(st.month || 1) + '-' + pad2(st.day || 1) +
        ' ' + pad2(st.hour || 0) + ':' + pad2(st.minute || 0) + ':' + pad2(st.second || 0);
    }
    return '-';
  }

  function countTables(model) {
    var tables = model && Array.isArray(model.tables) ? model.tables : [];
    var nonEmpty = 0;
    var records = 0;
    for (var i = 0; i < tables.length; i += 1) {
      var rows = tables[i] && Array.isArray(tables[i].records) ? tables[i].records : [];
      if (rows.length > 0) nonEmpty += 1;
      records += rows.length;
    }
    return { tableCount: nonEmpty, recordCount: records };
  }

  function computeStorageOverflows(model) {
    var list = model && Array.isArray(model.items) ? model.items : [];
    var totals = Object.create(null);
    var order = [];
    for (var i = 0; i < list.length; i += 1) {
      var row = list[i];
      if (!row || Number(row.owner) !== 0) continue;
      var key = String(row.baseId);
      if (!totals[key]) {
        totals[key] = { baseId: row.baseId, total: 0, recordIds: [] };
        order.push(key);
      }
      var cnt = Number(row.count);
      if (!isFinite(cnt) || cnt < 0) cnt = 0;
      totals[key].total += cnt;
      totals[key].recordIds.push(row.id);
    }
    var out = [];
    for (var j = 0; j < order.length; j += 1) {
      var agg = totals[order[j]];
      var meta = getItemMeta(agg.baseId);
      if (agg.total > meta.limitNum) {
        out.push({
          baseId: agg.baseId,
          name: meta.name,
          total: agg.total,
          limitNum: meta.limitNum,
          recordIds: agg.recordIds
        });
      }
    }
    return out;
  }

  function enrichItems(model) {
    var list = model && Array.isArray(model.items) ? model.items : [];
    var overflows = computeStorageOverflows(model);
    var overflowMap = Object.create(null);
    for (var i = 0; i < overflows.length; i += 1) {
      overflowMap[String(overflows[i].baseId)] = true;
    }
    var mainId = model && model.mainRoleId ? Number(model.mainRoleId) : 0;
    return list.map(function (row) {
      var meta = getItemMeta(row.baseId);
      var ownerNum = Number(row.owner) || 0;
      var isStorage = ownerNum === 0;
      var ownerLabel = isStorage
        ? '계정 창고'
        : (mainId > 0 && ownerNum === mainId ? '주인공 배낭' : '소유 #' + ownerNum);
      return {
        id: row.id,
        baseId: row.baseId,
        name: meta.name,
        rank: meta.rank,
        type: meta.type,
        maxNum: meta.maxNum,
        limitNum: meta.limitNum,
        count: row.count,
        owner: row.owner,
        isStorage: isStorage,
        ownerLabel: ownerLabel,
        exceedsLimit: isStorage && overflowMap[String(row.baseId)] === true
      };
    });
  }

  function enrichMartials(model) {
    var list = model && Array.isArray(model.martials) ? model.martials : [];
    return list.map(function (row) {
      var meta = getMartialMeta(row.baseId);
      return {
        id: row.id,
        baseId: row.baseId,
        name: meta.name,
        rank: meta.rank,
        depart: meta.depart,
        level: row.level,
        exp: row.exp,
        roleId: row.roleId
      };
    });
  }

  function enrichGifts(model) {
    var list = model && Array.isArray(model.gifts) ? model.gifts : [];
    return list.map(function (row) {
      var meta = getGiftMeta(row.baseId);
      return {
        id: row.id,
        baseId: row.baseId,
        name: meta.name,
        rank: meta.rank,
        roleId: row.roleId
      };
    });
  }

  function enrichNpcs(model) {
    var list = model && Array.isArray(model.npcDispositions) ? model.npcDispositions : [];
    return list.map(function (row) {
      return {
        id: row.id,
        npcBaseId: row.npcBaseId,
        name: getRoleName(row.npcBaseId),
        slotIndex: row.slotIndex,
        disposition: row.disposition
      };
    });
  }

  function createSession() {
    var session = {};
    var originalBytes = new Uint8Array(0);
    var model = null;
    var fileName = '';
    var dirty = false;
    var slotId = null;
    var sha256 = null;

    function requireModel() {
      if (!model) throw new Error('불러온 세이브 데이터가 없습니다.');
      return model;
    }

    session.loadBytes = function (bytes, meta) {
      var src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
      originalBytes = cloneBytes(src);
      model = MyjhCodec.parse(src);
      fileName = meta && meta.fileName != null ? String(meta.fileName) : 'Save.sav';
      slotId = meta && meta.slotId != null ? meta.slotId : null;
      sha256 = meta && meta.sha256 != null ? String(meta.sha256) : null;
      dirty = false;
      return session.getSummary();
    };

    session.loadDemo = function () {
      var bytes = MyjhCodec.createDemoSave();
      return session.loadBytes(bytes, { fileName: 'Save.sav' });
    };

    session.reset = function () {
      if (!originalBytes.length) throw new Error('원본 세이브 데이터가 없습니다.');
      model = MyjhCodec.parse(originalBytes);
      dirty = false;
      return session.getSummary();
    };

    session.isLoaded = function () { return !!model; };
    session.isDirty = function () { return dirty; };
    session.getModel = function () { return model; };
    session.getMeta = function () {
      return { fileName: fileName, slotId: slotId, sha256: sha256, dirty: dirty };
    };
    session.markSaved = function (newBytes, newSha256) {
      if (newBytes) originalBytes = cloneBytes(newBytes);
      if (newSha256 != null) sha256 = String(newSha256);
      dirty = false;
    };

    session.getSummary = function () {
      var m = requireModel();
      var counts = countTables(m);
      var serialized = MyjhCodec.serialize(m);
      return {
        fileName: fileName,
        slotId: slotId,
        sha256: sha256,
        dirty: dirty,
        byteSize: serialized.length,
        saveTime: formatSaveTime(m.saveTime),
        tableCount: counts.tableCount,
        recordCount: counts.recordCount,
        hasScript: m.hasScript,
        accountName: m.accountName,
        mainRoleName: m.mainRoleName,
        mainRoleId: m.mainRoleId,
        coin: m.coin,
        commonCurrencies: m.commonCurrencies,
        mainRole: m.mainRole,
        roles: m.roles,
        items: enrichItems(m),
        storageOverflows: computeStorageOverflows(m),
        martials: enrichMartials(m),
        gifts: enrichGifts(m),
        npcs: enrichNpcs(m)
      };
    };

    session.toBytes = function () {
      var out = MyjhCodec.serialize(requireModel());
      var check = MyjhCodec.validate(out);
      if (!check.ok) throw new Error(check.errors.join(' '));
      return out;
    };

    session.setHeaderField = function (field, value) {
      MyjhCodec.setHeaderField(requireModel(), field, Number(value));
      dirty = true;
      return model;
    };

    session.setScriptField = function (field, value) {
      MyjhCodec.setScriptField(requireModel(), field, Number(value));
      dirty = true;
      return model;
    };

    session.setMainRoleName = function (name) {
      MyjhCodec.setMainRoleName(requireModel(), String(name));
      dirty = true;
      return model;
    };

    session.setCommonCurrency = function (keyOrId, value) {
      MyjhCodec.setCommonCurrency(requireModel(), keyOrId, Number(value));
      dirty = true;
      return model;
    };

    session.setRoleMeta = function (roleId, field, value) {
      MyjhCodec.setRoleMeta(requireModel(), Number(roleId), field, Number(value));
      dirty = true;
      return model;
    };

    session.setRoleAttr = function (roleId, attrIndex, value) {
      MyjhCodec.setRoleAttr(requireModel(), Number(roleId), Number(attrIndex), Number(value));
      dirty = true;
      return model;
    };

    session.setItemCount = function (itemId, count) {
      MyjhCodec.setItemCount(requireModel(), Number(itemId), Number(count));
      dirty = true;
      return model;
    };

    session.addItem = function (baseId, count, owner) {
      var id = MyjhCodec.addItem(requireModel(), Number(baseId), Number(count), owner == null ? undefined : Number(owner));
      dirty = true;
      return id;
    };

    session.removeItem = function (itemId) {
      MyjhCodec.removeItem(requireModel(), Number(itemId));
      dirty = true;
      return model;
    };

    session.getStorageOverflows = function () {
      return computeStorageOverflows(requireModel());
    };

    session.fixStorageOverflows = function () {
      var m = requireModel();
      var overflows = computeStorageOverflows(m);
      var fixedItems = 0;
      var removedRecords = 0;
      var details = [];
      var changed = false;
      for (var i = 0; i < overflows.length; i += 1) {
        var ov = overflows[i];
        var rows = m.items.filter(function (row) {
          return Number(row.owner) === 0 && Number(row.baseId) === Number(ov.baseId);
        }).map(function (row) {
          return { id: row.id, count: Number(row.count) || 0 };
        });
        var remain = ov.limitNum;
        var itemChanged = false;
        for (var j = 0; j < rows.length; j += 1) {
          var row = rows[j];
          var keep = Math.min(row.count, remain);
          remain -= keep;
          if (keep === row.count) continue;
          changed = true;
          itemChanged = true;
          if (keep <= 0) {
            MyjhCodec.removeItem(m, row.id);
            removedRecords += 1;
          } else {
            MyjhCodec.setItemCount(m, row.id, keep);
          }
        }
        if (itemChanged) {
          fixedItems += 1;
          details.push({
            baseId: ov.baseId,
            name: ov.name,
            totalBefore: ov.total,
            totalAfter: ov.limitNum,
            limitNum: ov.limitNum
          });
        }
      }
      if (changed) dirty = true;
      return { fixedItems: fixedItems, removedRecords: removedRecords, details: details };
    };

    session.setMartial = function (martialId, patch) {
      MyjhCodec.setMartial(requireModel(), Number(martialId), patch);
      dirty = true;
      return model;
    };

    session.addMartial = function (baseId, level, roleId) {
      var id = MyjhCodec.addMartial(requireModel(), Number(baseId), Number(level) || 1, roleId == null ? undefined : Number(roleId));
      dirty = true;
      return id;
    };

    session.removeMartial = function (martialId) {
      MyjhCodec.removeMartial(requireModel(), Number(martialId));
      dirty = true;
      return model;
    };

    session.addGift = function (baseId, roleId) {
      var id = MyjhCodec.addGift(requireModel(), Number(baseId), roleId == null ? undefined : Number(roleId));
      dirty = true;
      return id;
    };

    session.removeGift = function (giftId) {
      MyjhCodec.removeGift(requireModel(), Number(giftId));
      dirty = true;
      return model;
    };

    session.setNpcDisposition = function (contactId, slotIndex, value) {
      MyjhCodec.setNpcDisposition(requireModel(), Number(contactId), Number(slotIndex), Number(value));
      dirty = true;
      return model;
    };

    session.setAllNpcDispositions = function (value) {
      MyjhCodec.setAllNpcDispositions(requireModel(), Number(value));
      dirty = true;
      return model;
    };

    session.setRawU32 = function (tableIdx, recordIndex, byteOffset, value) {
      MyjhCodec.setU32(requireModel(), Number(tableIdx), Number(recordIndex), Number(byteOffset), Number(value));
      dirty = true;
      return model;
    };

    session.applyPreset = function (presetId) {
      var m = requireModel();
      if (presetId === 'rich_resources') {
        if (m.hasScript) {
          MyjhCodec.setScriptField(m, 'coin', Math.max(m.coin, 9999999));
          MyjhCodec.setScriptField(m, 'bagExtraCap', Math.max(m.bagExtraCap, 500));
          MyjhCodec.setScriptField(m, 'martialLvMaxBonus', Math.max(m.martialLvMaxBonus, 20));
          MyjhCodec.setScriptField(m, 'roleLvMaxBonus', Math.max(m.roleLvMaxBonus, 30));
          MyjhCodec.setScriptField(m, 'martialNumMax', Math.max(m.martialNumMax, 30));
        }
        var currencies = {
          silver: 999999,
          gold: 999999,
          refinedIron: 99999,
          perfectPowder: 99999,
          heavenHammer: 99999,
          tonglingyu: 99999,
          lowIncomplete: 99999,
          midIncomplete: 99999,
          highIncomplete: 99999
        };
        Object.keys(currencies).forEach(function (cid) {
          var cur = (m.commonCurrencies && m.commonCurrencies[cid]) || 0;
          MyjhCodec.setCommonCurrency(m, cid, Math.max(cur, currencies[cid]));
        });
        dirty = true;
        return model;
      }
      if (presetId === 'max_role_stats') {
        var role = m.mainRole;
        if (role) {
          var rid = role.id;
          MyjhCodec.setRoleMeta(m, rid, 'level', Math.max(role.level, 30));
          MyjhCodec.setRoleMeta(m, rid, 'remainAttrPoint', Math.max(role.remainAttrPoint, 500));
          MyjhCodec.setRoleMeta(m, rid, 'eatFoodMaxNum', Math.max(role.eatFoodMaxNum, 999));
          var targets = { 0: 99999, 1: 99999, 2: 9999, 11: 9999 };
          [3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19].forEach(function (idx) {
            targets[idx] = 999;
          });
          Object.keys(targets).forEach(function (k) {
            var idx = Number(k);
            var curVal = Number(m.mainRole.attrTokens[idx]) || 0;
            if (idx < m.mainRole.attrTokens.length) {
              MyjhCodec.setRoleAttr(m, rid, idx, Math.max(curVal, targets[idx]));
            }
          });
        }
        dirty = true;
        return model;
      }
      if (presetId === 'all_martials_lv30') {
        m.martials.slice().forEach(function (row) {
          MyjhCodec.setMartial(m, row.id, { level: 30 });
        });
        dirty = true;
        return model;
      }
      if (presetId === 'all_npcs_100') {
        MyjhCodec.setAllNpcDispositions(m, 100);
        dirty = true;
        return model;
      }
      throw new Error('알 수 없는 빠른 설정입니다: ' + presetId);
    };

    return session;
  }

  var PRESETS = [
    { id: 'rich_resources', label: '풍족한 강호행', desc: '동전·은자·금자·재료·잔문과 배낭·무학 상한을 대폭 확장합니다.' },
    { id: 'max_role_stats', label: '주인공 능력치 극대화', desc: '생명력·진기·방어 및 6대 1차 속성·8대 무학 정통을 999 이상으로 끌어올립니다.' },
    { id: 'all_martials_lv30', label: '보유 무학 30레벨 달성', desc: '현재 보유한 모든 무학의 레벨을 30으로 설정합니다.' },
    { id: 'all_npcs_100', label: '모든 인연 호감도 100', desc: '등장 인물의 주인공 호감도를 모두 100으로 설정합니다.' }
  ];

  return {
    PRESETS: PRESETS,
    Codec: MyjhCodec,
    Catalog: catalog,
    createSession: createSession,
    getItemMeta: getItemMeta,
    getMartialMeta: getMartialMeta,
    getGiftMeta: getGiftMeta,
    getRoleName: getRoleName,
    searchCatalog: searchCatalog
  };
}));
