"""Configuration: /config/config.toml (household, location, sources, widgets) + environment (secrets).

Every key has a default here, so a minimal config only needs what differs. Secrets (API tokens and
passwords) never go in config.toml - they come from environment variables (see .env.example).
"""
import copy, os, tomllib
from pathlib import Path

CONFIG_FILE = Path(os.environ.get("HOMEDASH_CONFIG", "/config/config.toml"))

DEFAULTS = {
    "household": {"title": "Home Dashboard", "greeting_name": "", "timezone": "Europe/London"},
    "location": {"name": "Home", "lat": 51.5, "lon": -0.12},
    "weather": {"warnings_feed": ""},   # e.g. a Met Office regional warnings RSS feed
    "widgets": {k: True for k in ("weather", "marine", "plex", "news", "apps", "solar", "network", "alerts", "music",
                                  "birthdays", "bins", "clubs", "events", "notes", "backgrounds", "notifications")},
    "marine": {"place": "", "lat": None, "lon": None, "onshore_from": 30, "onshore_to": 200, "fish": "irish-sea"},
    "news": {"feeds": [{"name": "BBC News", "url": "https://feeds.bbci.co.uk/news/rss.xml", "local": False, "short": "BBC"}]},
    "school": {"enabled": False, "name": "", "site": "", "platform": "swd", "newsletter_dates": True, "classes": {}, "max_age_days": 60},
    "events": {"radius_miles": 20, "near_towns": [], "eventbrite": [], "facebook_feeds": [],
               "discover_ni": {"enabled": False}, "visit_mgs": {"enabled": False}},
    "bins": {"enabled": False, "day": "Sunday", "anchor": "2026-01-04", "rotation": [["black"], ["blue", "brown"]],
             "labels": {"black": "Black bin", "blue": "Blue bin", "brown": "Brown bin", "green": "Green bin", "grey": "Grey bin"}},
    "family": [],
    "clubs": {"people": {}, "weekly": []},
    "network": {"router": "", "router_host": "192.168.1.254", "services": [], "names": {}},
    "plex": {"url": "http://127.0.0.1:32400"},
    "solar": {"provider": "solax", "api": "https://openapi-eu.solaxcloud.com"},
    "pihole": {"url": "http://127.0.0.1:8053"},
    "alerts": {"provider": "", "routes": [], "route_label": "", "places": [], "local_places": [], "town_roads": {},
               "power_route_km": 5, "power_home_km": 10},
    "backgrounds": {"commons_category": "", "priority_words": [], "skip_words": [], "target": 30},
    "apps": [],
    "radio": [],
    "tv": {"dashboard_url": ""},
}


def _merge(base, over):
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


def load(path=CONFIG_FILE):
    try:
        with open(path, "rb") as f:
            user = tomllib.load(f)
    except FileNotFoundError:
        user = {}
    return _merge(DEFAULTS, user)


C = load()


def secret(name):
    return os.environ.get(name, "")


def widgets():
    """Effective widget switches: enabled in config AND their prerequisites (credentials/config) present."""
    w = dict(C["widgets"])
    need = {
        "marine": C["marine"]["lat"] is not None,
        "plex": bool(secret("PLEX_TOKEN")),
        "solar": bool(secret("SOLAX_CLIENT_ID") and secret("SOLAX_CLIENT_SECRET")),
        "network": True,
        "alerts": bool(C["alerts"]["provider"]),
        "birthdays": bool(C["family"]),
        "bins": bool(C["bins"]["enabled"]),
        "clubs": bool(C["clubs"]["weekly"]) or bool(C["school"]["enabled"]),
        "events": bool(C["events"]["eventbrite"] or C["events"]["facebook_feeds"] or C["events"]["discover_ni"].get("enabled")
                       or C["events"]["visit_mgs"].get("enabled")),
        "notes": bool(secret("HOMEDASH_TOKEN")),
        "music": bool(C["radio"]),
        "apps": bool(C["apps"]),
        "backgrounds": True,
    }
    for k, ok in need.items():
        w[k] = bool(w.get(k)) and ok
    w["router"] = bool(C["network"]["router"]) and bool(secret("EE_HUB_PASSWORD"))
    w["pihole"] = bool(secret("PIHOLE_PASSWORD"))
    return w


def public():
    """The non-secret slice the web frontends need."""
    news_tabs = [{"label": f.get("short") or f["name"], "source": f["name"]} for f in C["news"]["feeds"]]
    if C["school"]["enabled"]:
        news_tabs.insert(1, {"label": C["school"]["name"], "source": C["school"]["name"]})
    for fb in C["events"]["facebook_feeds"]:
        news_tabs.append({"label": fb.get("short") or fb["name"], "source": fb["name"]})
    return {
        "household": C["household"], "location": {"name": C["location"]["name"]},
        "marine_place": C["marine"]["place"] or C["location"]["name"],
        "widgets": widgets(), "news_tabs": news_tabs,
        "local_sources": [f["name"] for f in C["news"]["feeds"] if f.get("local")] + [fb["name"] for fb in C["events"]["facebook_feeds"]]
                         + ([C["school"]["name"]] if C["school"]["enabled"] else []),
        "notify_sources": [fb["name"] for fb in C["events"]["facebook_feeds"]] + ([C["school"]["name"]] if C["school"]["enabled"] else []),
        "events_venue": (C["events"]["eventbrite"][0]["name"] if C["events"]["eventbrite"] else ""),
        "alerts_route_label": C["alerts"]["route_label"],
        "apps": C["apps"], "radio": [{"id": r["id"], "name": r["name"]} for r in C["radio"]],
    }
