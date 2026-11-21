'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const Codec = require('../src/myjh-codec.js');
const Catalog = require('../src/catalog-data.js');
const Core = require('../src/editor-core.js');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const HANZI_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const KANA_RE = /[\u3040-\u30ff]/;
const HTTP_RE = /https?:\/\//i;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`[FAIL] ${name}`);
    console.error(err && err.stack ? err.stack : String(err));
  }
}

function walkFiles(dir, fileName, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, fileName, out);
    else if (ent.isFile() && ent.name === fileName) out.push(p);
  }
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

test('Language & Hygiene Audit', () => {
  for (const rel of [
    'src/catalog-data.js',
    'src/myjh-codec.js',
    'src/editor-core.js',
    'src/editor-ui.js',
    'src/editor-page.html',
    'dist/MyJianghuSaveEditor-v1.1.html'
  ]) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(!HANZI_RE.test(text), `${rel}: contains Hanzi`);
    assert.ok(!KANA_RE.test(text), `${rel}: contains Kana`);
    assert.ok(!text.includes('실험적'), `${rel}: contains forbidden word`);
  }

  const distPath = path.join(DIST, 'MyJianghuSaveEditor-v1.1.html');
  const distText = fs.readFileSync(distPath, 'utf8');
  const distSize = fs.statSync(distPath).size;

  assert.ok(distText.includes("default-src 'none'"), 'dist: missing default-src');
  assert.ok(distText.includes("connect-src 'none'"), 'dist: missing connect-src');
  assert.ok(!/<script\b[^>]*\bsrc\b/i.test(distText), 'dist: must not contain <script src');
  assert.ok(!HTTP_RE.test(distText), 'dist: must not contain http(s) URLs');
  assert.ok(distSize < 10 * 1024 * 1024, 'dist: size must be < 10 MiB');
});

test('Catalog Completeness', () => {
  assert.ok(Array.isArray(Catalog.items) && Catalog.items.length >= 3800);
  assert.ok(Array.isArray(Catalog.martials) && Catalog.martials.length >= 900);
  assert.ok(Array.isArray(Catalog.gifts) && Catalog.gifts.length >= 2800);
  assert.ok(Catalog.roles && Object.keys(Catalog.roles).length >= 3200);
  assert.strictEqual(Core.getRoleName(1000001260), '전소륙');
  assert.ok(Core.searchCatalog('items', '경험단', '', 20).length > 0);
  const silver = Codec.COMMON_CURRENCIES.find((c) => c.id === 'silver');
  const gold = Codec.COMMON_CURRENCIES.find((c) => c.id === 'gold');
  const tongling = Codec.COMMON_CURRENCIES.find((c) => c.id === 'tonglingyu');
  const maxHp = Codec.ATTR_FIELDS.find((a) => a.key === 'maxHp');
  const lidao = Codec.ATTR_FIELDS.find((a) => a.key === 'lidao');
  const lingqiao = Codec.ATTR_FIELDS.find((a) => a.key === 'lingqiao');
  assert.strictEqual(silver && silver.label, '은자');
  assert.strictEqual(gold && gold.label, '금자');
  assert.strictEqual(tongling && tongling.label, '금강옥');
  assert.strictEqual(maxHp && maxHp.label, '최대 생명력');
  assert.strictEqual(lidao && lidao.label, '근력');
  assert.strictEqual(lingqiao && lingqiao.label, '민첩');
});

test('Synthetic Demo Save & Validation', () => {
  const demo = Buffer.from(Codec.createDemoSave());
  assert.strictEqual(Codec.validate(demo).ok, true);

  const roundTrip = Buffer.from(Codec.serialize(Codec.parse(demo)));
  assert.strictEqual(Buffer.compare(demo, roundTrip), 0);

  const truncated = demo.subarray(0, demo.length - 1);
  assert.strictEqual(Codec.validate(truncated).ok, false);

  const trailing = Buffer.concat([demo, Buffer.from([0x00])]);
  assert.strictEqual(Codec.validate(trailing).ok, false);

  const tooMany = Buffer.from(demo);
  tooMany.writeUInt32LE(Codec.MAX_RECORDS + 1, Codec.HEADER_SIZE);
  assert.strictEqual(Codec.validate(tooMany).ok, false);
});

