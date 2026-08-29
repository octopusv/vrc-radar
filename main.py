"""VRC Radar — read-only web dashboard over local VRCX databases.

Serves a small JSON API + static SPA. VRCX databases are only ever opened
with mode=ro; only feed/friend/gamelog/notification tables are queried.

Favorites and the friends' live state come from VRChat itself: the
auth cookie VRCX already stores is reused for GET-only, cached calls
(favorite groups, and /auth/user + /auth/user/friends to reconcile who
is really online and where).
The cookie is used solely as a Cookie header to api.vrchat.cloud and is
never logged, echoed, or written anywhere.

Multi account: accounts are discovered from every configured database
(accounts.json) and every usr prefix inside each. URL paths /1, /2, …
select the account; APIs take the same index via ?acct=.

The only thing this app ever writes is its own image_cache/ directory
(persisted avatar thumbnails, so feed history keeps its pictures even
after VRChat deletes the original file). VRCX databases stay read-only.
"""

import base64
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urljoin, urlparse

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
ACCOUNTS_FILE = BASE_DIR / "accounts.json"

PORT = int(os.environ.get("PORT", "8321"))

VRCHAT_API = "https://api.vrchat.cloud/api/1"
USER_AGENT = os.environ.get(
    "VRC_RADAR_UA", "VRCRadar/1.0 (self-hosted VRCX companion dashboard)")
FAV_TTL = 600.0        # re-read favorites from VRChat at most every 10 min
FAV_FAIL_TTL = 120.0   # after a failure, wait this long before retrying
LIVE_TTL = 60.0        # re-check who is really online at most every minute
LIVE_FAIL_TTL = 120.0
WORLD_LOOKUP_MAX = 10  # /worlds/<id> fallback lookups per request, at most
WORLD_MISS_TTL = 3600.0  # don't retry a failed world lookup for an hour

FEED_TABLES = {
    "gps": "feed_gps",
    "online": "feed_online_offline",
    "status": "feed_status",
    "avatar": "feed_avatar",
    "bio": "feed_bio",
}

FEED_SELECTS = {
    "gps": "id, created_at, user_id, display_name, location, world_name,"
    " previous_location, time, group_name",
    "online": "id, created_at, user_id, display_name, type, location,"
    " world_name, time",
    "status": "id, created_at, user_id, display_name, status,"
    " status_description, previous_status, previous_status_description",
    "avatar": "id, created_at, user_id, display_name, avatar_name, owner_id,"
    " current_avatar_thumbnail_image_url,"
    " previous_current_avatar_thumbnail_image_url",
    "bio": "id, created_at, user_id, display_name, bio, previous_bio",
}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------- db / accounts


def _default_db_path():
    """Default VRCX DB. The server may run under a service account, so
    %APPDATA% can point at the wrong profile; fall back to the profile that
    owns this app directory (…/Users/<name>/…)."""
    override = os.environ.get("VRCX_DB")
    if override:
        return override
    candidates = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "VRCX" / "VRCX.sqlite3")
    for parent in BASE_DIR.parents:
        if parent.parent.name.lower() == "users":
            candidates.append(
                parent / "AppData" / "Roaming" / "VRCX" / "VRCX.sqlite3"
            )
            break
    for c in candidates:
        if c.is_file():
            return str(c)
    return str(candidates[-1]) if candidates else "VRCX.sqlite3"


def connect(db_path):
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=5.0)
    conn.row_factory = sqlite3.Row
    return conn


def _configured_dbs():
    """[(db_path, label_or_None)] — default DB first, then accounts.json."""
    dbs = [(_default_db_path(), None)]
    try:
        raw = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8"))
        for entry in raw if isinstance(raw, list) else []:
            path = str(entry.get("db", "")).strip()
            if path:
                dbs.append((path, entry.get("label") or None))
    except FileNotFoundError:
        pass
    except Exception as e:  # noqa: BLE001
        print(f"accounts.json parse error: {e}", flush=True)
    seen = set()
    unique = []
    for path, label in dbs:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            unique.append((path, label))
    return unique


_accounts_cache = {"at": 0.0, "list": []}
_accounts_lock = threading.Lock()


def discover_accounts(force=False):
    """[{idx, db, prefix, label}] across all configured databases."""
    with _accounts_lock:
        if not force and _accounts_cache["list"] and \
                time.time() - _accounts_cache["at"] < 60:
            return _accounts_cache["list"]
    accounts = []
    for db_path, label in _configured_dbs():
        if not os.path.isfile(db_path):
            continue
        try:
            conn = connect(db_path)
        except sqlite3.Error:
            continue
        try:
            prefixes = [
                r[0][: -len("_friend_log_current")]
                for r in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                    " AND name LIKE 'usr%\\_friend\\_log\\_current'"
                    " ESCAPE '\\'"
                )
            ]
            prefixes = [p for p in prefixes
                        if re.fullmatch(r"usr[0-9a-f]{32}", p)]
            current = None
            row = conn.execute(
                "SELECT value FROM configs"
                " WHERE key = 'config:lastuserloggedin'"
            ).fetchone()
            if row and row[0] and row[0].startswith("usr_"):
                current = "usr" + row[0][4:].replace("-", "")
            prefixes.sort(key=lambda p: (p != current, p))
        except sqlite3.Error:
            prefixes = []
        finally:
            conn.close()
        for i, prefix in enumerate(prefixes):
            base = label or f"アカウント{len(accounts) + 1}"
            name = base if len(prefixes) == 1 else f"{base} ({i + 1})"
            accounts.append({
                "idx": len(accounts) + 1,
                "db": db_path,
                "prefix": prefix,
                # only the DB's currently-logged-in account has usable cookies
                "live": i == 0,
                "label": name,
            })
    with _accounts_lock:
        _accounts_cache["at"] = time.time()
        _accounts_cache["list"] = accounts
    return accounts


def resolve_account(params):
    accounts = discover_accounts()
    if not accounts:
        raise ApiError(503, "VRCXデータベースが見つかりません")
    raw = params.get("acct", "1")
    try:
        idx = int(raw)
    except ValueError:
        raise ApiError(400, "invalid account") from None
    for a in accounts:
        if a["idx"] == idx:
            return a
    raise ApiError(404, f"アカウント {idx} は存在しません")


# ------------------------------------------------- VRChat favorites (API)

_fav_cache = {}          # db_path -> {at, ok, groups, users, error}
_fav_locks = {}
_fav_locks_guard = threading.Lock()


