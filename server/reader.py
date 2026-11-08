"""Fetch a news article and reduce it to title + paragraphs for the on-TV reader overlay."""
import html, re, time, urllib.parse, urllib.request
from collections import OrderedDict
from html.parser import HTMLParser

from config import C
_FEEDS = [f["url"] for f in C["news"]["feeds"]] + [C["school"]["site"]]
ALLOWED = tuple({urllib.parse.urlparse(u).hostname.removeprefix("www.") for u in _FEEDS if u}
                | {"bbc.co.uk", "bbc.com", "swdcache.b-cdn.net"})   # article/PDF hosts the reader may fetch
CACHE = OrderedDict()


class _Paras(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paras, self.title, self._buf, self._in_p, self._in_title, self._skip = [], "", [], 0, False, 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "nav", "footer", "aside", "figure", "form"):
            self._skip += 1
        elif tag == "p" and not self._skip:
            self._in_p += 1
            self._buf = []
        elif tag == "h1" and not self.title:
            self._in_title = True
            self._buf = []

    def handle_endtag(self, tag):
        if tag in ("script", "style", "nav", "footer", "aside", "figure", "form") and self._skip:
            self._skip -= 1
        elif tag == "p" and self._in_p:
            self._in_p -= 1
            text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            if len(text) > 40:
                self.paras.append(text)
        elif tag == "h1" and self._in_title:
            self._in_title = False
            self.title = re.sub(r"\s+", " ", "".join(self._buf)).strip()

    def handle_data(self, data):
        if (self._in_p or self._in_title) and not self._skip:
            self._buf.append(data)


BOILERPLATE = re.compile(r"(cookie|subscribe|sign up|newsletter|follow us|download the|copyright|all rights reserved|"
                         r"related topics|more on this story|share this|image source|getty images)", re.I)


def article(url, ua):
    host = urllib.parse.urlparse(url).hostname or ""
    if not any(host == d or host.endswith("." + d) for d in ALLOWED):
        raise ValueError("source not allowed")
    if url in CACHE:
        return CACHE[url]
    if urllib.parse.urlparse(url).path.lower().endswith(".pdf"):
        return {"title": "", "paragraphs": [], "pdf": url, "source": host.replace("www.", "")}
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    with urllib.request.urlopen(req, timeout=15) as r:
        doc = r.read().decode("utf-8", "replace")
    # pages that just embed a PDF (e.g. school newsletters): hand back the PDF to render as images
    pdf = re.search(r'(?:src|href|data)="([^"]+\.pdf)(?:[#?][^"]*)?"', doc, re.I)
    p = _Paras()
    p.feed(doc)
    paras = [html.unescape(x) for x in p.paras if not BOILERPLATE.search(x)][:40]
    out = {"title": html.unescape(p.title), "paragraphs": paras, "source": host.replace("www.", ""), "fetched": time.time()}
    if pdf and len(paras) < 3:
        out["pdf"] = urllib.parse.urljoin(url, html.unescape(pdf.group(1)))
    CACHE[url] = out
    while len(CACHE) > 40:
        CACHE.popitem(last=False)
    return out
