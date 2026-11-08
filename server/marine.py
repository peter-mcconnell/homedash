"""Tides (from Open-Meteo marine modelled sea level) and a pier-fishing guide for the Mourne coast.

Tide times are derived from a model, not port predictions: expect roughly ±20 minutes versus
official Annalong/Kilkeel tables.
"""
from datetime import datetime, timedelta

# Species commonly taken from piers/harbour walls on the Co. Down / Mourne coast.
# months = in season, best = peak months. Approximate — conditions vary year to year.
FISH = [
    {"name": "Mackerel", "months": [6, 7, 8, 9], "best": [7, 8], "tip": "Feathers or small spinners on the flood tide; shoals come and go fast."},
    {"name": "Pollack", "months": [4, 5, 6, 7, 8, 9, 10, 11], "best": [9, 10], "tip": "Soft plastics or spinners along the wall, best at dawn and dusk."},
    {"name": "Coalfish", "months": list(range(1, 13)), "best": [10, 11, 12, 1, 2], "tip": "Small lures or float-fished strip at dusk; the small 'glashan' shoal under the pier."},
    {"name": "Codling", "months": [10, 11, 12, 1, 2, 3], "best": [11, 12, 1], "tip": "Lugworm or peeler crab hard on the bottom, after dark on a big tide."},
    {"name": "Whiting", "months": [10, 11, 12, 1, 2], "best": [11, 12], "tip": "Mackerel strip or worm on a two-hook flapper after dark."},
    {"name": "Dogfish", "months": list(range(1, 13)), "best": [6, 7, 8, 9, 10], "tip": "Any fish bait on the bottom; reliable when nothing else is biting."},
    {"name": "Flounder", "months": [9, 10, 11, 12, 1, 2, 3, 4], "best": [10, 11, 12, 1], "tip": "Peeler crab or ragworm close in over sand, especially near the river mouth."},
    {"name": "Dab", "months": [10, 11, 12, 1, 2, 3], "best": [11, 12, 1], "tip": "Small hooks with lugworm over clean sand."},
    {"name": "Plaice", "months": [4, 5, 6, 7, 8, 9, 10], "best": [5, 6, 9], "tip": "Worm baits with beads over sand patches."},
    {"name": "Ballan wrasse", "months": [5, 6, 7, 8, 9, 10], "best": [6, 7, 8], "tip": "Crab or worm tight to the rocks and pier footings; strong tackle."},
    {"name": "Thornback ray", "months": [4, 5, 6, 7, 8, 9], "best": [5, 6], "tip": "Sandeel or mackerel cast out onto clean ground, evening tides."},
    {"name": "Conger eel", "months": [5, 6, 7, 8, 9, 10], "best": [7, 8, 9], "tip": "Big fish baits after dark among rough ground; heavy gear."},
    {"name": "Garfish", "months": [5, 6, 7, 8, 9], "best": [6, 7], "tip": "Float-fished mackerel strip near the surface."},
    {"name": "Grey mullet", "months": [6, 7, 8, 9], "best": [7, 8], "tip": "Bread flake and groundbait in the harbour; very shy biters."},
]


def in_season(month):
    out = []
    for f in FISH:
        if month in f["months"]:
            out.append({"name": f["name"], "best": month in f["best"], "tip": f["tip"]})
    out.sort(key=lambda f: (not f["best"], f["name"]))
    return out


def extrema(times, levels):
    """Find highs/lows in a 15-minute series, refining each turning point with a parabola fit."""
    events = []
    for i in range(1, len(levels) - 1):
        a, b, c = levels[i - 1], levels[i], levels[i + 1]
        if a is None or b is None or c is None:
            continue
        kind = "high" if b >= a and b > c else "low" if b <= a and b < c else None
        if not kind:
            continue
        denom = a - 2 * b + c
        off = 0.5 * (a - c) / denom if denom else 0.0           # fraction of a step
        t = times[i] + timedelta(minutes=15 * off)
        h = b - 0.25 * (a - c) * off
        if events and events[-1]["kind"] == kind and (t - events[-1]["dt"]).total_seconds() < 4 * 3600:
            continue  # ignore wobble on a flat top/bottom
        events.append({"kind": kind, "dt": t, "height": round(h, 2)})
    return events


def tides(marine_json, now):
    m = marine_json["minutely_15"]
    times = [datetime.fromisoformat(t) for t in m["time"]]
    levels = m["sea_level_height_msl"]
    ev = extrema(times, levels)
    future = [e for e in ev if e["dt"] > now]
    # current level and direction
    idx = max(0, min(len(times) - 2, int((now - times[0]).total_seconds() // 900)))
    rising = (levels[idx + 1] or 0) > (levels[idx] or 0)
    # 24h curve from 2h ago, for the chart
    start = max(0, idx - 8)
    curve = [{"t": times[i].strftime("%H:%M"), "v": levels[i]} for i in range(start, min(len(times), start + 26 * 4))]
    hr = m.get("hourly") or {}
    return {
        "rising": rising,
        "next_high": _fmt(next((e for e in future if e["kind"] == "high"), None)),
        "next_low": _fmt(next((e for e in future if e["kind"] == "low"), None)),
        "events": [_fmt(e) for e in future[:8]],
        "curve": curve,
        "now_index": idx - start,
    }


def _fmt(e):
    if not e:
        return None
    return {"kind": e["kind"], "time": e["dt"].strftime("%H:%M"), "day": e["dt"].strftime("%a"),
            "iso": e["dt"].isoformat(timespec="minutes"), "height": e["height"]}


from config import C

ONSHORE = (C["marine"]["onshore_from"], C["marine"]["onshore_to"])   # wind directions that blow onto the shore


def verdict(now, wind, waves, tide, pop_next3h, sunset):
    """Rough 'is it worth going to the pier' call from gusts, swell, rain and tide timing."""
    score, notes = 0, []
    gust = wind.get("gust") or 0
    onshore = ONSHORE[0] <= (wind.get("dir") or 0) <= ONSHORE[1]
    if gust < 18:
        score += 2; notes.append("light wind")
    elif gust < 28:
        score += 1; notes.append(f"breezy ({round(gust)} mph gusts)")
    else:
        notes.append(f"strong gusts ({round(gust)} mph)")
    if waves is not None:
        if waves < 0.8:
            score += 2; notes.append("calm sea")
        elif waves < 1.5:
            score += 1; notes.append(f"{waves:.1f} m swell" + (", onshore" if onshore else ""))
        else:
            notes.append(f"rough ({waves:.1f} m waves)")
    if pop_next3h is not None and pop_next3h < 40:
        score += 1
    elif pop_next3h is not None:
        notes.append(f"{pop_next3h}% chance of rain")
    window = None
    nh = tide.get("next_high")
    if nh:
        ht = datetime.fromisoformat(nh["iso"])
        start, end = ht - timedelta(hours=2), ht + timedelta(hours=2)
        window = f"{start:%H:%M}–{end:%H:%M}"
        if start <= now <= end:
            score += 1; notes.insert(0, "prime time around high water")
    level = "Good" if score >= 5 else "Fair" if score >= 3 else "Poor"
    return {"level": level, "notes": notes[:3], "window": window, "dusk": sunset}
