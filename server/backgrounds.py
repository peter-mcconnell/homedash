"""Background photos: the household's own photos (/data/photos) plus landscape photos from a
Wikimedia Commons category (config [backgrounds]), fetched slowly (Commons rate-limits bulk requests)
and cached in /data/commons.

Each Commons image keeps a .json sidecar with title, author and licence for on-screen attribution.
"""
import html, json, logging, os, random, re, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

log = logging.getLogger("homedash.bg")
DATA = Path("/data")
PHOTOS = DATA / "photos"
COMMONS = DATA / "commons"
STATE_FILE = COMMONS / "crawl.json"
from config import C

TARGET = int(C["backgrounds"]["target"])
UA = {"User-Agent": os.environ.get("COMMONS_UA", "homedash/1.0 (private home TV dashboard)")}
API = "https://commons.wikimedia.org/w/api.php?"
ROOT_CAT = C["backgrounds"]["commons_category"]
SKIP_WORDS = re.compile(r"sign|map|plaque|memorial|church|chapel|grave|interior|house|cottage|shop|street|road|car|bus|"
                        r"train|sheep|cow|dog|horse|people|portrait|bridge|gate|stile|museum|hotel|school|statue|power|pylon|"
                        r"cable|electric|fence|car.?park|toilet|sewage|pipe",
                        re.I)
PRIORITY = re.compile("|".join(map(re.escape, C["backgrounds"]["priority_words"])) or "(?!)", re.I)
OK_LICENCE = re.compile(r"^(CC BY|CC0|Public domain|PD)", re.I)


def _api(**p):
    p.update(format="json", maxlag=5)
    url = API + urllib.parse.urlencode(p)
    for _ in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            wait = int(e.headers.get("Retry-After") or 60)
            log.info("commons rate limit, sleeping %ss", wait)
            time.sleep(wait + 5)
    raise RuntimeError("commons keeps rate limiting")


