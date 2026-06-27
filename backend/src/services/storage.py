"""Screenshot storage — Supabase Storage (S3-compatible) via its REST API.

Upload happens from the backend with the service_role key. If storage isn't
configured (no key), `store_screenshot` returns a base64 `data:` URI so the
frontend can still render the screenshot without any object store.

Public URL shape:
  {SUPABASE_URL}/storage/v1/object/public/{bucket}/{path}
"""

from __future__ import annotations

import base64
import logging

import httpx

from src.config import get_settings

logger = logging.getLogger("storage")

_bucket_ready = False


def storage_configured() -> bool:
    s = get_settings()
    return bool(s.supabase_url and s.supabase_service_role_key)


async def _ensure_bucket(client: httpx.AsyncClient) -> None:
    """Create the public bucket once per process (ignore 'already exists')."""
    global _bucket_ready
    if _bucket_ready:
        return
    s = get_settings()
    resp = await client.post(
        f"{s.supabase_url}/storage/v1/bucket",
        json={"id": s.supabase_storage_bucket, "name": s.supabase_storage_bucket, "public": True},
    )
    if resp.status_code not in (200, 201, 409, 400):
        logger.warning("bucket create unexpected %s: %s", resp.status_code, resp.text[:200])
    _bucket_ready = True


async def store_screenshot(
    path: str, data: bytes, content_type: str = "image/png"
) -> str:
    """Upload image bytes and return a public URL, or a data: URI fallback."""
    s = get_settings()
    if not storage_configured():
        b64 = base64.b64encode(data).decode("ascii")
        return f"data:{content_type};base64,{b64}"

    headers = {
        "Authorization": f"Bearer {s.supabase_service_role_key}",
        "apikey": s.supabase_service_role_key,
    }
    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        await _ensure_bucket(client)
        url = f"{s.supabase_url}/storage/v1/object/{s.supabase_storage_bucket}/{path}"
        resp = await client.post(
            url,
            content=data,
            headers={"Content-Type": content_type, "x-upsert": "true"},
        )
        if resp.status_code not in (200, 201):
            logger.warning(
                "screenshot upload failed %s: %s — falling back to data URI",
                resp.status_code,
                resp.text[:200],
            )
            b64 = base64.b64encode(data).decode("ascii")
            return f"data:{content_type};base64,{b64}"
    public = f"{s.supabase_url}/storage/v1/object/public/{s.supabase_storage_bucket}/{path}"
    logger.info("screenshot stored: %s", public)
    return public
