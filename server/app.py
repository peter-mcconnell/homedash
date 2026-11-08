"""homedash — data backend + static host for the house TV/phone dashboard.

Runs in Docker with host networking. Collectors refresh in background threads and the dashboard
polls GET /api/state. Household/location/source settings come from config.toml (see config.py);
secrets (Plex token, router password, API keys) come from the environment and never leave this
process — e.g. Plex artwork is proxied through /img.
"""
import html, json, logging, os, re, socket, uuid, threading, time, urllib.parse, urllib.request
import xml.etree.ElementTree as ET
from collections import OrderedDict, deque
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import alerts, backgrounds, clubs, dni, family, marine, pdfpages, pihole, reader, school, solax, usp, vmgs
from config import C, secret, public as public_config, widgets as widget_flags

TZ = ZoneInfo(C["household"]["timezone"])
W = widget_flags()   # effective widget switches (config + credentials present)

log = logging.getLogger("homedash")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

CFG = {
    "place": C["location"]["name"], "lat": C["location"]["lat"], "lon": C["location"]["lon"],
    "port": int(os.environ.get("PORT", "8090")),
    "plex_url": C["plex"]["url"].rstrip("/"), "plex_token": secret("PLEX_TOKEN"),
    "hub_host": C["network"]["router_host"], "hub_password": secret("EE_HUB_PASSWORD"),
    "marine_lat": C["marine"]["lat"], "marine_lon": C["marine"]["lon"],
    "warnings_feed": C["weather"]["warnings_feed"],
}
# RSS news feeds + Facebook pages (via an RSS bridge such as FetchRSS), in display priority order
NEWS_FEEDS = [dict(f, facebook=False) for f in C["news"]["feeds"]] + \
             [dict(f, facebook=True, local=True) for f in C["events"]["facebook_feeds"]]
STATIC = Path(__file__).parent / "static"
UA = "Mozilla/5.0 (X11; Linux x86_64) homedash/1.0"

STATE = {}
LOCK = threading.Lock()


def put(section, data=None, error=None):
    with LOCK:
        prev = STATE.get(section, {})
        STATE[section] = {
            "data": data if data is not None else prev.get("data"),
            "updated": time.time() if error is None else prev.get("updated"),
            "error": error,
        }


