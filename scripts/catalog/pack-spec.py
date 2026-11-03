"""Create a reproducible private bundle; print only its SHA256, never its input."""
import gzip
import hashlib
import pathlib
import sys
import tarfile


source, destination = map(pathlib.Path, sys.argv[1:])
source = source.resolve()
subtree = source / "docs/en"
if subtree.resolve() != subtree.absolute() or not subtree.is_dir():
    raise ValueError("Pinned subtree must be a directory without links")
files = sorted(subtree.rglob("*"))
if any(item.is_symlink() or not (item.is_file() or item.is_dir()) for item in files):
    raise ValueError("Pinned subtree must contain regular files without links")
with destination.open("xb") as output:
    with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
        with tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
            for item in [subtree, *files]:
                info = tarfile.TarInfo("snapshot/" + item.relative_to(source).as_posix())
                info.mode = 0o755 if item.is_dir() else 0o644
                if item.is_dir():
                    info.type = tarfile.DIRTYPE
                    archive.addfile(info)
                else:
                    info.size = item.stat().st_size
                    with item.open("rb") as content:
                        archive.addfile(info, content)
destination.chmod(0o600)
print(hashlib.sha256(destination.read_bytes()).hexdigest())