def _fav_lock_for(db_path):
    with _fav_locks_guard:
        lock = _fav_locks.get(db_path)
        if lock is None:
            lock = _fav_locks[db_path] = threading.Lock()
        return lock


def _auth_cookie_header(db_path):
    """Rebuild the Cookie header from the container VRCX persisted.

    Stored as base64(JSON list of .NET Cookie objects). Values are handed
    straight to the request and never surface anywhere else.
    """
    try:
        conn = connect(db_path)
    except sqlite3.Error:
        return None
    try:
        row = conn.execute(
            "SELECT value FROM cookies WHERE key = 'default'").fetchone()
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    if not row or not row[0]:
        return None
    try:
        items = json.loads(base64.b64decode(row[0]).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    parts = []
    for item in items if isinstance(items, list) else []:
        name = item.get("Name") or item.get("name")
        value = item.get("Value") or item.get("value")
        domain = (item.get("Domain") or item.get("domain") or "").lower()
        if name and value and "vrchat" in domain:
            parts.append(f"{name}={value}")
    return "; ".join(parts) or None


def _vrchat_get(path, cookie, timeout=12):
    req = urllib.request.Request(
        VRCHAT_API + path,
        headers={
            "Cookie": cookie,
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _fetch_vrchat_favorites(db_path):
    """{ok, groups:[{key,name,count}], users:{uid:[group names]}, error}"""
    cookie = _auth_cookie_header(db_path)
    if not cookie:
        return {"ok": False, "groups": [], "users": {},
                "error": "VRCXの認証情報が見つかりません"}
    try:
        raw_groups = _vrchat_get("/favorite/groups?type=friend&n=50", cookie)
        names = {}
        for g in raw_groups if isinstance(raw_groups, list) else []:
            key = g.get("name")
            if not key:
                continue
            display = (g.get("displayName") or "").strip()
            if not display or display == key:
                # VRChat leaves group_0/1/2 unnamed until the user renames it
                m = re.fullmatch(r"group_(\d+)", key)
                display = f"グループ{int(m[1]) + 1}" if m else key
            names[key] = display

        users = {}
        counts = {}
        offset = 0
        while offset <= 1000:
            page = _vrchat_get(
                f"/favorites?type=friend&n=100&offset={offset}", cookie)
            if not isinstance(page, list) or not page:
                break
            for fav in page:
                uid = fav.get("favoriteId")
                if not uid:
                    continue
                labels = []
                for tag in fav.get("tags") or []:
                    label = names.get(tag, tag)
                    labels.append(label)
                    counts[label] = counts.get(label, 0) + 1
                users[uid] = labels
            if len(page) < 100:
                break
            offset += 100

        groups = [{"key": k, "name": v, "count": counts.get(v, 0)}
                  for k, v in names.items()]
        groups.sort(key=lambda g: g["key"])
        return {"ok": True, "groups": groups, "users": users, "error": ""}
    except urllib.error.HTTPError as e:
        msg = ("VRChatの認証が切れています（VRCXで再ログインしてください）"
               if e.code in (401, 403) else f"VRChat API エラー {e.code}")
        return {"ok": False, "groups": [], "users": {}, "error": msg}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "groups": [], "users": {},
                "error": f"VRChatに接続できません ({type(e).__name__})"}


def get_favorites(account, force=False):
    """Cached favorites for an account's database."""
    if not account.get("live"):
        return {"ok": False, "groups": [], "users": {},
                "error": "このアカウントは現在VRCXにログインしていません"}
    db_path = account["db"]
    now = time.time()
    cached = _fav_cache.get(db_path)
    if cached and not force:
        ttl = FAV_TTL if cached["ok"] else FAV_FAIL_TTL
        if now - cached["at"] < ttl:
            return cached
    with _fav_lock_for(db_path):
        cached = _fav_cache.get(db_path)
        if cached and not force:
            ttl = FAV_TTL if cached["ok"] else FAV_FAIL_TTL
            if time.time() - cached["at"] < ttl:
                return cached
        result = _fetch_vrchat_favorites(db_path)
        result["at"] = time.time()
        _fav_cache[db_path] = result
        print(f"favorites refresh: ok={result['ok']}"
              f" users={len(result['users'])} groups={len(result['groups'])}"
              + (f" error={result['error']}" if result["error"] else ""),
              flush=True)
        return result


def fav_state(account):
    """(set of favorite user ids, {uid: [group names]}, status dict)."""
    data = get_favorites(account)
    users = data["users"]
    status = {"ok": data["ok"], "error": data["error"],
              "groups": data["groups"],
              "fetched_at": iso_from_epoch(data.get("at", 0))}
    return set(users), users, status


# ---------------------------------------------- VRChat live state (API)

_live_cache = {}         # db_path -> {at, ok, online, active, error}
_live_locks = {}
_live_locks_guard = threading.Lock()


def _live_lock_for(db_path):
    with _live_locks_guard:
        lock = _live_locks.get(db_path)
        if lock is None:
            lock = _live_locks[db_path] = threading.Lock()
        return lock


def _fetch_vrchat_live(db_path):
    """{ok, online: set of ids, active: set of ids, locations, error}.

    The feed tables only record transitions VRCX observed while it was
    running, so a logout or an instance move while VRCX was closed leaves
    stale state in the DB forever. /auth/user gives the authoritative
    online/active id lists; /auth/user/friends adds each online friend's
    current location. Presence is reconciled against both.

    locations holds only meaningful values (wrld_… or "private") —
    "traveling"/"offline" are transient or useless and are dropped.

    icons maps each online friend to a proxied profile image ref
    (userIcon > profilePicOverride > current avatar thumbnail — the same
    preference VRCX uses for its friend list).

    statuses maps each online/active friend to (status, statusDescription)
    — feed_status only records *changes* VRCX observed, so friends who
    never touched their status while VRCX was watching have no row at all.
    """
    fail = {"ok": False, "online": set(), "active": set(),
            "locations": {}, "icons": {}, "statuses": {}, "error": ""}
    cookie = _auth_cookie_header(db_path)
    if not cookie:
        return dict(fail, error="VRCXの認証情報が見つかりません")
    try:
        data = _vrchat_get("/auth/user", cookie)
        online = data.get("onlineFriends")
        active = data.get("activeFriends")
        if not isinstance(online, list) or not isinstance(active, list):
            return dict(fail, error="VRChat APIの応答が想定外の形式です")
        locations = {}
        icons = {}
        statuses = {}
        offset = 0
        while offset <= 1000:
            page = _vrchat_get(
                f"/auth/user/friends?offline=false&n=100&offset={offset}",
                cookie)
            if not isinstance(page, list) or not page:
                break
            for f in page:
                uid = f.get("id")
                if not uid:
                    continue
                loc = f.get("location") or ""
                if loc.startswith("wrld_") or loc == "private":
                    locations[uid] = loc
                ref = image_ref(f.get("userIcon")
                                or f.get("profilePicOverride")
                                or f.get("currentAvatarThumbnailImageUrl"))
                if ref:
                    icons[uid] = ref
                statuses[uid] = (f.get("status") or "",
                                 (f.get("statusDescription") or "").strip())
            if len(page) < 100:
                break
            offset += 100
        return {"ok": True, "online": set(online), "active": set(active),
                "locations": locations, "icons": icons,
                "statuses": statuses, "error": ""}
    except urllib.error.HTTPError as e:
        msg = ("VRChatの認証が切れています（VRCXで再ログインしてください）"
               if e.code in (401, 403) else f"VRChat API エラー {e.code}")
        return dict(fail, error=msg)
    except Exception as e:  # noqa: BLE001
        return dict(fail, error=f"VRChatに接続できません ({type(e).__name__})")


def get_live(account):
    """Cached live friend-state sets for an account's database."""
    if not account.get("live"):
        return {"ok": False, "online": set(), "active": set(),
                "locations": {}, "icons": {}, "statuses": {},
                "error": "このアカウントは現在VRCXにログインしていません"}
    db_path = account["db"]
    now = time.time()
    cached = _live_cache.get(db_path)
    if cached:
        ttl = LIVE_TTL if cached["ok"] else LIVE_FAIL_TTL
        if now - cached["at"] < ttl:
            return cached
    with _live_lock_for(db_path):
        cached = _live_cache.get(db_path)
        if cached:
            ttl = LIVE_TTL if cached["ok"] else LIVE_FAIL_TTL
            if time.time() - cached["at"] < ttl:
                return cached
        result = _fetch_vrchat_live(db_path)
        result["at"] = time.time()
        _live_cache[db_path] = result
        print(f"live state refresh: ok={result['ok']}"
              f" online={len(result['online'])}"
              f" active={len(result['active'])}"
              f" locations={len(result['locations'])}"
              + (f" error={result['error']}" if result["error"] else ""),
              flush=True)
        return result


def live_state(account):
    """(live data dict or None when unavailable, status dict for the UI)."""
    data = get_live(account)
    status = {"ok": data["ok"], "error": data["error"],
              "fetched_at": iso_from_epoch(data.get("at", 0))}
    return (data if data["ok"] else None), status


# ------------------------------------------------ VRChat images (proxy)
#
# Thumbnails (avatars, user icons) sit behind the VRChat API and need the
# auth cookie, so the browser cannot load them directly. /api/image
# proxies them read-only. The cookie is attached only to requests whose
# host is api.vrchat.cloud — redirects to the CDN behind it are followed
# by hand without it.
#
# Every size fetched is also persisted to image_cache/ — VRChat stops
# serving an image once the avatar behind it is deleted, and without a
# local copy the feed's before/after pictures would silently rot away.
# 256px accumulates from the lists; 1024px only for images someone
# actually opened in the lightbox. When VRChat no longer has the file,
# the exact size is served from disk, else the largest saved copy.
# image_cache/ is the ONLY place this app ever writes; VRCX databases
# stay read-only.

IMG_SIZES = ("128", "256", "512", "1024")   # what VRChat's resizer offers
IMG_CACHE_MAX = 800
IMG_CACHE_MAX_BYTES = 64 * 1024 * 1024
IMG_DIR = BASE_DIR / "image_cache"
_IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg",
            "image/webp": ".webp", "image/gif": ".gif"}
_img_cache = OrderedDict()   # (fid, ver, size) -> (content_type, bytes)
_img_cache_stats = {"bytes": 0}
_img_neg = {}                # (fid, ver, size) -> epoch after which to retry
_img_lock = threading.Lock()
_img_fetch_sem = threading.BoundedSemaphore(4)  # be gentle on the API


def _img_disk_read(fid, ver, size):
    """Persisted copy as (content_type, bytes), or None.

    One file per size; names from the 256px-only era carry no size
    suffix and still resolve for 256.
    """
    names = [f"{fid}_{ver}_{size}"]
    if size == "256":
        names.append(f"{fid}_{ver}")
    for name in names:
        for ctype, ext in _IMG_EXT.items():
            p = IMG_DIR / f"{name}{ext}"
            try:
                if p.is_file():
                    return ctype, p.read_bytes()
            except OSError:
                pass
    return None


def _img_disk_fallback(fid, ver, size):
    """Best saved copy when VRChat can't serve the file any more:
    the requested size first, then the largest one on disk."""
    hit = _img_disk_read(fid, ver, size)
    if hit:
        return hit
    for s in ("1024", "512", "256", "128"):
        if s != size:
            hit = _img_disk_read(fid, ver, s)
            if hit:
                return hit
    return None


def _img_disk_write(fid, ver, size, ctype, data):
    """Best effort; a read-only disk just leaves the cache memory-only."""
    ext = _IMG_EXT.get(ctype, ".png")
    tmp = IMG_DIR / f".tmp-{threading.get_ident()}-{fid}-{size}{ext}"
    try:
        IMG_DIR.mkdir(exist_ok=True)
        tmp.write_bytes(data)
        os.replace(tmp, IMG_DIR / f"{fid}_{ver}_{size}{ext}")
    except OSError:
        try:
            tmp.unlink()
        except OSError:
            pass


def _img_store(key, entry):
    """Put an image into the byte-capped in-memory LRU."""
    with _img_lock:
        if key in _img_cache:
            _img_cache.move_to_end(key)
            return
        _img_cache[key] = entry
        _img_cache_stats["bytes"] += len(entry[1])
        while _img_cache and (len(_img_cache) > IMG_CACHE_MAX
                              or _img_cache_stats["bytes"]
                              > IMG_CACHE_MAX_BYTES):
            _, (_, old) = _img_cache.popitem(last=False)
            _img_cache_stats["bytes"] -= len(old)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_img_opener = urllib.request.build_opener(_NoRedirect)


def image_ref(url):
    """VRChat image/file URL -> local proxy path ('' when unusable)."""
    m = re.match(
        r"https://api\.vrchat\.cloud/api/1/\S*?"
        r"(file_[0-9a-fA-F-]{36})/(\d{1,6})", url or "")
    return f"/api/image?fid={m[1]}&v={m[2]}" if m else ""


def _fetch_image(url, cookie, hops=0):
    headers = {"User-Agent": USER_AGENT, "Accept": "image/*"}
    if urlparse(url).hostname == "api.vrchat.cloud" and cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers)
    try:
        with _img_opener.open(req, timeout=15) as res:
            ctype = (res.headers.get("Content-Type") or "").split(";")[0]
            if not ctype.startswith("image/"):
                ctype = "image/png"
            return ctype, res.read()
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308) and hops < 3:
            loc = e.headers.get("Location")
            if loc:
                return _fetch_image(urljoin(url, loc), cookie, hops + 1)
        raise


