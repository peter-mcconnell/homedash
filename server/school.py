"""Dated school events parsed from a school's newsletter PDFs ("DATE REMINDER" box on page 1).

Built for schools on the "School Website Design" (swd) platform: newsletters are posted under /news/
with an embedded PDF. Configure [school] site + name in config.toml."""
import json, re, time, urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

import pdfpages, reader
from config import C

SITE = C["school"]["site"].rstrip("/")
CACHE = Path("/data/school_events.json")
MAX_AGE = 24 * 3600
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
MONTHS = {m: i for i, m in enumerate(["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST",
                                       "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"], 1)}
LINE = re.compile(r"^(\d{1,2})(?:st|nd|rd|th)?(?:\s*[–-]\s*(\d{1,2})(?:st|nd|rd|th)?)?\s+(.+)$", re.I)
KEEP_UPPER = re.compile(r"^(KPS|P[1-7]|PE|PTA|STEM|ICT|SEN|NHS|@)$")


def tidy(text):
    """'P6 – VISIT TITANIC MUSEUM, BELFAST' -> 'P6 – Visit Titanic Museum, Belfast'"""
    text = re.sub(r"\s+", " ", text).strip(" -–")
    words = []
    for w in text.split(" "):
        core = re.sub(r"[^\w@]", "", w)
        if KEEP_UPPER.match(core) or re.match(r"^\d", core):
            words.append(w.replace("AM", "am").replace("PM", "pm").replace("NOON", "noon"))
        else:
            words.append(w.capitalize() if w.isupper() else w)
    return " ".join(words)


def _year_for(month, today):
    # newsletters cover the coming months; pick the year that puts the date nearest to now
    best = None
    for y in (today.year - 1, today.year, today.year + 1):
        d = date(y, month, 1)
        if best is None or abs((d - today).days) < abs((best - today).days):
            best = d
    return best.year


def parse_pdf(pdf_url, today=None):
    today = today or date.today()
    doc = pdfpages._doc(pdf_url)
    page = doc[0]
    w = page.rect.width
    lines = []
    for b in sorted(page.get_text("blocks"), key=lambda b: b[1]):
        if b[0] < w / 2:
            lines.extend(l.strip() for l in b[4].splitlines() if l.strip())
    events, month, started = [], None, False
    for line in lines:
        up = line.upper()
        if "DATE REMINDER" in up:
            started = True
            continue
        if not started:
            continue
        if up.strip() in MONTHS:
            month = MONTHS[up.strip()]
            continue
        m = LINE.match(line)
        if month and m:
            d1 = int(m.group(1))
            d2 = int(m.group(2)) if m.group(2) else d1
            text = tidy(m.group(3))
            classes = re.findall(r"\bP([1-7])\b", m.group(3).upper())
            year = _year_for(month, today)
            try:
                start, end = date(year, month, d1), date(year, month, d2)
            except ValueError:
                continue
            events.append({"start": start.isoformat(), "end": end.isoformat(), "what": text,
                           "classes": ["P" + c for c in classes]})
        elif month and events and not m and len(line) > 30:
            break   # left the date box (next section heading/paragraph)
    return events


def newsletter_pdfs(limit=2):
    with urllib.request.urlopen(urllib.request.Request(SITE + "/news/", headers={"User-Agent": UA}), timeout=20) as r:
        page = r.read().decode("utf-8", "replace")
    links = []
    for href, title in re.findall(r'class="listItemTitle"><a href="([^"]+)">([\s\S]*?)</a>', page):
        if "newsletter" in title.lower():
            links.append(SITE + href.split("?")[0])
    pdfs = []
    for link in links[:limit]:
        a = reader.article(link, UA)
        if a.get("pdf"):
            pdfs.append(a["pdf"])
    return pdfs


def cached(force=False):
    try:
        c = json.loads(CACHE.read_text())
        if not force and time.time() - c["fetched"] < MAX_AGE:
            return c["events"]
    except (OSError, ValueError, KeyError):
        c = None
    try:
        events, seen = [], set()
        for pdf in newsletter_pdfs():
            for e in parse_pdf(pdf):
                key = (e["start"], e["what"])
                if key not in seen:
                    seen.add(key)
                    events.append(e)
    except Exception:
        if c:
            return c["events"]
        raise
    CACHE.write_text(json.dumps({"fetched": time.time(), "events": events}))
    return events
