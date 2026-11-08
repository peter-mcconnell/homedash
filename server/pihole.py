"""Pi-hole v6 stats for the network page (session login with the admin password, re-login on expiry)."""
import json, os, time, urllib.request

_sid = {"v": None, "t": 0}


def _req(method, path, sid=None, body=None):
    url = os.environ.get("PIHOLE_URL", "http://127.0.0.1:8053").rstrip("/") + "/api/" + path
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json", **({"sid": sid} if sid else {})})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)


def _login():
    if _sid["v"] and time.time() - _sid["t"] < 1200:
        return _sid["v"]
    r = _req("POST", "auth", body={"password": os.environ["PIHOLE_PASSWORD"]})
    _sid["v"], _sid["t"] = r["session"]["sid"], time.time()
    return _sid["v"]


def get(path):
    try:
        return _req("GET", path, sid=_login())
    except urllib.error.HTTPError as e:
        if e.code == 401:   # session expired: log in again once
            _sid["v"] = None
            return _req("GET", path, sid=_login())
        raise


def stats(names=None):
    names = names or {}
    s = get("stats/summary")
    # upstream "0.0.0.0" answers (e.g. bare plex.direct) count as blocked in Pi-hole but aren't ours: hide them
    blocked = [d for d in get("stats/top_domains?blocked=true&count=14")["domains"] if not d["domain"].endswith("plex.direct")][:10]
    clients = [c for c in get("stats/top_clients?count=15")["clients"] if c["ip"] not in ("127.0.0.1", "::1")][:10]
    hist = get("history")["history"]
    q = s["queries"]
    return {
        "total": q["total"], "blocked": q["blocked"], "percent": round(q["percent_blocked"], 1),
        "cached": q.get("cached"), "forwarded": q.get("forwarded"),
        "clients_active": (s.get("clients") or {}).get("active"),
        "blocklist_size": (s.get("gravity") or {}).get("domains_being_blocked"),
        "top_blocked": [{"domain": d["domain"], "count": d["count"]} for d in blocked],
        "top_clients": [{"name": c.get("name") or names.get(c["ip"]) or c["ip"], "ip": c["ip"], "count": c["count"]} for c in clients],
        "history": [{"t": h["timestamp"], "allowed": h["total"] - h["blocked"], "blocked": h["blocked"]} for h in hist[-144:]],
    }
