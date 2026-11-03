"""Extract a pinned source archive without links, traversal or special files."""
import pathlib
import shutil
import sys
import tarfile

archive_path, destination = sys.argv[1:]
root = pathlib.Path(destination)
root.mkdir(parents=True, exist_ok=True)
assert not root.is_symlink() and not any(root.iterdir()), "Snapshot destination must be empty"
prefix = None
total = 0
with tarfile.open(archive_path, "r:gz") as archive:
    for index, member in enumerate(archive):
        name = pathlib.PurePosixPath(member.name)
        assert index < 20000 and not name.is_absolute() and ".." not in name.parts, "Unsafe archive path or size"
        assert member.isdir() or member.isfile(), "Archive links and special files are forbidden"
        assert name.parts, "Empty archive path"
        prefix = prefix or name.parts[0]
        assert name.parts[0] == prefix, "Archive must have one top-level directory"
        if len(name.parts) == 1:
            assert member.isdir(), "Archive needs a top-level directory"
            continue
        target = root.joinpath(*name.parts[1:])
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            total += member.size
            assert total <= 256 * 1024 * 1024, "Snapshot exceeds 256 MiB"
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.extractfile(member) as source, target.open("xb") as output:
                shutil.copyfileobj(source, output)
            target.chmod(0o644)