def http_get(url, headers=None, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def every(seconds, name):
    """Decorator: run fn forever in a daemon thread every `seconds`, recording errors in STATE."""
    def deco(fn):
        def loop():
            time.sleep(2)   # let the whole module load first (collectors start as soon as they're defined)
            while True:
                try:
                    fn()
                except Exception as e:  # keep last good data, surface the error
                    log.warning("%s failed: %s", name, e)
                    put(name, error=str(e)[:200])
                time.sleep(seconds)
        threading.Thread(target=loop, name=name, daemon=True).start()
        return fn
    return deco


# ---------------------------------------------------------------- weather
WMO = {
    0: ("Clear", "clear"), 1: ("Mostly clear", "clear"), 2: ("Partly cloudy", "partly"), 3: ("Overcast", "cloud"),
    45: ("Fog", "fog"), 48: ("Freezing fog", "fog"),
    51: ("Light drizzle", "drizzle"), 53: ("Drizzle", "drizzle"), 55: ("Heavy drizzle", "drizzle"),
    56: ("Freezing drizzle", "drizzle"), 57: ("Freezing drizzle", "drizzle"),
    61: ("Light rain", "rain"), 63: ("Rain", "rain"), 65: ("Heavy rain", "rain"),
    66: ("Freezing rain", "rain"), 67: ("Freezing rain", "rain"),
    71: ("Light snow", "snow"), 73: ("Snow", "snow"), 75: ("Heavy snow", "snow"), 77: ("Snow grains", "snow"),
    80: ("Light showers", "showers"), 81: ("Showers", "showers"), 82: ("Heavy showers", "showers"),
    85: ("Snow showers", "snow"), 86: ("Heavy snow showers", "snow"),
    95: ("Thunderstorm", "thunder"), 96: ("Thunderstorm, hail", "thunder"), 99: ("Thunderstorm, hail", "thunder"),
}
BEAUFORT = [(1, "Calm"), (4, "Light air"), (8, "Light breeze"), (13, "Gentle breeze"), (19, "Moderate breeze"),
            (25, "Fresh breeze"), (32, "Strong breeze"), (39, "Near gale"), (47, "Gale"), (55, "Severe gale"),
            (64, "Storm"), (73, "Violent storm"), (999, "Hurricane force")]
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def wmo(code):
    return WMO.get(int(code or 0), ("Unknown", "cloud"))


def beaufort(mph):
    for force, (limit, name) in enumerate(BEAUFORT):
        if mph < limit:
            return force, name
    return 12, BEAUFORT[-1][1]


def compass(deg):
    return COMPASS[int(((deg or 0) % 360) / 22.5 + 0.5) % 16]


@every(600, "weather")
def collect_weather():
    if not (W["weather"] or W["marine"]):
        return
    q = urllib.parse.urlencode({
        "latitude": CFG["lat"], "longitude": CFG["lon"], "timezone": "Europe/London", "wind_speed_unit": "mph",
        "current": "temperature_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_gusts_10m,"
                   "wind_direction_10m,relative_humidity_2m,precipitation,pressure_msl",
        "hourly": "temperature_2m,precipitation_probability,weather_code,is_day,wind_speed_10m,wind_gusts_10m,wind_direction_10m",
        "daily": "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,"
                 "wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,sunrise,sunset",
        "forecast_days": 6, "forecast_hours": 25,
    })
    w = json.loads(http_get(f"https://api.open-meteo.com/v1/forecast?{q}"))
    c = w["current"]
    force, force_name = beaufort(c["wind_speed_10m"])
    label, icon = wmo(c["weather_code"])
    now = {
        "temp": c["temperature_2m"], "feels": c["apparent_temperature"], "label": label, "icon": icon,
        "day": bool(c["is_day"]), "humidity": c["relative_humidity_2m"], "pressure": c["pressure_msl"],
        "precip": c["precipitation"],
        "wind": {"speed": c["wind_speed_10m"], "gust": c["wind_gusts_10m"], "dir": c["wind_direction_10m"],
                 "compass": compass(c["wind_direction_10m"]), "force": force, "force_name": force_name},
    }
    h = w["hourly"]
    hourly = []
    for i, t in enumerate(h["time"][:25]):
        l, ic = wmo(h["weather_code"][i])
        hourly.append({"time": t, "temp": h["temperature_2m"][i], "pop": h["precipitation_probability"][i],
                       "icon": ic, "label": l, "day": bool(h["is_day"][i]), "wind": h["wind_speed_10m"][i],
                       "gust": h["wind_gusts_10m"][i], "dir": h["wind_direction_10m"][i]})
    d = w["daily"]
    daily = []
    for i, t in enumerate(d["time"]):
        l, ic = wmo(d["weather_code"][i])
        daily.append({"date": t, "max": d["temperature_2m_max"][i], "min": d["temperature_2m_min"][i],
                      "pop": d["precipitation_probability_max"][i], "icon": ic, "label": l,
                      "wind": d["wind_speed_10m_max"][i], "gust": d["wind_gusts_10m_max"][i],
                      "dir": d["wind_direction_10m_dominant"][i], "compass": compass(d["wind_direction_10m_dominant"][i]),
                      "sunrise": d["sunrise"][i][-5:], "sunset": d["sunset"][i][-5:]})
    put("weather", {"place": CFG["place"], "now": now, "hourly": hourly, "daily": daily})


@every(900, "warnings")
def collect_warnings():
    if not (W["weather"] and CFG["warnings_feed"]):
        return
    root = ET.fromstring(http_get(CFG["warnings_feed"]))
    ns = {"a": "http://www.w3.org/2005/Atom"}
    items = []
    entries = root.findall("a:entry", ns) or root.findall(".//item")
    for e in entries:
        title = (e.findtext("a:title", None, ns) or e.findtext("title") or "").strip()
        summary = (e.findtext("a:summary", None, ns) or e.findtext("description") or "").strip()
        if title:
            items.append({"title": title, "summary": summary[:300]})
    put("warnings", items)


# ---------------------------------------------------------------- news
def _hub_titles():
    try:
        out = {}
        for e in json.loads(Path("/data/hub_events.json").read_text()).get("events", []):
            out.setdefault(e.get("post"), e["title"])
        return out
    except (OSError, ValueError, KeyError):
        return {}


HUB_TITLES = {}


@every(600, "news")
def collect_news():
    if not W["news"]:
        return
    HUB_TITLES.clear(); HUB_TITLES.update(_hub_titles())
    items, seen, errors = [], set(), []
    if C["school"]["enabled"]:
        try:
            for it in school_news(C["school"]["max_age_days"]):
                if it["title"].lower() not in seen:
                    seen.add(it["title"].lower()); items.append(it)
        except Exception as e:
            errors.append(f"{C['school']['name']}: {e}")
    for feed in NEWS_FEEDS:
        source, url = feed["name"], feed["url"]
        try:
            root = ET.fromstring(http_get(url))
        except Exception as e:
            errors.append(f"{source}: {e}")
            continue
        n = 0
        for it in root.iter("item"):
            title = html.unescape((it.findtext("title") or "").strip())
            if not title or title.lower() in seen:
                continue
            seen.add(title.lower())
            try:
                ts = parsedate_to_datetime(it.findtext("pubDate")).timestamp()
            except Exception:
                ts = None
            desc_html = html.unescape(it.findtext("description") or "")
            summary = re.sub(r"<[^>]+>", " ", desc_html).strip()
            summary = re.sub(r"\(Feed generated with\s+FetchRSS\s*\)", "", summary)
            summary = re.sub(r"\s+", " ", re.sub(r"The post .* appeared first on .*$", "", summary)).strip()
            link = (it.findtext("link") or "").strip()
            if feed["facebook"]:   # Facebook posts: titles are often generic ("A post from…", "Photos from…")
                if re.match(r"^(A post from|Photos from|@|\(Feed generated)", title) or len(title) < 12:
                    first = re.split(r"(?<=[.!?])\s", re.sub(r"^@\w+(\s+\w+)?\s*", "", summary), 1)[0] if summary else ""
                    poster = HUB_TITLES.get(link)   # picture-only posts: name them after the event read off the poster
                    title = (first[:110] if first else "") or (poster and "Poster: " + poster) or title
                imgs = re.findall(r'<img[^>]+src="([^"]+)"', desc_html)
            item = {"title": title, "summary": summary[:240], "ts": ts, "link": link,
                    "source": source, "local": bool(feed.get("local")), "image": news_image(it, link)}
            if feed["facebook"]:
                item.update(image=imgs[0] if imgs else "", text=summary[:1500], images=imgs[:6])
            items.append(item)
            n += 1
            if n >= 10:
                break
    for e in errors:
        log.warning("news source failed: %s", e)
    if not items:
        raise RuntimeError("; ".join(errors) or "no news")
    # local stories first (newest first), then regional/national
    items.sort(key=lambda i: (not i["local"], -(i["ts"] or 0)))
    put("news", {"source": " + ".join(f["name"] for f in NEWS_FEEDS), "items": items[:18]})


SCHOOL_URL = C["school"]["site"].rstrip("/")


def school_news(max_age_days=60):
    """School news from a "School Website Design" (swd) site's /news/ listing (these sites have no RSS)."""
    page = http_get(SCHOOL_URL + "/news/").decode("utf-8", "replace")
    out = []
    for block in re.split(r'<div class="listItem newsListItem', page)[1:]:
        m = re.search(r'class="listItemTitle"><a href="([^"]+)">([\s\S]*?)</a>', block)
        if not m:
            continue
        title = html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        d = re.search(r'class="listItemSubtitle">\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3})[a-z]*\s+(\d{4})', block)
        ts = None
        if d:
            try:
                ts = datetime.strptime(f"{d.group(1)} {d.group(2)} {d.group(3)}", "%d %b %Y").timestamp()
            except ValueError:
                pass
        if ts and ts < time.time() - max_age_days * 86400:
            continue
        summary = re.search(r'class="listItemText">([\s\S]*?)</div>', block)
        img = re.search(r"background:url\(([^)]+)\)", block)
        out.append({"title": title, "summary": html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", summary.group(1) if summary else ""))).strip()[:240],
                    "ts": ts, "link": SCHOOL_URL + m.group(1).split("?")[0], "source": C["school"]["name"], "local": True,
                    "image": img.group(1).strip("'\"") if img else ""})
    return out[:6]


MEDIA_NS = "{http://search.yahoo.com/mrss/}"
OG_CACHE = {}   # article link -> og:image url ("" if none)


def news_image(item, link):
    """Best picture for a news item: RSS media thumbnail (BBC, upsized) or the article's og:image."""
    thumb = item.find(MEDIA_NS + "thumbnail")
    if thumb is not None and thumb.get("url"):
        return re.sub(r"/standard/\d+/", "/standard/480/", thumb.get("url"))
    if not link:
        return ""
    if link not in OG_CACHE:
        try:
            page = http_get(link, timeout=10)[:300000].decode("utf-8", "replace")
            m = re.search(r'<meta[^>]+property="og:image"[^>]+content="([^"]+)"', page)
            OG_CACHE[link] = html.unescape(m.group(1)) if m else ""
        except Exception:
            OG_CACHE[link] = ""
        if len(OG_CACHE) > 200:
            OG_CACHE.pop(next(iter(OG_CACHE)))
    return OG_CACHE[link]


NEWS_IMG_HOSTS = ("ichef.bbci.co.uk", "mourneobserver.com", "swdcache.b-cdn.net", "simpleviewinc.com",
                  "newmindmedia.com", "discovernorthernireland.com", "evbuc.com", "simpleview-europe.com", "fbcdn.net")
NEWS_IMG_CACHE = OrderedDict()


def news_image_bytes(url, w):
    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == h or host.endswith("." + h) for h in NEWS_IMG_HOSTS):
        raise ValueError("host not allowed")
    key = f"{url}|{w}"
    if key in NEWS_IMG_CACHE:
        NEWS_IMG_CACHE.move_to_end(key)
        return NEWS_IMG_CACHE[key]
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(http_get(url, timeout=15))).convert("RGB")
    im.thumbnail((w, w))
    out = BytesIO()
    im.save(out, "JPEG", quality=82, optimize=True)
    data = out.getvalue()
    NEWS_IMG_CACHE[key] = data
    while len(NEWS_IMG_CACHE) > 60:
        NEWS_IMG_CACHE.popitem(last=False)
    return data


