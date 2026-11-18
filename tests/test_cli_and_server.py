#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import base64
import http.client
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import myjh_editor as ed


def _sha(data: bytes) -> str:
    return ed.sha256_bytes(data)


def _raw_http(host: str, port: int, method: str, path: str, headers: dict | None = None, body: bytes = b"", timeout: int = 10):
    conn = http.client.HTTPConnection(host, port, timeout=timeout)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        return resp.status, dict(resp.getheaders()), resp.read()
    finally:
        conn.close()


class TestCliAndServer(unittest.TestCase):
    def setUp(self) -> None:
        self.td = tempfile.mkdtemp(prefix="myjh_test_")
        self.addCleanup(shutil.rmtree, self.td, True)
        self._orig_game_running = os.environ.pop("MYJH_SIMULATE_GAME_RUNNING", None)

    def tearDown(self) -> None:
        if self._orig_game_running is not None:
            os.environ["MYJH_SIMULATE_GAME_RUNNING"] = self._orig_game_running
        else:
            os.environ.pop("MYJH_SIMULATE_GAME_RUNNING", None)

    def _run_cli(self, argv: list[str]) -> tuple[int, str]:
        buf = io.StringIO()
        with redirect_stdout(buf):
            rc = ed.main(argv)
        return rc, buf.getvalue()

    def test_demo_roundtrip_and_cli_commands(self) -> None:
        save_path = os.path.join(self.td, "Save.sav")
        rc, out = self._run_cli(["demo", "--out", save_path])
        self.assertEqual(rc, 0, out)
        demo_bytes = Path(save_path).read_bytes()
        doc = ed.SaveDoc.parse(demo_bytes)
        self.assertEqual(doc.serialize(), demo_bytes)
        doc.validate()

        self.assertEqual(self._run_cli(["info", save_path])[0], 0)
        self.assertEqual(self._run_cli(["validate", save_path])[0], 0)
        self.assertEqual(self._run_cli(["presets"])[0], 0)

        disc_dir = os.path.join(self.td, "discover")
        os.makedirs(disc_dir, exist_ok=True)
        auto_p = os.path.join(disc_dir, "Save.sav")
        manual_dir = os.path.join(disc_dir, "SaveFile", "1")
        os.makedirs(manual_dir, exist_ok=True)
        manual_p = os.path.join(manual_dir, "Save.sav")
        Path(auto_p).write_bytes(demo_bytes)
        Path(manual_p).write_bytes(demo_bytes)

        found = ed.discover_saves(disc_dir)
        auto_hits = [x for x in found if x.get("path") == os.path.abspath(auto_p) and x.get("isAuto") is True]
        manual_hits = [x for x in found if x.get("path") == os.path.abspath(manual_p) and x.get("isAuto") is False]
        self.assertEqual(len(auto_hits), 1)
        self.assertEqual(len(manual_hits), 1)
        self.assertEqual(self._run_cli(["discover", "--save-dir", disc_dir])[0], 0)

        before = Path(save_path).read_bytes()
        before_sha = _sha(before)
        rc, out = self._run_cli(["edit", save_path, "--coin", "123456", "--dry-run"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(Path(save_path).read_bytes(), before)

        rc, out = self._run_cli([
            "edit", save_path, "--preset", "rich_resources",
            "--coin", "777777", "--add-item", "1005", "10",
        ])
        self.assertEqual(rc, 0, out)
        after = Path(save_path).read_bytes()
        self.assertNotEqual(_sha(after), before_sha)

        backups = sorted(Path(self.td).glob("Save.sav.backup-*.bak"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(_sha(backups[0].read_bytes()), before_sha)

        after_doc = ed.SaveDoc.parse(after)
        after_doc.validate()
        self.assertEqual(after_doc.coin, 777777)
        self.assertGreaterEqual(after_doc.get_currency("silver"), 999999)

    def test_game_running_and_sha_mismatch_and_symlink_guards(self) -> None:
        p = os.path.join(self.td, "Save.sav")
        self._run_cli(["demo", "--out", p])
        raw = Path(p).read_bytes()
        good_sha = _sha(raw)

        os.environ["MYJH_SIMULATE_GAME_RUNNING"] = "1"
        try:
            with self.assertRaises(ed.GameRunningError):
                ed.save_with_backup(p, raw, expected_sha256=good_sha)
        finally:
            os.environ.pop("MYJH_SIMULATE_GAME_RUNNING", None)

        with self.assertRaises(ed.ShaMismatchError):
            ed.save_with_backup(p, raw, expected_sha256="0" * 64)

        link_dir = os.path.join(self.td, "links")
        os.makedirs(link_dir, exist_ok=True)
        target = os.path.join(link_dir, "real.sav")
        Path(target).write_bytes(raw)
        link = os.path.join(link_dir, "Save.sav")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unsupported on this OS")

        with self.assertRaises(ed.UnsafePathError):
            ed.save_with_backup(link, raw)
        hits = ed.discover_saves(link_dir)
        self.assertFalse(any(h.get("path") == os.path.abspath(link) for h in hits))

    def test_http_server_security_and_roundtrip(self) -> None:
        save_dir = os.path.join(self.td, "srv")
        os.makedirs(save_dir, exist_ok=True)
        save_path = os.path.join(save_dir, "Save.sav")
        self._run_cli(["demo", "--out", save_path])
        txt_path = os.path.join(save_dir, "notes.txt")
        Path(txt_path).write_text("hello", encoding="utf-8")

        with self.assertRaises(ed.MyjhError):
            ed.create_http_server(host="0.0.0.0", save_dir=save_dir)

        httpd, _url = ed.create_http_server(port=0, save_dir=save_dir)

        def _stop() -> None:
            try:
                httpd.shutdown()
            finally:
                httpd.server_close()

        self.addCleanup(_stop)
        t = threading.Thread(target=httpd.serve_forever, daemon=True)
        t.start()
        self.addCleanup(t.join, 5)

        host = "127.0.0.1"
        port = httpd.server_address[1]
        token = httpd.token

        st, _hdrs, body = _raw_http(host, port, "GET", "/")
        self.assertEqual(st, 200)
        text = body.decode("utf-8")
        self.assertIn("connect-src 'self'", text)
        self.assertIn("window.__MYJH_TOKEN__", text)

        self.assertEqual(_raw_http(host, port, "GET", "/", headers={"Host": "evil.example"})[0], 403)
        self.assertEqual(_raw_http(host, port, "GET", "/", headers={"Origin": "http://evil.example"})[0], 403)
        self.assertEqual(_raw_http(host, port, "GET", "/", headers={"Sec-Fetch-Site": "cross-site"})[0], 403)
        self.assertEqual(_raw_http(host, port, "GET", "/api/slots")[0], 401)
        self.assertEqual(_raw_http(host, port, "GET", "/api/slots", headers={"X-MYJH-Token": "wrong"})[0], 401)

        auth = {"X-MYJH-Token": token, "Content-Type": "application/json"}
        st, _, body = _raw_http(host, port, "GET", "/api/slots", headers=auth)
        self.assertEqual(st, 200)
        slots = json.loads(body.decode("utf-8"))["slots"]
        self.assertTrue(any(s["path"] == os.path.abspath(save_path) for s in slots))

        st, _, body = _raw_http(host, port, "POST", "/api/load", headers=auth, body=json.dumps({"path": save_path}).encode("utf-8"))
        self.assertEqual(st, 200)
        loaded = json.loads(body.decode("utf-8"))
        sha_loaded = loaded["sha256"]
        data_bytes = base64.b64decode(loaded["dataBase64"])
        self.assertEqual(_sha(data_bytes), sha_loaded)

        doc = ed.SaveDoc.parse(data_bytes)
        doc.coin = 888888
        mutated = doc.serialize()

        st, _, body = _raw_http(
            host, port, "POST", "/api/save", headers=auth,
            body=json.dumps({
                "path": save_path,
                "dataBase64": base64.b64encode(mutated).decode("ascii"),
                "expectedSha256": sha_loaded,
            }).encode("utf-8"),
        )
        self.assertEqual(st, 200, body)
        self.assertEqual(len(list(Path(save_dir).glob("Save.sav.backup-*.bak"))), 1)

        st, _, _ = _raw_http(
            host, port, "POST", "/api/save", headers=auth,
            body=json.dumps({
                "path": save_path,
                "dataBase64": base64.b64encode(mutated).decode("ascii"),
                "expectedSha256": sha_loaded,
            }).encode("utf-8"),
        )
        self.assertEqual(st, 409)

        os.environ["MYJH_SIMULATE_GAME_RUNNING"] = "1"
        try:
            st, _, _ = _raw_http(
                host, port, "POST", "/api/save", headers=auth,
                body=json.dumps({
                    "path": save_path,
                    "dataBase64": base64.b64encode(data_bytes).decode("ascii"),
                    "expectedSha256": _sha(mutated),
                }).encode("utf-8"),
            )
            self.assertEqual(st, 409)
        finally:
            os.environ.pop("MYJH_SIMULATE_GAME_RUNNING", None)

        st, _, _ = _raw_http(host, port, "POST", "/api/load", headers=auth, body=json.dumps({"path": txt_path}).encode("utf-8"))
        self.assertEqual(st, 403)

        # Concurrent save serialization test: 2 simultaneous saves with identical expectedSha256 -> {200, 409}
        cur_sha = ed.sha256_file(Path(save_path))
        doc_a = ed.SaveDoc.parse(Path(save_path).read_bytes())
        doc_a.coin = 111111
        b64_a = base64.b64encode(doc_a.serialize()).decode("ascii")
        doc_b = ed.SaveDoc.parse(Path(save_path).read_bytes())
        doc_b.coin = 222222
        b64_b = base64.b64encode(doc_b.serialize()).decode("ascii")

        barrier = threading.Barrier(2)
        statuses: list[int] = []

        def _worker(b64_payload: str) -> None:
            barrier.wait(timeout=5)
            st_code, _, _ = _raw_http(
                host, port, "POST", "/api/save", headers=auth,
                body=json.dumps({
                    "path": save_path,
                    "dataBase64": b64_payload,
                    "expectedSha256": cur_sha,
                }).encode("utf-8"),
            )
            statuses.append(st_code)

        t1 = threading.Thread(target=_worker, args=(b64_a,))
        t2 = threading.Thread(target=_worker, args=(b64_b,))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)
        self.assertEqual(sorted(statuses), [200, 409])

    def test_real_saves_if_present(self) -> None:
        real_dir = os.environ.get("MYJH_REAL_SAVE_DIR")
        if not real_dir or not os.path.isdir(real_dir):
            self.skipTest("MYJH_REAL_SAVE_DIR not set")
        found = 0
        for root, _dirs, files in os.walk(real_dir):
            for fn in files:
                if fn == "Save.sav":
                    raw = Path(root, fn).read_bytes()
                    doc = ed.SaveDoc.parse(raw)
                    self.assertEqual(doc.serialize(), raw)
                    doc.validate()
                    found += 1
        self.assertGreaterEqual(found, 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
