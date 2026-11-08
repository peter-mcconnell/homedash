"""Family birthdays from config.toml [[family]]: name, dob (YYYY-MM-DD), optional display name and show_age."""
from datetime import date

from config import C

UPCOMING_DAYS = 45


def load():
    return C["family"]


def _birthday_in(year, dob):
    try:
        return dob.replace(year=year)
    except ValueError:  # 29 Feb in a non-leap year
        return date(year, 2, 28)


def ordinal(n):
    suffix = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def birthdays(today, people=None):
    people = load() if people is None else people
    todays, upcoming = [], []
    for p in people:
        try:
            dob = date.fromisoformat(p["dob"])
        except (KeyError, ValueError):
            continue
        nxt = _birthday_in(today.year, dob)
        if nxt < today:
            nxt = _birthday_in(today.year + 1, dob)
        age = nxt.year - dob.year
        show_age = p.get("show_age", age < 18)
        entry = {"name": p.get("display") or p["name"].split()[0], "full_name": p["name"], "date": nxt.isoformat(),
                 "days": (nxt - today).days, "age": age if show_age else None,
                 "ordinal": ordinal(age) if show_age else None}
        (todays if entry["days"] == 0 else upcoming).append(entry)
    upcoming.sort(key=lambda e: e["days"])
    return {
        "today": todays,
        "soon": [e for e in upcoming if e["days"] <= UPCOMING_DAYS],
        "next": upcoming[0] if upcoming else None,
    }