test('All Codec & Session Mutations + Bounds Enforcement', () => {
  const session = Core.createSession();
  session.loadDemo();
  const initialBytes = Buffer.from(session.toBytes());
  assert.strictEqual(session.isDirty(), false);

  session.setHeaderField('meridiansLvl', 7);
  session.setHeaderField('achievePoint', 12345);
  assert.strictEqual(session.getModel().header.meridiansLvl, 7);
  assert.strictEqual(session.getModel().header.achievePoint, 12345);

  session.setScriptField('coin', 77777);
  session.setScriptField('bagExtraCap', 120);
  session.setScriptField('difficulty', 25);
  session.setMainRoleName('가나다라마바사아자차');
  assert.strictEqual(session.getSummary().coin, 77777);
  assert.strictEqual(session.getModel().bagExtraCap, 120);
  assert.strictEqual(session.getModel().difficulty, 25);
  assert.strictEqual(session.getSummary().mainRoleName, '가나다라마바사아자차');

  assert.throws(() => session.setScriptField('difficulty', 0));
  assert.throws(() => session.setScriptField('difficulty', 26));
  assert.throws(() => session.setMainRoleName('가나다라마바사아자차카'));

  session.setCommonCurrency('silver', 1000);
  session.setCommonCurrency('gold', 2000);
  session.setCommonCurrency('tonglingyu', 3000);
  assert.strictEqual(session.getSummary().commonCurrencies.silver, 1000);
  assert.strictEqual(session.getSummary().commonCurrencies.gold, 2000);
  assert.strictEqual(session.getSummary().commonCurrencies.tonglingyu, 3000);

  const rid = session.getSummary().mainRoleId;
  session.setRoleMeta(rid, 'level', 99);
  session.setRoleMeta(rid, 'exp', 123456789);
  session.setRoleMeta(rid, 'remainAttrPoint', 55);
  session.setRoleMeta(rid, 'eatFoodMaxNum', 80);
  assert.strictEqual(session.getSummary().mainRole.level, 99);
  assert.strictEqual(session.getSummary().mainRole.exp, 123456789);
  assert.throws(() => session.setRoleMeta(rid, 'level', 0));
  assert.throws(() => session.setRoleMeta(rid, 'level', 100));

  session.setRoleAttr(rid, 0, 88888);
  session.setRoleAttr(rid, 11, 4444);
  session.setRoleAttr(rid, 13, 333);
  assert.strictEqual(Number(session.getSummary().mainRole.attrTokens[0]), 88888);
  assert.strictEqual(Number(session.getSummary().mainRole.attrTokens[11]), 4444);
  assert.strictEqual(Number(session.getSummary().mainRole.attrTokens[13]), 333);

  const newItemId = session.addItem(1005, 2);
  session.setItemCount(newItemId, 25);
  assert.strictEqual(session.getSummary().items.find((i) => i.id === newItemId).count, 25);
  assert.ok(session.getModel().maxIds[Codec.ITEM_OBJ_TYPE] >= newItemId);
  session.removeItem(newItemId);
  assert.strictEqual(session.getSummary().items.find((i) => i.id === newItemId), undefined);

  const overflowModel = Codec.parse(Codec.createDemoSave());
  const itemMaxRec = overflowModel.tables[Codec.MAXID_TABLE].records.find((r) => (r[0x10] | (r[0x11] << 8) | (r[0x12] << 16) | (r[0x13] << 24)) >>> 0 === Codec.ITEM_OBJ_TYPE);
  itemMaxRec.set([0xff, 0xff, 0xff, 0xff], 0x14);
  const itemCountBefore = overflowModel.tables[Codec.ITEM_TABLE].records.length;
  assert.throws(() => Codec.addItem(overflowModel, 1005, 1));
  assert.strictEqual(overflowModel.tables[Codec.ITEM_TABLE].records.length, itemCountBefore);

  const newMartialId = session.addMartial(12216, 5);
  session.setMartial(newMartialId, { level: 30, exp: 999 });
  assert.strictEqual(session.getSummary().martials.find((m) => m.id === newMartialId).level, 30);
  assert.throws(() => session.setMartial(newMartialId, { level: 0 }));
  assert.throws(() => session.setMartial(newMartialId, { level: 31 }));
  session.removeMartial(newMartialId);

  const newGiftId = session.addGift(409);
  assert.ok(session.getSummary().gifts.some((g) => g.id === newGiftId));
  session.removeGift(newGiftId);
  assert.ok(!session.getSummary().gifts.some((g) => g.id === newGiftId));

  const firstNpc = session.getSummary().npcs[0];
  session.setNpcDisposition(firstNpc.id, firstNpc.slotIndex, -100);
  session.setNpcDisposition(firstNpc.id, firstNpc.slotIndex, 100);
  assert.throws(() => session.setNpcDisposition(firstNpc.id, firstNpc.slotIndex, 101));
  assert.throws(() => session.setNpcDisposition(firstNpc.id, firstNpc.slotIndex, -101));
  session.setAllNpcDispositions(-50);
  assert.strictEqual(session.getSummary().npcs[0].disposition, -50);

  const origWord = Codec.getU32(session.getModel(), 0, 0, 0x38);
  session.setRawU32(0, 0, 0x38, 654321);
  assert.strictEqual(session.getSummary().coin, 654321);
  session.setRawU32(0, 0, 0x38, origWord);

  assert.strictEqual(session.isDirty(), true);
  session.reset();
  assert.strictEqual(session.isDirty(), false);
  assert.strictEqual(Buffer.compare(Buffer.from(session.toBytes()), initialBytes), 0);

  assert.strictEqual(Array.isArray(Core.PRESETS), true);
  assert.strictEqual(Core.PRESETS.length, 4);
  for (const p of Core.PRESETS) {
    const s2 = Core.createSession();
    s2.loadDemo();
    s2.applyPreset(p.id);
    const out = s2.toBytes();
    assert.strictEqual(Codec.validate(out).ok, true);
  }
});

const realDir = process.env.MYJH_REAL_SAVE_DIR;
if (realDir && fs.existsSync(realDir) && fs.statSync(realDir).isDirectory()) {
  test('Real-Save Byte-Identical Round-Trip', () => {
    const saves = walkFiles(realDir, 'Save.sav');
    assert.ok(saves.length >= 2, `expected >=2 Save.sav files in ${realDir}`);
    for (const file of saves) {
      const raw = fs.readFileSync(file);
      assert.strictEqual(Codec.validate(raw).ok, true, `${file}: validate failed`);
      const out = Buffer.from(Codec.serialize(Codec.parse(raw)));
      assert.strictEqual(sha256(raw), sha256(out), `${file}: SHA-256 mismatch`);
      assert.strictEqual(Buffer.compare(raw, out), 0, `${file}: byte mismatch`);
    }
  });
} else {
  console.log('[SKIP] real-save fixture dir not set');
}

const total = passed + failed;
console.log(`Passed ${passed}/${total}`);
if (failed > 0) process.exit(1);
