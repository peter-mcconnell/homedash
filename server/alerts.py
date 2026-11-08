"""Travel and power warnings along configured routes (provider "ni": Northern Ireland sources).

Traffic: TrafficWatchNI's official RSS feeds (incidents, roadworks, events; NI trunk roads + Greater Belfast).
  Items have no coordinates, so relevance is by place names / road numbers on the routes.
Power: NIE Networks PowerCheck (/NIEPowerCheckerWebAPI/api/faults, the feed behind its public map).
  Fault points are Irish Grid (TM65) coordinates, converted to lat/lon and matched by distance to the routes.
"""
import html, json, math, re, urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime

from config import C

UA = "Mozilla/5.0 (X11; Linux x86_64) homedash/1.0"
_A = C["alerts"]
HOME = (C["location"]["lat"], C["location"]["lon"])
TWNI = "https://rss.trafficwatchni.com/trafficwatchni_{}_rss.xml"
NIE = "https://powercheck.nienetworks.co.uk/NIEPowerCheckerWebAPI/api/faults"

# config [[alerts.routes]]: name + points = [[lat, lon], ...] polylines between home and a regular destination
ROUTES = {r["name"]: [tuple(pt) for pt in r["points"]] for r in _A["routes"]}
PLACES = [p.lower() for p in _A["places"]]              # towns along the routes (TrafficWatchNI has no coordinates)
LOCAL = tuple(p.lower() for p in _A["local_places"])     # places counted as "near home"
ROADS = re.compile(r"\b([AMB])0*(\d+)\b", re.I)        # roadworks write A1 as "A0001"
CLEARED = re.compile(r"\b(re-?opened|cleared|now open|has been removed|incident over)\b", re.I)
# roads the routes actually use through each town (roadworks elsewhere in that town are ignored)
TOWN_ROADS = {t.lower(): set(r) for t, r in _A["town_roads"].items()}
POWER_ROUTE_KM, POWER_HOME_KM = float(_A["power_route_km"]), float(_A["power_home_km"])
PLACE_RE = {p: re.compile(r"\b" + re.escape(p) + r"\b") for p in PLACES}
CLEARED = re.compile(r"\b(re-?opened|cleared|now open|has been removed|incident over)\b", re.I)
LOCAL = ("kilkeel", "annalong", "ballymartin", "attical", "mourne", "newcastle")


def _get(url, timeout=20):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
        return r.read()


