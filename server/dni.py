"""Events near home from Discover Northern Ireland (Tourism NI's Simpleview site).

There's no public API or RSS; this uses the same endpoint the site's own what's-on page calls
(a per-visitor token from /plugins/core/get_simple_token/), fetched at most once a day and cached
on disk. The user approved this source explicitly.
"""
import json, logging, math, time, urllib.parse, urllib.request
from datetime import date, timedelta
from pathlib import Path

log = logging.getLogger("homedash.dni")
BASE = "https://discovernorthernireland.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
CACHE = Path("/data/dni_events.json")
MAX_AGE = 24 * 3600
LOCAL_TOWNS = ("annalong", "kilkeel", "newcastle", "warrenpoint", "rostrevor", "castlewellan", "dundrum", "newry",
               "hilltown", "mourne", "ballymartin", "attical", "bryansford", "maghera", "clough", "rathfriland",
               "mayobridge", "burren", "killowen", "greencastle", "silent valley", "tollymore", "murlough")


def _get(url, timeout=25):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
        return r.read()


def miles(lat1, lon1, lat2, lon2):
    r = 3958.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def fetch(home_lat, home_lon, radius_miles=20, days=14):
    token = _get(BASE + "/plugins/core/get_simple_token/").decode().strip().strip('"')
    start = date.today()
    filt = {"calendarid": {"$eq": "1"},
            "date_range": {"start": {"$date": f"{start.isoformat()}T00:00:00.000Z"},
                           "end": {"$date": f"{(start + timedelta(days=days)).isoformat()}T00:00:00.000Z"}}}
    fields = {k: 1 for k in ("title", "date", "startDate", "endDate", "city", "url", "media_raw", "latitude",
                             "longitude", "categories", "location", "recid", "admission")}
    events, skip, seen = [], 0, set()
    stats = {"total": 0, "no_coords": 0, "by_town": 0}
    while skip < 1200:   # page through all NI events in the window (typically a few hundred)
        opts = {"limit": 200, "skip": skip, "count": True, "castDocs": False,
                "sort": {"date": 1, "rank": 1, "title_sort": 1}, "fields": fields}
        url = BASE + "/includes/rest_v2/plugins_events_events_by_date/find/?" + urllib.parse.urlencode(
            {"json": json.dumps({"filter": filt, "options": opts}), "token": token})
        docs = json.loads(_get(url))["docs"]
        batch = docs.get("docs") or []
        for d in batch:
            stats["total"] += 1
            place = f'{d.get("city") or ""} {d.get("location") or ""} {d.get("title") or ""}'.lower()
            try:
                dist = miles(home_lat, home_lon, float(d.get("latitude")), float(d.get("longitude")))
            except (TypeError, ValueError):
                stats["no_coords"] += 1
                dist = None
            if dist is None or dist > radius_miles:
                if not any(t in place for t in LOCAL_TOWNS):
                    continue
                stats["by_town"] += 1
                dist = dist if dist is not None and dist < 40 else 0.0
            key = (d.get("recid"), (d.get("date") or "")[:10])
            if key in seen:
                continue
            seen.add(key)
            media = (d.get("media_raw") or [{}])[0]
            img = media.get("mediaurl") or ""
            u = d.get("url") or ""
            events.append({
                "name": d.get("title", ""), "start": (d.get("date") or "")[:10],
                "end": (d.get("endDate") or "")[:10], "place": d.get("city") or d.get("location") or "",
                "miles": round(dist, 1), "url": u if u.startswith("http") else BASE + u,
                "image": img, "category": ((d.get("categories") or [{}])[0] or {}).get("catName", ""),
                "price": d.get("admission") or "", "source": "Discover NI",
            })
        skip += len(batch)
        if len(batch) < 200:
            break
        time.sleep(2)
    events.sort(key=lambda e: (e["start"], e["miles"]))
    log.info("discover NI: %d events in window, %d without coordinates, %d kept by town name, %d kept nearby",
             stats["total"], stats["no_coords"], stats["by_town"], len(events))
    return events


def cached(home_lat, home_lon, radius_miles=20, force=False):
    """Return (events, fetched_at), refreshing from the site at most once per MAX_AGE."""
    try:
        c = json.loads(CACHE.read_text())
        if not force and time.time() - c["fetched"] < MAX_AGE:
            return c["events"], c["fetched"]
    except (OSError, ValueError, KeyError):
        c = None
    try:
        ev = fetch(home_lat, home_lon, radius_miles)
    except Exception:
        if c:   # keep yesterday's list if today's fetch fails
            return c["events"], c["fetched"]
        raise
    CACHE.write_text(json.dumps({"fetched": time.time(), "events": ev}))
    return ev, time.time()
