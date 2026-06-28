"""GitHub App client: authenticate as the App, then act on a single PR.

CodeRabbit-style flow needs two credentials the OAuth user-token path can't give:

  1. An *App JWT* (RS256, signed with the App's private key) to look up which
     installation covers a repo.
  2. A short-lived *installation access token* (scoped to that installation,
     ~1h) used for every read/write on the repo — including posting the review
     comment back onto the PR.

Everything here is per-delivery and in-memory; no token is persisted.
"""

from __future__ import annotations

import logging
import time
from functools import lru_cache

import httpx
import jwt

from src.config import get_settings

logger = logging.getLogger("github_app")

GH_API = "https://api.github.com"


@lru_cache
def _private_key() -> str:
    settings = get_settings()
    if not settings.github_app_private_key_path:
        raise RuntimeError("GITHUB_APP_PRIVATE_KEY_PATH is not configured")
    with open(settings.github_app_private_key_path, "r", encoding="utf-8") as fh:
        return fh.read()


def app_jwt() -> str:
    """Mint a 10-minute App JWT (RS256). `iat` is backdated 60s for clock skew."""
    settings = get_settings()
    if not settings.github_app_id:
        raise RuntimeError("GITHUB_APP_ID is not configured")
    now = int(time.time())
    payload = {"iat": now - 60, "exp": now + 600, "iss": settings.github_app_id}
    return jwt.encode(payload, _private_key(), algorithm="RS256")


def _app_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {app_jwt()}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pullguard-app",
    }


async def installation_token(full_name: str) -> str:
    """Exchange the App JWT for an installation token scoped to `owner/repo`."""
    owner, repo = full_name.split("/", 1)
    async with httpx.AsyncClient(timeout=30) as client:
        inst = await client.get(
            f"{GH_API}/repos/{owner}/{repo}/installation", headers=_app_headers()
        )
        if inst.status_code != 200:
            raise RuntimeError(
                f"App not installed on {full_name} ({inst.status_code}). "
                "Install it on the repo from the App's public page."
            )
        installation_id = inst.json()["id"]

        tok = await client.post(
            f"{GH_API}/app/installations/{installation_id}/access_tokens",
            headers=_app_headers(),
        )
        if tok.status_code != 201:
            raise RuntimeError(
                f"Could not mint installation token ({tok.status_code}): {tok.text}"
            )
        return tok.json()["token"]


def _token_headers(token: str, accept: str = "application/vnd.github+json") -> dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "pullguard-app",
    }


class PRContext:
    """Everything the reviewer LLM needs that lives on GitHub's side of the PR."""

    def __init__(
        self,
        full_name: str,
        number: int,
        title: str,
        body: str,
        head_sha: str,
        base_ref: str,
        head_ref: str,
        diff: str,
        changed_files: list[str],
        issues: list[dict],
        author: str = "",
        state: str = "open",
        url: str = "",
    ):
        self.full_name = full_name
        self.number = number
        self.title = title
        self.body = body
        self.head_sha = head_sha
        self.base_ref = base_ref
        self.head_ref = head_ref
        self.diff = diff
        self.changed_files = changed_files
        self.issues = issues
        self.author = author
        self.state = state
        self.url = url


def _linked_issue_numbers(body: str) -> list[int]:
    """Pull `#123` / closing-keyword references out of the PR body."""
    import re

    nums = {int(n) for n in re.findall(r"#(\d+)", body or "")}
    return sorted(nums)


async def fetch_pr_context(token: str, full_name: str, number: int) -> PRContext:
    owner, repo = full_name.split("/", 1)
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as client:
        meta_resp, diff_resp, files_resp = await _gather(
            client,
            (f"{GH_API}/repos/{owner}/{repo}/pulls/{number}", _token_headers(token)),
            (
                f"{GH_API}/repos/{owner}/{repo}/pulls/{number}",
                _token_headers(token, "application/vnd.github.v3.diff"),
            ),
            (
                f"{GH_API}/repos/{owner}/{repo}/pulls/{number}/files?per_page=100",
                _token_headers(token),
            ),
        )
        if meta_resp.status_code != 200:
            raise RuntimeError(
                f"PR fetch failed ({meta_resp.status_code}): {meta_resp.text[:200]}"
            )
        meta = meta_resp.json()
        diff = diff_resp.text if diff_resp.status_code == 200 else ""
        changed_files = (
            [f["filename"] for f in files_resp.json()]
            if files_resp.status_code == 200
            else []
        )

        issues: list[dict] = []
        for n in _linked_issue_numbers(meta.get("body") or ""):
            ir = await client.get(
                f"{GH_API}/repos/{owner}/{repo}/issues/{n}", headers=_token_headers(token)
            )
            if ir.status_code == 200:
                j = ir.json()
                # A PR is also an "issue"; skip those, keep real issues only.
                if "pull_request" not in j:
                    issues.append(
                        {"number": j["number"], "title": j["title"], "body": j.get("body") or ""}
                    )

    state = "merged" if meta.get("merged_at") else meta.get("state", "open")
    return PRContext(
        full_name=full_name,
        number=number,
        title=meta.get("title", ""),
        body=meta.get("body") or "",
        head_sha=meta["head"]["sha"],
        base_ref=meta["base"]["ref"],
        head_ref=meta["head"]["ref"],
        diff=diff,
        changed_files=changed_files,
        issues=issues,
        author=(meta.get("user") or {}).get("login", ""),
        state=state,
        url=meta.get("html_url", ""),
    )


async def _gather(client: httpx.AsyncClient, *reqs):
    import asyncio

    return await asyncio.gather(*(client.get(url, headers=h) for url, h in reqs))


async def upsert_pr_comment(
    token: str, full_name: str, number: int, body: str, marker: str
) -> str:
    """Create the review comment, or update our previous one if `marker` is found.

    Keeps the PR to a single PullGuard section that refreshes on each push,
    instead of stacking a new comment per `synchronize` event.
    """
    owner, repo = full_name.split("/", 1)
    base = f"{GH_API}/repos/{owner}/{repo}/issues/{number}/comments"
    async with httpx.AsyncClient(timeout=30) as client:
        existing = await client.get(f"{base}?per_page=100", headers=_token_headers(token))
        if existing.status_code == 200:
            for c in existing.json():
                if marker in (c.get("body") or ""):
                    patch = await client.patch(
                        f"{GH_API}/repos/{owner}/{repo}/issues/comments/{c['id']}",
                        headers=_token_headers(token),
                        json={"body": body},
                    )
                    if patch.status_code == 200:
                        return patch.json().get("html_url", "")
                    break  # fall through to create on patch failure

        resp = await client.post(base, headers=_token_headers(token), json={"body": body})
        if resp.status_code != 201:
            raise RuntimeError(
                f"Posting PR comment failed ({resp.status_code}): {resp.text[:200]}"
            )
        return resp.json().get("html_url", "")