def _text(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


# ---------------------------------------------------------------- geometry
def irish_grid_to_latlon(e, n):
    """Inverse transverse Mercator for the Irish Grid (TM65 / Airy Modified). Datum shift to WGS84 (~50 m) ignored."""
    a, b, f0 = 6377340.189, 6356034.447, 1.000035
    lat0, lon0, e0, n0 = math.radians(53.5), math.radians(-8.0), 200000.0, 250000.0
    e2 = 1 - (b * b) / (a * a)
    nn = (a - b) / (a + b)
    lat, m = lat0, 0.0
    while True:
        lat = (n - n0 - m) / (a * f0) + lat
        m = b * f0 * ((1 + nn + 1.25 * nn ** 2 + 1.25 * nn ** 3) * (lat - lat0)
                      - (3 * nn + 3 * nn ** 2 + 2.625 * nn ** 3) * math.sin(lat - lat0) * math.cos(lat + lat0)
                      + (1.875 * nn ** 2 + 1.875 * nn ** 3) * math.sin(2 * (lat - lat0)) * math.cos(2 * (lat + lat0))
                      - (35 / 24) * nn ** 3 * math.sin(3 * (lat - lat0)) * math.cos(3 * (lat + lat0)))
        if abs(n - n0 - m) < 0.00001:
            break
    sl, cl, tl = math.sin(lat), math.cos(lat), math.tan(lat)
    nu = a * f0 / math.sqrt(1 - e2 * sl ** 2)
    rho = a * f0 * (1 - e2) / (1 - e2 * sl ** 2) ** 1.5
    eta2 = nu / rho - 1
    vii, viii = tl / (2 * rho * nu), tl / (24 * rho * nu ** 3) * (5 + 3 * tl ** 2 + eta2 - 9 * tl ** 2 * eta2)
    ix = tl / (720 * rho * nu ** 5) * (61 + 90 * tl ** 2 + 45 * tl ** 4)
    x, xi, xii = 1 / (cl * nu), 1 / (cl * nu) / (6 * nu ** 2) * (nu / rho + 2 * tl ** 2), 1 / (cl * 120 * nu ** 5) * (5 + 28 * tl ** 2 + 24 * tl ** 4)
    de = e - e0
    lat_r = lat - vii * de ** 2 + viii * de ** 4 - ix * de ** 6
    lon_r = lon0 + x * de - xi * de ** 3 + xii * de ** 5
    return math.degrees(lat_r), math.degrees(lon_r)


def km(p, q):
    r = 6371.0
    dlat, dlon = math.radians(q[0] - p[0]), math.radians(q[1] - p[1])
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(p[0])) * math.cos(math.radians(q[0])) * math.sin(dlon / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def km_to_route(p, line):
    best = 1e9
    for a, b in zip(line, line[1:]):   # sample each segment (fine at this scale)
        for i in range(21):
            t = i / 20
            best = min(best, km(p, (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)))
    return best


# ---------------------------------------------------------------- traffic
WORKS_DATES = re.compile(r"from (\d\d:\d\d) on \w+ (\d{1,2})\w* (\w+) (\d{4}) to (\d\d:\d\d) on \w+ (\d{1,2})\w* (\w+) (\d{4})", re.I)


SMALL = {"of", "the", "and", "to", "at", "on", "with", "in", "for"}


def _tidy(s):
    """'A1 HILLSBOROUGH BY-PASS (NORTH BOUND), LISBURN' -> 'A1 Hillsborough By-Pass (North Bound), Lisburn'"""
    out = []
    for i, w in enumerate(s.split()):
        core = re.sub(r"[^\w]", "", w)
        if re.match(r"^[AMBUC]\d+$", core) or not w.isupper():
            out.append(w)
        elif i and core.lower() in SMALL:
            out.append(w.lower())
        else:
            out.append(re.sub(r"[A-Za-z]+", lambda m: m.group(0).capitalize(), w))
    return re.sub(r"\s+,", ",", " ".join(out)).replace("Co Down", "Co. Down")


def headline(kind, title, closed):
    """Short, readable headline + an even shorter label for the header pill."""
    if kind == "roadworks":
        m = re.match(r"^[AMBUC]0*\d+,\s*(.*?)\s+-\s+([^,]+)", title)
        if m:
            where, what = _tidy(m.group(1)), m.group(2).strip()
            road = re.match(r"^([^,(]+)", where).group(1).strip()
            return f"{where} — {what}", f"{road}: {what.lower()}"
    parts = [p.strip() for p in title.split(" - ")]
    if len(parts) >= 2:
        road = parts[1]
        state = parts[2].split(",")[0] if len(parts) > 2 else ""
        return f"{road} — {state}, {parts[0]}" if state else f"{road}, {parts[0]}", f"{road} {state.lower() or 'incident'}"
    return title, title[:40]


def _works_window(desc):
    m = WORKS_DATES.search(desc)
    if not m:
        return None, None
    try:
        s = datetime.strptime(f"{m[2]} {m[3][:3]} {m[4]} {m[1]}", "%d %b %Y %H:%M")
        e = datetime.strptime(f"{m[6]} {m[7][:3]} {m[8]} {m[5]}", "%d %b %Y %H:%M")
        return s, e
    except ValueError:
        return None, None


def traffic(now):
    out, seen = [], set()
    for feed in ("incidents", "incidents_belfast", "events", "events_belfast", "roadworks", "roadworks_belfast"):
        try:
            root = ET.fromstring(_get(TWNI.format(feed)))
        except Exception:
            continue
        kind = "roadworks" if "roadworks" in feed else ("event" if "events" in feed else "incident")
        for it in root.iter("item"):
            guid = it.findtext("guid") or it.findtext("title")
            if guid in seen:
                continue
            seen.add(guid)
            title, desc = _text(it.findtext("title")), _text(it.findtext("description"))
            blob = f"{title} {desc}".lower()
            place_hits = [p for p in PLACES if PLACE_RE[p].search(blob)]
            road = ROADS.search(f"{title} {desc}")
            local = any(PLACE_RE[p].search(blob) for p in LOCAL)
            if kind == "roadworks":
                start, end = _works_window(desc)
                if not start or end < now or start > now + timedelta(hours=24):
                    continue   # only works on now or starting within a day
                # titles look like "A0002, NEWRY ROAD, WARRENPOINT - Lane closure, ..."
                m = re.match(r"^([AMBUC])0*(\d+),\s*[^,]*,\s*([^,-]+?)\s+-\s", title)
                if m:
                    cls, num, town = m.group(1).upper(), m.group(2), m.group(3).strip().lower()
                    town_hit = next((p for p in PLACES if PLACE_RE[p].search(town)), None)
                    local = any(PLACE_RE[p].search(town) for p in LOCAL)
                    if not town_hit:
                        continue
                    allowed = TOWN_ROADS.get(town_hit)
                    if not local and allowed is not None and (cls + num) not in allowed:
                        continue   # not one of the roads the routes use through this town
                    if not (local or cls in "AM"):
                        continue   # elsewhere: main roads only
                    place_hits = [town_hit]
                elif not (local or (road and place_hits)):
                    continue
            else:
                start = end = None
                if not place_hits or CLEARED.search(title):
                    continue   # incidents/events: must name a place on the route, and still be live
            try:
                posted = parsedate_to_datetime(it.findtext("pubDate")).astimezone().replace(tzinfo=None)
            except Exception:
                posted = None
            closed = bool(re.search(r"\bclosed?\b|closure", blob)) and "lane closure" not in blob
            head, short = headline(kind, title, closed)
            out.append({
                "kind": kind, "title": title, "headline": head, "short": short, "detail": desc[:400], "posted": posted.isoformat(timespec="minutes") if posted else None,
                "from": start.isoformat(timespec="minutes") if start else None, "to": end.isoformat(timespec="minutes") if end else None,
                "near_home": local, "closure": closed, "where": ", ".join(p.title() for p in place_hits[:3]),
                "severity": "high" if (closed and kind == "incident") or (local and kind == "incident") else ("medium" if kind == "incident" or closed else "low"),
            })
    order = {"high": 0, "medium": 1, "low": 2}
    out.sort(key=lambda a: (order[a["severity"]], not a["near_home"], a["kind"] != "incident"))
    return out


# ---------------------------------------------------------------- power
def power():
    d = json.loads(_get(NIE))
    out = []
    for o in d.get("outageMessage") or []:
        try:
            e, n = (float(x) for x in o["point"]["coordinates"].split(","))
            pos = irish_grid_to_latlon(e, n)
        except (KeyError, ValueError):
            continue
        route_km = min((km_to_route(pos, line) for line in ROUTES.values()), default=1e9)
        home_km = km(pos, HOME)
        if route_km > POWER_ROUTE_KM and home_km > POWER_HOME_KM:
            continue
        out.append({
            "kind": o.get("outageType") or "Fault", "postcodes": (o.get("postCode") or "").replace(";", ", ").strip(" ,"),
            "customers": int(o.get("numCustAffected") or 0), "started": o.get("startTime"), "restore": o.get("estRestoreTime"),
            "status": o.get("statusMessage") or "", "cause": o.get("causeMessage") or "", "updated": o.get("updatedTimeStamp"),
            "home_km": round(home_km, 1), "route_km": round(route_km, 1), "near_home": home_km <= POWER_HOME_KM,
            "severity": "high" if home_km <= POWER_HOME_KM else "medium",
        })
    out.sort(key=lambda a: a["home_km"])
    esc = d.get("escalationInfo") or {}
    return out, (esc.get("escalationMessage") or "").strip() if esc.get("escalated") else ""


def collect(now):
    errors = []
    try:
        t = traffic(now)
    except Exception as e:
        t, errors = [], errors + [f"traffic: {e}"]
    try:
        p, nie_msg = power()
    except Exception as e:
        p, nie_msg, errors = [], "", errors + [f"power: {e}"]
    alerts = [dict(a, category="traffic") for a in t] + [dict(a, category="power") for a in p]
    return {"traffic": t, "power": p, "nie_message": nie_msg, "errors": errors,
            "count": len(alerts), "urgent": sum(1 for a in alerts if a["severity"] == "high")}
