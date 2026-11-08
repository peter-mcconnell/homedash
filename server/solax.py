"""SolaX solar + battery via the SolaX Developer Portal API (OAuth client credentials).

Sign conventions in the output:
  pv_w       panel power (DC, from the MPPT inputs)
  battery_w  + charging / - discharging
  grid_w     + importing from the grid / - exporting
  home_w     house consumption = inverter AC output + grid import - grid export
"""
import json, os, time, urllib.parse, urllib.request
from pathlib import Path

BASE = os.environ.get("SOLAX_API", "https://openapi-eu.solaxcloud.com")
HISTORY = Path("/data/solar_history.json")
_tok = {"value": None, "exp": 0}
_ids = {}


def _req(method, path, token=None, form=None, params=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(params) if params else "")
    data = urllib.parse.urlencode(form).encode() if form else None
    headers = {"Accept": "application/json"}
    if form:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = "bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers, method=method), timeout=20) as r:
        return json.load(r)


def token():
    if _tok["value"] and time.time() < _tok["exp"] - 3600:
        return _tok["value"]
    r = _req("POST", "/openapi/auth/oauth/token", form={
        "client_id": os.environ["SOLAX_CLIENT_ID"], "client_secret": os.environ["SOLAX_CLIENT_SECRET"],
        "grant_type": "client_credentials"})
    if r.get("code") != 0:
        raise RuntimeError(f"SolaX auth failed: {r.get('message')}")
    _tok["value"], _tok["exp"] = r["result"]["access_token"], time.time() + int(r["result"]["expires_in"])
    return _tok["value"]


def _call(path, **params):
    r = _req("GET", path, token=token(), params=params)
    if r.get("code") != 10000:
        if r.get("code") in (401, 10401):   # token revoked/expired early: retry once
            _tok["value"] = None
            r = _req("GET", path, token=token(), params=params)
        if r.get("code") != 10000:
            raise RuntimeError(f"SolaX {path}: {r.get('code')} {r.get('message')}")
    return r["result"]


def devices():
    if not _ids:
        for dtype, key in ((1, "inverter"), (2, "battery")):
            recs = _call("/openapi/v2/device/page_device_info", deviceType=dtype, businessType=1).get("records") or []
            if recs:
                _ids[key] = recs[0]["deviceSn"]
                _ids["plant"] = recs[0]["plantId"]
                if key == "inverter":
                    _ids["rated_kw"] = recs[0].get("ratedPower")
    return _ids


def now():
    ids = devices()
    inv = _call("/openapi/v2/device/realtime_data", snList=ids["inverter"], deviceType=1, businessType=1)[0]
    bat = (_call("/openapi/v2/device/realtime_data", snList=ids["battery"], deviceType=2, businessType=1) or [{}])[0] \
        if ids.get("battery") else {}
    plant = _call("/openapi/v2/plant/realtime_data", plantId=ids["plant"], businessType=1)
    ac = float(inv.get("acPower1") or 0) + float(inv.get("acPower2") or 0) + float(inv.get("acPower3") or 0)
    grid_export = float(inv.get("gridPower") or 0)          # SolaX: + export, - import
    mppt = inv.get("mpptMap") or {}
    strings = [float(mppt.get(f"MPPT{i}Power") or 0) for i in (1, 2, 3, 4) if f"MPPT{i}Power" in mppt]
    pv = float(inv.get("MPPTTotalInputPower") or sum(strings))
    daily_ac = float(plant.get("dailyYield") or 0)
    imported, exported = float(plant.get("dailyImported") or 0), float(plant.get("dailyExported") or 0)
    return {
        "time": inv.get("plantLocalTime") or plant.get("plantLocalTime"),
        "pv_w": round(pv), "strings_w": [round(s) for s in strings],
        "home_w": round(max(ac - grid_export, 0)),
        "grid_w": round(-grid_export),
        "battery_w": round(float(bat.get("chargeDischargePower") or 0)),
        "soc": bat.get("batterySOC"), "battery_kwh": bat.get("batteryRemainings"),
        "battery_health": bat.get("batterySOH"), "battery_temp": bat.get("batteryTemperature"),
        "battery_cycles": bat.get("batteryCycleTimes"),
        "inverter_temp": inv.get("inverterTemperature"), "rated_kw": ids.get("rated_kw"),
        "today": {
            "solar_kwh": float(inv.get("dailyYield") or daily_ac), "inverter_kwh": daily_ac,
            "imported_kwh": imported, "exported_kwh": exported,
            "charged_kwh": float(plant.get("dailyCharged") or 0), "discharged_kwh": float(plant.get("dailyDischarged") or 0),
            "consumption_kwh": round(daily_ac + imported - exported, 2),
        },
        "totals": {"solar_kwh": float(inv.get("totalYield") or 0), "imported_kwh": float(plant.get("totalImported") or 0),
                   "exported_kwh": float(plant.get("totalExported") or 0)},
    }


def record(sample, keep_hours=36):
    """Append a sample to the on-disk history (for today's charts) and return today's points."""
    try:
        hist = json.loads(HISTORY.read_text())
    except (OSError, ValueError):
        hist = []
    t = time.time()
    hist.append({"t": round(t), "pv": sample["pv_w"], "home": sample["home_w"], "grid": sample["grid_w"],
                 "bat": sample["battery_w"], "soc": sample["soc"]})
    hist = [h for h in hist if t - h["t"] < keep_hours * 3600]
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps(hist))
    return hist


def _hist(sn, dtype, start_ms, end_ms):
    return _call("/openapi/v2/device/history_data", snList=sn, deviceType=dtype, businessType=1,
                 startTime=start_ms, endTime=end_ms, timeInterval=5) or []


def backfill(day_start):
    """Fill today's chart history from SolaX's 5-minute history (the API allows 12h per request)."""
    from datetime import datetime
    ids = devices()
    now_ms = int(time.time() * 1000)
    rows = {}
    t = int(day_start * 1000)
    while t < now_ms:
        end = min(t + 12 * 3600 * 1000 - 1, now_ms)
        for r in _hist(ids["inverter"], 1, t, end):
            key = (r.get("plantLocalTime") or "")[:16]
            ac = sum(float(r.get(f"acPower{i}") or 0) for i in (1, 2, 3))
            g = float(r.get("gridPower") or 0)
            rows.setdefault(key, {}).update({"pv": round(float(r.get("MPPTTotalInputPower") or 0)),
                                             "home": round(max(ac - g, 0)), "grid": round(-g)})
        if ids.get("battery"):
            for r in _hist(ids["battery"], 2, t, end):
                key = (r.get("plantLocalTime") or "")[:16]
                rows.setdefault(key, {}).update({"bat": round(float(r.get("chargeDischargePower") or 0)), "soc": r.get("batterySOC")})
        t = end + 1
    pts = []
    for key, v in rows.items():
        try:
            ts = datetime.strptime(key, "%Y-%m-%d %H:%M").timestamp()
        except ValueError:
            continue
        if "pv" in v:
            pts.append(dict({"t": round(ts), "bat": 0, "soc": None}, **v))
    try:
        hist = json.loads(HISTORY.read_text())
    except (OSError, ValueError):
        hist = []
    seen = {h["t"] // 300 for h in hist}
    hist += [p for p in pts if p["t"] // 300 not in seen]
    hist.sort(key=lambda h: h["t"])
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps(hist))
    return len(pts)