def get_image(params, account):
    """(content_type, bytes) for a validated image ref.

    ?s= selects the resize (default 256 for list thumbnails; the lightbox
    asks for 1024). Lookup order: memory LRU → persisted copy → VRChat.
    Whenever VRChat cannot serve the file any more (deleted avatar,
    expired auth, network down), the best saved copy is served instead,
    so history never loses its images.
    """
    fid = params.get("fid", "")
    ver = params.get("v", "")
    size = params.get("s", "256")
    if not re.fullmatch(r"file_[0-9a-fA-F-]{36}", fid) \
            or not re.fullmatch(r"\d{1,6}", ver) or size not in IMG_SIZES:
        raise ApiError(400, "invalid image ref")
    key = (fid, ver, size)
    with _img_lock:
        hit = _img_cache.get(key)
        if hit:
            _img_cache.move_to_end(key)
            return hit
        blocked = time.time() < _img_neg.get(key, 0)
    disk = _img_disk_read(fid, ver, size)
    if disk:
        _img_store(key, disk)
        return disk
    if blocked:
        disk = _img_disk_fallback(fid, ver, size)
        if disk:
            return disk
        raise ApiError(404, "image unavailable")
    cookie = _auth_cookie_header(account["db"])
    if not cookie:
        disk = _img_disk_fallback(fid, ver, size)
        if disk:
            return disk
        raise ApiError(503, "VRCXの認証情報が見つかりません")
    with _img_fetch_sem:
        with _img_lock:      # someone may have fetched it while we waited
            hit = _img_cache.get(key)
            if hit:
                return hit
        try:
            ctype, data = _fetch_image(
                f"{VRCHAT_API}/image/{fid}/{ver}/{size}", cookie)
        except urllib.error.HTTPError as e:
            with _img_lock:
                now = time.time()
                if len(_img_neg) > 2000:
                    for k in [k for k, t in _img_neg.items() if t < now]:
                        del _img_neg[k]
                # auth problems are transient, missing files are not
                _img_neg[key] = now + (120 if e.code in (401, 403) else 3600)
            disk = _img_disk_fallback(fid, ver, size)
            if disk:
                return disk
            raise ApiError(404, f"image fetch failed ({e.code})") from None
        except Exception as e:  # noqa: BLE001
            with _img_lock:
                _img_neg[key] = time.time() + 120
            disk = _img_disk_fallback(fid, ver, size)
            if disk:
                return disk
            raise ApiError(
                502, f"image fetch failed ({type(e).__name__})") from None
    _img_store(key, (ctype, data))
    _img_disk_write(fid, ver, size, ctype, data)
    return ctype, data