NEAR_TOWNS = tuple(t.lower() for t in C["events"]["near_towns"])   # events here are shown first


@every(300, "alerts")
def collect_alerts():
    if not W["alerts"]:
        return
    put("alerts", alerts.collect(datetime.now(TZ).replace(tzinfo=None)))


@every(60, "pihole")
def collect_pihole():
    if not W["pihole"]:
        return
    hub = section_data("hub") or {}
    names = {d["ip"]: d["name"] for d in hub.get("devices", []) if d.get("ip")}
    names.update(C["network"]["names"])   # friendly names for IPs the router doesn't name
    put("pihole", pihole.stats(names))


SOLAR_BACKFILL = {}


@every(120, "solar")
def collect_solar():
    if not W["solar"]:
        return
    midnight = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    if SOLAR_BACKFILL.get("day") != midnight:   # once a day (and at start-up), load today's 5-minute history
        try:
            log.info("solar: backfilled %d points", solax.backfill(midnight))
            SOLAR_BACKFILL["day"] = midnight
        except Exception as e:
            log.warning("solar backfill failed: %s", e)
    s = solax.now()
    hist = solax.record(s)
    put("solar", dict(s, history=[h for h in hist if h["t"] >= midnight]))


SCHOOL_EVENTS = {}


@every(6 * 3600, "school")
def collect_school():
    if not (C["school"]["enabled"] and C["school"]["newsletter_dates"]):
        return
    SCHOOL_EVENTS["events"] = school.cached()   # re-reads the newsletters at most once a day
    put("school", {"count": len(SCHOOL_EVENTS["events"])})