def _strip(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def _thumb(url, width=1920):
    # https://upload.wikimedia.org/wikipedia/commons/a/ab/Name.jpg -> .../commons/thumb/a/ab/Name.jpg/1920px-Name.jpg
    url = url.split("?", 1)[0]   # Commons appends utm_* tracking parameters
    m = re.match(r"(https://upload\.wikimedia\.org/wikipedia/commons)/(\w/\w\w)/(.+)$", url)
    return f"{m[1]}/thumb/{m[2]}/{m[3]}/{width}px-{m[3]}" if m else url


def _load_state():
    try:
        return json.loads(STATE_FILE.read_text())
    except (OSError, ValueError):
        return {}


def _save_state(st):
    STATE_FILE.write_text(json.dumps(st))


def crawl_step():
    """Do one small unit of work toward TARGET Commons images. Returns True if more work remains."""
    COMMONS.mkdir(parents=True, exist_ok=True)
    have = list(COMMONS.glob("*.jpg"))
    if len(have) >= TARGET or not ROOT_CAT:
        return False
    st = _load_state()
    if "cats" not in st:
        subs = [c["title"] for c in _api(action="query", list="categorymembers", cmtitle=ROOT_CAT,
                                         cmtype="subcat", cmlimit=100)["query"]["categorymembers"]]
        subs.sort(key=lambda c: (not PRIORITY.search(c), c))
        st = {"cats": [ROOT_CAT] + subs, "cat_pos": 0, "titles": [], "pos": 0, "queue": []}
        _save_state(st)
        return True

    # 1. download a queued photo (skip it for good if it fails)
    if st.get("queue"):
        item = st["queue"].pop(0)
        _save_state(st)
        name = re.sub(r"[^\w.-]+", "_", item["title"][5:])[:120]
        dest = COMMONS / (name if name.lower().endswith(".jpg") else name + ".jpg")
        if not dest.exists():
            try:
                with urllib.request.urlopen(urllib.request.Request(_thumb(item["url"]), headers=UA), timeout=60) as r:
                    data = r.read()
                dest.write_bytes(data)
                dest.with_suffix(".json").write_text(json.dumps(item))
                log.info("commons: saved %s (%d/%d)", dest.name, len(have) + 1, TARGET)
            except urllib.error.HTTPError as e:
                if e.code == 429:   # rate limited / robot policy: put it back and let the loop back off
                    st["queue"].insert(0, item)
                    _save_state(st)
                    raise RuntimeError("commons rate limited downloads (429)")
                log.warning("commons: skipping %s: %s", item["title"], e)
            except Exception as e:
                log.warning("commons: skipping %s: %s", item["title"], e)
        return True

    # 2. evaluate the next batch of listed titles
    if st["pos"] < len(st["titles"]):
        batch = st["titles"][st["pos"]:st["pos"] + 50]
        st["pos"] += len(batch)
        r = _api(action="query", titles="|".join(batch), prop="imageinfo", iiprop="url|size|extmetadata",
                 iiextmetadatafilter="Artist|LicenseShortName|ObjectName")
        for pg in r.get("query", {}).get("pages", {}).values():
            ii = (pg.get("imageinfo") or [{}])[0]
            w, h = ii.get("width", 0), ii.get("height", 1)
            meta = ii.get("extmetadata", {})
            lic = meta.get("LicenseShortName", {}).get("value", "")
            if w >= 1920 and 1.4 <= w / h <= 2.1 and OK_LICENCE.search(lic):
                st["queue"].append({
                    "title": pg["title"], "url": ii["url"], "page": ii.get("descriptionurl", ""),
                    "name": _strip(meta.get("ObjectName", {}).get("value", "")) or pg["title"][5:].rsplit(".", 1)[0],
                    "artist": _strip(meta.get("Artist", {}).get("value", ""))[:60], "licence": lic,
                })
        _save_state(st)
        log.info("commons: evaluated %d/%d titles, %d queued", st["pos"], len(st["titles"]), len(st["queue"]))
        return True

    # 3. list the next category
    if st["cat_pos"] < len(st["cats"]):
        cat = st["cats"][st["cat_pos"]]
        for m in _api(action="query", list="categorymembers", cmtitle=cat, cmtype="file", cmlimit=500)["query"]["categorymembers"]:
            t = m["title"]
            if t.lower().endswith((".jpg", ".jpeg")) and not SKIP_WORDS.search(t) and t not in st["titles"]:
                st["titles"].append(t)
        st["cat_pos"] += 1
        _save_state(st)
        log.info("commons: listed %s (%d/%d), %d titles", cat, st["cat_pos"], len(st["cats"]), len(st["titles"]))
        return True
    return False


def listing():
    out = []
    PHOTOS.mkdir(parents=True, exist_ok=True)
    for f in sorted(PHOTOS.glob("*")):
        if f.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"):
            out.append({"url": "/bg/photos/" + urllib.parse.quote(f.name), "credit": "", "own": True})
    for f in sorted(COMMONS.glob("*.jpg")) if COMMONS.exists() else []:
        try:
            meta = json.loads(f.with_suffix(".json").read_text())
        except (OSError, ValueError):
            meta = {}
        name = re.sub(r"\s*-\s*geograph\.org\.uk.*$", "", meta.get("name", ""))
        credit = " · ".join(x for x in (name[:70], meta.get("artist", ""), meta.get("licence", "")) if x)
        out.append({"url": "/bg/commons/" + urllib.parse.quote(f.name), "credit": credit, "own": False})
    return out


def resolve(path):
    """Map /bg/<photos|commons>/<name> to a file inside DATA, or None."""
    parts = path.split("/", 3)
    if len(parts) != 4 or parts[2] not in ("photos", "commons"):
        return None
    f = (DATA / parts[2] / urllib.parse.unquote(parts[3])).resolve()
    return f if (DATA / parts[2]).resolve() in f.parents and f.is_file() else None