# ---------------------------------------------------------------- helpers


def like_escape(text):
    return re.sub(r"([%_\\])", r"\\\1", text)


def iso_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def iso_from_epoch(ts):
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z")


def iso_ago(**kw):
    return (datetime.now(timezone.utc) - timedelta(**kw)).strftime(
        "%Y-%m-%dT%H:%M:%S.000Z"
    )


def require_user_id(params, key="id"):
    uid = params.get(key, "")
    if not re.fullmatch(r"usr_[0-9a-fA-F-]{36}", uid):
        raise ApiError(400, "invalid user id")
    return uid


_world_names = {}        # world_id -> name; worlds rarely rename
_world_api_miss = {}     # world_id -> epoch of last failed API lookup


def _world_name_from_api(world_id, cookie):
    """Resolve a world name VRCX has never logged (e.g. a young DB of a
    freshly added account) via the worlds API. Only successes are cached
    here; the caller throttles retries of failures."""
    if not cookie or not re.fullmatch(r"wrld_[0-9a-fA-F-]{36}", world_id):
        return ""
    try:
        data = _vrchat_get(f"/worlds/{world_id}", cookie)
        name = (data.get("name") or "").strip()
    except Exception:  # noqa: BLE001
        return ""
    if name:
        _world_names[world_id] = name
    return name


def _world_name_from_db(conn, prefix, world_id):
    """Best-effort wrld_id -> name from locations VRCX has already seen.

    The API's friend objects carry no world name; only resolved names are
    cached so an unknown world can still resolve once a feed logs it.
    """
    if world_id in _world_names:
        return _world_names[world_id]
    row = conn.execute(
        f"SELECT world_name FROM {prefix}_feed_gps"
        f" WHERE location LIKE ? ESCAPE '\\' AND world_name != ''"
        f" ORDER BY id DESC LIMIT 1",
        (like_escape(world_id) + ":%",),
    ).fetchone()
    if not row:
        row = conn.execute(
            "SELECT world_name FROM gamelog_location"
            " WHERE world_id = ? AND world_name != ''"
            " ORDER BY id DESC LIMIT 1",
            (world_id,),
        ).fetchone()
    name = row["world_name"] if row else ""
    if name:
        _world_names[world_id] = name
    return name


def latest_per_user(conn, prefix, suffix, cols):
    col_sql = ", ".join(cols)
    rows = conn.execute(
        f"SELECT {col_sql} FROM ("
        f"  SELECT {col_sql}, ROW_NUMBER() OVER"
        f"    (PARTITION BY user_id ORDER BY id DESC) rn"
        f"  FROM {prefix}_{suffix}) WHERE rn = 1"
    ).fetchall()
    return {r["user_id"]: dict(r) for r in rows}


def friend_images(conn, prefix, live=None):
    """{uid: proxied image ref} — last avatar thumbnail VRCX recorded,
    overridden by the fresher API profile icon for online friends."""
    imgs = {}
    for uid, row in latest_per_user(
            conn, prefix, "feed_avatar",
            ["user_id", "current_avatar_thumbnail_image_url"]).items():
        ref = image_ref(row["current_avatar_thumbnail_image_url"])
        if ref:
            imgs[uid] = ref
    if live:
        imgs.update(live.get("icons") or {})
    return imgs


