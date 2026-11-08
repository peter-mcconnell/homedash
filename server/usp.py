"""Minimal USP (TR-369) client for the EE Smart Hub Pro, over MQTT/websockets.

Same protocol as ~/.local/bin/eehub (hades): MQTT user "admin" + hub password, records sent to
/<serial>/usp/admin/request/reply-to=<%2F-encoded reply topic>. Read-only use here (Get only).
"""
import json, re, ssl, threading, time, urllib.request, uuid

import paho.mqtt.client as mqtt


def _varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n:
            return bytes(out)


def pb(num, val):
    if isinstance(val, int):
        return _varint(num << 3) + _varint(val)
    if isinstance(val, str):
        val = val.encode()
    return _varint(num << 3 | 2) + _varint(len(val)) + val


def unpb(buf):
    i, out = 0, {}

    def rv():
        nonlocal i
        v = s = 0
        while True:
            b = buf[i]; i += 1
            v |= (b & 0x7F) << s; s += 7
            if not b & 0x80:
                return v
    while i < len(buf):
        key = rv()
        num, wt = key >> 3, key & 7
        if wt == 0:
            v = rv()
        elif wt == 2:
            ln = rv(); v = buf[i:i + ln]; i += ln
        elif wt == 5:
            v = int.from_bytes(buf[i:i + 4], "little"); i += 4
        elif wt == 1:
            v = int.from_bytes(buf[i:i + 8], "little"); i += 8
        else:
            raise ValueError(f"wire type {wt}")
        out.setdefault(num, []).append(v)
    return out


def first(d, n, default=None):
    return d.get(n, [default])[0]


def _s(b):
    return b.decode(errors="replace") if isinstance(b, (bytes, bytearray)) else (b or "")


class HubError(Exception):
    pass


def hub_get(host, password, paths, timeout=20):
    """One-shot: connect, USP Get the paths, disconnect. Returns {param_path: value}."""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    serial = json.load(urllib.request.urlopen(f"https://{host}/config.json", context=ctx, timeout=10))["SerialNumber"]
    device_id = str(uuid.uuid4())
    reply_topic = f"/{serial}/usp/admin/reply-to/{device_id}"
    request_topic = f"/{serial}/usp/admin/request/reply-to=" + reply_topic.replace("/", "%2F")
    mid = str(uuid.uuid4())
    msg = pb(1, pb(1, mid) + pb(2, 1)) + pb(2, pb(1, pb(1, b"".join(pb(1, p) for p in paths))))
    record = pb(1, "1.0") + pb(2, f"os::012345-{serial}") + pb(3, "usp-gui-admin") + pb(7, pb(2, msg))

    state = {"rc": None, "body": None}
    connected, answered = threading.Event(), threading.Event()

    def on_connect(c, u, flags, rc, props=None):
        state["rc"] = rc.value if hasattr(rc, "value") else rc
        if state["rc"] == 0:
            c.subscribe(reply_topic, qos=1)
        connected.set()

    def on_subscribe(c, u, m, rcs, props=None):
        c.publish(request_topic, record, qos=1)

    def on_message(c, u, m):
        try:
            rec = unpb(m.payload)
            body_msg = unpb(first(unpb(first(rec, 7)), 2))
            if _s(first(unpb(first(body_msg, 1)), 1)) == mid:
                state["body"] = unpb(first(body_msg, 2))
                answered.set()
        except Exception:
            pass

    c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"gui-{device_id}",
                    transport="websockets", protocol=mqtt.MQTTv311)
    c.ws_set_options(path="/ws")
    c.tls_set_context(ctx)
    c.tls_insecure_set(True)
    c.username_pw_set("admin", password)
    c.on_connect, c.on_subscribe, c.on_message = on_connect, on_subscribe, on_message
    c.connect(host, 443, keepalive=30)
    c.loop_start()
    try:
        if not connected.wait(10) or state["rc"] != 0:
            raise HubError(f"hub login failed ({state['rc']})")
        if not answered.wait(timeout):
            raise HubError("hub did not answer")
    finally:
        c.disconnect()
        c.loop_stop()

    body = state["body"]
    if 3 in body:
        e = unpb(first(body, 3))
        raise HubError(f"USP error {first(e, 1)}: {_s(first(e, 2))}")
    out = {}
    resp = unpb(first(body, 2))
    for rpr in unpb(first(resp, 1, b"")).get(1, []):
        r = unpb(rpr)
        for res in r.get(4, []):
            rs = unpb(res)
            base = _s(first(rs, 1))
            for ent in rs.get(2, []):
                m = unpb(ent)
                out[base + _s(first(m, 1, b""))] = _s(first(m, 2, b""))
    return out


def by_instance(params, prefix):
    out = {}
    rx = re.compile(re.escape(prefix) + r"(\d+)\.(.+)$")
    for k, v in params.items():
        if m := rx.match(k):
            out.setdefault(int(m[1]), {})[m[2]] = v
    return out
