from hashlib import sha256
import json
from pathlib import Path
import stat
import sys
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from workspace_backup import FORMAT, MANIFEST, VERSION, WORKSPACE, create_backup, inspect_backup, stage_backup


class WorkspaceBackupTests(unittest.TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "fern"
        self.root.mkdir()
        self.state = self.base / WORKSPACE
        self.state.write_text(json.dumps({"version": 1, "chats": {
            "threads": [{"draft": "Unsent draft", "versions": [{"id": "saved", "messages": [{"content": "Saved reply"}]}]}],
        }, "settings": {"theme": "dark"}}), encoding="utf-8")
        self.archive = self.base / "workspace.fern-backup"
        self.staged = self.base / "staged"

    def add_file(self, name, content=b"fixture"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def write_archive(self, entries, overrides=None, extra=None):
        records = [{"path": entry.filename if isinstance(entry, ZipInfo) else entry, "size": len(data),
                    "sha256": sha256(data).hexdigest(), "mtimeNs": 1}
                   for entry, data in entries]
        if overrides:
            records[-1].update(overrides)
        with ZipFile(self.archive, "w") as archive:
            for name, data in entries + (extra or []):
                archive.writestr(name, data)
            archive.writestr(MANIFEST, json.dumps({
                "format": FORMAT, "version": VERSION, "createdAt": "2026-11-24T00:00:00+00:00", "files": records,
            }))

    def test_round_trip_preserves_state_and_assets_without_runtime_files(self):
        contents = {
            "outputs/poster.png": b"poster",
            "outputs/voice.wav": b"take",
            "outputs/clip.webm": b"clip",
            "data/references/chat-image-test.png": b"reference",
            "data/chat-documents/research.json": b'{"notes":"Preserved document text"}',
            "data/videos/video.json": b'{"prompt":"Animate this still"}',
            "data/flux2_gallery.json": b'{"poster.png":{"threadId":"original"}}',
        }
        for name, content in contents.items():
            self.add_file(name, content)
        for name in ("models/large.gguf", ".cache/draft.png", "data/text-models.json",
                     "data/gguf-runtime/executable", "data/loras/reference.safetensors", "outputs/temporary.part"):
            self.add_file(name, b"leave out of archive")
        exported = create_backup(self.root, self.state, self.archive)
        self.assertEqual(exported, inspect_backup(self.archive))
        self.assertEqual(exported, stage_backup(self.archive, self.staged))
        self.assertEqual(exported["fileCount"], len(contents))
        contents[WORKSPACE] = self.state.read_bytes()
        self.assertEqual({path.relative_to(self.staged).as_posix(): path.read_bytes()
                          for path in self.staged.rglob("*") if path.is_file()}, contents)
        self.assertEqual((self.staged / "outputs/poster.png").stat().st_mtime_ns,
                         (self.root / "outputs/poster.png").stat().st_mtime_ns)

    def test_invalid_member_paths_and_links_are_rejected(self):
        link = ZipInfo("outputs/linked.png")
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for entry in ("../outside.png", "/outputs/absolute.png", "outputs/../../outside.png",
                      "outputs\\escape.png", "outputs/CON.png", "outputs/ends-with.png.", "data/text-models.json", link):
            with self.subTest(entry=entry):
                self.write_archive([(WORKSPACE, b"{}"), (entry, b"unsafe")])
                with self.assertRaises(ValueError):
                    stage_backup(self.archive, self.staged)
                self.assertFalse(self.staged.exists())

    def test_conflicts_and_unlisted_entries_are_rejected(self):
        self.write_archive([(WORKSPACE, b"{}"), ("outputs/same.png", b"lower"), ("outputs/SAME.png", b"upper")])
        with self.assertRaisesRegex(ValueError, "conflicting"):
            inspect_backup(self.archive)
        self.write_archive([(WORKSPACE, b"{}")], extra=[("outputs/extra.png", b"unlisted")])
        with self.assertRaisesRegex(ValueError, "missing from its manifest"):
            inspect_backup(self.archive)

    def test_bad_digest_does_not_publish_an_incomplete_restore(self):
        self.write_archive([(WORKSPACE, b"{}"), ("outputs/poster.png", b"changed")], overrides={"sha256": "0" * 64})
        with self.assertRaisesRegex(ValueError, "integrity check"):
            stage_backup(self.archive, self.staged)
        self.assertFalse(self.staged.exists())
        self.assertEqual(list(self.base.glob(".fern-restore-*")), [])

    def test_write_failure_keeps_prior_backup_at_the_chosen_location(self):
        self.archive.write_bytes(b"previous backup")
        self.add_file("outputs/poster.png")
        with patch("workspace_backup.copy_member", side_effect=OSError("Disk disconnected")):
            with self.assertRaisesRegex(OSError, "Disk disconnected"):
                create_backup(self.root, self.state, self.archive)
        self.assertEqual(self.archive.read_bytes(), b"previous backup")
        self.assertEqual(list(self.base.glob(".fern-backup-*")), [])

    def test_staged_restore_refuses_an_existing_directory(self):
        create_backup(self.root, self.state, self.archive)
        self.staged.mkdir()
        (self.staged / WORKSPACE).write_bytes(b"saved workspace")
        with self.assertRaisesRegex(ValueError, "new folder"):
            stage_backup(self.archive, self.staged)
        self.assertEqual((self.staged / WORKSPACE).read_bytes(), b"saved workspace")


if __name__ == "__main__":
    unittest.main()
