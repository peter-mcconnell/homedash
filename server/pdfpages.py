"""Render PDF pages (e.g. school newsletters) to JPEGs so the old TV browser can show them."""
import urllib.parse, urllib.request
from collections import OrderedDict

from config import C
_FEEDS = [f["url"] for f in C["news"]["feeds"]] + [C["school"]["site"]]
ALLOWED = tuple({urllib.parse.urlparse(u).hostname.removeprefix("www.") for u in _FEEDS if u}
                | {"bbc.co.uk", "bbc.com", "swdcache.b-cdn.net"})   # article/PDF hosts the reader may fetch
MAX_BYTES = 30 * 1024 * 1024
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
_docs, _pages = OrderedDict(), OrderedDict()


def _allowed(url):
    host = urllib.parse.urlparse(url).hostname or ""
    return any(host == h or host.endswith("." + h) for h in ALLOWED)


def _doc(url):
    import fitz   # PyMuPDF
    url = url.split("#", 1)[0]
    if not _allowed(url):
        raise ValueError("host not allowed")
    if url in _docs:
        _docs.move_to_end(url)
        return _docs[url]
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=30) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("pdf too large")
    doc = fitz.open(stream=data, filetype="pdf")
    _docs[url] = doc
    while len(_docs) > 4:
        _docs.popitem(last=False)
    return doc


def info(url):
    return {"pages": _doc(url).page_count}


def page_jpeg(url, n, width=1440):
    import fitz
    key = (url.split("#", 1)[0], n, width)
    if key in _pages:
        _pages.move_to_end(key)
        return _pages[key]
    doc = _doc(url)
    page = doc[max(0, min(n, doc.page_count - 1))]
    zoom = width / page.rect.width
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    data = pix.tobytes("jpeg", jpg_quality=80)
    _pages[key] = data
    while len(_pages) > 40:
        _pages.popitem(last=False)
    return data
