"""Screenshot encoding — the backend does no object storage.

Persistence is the frontend's job, so the backend simply returns each
screenshot as a base64 `data:` URI. The frontend stores it (and may re-host it)
however it likes; the backend stays stateless.

Public URL shape (when the frontend re-hosts) is up to the frontend.
"""

from __future__ import annotations

import base64
import logging

logger = logging.getLogger("storage")


async def store_screenshot(
    path: str, data: bytes, content_type: str = "image/png"
) -> str:
    """Return image bytes as a `data:` URI for the frontend to persist.

    `path` is accepted for call-site compatibility but unused — the backend
    no longer writes to any bucket.
    """
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{content_type};base64,{b64}"