@every(3600, "nearby")
def collect_nearby():
    """What's on nearby from regional tourism listings, each fetched at most once a day."""
    if not W["events"]:
        return
    sources = []
    if C["events"]["visit_mgs"].get("enabled"):
        sources.append(("Visit Mourne", lambda: vmgs.cached()))
    if C["events"]["discover_ni"].get("enabled"):
        sources.append(("Discover NI", lambda: dni.cached(CFG["lat"], CFG["lon"], C["events"]["radius_miles"])))
    if not sources:
        return
    merged, seen, errors = [], set(), []
    for name, get in sources:
        try:
            ev, _ = get()
        except Exception as e:
            errors.append(f"{name}: {e}")
            continue
        for e in ev:
            key = re.sub(r"[^a-z0-9]", "", e["name"].lower())[:40]
            if key in seen:
                continue
            seen.add(key)
            merged.append(e)
    if not merged and errors:
        raise RuntimeError("; ".join(errors))
    today = datetime.now(TZ).date()
    horizon = (today + timedelta(days=14)).isoformat()
    items = []
    for e in merged:
        end = e.get("end") or e["start"]
        if end < today.isoformat() or e["start"] > horizon:
            continue
        try:
            span = (date.fromisoformat(end) - date.fromisoformat(e["start"])).days
        except ValueError:
            span = 0
        place = (e.get("place") or "").lower()
        items.append(dict(e, ongoing=span > 21, near=any(t in place for t in NEAR_TOWNS)))
    items.sort(key=lambda e: (e["ongoing"], max(e["start"], today.isoformat()), not e["near"], e["name"]))
    put("nearby", {"items": items[:80], "errors": errors})


@every(3600, "events")
def collect_events():
    """A community venue's events: Eventbrite organiser listings + posters transcribed by tools/hub-posters."""
    if not W["events"]:
        return
    events = []
    for org in C["events"]["eventbrite"]:
        url = f"https://www.eventbrite.co.uk/api/v3/organizers/{org['organizer_id']}/events/?status=live&order_by=start_asc"
        try:
            data = json.loads(http_get(url))
        except Exception as e:
            log.warning("eventbrite %s: %s", org.get("name"), e)
            continue
        for e in data.get("events") or []:
            start = (e.get("start") or {}).get("local")
            if not start:
                continue
            events.append({"name": (e.get("name") or {}).get("text", ""), "start": start,
                           "summary": (e.get("summary") or "")[:200], "url": e.get("url", "")})
    try:   # what's-on posters, transcribed by tools/hub-posters (claude -p) on the host
        now_iso = datetime.now(TZ).strftime("%Y-%m-%dT%H:%M")
        for e in json.loads(Path("/data/hub_events.json").read_text()).get("events", []):
            start = e["date"] + "T" + (e.get("start") or "00:00")
            end = e["date"] + "T" + (e.get("end") or e.get("start") or "23:59")
            if end >= now_iso:
                events.append({"name": e["title"], "start": start, "summary": e.get("note", ""), "url": e.get("post", ""),
                               "allday": not e.get("start")})
    except (OSError, ValueError, KeyError):
        pass
    events.sort(key=lambda e: e["start"])
    venue = (C["events"]["eventbrite"] or C["events"]["facebook_feeds"] or [{"name": "Events"}])[0]["name"]
    put("events", {"venue": venue, "items": events[:40]})


# ---------------------------------------------------------------- plex
def plex(path):
    sep = "&" if "?" in path else "?"
    return json.loads(http_get(f"{CFG['plex_url']}{path}{sep}X-Plex-Token={CFG['plex_token']}",
                               headers={"Accept": "application/json"}, timeout=10))["MediaContainer"]


def plex_title(m):
    t = m.get("type")
    if t == "episode":
        return m.get("grandparentTitle", ""), f"S{m.get('parentIndex', 0):02d}E{m.get('index', 0):02d} · {m.get('title', '')}"
    if t == "season":
        return m.get("parentTitle", ""), m.get("title", "")
    if t == "track":
        return m.get("title", ""), f"{m.get('grandparentTitle', '')} · {m.get('parentTitle', '')}"
    if t == "album":
        return m.get("title", ""), m.get("parentTitle", "")
    return m.get("title", ""), str(m.get("year", "")) if m.get("year") else ""


def plex_art(m):
    t = m.get("type")
    if t == "episode":
        return m.get("grandparentThumb") or m.get("parentThumb") or m.get("thumb")
    if t in ("season", "track"):
        return m.get("parentThumb") or m.get("grandparentThumb") or m.get("thumb")
    return m.get("thumb")