def current_presence(conn, prefix, live=None, as_of="", account=None):
    """{uid: {display_name, online, location, world_name, since, status…}}

    Location comes from whichever of the online/gps feeds spoke last, so a
    friend who went online already inside a world is placed correctly.

    live (VRChat API snapshot taken at as_of) is authoritative when given:
    the feeds only hold transitions VRCX observed, so a logout or a move
    while VRCX was closed leaves a friend "Online" in a stale world
    forever. The online flag, the location, and the status are all
    reconciled. Feed events newer than the snapshot win, so a state
    change that happened after the cached API call isn't reverted.
    """
    online = latest_per_user(
        conn, prefix, "feed_online_offline",
        ["user_id", "display_name", "type", "location", "world_name",
         "created_at"],
    )
    gps = latest_per_user(
        conn, prefix, "feed_gps",
        ["user_id", "display_name", "location", "world_name", "group_name",
         "created_at"],
    )
    status = latest_per_user(
        conn, prefix, "feed_status",
        ["user_id", "status", "status_description", "created_at"],
    )
    presence = {}
    for uid, ev in online.items():
        is_online = ev["type"] == "Online"
        entry = {
            "user_id": uid,
            "display_name": ev["display_name"],
            "is_online": is_online,
            "since": ev["created_at"],
            "location": ev["location"] if is_online else "",
            "world_name": ev["world_name"] if is_online else "",
            "group_name": "",
            "located_at": ev["created_at"],
            "status": "",
            "status_description": "",
        }
        g = gps.get(uid)
        if is_online and g and g["created_at"] >= ev["created_at"]:
            entry["location"] = g["location"]
            entry["world_name"] = g["world_name"]
            entry["group_name"] = g["group_name"]
            entry["located_at"] = g["created_at"]
        s = status.get(uid)
        if s:
            entry["status"] = s["status"]
            entry["status_description"] = s["status_description"]
        presence[uid] = entry

    if live is not None:
        online_ids = live["online"]
        api_locs = live["locations"]
        api_status = live["statuses"]
        for uid, entry in presence.items():
            # status freshness is governed by the status feed alone — a
            # recent gps event says nothing about the status row's age
            st = api_status.get(uid)
            if st:
                s = status.get(uid)
                if not s or s["created_at"] <= as_of:
                    entry["status"], entry["status_description"] = st
            if max(entry["since"], entry["located_at"]) > as_of:
                continue
            if entry["is_online"] and uid not in online_ids:
                entry["is_online"] = False
                entry["location"] = ""
                entry["world_name"] = ""
                entry["group_name"] = ""
            elif not entry["is_online"] and uid in online_ids:
                entry["is_online"] = True
            loc = api_locs.get(uid, "")
            if entry["is_online"] and loc and loc != entry["location"]:
                entry["location"] = loc
                entry["world_name"] = ""
                entry["group_name"] = ""
                entry["located_at"] = ""   # arrival time unknown
        missing = online_ids.difference(presence)
        if missing:
            # online per the API but never seen in any feed table
            for r in conn.execute(
                f"SELECT user_id, display_name"
                f" FROM {prefix}_friend_log_current"
            ):
                if r["user_id"] in missing:
                    st = api_status.get(r["user_id"], ("", ""))
                    presence[r["user_id"]] = {
                        "user_id": r["user_id"],
                        "display_name": r["display_name"],
                        "is_online": True,
                        "since": "",
                        "location": api_locs.get(r["user_id"], ""),
                        "world_name": "",
                        "group_name": "",
                        "located_at": "",
                        "status": st[0],
                        "status_description": st[1],
                    }
        # the API carries no world names; recover them from locations
        # VRCX has seen before, then fall back to the worlds API for
        # worlds a young DB has never logged (capped + failure-throttled)
        blanks = [e for e in presence.values()
                  if e["is_online"] and not e["world_name"]
                  and e["location"].startswith("wrld_")]
        for entry in blanks:
            entry["world_name"] = _world_name_from_db(
                conn, prefix, entry["location"].split(":", 1)[0])
        pending = sorted({e["location"].split(":", 1)[0] for e in blanks
                          if not e["world_name"]})
        if pending and account and account.get("live"):
            cookie = _auth_cookie_header(account["db"])
            now = time.time()
            for wid in pending[:WORLD_LOOKUP_MAX]:
                if now - _world_api_miss.get(wid, 0) < WORLD_MISS_TTL:
                    continue
                if not _world_name_from_api(wid, cookie):
                    _world_api_miss[wid] = now
            for entry in blanks:
                if not entry["world_name"]:
                    entry["world_name"] = _world_names.get(
                        entry["location"].split(":", 1)[0], "")
    return presence


def fetch_feed_rows(conn, prefix, kinds, before, after, q, limit,
                    fav_ids=None, user_id=None):
    where = []
    args = []
    if before:
        where.append("created_at < ?")
        args.append(before)
    elif after:
        where.append("created_at > ?")
        args.append(after)
    if q:
        where.append("display_name LIKE ? ESCAPE '\\'")
        args.append(f"%{like_escape(q)}%")
    if user_id:
        where.append("user_id = ?")
        args.append(user_id)
    if fav_ids is not None:
        if not fav_ids:
            return []
        marks = ",".join("?" * len(fav_ids))
        where.append(f"user_id IN ({marks})")
        args.extend(sorted(fav_ids))
    where_sql = (" WHERE " + " AND ".join(where)) if where else ""

    items = []
    for kind in kinds:
        table = FEED_TABLES.get(kind)
        if not table:
            continue
        rows = conn.execute(
            f"SELECT {FEED_SELECTS[kind]} FROM {prefix}_{table}{where_sql}"
            f" ORDER BY created_at DESC LIMIT ?",
            [*args, limit],
        ).fetchall()
        for r in rows:
            d = dict(r)
            d["kind"] = kind
            if kind == "avatar":
                # raw VRChat URLs never leave the server; hand the client
                # proxy refs instead
                d["image"] = image_ref(
                    d.pop("current_avatar_thumbnail_image_url"))
                d["previous_image"] = image_ref(
                    d.pop("previous_current_avatar_thumbnail_image_url"))
            elif kind == "gps":
                prev = d.get("previous_location") or ""
                d["previous_world_name"] = _world_name_from_db(
                    conn, prefix, prev.split(":", 1)[0]) \
                    if prev.startswith("wrld_") else ""
            items.append(d)
    items.sort(key=lambda d: d["created_at"], reverse=True)
    return items[:limit]


# ---------------------------------------------------------------- handlers


def api_accounts(conn, prefix, params, account):
    return {
        "accounts": [
            {"idx": a["idx"], "label": a["label"],
             "user": "usr_" + a["prefix"][3:]}
            for a in discover_accounts()
        ]
    }


