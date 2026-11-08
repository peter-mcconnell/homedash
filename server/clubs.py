"""Weekly kids' clubs from config.toml [clubs] (people colours + weekly entries), plus dated school items."""
from datetime import datetime, timedelta

from config import C

DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def load():
    people = dict(C["clubs"]["people"])
    people.setdefault("School", "#2dd4bf")
    return {"people": people, "clubs": C["clubs"]["weekly"], "school": {"classes": C["school"]["classes"]}}


def _at(day, hhmm):
    h, m = (int(x) for x in hhmm.split(":"))
    return datetime(day.year, day.month, day.day, h, m)


def _school_entries(cfg, day, now, dated):
    """School newsletter dates for `day`. Class-specific items go to the child in that class (others hidden)."""
    classes = (cfg.get("school") or {}).get("classes", {})
    by_class = {c: kid for kid, c in classes.items()}
    out = []
    for e in dated or []:
        if not (e["start"] <= day.isoformat() <= e.get("end", e["start"])):
            continue
        who = "School"
        if e.get("classes"):
            kids = [by_class[c] for c in e["classes"] if c in by_class]
            if not kids:
                continue
            who = kids[0]
        # all-day school items stop counting as "remaining" once school's out, so the evening looks ahead
        status = "allday" if now.date() < day or (now.date() == day and now.hour < 16) else "done"
        out.append({"who": who, "what": e["what"], "where": None, "note": None, "start": None, "end": None,
                    "colour": cfg.get("people", {}).get(who, "#2dd4bf"), "status": status, "school": True})
    return out


def _entries(cfg, day, now, dated=None):
    out = _school_entries(cfg, day, now, dated)
    for c in cfg.get("clubs", []):
        if c.get("day") != DAYS[day.weekday()]:
            continue
        e = {k: c.get(k) for k in ("who", "what", "where", "note", "start", "end")}
        e["colour"] = cfg.get("people", {}).get(c.get("who"), "#9aa4b6")
        if c.get("start") and c.get("end"):
            start, end = _at(day, c["start"]), _at(day, c["end"])
            if now >= end:
                e["status"] = "done"
            elif now >= start:
                e["status"] = "now"
            else:
                e["status"] = "upcoming"
                e["starts_in_min"] = int((start - now).total_seconds() // 60)
        else:  # no fixed time (e.g. Saturday match): treat as on all day
            e["status"] = "allday" if now.date() == day else "upcoming"
        out.append(e)
    out.sort(key=lambda e: (not e.get("school"), e.get("start") or "00:00"))
    return out


def summary(now, cfg=None, dated=None):
    cfg = load() if cfg is None else cfg
    today = now.date()
    t = _entries(cfg, today, now, dated)
    tomorrow = _entries(cfg, today + timedelta(days=1), now, dated)
    remaining = [e for e in t if e["status"] != "done"]
    week = []
    for i in range(7):
        d = today + timedelta(days=i)
        week.append({"day": DAYS[d.weekday()], "date": d.isoformat(), "clubs": _entries(cfg, d, now, dated)})
    return {"today": t, "tomorrow": tomorrow, "show": "today" if remaining else "tomorrow", "week": week,
            "people": cfg.get("people", {})}