@every(10, "plex")
def collect_plex():
    if not W["plex"]:
        return
    sess = plex("/status/sessions")
    playing = []
    for m in sess.get("Metadata", []) or []:
        title, sub = plex_title(m)
        dur, off = m.get("duration") or 0, m.get("viewOffset") or 0
        ts = m.get("TranscodeSession")
        playing.append({
            "title": title, "subtitle": sub, "type": m.get("type"),
            "user": (m.get("User") or {}).get("title", ""),
            "player": (m.get("Player") or {}).get("title") or (m.get("Player") or {}).get("product", ""),
            "state": (m.get("Player") or {}).get("state", ""),
            "progress": round(off / dur, 4) if dur else 0, "remaining_min": round((dur - off) / 60000) if dur else None,
            "transcode": bool(ts and ts.get("videoDecision") == "transcode"),
            "art": plex_art(m), **plex_details(m),
        })
    recent = []
    for m in (plex("/library/recentlyAdded?X-Plex-Container-Start=0&X-Plex-Container-Size=10").get("Metadata") or []):
        title, sub = plex_title(m)
        recent.append({"title": title, "subtitle": sub, "type": m.get("type"), "added": m.get("addedAt"),
                       "library": m.get("librarySectionTitle", ""), "art": plex_art(m), **plex_details(m)})
    put("plex", {"playing": playing, "recent": recent})


def plex_details(m):
    return {"key": m.get("ratingKey"), "year": m.get("year") or m.get("parentYear"),
            "summary": (m.get("summary") or m.get("parentSummary") or "")[:600],
            "duration_min": round((m.get("duration") or 0) / 60000) or None,
            "rating": m.get("audienceRating") or m.get("rating"), "content_rating": m.get("contentRating"),
            "studio": m.get("studio"), "genres": [g.get("tag") for g in (m.get("Genre") or [])][:3]}


IMG_CACHE = OrderedDict()
IMG_LOCK = threading.Lock()


def plex_image(path, w, h):
    key = f"{path}|{w}|{h}"
    with IMG_LOCK:
        if key in IMG_CACHE:
            IMG_CACHE.move_to_end(key)
            return IMG_CACHE[key]
    q = urllib.parse.urlencode({"width": w, "height": h, "minSize": 1, "upscale": 1, "url": path,
                                "X-Plex-Token": CFG["plex_token"]})
    data = http_get(f"{CFG['plex_url']}/photo/:/transcode?{q}", timeout=15)
    with IMG_LOCK:
        IMG_CACHE[key] = data
        while len(IMG_CACHE) > 150:
            IMG_CACHE.popitem(last=False)
    return data


# ---------------------------------------------------------------- marine
@every(1800, "marine")
def collect_marine():
    if not W["marine"]:
        return
    q = urllib.parse.urlencode({
        "latitude": CFG["marine_lat"], "longitude": CFG["marine_lon"], "timezone": "Europe/London",
        "minutely_15": "sea_level_height_msl", "hourly": "wave_height,sea_surface_temperature",
        "past_days": 1, "forecast_days": 3,
    })
    m = json.loads(http_get(f"https://marine-api.open-meteo.com/v1/marine?{q}"))
    now = datetime.now(TZ).replace(tzinfo=None)
    t = marine.tides(m, now)
    hr = m.get("hourly", {})
    idx = 0
    for i, ts in enumerate(hr.get("time", [])):
        if datetime.fromisoformat(ts) <= now:
            idx = i
    t["waves"] = (hr.get("wave_height") or [None])[idx]
    t["sea_temp"] = (hr.get("sea_surface_temperature") or [None])[idx]
    put("marine", t)


def pier_now():
    """Fishing verdict, computed on request from the latest weather + marine data."""
    w, m = section_data("weather"), section_data("marine")
    if not w or not m:
        return None
    now = datetime.now(TZ).replace(tzinfo=None)
    pops = [h["pop"] for h in w["hourly"] if now - timedelta(hours=1) <= datetime.fromisoformat(h["time"]) <= now + timedelta(hours=3)]
    v = marine.verdict(now, w["now"]["wind"], m.get("waves"), m, max(pops) if pops else None,
                       w["daily"][0]["sunset"] if w.get("daily") else None)
    return {"verdict": v, "fish": marine.in_season(now.month), "month": now.strftime("%B")}


def section_data(name):
    with LOCK:
        return (STATE.get(name) or {}).get("data")


