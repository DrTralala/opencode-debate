#!/usr/bin/env python3
"""Publish a validated transcript through a trusted directory descriptor."""
from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import stat
import sys
import time


def _require_descriptor_support() -> None:
    if sys.platform != "linux":
        raise RuntimeError("Linux is required for descriptor-relative transcript publication")
    if os.open not in os.supports_dir_fd or os.link not in os.supports_dir_fd:
        raise RuntimeError("platform lacks the directory-descriptor APIs required for safe publication")
    if os.link not in os.supports_follow_symlinks:
        raise RuntimeError("platform lacks no-follow hard-link publication support")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise RuntimeError("platform lacks the no-follow directory-open flags required for safe publication")
    if not os.path.isdir("/proc/self/fd"):
        raise RuntimeError("Linux /proc/self/fd is required for safe descriptor publication")


def _directory_flags() -> int:
    return os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def _open_existing_directory(path: str) -> int:
    absolute = os.path.abspath(path)
    current = os.open(os.path.sep, _directory_flags())
    try:
        for component in Path(absolute).parts[1:]:
            next_descriptor = os.open(component, _directory_flags(), dir_fd=current)
            os.close(current)
            current = next_descriptor
        return current
    except BaseException:
        os.close(current)
        raise


def _open_or_create_directory(parent: int, name: str) -> int:
    try:
        return os.open(name, _directory_flags(), dir_fd=parent)
    except FileNotFoundError:
        try:
            os.mkdir(name, 0o755, dir_fd=parent)
        except FileExistsError:
            pass
        return os.open(name, _directory_flags(), dir_fd=parent)


def _open_transcript_directory(project: str) -> tuple[int, int, int]:
    project_descriptor = _open_existing_directory(project)
    docs_descriptor: int | None = None
    try:
        docs_descriptor = _open_or_create_directory(project_descriptor, "docs")
        debates_descriptor = _open_or_create_directory(docs_descriptor, "debates")
        return project_descriptor, docs_descriptor, debates_descriptor
    except BaseException:
        if docs_descriptor is not None:
            os.close(docs_descriptor)
        os.close(project_descriptor)
        raise


def _identity(descriptor: int) -> tuple[int, int]:
    value = os.fstat(descriptor)
    if not stat.S_ISDIR(value.st_mode):
        raise RuntimeError("publication component is not a directory")
    return value.st_dev, value.st_ino


def _open_canonical_transcript_directory(project: str) -> tuple[int, int, int]:
    return _open_transcript_directory(project)


def _canonical_identity_matches(
    project: str,
    project_identity: tuple[int, int],
    docs_identity: tuple[int, int],
    debates_identity: tuple[int, int],
) -> bool:
    descriptors: tuple[int, int, int] | None = None
    try:
        descriptors = _open_canonical_transcript_directory(project)
        return (
            _identity(descriptors[0]) == project_identity
            and _identity(descriptors[1]) == docs_identity
            and _identity(descriptors[2]) == debates_identity
        )
    except (FileNotFoundError, NotADirectoryError, OSError):
        return False
    finally:
        if descriptors is not None:
            for descriptor in reversed(descriptors):
                os.close(descriptor)


def _fsync_directory(descriptor: int) -> None:
    try:
        os.fsync(descriptor)
    except OSError as error:
        if error.errno not in {errno.EBADF, errno.EINVAL, errno.ENOTSUP}:
            raise


def _same_regular_inode(left: os.stat_result, right: os.stat_result) -> bool:
    return (
        stat.S_ISREG(left.st_mode)
        and stat.S_ISREG(right.st_mode)
        and left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
    )


def _unlink_owned(
    descriptor: int,
    name: str,
    source_stat: os.stat_result,
) -> None:
    try:
        current = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        if _same_regular_inode(current, source_stat):
            os.unlink(name, dir_fd=descriptor)
            _fsync_directory(descriptor)
    except FileNotFoundError:
        pass


