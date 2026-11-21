(function () {
  'use strict';

  const Codec = window.MyjhCodec;
  const Core = window.MyjhEditorCore;
  const Catalog = window.MYJH_CATALOG || {};
  if (!Codec || !Core) return;

  const session = Core.createSession();
  let currentPath = '';
  let selectedRoleId = null;
  let rawTable = 0;
  let rawPage = 0;
  let catalogKind = 'items';
  let catalogFilter = '';
  const CATALOG_LIMIT = 100;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : (fallback || 0);
  }

  function bytesToBase64(bytes) {
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function base64ToBytes(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toast(msg, kind) {
    const host = $('#toast-host');
    if (!host) return;
    const cls = 'toast' + (kind === 'error' ? ' error' : (kind === 'ok' ? ' ok' : ''));
    const t = el('div', cls, msg);
    host.appendChild(t);
    setTimeout(() => { if (t.parentNode) t.parentNode.removeChild(t); }, kind === 'error' ? 4600 : 3000);
  }

  function safeRun(fn, onErrorRevert) {
    try {
      return fn();
    } catch (e) {
      if (typeof onErrorRevert === 'function') onErrorRevert();
      toast((e && e.message) ? e.message : String(e), 'error');
      return undefined;
    }
  }

  function applyTheme(theme) {
    const meta = $('meta[name="color-scheme"]');
    if (theme === 'dark' || theme === 'light') {
      document.documentElement.dataset.theme = theme;
      if (meta) meta.setAttribute('content', theme);
      try { localStorage.setItem('myjh-theme', theme); } catch (e) { /* ignore */ }
    } else {
      delete document.documentElement.dataset.theme;
      if (meta) meta.setAttribute('content', 'light dark');
      try { localStorage.removeItem('myjh-theme'); } catch (e) { /* ignore */ }
    }
  }

  function initTheme() {
    let stored = null;
    try { stored = localStorage.getItem('myjh-theme'); } catch (e) { stored = null; }
    if (stored === 'dark' || stored === 'light') applyTheme(stored);
  }

  function toggleTheme() {
    const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const curAttr = document.documentElement.dataset.theme;
    const isDarkNow = curAttr ? (curAttr === 'dark') : sysDark;
    const target = isDarkNow ? 'light' : 'dark';
    if ((target === 'dark' && sysDark) || (target === 'light' && !sysDark)) applyTheme(null);
    else applyTheme(target);
  }

  function loadFromBytes(bytesOrB64, opts) {
    opts = opts || {};
    let bytes;
    if (typeof bytesOrB64 === 'string') bytes = base64ToBytes(bytesOrB64);
    else if (bytesOrB64 instanceof Uint8Array) bytes = bytesOrB64;
    else if (bytesOrB64 instanceof ArrayBuffer) bytes = new Uint8Array(bytesOrB64);
    else if (ArrayBuffer.isView(bytesOrB64)) bytes = new Uint8Array(bytesOrB64.buffer, bytesOrB64.byteOffset, bytesOrB64.byteLength);
    else throw new Error('지원하지 않는 세이브 바이트 형식입니다.');

    const summary = session.loadBytes(bytes, {
      fileName: opts.fileName || 'Save.sav',
      slotId: opts.slotId != null ? opts.slotId : null,
      sha256: opts.sha256 || null
    });
    currentPath = opts.path || '';
    selectedRoleId = summary.mainRole ? summary.mainRole.id : (summary.roles[0] ? summary.roles[0].id : null);
    rawPage = 0;
    rerenderAll();
    if (opts.silent !== true) toast('세이브 파일을 불러왔습니다.', 'ok');
    return session;
  }

  function loadDemo() {
    return safeRun(() => {
      const summary = session.loadDemo();
      currentPath = '';
      selectedRoleId = summary.mainRole ? summary.mainRole.id : null;
      rawPage = 0;
      rerenderAll();
      toast('예시 세이브를 불러왔습니다.', 'ok');
      return session;
    });
  }

  function exportBase64() {
    const bytes = session.toBytes();
    const meta = session.getMeta();
    return JSON.stringify({
      dataBase64: bytesToBase64(bytes),
      fileName: meta.fileName || 'Save.sav',
      byteLength: bytes.length
    });
  }

  function openFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      safeRun(() => loadFromBytes(new Uint8Array(reader.result), { fileName: file.name || 'Save.sav' }));
    };
    reader.onerror = () => toast('파일 읽기에 실패했습니다.', 'error');
    reader.readAsArrayBuffer(file);
  }

  const Host = (function () {
    const token = window.__MYJH_TOKEN__ || (window.__MYJH_SERVER__ && window.__MYJH_SERVER__.token) || null;
    const isWebView2 = !!(window.chrome && window.chrome.webview);

    function headers() {
      const h = { 'Content-Type': 'application/json' };
      if (token) h['X-MYJH-Token'] = token;
      return h;
    }

    async function apiFetch(url, opts) {
      const res = await fetch(url, Object.assign({ headers: headers() }, opts || {}));
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) ? data.error : ('서버 오류 (' + res.status + ')'));
      }
      return data;
    }

    async function discover() {
      if (isWebView2) {
        window.chrome.webview.postMessage({ type: 'discover' });
        return;
      }
      if (!token) return;
      safeRun(async () => {
        try {
          const data = await apiFetch('/api/slots', { method: 'GET' });
          renderSlots(data.slots || []);
        } catch (e) {
          toast(e.message || '슬롯 탐색 실패', 'error');
        }
      });
    }

    async function loadSlot(path) {
      if (!path) return;
      if (isWebView2) {
        window.chrome.webview.postMessage({ type: 'load', path: path });
        return;
      }
      if (!token) return;
      try {
        const data = await apiFetch('/api/load', { method: 'POST', body: JSON.stringify({ path: path }) });
        loadFromBytes(data.dataBase64, {
          fileName: data.name || path.split(/[\\/]/).pop() || 'Save.sav',
          path: data.path || path,
          sha256: data.sha256 || null
        });
      } catch (e) {
        toast(e.message || '슬롯 불러오기 실패', 'error');
      }
    }

    async function saveSlot() {
      if (!session.isLoaded()) {
        toast('먼저 세이브를 불러오세요.', 'error');
        return;
      }
      const targetPath = currentPath || ($('#slot-select') ? $('#slot-select').value : '');
      if (!targetPath) {
        toast('저장할 슬롯을 먼저 선택하세요.', 'error');
        return;
      }
      let bytes;
      try { bytes = session.toBytes(); } catch (e) { toast(e.message, 'error'); return; }
      const dataBase64 = bytesToBase64(bytes);
      const expectedSha256 = session.getMeta().sha256 || '';

      if (isWebView2) {
        window.chrome.webview.postMessage({
          type: 'save',
          path: targetPath,
          dataBase64: dataBase64,
          expectedSha256: expectedSha256
        });
        return;
      }
      if (!token) return;
      try {
        const data = await apiFetch('/api/save', {
          method: 'POST',
          body: JSON.stringify({ path: targetPath, dataBase64: dataBase64, expectedSha256: expectedSha256 })
        });
        currentPath = data.path || targetPath;
        session.markSaved(bytes, data.sha256 || null);
        rerenderStatusAndSummary();
        toast('슬롯 저장 및 자동 백업이 완료되었습니다.', 'ok');
      } catch (e) {
        toast(e.message || '슬롯 저장 실패', 'error');
      }
    }

    if (isWebView2) {
      window.chrome.webview.addEventListener('message', (ev) => {
        let d = ev && ev.data;
        if (typeof d === 'string') {
          try { d = JSON.parse(d); } catch (e) { return; }
        }
        if (!d || typeof d !== 'object') return;
        if (d.type === 'slots') renderSlots(d.slots || []);
        else if (d.type === 'loaded' && d.dataBase64) {
          safeRun(() => loadFromBytes(d.dataBase64, {
            fileName: (d.path || '').split(/[\\/]/).pop() || 'Save.sav',
            path: d.path || '',
            sha256: d.sha256 || null
          }));
        } else if (d.type === 'saved') {
          if (session.isLoaded()) {
            session.markSaved(session.toBytes(), d.sha256 || null);
            rerenderStatusAndSummary();
          }
          toast('슬롯 저장 및 자동 백업이 완료되었습니다.', 'ok');
        } else if (d.type === 'error') {
          toast(d.message || '호스트 오류가 발생했습니다.', 'error');
        }
      });
    }

    return { available: !!token || isWebView2, discover: discover, loadSlot: loadSlot, saveSlot: saveSlot };
  })();

  function renderSlots(slots) {
    const wrap = $('#slot-wrap');
    const sel = $('#slot-select');
    if (!sel) return;
    clear(sel);
    const ph = el('option', null, slots.length ? '저장 슬롯 선택...' : '발견된 슬롯 없음');
    ph.value = '';
    sel.appendChild(ph);
    slots.forEach((slot) => {
      const p = typeof slot === 'string' ? slot : (slot.path || slot.Path || '');
      if (!p) return;
      const name = (slot.name || slot.Name || p.split(/[\\/]/).pop() || p) + ((slot.isAuto || slot.IsAuto) ? ' [자동]' : '');
      const opt = el('option', null, name);
      opt.value = p;
      sel.appendChild(opt);
    });
    if (currentPath && Array.from(sel.options).some((o) => o.value === currentPath)) sel.value = currentPath;
    if (wrap) wrap.classList.toggle('hidden', !Host.available);
  }

  function makeFieldCard(id, labelText, value, opts, onCommit) {
    opts = opts || {};
    const card = el('div', 'field-card');
    const lbl = el('label', null, labelText);
    lbl.htmlFor = id;
    const inp = document.createElement('input');
    inp.id = id;
    inp.type = opts.type || 'number';
    if (inp.type === 'number') {
      if (opts.min != null) inp.min = String(opts.min);
      if (opts.max != null) inp.max = String(opts.max);
      inp.step = '1';
    }
    let lastValid = value == null ? '' : String(value);
    inp.value = lastValid;
    inp.addEventListener('change', () => {
      safeRun(() => {
        onCommit(inp.value);
        lastValid = inp.value;
        rerenderStatusAndSummary();
      }, () => { inp.value = lastValid; });
    });
    card.appendChild(lbl);
    card.appendChild(inp);
    return card;
  }

  function rerenderStatusAndSummary() {
    const loaded = session.isLoaded();
    const badge = $('#status-badge');
    const dirty = $('#dirty-badge');
    const resetBtn = $('#btn-reset');
    const dlBtn = $('#btn-download');
    if (resetBtn) resetBtn.disabled = !loaded;
    if (dlBtn) dlBtn.disabled = !loaded;
    if (!loaded) {
      if (badge) badge.textContent = '대기 중';
      if (dirty) dirty.classList.add('hidden');
      return;
    }
    const s = session.getSummary();
    const m = session.getModel();
    if (badge) badge.textContent = s.fileName + ' (' + s.byteSize.toLocaleString('ko-KR') + ' 바이트)';
    if (dirty) dirty.classList.toggle('hidden', !session.isDirty());

    const cardsBox = $('#summary-cards');
    if (cardsBox) {
      clear(cardsBox);
      const pairs = [
        ['파일 이름', s.fileName || 'Save.sav'],
        ['파일 크기', s.byteSize.toLocaleString('ko-KR') + ' 바이트'],
        ['저장 시각', s.saveTime || '-'],
        ['계정 이름', s.accountName || '-'],
        ['주인공', s.hasScript ? (s.mainRoleName + ' (#' + s.mainRoleId + ')') : '타이틀 화면'],
        ['생존 일수', ((m.header && m.header.aliveDays) || 0) + '일'],
        ['보유 동전', s.coin.toLocaleString('ko-KR')],
        ['활성 테이블 / 레코드', s.tableCount + '개 / ' + s.recordCount.toLocaleString('ko-KR') + '건']
      ];
      pairs.forEach(([k, v]) => {
        const c = el('div', 'stat-card');
        c.appendChild(el('div', 'k', k));
        c.appendChild(el('div', 'v', v));
        cardsBox.appendChild(c);
      });
    }
  }

  function renderOverview() {
    const presetBar = $('#preset-bar');
    const hb = $('#header-fields-box');
    const sb = $('#script-fields-box');
    const cb = $('#currency-fields-box');
    if (presetBar) {
      clear(presetBar);
      (Core.PRESETS || []).forEach((p) => {
        const b = el('button', 'btn', p.label);
        b.type = 'button';
        b.id = 'preset-' + p.id;
        b.title = p.desc || '';
        b.disabled = !session.isLoaded();
        b.addEventListener('click', () => applyPreset(p.id));
        presetBar.appendChild(b);
      });
    }
    if (!session.isLoaded()) {
      [hb, sb, cb].forEach((box) => {
        if (!box) return;
        clear(box);
        box.appendChild(el('div', 'placeholder', '세이브 파일을 먼저 불러오세요.'));
      });
      return;
    }
    const m = session.getModel();
    if (hb) {
      clear(hb);
      hb.appendChild(makeFieldCard('input-header-meridiansLvl', '경맥 등급', m.header.meridiansLvl, { min: 0 }, (v) => session.setHeaderField('meridiansLvl', num(v))));
      hb.appendChild(makeFieldCard('input-header-achievePoint', '업적 점수', m.header.achievePoint, { min: 0 }, (v) => session.setHeaderField('achievePoint', num(v))));
    }
    if (sb) {
      clear(sb);
      if (!m.hasScript) {
        sb.appendChild(el('div', 'placeholder', '타이틀 화면 세이브에는 시나리오 진행 정보(동전·주인공 이름 등)가 포함되지 않습니다. 공용 재화 및 머리말 정보만 편집할 수 있습니다.'));
      } else {
        sb.appendChild(makeFieldCard('input-mainRoleName', '주인공 이름 (최대 30바이트)', m.mainRoleName, { type: 'text' }, (v) => session.setMainRoleName(v)));
        sb.appendChild(makeFieldCard('input-coin', '보유 동전', m.coin, { min: 0, max: 2000000000 }, (v) => session.setScriptField('coin', num(v))));
        const sdefs = [
          ['bagExtraCap', '배낭 추가 용량', 0, 99999],
          ['difficulty', '난이도 (1~25)', 1, 25],
          ['martialLvMaxBonus', '무학 레벨 상한 보너스', 0, 99],
          ['roleLvMaxBonus', '레벨 상한 보너스', 0, 99],
          ['teamMax', '출전 동료 상한 (1~20)', 1, 20],
          ['martialNumMax', '무학 수량 상한', 0, 99],
          ['forgeExp', '제작 숙련도', 0, 2000000000],
          ['reforgeExp', '재련 숙련도', 0, 2000000000]
        ];
        sdefs.forEach(([k, label, lo, hi]) => {
          sb.appendChild(makeFieldCard('input-script-' + k, label, m[k], { min: lo, max: hi }, (v) => session.setScriptField(k, num(v))));
        });
      }
    }
    if (cb) {
      clear(cb);
      (Codec.COMMON_CURRENCIES || []).forEach((c) => {
        const curVal = (m.commonCurrencies && m.commonCurrencies[c.id]) || 0;
        cb.appendChild(makeFieldCard('input-currency-' + c.id, c.label, curVal, { min: 0, max: 2000000000 }, (v) => session.setCommonCurrency(c.id, num(v))));
      });
    }
  }

  function renderRoles() {
    const sel = $('#role-select');
    const metaBox = $('#role-meta-box');
    const attrBox = $('#role-attrs-box');
    if (!sel || !metaBox || !attrBox) return;
    clear(sel);
    clear(metaBox);
    clear(attrBox);
    if (!session.isLoaded()) {
      sel.disabled = true;
      metaBox.appendChild(el('div', 'placeholder', '세이브 파일을 먼저 불러오세요.'));
      return;
    }
    const s = session.getSummary();
    if (!s.roles.length) {
      sel.disabled = true;
      metaBox.appendChild(el('div', 'placeholder', '이 세이브에는 인물 능력치 레코드가 없습니다.'));
      return;
    }
    sel.disabled = false;
    s.roles.forEach((r) => {
      const opt = el('option', null, Core.getRoleName(r.templateId) + ' (#' + r.id + ')' + (r.isMain ? ' [주인공]' : ''));
      opt.value = String(r.id);
      sel.appendChild(opt);
    });
    if (!s.roles.some((r) => r.id === selectedRoleId)) {
      selectedRoleId = s.mainRole ? s.mainRole.id : s.roles[0].id;
    }
    sel.value = String(selectedRoleId);

    const role = s.roles.find((r) => r.id === selectedRoleId) || s.roles[0];
    const metaDefs = [
      ['level', '레벨 (1~99)', role.level, 1, 99],
      ['exp', '경험치', role.exp, 0, 2000000000],
      ['remainAttrPoint', '남은 능력치 포인트', role.remainAttrPoint, 0, 60000],
      ['eatFoodMaxNum', '음식 섭취 상한', role.eatFoodMaxNum, 0, 60000]
    ];
    metaDefs.forEach(([k, label, val, lo, hi]) => {
      metaBox.appendChild(makeFieldCard('input-role-' + k, label, val, { min: lo, max: hi }, (v) => session.setRoleMeta(role.id, k, num(v))));
    });
    (Codec.ATTR_FIELDS || []).forEach((f) => {
      const cur = num(role.attrTokens[f.index], 0);
      attrBox.appendChild(makeFieldCard('input-attr-' + f.key, f.label, cur, { min: 0, max: 2000000000 }, (v) => session.setRoleAttr(role.id, f.index, num(v))));
    });
  }

  function renderEmptyRow(tbody, cols, msg) {
    clear(tbody);
    const tr = el('tr', 'empty-row');
    const cell = el('td', null, msg);
    cell.colSpan = cols;
    tr.appendChild(cell);
    tbody.appendChild(tr);
  }

  function renderItems() {
    const tbody = $('#items-tbody');
    const countLbl = $('#items-count');
    if (!tbody) return;
    if (!session.isLoaded()) {
      if (countLbl) countLbl.textContent = '0개';
      renderEmptyRow(tbody, 5, '세이브를 열면 보유 물품이 표시됩니다.');
      return;
    }
    const q = (($('#item-search') || {}).value || '').trim().toLowerCase();
    const all = session.getSummary().items;
    const rows = all.filter((it) => !q || it.name.toLowerCase().includes(q) || String(it.baseId).includes(q));
    if (countLbl) countLbl.textContent = rows.length + ' / ' + all.length + '개';
    if (!rows.length) {
      renderEmptyRow(tbody, 5, '일치하는 보유 물품이 없습니다.');
      return;
    }
    clear(tbody);
    rows.forEach((it) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, '#' + it.id + ' (' + it.baseId + ')'));
      tr.appendChild(el('td', null, it.name + ' [' + it.rank + ']'));
      const tdQty = el('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '1';
      inp.max = '999999';
      inp.value = String(it.count);
      inp.addEventListener('change', () => safeRun(() => {
        session.setItemCount(it.id, num(inp.value, 1));
        rerenderStatusAndSummary();
      }, () => { inp.value = String(it.count); }));
      tdQty.appendChild(inp);
      tr.appendChild(tdQty);
      tr.appendChild(el('td', null, it.type + ' (소유 #' + it.owner + ')'));
      const tdOp = el('td');
      const rm = el('button', 'btn sm danger', '삭제');
      rm.type = 'button';
      rm.addEventListener('click', () => safeRun(() => {
        session.removeItem(it.id);
        renderItems();
        rerenderStatusAndSummary();
      }));
      tdOp.appendChild(rm);
      tr.appendChild(tdOp);
      tbody.appendChild(tr);
    });
  }

  function renderMartialsAndGifts() {
    const mBody = $('#martials-tbody');
    const mCnt = $('#martials-count');
    const gBody = $('#gifts-tbody');
    const gCnt = $('#gifts-count');
    if (!session.isLoaded()) {
      if (mCnt) mCnt.textContent = '0개';
      if (gCnt) gCnt.textContent = '0개';
      if (mBody) renderEmptyRow(mBody, 5, '세이브를 열면 무학 목록이 표시됩니다.');
      if (gBody) renderEmptyRow(gBody, 4, '세이브를 열면 천부 목록이 표시됩니다.');
      return;
    }
    const s = session.getSummary();
    if (mBody) {
      const mq = (($('#martial-search') || {}).value || '').trim().toLowerCase();
      const rows = s.martials.filter((r) => !mq || r.name.toLowerCase().includes(mq) || String(r.baseId).includes(mq));
      if (mCnt) mCnt.textContent = rows.length + ' / ' + s.martials.length + '개';
      if (!rows.length) renderEmptyRow(mBody, 5, '보유한 무학이 없습니다.');
      else {
        clear(mBody);
        rows.forEach((r) => {
          const tr = el('tr');
          tr.appendChild(el('td', null, '#' + r.id + ' (' + r.baseId + ')'));
          tr.appendChild(el('td', null, r.name + ' [' + r.depart + ' · ' + r.rank + ']'));
          const tdExp = el('td');
          const expInp = document.createElement('input');
          expInp.type = 'number';
          expInp.min = '0';
          expInp.value = String(r.exp);
          expInp.addEventListener('change', () => safeRun(() => {
            session.setMartial(r.id, { exp: num(expInp.value, 0) });
            rerenderStatusAndSummary();
          }, () => { expInp.value = String(r.exp); }));
          tdExp.appendChild(expInp);
          tr.appendChild(tdExp);

          const tdLv = el('td');
          const lvInp = document.createElement('input');
          lvInp.type = 'number';
          lvInp.min = '1';
          lvInp.max = '30';
          lvInp.value = String(r.level);
          lvInp.addEventListener('change', () => safeRun(() => {
            session.setMartial(r.id, { level: num(lvInp.value, 1) });
            rerenderStatusAndSummary();
          }, () => { lvInp.value = String(r.level); }));
          tdLv.appendChild(lvInp);
          tr.appendChild(tdLv);

          const tdOp = el('td');
          const rm = el('button', 'btn sm danger', '삭제');
          rm.type = 'button';
          rm.addEventListener('click', () => safeRun(() => {
            session.removeMartial(r.id);
            renderMartialsAndGifts();
            rerenderStatusAndSummary();
          }));
          tdOp.appendChild(rm);
          tr.appendChild(tdOp);
          mBody.appendChild(tr);
        });
      }
    }
    if (gBody) {
      const gq = (($('#gift-search') || {}).value || '').trim().toLowerCase();
      const rows = s.gifts.filter((r) => !gq || r.name.toLowerCase().includes(gq) || String(r.baseId).includes(gq));
      if (gCnt) gCnt.textContent = rows.length + ' / ' + s.gifts.length + '개';
      if (!rows.length) renderEmptyRow(gBody, 4, '보유한 천부가 없습니다.');
      else {
        clear(gBody);
        rows.forEach((r) => {
          const tr = el('tr');
          tr.appendChild(el('td', null, '#' + r.id + ' (' + r.baseId + ')'));
          tr.appendChild(el('td', null, r.name));
          tr.appendChild(el('td', null, r.rank));
          const tdOp = el('td');
          const rm = el('button', 'btn sm danger', '삭제');
          rm.type = 'button';
          rm.addEventListener('click', () => safeRun(() => {
            session.removeGift(r.id);
            renderMartialsAndGifts();
            rerenderStatusAndSummary();
          }));
          tdOp.appendChild(rm);
          tr.appendChild(tdOp);
          gBody.appendChild(tr);
        });
      }
    }
  }

  function relLabel(v) {
    if (v >= 60) return '친밀';
    if (v >= 20) return '우호';
    if (v > -20) return '보통';
    return '적대';
  }

  function renderNpcs() {
    const tbody = $('#npcs-tbody');
    const cnt = $('#npcs-count');
    if (!tbody) return;
    if (!session.isLoaded()) {
      if (cnt) cnt.textContent = '0명';
      renderEmptyRow(tbody, 5, '세이브를 열면 인물 목록이 표시됩니다.');
      return;
    }
    const q = (($('#npc-search') || {}).value || '').trim().toLowerCase();
    const all = session.getSummary().npcs;
    const rows = all.filter((r) => !q || r.name.toLowerCase().includes(q) || String(r.npcBaseId).includes(q));
    if (cnt) cnt.textContent = rows.length + ' / ' + all.length + '명';
    if (!rows.length) {
      renderEmptyRow(tbody, 5, '표시할 인물 호감도 기록이 없습니다.');
      return;
    }
    clear(tbody);
    rows.forEach((r) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, '#' + r.id));
      tr.appendChild(el('td', null, r.name + ' (' + r.npcBaseId + ')'));
      const tdVal = el('td');
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = '-100';
      inp.max = '100';
      inp.value = String(r.disposition);
      const tdRel = el('td', null, relLabel(r.disposition));
      inp.addEventListener('change', () => safeRun(() => {
        const v = num(inp.value, 0);
        session.setNpcDisposition(r.id, r.slotIndex, v);
        tdRel.textContent = relLabel(v);
        rerenderStatusAndSummary();
      }, () => { inp.value = String(r.disposition); }));
      tdVal.appendChild(inp);
      tr.appendChild(tdVal);
      tr.appendChild(tdRel);
      tr.appendChild(el('td', null, '슬롯 #' + r.slotIndex));
      tbody.appendChild(tr);
    });
  }

  function renderRaw() {
    const sel = $('#raw-table-select');
    const box = $('#raw-records-box');
    const info = $('#raw-page-info');
    if (!sel || !box) return;
    if (!session.isLoaded()) {
      clear(sel);
      sel.disabled = true;
      clear(box);
      box.appendChild(el('div', 'placeholder', '원시 레코드를 보려면 세이브를 여세요.'));
      if (info) info.textContent = '0 / 0';
      return;
    }
    sel.disabled = false;
    const m = session.getModel();
    clear(sel);
    m.tables.forEach((t) => {
      const o = el('option', null, 'T' + String(t.index).padStart(2, '0') + ' · ' + t.nameKo + ' (' + t.records.length + '건)');
      o.value = String(t.index);
      sel.appendChild(o);
    });
    if (rawTable < 0 || rawTable >= m.tables.length) rawTable = 0;
    sel.value = String(rawTable);
    renderRawRecordsOnly();
  }

  function renderRawRecordsOnly() {
    const box = $('#raw-records-box');
    const info = $('#raw-page-info');
    if (!box || !session.isLoaded()) return;
    clear(box);
    const m = session.getModel();
    const recs = Codec.listRecords(m, rawTable);
    if (!recs.length) {
      box.appendChild(el('div', 'placeholder', '선택한 테이블에 저장된 레코드가 없습니다.'));
      if (info) info.textContent = '0 / 0';
      return;
    }
    const perPage = 20;
    const pages = Math.max(1, Math.ceil(recs.length / perPage));
    if (rawPage >= pages) rawPage = pages - 1;
    if (rawPage < 0) rawPage = 0;
    if (info) info.textContent = (rawPage + 1) + ' / ' + pages;
    recs.slice(rawPage * perPage, rawPage * perPage + perPage).forEach((rec) => {
      const wrap = el('div', 'raw-record');
      wrap.appendChild(el('strong', null, '레코드 #' + rec.recordIndex + ' (식별값 ' + rec.key + ')'));
      const grid = el('div', 'raw-words');
      const count = Math.min(16, rec.u32.length);
      for (let j = 0; j < count; j++) {
        const byteOff = 0x10 + j * 4;
        const cell = el('div', 'raw-word');
        cell.appendChild(el('span', null, '+0x' + byteOff.toString(16)));
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.max = '4294967295';
        inp.value = String(rec.u32[j]);
        inp.addEventListener('change', () => safeRun(() => {
          session.setRawU32(rawTable, rec.recordIndex, byteOff, num(inp.value, 0));
          rerenderAll();
        }, () => { inp.value = String(rec.u32[j]); }));
        cell.appendChild(inp);
        grid.appendChild(cell);
      }
      wrap.appendChild(grid);
      box.appendChild(wrap);
    });
  }

  function openCatalogDialog(kind) {
    if (!session.isLoaded()) {
      toast('세이브 파일을 먼저 불러오세요.', 'error');
      return;
    }
    catalogKind = kind;
    catalogFilter = '';
    const dlg = $('#catalog-dialog');
    const title = $('#catalog-dialog-title');
    const searchInp = $('#catalog-search-input');
    const filterSel = $('#catalog-filter-select');
    const qtyWrap = $('#catalog-qty-wrap');
    const qtyInp = $('#catalog-qty-input');
    if (!dlg) return;
    if (title) {
      title.textContent = kind === 'items' ? '물품 도감 검색 및 추가' : (kind === 'martials' ? '무학 도감 검색 및 추가' : '천부 도감 검색 및 추가');
    }
    if (searchInp) searchInp.value = '';
    if (qtyWrap) qtyWrap.classList.toggle('hidden', kind === 'gifts');
    if (qtyInp) {
      qtyInp.value = '1';
      qtyInp.max = kind === 'martials' ? '30' : '9999';
    }
    if (filterSel) {
      clear(filterSel);
      const allOpt = el('option', null, '전체 분류');
      allOpt.value = '';
      filterSel.appendChild(allOpt);
      const list = Catalog[kind] || [];
      const fieldKey = kind === 'items' ? 'type' : (kind === 'martials' ? 'depart' : 'rank');
      const vals = Array.from(new Set(list.map((e) => e && e[fieldKey]).filter(Boolean))).sort();
      vals.forEach((v) => {
        const o = el('option', null, String(v));
        o.value = String(v);
        filterSel.appendChild(o);
      });
    }
    renderCatalogResults();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function renderCatalogResults() {
    const tbody = $('#catalog-results-body');
    const cnt = $('#catalog-count-label');
    if (!tbody) return;
    const q = (($('#catalog-search-input') || {}).value || '').trim();
    const rows = Core.searchCatalog(catalogKind, q, catalogFilter, CATALOG_LIMIT);
    if (cnt) cnt.textContent = rows.length + '건 표시';
    if (!rows.length) {
      renderEmptyRow(tbody, 5, '일치하는 도감 항목이 없습니다.');
      return;
    }
    clear(tbody);
    rows.forEach((entry) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(entry.id)));
      tr.appendChild(el('td', null, entry.name));
      tr.appendChild(el('td', null, entry.type || entry.depart || '-'));
      tr.appendChild(el('td', null, entry.rank || '-'));
      const tdAdd = el('td');
      const btn = el('button', 'btn sm primary', '추가');
      btn.type = 'button';
      btn.dataset.addId = String(entry.id);
      btn.addEventListener('click', () => safeRun(() => {
        const qtyVal = Math.max(1, num(($('#catalog-qty-input') || {}).value, 1));
        if (catalogKind === 'items') session.addItem(entry.id, qtyVal);
        else if (catalogKind === 'martials') session.addMartial(entry.id, Math.min(30, qtyVal));
        else session.addGift(entry.id);
        rerenderAll();
        toast('추가 완료: ' + entry.name, 'ok');
      }));
      tdAdd.appendChild(btn);
      tr.appendChild(tdAdd);
      tbody.appendChild(tr);
    });
  }

  function switchTab(tab) {
    $$('#main-tablist [role="tab"]').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('main > section[role="tabpanel"]').forEach((panel) => {
      panel.hidden = panel.id !== ('panel-' + tab);
    });
  }

  function applyPreset(presetId) {
    return safeRun(() => {
      session.applyPreset(presetId);
      rerenderAll();
      toast('빠른 설정을 적용했습니다.', 'ok');
    });
  }

  function rerenderAll() {
    rerenderStatusAndSummary();
    renderOverview();
    renderRoles();
    renderItems();
    renderMartialsAndGifts();
    renderNpcs();
    renderRaw();
  }

  function bindEvents() {
    const themeBtn = $('#btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const fileInp = $('#file-input');
    const openBtn = $('#btn-open-file');
    if (openBtn && fileInp) openBtn.addEventListener('click', () => fileInp.click());
    if (fileInp) fileInp.addEventListener('change', () => {
      if (fileInp.files && fileInp.files[0]) openFile(fileInp.files[0]);
      fileInp.value = '';
    });

    const demoBtn = $('#btn-demo');
    if (demoBtn) demoBtn.addEventListener('click', loadDemo);

    const resetBtn = $('#btn-reset');
    if (resetBtn) resetBtn.addEventListener('click', () => safeRun(() => {
      session.reset();
      rerenderAll();
      toast('원본 상태로 복원했습니다.', 'ok');
    }));

    const dlBtn = $('#btn-download');
    if (dlBtn) dlBtn.addEventListener('click', () => safeRun(() => {
      const bytes = session.toBytes();
      const blob = new Blob([bytes], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = session.getMeta().fileName || 'Save.sav';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a); }, 250);
    }));

    const dz = $('#drop-zone');
    if (dz) {
      dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('is-over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
      dz.addEventListener('drop', (ev) => {
        ev.preventDefault();
        dz.classList.remove('is-over');
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) openFile(f);
      });
    }

    const slotSel = $('#slot-select');
    if (slotSel) slotSel.addEventListener('change', () => { if (slotSel.value) Host.loadSlot(slotSel.value); });
    const refreshBtn = $('#btn-refresh-slots');
    if (refreshBtn) refreshBtn.addEventListener('click', () => Host.discover());
    const saveHostBtn = $('#btn-save-host');
    if (saveHostBtn) saveHostBtn.addEventListener('click', () => Host.saveSlot());

    $$('#main-tablist [role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
      btn.addEventListener('keydown', (ev) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(ev.key)) return;
        ev.preventDefault();
        const tabs = $$('#main-tablist [role="tab"]');
        const i = tabs.indexOf(btn);
        let ni = i;
        if (ev.key === 'ArrowRight') ni = (i + 1) % tabs.length;
        else if (ev.key === 'ArrowLeft') ni = (i - 1 + tabs.length) % tabs.length;
        else if (ev.key === 'Home') ni = 0;
        else if (ev.key === 'End') ni = tabs.length - 1;
        tabs[ni].focus();
        switchTab(tabs[ni].dataset.tab);
      });
    });

    const roleSel = $('#role-select');
    if (roleSel) roleSel.addEventListener('change', () => {
      selectedRoleId = num(roleSel.value, 0);
      renderRoles();
    });

    const itemSearch = $('#item-search');
    if (itemSearch) itemSearch.addEventListener('input', renderItems);
    const martialSearch = $('#martial-search');
    if (martialSearch) martialSearch.addEventListener('input', renderMartialsAndGifts);
    const giftSearch = $('#gift-search');
    if (giftSearch) giftSearch.addEventListener('input', renderMartialsAndGifts);
    const npcSearch = $('#npc-search');
    if (npcSearch) npcSearch.addEventListener('input', renderNpcs);

    const addItemBtn = $('#btn-add-item');
    if (addItemBtn) addItemBtn.addEventListener('click', () => openCatalogDialog('items'));
    const addMartialBtn = $('#btn-add-martial');
    if (addMartialBtn) addMartialBtn.addEventListener('click', () => openCatalogDialog('martials'));
    const addGiftBtn = $('#btn-add-gift');
    if (addGiftBtn) addGiftBtn.addEventListener('click', () => openCatalogDialog('gifts'));

    const npcBulkBtn = $('#btn-npc-bulk');
    if (npcBulkBtn) npcBulkBtn.addEventListener('click', () => safeRun(() => {
      const val = num(($('#npc-bulk-input') || {}).value, 100);
      session.setAllNpcDispositions(val);
      renderNpcs();
      rerenderStatusAndSummary();
      toast('모든 인물의 호감도를 ' + val + '(으)로 설정했습니다.', 'ok');
    }));

    const rawSel = $('#raw-table-select');
    if (rawSel) rawSel.addEventListener('change', () => {
      rawTable = num(rawSel.value, 0);
      rawPage = 0;
      renderRawRecordsOnly();
    });
    const rawPrev = $('#raw-page-prev');
    if (rawPrev) rawPrev.addEventListener('click', () => { rawPage = Math.max(0, rawPage - 1); renderRawRecordsOnly(); });
    const rawNext = $('#raw-page-next');
    if (rawNext) rawNext.addEventListener('click', () => { rawPage += 1; renderRawRecordsOnly(); });

    const dlg = $('#catalog-dialog');
    if (dlg) dlg.addEventListener('close', () => { dlg.returnValue = ''; });
    const catSearch = $('#catalog-search-input');
    if (catSearch) catSearch.addEventListener('input', renderCatalogResults);
    const catFilter = $('#catalog-filter-select');
    if (catFilter) catFilter.addEventListener('change', () => {
      catalogFilter = catFilter.value;
      renderCatalogResults();
    });
  }

  function init() {
    initTheme();
    bindEvents();
    rerenderAll();
    if (Host.available) {
      const wrap = $('#slot-wrap');
      if (wrap) wrap.classList.remove('hidden');
      Host.discover();
    }
  }

  window.MyjhUi = {
    getSession: () => session,
    loadDemo: loadDemo,
    loadFromBytes: loadFromBytes,
    exportBase64: exportBase64,
    refresh: rerenderAll,
    switchTab: switchTab,
    applyPreset: applyPreset
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