def api_favorites(conn, prefix, params, account):
    data = get_favorites(account, force=params.get("refresh") == "1")
    return {
        "ok": data["ok"],
        "error": data["error"],
        "groups": data["groups"],
        "total": len(data["users"]),
        "fetched_at": iso_from_epoch(data.get("at", 0)),
    }


def api_summary(conn, prefix, params, account):
    live, live_status = live_state(account)
    presence = current_presence(conn, prefix, live,
                                live_status["fetched_at"], account)
    fav_ids, fav_groups, fav_status = fav_state(account)
    imgs = friend_images(conn, prefix, live)

    online_friends = []
    for uid, p in presence.items():
        if not p["is_online"]:
            continue
        online_friends.append({
            "user_id": uid,
            "display_name": p["display_name"],
            "online_since": p["since"],
            "location": p["location"],
            "world_name": p["world_name"],
            "status": p["status"],
            "status_description": p["status_description"],
            "is_fav": uid in fav_ids,
            "fav_groups": fav_groups.get(uid, []),
            "image": imgs.get(uid, ""),
        })
    online_friends.sort(key=lambda e: e["online_since"], reverse=True)

    friends_total = conn.execute(
        f"SELECT COUNT(*) FROM {prefix}_friend_log_current"
    ).fetchone()[0]

    cutoff = iso_ago(hours=24)
    today_events = 0
    latest_ts = ""
    for table in FEED_TABLES.values():
        today_events += conn.execute(
            f"SELECT COUNT(*) FROM {prefix}_{table} WHERE created_at >= ?",
            (cutoff,),
        ).fetchone()[0]
        row = conn.execute(
            f"SELECT MAX(created_at) FROM {prefix}_{table}"
        ).fetchone()
        if row[0] and row[0] > latest_ts:
            latest_ts = row[0]

    own = conn.execute(
        "SELECT created_at, location, world_id, world_name, group_name, time"
        " FROM gamelog_location ORDER BY id DESC LIMIT 1"
    ).fetchone()

    return {
        "friends_total": friends_total,
        "online_count": len(online_friends),
        "online_friends": online_friends,
        "events_24h": today_events,
        "latest_event_at": latest_ts,
        "own_last_location": dict(own) if own else None,
        "fav_status": fav_status,
        "live_status": live_status,
        "server_time": iso_now(),
    }


def api_locations(conn, prefix, params, account):
    """Friends grouped by instance, busiest instance first."""
    live, live_status = live_state(account)
    presence = current_presence(conn, prefix, live,
                                live_status["fetched_at"], account)
    fav_ids, fav_groups, fav_status = fav_state(account)
    imgs = friend_images(conn, prefix, live)
    trust = {
        r["user_id"]: r["trust_level"]
        for r in conn.execute(
            f"SELECT user_id, trust_level FROM {prefix}_friend_log_current")
    }

    own_row = conn.execute(
        "SELECT location, world_name, created_at FROM gamelog_location"
        " ORDER BY id DESC LIMIT 1"
    ).fetchone()
    own_location = own_row["location"] if own_row else ""

    instances = {}
    hidden = []      # online but location unknown / private
    for uid, p in presence.items():
        if not p["is_online"]:
            continue
        entry = {
            "user_id": uid,
            "display_name": p["display_name"],
            "trust_level": trust.get(uid, ""),
            "since": p["located_at"],
            "status": p["status"],
            "status_description": p["status_description"],
            "is_fav": uid in fav_ids,
            "fav_groups": fav_groups.get(uid, []),
            "image": imgs.get(uid, ""),
        }
        loc = p["location"] or ""
        if not loc.startswith("wrld_"):
            entry["state"] = loc or "unknown"
            hidden.append(entry)
            continue
        inst = instances.get(loc)
        if inst is None:
            inst = instances[loc] = {
                "location": loc,
                "world_id": loc.split(":", 1)[0],
                "world_name": p["world_name"] or "",
                "group_name": p["group_name"] or "",
                "is_own": loc == own_location,
                "friends": [],
            }
        if not inst["world_name"] and p["world_name"]:
            inst["world_name"] = p["world_name"]
        if not inst["group_name"] and p["group_name"]:
            inst["group_name"] = p["group_name"]
        inst["friends"].append(entry)

    rows = []
    for inst in instances.values():
        inst["friends"].sort(key=lambda f: f["since"], reverse=True)
        inst["count"] = len(inst["friends"])
        inst["fav_count"] = sum(1 for f in inst["friends"] if f["is_fav"])
        inst["newest"] = inst["friends"][0]["since"] if inst["friends"] else ""
        rows.append(inst)
    rows.sort(key=lambda i: (i["count"], i["newest"]), reverse=True)

    hidden.sort(key=lambda f: f["since"], reverse=True)
    return {
        "instances": rows,
        "hidden": hidden,
        "online_count": sum(r["count"] for r in rows) + len(hidden),
        "own_location": own_location,
        "own_world_name": own_row["world_name"] if own_row else "",
        "fav_status": fav_status,
        "live_status": live_status,
        "server_time": iso_now(),
    }


def api_feed(conn, prefix, params, account):
    kinds = [k for k in
             params.get("types", ",".join(FEED_TABLES)).split(",") if k]
    limit = min(max(int(params.get("limit", "50")), 1), 200)
    fav_ids = None
    fav_status = None
    if params.get("fav") == "1":
        fav_ids, _, fav_status = fav_state(account)
    items = fetch_feed_rows(
        conn, prefix, kinds,
        params.get("before", ""), params.get("after", ""),
        params.get("q", "").strip(), limit, fav_ids=fav_ids,
    )
    next_cursor = items[-1]["created_at"] if len(items) == limit else ""
    out = {"items": items, "next": next_cursor}
    if fav_status:
        out["fav_status"] = fav_status
    return out


def api_friends(conn, prefix, params, account):
    friends = conn.execute(
        f"SELECT user_id, display_name, trust_level, friend_number"
        f" FROM {prefix}_friend_log_current"
    ).fetchall()
    live, live_status = live_state(account)
    presence = current_presence(conn, prefix, live,
                                live_status["fetched_at"], account)
    fav_ids, fav_groups, fav_status = fav_state(account)
    imgs = friend_images(conn, prefix, live)

    result = []
    for f in friends:
        uid = f["user_id"]
        d = dict(f)
        p = presence.get(uid)
        d["is_online"] = bool(p and p["is_online"])
        d["last_seen"] = p["since"] if p else ""
        d["location"] = p["location"] if d["is_online"] else ""
        d["world_name"] = p["world_name"] if d["is_online"] else ""
        d["status"] = p["status"] if p else ""
        d["status_description"] = p["status_description"] if p else ""
        d["is_fav"] = uid in fav_ids
        d["fav_groups"] = fav_groups.get(uid, [])
        d["image"] = imgs.get(uid, "")
        result.append(d)
    return {"friends": result, "fav_status": fav_status,
            "live_status": live_status}


