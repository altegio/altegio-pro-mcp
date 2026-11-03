"""Extract a pinned source archive without links, traversal or special files."""
import pathlib
import os
import shutil
import sys
import tarfile
import tempfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


archive_path, destination = sys.argv[1:]
root = pathlib.Path(destination)
root.parent.mkdir(parents=True, exist_ok=True)
require(
    not root.is_symlink() and (not root.exists() or (root.is_dir() and not any(root.iterdir()))),
    "Snapshot destination must be empty",
)
with tempfile.TemporaryDirectory(prefix=".spec-extract-", dir=root.parent) as temp:
    staging = pathlib.Path(temp) / "snapshot"
    staging.mkdir(mode=0o755)
    prefix = None
    total = 0
    seen = set()
    with tarfile.open(archive_path, "r:gz") as archive:
        for index, member in enumerate(archive):
            name = pathlib.PurePosixPath(member.name)
            require(
                index < 20000 and not name.is_absolute() and ".." not in name.parts
                and "\\" not in member.name and len(member.name.encode()) <= 1024,
                "Unsafe archive path or size",
            )
            require(
                (member.isdir() or member.isfile()) and member.sparse is None,
                "Archive links, sparse files and special files are forbidden",
            )
            require(name.parts and name not in seen, "Empty or duplicate archive path")
            seen.add(name)
            prefix = prefix or name.parts[0]
            require(name.parts[0] == prefix, "Archive must have one top-level directory")
            require(member.size >= 0 and (not member.isdir() or member.size == 0), "Invalid member size")
            total += member.size
            require(total <= 256 * 1024 * 1024, "Snapshot exceeds 256 MiB")
            if len(name.parts) == 1:
                require(member.isdir(), "Archive needs a top-level directory")
                continue
            # Only this subtree is covered by spec-pin.json. Never expose
            # unrelated, unverified source-archive files to candidate code.
            relative = name.parts[1:]
            if relative[:2] != ("docs", "en"):
                continue
            target = staging.joinpath(*relative)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open("xb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o644)
    require((staging / "docs/en").is_dir(), "Archive lacks the pinned subtree")
    if root.exists():
        root.rmdir()
    os.replace(staging, root)