def bins_for(today):
    """Bin day from a fixed rotation: config [bins] day, anchor (a date whose collection is rotation[0]), rotation."""
    b = C["bins"]
    days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
    wd = days.index(b["day"].lower())
    rot, labels = b["rotation"], b["labels"]
    anchor = date.fromisoformat(b["anchor"])
    days_to = (wd - today.weekday()) % 7
    nxt = today + timedelta(days=days_to)
    i = ((nxt - anchor).days // 7) % len(rot)
    label = lambda bins: " & ".join(labels.get(x, x.title()) for x in bins) if len(bins) == 1 else \
        " & ".join(x.title() for x in bins[:-1]) + " & " + bins[-1] + " bins"
    nb = rot[(i + 1) % len(rot)]
    return {"date": nxt.isoformat(), "days": days_to, "day": b["day"], "bins": rot[i], "label": label(rot[i]),
            "following": {"bins": nb, "label": label(nb), "date": (nxt + timedelta(days=7)).isoformat()}}


# ---------------------------------------------------------------- backgrounds
def _bg_loop():
    if not W["backgrounds"]:
        return
    while True:
        try:
            more = backgrounds.crawl_step()
        except Exception as e:
            log.warning("backgrounds: %s", e)
            more = True
            time.sleep(900 if "429" in str(e) else 60)
        put("backgrounds", backgrounds.listing())
        time.sleep(6 if more else 6 * 3600)


threading.Thread(target=_bg_loop, name="backgrounds", daemon=True).start()


# ---------------------------------------------------------------- network
LATENCY = deque(maxlen=60)  # (ts, ms or None)
PREV_HUB = {}


def tcp_ms(host, port, timeout=3):
    t = time.monotonic()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return round((time.monotonic() - t) * 1000, 1)
    except OSError:
        return None


@every(30, "latency")
def collect_latency():
    samples = [x for x in (tcp_ms("1.1.1.1", 443), tcp_ms("8.8.8.8", 443)) if x is not None]
    LATENCY.append((time.time(), min(samples) if samples else None))
    services = {svc["name"]: tcp_ms(svc["host"], int(svc.get("port", 443))) is not None for svc in C["network"]["services"]}
    put("latency", {"internet": bool(samples), "ms": LATENCY[-1][1],
                    "history": [ms for _, ms in LATENCY], "services": services})


HUB_LOCK = threading.Lock()
HOST_SNAPS = deque(maxlen=80)    # (ts, {mac: (rx, tx)}) for per-device rates over a ~1 minute window
THROUGHPUT = deque(maxlen=240)   # (ts, down_bps, up_bps): 5s samples while the network page is open, 60s otherwise


def _host_name(h, mac):
    name = h.get("X_BT-COM_UserHostName") or h.get("HostName") or ""
    return "Unnamed (" + mac[-8:] + ")" if not name or name.lower().replace("-", ":") == mac else name


def sample_hub(max_age=0.0):
    """Read the hub (at most one query at a time) and derive rates vs the previous sample.
    Returns the cached result if the last sample is younger than max_age seconds."""
    with HUB_LOCK:
        prev = PREV_HUB.get("snap")
        if prev and time.time() - prev["ts"] < max_age and PREV_HUB.get("result"):
            return PREV_HUB["result"]
        fields = ["HostName", "X_BT-COM_UserHostName", "PhysAddress", "Active", "IPAddress",
                  "WANStats.BytesSent", "WANStats.BytesReceived"]
        p = usp.hub_get(CFG["hub_host"], CFG["hub_password"], [
            "Device.DeviceInfo.UpTime", "Device.DeviceInfo.ModelName",
            "Device.PPP.Interface.1.ConnectionStatus", "Device.PPP.Interface.1.LastChange",
            "Device.PPP.Interface.1.IPCP.LocalIPAddress",
            "Device.PPP.Interface.1.Stats.BytesReceived", "Device.PPP.Interface.1.Stats.BytesSent",
        ] + [f"Device.Hosts.Host.*.{f}" for f in fields])
        now = time.time()
        hosts = usp.by_instance(p, "Device.Hosts.Host.")
        rx = int(p.get("Device.PPP.Interface.1.Stats.BytesReceived") or 0)
        tx = int(p.get("Device.PPP.Interface.1.Stats.BytesSent") or 0)
        rate_down = rate_up = None
        per_dev = {}
        if prev and now > prev["ts"]:
            dt = now - prev["ts"]
            if rx >= prev["rx"] and tx >= prev["tx"]:
                rate_down, rate_up = (rx - prev["rx"]) * 8 / dt, (tx - prev["tx"]) * 8 / dt  # bits/s
                THROUGHPUT.append((now, rate_down, rate_up))
        totals = {h.get("PhysAddress", "").lower(): (int(h.get("WANStats.BytesReceived") or 0), int(h.get("WANStats.BytesSent") or 0))
                  for h in hosts.values()}
        # the hub only refreshes per-device counters about once a minute, so compare against a snapshot >=55s old
        base = next((sn for sn in HOST_SNAPS if now - sn[0] >= 55), None) if HOST_SNAPS else None
        if base is None and HOST_SNAPS:
            base = HOST_SNAPS[0]
        if base and now > base[0]:
            dt = now - base[0]
            for mac, (d1, u1) in totals.items():
                old = base[1].get(mac)
                if old:
                    per_dev[mac] = (max(d1 - old[0], 0) * 8 / dt, max(u1 - old[1], 0) * 8 / dt)
        HOST_SNAPS.append((now, totals))
        while len(HOST_SNAPS) > 2 and now - HOST_SNAPS[1][0] >= 55:   # keep just enough history for the window
            HOST_SNAPS.popleft()
        devices = []
        for h in hosts.values():
            if h.get("Active") != "1":
                continue
            mac = h.get("PhysAddress", "").lower()
            d, u = per_dev.get(mac, (0.0, 0.0))
            devices.append({"name": _host_name(h, mac), "down": d, "up": u, "rate": d + u, "ip": h.get("IPAddress", "")})
        devices.sort(key=lambda x: (-x["rate"], x["name"].lower()))
        PREV_HUB["snap"] = {"ts": now, "rx": rx, "tx": tx, "hosts": {
            h.get("PhysAddress", "").lower(): (int(h.get("WANStats.BytesReceived") or 0), int(h.get("WANStats.BytesSent") or 0))
            for h in hosts.values()}}
        result = {
            "model": p.get("Device.DeviceInfo.ModelName", ""),
            "uptime": int(p.get("Device.DeviceInfo.UpTime") or 0),
            "broadband": p.get("Device.PPP.Interface.1.ConnectionStatus", "?"),
            "connected_for": int(p.get("Device.PPP.Interface.1.LastChange") or 0),
            "public_ip": p.get("Device.PPP.Interface.1.IPCP.LocalIPAddress", ""),
            "online": len(devices), "known": len(hosts),
            "rate_down": rate_down, "rate_up": rate_up,
            "busiest": [x for x in devices if x["rate"] > 0][:3],
            "devices": devices, "sampled": now,
        }
        PREV_HUB["result"] = result
        put("hub", result)
        return result


@every(60, "hub")
def collect_hub():
    if not W["router"]:
        return
    sample_hub(max_age=20)   # skip if the live view sampled very recently


def network_live():
    hub = sample_hub(max_age=4)
    cutoff = time.time() - 300
    with LOCK:
        lat = (STATE.get("latency") or {}).get("data") or {}
    with LOCK:
        ph = (STATE.get("pihole") or {}).get("data")
    return {
        "pihole": ph,
        "hub": hub,
        "throughput": [{"t": round(t), "down": d, "up": u} for t, d, u in THROUGHPUT if t >= cutoff],
        "latency": {"ms": lat.get("ms"), "history": lat.get("history", []), "internet": lat.get("internet"),
                    "services": lat.get("services", {})},
        "now": time.time(),
    }


# ---------------------------------------------------------------- http
# background music stations; relayed so the TV gets plain HTTP with no redirects
RADIO = {r["id"]: (r["name"], r["url"]) for r in C["radio"]}

NOTES_FILE = Path("/data/notices.json")
NOTES_LOCK = threading.Lock()


def notes_load():
    try:
        return json.loads(NOTES_FILE.read_text())
    except (OSError, ValueError):
        return []


def notes_active():
    now = time.time()
    return [n for n in notes_load() if not n.get("until") or n["until"] > now]


def notes_save(notes):
    now = time.time()
    keep = [n for n in notes if not n.get("until") or n["until"] > now - 86400]   # drop a day after expiry
    tmp = NOTES_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(keep, indent=1))
    tmp.replace(NOTES_FILE)


