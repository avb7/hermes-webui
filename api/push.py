"""Web Push notifications for Hermes WebUI.

Fork-only addition: lets the user receive native OS notifications when an
agent finishes a turn in a session, even with the browser tab closed.

Architecture:
- VAPID keypair generated once and persisted at $STATE_DIR/push-keys.json.
  Public key (URL-safe base64 of the uncompressed P-256 point) is exposed
  via /api/push/public-key for the frontend to use as applicationServerKey.
- Push subscriptions are JSON dicts (endpoint + p256dh + auth keys)
  persisted at $STATE_DIR/push-subscriptions.json, deduped by endpoint.
- send_to_all() POSTs to the push services with VAPID-signed JWT auth.
  Dead subscriptions (404/410 from the push service) are auto-pruned.

This module degrades gracefully if pywebpush isn't installed — every
endpoint returns 503 with a helpful message; the stream-end hook becomes
a no-op. So WebUI startup never crashes from a missing dep.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any

try:
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import ec

    _CRYPTO = True
except Exception:
    _CRYPTO = False

try:
    from pywebpush import WebPushException, webpush
    from py_vapid import Vapid01

    _PYWEBPUSH = True
except Exception:
    WebPushException = Exception  # type: ignore
    webpush = None  # type: ignore
    Vapid01 = None  # type: ignore
    _PYWEBPUSH = False


logger = logging.getLogger("hermes.push")


# Subject claim embedded in the VAPID JWT (RFC 8292 §2.1). Push services use
# this so they can contact the sender if a subscription misbehaves. MUST be
# either a "mailto:" or "https:" URI.
#
# Apple's push service (web.push.apple.com) is *strict* here: a localhost
# domain or non-resolving hostname triggers a silent 400/403 reject (Apple
# returns 'BadJwtToken' with no further detail). We default to the public
# GitHub URL of the fork so the claim is a real, resolvable HTTPS URI. Override
# via the HERMES_WEBUI_PUSH_VAPID_SUB env var if you want your own contact.
VAPID_SUB = os.environ.get(
    "HERMES_WEBUI_PUSH_VAPID_SUB",
    "https://github.com/avb7/hermes-webui",
)

_LOCK = threading.Lock()
_keys_cache: dict | None = None
_subs_cache: list | None = None


def is_available() -> bool:
    return _CRYPTO and _PYWEBPUSH


def availability_reason() -> str:
    missing = []
    if not _CRYPTO:
        missing.append("cryptography")
    if not _PYWEBPUSH:
        missing.append("pywebpush")
    if not missing:
        return ""
    return "missing python deps: " + ", ".join(missing)


def _state_dir() -> Path:
    raw = os.environ.get("HERMES_WEBUI_STATE_DIR") or os.path.expanduser(
        "~/.hermes/webui"
    )
    p = Path(raw).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


def _keys_path() -> Path:
    return _state_dir() / "push-keys.json"


def _private_pem_path() -> Path:
    # Sidecar PEM file. We pass this path to pywebpush instead of the PEM
    # string because py_vapid.Vapid01.from_string() does not handle PEM
    # input correctly (it tries to DER-decode the body and fails with
    # "ASN.1 parsing error: invalid length"). Vapid01.from_file() works.
    return _state_dir() / "push-private.pem"


def _subs_path() -> Path:
    return _state_dir() / "push-subscriptions.json"


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _generate_vapid_keys() -> dict:
    if not _CRYPTO:
        raise RuntimeError("cryptography not installed")
    pk = ec.generate_private_key(ec.SECP256R1())
    # SEC1 / TraditionalOpenSSL format ("-----BEGIN EC PRIVATE KEY-----")
    # is the canonical VAPID private-key format and what py_vapid /
    # pywebpush deserialize without issue. PKCS#8 PEM ("-----BEGIN PRIVATE
    # KEY-----") fails to load via py_vapid's wrapper with a confusing
    # "EC curves with explicit parameters" error.
    private_pem = pk.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    pub_bytes = pk.public_key().public_bytes(
        encoding=serialization.Encoding.X962,
        format=serialization.PublicFormat.UncompressedPoint,
    )
    return {
        "private_pem": private_pem,
        "public_b64url": _b64url(pub_bytes),
        "created": int(time.time()),
    }


def _write_keys_files(keys: dict) -> None:
    """Persist keys to push-keys.json + sidecar push-private.pem."""
    try:
        p = _keys_path()
        p.write_text(json.dumps(keys, indent=2))
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
    except OSError:
        pass
    try:
        pem_path = _private_pem_path()
        pem_path.write_text(keys["private_pem"])
        try:
            os.chmod(pem_path, 0o600)
        except OSError:
            pass
    except OSError:
        pass


def get_keys() -> dict:
    """Return persisted VAPID keys, creating them on first call."""
    global _keys_cache
    with _LOCK:
        if _keys_cache is not None:
            # Make sure the PEM sidecar exists even if it was deleted
            # out-of-band after we cached the JSON.
            if not _private_pem_path().exists():
                _write_keys_files(_keys_cache)
            return _keys_cache
        p = _keys_path()
        if p.exists():
            try:
                _keys_cache = json.loads(p.read_text())
                # Backfill the sidecar PEM for keystores generated by an
                # older version of this module that only wrote the JSON.
                if not _private_pem_path().exists():
                    _write_keys_files(_keys_cache)
                return _keys_cache
            except Exception:
                pass
        if not _CRYPTO:
            raise RuntimeError(availability_reason())
        keys = _generate_vapid_keys()
        _write_keys_files(keys)
        _keys_cache = keys
        return keys


def public_key_b64url() -> str:
    return get_keys()["public_b64url"]


def _load_subs() -> list:
    global _subs_cache
    if _subs_cache is not None:
        return _subs_cache
    p = _subs_path()
    if p.exists():
        try:
            data = json.loads(p.read_text())
            if isinstance(data, dict):
                _subs_cache = list(data.get("subscriptions") or [])
            elif isinstance(data, list):
                _subs_cache = list(data)
            else:
                _subs_cache = []
        except Exception:
            _subs_cache = []
    else:
        _subs_cache = []
    return _subs_cache


def _save_subs(subs: list) -> None:
    global _subs_cache
    _subs_cache = list(subs)
    p = _subs_path()
    payload = {"subscriptions": _subs_cache}
    try:
        p.write_text(json.dumps(payload, indent=2))
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
    except OSError:
        pass


def list_subscriptions() -> list:
    with _LOCK:
        return [dict(s) for s in _load_subs()]


def add_subscription(sub: dict) -> dict:
    """Store a new subscription, keyed by its endpoint."""
    endpoint = sub.get("endpoint") or ""
    keys = sub.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("subscription must have endpoint, keys.p256dh, keys.auth")
    now = int(time.time())
    record = {
        "endpoint": endpoint,
        "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]},
        "created": now,
        "last_seen": now,
        "user_agent": sub.get("user_agent") or "",
    }
    with _LOCK:
        subs = _load_subs()
        # Replace any existing record with this endpoint
        subs = [s for s in subs if s.get("endpoint") != endpoint]
        subs.append(record)
        _save_subs(subs)
    return record


def remove_subscription(endpoint: str) -> bool:
    if not endpoint:
        return False
    with _LOCK:
        subs = _load_subs()
        new = [s for s in subs if s.get("endpoint") != endpoint]
        if len(new) == len(subs):
            return False
        _save_subs(new)
        return True


def _identify_endpoint(endpoint: str) -> str:
    """Return a short tag for the push service host (for log readability)."""
    if "web.push.apple.com" in endpoint:
        return "apple"
    if "fcm.googleapis.com" in endpoint or "fcm.android.com" in endpoint:
        return "fcm"
    if "updates.push.services.mozilla.com" in endpoint:
        return "mozilla"
    if "wns2-" in endpoint or "notify.windows.com" in endpoint:
        return "windows"
    return "other"


def send_to_all(payload: dict, *, ttl: int = 86400) -> dict:
    """Deliver `payload` (any JSON-serializable dict) to every subscription.
    Auto-prunes endpoints that return 404/410 (gone) or 403 with the well-known
    "subscription bound to a different VAPID key" body shapes.

    ttl=86400 (24h) by default — Apple in particular favours longer TTLs;
    shorter values can be silently bounced. Callers can override per-event.

    Returns {"sent": N, "removed": M, "errors": [...]} for diagnostics.
    """
    if not is_available():
        return {"sent": 0, "removed": 0, "errors": ["push not available"]}
    get_keys()  # ensures both keys.json and the sidecar PEM exist on disk
    pem_path = str(_private_pem_path())
    payload_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    sent = 0
    removed = 0
    errors: list[str] = []
    with _LOCK:
        subs = list(_load_subs())
    dead: list[str] = []
    logger.info(
        "send_to_all start: subs=%d ttl=%ds sub_claim=%s payload_bytes=%d",
        len(subs), ttl, VAPID_SUB, len(payload_bytes),
    )
    for sub in subs:
        svc = _identify_endpoint(sub["endpoint"])
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": sub["keys"],
                },
                data=payload_bytes,
                vapid_private_key=pem_path,
                vapid_claims={"sub": VAPID_SUB},
                ttl=ttl,
            )
            sent += 1
            logger.info("webpush ok: svc=%s ep=%s", svc, sub["endpoint"][:80])
        except WebPushException as e:
            code = getattr(getattr(e, "response", None), "status_code", 0)
            body = ""
            try:
                body = e.response.text  # type: ignore[attr-defined]
            except Exception:
                body = str(e)
            headers = {}
            try:
                headers = dict(e.response.headers or {})  # type: ignore[attr-defined]
            except Exception:
                pass
            # Always log the full failure so future Apple/FCM regressions
            # leave a trace. Service tag + HTTP code + first 300 chars of
            # body is enough to diagnose every known web-push failure mode.
            logger.warning(
                "webpush FAIL: svc=%s code=%s ep=%s body=%r headers=%s",
                svc, code, sub["endpoint"][:80], body[:300], headers,
            )
            # 404/410 = gone for good. 403 + "do not correspond" / BadJwtToken
            # means the subscription is bound to an older VAPID public key
            # than the one we just signed with — equivalent to "gone", and
            # the only way to recover is to have the client re-subscribe.
            stale_403 = code == 403 and (
                "do not correspond" in body
                or "BadJwtToken" in body
                or "VapidPubKey" in body
                or "VAPID public key" in body
            )
            if code in (404, 410) or stale_403:
                dead.append(sub["endpoint"])
            else:
                errors.append(f"{svc}/{code}: {body[:160]}")
        except Exception as e:
            logger.warning(
                "webpush UNEXPECTED: svc=%s ep=%s err=%r",
                svc, sub["endpoint"][:80], e,
            )
            errors.append(str(e)[:200])
    if dead:
        with _LOCK:
            current = _load_subs()
            new = [s for s in current if s.get("endpoint") not in dead]
            removed = len(current) - len(new)
            _save_subs(new)
    return {"sent": sent, "removed": removed, "errors": errors}


def notify_session_response(session_id: str, *, title: str = "", body: str = "") -> None:
    """Fire-and-forget push notifying that a session's stream just ended.

    Called from api/streaming.py after the final stream_end event. Safe to
    call when push isn't configured — no-ops with a swallowed exception.
    """
    if not is_available():
        return
    if not list_subscriptions():
        return
    payload = {
        "type": "session_response",
        "session_id": session_id,
        "title": (title or "Hermes")[:80],
        "body": (body or "Agent finished a turn")[:200],
        "url": f"/session/{session_id}",
        "ts": int(time.time()),
    }
    # Send on a background thread so the streaming pipeline isn't held up
    # by network latency to FCM / Mozilla / Apple push services. Inherit the
    # send_to_all default TTL (24h) — agent turns can sometimes finish while
    # the phone is offline and we want the OS to deliver the badge whenever
    # the user's device next reaches a push gateway.
    def _do():
        try:
            send_to_all(payload)
        except Exception:
            logger.exception("notify_session_response: send_to_all failed")

    threading.Thread(target=_do, daemon=True).start()
