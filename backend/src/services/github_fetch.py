"""Download a repo tarball from GitHub and extract its Python sources.

Uses the user's OAuth token only in-memory. The tarball endpoint redirects to
codeload, so redirects are followed. Non-`.py` files are counted for the file
index but not read into memory.
"""

from __future__ import annotations

import io
import tarfile

import httpx

from src.config import get_settings

GH_API = "https://api.github.com"


class FetchResult:
    def __init__(self, sources: dict[str, str], total_file_count: int):
        self.sources = sources
        self.total_file_count = total_file_count


def _strip_root(name: str) -> str:
    """Tarballs nest everything under a `owner-repo-sha/` root dir; drop it."""
    parts = name.split("/", 1)
    return parts[1] if len(parts) == 2 else name


async def download_tarball(token: str, full_name: str, ref: str) -> FetchResult:
    settings = get_settings()
    ref_path = f"/{ref}" if ref else ""
    url = f"{GH_API}/repos/{full_name}/tarball{ref_path}"

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pullguard-ast",
    }

    async with httpx.AsyncClient(follow_redirects=True, timeout=60) as client:
        resp = await client.get(url, headers=headers)
        if resp.status_code != 200:
            raise RuntimeError(
                f"GitHub tarball fetch failed ({resp.status_code}) for {full_name}"
            )
        data = resp.content

    sources: dict[str, str] = {}
    total_file_count = 0

    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile():
                continue
            total_file_count += 1
            rel = _strip_root(member.name)
            if not rel.endswith(".py"):
                continue
            if member.size > settings.max_file_bytes:
                continue
            if len(sources) >= settings.max_python_files:
                continue
            fh = tar.extractfile(member)
            if fh is None:
                continue
            try:
                sources[rel] = fh.read().decode("utf-8", errors="replace")
            finally:
                fh.close()

    return FetchResult(sources=sources, total_file_count=total_file_count)