CLIENTS = {}   # ip -> last request (lets us confirm the TV is polling)


class Handler(BaseHTTPRequestHandler):
    server_version = "homedash"

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype, cache="no-cache"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self):
        token = os.environ.get("HOMEDASH_TOKEN", "")
        return bool(token) and self.headers.get("X-Homedash-Token", "") == token

    def do_POST(self):
        url = urllib.parse.urlparse(self.path)
        if url.path != "/api/notices":
            return self.send(404, b"not found", "text/plain")
        if not self._authorised():
            return self.send(403, b"forbidden", "text/plain")
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("Content-Length") or 0), 20000)) or b"{}")
            text = str(body["text"]).strip()[:500]
            if not text:
                raise ValueError("empty")
        except (ValueError, KeyError, TypeError):
            return self.send(400, b"need {\"text\": ...}", "text/plain")
        until = body.get("until")
        hours = body.get("hours")
        now = time.time()
        note = {"id": uuid.uuid4().hex[:8], "text": text, "by": str(body.get("by") or "")[:40], "created": now,
                "until": float(until) if until else now + float(hours or 24) * 3600}
        with NOTES_LOCK:
            notes = notes_load()
            notes.append(note)
            notes_save(notes)
        return self.send(200, json.dumps(note).encode(), "application/json")

    def do_DELETE(self):
        url = urllib.parse.urlparse(self.path)
        if not url.path.startswith("/api/notices/"):
            return self.send(404, b"not found", "text/plain")
        if not self._authorised():
            return self.send(403, b"forbidden", "text/plain")
        nid = url.path.rsplit("/", 1)[-1]
        with NOTES_LOCK:
            notes = notes_load()
            keep = [] if nid == "all" else [n for n in notes if n["id"] != nid]
            notes_save(keep)
        return self.send(200, json.dumps({"removed": len(notes) - len(keep)}).encode(), "application/json")

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        CLIENTS[self.client_address[0]] = {"last": time.time(), "path": url.path,
                                           "ua": (self.headers.get("User-Agent") or "")[:120]}
        if url.path == "/api/clients":
            return self.send(200, json.dumps(CLIENTS).encode(), "application/json")
        if url.path == "/api/state":
            q = urllib.parse.parse_qs(url.query)
            try:   # ?today=YYYY-MM-DD lets us preview birthday / bin messages
                today = date.fromisoformat(q["today"][0])
            except (KeyError, ValueError):
                today = datetime.now(TZ).date()
            try:   # ?now=YYYY-MM-DDTHH:MM previews the kids' clubs line at a given time
                now_dt = datetime.fromisoformat(q["now"][0])
                today = now_dt.date()
            except (KeyError, ValueError):
                now_dt = datetime.now(TZ).replace(tzinfo=None)
                if "today" in q:
                    now_dt = datetime.combine(today, now_dt.time())
            extra = {"family": {"data": family.birthdays(today)}, "bins": {"data": bins_for(today)},
                     "notices": {"data": notes_active()},
                     "clubs": {"data": clubs.summary(now_dt, dated=SCHOOL_EVENTS.get("events"))}}
            try:
                extra["pier"] = {"data": pier_now()}
            except Exception as e:
                extra["pier"] = {"data": None, "error": str(e)}
            with LOCK:
                body = json.dumps({"server_time": time.time(), "today": today.isoformat(), **STATE, **extra}).encode()
            return self.send(200, body, "application/json")
        if url.path.startswith("/radio/"):
            station = RADIO.get(url.path.split("/")[2])
            if not station:
                return self.send(404, b"no such station", "text/plain")
            try:
                upstream = urllib.request.urlopen(urllib.request.Request(station[1], headers={"User-Agent": UA}), timeout=15)
            except Exception:
                return self.send(502, b"stream unavailable", "text/plain")
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            try:
                while True:
                    chunk = upstream.read(16384)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass   # listener went away
            finally:
                upstream.close()
            return
        if url.path == "/api/config":
            return self.send(200, json.dumps(public_config()).encode(), "application/json")
        if url.path == "/api/radio":
            return self.send(200, json.dumps({k: v[0] for k, v in RADIO.items()}).encode(), "application/json")
        if url.path == "/api/network/live":
            try:
                body = json.dumps(network_live()).encode()
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
            return self.send(200, body, "application/json")
        if url.path == "/qr":   # QR code (SVG) so a link shown on the TV can be opened on a phone
            target = urllib.parse.parse_qs(url.query).get("u", [""])[0]
            if not re.match(r"^https?://", target) or len(target) > 1000:
                return self.send(400, b"bad url", "text/plain")
            import io, segno
            buf = io.BytesIO()
            segno.make(target, error="m").save(buf, kind="svg", scale=6, border=2, dark="#0b0f17", light="#ffffff")
            return self.send(200, buf.getvalue(), "image/svg+xml", cache="max-age=86400")
        if url.path == "/api/pdfinfo":
            q = urllib.parse.parse_qs(url.query)
            try:
                body = json.dumps(pdfpages.info(q.get("u", [""])[0])).encode()
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
            return self.send(200, body, "application/json")
        if url.path == "/pdfpage":
            q = urllib.parse.parse_qs(url.query)
            try:
                data = pdfpages.page_jpeg(q.get("u", [""])[0], int(q.get("p", ["0"])[0]), min(int(q.get("w", ["1440"])[0]), 1800))
            except Exception:
                return self.send(404, b"no page", "text/plain")
            return self.send(200, data, "image/jpeg", cache="max-age=86400")
        if url.path == "/api/article":
            q = urllib.parse.parse_qs(url.query)
            try:
                body = json.dumps(reader.article(q.get("url", [""])[0], UA)).encode()
            except Exception as e:
                body = json.dumps({"error": str(e)}).encode()
            return self.send(200, body, "application/json")
        if url.path == "/newsimg":
            q = urllib.parse.parse_qs(url.query)
            try:
                data = news_image_bytes(q.get("u", [""])[0], min(int(q.get("w", ["480"])[0]), 960))
            except Exception:
                return self.send(404, b"no image", "text/plain")
            return self.send(200, data, "image/jpeg", cache="max-age=86400")
        if url.path.startswith("/bg/"):
            f = backgrounds.resolve(url.path)
            if not f:
                return self.send(404, b"not found", "text/plain")
            ctype = {".png": "image/png", ".webp": "image/webp"}.get(f.suffix.lower(), "image/jpeg")
            return self.send(200, f.read_bytes(), ctype, cache="max-age=604800")
        if url.path == "/img":
            q = urllib.parse.parse_qs(url.query)
            path = q.get("p", [""])[0]
            if not path.startswith("/library/"):
                return self.send(400, b"bad path", "text/plain")
            try:
                data = plex_image(path, int(q.get("w", ["300"])[0]), int(q.get("h", ["450"])[0]))
            except Exception:
                return self.send(502, b"plex image failed", "text/plain")
            return self.send(200, data, "image/jpeg", cache="max-age=86400")
        if url.path == "/favicon.ico":
            return self.send(204, b"", "image/x-icon", cache="max-age=86400")
        if url.path == "/health":
            return self.send(200, b"ok", "text/plain")
        ua = self.headers.get("User-Agent") or ""
        phone = bool(re.search(r"iPhone|iPod|Android.*Mobile|Mobile Safari|Windows Phone", ua)) and "SMART-TV" not in ua and "Tizen" not in ua
        if url.path in ("/m", "/m/", "/mobile"):
            rel = "mobile.html"
        elif url.path in ("/tv", "/tv/"):
            rel = "index.html"
        elif url.path in ("/", ""):
            rel = "mobile.html" if phone else "index.html"   # phones get the phone layout automatically
        else:
            rel = url.path.lstrip("/")
        f = (STATIC / rel).resolve()
        if STATIC.resolve() not in f.parents or not f.is_file():
            return self.send(404, b"not found", "text/plain")
        ctype = {".html": "text/html; charset=utf-8", ".js": "application/javascript", ".css": "text/css",
                 ".svg": "image/svg+xml", ".png": "image/png"}.get(f.suffix, "application/octet-stream")
        return self.send(200, f.read_bytes(), ctype)


if __name__ == "__main__":
    log.info("homedash on :%s for %s (%s, %s)", CFG["port"], CFG["place"], CFG["lat"], CFG["lon"])
    ThreadingHTTPServer(("0.0.0.0", CFG["port"]), Handler).serve_forever()