def api_user(conn, prefix, params, account):
    uid = require_user_id(params)
    base = conn.execute(
        f"SELECT user_id, display_name, trust_level, friend_number"
        f" FROM {prefix}_friend_log_current WHERE user_id = ?",
        (uid,),
    ).fetchone()
    profile = dict(base) if base else {"user_id": uid}
    profile["is_friend"] = bool(base)
    if not base:
        row = conn.execute(
            f"SELECT display_name FROM {prefix}_feed_online_offline"
            f" WHERE user_id = ? ORDER BY id DESC LIMIT 1",
            (uid,),
        ).fetchone()
        profile["display_name"] = row["display_name"] if row else uid
        profile["trust_level"] = ""
        profile["friend_number"] = None
    fav_ids, fav_groups, fav_status = fav_state(account)
    profile["is_fav"] = uid in fav_ids
    profile["fav_groups"] = fav_groups.get(uid, [])

    live, _ = live_state(account)
    icon = (live["icons"].get(uid, "") if live else "")
    if not icon:
        row = conn.execute(
            f"SELECT current_avatar_thumbnail_image_url"
            f" FROM {prefix}_feed_avatar WHERE user_id = ?"
            f" ORDER BY id DESC LIMIT 1",
            (uid,),
        ).fetchone()
        icon = image_ref(row[0]) if row else ""
    profile["image"] = icon

    note = conn.execute(
        f"SELECT note, created_at FROM {prefix}_notes WHERE user_id = ?",
        (uid,),
    ).fetchone()
    memo = conn.execute(
        "SELECT memo, edited_at FROM memos WHERE user_id = ?", (uid,)
    ).fetchone()

    friends_map = {
        r["user_id"]: r["display_name"]
        for r in conn.execute(
            f"SELECT user_id, display_name FROM {prefix}_friend_log_current"
        )
    }
    mutuals = []
    for r in conn.execute(
        f"SELECT mutual_id FROM {prefix}_mutual_graph_links"
        f" WHERE friend_id = ?",
        (uid,),
    ):
        mid = r["mutual_id"]
        mutuals.append(
            {"user_id": mid, "display_name": friends_map.get(mid, mid),
             "is_friend": mid in friends_map, "is_fav": mid in fav_ids}
        )
    mutuals.sort(key=lambda m: m["display_name"].lower())

    history = conn.execute(
        f"SELECT id, created_at, type, display_name, previous_display_name,"
        f" trust_level, previous_trust_level FROM {prefix}_friend_log_history"
        f" WHERE user_id = ? ORDER BY id DESC LIMIT 50",
        (uid,),
    ).fetchall()

    # the bare thumbnail column rides along with MAX(created_at), so each
    # avatar shows the image from its most recent sighting (SQLite bare-
    # column-with-max semantics)
    avatars = []
    for r in conn.execute(
        f"SELECT avatar_name, COUNT(*) times, MAX(created_at) last_used,"
        f" current_avatar_thumbnail_image_url thumb"
        f" FROM {prefix}_feed_avatar WHERE user_id = ? AND avatar_name != ''"
        f" GROUP BY avatar_name ORDER BY last_used DESC LIMIT 30",
        (uid,),
    ):
        d = dict(r)
        d["image"] = image_ref(d.pop("thumb"))
        avatars.append(d)

    cutoff_ms = int(
        (datetime.now(timezone.utc) - timedelta(days=30)).timestamp() * 1000
    )
    sessions = conn.execute(
        f"SELECT start_at, end_at, is_open_tail"
        f" FROM {prefix}_activity_sessions_v2"
        f" WHERE user_id = ? AND end_at >= ? ORDER BY start_at",
        (uid, cutoff_ms),
    ).fetchall()

    return {
        "profile": profile,
        "note": dict(note) if note else None,
        "memo": dict(memo) if memo else None,
        "mutuals": mutuals,
        "friend_log": [dict(r) for r in history],
        "avatars": avatars,
        "sessions": [dict(r) for r in sessions],
        "fav_status": fav_status,
    }


def api_user_feed(conn, prefix, params, account):
    uid = require_user_id(params)
    limit = min(max(int(params.get("limit", "50")), 1), 200)
    items = fetch_feed_rows(
        conn, prefix, list(FEED_TABLES),
        params.get("before", ""), "", "", limit, user_id=uid,
    )
    next_cursor = items[-1]["created_at"] if len(items) == limit else ""
    return {"items": items, "next": next_cursor}


def api_gamelog(conn, prefix, params, account):
    limit = min(max(int(params.get("limit", "100")), 1), 300)
    before = params.get("before", "")
    cursor_sql = " WHERE created_at < ?" if before else ""
    cursor_args = [before] if before else []
    locations = conn.execute(
        f"SELECT id, created_at, location, world_id, world_name, time,"
        f" group_name FROM gamelog_location{cursor_sql}"
        f" ORDER BY created_at DESC LIMIT ?",
        [*cursor_args, limit],
    ).fetchall()
    joins = conn.execute(
        f"SELECT id, created_at, type, display_name, location, user_id, time"
        f" FROM gamelog_join_leave{cursor_sql}"
        f" ORDER BY created_at DESC LIMIT ?",
        [*cursor_args, limit],
    ).fetchall()
    items = [dict(r, kind="location") for r in locations]
    items += [dict(r, kind="join_leave") for r in joins]
    items.sort(key=lambda d: d["created_at"], reverse=True)
    items = items[:limit]
    next_cursor = items[-1]["created_at"] if len(items) == limit else ""
    return {"items": items, "next": next_cursor}


