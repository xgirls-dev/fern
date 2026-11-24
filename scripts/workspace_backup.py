"""Portable archives of Fern's workspace and its user-created files."""

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
from tempfile import TemporaryDirectory
from unicodedata import normalize
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile, ZipInfo

FORMAT = "fern-workspace"
VERSION = 1
MANIFEST = "manifest.json"
WORKSPACE = "workspace.json"
CHUNK_SIZE = 1024 * 1024
MAX_MANIFEST_SIZE = 32 * 1024 * 1024

# Keep this list independent of the runtime, model registries, and caches.
FILE_TYPES = {
    "outputs": {".png", ".wav", ".webm"},
    "data/references": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".wav"},
    "data/chat-documents": {".json"},
    "data/videos": {".json"},
}
GALLERY = "data/flux2_gallery.json"
INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED_NAME = re.compile(r"(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])(?:\..*)?", re.IGNORECASE)


def portable_name(name):
    return bool(name) and name not in (".", "..") and not (
        name[-1] in ". " or INVALID_NAME.search(name) or RESERVED_NAME.fullmatch(name)
    )


def archive_member(name):
    if not isinstance(name, str):
        return False
    if name in (WORKSPACE, GALLERY):
        return True
    group, _, filename = name.rpartition("/")
    return group in FILE_TYPES and portable_name(filename) and Path(filename).suffix.lower() in FILE_TYPES[group]


def member_key(name):
    return normalize("NFC", name).casefold()


def linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def regular_file(path):
    info = path.lstat()
    if linked(info) or not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Backup requires a regular file: {path.name}.")
    return info


def source_directory(root, group):
    current = root
    for component in group.split("/"):
        current /= component
        try:
            info = current.lstat()
        except FileNotFoundError:
            return None
        if linked(info) or not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"Backup cannot read the workspace folder {group}.")
    return current


def sources(root, state):
    yield WORKSPACE, state
    data = source_directory(root, "data")
    if data is not None:
        gallery = data / Path(GALLERY).name
        if gallery.exists() or gallery.is_symlink():
            yield GALLERY, gallery
    for group, extensions in FILE_TYPES.items():
        directory = source_directory(root, group)
        if directory is None:
            continue
        for path in sorted(directory.iterdir()):
            if path.suffix.lower() not in extensions:
                continue
            name = f"{group}/{path.name}"
            if not archive_member(name):
                raise ValueError(f"This workspace contains a file name that will not work across platforms: {path.name}.")
            yield name, path


def copy_member(source, target, expected_size):
    digest = sha256()
    remaining = expected_size
    while chunk := source.read(CHUNK_SIZE):
        remaining -= len(chunk)
        if remaining < 0:
            raise ValueError("An archive file is larger than its recorded size.")
        digest.update(chunk)
        target.write(chunk)
    if remaining:
        raise ValueError("An archive file is smaller than its recorded size.")
    return digest.hexdigest()


def unchanged(original, latest):
    return (original.st_dev, original.st_ino, original.st_size, original.st_mtime_ns, original.st_ctime_ns) == (
        latest.st_dev, latest.st_ino, latest.st_size, latest.st_mtime_ns, latest.st_ctime_ns
    )


def create_backup(root, state, destination):
    """Publish the archive only after every file has been read successfully."""
    root = root.resolve()
    state = state.resolve()
    destination = destination.absolute()
    if destination.suffix.lower() != ".fern-backup":
        raise ValueError("Choose a .fern-backup file for your workspace backup.")
    with TemporaryDirectory(prefix=".fern-backup-", dir=destination.parent) as temporary:
        staged = Path(temporary) / "backup.zip"
        exact_files = list(sources(root, state))
        records = []
        observed = []
        seen = set()
        with ZipFile(staged, "w", allowZip64=True) as archive:
            for name, path in exact_files:
                info = regular_file(path)
                key = member_key(name)
                if key in seen:
                    raise ValueError(f"Two workspace files have the same portable name: {path.name}.")
                seen.add(key)

                entry = ZipInfo(name)
                entry.external_attr = (stat.S_IFREG | 0o600) << 16
                entry.compress_type = ZIP_DEFLATED if path.suffix.lower() == ".json" else ZIP_STORED
                entry.file_size = info.st_size
                flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
                with os.fdopen(os.open(path, flags), "rb") as source:
                    if not unchanged(info, os.fstat(source.fileno())):
                        raise ValueError(f"Workspace file changed while backing up: {path.name}.")
                    with archive.open(entry, "w", force_zip64=True) as target:
                        signature = copy_member(source, target, info.st_size)
                records.append({"path": name, "size": info.st_size, "sha256": signature, "mtimeNs": info.st_mtime_ns})
                observed.append((path, info))

            if list(sources(root, state)) != exact_files or any(
                not unchanged(info, regular_file(path)) for path, info in observed
            ):
                raise ValueError("Workspace files changed during backup. Finish any work in progress and try again.")
            manifest = {
                "format": FORMAT, "version": VERSION,
                "createdAt": datetime.now(timezone.utc).isoformat(), "files": records,
            }
            payload = json.dumps(manifest, separators=(",", ":")).encode("utf-8")
            if len(payload) > MAX_MANIFEST_SIZE:
                raise ValueError("This workspace has too many files for a single backup.")
            archive.writestr(MANIFEST, payload, compress_type=ZIP_DEFLATED)
        with staged.open("rb+") as file:
            os.fsync(file.fileno())
        os.replace(staged, destination)
    return preview(manifest)