def _wait_for_release(path: str) -> None:
    barrier = Path(path)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("ready\n")
    except FileExistsError:
        pass
    with barrier.open("a", encoding="utf-8") as stream:
        stream.write(f"pid:{os.getpid()}\n")
    content = barrier.read_text(encoding="utf-8")
    if content.count("pid:") >= 2:
        with barrier.open("a", encoding="utf-8") as stream:
            stream.write("release\n")
    deadline = time.monotonic() + 10
    while True:
        if "release\n" in barrier.read_text(encoding="utf-8"):
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("publication barrier timed out")
        time.sleep(0.01)


def _write_all(descriptor: int, payload: bytes) -> None:
    remaining = memoryview(payload)
    while remaining:
        written = os.write(descriptor, remaining)
        if written <= 0:
            raise OSError(errno.EIO, "short transcript write")
        remaining = remaining[written:]


def publish(
    project: str,
    date: str,
    slug: str,
    markdown: str,
    barrier: str | None,
) -> tuple[str, str]:
    _require_descriptor_support()
    project_descriptor, docs_descriptor, debates_descriptor = _open_transcript_directory(project)
    project_identity = _identity(project_descriptor)
    docs_identity = _identity(docs_descriptor)
    debates_identity = _identity(debates_descriptor)
    temporary_name = f".{date}-{slug}-{os.getpid()}-{os.urandom(8).hex()}.tmp"
    temporary_descriptor: int | None = None
    source_stat: os.stat_result | None = None
    try:
        temporary_descriptor = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=debates_descriptor,
        )
        _write_all(temporary_descriptor, markdown.encode("utf-8"))
        os.fsync(temporary_descriptor)
        source_stat = os.fstat(temporary_descriptor)
        if not stat.S_ISREG(source_stat.st_mode):
            raise RuntimeError("temporary transcript is not a regular file")

        if barrier is not None:
            _wait_for_release(barrier)

        if not _canonical_identity_matches(
            project,
            project_identity,
            docs_identity,
            debates_identity,
        ):
            raise RuntimeError("canonical transcript directory changed before publication")

        current_source = os.fstat(temporary_descriptor)
        if not _same_regular_inode(current_source, source_stat):
            raise RuntimeError("temporary transcript inode changed before publication")

        for suffix in range(1, 2**31):
            filename = f"{date}-{slug}.md" if suffix == 1 else f"{date}-{slug}-{suffix}.md"
            try:
                os.link(
                    f"/proc/self/fd/{temporary_descriptor}",
                    filename,
                    dst_dir_fd=debates_descriptor,
                    follow_symlinks=True,
                )
            except FileExistsError:
                continue
            published_stat = os.stat(
                filename,
                dir_fd=debates_descriptor,
                follow_symlinks=False,
            )
            if not _same_regular_inode(published_stat, source_stat):
                _unlink_owned(debates_descriptor, filename, source_stat)
                raise RuntimeError("published transcript inode did not match the written inode")
            if not _canonical_identity_matches(
                project,
                project_identity,
                docs_identity,
                debates_identity,
            ):
                _unlink_owned(debates_descriptor, filename, source_stat)
                raise RuntimeError("canonical transcript directory changed during publication")
            _fsync_directory(debates_descriptor)
            token = json.dumps(
                {
                    "project": project_identity,
                    "docs": docs_identity,
                    "debates": debates_identity,
                    "filename": filename,
                    "source": (source_stat.st_dev, source_stat.st_ino),
                },
                separators=(",", ":"),
            )
            return filename, token
        raise RuntimeError("transcript filename suffix space exhausted")
    finally:
        if temporary_descriptor is not None:
            if source_stat is not None:
                _unlink_owned(debates_descriptor, temporary_name, source_stat)
            os.close(temporary_descriptor)
        os.close(debates_descriptor)
        os.close(docs_descriptor)
        os.close(project_descriptor)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--slug", required=True)
    parser.add_argument("--barrier")
    arguments = parser.parse_args(argv)
    try:
        filename, publication_token = publish(
            arguments.project,
            arguments.date,
            arguments.slug,
            sys.stdin.read(),
            arguments.barrier,
        )
    except (OSError, RuntimeError, TimeoutError) as error:
        print(f"publish_transcript: {error}", file=sys.stderr)
        return 2
    print(json.dumps({"filename": filename, "publicationToken": publication_token}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