def api_graph(conn, prefix, params, account):
    friends = conn.execute(
        f"SELECT user_id, display_name, trust_level"
        f" FROM {prefix}_friend_log_current"
    ).fetchall()
    fav_ids, _, fav_status = fav_state(account)
    index = {}
    nodes = []
    for f in friends:
        index[f["user_id"]] = len(nodes)
        nodes.append(
            {"id": f["user_id"], "name": f["display_name"],
             "trust": f["trust_level"], "deg": 0,
             "fav": f["user_id"] in fav_ids}
        )
    seen = set()
    links = []
    for r in conn.execute(
        f"SELECT friend_id, mutual_id FROM {prefix}_mutual_graph_links"
    ):
        a = index.get(r["friend_id"])
        b = index.get(r["mutual_id"])
        if a is None or b is None or a == b:
            continue
        key = (a, b) if a < b else (b, a)
        if key in seen:
            continue
        seen.add(key)
        links.append([key[0], key[1]])
        nodes[a]["deg"] += 1
        nodes[b]["deg"] += 1
    return {"nodes": nodes, "links": links, "fav_status": fav_status}


def api_notifications(conn, prefix, params, account):
    limit = min(max(int(params.get("limit", "50")), 1), 200)
    before = params.get("before", "")
    cursor_sql = " WHERE created_at < ?" if before else ""
    cursor_args = [before] if before else []
    rows = conn.execute(
        f"SELECT id, created_at, type, title, message, sender_username,"
        f" link, link_text FROM {prefix}_notifications_v2{cursor_sql}"
        f" ORDER BY created_at DESC LIMIT ?",
        [*cursor_args, limit],
    ).fetchall()
    items = [dict(r) for r in rows]
    next_cursor = items[-1]["created_at"] if len(items) == limit else ""
    return {"items": items, "next": next_cursor}


def api_activity(conn, prefix, params, account):
    days = int(params.get("days", "7"))
    if days not in (1, 7, 30):
        days = 7
    cutoff = iso_ago(days=days)
    # always bucket by UTC hour; the client re-buckets into local days
    bucket_sql = "substr(created_at, 1, 13)"
    series = {}
    for kind, table in FEED_TABLES.items():
        rows = conn.execute(
            f"SELECT {bucket_sql} b, COUNT(*) c FROM {prefix}_{table}"
            f" WHERE created_at >= ? GROUP BY b",
            (cutoff,),
        ).fetchall()
        series[kind] = {r["b"]: r["c"] for r in rows}

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    cutoff_ms = now_ms - days * 86400_000
    totals = {}
    for r in conn.execute(
        f"SELECT user_id, start_at, end_at, is_open_tail"
        f" FROM {prefix}_activity_sessions_v2 WHERE end_at >= ?"
        f" OR is_open_tail = 1",
        (cutoff_ms,),
    ):
        end = now_ms if r["is_open_tail"] else min(r["end_at"], now_ms)
        start = max(r["start_at"], cutoff_ms)
        if end > start:
            totals[r["user_id"]] = totals.get(r["user_id"], 0) + (end - start)
    friends_map = {
        r["user_id"]: r["display_name"]
        for r in conn.execute(
            f"SELECT user_id, display_name FROM {prefix}_friend_log_current"
        )
    }
    top = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:15]
    top_friends = [
        {"user_id": uid, "display_name": friends_map.get(uid, uid), "ms": ms}
        for uid, ms in top
    ]
    return {
        "days": days,
        "series": series,
        "top_friends": top_friends,
        "server_time": iso_now(),
    }


def api_updates(conn, prefix, params, account):
    after = params.get("after", "")
    latest = ""
    count = 0
    for table in FEED_TABLES.values():
        row = conn.execute(
            f"SELECT MAX(created_at) FROM {prefix}_{table}"
        ).fetchone()
        if row[0] and row[0] > latest:
            latest = row[0]
        if after:
            count += conn.execute(
                f"SELECT COUNT(*) FROM {prefix}_{table} WHERE created_at > ?",
                (after,),
            ).fetchone()[0]
    return {"latest": latest, "new_count": count}


GET_ROUTES = {
    "/api/accounts": api_accounts,
    "/api/favorites": api_favorites,
    "/api/summary": api_summary,
    "/api/locations": api_locations,
    "/api/feed": api_feed,
    "/api/friends": api_friends,
    "/api/user": api_user,
    "/api/user_feed": api_user_feed,
    "/api/gamelog": api_gamelog,
    "/api/graph": api_graph,
    "/api/notifications": api_notifications,
    "/api/activity": api_activity,
    "/api/updates": api_updates,
}

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "VRCRadar/3.0"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if path == "/api/image":
            params = {k: v[0] for k, v in parse_qs(parsed.query).items() if v}
            self.run_image(params)
            return
        handler = GET_ROUTES.get(path)
        if handler:
            params = {k: v[0] for k, v in parse_qs(parsed.query).items() if v}
            self.run_api(handler, params)
            return
        self.serve_static(path)

    def run_image(self, params):
        try:
            account = resolve_account(params)
            ctype, data = get_image(params, account)
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
            return
        except Exception as e:  # noqa: BLE001
            self.send_json(502, {"error": str(e)})
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        # fid+version never changes content; let the browser keep it
        self.send_header("Cache-Control", "public, max-age=604800, immutable")
        self.end_headers()
        self.wfile.write(data)

    def run_api(self, handler, params):
        try:
            account = resolve_account(params)
            conn = connect(account["db"])
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
            return
        except sqlite3.Error as e:
            self.send_json(503, {"error": f"database unavailable: {e}"})
            return
        try:
            self.send_json(
                200, handler(conn, account["prefix"], params, account))
        except ApiError as e:
            self.send_json(e.status, {"error": e.message})
        except sqlite3.OperationalError as e:
            self.send_json(503, {"error": f"database busy: {e}"})
        except Exception as e:  # noqa: BLE001
            self.send_json(500, {"error": str(e)})
        finally:
            conn.close()

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if not target.is_relative_to(STATIC_DIR) or not target.is_file():
            # SPA: unknown non-API paths (e.g. /1, /2) fall back to the shell
            target = STATIC_DIR / "index.html"
            if not target.is_file():
                self.send_json(404, {"error": "not found"})
                return
        body = target.read_bytes()
        ctype = CONTENT_TYPES.get(
            target.suffix.lower(), "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def main():
    accounts = discover_accounts(force=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"VRC Radar listening on http://127.0.0.1:{PORT}", flush=True)
    for a in accounts:
        print(f"account {a['idx']}: {a['label']} ({a['prefix'][:11]}…)"
              f" db={a['db']}", flush=True)
    if not accounts:
        print("WARNING: no VRCX databases found", flush=True)
    try:
        files = [f for f in IMG_DIR.iterdir() if f.name.startswith("file_")]
        mb = sum(f.stat().st_size for f in files) / 1e6
        print(f"image cache: {len(files)} files, {mb:.1f}MB", flush=True)
    except OSError:
        pass
    server.serve_forever()


if __name__ == "__main__":
    main()
