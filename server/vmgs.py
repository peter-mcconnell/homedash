"""Events from Visit Mourne Gullion Strangford (the council-area tourism site). Its /whats-on page is
server-rendered with an event card per listing (name, location, from/to dates, image, description).
Fetched at most once a day, cached on disk."""
import html, json, re, time, urllib.request
from datetime import datetime
from pathlib import Path

BASE = "https://www.visitmournegullionstrangford.com"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
CACHE = Path("/data/vmgs_events.json")
MAX_AGE = 24 * 3600


def _date(s):
    m = re.match(r"\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})", s or "")
    if not m:
        return ""
    try:
        return datetime.strptime(f"{m.group(1)} {m.group(2)[:3]} {m.group(3)}", "%d %b %Y").date().isoformat()
    except ValueError:
        return ""


def _text(s):
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or ""))).strip()


def fetch():
    with urllib.request.urlopen(urllib.request.Request(BASE + "/whats-on", headers={"User-Agent": UA}), timeout=30) as r:
        page = r.read().decode("utf-8", "replace")
    events, seen = [], set()
    for block in re.split(r'<div class="Highlight Item', page)[1:]:
        pid = re.match(r'[^"]*\bp(\d+)"', block)
        name = re.search(r'<a class="Name" href="([^"]+)">([\s\S]*?)</a>', block)
        if not pid or not name or pid.group(1) in seen:
            continue
        seen.add(pid.group(1))
        loc = re.search(r'class="node location"[^>]*>[\s\S]*?<span class="value">([\s\S]*?)</span>', block)
        start = re.search(r'<span class="From">([^<]+)</span>', block)
        end = re.search(r'<span class="To">([^<]+)</span>', block)
        when = re.search(r'<h4>([^<]+)</h4>', block)
        img = re.search(r'data-lazy-src="([^"]+)"', block)
        desc = re.search(r'<p class="Desc"[^>]*>([\s\S]*?)</p>', block)
        events.append({
            "name": _text(name.group(2)), "url": BASE + name.group(1) if name.group(1).startswith("/") else name.group(1),
            "place": _text(loc.group(1)) if loc else "", "start": _date(start.group(1)) if start else "",
            "end": _date(end.group(1)) if end else "", "when": _text(when.group(1)) if when else "",
            "image": html.unescape(img.group(1)) if img else "", "summary": _text(desc.group(1))[:200] if desc else "",
            "source": "Visit Mourne",
        })
    return [e for e in events if e["start"]]


def cached(force=False):
    try:
        c = json.loads(CACHE.read_text())
        if not force and time.time() - c["fetched"] < MAX_AGE:
            return c["events"], c["fetched"]
    except (OSError, ValueError, KeyError):
        c = None
    try:
        ev = fetch()
    except Exception:
        if c:
            return c["events"], c["fetched"]
        raise
    CACHE.write_text(json.dumps({"fetched": time.time(), "events": ev}))
    return ev, time.time()