def check_entry(entry):
    mode = entry.external_attr >> 16
    if (entry.orig_filename != entry.filename or entry.is_dir() or stat.S_IFMT(mode) not in (0, stat.S_IFREG) or
            entry.flag_bits & 1 or entry.compress_type not in (ZIP_STORED, ZIP_DEFLATED)):
        raise ValueError("The backup contains an unsupported archive entry.")


def read_manifest(archive):
    entries = archive.infolist()
    inventory = {entry.filename: entry for entry in entries}
    if len(inventory) != len(entries):
        raise ValueError("The backup contains duplicate entries.")
    manifest_entry = inventory.pop(MANIFEST, None)
    if manifest_entry is None or manifest_entry.file_size > MAX_MANIFEST_SIZE:
        raise ValueError("The workspace backup manifest is missing or too large.")
    check_entry(manifest_entry)
    try:
        manifest = json.loads(archive.read(manifest_entry))
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ValueError("The workspace backup manifest cannot be read.") from error
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT:
        raise ValueError("This file is not a Fern workspace backup.")
    if type(manifest.get("version")) is not int or manifest["version"] != VERSION:
        raise ValueError("This backup uses a different Fern workspace format.")
    if not isinstance(manifest.get("createdAt"), str) or len(manifest["createdAt"]) > 60:
        raise ValueError("The workspace backup creation date is invalid.")
    try:
        datetime.fromisoformat(manifest["createdAt"])
    except ValueError as error:
        raise ValueError("The workspace backup creation date is invalid.") from error
    records = manifest.get("files")
    if not isinstance(records, list) or WORKSPACE not in inventory:
        raise ValueError("The workspace backup is missing its workspace data.")
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not archive_member(record.get("path")):
            raise ValueError("The backup contains a file outside the Fern workspace.")
        name = record["path"]
        key = member_key(name)
        entry = inventory.pop(name, None)
        if key in seen or entry is None:
            raise ValueError("The backup contains conflicting or missing files.")
        seen.add(key)
        check_entry(entry)
        signature = record.get("sha256")
        mtime = record.get("mtimeNs")
        if (type(record.get("size")) is not int or record["size"] != entry.file_size or
                not isinstance(signature, str) or not re.fullmatch("[a-f0-9]{64}", signature) or
                type(mtime) is not int or not -(2**63) <= mtime <= 2**63 - 1):
            raise ValueError("The backup contains invalid file details.")
    if inventory:
        raise ValueError("The backup contains files that are missing from its manifest.")
    return manifest


def preview(manifest):
    return {
        "createdAt": manifest["createdAt"],
        "fileCount": len(manifest["files"]) - 1,
        "size": sum(record["size"] for record in manifest["files"]),
    }


def inspect_backup(path):
    with ZipFile(path) as archive:
        return preview(read_manifest(archive))


def stage_backup(path, destination):
    """Verify every entry before publishing a new workspace staging directory."""
    if destination.exists() or destination.is_symlink():
        raise ValueError("Choose a new folder for the staged workspace.")
    with ZipFile(path) as archive:
        manifest = read_manifest(archive)
        if preview(manifest)["size"] > shutil.disk_usage(destination.parent).free:
            raise ValueError("There is not enough disk space to unpack this workspace backup.")
        with TemporaryDirectory(prefix=".fern-restore-", dir=destination.parent) as temporary:
            staged = Path(temporary) / "restore"
            staged.mkdir(mode=0o700)
            for record in manifest["files"]:
                name = record["path"]
                output = staged / name
                output.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(name) as source, output.open("xb") as target:
                    signature = copy_member(source, target, record["size"])
                if signature != record["sha256"]:
                    raise ValueError(f"The backup failed its integrity check for {name}.")
                os.utime(output, ns=(record["mtimeNs"], record["mtimeNs"]))
            os.rename(staged, destination)
    return preview(manifest)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    create = commands.add_parser("create")
    create.add_argument("root", type=Path)
    create.add_argument("state", type=Path)
    create.add_argument("destination", type=Path)
    inspect = commands.add_parser("inspect")
    inspect.add_argument("archive", type=Path)
    stage = commands.add_parser("stage")
    stage.add_argument("archive", type=Path)
    stage.add_argument("destination", type=Path)
    args = parser.parse_args()
    try:
        if args.operation == "create":
            result = create_backup(args.root, args.state, args.destination)
        elif args.operation == "inspect":
            result = inspect_backup(args.archive)
        else:
            result = stage_backup(args.archive, args.destination)
    except BadZipFile:
        sys.exit("This workspace backup is damaged or is not a readable archive.")
    except (ValueError, OSError, RuntimeError) as error:
        sys.exit(str(error))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
