/* homedash TV dashboard — ES5 only (Tizen 3 ≈ Chrome 47). Reads /api/config once, then polls /api/state. */
(function () {
  "use strict";

  var BASE = window.HOMEDASH_API || "";
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var state = {};
  var CONF = { household: {}, widgets: {}, news_tabs: [], local_sources: [], notify_sources: [], apps: [], radio: [] }, W = {};
  var newsIdx = 0;
  var query = location.search.replace(/^\?/, "");   // e.g. ?today=2027-08-05 to preview birthdays

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function round(n) { return n == null ? "--" : Math.round(n); }
  function data(name) { return state[name] && state[name].data; }
  // Parse "YYYY-MM-DD[THH:MM]" as local time (old engines treat offset-less ISO strings inconsistently)
  function parseLocal(s) {
    var m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/.exec(s || "");
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(NaN);
  }
  function setStale(el, name, maxAge) {
    var s = state[name], stale = !s || !s.updated || (state.server_time - s.updated) > maxAge;
    if (stale) { el.classList.add("stale"); } else { el.classList.remove("stale"); }
  }
  function toast(msg) {
    var t = $("toast");
    t.innerHTML = esc(msg); t.className = "";
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.className = "hidden"; }, 3500);
  }
  function getJSON(url, cb) {
    var x = new XMLHttpRequest();
    x.open("GET", BASE + url, true);
    x.timeout = 15000;
    x.onload = function () { if (x.status === 200) { try { cb(JSON.parse(x.responseText)); } catch (e) { cb(null); } } else { cb(null); } };
    x.onerror = x.ontimeout = function () { cb(null); };
    x.send();
  }
  // Talk to the Tizen app shell (parent frame) for things only it can do: launch apps, exit.
  function shell(action, payload) {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ homedash: 1, action: action, payload: payload || null }), "*");
      return true;
    }
    return false;
  }

  /* ---------------- icons (inline SVG, 100x100 viewBox) ---------------- */
  var SUN = '<circle cx="50" cy="50" r="18" fill="#fbbf24"/><g stroke="#fbbf24" stroke-width="6" stroke-linecap="round">' +
    '<line x1="50" y1="12" x2="50" y2="22"/><line x1="50" y1="78" x2="50" y2="88"/><line x1="12" y1="50" x2="22" y2="50"/>' +
    '<line x1="78" y1="50" x2="88" y2="50"/><line x1="23" y1="23" x2="30" y2="30"/><line x1="70" y1="70" x2="77" y2="77"/>' +
    '<line x1="23" y1="77" x2="30" y2="70"/><line x1="70" y1="30" x2="77" y2="23"/></g>';
  var MOON = '<path d="M62 18a32 32 0 1 0 22 52A28 28 0 0 1 62 18z" fill="#cbd5e1"/>';
  function cloud(fill, dx, dy) {
    return '<g transform="translate(' + (dx || 0) + ',' + (dy || 0) + ')"><path d="M30 78h44a16 16 0 0 0 0-32 22 22 0 0 0-42-6 16 16 0 0 0-2 38z" fill="' + fill + '"/></g>';
  }
  function drops(color, kind) {
    if (kind === "snow") { return '<g fill="#e2e8f0"><circle cx="36" cy="90" r="4"/><circle cx="52" cy="94" r="4"/><circle cx="68" cy="90" r="4"/></g>'; }
    var s = '<g stroke="' + color + '" stroke-width="5" stroke-linecap="round">';
    if (kind === "drizzle") { return s + '<line x1="40" y1="86" x2="38" y2="92"/><line x1="58" y1="86" x2="56" y2="92"/></g>'; }
    return s + '<line x1="36" y1="84" x2="32" y2="96"/><line x1="52" y1="84" x2="48" y2="96"/><line x1="68" y1="84" x2="64" y2="96"/></g>';
  }
  function icon(kind, day) {
    var orb = day === false ? MOON : SUN, b;
    switch (kind) {
      case "clear": b = orb; break;
      case "partly": b = '<g transform="translate(-12,-14) scale(0.8)">' + orb + '</g>' + cloud("#cbd5e1", 4, 4); break;
      case "cloud": b = cloud("#64748b", -10, -8) + cloud("#cbd5e1", 4, 2); break;
      case "fog": b = cloud("#94a3b8", 0, -10) + '<g stroke="#94a3b8" stroke-width="5" stroke-linecap="round"><line x1="22" y1="82" x2="78" y2="82"/><line x1="30" y1="92" x2="70" y2="92"/></g>'; break;
      case "drizzle": b = cloud("#94a3b8", 0, -10) + drops("#60a5fa", "drizzle"); break;
      case "rain": b = cloud("#64748b", 0, -10) + drops("#3b82f6"); break;
      case "showers": b = '<g transform="translate(-12,-16) scale(0.7)">' + orb + '</g>' + cloud("#94a3b8", 4, -8) + drops("#3b82f6"); break;
      case "snow": b = cloud("#cbd5e1", 0, -10) + drops("", "snow"); break;
      case "thunder": b = cloud("#475569", 0, -12) + '<path d="M54 66 42 84h10l-6 14 16-20H52l6-12z" fill="#facc15"/>'; break;
      default: b = cloud("#cbd5e1");
    }
    return '<svg viewBox="0 0 100 100" width="100%" height="100%">' + b + '</svg>';
  }
  var FISH_ICON = '<svg viewBox="0 0 120 70"><path d="M8 35c18-24 52-30 78-12l22-16v56l-22-16C60 65 26 59 8 35z" fill="#38bdf8"/>' +
    '<circle cx="30" cy="31" r="4" fill="#0b0f17"/><path d="M48 20c6 8 6 22 0 30" stroke="#0369a1" stroke-width="4" fill="none"/></svg>';
  var CAKE = '<svg viewBox="0 0 100 100"><rect x="18" y="52" width="64" height="34" rx="6" fill="#f472b6"/>' +
    '<rect x="18" y="52" width="64" height="10" fill="#fde68a"/><rect x="47" y="30" width="6" height="22" fill="#93c5fd"/>' +
    '<path d="M50 14c6 7 6 12 0 15-6-3-6-8 0-15z" fill="#fbbf24"/><rect x="12" y="84" width="76" height="6" rx="3" fill="#e5e7eb"/></svg>';
  function arrow(deg, size) {   // small wind arrow pointing where the wind blows TO
    return '<svg viewBox="0 0 20 20" width="' + size + '" height="' + size + '" style="vertical-align:-2px"><g transform="rotate(' +
      ((deg + 180) % 360) + ' 10 10)"><path d="M10 2 15 12h-3.5v6h-3v-6H5z" fill="currentColor"/></g></svg>';
  }

  /* ---------------- clock, greeting, family, bins, events ---------------- */
  function tickClock() {
    var d = new Date();
    $("clock").innerHTML = pad(d.getHours()) + ":" + pad(d.getMinutes());
    $("date").innerHTML = DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()];
    var mins = d.getHours() * 60 + d.getMinutes();
    var night = mins >= 23 * 60 || mins < 6 * 60 + 30;
    if (night) { document.body.classList.add("night"); } else { document.body.classList.remove("night"); }
    renderHello();
  }
  function isoDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function niceDate(iso) {
    var d = parseLocal(iso);
    return DAYS[d.getDay()].slice(0, 3) + " " + d.getDate() + " " + MONTHS[d.getMonth()];
  }
  function renderHello() {
    var f = data("family"), h = new Date().getHours(), g = $("greeting");
    var hello = h < 12 ? "Good morning" : (h < 18 ? "Good afternoon" : "Good evening");
    if (f && f.today && f.today.length) {
      var names = [], i;
      for (i = 0; i < f.today.length; i++) {
        names.push((f.today[i].ordinal ? "Happy " + f.today[i].ordinal + " birthday, " : "Happy birthday, ") + esc(f.today[i].name) + "!");
      }
      g.className = "bday";
      g.innerHTML = CAKE + names.join(" ");
      confetti(true);
    } else {
      g.className = "";
      g.innerHTML = hello + (CONF.household.greeting_name ? ", " + esc(CONF.household.greeting_name) : "");
      confetti(false);
    }
    var line = "";
    if (f && f.soon && f.soon.length) {
      var s = f.soon[0];
      var what = esc(s.name) + "’s " + (s.ordinal ? s.ordinal + " " : "") + "birthday";
      line = '<span class="alert">' + what + "</span> " +
        (s.days === 1 ? "is tomorrow!" : "in " + s.days + " days") + ' <span class="muted">· ' + niceDate(s.date) + "</span>";
      if (f.soon[1] && f.soon[1].days <= 21) { line += ' <span class="muted">· then ' + esc(f.soon[1].name) + " in " + f.soon[1].days + " days</span>"; }
    }   // distant birthdays aren't shown in the header (they're in the week ahead when close)
    $("family-line").innerHTML = W.birthdays ? line : "";

    var b = data("bins"), bl = "";
    if (b) {
      var hr = new Date().getHours(), nowB = binDots(b.bins) + esc(b.label), nextB = binDots(b.following.bins) + esc(b.following.label);
      if (b.days === 0) {
        bl = (hr < 12 ? '<span class="alert">Bin day today:</span> ' : '<span class="muted">Today:</span> ') + nowB +
          ' <span class="muted">· next Sunday:</span> ' + nextB;
      } else if (b.days === 1 && hr >= 16) {
        bl = '<span class="alert">Put out tonight:</span> ' + nowB;
      } else {
        bl = '<span class="muted">' + (b.days === 1 ? "Tomorrow" : "Sunday") + ':</span> ' + nowB +
          ' <span class="muted">· then</span> ' + nextB;
      }
    }
    $("bins-line").innerHTML = W.bins ? bl : "";

    renderKids();
    var ev = data("events"), nb = data("nearby"), el = $("event-line"), line = "";
    headerEvent = null;
    var soonEv = null, cutoff = Date.now() + 36 * 3600000, qi;
    for (qi = 0; ev && ev.items && qi < ev.items.length && !soonEv; qi++) { if (parseLocal(ev.items[qi].start).getTime() <= cutoff) { soonEv = ev.items[qi]; } }
    if (soonEv) {
      var e0 = soonEv, when = parseLocal(e0.start);
      headerEvent = e0;
      line = '<span class="muted">' + esc(ev.venue) + ":</span> " + esc(e0.name) + ' <span class="muted">· ' +
        DAYS[when.getDay()].slice(0, 3) + " " + when.getDate() + " " + MONTHS[when.getMonth()].slice(0, 3) + " " +
        pad(when.getHours()) + ":" + pad(when.getMinutes()) + "</span>";
    } else if (nb && nb.items && nb.items.length) {
      var today = isoDate(new Date()), tmrw = isoDate(new Date(Date.now() + 86400000)), n0 = null, q;
      for (q = 0; q < nb.items.length && !n0; q++) { if (!nb.items[q].ongoing && nb.items[q].near) { n0 = nb.items[q]; } }
      for (q = 0; q < nb.items.length && !n0; q++) { if (!nb.items[q].ongoing) { n0 = nb.items[q]; } }
      n0 = n0 || nb.items[0];
      headerEvent = n0;
      var lbl = n0.start <= today ? "On today" : (n0.start === tmrw ? "Tomorrow" : niceDate(n0.start));
      line = '<span class="muted">' + lbl + " nearby:</span> " + esc(n0.name) + ' <span class="muted">· ' + esc(evPlace(n0.place)) +
        (nb.items.length > 1 ? " · +" + (nb.items.length - 1) + " more" : "") + "</span>";
    }
    if (!W.events) { line = ""; }
    el.innerHTML = line;
    if (line) { el.classList.add("focusable"); } else { el.classList.remove("focusable"); }
  }
  function binDots(bins) {
    var s = "", k;
    for (k = 0; k < bins.length; k++) { s += '<span class="bin ' + bins[k] + '"></span>'; }
    return s;
  }
  function clubTime(e) {
    if (e.school) { return ""; }
    if (!e.start) { return e.note ? "(" + esc(e.note) + ")" : ""; }
    function t(s) { var p = s.split(":"), h = +p[0], m = p[1]; return (h > 12 ? h - 12 : h) + (m !== "00" ? ":" + m : ""); }
    return t(e.start) + "–" + t(e.end) + (+e.end.split(":")[0] >= 12 ? "pm" : "am");
  }
  function kidChip(e) { return '<span class="kid" style="background:' + e.colour + '">' + esc(e.who) + "</span>"; }
  function renderKids() {
    if (!W.clubs) { return; }
    var c = data("clubs"), el = $("kids-line");
    if (!c) { el.innerHTML = ""; return; }
    var list = c.show === "today" ? c.today : c.tomorrow, parts = [], i;
    for (i = 0; i < list.length; i++) {
      var e = list[i], st = "";
      if (c.show === "today") {
        if (e.status === "now") { st = ' <span class="club-now">● now</span>'; }
        else if (e.status === "upcoming" && e.starts_in_min != null && e.starts_in_min <= 60) { st = ' <span class="club-soon">in ' + e.starts_in_min + " min</span>"; }
      }
      parts.push(kidChip(e) + '<span class="' + (e.status === "done" && c.show === "today" ? "club-done" : "") + '">' + esc(e.what) +
        "</span> " + '<span class="muted">' + clubTime(e) + (e.where && e.what.indexOf(e.where) < 0 ? " · " + esc(e.where) : "") + "</span>" + st);
    }
    el.innerHTML = '<span class="muted">' + (c.show === "today" ? "Today:" : "Tomorrow:") + "</span> " +
      (parts.length ? parts.join(' <span class="muted">·</span> ') : '<span class="muted">no clubs</span>');
  }
  var confettiOn = false, headerEvent = null;
  function confetti(on) {
    if (on === confettiOn) { return; }
    confettiOn = on;
    var c = $("confetti"), html = "", i, cols = ["#f472b6", "#fbbf24", "#60a5fa", "#4ade80", "#c084fc"];
    if (on) {
      for (i = 0; i < 40; i++) {
        html += '<i style="left:' + Math.round(Math.random() * 1900) + 'px;background:' + cols[i % 5] +
          ';-webkit-animation-delay:' + (Math.random() * 7).toFixed(1) + 's;animation-delay:' + (Math.random() * 7).toFixed(1) + 's"></i>';
      }
    }
    c.innerHTML = html;
  }

  /* ---------------- backgrounds ---------------- */
  var bgList = [], bgOrder = [], bgPos = 0, bgFront = "bg-a";
  function updateBackgrounds() {
    if (!W.backgrounds) { return; }
    var list = data("backgrounds") || [];
    if (list.length !== bgList.length) {
      bgList = list;
      bgOrder = [];
      for (var i = 0; i < list.length; i++) { bgOrder.push(i); }
      // own photos twice as often as Commons ones
      for (i = 0; i < list.length; i++) { if (list[i].own) { bgOrder.push(i); } }
      bgOrder.sort(function () { return Math.random() - 0.5; });
      if (!$(bgFront).classList.contains("show")) { nextBackground(); }
    }
  }
  function nextBackground() {
    if (!bgOrder.length || document.body.classList.contains("night")) { return; }
    var item = bgList[bgOrder[bgPos % bgOrder.length]];
    bgPos++;
    var img = new Image();
    img.onload = function () {
      var back = bgFront === "bg-a" ? "bg-b" : "bg-a";
      // cover 1920x1080 keeping proportions (computed here: the TV engine mishandles CSS min-size/transform tricks)
      var nw = img.naturalWidth || img.width, nh = img.naturalHeight || img.height, sc = Math.max(1920 / nw, 1080 / nh);
      var w = Math.ceil(nw * sc), h = Math.ceil(nh * sc);
      $(back).innerHTML = '<img src="' + BASE + item.url + '" alt="" style="width:' + w + "px;height:" + h + "px;left:" +
        Math.floor((1920 - w) / 2) + "px;top:" + Math.floor((1080 - h) / 2) + 'px">';
      $(back).classList.add("show");
      $(bgFront).classList.remove("show");
      bgFront = back;
      $("credit").innerHTML = item.credit ? "Photo: " + esc(item.credit) : "";
    };
    img.src = BASE + item.url;
  }

  /* ---------------- weather ---------------- */
  function upcomingHours(w, n) {
    var out = [], now = Date.now(), i;
    for (i = 0; i < w.hourly.length && out.length < n; i++) {
      if (parseLocal(w.hourly[i].time).getTime() >= now - 3600000) { out.push(w.hourly[i]); }
    }
    return out;
  }
  function renderWeather() {
    if (!W.weather) { return; }
    var w = data("weather");
    if (!w) { return; }
    var n = w.now;
    $("now-icon").innerHTML = icon(n.icon, n.day);
    $("now-temp").innerHTML = round(n.temp) + "°";
    $("now-label").innerHTML = esc(n.label);
    $("now-meta").innerHTML = "Feels " + round(n.feels) + "° · Humidity " + round(n.humidity) + "%";
    $("place").innerHTML = esc(w.place);
    var hrs = upcomingHours(w, 12), html = "", i;
    for (i = 0; i < hrs.length; i++) {
      var h = hrs[i];
      html += '<div class="hour"><div class="t">' + (i === 0 ? "Now" : pad(parseLocal(h.time).getHours())) + '</div>' +
        '<div class="ic">' + icon(h.icon, h.day) + '</div><div class="v">' + round(h.temp) + '°</div>' +
        '<div class="p">' + (h.pop >= 20 ? h.pop + "%" : "") + '</div>' +
        '<div class="w" style="color:' + windColour(h.gust) + '">' + arrow(h.dir, 14) + round(h.wind) + '</div></div>';
    }
    $("hourly").innerHTML = html;
    html = "";
    for (i = 1; i < w.daily.length && i <= 5; i++) {
      var d = w.daily[i], dd = parseLocal(d.date);
      html += '<div class="day"><div class="d">' + (i === 1 ? "Tomorrow" : DAYS[dd.getDay()].slice(0, 3)) + '</div>' +
        '<div class="ic">' + icon(d.icon, true) + '</div>' +
        '<div class="v">' + round(d.max) + '° <span class="lo">' + round(d.min) + '°</span></div>' +
        '<div class="w">' + esc(d.compass) + " " + round(d.wind) + "–" + round(d.gust) + ' mph</div>' +
        '<div class="p">' + (d.pop >= 20 ? d.pop + "% rain" : "") + '</div></div>';
    }
    $("daily").innerHTML = html;
    if (w.daily[0]) { $("sun").innerHTML = "Sunrise " + w.daily[0].sunrise + " · Sunset " + w.daily[0].sunset; }
    setStale($("weather"), "weather", 3600);
  }
  function windColour(mph) {
    if (mph < 13) { return "#60a5fa"; }
    if (mph < 25) { return "#4ade80"; }
    if (mph < 39) { return "#facc15"; }
    if (mph < 55) { return "#fb923c"; }
    return "#f87171";
  }
  function renderWarnings() {
    var ws = data("warnings") || [], el = $("warn");
    if (!ws.length) { el.className = "hidden"; return; }
    el.className = /red/i.test(ws[0].title) ? "red" : "";
    el.innerHTML = "⚠ " + esc(ws[0].title) + (ws.length > 1 ? " (+" + (ws.length - 1) + " more)" : "");
  }

  /* ---------------- wind & pier ---------------- */
  function renderPier() {
    if (!W.marine) { return; }
    var w = data("weather"), m = data("marine"), p = data("pier");
    if (w) {
      var wd = w.now.wind, rot = (wd.dir + 180) % 360, col = windColour(wd.gust), ticks = "", k;
      $("wind-speed").innerHTML = round(wd.speed);
      $("wind-gust").innerHTML = round(wd.gust);
      $("wind-from").innerHTML = "from the " + esc(wd.compass);
      $("wind-force").innerHTML = "Force " + wd.force + " · " + esc(wd.force_name);
      for (k = 0; k < 360; k += 30) {
        ticks += '<line x1="100" y1="12" x2="100" y2="' + (k % 90 === 0 ? 26 : 20) + '" stroke="#3b4558" stroke-width="3" transform="rotate(' + k + ' 100 100)"/>';
      }
      $("wind-dial").innerHTML = '<svg viewBox="0 0 200 200" width="100%" height="100%">' +
        '<circle cx="100" cy="100" r="92" fill="rgba(10,14,22,0.7)" stroke="#1e2636" stroke-width="4"/>' + ticks +
        '<g font-size="22" fill="#9aa4b6" text-anchor="middle" font-family="Arial">' +
        '<text x="100" y="50">N</text><text x="100" y="168">S</text><text x="160" y="108">E</text><text x="40" y="108">W</text></g>' +
        '<g transform="rotate(' + rot + ' 100 100)"><path d="M100 36 L116 84 L106 80 L106 150 L94 150 L94 80 L84 84 Z" fill="' + col + '"/></g></svg>';
    }
    if (m) {
      var nh = m.next_high, nl = m.next_low;
      $("tide-head").innerHTML =
        '<span class="muted">High water</span> <b>' + (nh ? nh.time : "–") + "</b>" +
        '<span class="muted">Low</span> <b>' + (nl ? nl.time : "–") + "</b>" +
        '<span class="muted">' + (m.rising ? "▲ rising" : "▼ falling") + (m.sea_temp != null ? " · sea " + round(m.sea_temp) + "°" : "") + "</span>";
      $("tide-chart").innerHTML = tideChart(m, 464, 92);
    }
    if (p) {
      var v = p.verdict, names = [], i;
      for (i = 0; i < p.fish.length && names.length < 6; i++) {
        names.push(p.fish[i].best ? "<b>" + esc(p.fish[i].name) + "</b>" : esc(p.fish[i].name));
      }
      $("fishing").innerHTML = '<div class="fish-head">' + FISH_ICON + '<span>Fishing</span><span class="pill ' + v.level + '">' + v.level + "</span>" +
        (v.window ? '<span class="muted" style="margin-left:12px;font-size:19px">best ' + v.window + "</span>" : "") + "</div>" +
        '<div class="fish-notes">' + esc(v.notes.join(" · ")) + "</div>" +
        '<div class="fish-list">In season: ' + names.join(", ") + "</div>";
    }
    setStale($("pier"), "marine", 7200);
  }
  function tideChart(m, W, H) {
    var c = m.curve, i, min = 99, max = -99;
    if (!c || !c.length) { return ""; }
    for (i = 0; i < c.length; i++) { if (c[i].v < min) { min = c[i].v; } if (c[i].v > max) { max = c[i].v; } }
    var span = (max - min) || 1, pts = [], step = W / (c.length - 1);
    function y(v) { return Math.round(H - 18 - (v - min) / span * (H - 40)); }
    function mins(t) { var p = t.split(":"); return +p[0] * 60 + +p[1]; }
    function refined(t) {   // use the parabola-refined event time when one is within 20 minutes
      for (var j = 0; j < (m.events || []).length; j++) {
        var d = Math.abs(mins(m.events[j].time) - mins(t)); if (Math.min(d, 1440 - d) <= 20) { return m.events[j].time; }
      }
      return t;
    }
    for (i = 0; i < c.length; i++) { pts.push(Math.round(i * step) + "," + y(c[i].v)); }
    var nx = Math.round(m.now_index * step), labels = "";
    for (i = 1; i < c.length - 1; i++) {
      var a = c[i - 1].v, b = c[i].v, d = c[i + 1].v;
      if ((b >= a && b > d) || (b <= a && b < d)) {
        var hi = b >= a;
        labels += '<text x="' + Math.min(W - 26, Math.max(26, Math.round(i * step))) + '" y="' + (hi ? y(b) - 6 : H - 2) +
          '" font-size="15" fill="' + (hi ? "#93c5fd" : "#64748b") + '" text-anchor="middle">' + refined(c[i].t) + "</text>";
      }
    }
    return '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">' +
      '<polygon points="0,' + H + " " + pts.join(" ") + " " + W + "," + H + '" fill="rgba(59,130,246,0.25)"/>' +
      '<polyline points="' + pts.join(" ") + '" fill="none" stroke="#60a5fa" stroke-width="3"/>' +
      '<line x1="' + nx + '" y1="0" x2="' + nx + '" y2="' + H + '" stroke="#fbbf24" stroke-width="2" stroke-dasharray="4,4"/>' +
      labels + "</svg>";
  }

  /* ---------------- plex ---------------- */
  function img(art, w, h) {
    return art ? '<img src="' + BASE + "/img?p=" + encodeURIComponent(art) + "&w=" + w + "&h=" + h + '">' : '<div class="ph"></div>';
  }
  function renderPlex() {
    if (!W.plex) { return; }
    var p = data("plex");
    if (!p) { return; }
    var html = "", i;
    if (p.playing.length) {
      $("plex-title").innerHTML = "Now playing";
      $("plex-meta").innerHTML = p.playing.length > 1 ? p.playing.length + " streams" : "";
      var small = p.playing.length > 1;
      for (i = 0; i < p.playing.length && i < 2; i++) {
        var s = p.playing[i];
        html += '<div class="np focusable' + (small ? " small" : "") + '" data-action="plexitem" data-list="playing" data-i="' + i + '">' + img(s.art, 300, 450) + '<div class="info">' +
          '<div class="title">' + esc(s.title) + '</div><div class="sub">' + esc(s.subtitle) + '</div>' +
          '<div class="who">' + esc(s.user) + " · " + esc(s.player) +
          (s.state === "paused" ? ' · <span class="paused">paused</span>' : "") + (s.transcode ? " · transcoding" : "") + '</div>' +
          '<div class="bar"><div style="width:' + Math.round(s.progress * 100) + '%"></div></div>' +
          (s.remaining_min != null ? '<div class="left">' + s.remaining_min + " min left</div>" : "") + "</div></div>";
      }
    } else {
      $("plex-title").innerHTML = "Plex · new";
      $("plex-meta").innerHTML = "nothing playing";
      html = '<div class="posters">';
      for (i = 0; i < 6 && i < p.recent.length; i++) {
        html += '<div class="poster focusable" data-action="plexitem" data-list="recent" data-i="' + i + '">' + img(p.recent[i].art, 272, 392) + '<div class="cap">' + esc(p.recent[i].title) + "</div></div>";
      }
      html += "</div>";
    }
    var keep = focused && focused.getAttribute("data-action") === "plexitem" ? focused.getAttribute("data-list") + focused.getAttribute("data-i") : null;
    $("plex-body").innerHTML = html;
    if (keep) {   // re-render replaced the focused poster; restore focus to its replacement
      var again = document.querySelector('[data-action="plexitem"][data-list="' + keep.replace(/\d+$/, "") + '"][data-i="' + keep.replace(/^\D+/, "") + '"]');
      if (again) { setFocus(again); }
    }
    setStale($("plex"), "plex", 120);
  }

  /* ---------------- news ---------------- */
  function newsImg(u, w) { return BASE + "/newsimg?u=" + encodeURIComponent(u) + "&w=" + w; }
  function newsItems() { var n = data("news"); return n && n.items ? n.items : []; }
  function srcLabel(source) {
    for (var i = 0; i < CONF.news_tabs.length; i++) { if (CONF.news_tabs[i].source === source) { return CONF.news_tabs[i].label; } }
    return source;
  }
  function srcTag(it) { return '<span class="src' + (it.local ? " local" : "") + '">' + esc(it.local ? it.source : srcLabel(it.source)) + "</span>"; }
  function renderNews() {
    if (!W.news) { return; }
    var items = newsItems();
    if (!items.length) { return; }
    var lead = items[newsIdx % items.length], pic = $("news-pic");
    if (lead.image) {
      var src = newsImg(lead.image, 480);
      if (pic.getAttribute("data-src") !== src) {   // preload, then swap, so it doesn't flash
        var im = new Image();
        im.onload = function () { pic.style.backgroundImage = "url('" + src + "')"; pic.setAttribute("data-src", src); pic.className = ""; };
        im.onerror = function () { pic.className = "none"; };
        im.src = src;
      }
    } else { pic.className = "none"; pic.removeAttribute("data-src"); }
    $("news-lead").innerHTML = '<span class="t">' + srcTag(lead) + esc(lead.title) + '</span><span class="s">' + esc(lead.summary) + "</span>";
    $("news-1").innerHTML = srcTag(items[(newsIdx + 1) % items.length]) + esc(items[(newsIdx + 1) % items.length].title);
    $("news-2").innerHTML = srcTag(items[(newsIdx + 2) % items.length]) + esc(items[(newsIdx + 2) % items.length].title);
    $("news-source").innerHTML = esc(CONF.news_tabs.map(function (t) { return t.label; }).join(" · "));
    setStale($("news"), "news", 3600);
  }
  function rotateNews() {
    var items = newsItems();
    if (!items.length || (focused && focused.id && focused.id.indexOf("news") === 0) || overlayOpen()) { return; }
    var el = $("news-lead");
    el.style.opacity = 0;
    setTimeout(function () { newsIdx = (newsIdx + 1) % items.length; renderNews(); el.style.opacity = 1; }, 600);
  }

  /* ---------------- network ---------------- */
  function rate(bps) {
    if (bps == null) { return "–"; }
    if (bps >= 1e9) { return (bps / 1e9).toFixed(1) + " Gb/s"; }
    if (bps >= 1e6) { return (bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1) + " Mb/s"; }
    if (bps >= 1e3) { return Math.round(bps / 1e3) + " kb/s"; }
    return Math.round(bps) + " b/s";
  }
  function spark(hist) {
    var pts = [], i, max = 20, n = hist.length;
    for (i = 0; i < n; i++) { if (hist[i] != null && hist[i] > max) { max = hist[i]; } }
    for (i = 0; i < n; i++) {
      var v = hist[i] == null ? max : hist[i];
      pts.push(Math.round(i / Math.max(n - 1, 1) * 140) + "," + Math.round(44 - v / max * 40));
    }
    return '<svg id="spark" viewBox="0 0 140 46" preserveAspectRatio="none"><polyline points="' + pts.join(" ") + '" fill="none" stroke="#22c55e" stroke-width="3"/></svg>';
  }
  function dur(s) {
    var d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600);
    return d ? d + "d " + h + "h" : h + "h " + Math.floor(s % 3600 / 60) + "m";
  }
  function renderNet() {
    if (!W.network) { return; }
    var hub = data("hub"), lat = data("latency"), html = "";
    if (!hub && !lat) { return; }
    var up = lat ? lat.internet : (hub && hub.broadband === "Connected");
    html += '<div class="net-row">' +
      '<div class="net-stat"><div class="v"><span class="dot' + (up ? "" : " bad") + '"></span>' + (up ? "Online" : "OFFLINE") + '</div>' +
      '<div class="l">' + (hub ? "up " + dur(hub.connected_for) : "internet") + '</div></div>' +
      '<div class="net-stat"><div class="v">' + (lat && lat.ms != null ? Math.round(lat.ms) + " ms" : "–") + '</div><div class="l">' + (hub ? hub.online + " devices" : "latency") + "</div></div></div>";
    html += '<div class="net-row" style="margin-top:8px"><div class="net-stat"><div class="v" style="font-size:24px">↓ ' + rate(hub && hub.rate_down) +
      " &nbsp;↑ " + rate(hub && hub.rate_up) + '</div></div></div><div style="margin-top:6px">';
    if (lat) {
      for (var k in lat.services) {
        if (lat.services.hasOwnProperty(k)) { html += '<span class="svc"><span class="dot' + (lat.services[k] ? "" : " bad") + '"></span>' + esc(k) + "</span>"; }
      }
    }
    html += "</div>";
    var b = hub && hub.busiest;
    html += '<div class="net-foot">' + (b && b.length ? "Busiest: " + esc(b[0].name) + " (" + rate(b[0].down + b[0].up) + ")" : "&nbsp;") + "</div>";
    $("net-body").innerHTML = html;
    $("net-ip").innerHTML = hub ? esc(hub.public_ip) : "";
    setStale($("net"), "latency", 180);
  }

  /* ---------------- calm background music ---------------- */
  var STATIONS = [null];   // filled from config [[radio]]
  var stationIdx = 0, needsGesture = false;
  function store(k, v) { try { if (v === undefined) { return localStorage.getItem(k); } localStorage.setItem(k, v); } catch (e) {} return null; }
  function renderMusic() {
    var st = STATIONS[stationIdx], el = $("music-state");
    if (st && needsGesture) { el.className = ""; el.innerHTML = "♫ press OK"; }
    else if (st) { el.className = "on"; el.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>' + esc(st.name); }
    else { el.className = "muted"; el.innerHTML = "♫ music off"; }
  }
  function fade(a, to, ms, done) {
    var from = a.volume, t0 = Date.now();
    clearInterval(fade.timer);
    fade.timer = setInterval(function () {
      var f = Math.min(1, (Date.now() - t0) / ms);
      a.volume = Math.max(0, Math.min(1, from + (to - from) * f));
      if (f >= 1) { clearInterval(fade.timer); if (done) { done(); } }
    }, 60);
  }
  function playStation(idx) {
    var a = $("radio"), st = STATIONS[idx];
    stationIdx = idx;
    store("homedash.station", st ? st.id : "off");
    if (!st) { fade(a, 0, 800, function () { a.pause(); a.removeAttribute("src"); a.load(); }); needsGesture = false; renderMusic(); return; }
    a.src = BASE + "/radio/" + st.id + "?t=" + Date.now();
    a.volume = 0;
    var p = a.play();
    needsGesture = false;
    if (p && p["catch"]) { p["catch"](function () { needsGesture = true; renderMusic(); }); }
    fade(a, 0.35, 3000);
    renderMusic();
  }
  function startMusicIfWanted() {
    if (!W.music) { return; }
    var saved = store("homedash.station"), h = new Date().getHours(), idx = 1, i;   // default: the first configured station
    if (saved === "off") { idx = 0; }
    for (i = 1; i < STATIONS.length; i++) { if (STATIONS[i].id === saved) { idx = i; } }
    if (h >= 23 || h < 7) { idx = 0; }   // no autoplay at night
    if (idx) { playStation(idx); } else { renderMusic(); }
  }

  /* ---------------- solar ---------------- */
  var C_SOLAR = "#c98500", C_HOME = "#3987e5", C_GRID = "#d55181", C_SOC = "#199e70";   // validated (dataviz, dark)
  function watts(w) {
    if (w == null) { return "–"; }
    var a = Math.abs(w);
    return a >= 1000 ? (a / 1000).toFixed(a >= 10000 ? 0 : 1) + " kW" : Math.round(a) + " W";
  }
  function socColour(s) { return s >= 50 ? "#22c55e" : (s >= 20 ? "#eab308" : "#ef4444"); }
  function renderSolar() {
    if (!W.solar) { return; }
    var s = data("solar");
    if (!s) { $("solar-body").innerHTML = '<p class="muted" style="font-size:20px">Waiting for SolaX data…</p>'; return; }
    var bat = s.battery_w || 0, grid = s.grid_w || 0, t = s.today || {};
    function tile(colour, value, label) {
      return '<div class="sol"><div class="v">' + value + '</div><div class="l">' + (colour ? '<span class="k" style="background:' + colour + '"></span>' : "") + label + "</div></div>";
    }
    var html = '<div class="sol-row">' +
      tile(C_SOLAR, watts(s.pv_w), "Panels") +
      tile(C_HOME, watts(s.home_w), "House") +
      tile(null, (s.soc != null ? s.soc + "%" : "–"), bat > 20 ? "Charging" : (bat < -20 ? "Battery ↓" : "Battery")) +
      tile(C_GRID, grid ? watts(grid) : "0 W", grid > 20 ? "Importing" : (grid < -20 ? "Exporting" : "Grid")) + "</div>";
    html += '<div class="batbar"><div style="width:' + (s.soc || 0) + "%;background:" + socColour(s.soc || 0) + '"></div></div>';
    html += '<div class="sol-foot">' + (bat < -20 ? "Battery covering " + watts(-bat) + (s.battery_kwh != null ? " · " + s.battery_kwh + " kWh left" : "") :
      bat > 20 ? "Charging battery at " + watts(bat) : (s.pv_w > s.home_w ? "Panels covering the house" : "Battery idle")) + "</div>";
    $("solar-body").innerHTML = html;
    $("solar-today").innerHTML = "today " + (t.solar_kwh != null ? t.solar_kwh.toFixed(1) : "–") + " kWh made · " + (t.consumption_kwh != null ? t.consumption_kwh.toFixed(1) : "–") + " used";
    setStale($("solar"), "solar", 900);
  }
  function solarChartSvg(hist, W, H) {
    var L = 70, R = 140, T = 14, B = 34, pw = W - L - R, ph = H - T - B, i, max = 1000;
    if (hist.length < 2) { return '<p class="muted">Collecting today\'s readings — the chart fills in through the day.</p>'; }
    var d0 = new Date(hist[0].t * 1000); d0.setHours(0, 0, 0, 0);
    var t0 = d0.getTime() / 1000, t1 = t0 + 86400;
    for (i = 0; i < hist.length; i++) { max = Math.max(max, hist[i].pv, hist[i].home, Math.max(hist[i].grid, 0)); }
    max = Math.ceil(max / 1000) * 1000;
    function x(t) { return L + (t - t0) / (t1 - t0) * pw; }
    function y(v) { return T + ph - Math.max(0, v) / max * ph; }
    var g = "", k;
    for (k = 0; k <= 2; k++) {
      var gy = T + ph - ph * k / 2;
      g += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + pw) + '" y2="' + gy + '" stroke="rgba(255,255,255,' + (k ? 0.07 : 0.2) + ')"/>' +
        '<text x="' + (L - 10) + '" y="' + (gy + 6) + '" text-anchor="end" font-size="17" fill="#9aa4b6">' + (k ? (max * k / 2 / 1000).toFixed(1).replace(".0", "") + " kW" : "0") + "</text>";
    }
    for (k = 0; k <= 24; k += 6) {
      g += '<text x="' + x(t0 + k * 3600) + '" y="' + (H - 6) + '" font-size="17" fill="#9aa4b6" text-anchor="middle">' + pad(k % 24) + ":00</text>";
    }
    function path(key, sign) {
      var s = "", j;
      for (j = 0; j < hist.length; j++) { s += (j ? " L" : "M") + x(hist[j].t).toFixed(1) + " " + y(sign * hist[j][key]).toFixed(1); }
      return s;
    }
    var last = hist[hist.length - 1], ex = x(last.t), labels = [["pv", "Panels", C_SOLAR, 1], ["home", "House", C_HOME, 1], ["grid", "Grid in", C_GRID, 1]];
    var area = path("pv", 1) + " L" + ex.toFixed(1) + " " + (T + ph) + " L" + x(hist[0].t).toFixed(1) + " " + (T + ph) + " Z";
    var out = '<svg width="' + W + '" height="' + H + '">' + g + '<path d="' + area + '" fill="' + C_SOLAR + '" fill-opacity="0.18"/>';
    var ys = [];
    for (i = 0; i < labels.length; i++) {
      out += '<path d="' + path(labels[i][0], 1) + '" fill="none" stroke="' + labels[i][2] + '" stroke-width="2.5" stroke-linejoin="round"/>';
      ys.push(y(Math.max(last[labels[i][0]], 0)));
    }
    // direct end labels, spread so they don't collide
    var order = [0, 1, 2].sort(function (a, b) { return ys[a] - ys[b]; }), prev = -99;
    for (i = 0; i < order.length; i++) {
      var o = order[i], ly = Math.max(ys[o], prev + 24); prev = ly;
      out += '<circle cx="' + ex + '" cy="' + ys[o] + '" r="5" fill="' + labels[o][2] + '" stroke="#121826" stroke-width="2"/>' +
        '<text x="' + (ex + 12) + '" y="' + (ly + 6) + '" font-size="19" fill="#e9edf3">' + labels[o][1] + " " + watts(Math.max(last[labels[o][0]], 0)) + "</text>";
    }
    return out + "</svg>";
  }
  function socSvg(hist, W, H) {
    var L = 70, R = 140, T = 14, B = 34, pw = W - L - R, ph = H - T - B, i, s = "";
    if (hist.length < 2) { return ""; }
    var d0 = new Date(hist[0].t * 1000); d0.setHours(0, 0, 0, 0);
    var t0 = d0.getTime() / 1000;
    function x(t) { return L + (t - t0) / 86400 * pw; }
    function y(v) { return T + ph - v / 100 * ph; }
    var g = "";
    for (i = 0; i <= 100; i += 50) {
      g += '<line x1="' + L + '" y1="' + y(i) + '" x2="' + (L + pw) + '" y2="' + y(i) + '" stroke="rgba(255,255,255,' + (i ? 0.07 : 0.2) + ')"/>' +
        '<text x="' + (L - 10) + '" y="' + (y(i) + 6) + '" text-anchor="end" font-size="17" fill="#9aa4b6">' + i + "%</text>";
    }
    for (i = 0; i < hist.length; i++) { if (hist[i].soc != null) { s += (s ? " L" : "M") + x(hist[i].t).toFixed(1) + " " + y(hist[i].soc).toFixed(1); } }
    var last = hist[hist.length - 1];
    return '<svg width="' + W + '" height="' + H + '">' + g + '<path d="' + s + '" fill="none" stroke="' + C_SOC + '" stroke-width="2.5"/>' +
      '<text x="' + (x(last.t) + 12) + '" y="' + (y(last.soc || 0) + 6) + '" font-size="19" fill="#e9edf3">' + (last.soc != null ? last.soc + "%" : "") + "</text></svg>";
  }
  function solarDetailHtml() {
    var s = data("solar");
    if (!s) { return '<p class="muted">No SolaX data yet.</p>'; }
    var t = s.today || {}, hist = s.history || [];
    var selfUse = t.inverter_kwh ? Math.round((t.inverter_kwh - t.exported_kwh) / t.inverter_kwh * 100) : null;
    var fromSolar = t.consumption_kwh ? Math.round((t.consumption_kwh - t.imported_kwh) / t.consumption_kwh * 100) : null;
    return '<div class="ntiles">' +
      tile("Generated today", (t.solar_kwh || 0).toFixed(1) + " kWh") +
      tile("Used today", (t.consumption_kwh || 0).toFixed(1) + " kWh") +
      tile("Imported", (t.imported_kwh || 0).toFixed(1) + " kWh") +
      tile("Exported", (t.exported_kwh || 0).toFixed(1) + " kWh") +
      tile("Battery in / out", "+" + (t.charged_kwh || 0).toFixed(1) + " / −" + (t.discharged_kwh || 0).toFixed(1)) +
      tile("House from own power", fromSolar != null ? fromSolar + "%" : "–") + "</div>" +
      '<h3>Power today <span class="lg"><i style="background:' + C_SOLAR + '"></i>Panels <i style="background:' + C_HOME + '"></i>House <i style="background:' +
      C_GRID + '"></i>Grid import</span></h3>' + solarChartSvg(hist, 1440, 300) +
      "<h3>Battery charge</h3>" + socSvg(hist, 1440, 170) +
      '<p class="muted" style="font-size:19px">Battery ' + (s.soc != null ? s.soc + "%" : "–") + (s.battery_kwh != null ? " (" + s.battery_kwh + " kWh)" : "") +
      " · health " + (s.battery_health || "–") + "% · " + (s.battery_cycles || "–") + " cycles · " + (s.battery_temp != null ? s.battery_temp + "°C" : "") +
      " · inverter " + (s.inverter_temp != null ? s.inverter_temp + "°C" : "–") + (selfUse != null ? " · " + selfUse + "% of solar used at home" : "") +
      " · lifetime " + Math.round((s.totals || {}).solar_kwh || 0) + " kWh · last reading " + esc((s.time || "").slice(11, 16)) + "</p>";
  }

  /* ---------------- live network page ---------------- */
  var C_DOWN = "#3987e5", C_UP = "#d95926", C_LAT = "#199e70";   // validated (dataviz palette, dark slots 1-3)
  function niceMax(v) {
    var steps = [1e6, 2e6, 5e6, 1e7, 2e7, 5e7, 1e8, 2e8, 5e8, 1e9], i;
    for (i = 0; i < steps.length; i++) { if (v <= steps[i]) { return steps[i]; } }
    return v;
  }
  function tile(label, value, extra) {
    return '<div class="nt"><div class="nv">' + value + '</div><div class="nl">' + label + "</div>" + (extra || "") + "</div>";
  }
  function throughputSvg(pts, now, W, H) {
    var max = 0, i, L = 76, R = 150, T = 14, B = 34, pw = W - L - R, ph = H - T - B;
    for (i = 0; i < pts.length; i++) { max = Math.max(max, pts[i].down, pts[i].up); }
    max = niceMax(max || 1);
    function x(t) { return L + Math.max(0, Math.min(1, 1 - (now - t) / 300)) * pw; }
    function y(v) { return T + ph - v / max * ph; }
    var g = "", k;
    for (k = 0; k <= 2; k++) {   // recessive grid + axis labels
      var gy = T + ph - ph * k / 2;
      g += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + pw) + '" y2="' + gy + '" stroke="rgba(255,255,255,' + (k ? 0.07 : 0.2) + ')" stroke-width="1"/>' +
        '<text x="' + (L - 10) + '" y="' + (gy + 6) + '" text-anchor="end" font-size="17" fill="#9aa4b6">' + (k ? rate(max * k / 2).replace(".0 ", " ").replace("/s", "") : "0") + "</text>";
    }
    g += '<text x="' + L + '" y="' + (H - 6) + '" font-size="17" fill="#9aa4b6">5 min ago</text>' +
      '<text x="' + (L + pw) + '" y="' + (H - 6) + '" font-size="17" fill="#9aa4b6" text-anchor="end">now</text>';
    if (pts.length < 2) {
      return '<svg width="' + W + '" height="' + H + '">' + g + '<text x="' + (L + pw / 2) + '" y="' + (T + ph / 2) +
        '" font-size="22" fill="#9aa4b6" text-anchor="middle">Collecting samples…</text></svg>';
    }
    function path(key) {
      var s = "", j;
      for (j = 0; j < pts.length; j++) { s += (j ? " L" : "M") + x(pts[j].t).toFixed(1) + " " + y(pts[j][key]).toFixed(1); }
      return s;
    }
    var area = path("down") + " L" + x(pts[pts.length - 1].t).toFixed(1) + " " + (T + ph) + " L" + x(pts[0].t).toFixed(1) + " " + (T + ph) + " Z";
    var last = pts[pts.length - 1], ex = x(last.t);
    // direct labels at the line ends, nudged apart if they would collide
    var yd = y(last.down), yu = y(last.up);
    if (Math.abs(yd - yu) < 26) { if (yd <= yu) { yd -= 13; yu += 13; } else { yd += 13; yu -= 13; } }
    return '<svg width="' + W + '" height="' + H + '">' + g +
      '<path d="' + area + '" fill="' + C_DOWN + '" fill-opacity="0.16"/>' +
      '<path d="' + path("down") + '" fill="none" stroke="' + C_DOWN + '" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<path d="' + path("up") + '" fill="none" stroke="' + C_UP + '" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<circle cx="' + ex + '" cy="' + y(last.down) + '" r="5" fill="' + C_DOWN + '" stroke="#121826" stroke-width="2"/>' +
      '<circle cx="' + ex + '" cy="' + y(last.up) + '" r="5" fill="' + C_UP + '" stroke="#121826" stroke-width="2"/>' +
      '<text x="' + (ex + 14) + '" y="' + (yd + 7) + '" font-size="21" fill="#e9edf3">↓ ' + rate(last.down) + "</text>" +
      '<text x="' + (ex + 14) + '" y="' + (yu + 7) + '" font-size="21" fill="#e9edf3">↑ ' + rate(last.up) + "</text></svg>";
  }
  function latencySvg(hist, W, H) {
    var L = 56, R = 16, T = 14, B = 34, pw = W - L - R, ph = H - T - B, max = 40, i, s = "", n = hist.length;
    for (i = 0; i < n; i++) { if (hist[i] != null && hist[i] > max) { max = hist[i]; } }
    max = Math.ceil(max / 20) * 20;
    function y(v) { return T + ph - v / max * ph; }
    var g = "", k;
    for (k = 0; k <= 2; k++) {
      var gy = T + ph - ph * k / 2;
      g += '<line x1="' + L + '" y1="' + gy + '" x2="' + (L + pw) + '" y2="' + gy + '" stroke="rgba(255,255,255,' + (k ? 0.07 : 0.2) + ')"/>' +
        '<text x="' + (L - 8) + '" y="' + (gy + 6) + '" text-anchor="end" font-size="17" fill="#9aa4b6">' + Math.round(max * k / 2) + "</text>";
    }
    var gaps = "";
    for (i = 0; i < n; i++) {
      var px = L + (n > 1 ? i / (n - 1) : 1) * pw;
      if (hist[i] == null) { gaps += '<line x1="' + px + '" y1="' + T + '" x2="' + px + '" y2="' + (T + ph) + '" stroke="#e66767" stroke-width="3"/>'; continue; }
      s += (s ? " L" : "M") + px.toFixed(1) + " " + y(hist[i]).toFixed(1);
    }
    return '<svg width="' + W + '" height="' + H + '">' + g + gaps +
      '<path d="' + s + '" fill="none" stroke="' + C_LAT + '" stroke-width="2.5" stroke-linejoin="round"/>' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="17" fill="#9aa4b6">' + Math.round(n / 2) + ' min ago</text>' +
      '<text x="' + (L + pw) + '" y="' + (H - 6) + '" font-size="17" fill="#9aa4b6" text-anchor="end">now · ms</text></svg>';
  }
  function devicesHtml(devs) {
    var active = [], i, max = 0;
    for (i = 0; i < devs.length; i++) { if (devs[i].rate >= 1000) { active.push(devs[i]); max = Math.max(max, devs[i].rate); } }
    var html = "", W = 760;
    if (!active.length) { return '<p class="muted">No device is using the internet right now.</p>'; }
    for (i = 0; i < active.length && i < 8; i++) {
      var d = active[i], wd = Math.max(d.down > 0 ? 3 : 0, Math.round(d.down / max * W)), wu = Math.max(d.up > 0 ? 3 : 0, Math.round(d.up / max * W));
      html += '<div class="dev"><div class="dn">' + esc(d.name) + '</div><div class="db">' +
        (wd ? '<span style="width:' + wd + "px;background:" + C_DOWN + ';border-radius:4px 0 0 4px"></span>' : "") +
        (wu ? '<span style="width:' + wu + "px;background:" + C_UP + ";margin-left:2px;border-radius:0 4px 4px 0" + '"></span>' : "") +
        '</div><div class="dv">↓ ' + rate(d.down) + " &nbsp;↑ " + rate(d.up) + "</div></div>";
    }
    var idle = devs.length - Math.min(active.length, 8);
    return html + '<p class="muted" style="font-size:20px;margin-top:8px">+ ' + idle + " other devices online and idle · internet traffic only (local streaming, e.g. Plex at home, isn't counted)</p>";
  }
  function piholeHtml(p) {
    if (!p) { return ""; }
    var h = "<h3>Ad blocking · Pi-hole (last 24 hours)" + ' <span class="lg"><i style="background:' + C_DOWN + '"></i>Allowed <i style="background:' + C_UP + '"></i>Blocked</span></h3>';
    h += '<div class="ntiles">' + tile("Lookups", (p.total || 0).toLocaleString()) + tile("Blocked", (p.blocked || 0).toLocaleString()) +
      tile("Blocked %", (p.percent || 0) + "%") + tile("Devices using it", p.clients_active != null ? p.clients_active : p.top_clients.length) +
      tile("Blocklist", p.blocklist_size ? Math.round(p.blocklist_size / 1000) + "k domains" : "–") + "</div>";
    // stacked hourly bars: allowed (blue) under blocked (orange), 2px surface gap between segments
    var hist = p.history || [], hours = [], i;
    for (i = 0; i < hist.length; i += 6) {
      var a = 0, b = 0, j;
      for (j = i; j < i + 6 && j < hist.length; j++) { a += hist[j].allowed; b += hist[j].blocked; }
      hours.push({ t: hist[i].t, a: a, b: b });
    }
    var W = 1440, H = 170, L = 60, B = 26, pw = W - L - 10, ph = H - B - 10, max = 10, bw;
    for (i = 0; i < hours.length; i++) { max = Math.max(max, hours[i].a + hours[i].b); }
    bw = hours.length ? pw / hours.length : pw;
    var svg = '<svg width="' + W + '" height="' + H + '"><line x1="' + L + '" y1="' + (10 + ph) + '" x2="' + (L + pw) + '" y2="' + (10 + ph) + '" stroke="rgba(255,255,255,0.2)"/>' +
      '<text x="' + (L - 8) + '" y="16" text-anchor="end" font-size="16" fill="#9aa4b6">' + max + '</text><text x="' + (L - 8) + '" y="' + (10 + ph) + '" text-anchor="end" font-size="16" fill="#9aa4b6">0</text>';
    for (i = 0; i < hours.length; i++) {
      var x = L + i * bw + 2, w = Math.max(2, bw - 4), ha = hours[i].a / max * ph, hb = hours[i].b / max * ph, y0 = 10 + ph;
      if (ha > 0) { svg += '<rect x="' + x + '" y="' + (y0 - ha) + '" width="' + w + '" height="' + ha + '" fill="' + C_DOWN + '" rx="2"/>'; }
      if (hb > 0) { svg += '<rect x="' + x + '" y="' + (y0 - ha - hb - (ha > 0 ? 2 : 0)) + '" width="' + w + '" height="' + hb + '" fill="' + C_UP + '" rx="2"/>'; }
      var hr = new Date(hours[i].t * 1000).getHours();
      if (hr % 6 === 0) { svg += '<text x="' + (x + w / 2) + '" y="' + (H - 4) + '" text-anchor="middle" font-size="15" fill="#9aa4b6">' + pad(hr) + ":00</text>"; }
    }
    h += svg + "</svg>";
    function list(title, rows, label) {
      var max2 = 1, k, out = '<div style="width:48%"><h3>' + title + "</h3>";
      for (k = 0; k < rows.length; k++) { max2 = Math.max(max2, rows[k].count); }
      for (k = 0; k < rows.length; k++) {
        out += '<div class="dev"><div class="dn" style="width:360px">' + esc(label(rows[k])) + '</div><div class="db" style="width:240px"><span style="width:' +
          Math.max(3, Math.round(rows[k].count / max2 * 230)) + "px;background:" + (title.indexOf("blocked") >= 0 ? C_UP : C_DOWN) + ';border-radius:4px"></span></div><div class="dv">' + rows[k].count + "</div></div>";
      }
      return out + (rows.length ? "" : '<p class="muted">Nothing yet</p>') + "</div>";
    }
    h += '<div style="display:flex;justify-content:space-between">' + list("Most blocked", p.top_blocked, function (r) { return r.domain; }) +
      list("Busiest devices", p.top_clients, function (r) { return r.name; }) + "</div>";
    return h;
  }
  function netLiveHtml(d) {
    var h = d.hub || {}, l = d.latency || {}, svc = "", k;
    for (k in l.services) { if (l.services.hasOwnProperty(k)) { svc += '<span class="svc2"><span class="dot' + (l.services[k] ? "" : " bad") + '"></span>' + esc(k) + (l.services[k] ? "" : " (down)") + "</span>"; } }
    var age = h.sampled ? Math.max(0, Math.round(d.now - h.sampled)) : null;
    return '<div class="ntiles">' +
      tile("Internet", '<span class="dot' + (l.internet ? "" : " bad") + '"></span>' + (l.internet ? "Online" : "OFFLINE")) +
      tile("Latency", l.ms != null ? Math.round(l.ms) + " ms" : "–") +
      tile("Broadband up", h.connected_for ? dur(h.connected_for) : "–") +
      tile("Devices online", h.online != null ? h.online : "–") +
      tile("Public IP", esc(h.public_ip || "–")) +
      tile("Services", svc || "–") + "</div>" +
      '<div class="nrow"><div><h3>Internet speed · last 5 minutes <span class="lg"><i style="background:' + C_DOWN + '"></i>Download <i style="background:' + C_UP +
      '"></i>Upload</span></h3>' + throughputSvg(d.throughput || [], d.now, 960, 250) + "</div>" +
      '<div><h3>Latency · last ' + Math.round((l.history || []).length / 2) + " min</h3>" + latencySvg(l.history || [], 440, 250) + "</div></div>" +
      "<h3>Using the internet now · average over the last minute</h3>" + devicesHtml(h.devices || []) + piholeHtml(d.pihole) +
      '<p class="muted" style="font-size:18px;text-align:right;margin:6px 0 0">Updated ' + (age != null ? age + "s ago" : "–") + " · refreshes every 5 seconds</p>";
  }

  /* ---------------- overlays (detail pages) ---------------- */
  function overlayOpen() { return !$("overlay").classList.contains("hidden"); }
  var liveTimer = null;
  function openOverlay(title, html) {
    clearInterval(liveTimer); liveTimer = null;
    if ($("notify")) { $("notify").style.display = "none"; }
    feedState = null;
    $("panel-title").innerHTML = title;
    $("panel-body").innerHTML = html;
    $("panel-body").removeAttribute("data-step");
    $("panel-body").scrollTop = 0;
    $("overlay").classList.remove("hidden");
  }
  function closeOverlay() { setTimeout(renderBell, 0); $("overlay").classList.add("hidden"); clearInterval(liveTimer); liveTimer = null; feedState = null; returnToFeed = null; }

  // TV apps: matched by installed app name on the TV, with known Tizen app IDs as a fallback
  var APPS = {};   // from config [[apps]] (key → {label, names, ids}); tiles drawn by renderApps()
  var APP_LOGOS = {
    youtube: '<svg viewBox="0 0 48 34"><rect width="48" height="34" rx="9" fill="#ff0033"/><path d="M19 9.5v15l13-7.5z" fill="#fff"/></svg>',
    iplayer: '<svg viewBox="0 0 48 34"><g fill="#fff"><rect x="1" y="9" width="14" height="16"/><rect x="17" y="9" width="14" height="16"/><rect x="33" y="9" width="14" height="16"/></g><g fill="#c0137a" font-family="Arial" font-weight="bold" font-size="13" text-anchor="middle"><text x="8" y="22">B</text><text x="24" y="22">B</text><text x="40" y="22">C</text></g></svg>',
    channel4: '<svg viewBox="0 0 34 34"><g fill="#fff"><path d="M20 2h7v30h-7z"/><path d="M20 2 4 22h7l9-11z"/><path d="M4 22h28v6H4z"/></g></svg>',
    spotify: '<svg viewBox="0 0 34 34"><circle cx="17" cy="17" r="16" fill="#1ed760"/><g fill="none" stroke="#000" stroke-linecap="round"><path d="M8 12.5c6-2 13-1.5 18.5 1.5" stroke-width="3"/><path d="M9 17.5c5-1.5 10.5-1 15 1.3" stroke-width="2.5"/><path d="M10 22.2c4-1.1 8.2-.8 11.8 1" stroke-width="2"/></g></svg>',
    netflix: '<svg viewBox="0 0 34 34"><path d="M9 3h6l5 17V3h5v28h-6L14 14v17H9z" fill="#e50914"/></svg>',
    plex: '<svg viewBox="0 0 34 34"><path d="M10 3h8l9 14-9 14h-8l9-14z" fill="#e5a00d"/></svg>'
  };
  var APP_CLASS = { youtube: "yt", iplayer: "ip", channel4: "c4", spotify: "sp" };
  function renderApps() {
    var h = "", i, a;
    for (i = 0; i < CONF.apps.length; i++) {
      a = CONF.apps[i];
      APPS[a.key] = { label: a.label, names: a.names || [a.label], ids: a.ids || [] };
      if (a.hidden) { continue; }   // e.g. Plex: launched from its own panel, no tile
      h += '<div class="app-tile focusable ' + (APP_CLASS[a.key] || "gen") + '" data-action="app" data-app="' + esc(a.key) + '">' +
        (APP_LOGOS[a.key] || "") + "<span>" + esc(a.label) + "</span></div>";
    }
    $("app-grid").innerHTML = h;
  }

  var OV_ACTIONS = {
    tab: function (el) { feedState.tab = +el.getAttribute("data-tab"); feedState.sel = 0; renderFeed(); },
    openplex: function () { closeOverlay(); ACTIONS.plex(); }
  };

  /* ---------------- expanded news & events ---------------- */
  var TABS = [{ label: "All news" }, { label: "Events", events: true }];   // rebuilt from config news_tabs
  var feedState = null, returnToFeed = null;
  function ago(ts) {
    if (!ts) { return ""; }
    var m = Math.round((Date.now() / 1000 - ts) / 60);
    if (m < 60) { return m + " min ago"; }
    if (m < 1440) { return Math.round(m / 60) + "h ago"; }
    var d = new Date(ts * 1000);
    return d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3);
  }
  function evWhen(e) {   // "7 and 21 November" from the source, else derived from the dates ("Season" is just a label)
    if (e.when && !/^season$/i.test(e.when)) { return e.when; }
    var s = parseLocal(e.start), en = e.end ? parseLocal(e.end) : null, today = new Date();
    if (en && e.end !== e.start) {
      if (s < today) { return "until " + DAYS[en.getDay()].slice(0, 3) + " " + en.getDate() + " " + MONTHS[en.getMonth()].slice(0, 3); }
      return s.getDate() + (s.getMonth() !== en.getMonth() ? " " + MONTHS[s.getMonth()].slice(0, 3) : "") + "–" + en.getDate() + " " + MONTHS[en.getMonth()].slice(0, 3);
    }
    var tm = /T(\d\d):(\d\d)/.exec(e.start || ""), clock = "";
    if (tm && tm[1] + tm[2] !== "0000") { var hh = +tm[1]; clock = " · " + (hh % 12 || 12) + (tm[2] !== "00" ? ":" + tm[2] : "") + (hh >= 12 ? "pm" : "am"); }
    return DAYS[s.getDay()].slice(0, 3) + " " + s.getDate() + " " + MONTHS[s.getMonth()].slice(0, 3) + clock;
  }
  function evPlace(p) {
    var parts = (p || "").split(/\s*,\s*/), out = [], i;
    for (i = 0; i < parts.length; i++) { if (parts[i] && out.indexOf(parts[i]) < 0) { out.push(parts[i]); } }
    return out.join(", ");
  }
  function feedItems(tab) {
    if (feedState && feedState.list) { return feedState.list; }
    var t = TABS[tab], out = [], i;
    if (t.events) {
      var ev = data("events"), nb = data("nearby");
      if (ev && ev.items) { for (i = 0; i < ev.items.length; i++) { out.push({ kind: "event", e: ev.items[i], venue: ev.venue }); } }
      if (nb && nb.items) { for (i = 0; i < nb.items.length; i++) { out.push({ kind: "event", e: nb.items[i] }); } }
      return out;
    }
    var items = newsItems();
    for (i = 0; i < items.length; i++) { if (!t.source || items[i].source === t.source) { out.push({ kind: "news", n: items[i] }); } }
    return out;
  }
  function renderFeed() {
    var items = feedItems(feedState.tab), html = "", i, s = loadSeen();
    if (feedState.notif) {
      var left = 0;
      for (i = 0; i < items.length; i++) { if (!s[notifId(items[i])]) { left++; } }
      html += '<p class="muted" style="font-size:20px;margin:0 0 12px">' + (left ? left + " unread · ▼ to read on" : "All caught up — press Back to close") + "</p>";
    } else {
      html += '<div class="tabs">';
      for (i = 0; i < TABS.length; i++) {
        html += '<span class="ov-btn' + (i === feedState.tab ? " sel" : "") + '" data-act="tab" data-tab="' + i + '">' + TABS[i].label + "</span>";
      }
      html += "</div>";
    }
    html += '<div id="feed-list">';
    feedState.sel = Math.max(0, Math.min(feedState.sel, items.length - 1));
    for (i = 0; i < items.length; i++) {
      var it = items[i], img = "", title, meta;
      if (it.kind === "note") {
        title = "📌 " + esc(it.note.text);
        meta = '<span class="src local">Note</span>' + (it.note.by ? esc(it.note.by) + " · " : "") + ago(it.note.created);
      } else if (it.kind === "news") {
        img = it.n.image ? newsImg(it.n.image, 320) : "";
        title = esc(it.n.title);
        meta = srcTag(it.n) + ago(it.n.ts) + (it.n.summary ? " · " + esc(it.n.summary) : "");
      } else {
        var e = it.e, d = parseLocal(e.start);
        img = e.image ? newsImg(e.image, 320) : "";
        title = esc(e.name);
        meta = '<span class="src local">' + esc(it.venue || e.source || "Event") + "</span>" + esc(evWhen(e)) +
          (e.place ? " · " + esc(evPlace(e.place)) : "") + (e.miles ? " · " + e.miles + " mi" : "");
      }
      var unread = feedState.notif && !s[notifId(it)];
      html += '<div class="fitem' + (i === feedState.sel ? " sel" : "") + (feedState.notif && !unread && i !== feedState.sel ? " read" : "") + '" data-i="' + i + '"><div class="fi"' + (img ? " style=\"background-image:url('" + img + "')\"" : "") +
        '></div><div class="ft"><div class="t">' + (unread ? '<span class="newdot"></span>' : "") + title + '</div><div class="m">' + meta + "</div></div></div>";
    }
    if (!items.length) { html += '<p class="muted">Nothing here right now.</p>'; }
    $("panel-body").innerHTML = html + "</div>";
    var sel = $("panel-body").querySelector(".fitem.sel");
    if (sel) {   // keep the selected row in view
      var body = $("panel-body"), top = sel.offsetTop, bottom = top + sel.offsetHeight;
      if (top < body.scrollTop + 70) { body.scrollTop = Math.max(0, top - 70); }
      else if (bottom > body.scrollTop + body.clientHeight) { body.scrollTop = bottom - body.clientHeight + 10; }
    }
  }
  function openFeed(tab) {
    openOverlay("Local news &amp; events", "");
    feedState = { tab: tab || 0, sel: 0 };
    renderFeed();
  }
  function openFeedItem() {
    var it = feedItems(feedState.tab)[feedState.sel];
    if (!it) { return; }
    returnToFeed = { tab: feedState.tab, sel: feedState.sel, list: feedState.list, notif: feedState.notif };
    if (it.kind === "note") { openOverlay("📌 Note", notesHtml()); return; }
    if (it.kind === "news") { showArticle(it.n); return; }
    var e = it.e;
    openOverlay(esc(e.name), (e.image ? '<img src="' + newsImg(e.image, 960) + '" style="width:720px;border-radius:16px;display:block;margin-bottom:20px">' : "") +
      '<p class="muted">' + esc(evWhen(e)) + (e.place ? " · " + esc(evPlace(e.place)) : "") + (e.miles ? " · " + e.miles + " mi" : "") + "</p>" +
      (e.summary ? "<p>" + esc(e.summary) + "</p>" : "") + '<p class="muted" style="font-size:20px">' + esc(it.venue || e.source || "") + "</p>" + origHtml(e.url));
  }
  function origHtml(url) {   // "scan to open the original" block for detail pages
    if (!url || !/^https?:\/\//.test(url)) { return ""; }
    var short = url.replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "");
    if (short.length > 70) { short = short.slice(0, 67) + "…"; }
    return '<div class="orig"><img src="' + BASE + "/qr?u=" + encodeURIComponent(url) + '" alt="QR code"><div>Scan with your phone to open the original' +
      '<div class="u">' + esc(short) + "</div></div></div>";
  }
  function showPdf(url, link) {
    $("panel-body").innerHTML = '<p class="muted">Opening the PDF…</p>';
    getJSON("/api/pdfinfo?u=" + encodeURIComponent(url), function (d) {
      if (!overlayOpen()) { return; }
      if (!d || d.error || !d.pages) { $("panel-body").innerHTML = '<p class="muted">Couldn\'t open this PDF on the TV.</p>'; return; }
      var html = '<p class="muted" style="font-size:20px">' + d.pages + " page" + (d.pages > 1 ? "s" : "") + " · ▲▼ to scroll</p>", i;
      for (i = 0; i < d.pages && i < 30; i++) {
        html += '<img class="pdfpage" src="' + BASE + "/pdfpage?u=" + encodeURIComponent(url) + "&p=" + i + '&w=1440" alt="page ' + (i + 1) + '">';
      }
      $("panel-body").innerHTML = html + origHtml(link || url);
      $("panel-body").setAttribute("data-step", "640");
    });
  }
  function showArticle(it) {
    if (/facebook\.com/.test(it.link || "")) {
      var h = '<p class="muted" style="font-size:22px">' + esc(it.source) + " · Facebook · " + ago(it.ts) + "</p><p>" + esc(it.text || it.summary) + "</p>", j;
      var imgs = it.images && it.images.length ? it.images : (it.image ? [it.image] : []);
      for (j = 0; j < imgs.length; j++) { h += '<img src="' + newsImg(imgs[j], 960) + '" style="max-width:960px;border-radius:14px;display:block;margin:0 auto 18px">'; }
      openOverlay(esc(it.title), h + origHtml(it.link));
      $("panel-body").setAttribute("data-step", "500");
      return;
    }
    openOverlay(esc(it.title), '<p class="muted">Loading…</p>');
    getJSON("/api/article?url=" + encodeURIComponent(it.link), function (a) {
      if (!overlayOpen()) { return; }
      if (a && a.pdf) { showPdf(a.pdf, it.link); return; }
      if (!a || a.error || !a.paragraphs || !a.paragraphs.length) {
        $("panel-body").innerHTML = (it.image ? '<img src="' + newsImg(it.image, 960) + '" style="width:720px;border-radius:16px;display:block;margin-bottom:20px">' : "") +
          "<p>" + esc(it.summary) + '</p><p class="muted">Full story unavailable on the TV.</p>' + origHtml(it.link);
        return;
      }
      var html = (it.image ? '<img src="' + newsImg(it.image, 960) + '" style="width:720px;border-radius:16px;display:block;margin-bottom:20px">' : "") +
        '<p class="muted" style="font-size:22px">' + esc(it.source) + "</p>", i;
      for (i = 0; i < a.paragraphs.length; i++) { html += "<p>" + esc(a.paragraphs[i]) + "</p>"; }
      $("panel-body").innerHTML = html + origHtml(it.link);
    });
  }

  /* ---------------- notifications (new posts from configured local sources & events, per device) ---------------- */
  var BELL = '<svg viewBox="0 0 24 24"><path d="M12 22a2.5 2.5 0 0 0 2.4-2h-4.8a2.5 2.5 0 0 0 2.4 2zm7-6V11a7 7 0 0 0-5-6.7V3.5a2 2 0 1 0-4 0v.8A7 7 0 0 0 5 11v5l-2 2v1h18v-1z" fill="#fde68a"/></svg>';
  var seen = null, lastUnseen = -1;
  function loadSeen() {
    if (seen) { return seen; }
    seen = {};
    try { var a = JSON.parse(store("homedash.seen") || "[]"); for (var i = 0; i < a.length; i++) { seen[a[i]] = 1; } } catch (e) {}
    return seen;
  }
  function saveSeen() {
    var keys = [], k;
    for (k in seen) { if (seen.hasOwnProperty(k)) { keys.push(k); } }
    store("homedash.seen", JSON.stringify(keys.slice(-600)));
  }
  function notifId(it) { return it.kind === "note" ? "note:" + it.note.id : it.kind === "news" ? "n:" + it.n.link : "e:" + (it.e.url || it.e.name + "|" + it.e.start); }
  function notifCandidates() {
    var out = [], i, items = newsItems(), ev = data("events"), nb = data("nearby"), ns = data("notices") || [];
    for (i = ns.length - 1; i >= 0; i--) { out.push({ kind: "note", note: ns[i] }); }
    for (i = 0; i < items.length; i++) { if (CONF.notify_sources.indexOf(items[i].source) >= 0) { out.push({ kind: "news", n: items[i] }); } }
    if (ev && ev.items) { for (i = 0; i < ev.items.length; i++) { out.push({ kind: "event", e: ev.items[i], venue: ev.venue }); } }
    if (nb && nb.items) { for (i = 0; i < nb.items.length; i++) { if (!nb.items[i].ongoing) { out.push({ kind: "event", e: nb.items[i] }); } } }
    return out;
  }
  function unseenItems() {
    var s = loadSeen(), all = notifCandidates(), out = [], i;
    for (i = 0; i < all.length; i++) { if (!s[notifId(all[i])]) { out.push(all[i]); } }
    return out;
  }
  function renderBell() {
    if (!W.notifications) { return; }
    var un = unseenItems(), el = $("bell");
    if (!un.length) { el.className = "hidden"; el.classList.remove("focusable"); lastUnseen = 0; return; }
    el.className = "focusable";
    el.innerHTML = BELL + un.length + " new" + '<span class="pulse"></span>';
    if (un.length > lastUnseen) { showNotify(un, lastUnseen < 0 ? un.length : un.length - lastUnseen); }
    lastUnseen = un.length;
  }
  function showNotify(un, fresh) {
    var news = 0, events = 0, i;
    for (i = 0; i < un.length; i++) { if (un[i].kind === "news") { news++; } else if (un[i].kind === "event") { events++; } }
    var n = $("notify");
    if (!n) { n = document.createElement("div"); n.id = "notify"; document.body.appendChild(n); }
    var first = un[0], title = first.kind === "note" ? "📌 " + first.note.text : first.kind === "news" ? first.n.title : first.e.name;
    n.innerHTML = BELL.replace("<svg", '<svg width="22" height="22" style="vertical-align:-3px;margin-right:8px"') + "<b>" + fresh + " new</b> · " +
      (news ? news + " new post" + (news > 1 ? "s" : "") : "") + (news && events ? " · " : "") + (events ? events + " event" + (events > 1 ? "s" : "") : "") +
      '<div class="nl">' + esc(title) + '</div><div class="nl" style="color:#9aa4b6;font-size:17px">Select the bell at the top to read them</div>';
    n.style.display = "block"; n.style.opacity = 1;
    clearTimeout(showNotify.t);
    showNotify.t = setTimeout(function () { n.style.opacity = 0; setTimeout(function () { n.style.display = "none"; }, 600); }, 12000);
  }
  function openNotifications() {
    var list = unseenItems();
    if (!list.length) { toast("You're all caught up"); return; }
    openOverlay(BELL.replace("<svg", '<svg width="34" height="34" style="vertical-align:-4px;margin-right:10px"') + "New for you", "");
    feedState = { tab: 0, sel: 0, list: list, notif: true };
    markSelectedSeen();
    renderFeed();
  }
  function markSelectedSeen() {
    if (!feedState || !feedState.notif) { return; }
    var it = feedState.list[feedState.sel];
    if (it) { loadSeen()[notifId(it)] = 1; saveSeen(); }
  }

  /* ---------------- notes pinned via Telegram (dashnote) ---------------- */
  function renderNotes() {
    if (!W.notes) { return; }
    var ns = data("notices") || [], el = $("notepill");
    if (!ns.length) { el.className = "hidden"; el.classList.remove("focusable"); return; }
    var latest = ns[ns.length - 1];
    el.className = "focusable";
    el.innerHTML = "📌 " + esc(latest.text) + (ns.length > 1 ? ' <span style="opacity:.75">+' + (ns.length - 1) + "</span>" : "");
  }
  function notesHtml() {
    var ns = (data("notices") || []).slice().reverse();
    if (!ns.length) { return '<p class="muted">No notes. Ask Hades on Telegram to “put … on the dashboard”.</p>'; }
    return ns.map(function (n) {
      var c = new Date(n.created * 1000), u = new Date(n.until * 1000);
      return '<div class="note-row">' + esc(n.text) + '<div class="d">' + (n.by ? esc(n.by) + " · " : "") + "pinned " + DAYS[c.getDay()].slice(0, 3) + " " +
        pad(c.getHours()) + ":" + pad(c.getMinutes()) + " · until " + DAYS[u.getDay()].slice(0, 3) + " " + u.getDate() + " " + MONTHS[u.getMonth()].slice(0, 3) +
        " " + pad(u.getHours()) + ":" + pad(u.getMinutes()) + "</div></div>";
    }).join("");
  }

  /* ---------------- travel & power warnings ---------------- */
  function alertTitle(a) {
    if (a.category === "power") { return "Power cut · " + (a.postcodes || "area") + (a.customers ? " · " + a.customers + " home" + (a.customers > 1 ? "s" : "") : ""); }
    return a.headline || a.title;
  }
  function renderWarnings2() {
    if (!W.alerts) { return; }
    var al = data("alerts"), el = $("warnpill");
    if (!al || (!al.count && !al.nie_message)) { el.className = "hidden"; el.classList.remove("focusable"); return; }
    var p = al.power.filter ? al.power : [], t = al.traffic || [], top = null, i;
    var all = p.concat(t);
    for (i = 0; i < all.length && !top; i++) { if (all[i].severity === "high") { top = all[i]; } }
    var nPow = p.length, nInc = 0, nWorks = 0;
    for (i = 0; i < t.length; i++) { if (t[i].kind === "roadworks") { nWorks++; } else { nInc++; } }
    var txt;
    if (top) { txt = (top.category === "power" ? "⚡ Power cut " + esc(top.postcodes.split(",")[0]) : "⚠ " + esc(top.short || alertTitle(top))); }
    else {
      var parts = [];
      if (nPow) { parts.push(nPow + " power cut" + (nPow > 1 ? "s" : "")); }
      if (nInc) { parts.push(nInc + " traffic incident" + (nInc > 1 ? "s" : "")); }
      if (nWorks) { parts.push(nWorks + " roadworks"); }
      txt = "⚠ " + (parts.join(" · ") || "NIE notice");
    }
    if (top && all.length > 1) { txt += ' <span style="opacity:.75">+' + (all.length - 1) + "</span>"; }
    el.className = (top || nPow ? "red" : "amber") + " focusable";
    el.innerHTML = txt;
  }
  function alertsHtml() {
    var al = data("alerts"), h = "", i;
    if (!al) { return '<p class="muted">No data yet.</p>'; }
    function row(a) {
      var when = "";
      if (a.category === "power") {
        when = "Started " + esc(a.started || "?") + " · restore: " + esc(a.restore || "?") + " · " + a.home_km + " km from home";
        return '<div class="alrow"><div class="sv ' + a.severity + '"></div><div>' + esc(alertTitle(a)) + '<div class="d">' + esc(a.status) +
          (a.cause ? " · " + esc(a.cause) : "") + "<br>" + when + "</div></div></div>";
      }
      if (a.from) { when = "Roadworks " + esc(a.from.replace("T", " ")) + " → " + esc(a.to.replace("T", " ")); }
      else if (a.posted) { when = "Reported " + esc(a.posted.replace("T", " ")); }
      return '<div class="alrow"><div class="sv ' + a.severity + '"></div><div>' + esc(alertTitle(a)) + (a.near_home ? ' <span class="alert">· near home</span>' : "") +
        '<div class="d">' + esc(a.detail.slice(0, 260)) + "<br>" + when + "</div></div></div>";
    }
    if (al.nie_message) { h += '<p class="alert">NIE Networks: ' + esc(al.nie_message) + "</p>"; }
    h += "<h3>Power — NIE Networks</h3>";
    h += al.power.length ? al.power.map(row).join("") : '<p class="muted">No power cuts near home or along your routes.</p>';
    h += "<h3>Traffic" + (CONF.alerts_route_label ? " — " + esc(CONF.alerts_route_label) : "") + "</h3>";
    h += al.traffic.length ? al.traffic.map(row).join("") : '<p class="muted">No incidents or roadworks on the routes right now.</p>';
    return h + '<p class="muted" style="font-size:18px;margin-top:16px">TrafficWatchNI (updated every 5 min) · NIE Networks PowerCheck (faults affecting 10+ homes) · checked every 5 minutes</p>';
  }

  var ACTIONS = {
    alerts: function () { openOverlay("Travel &amp; power warnings", alertsHtml()); },
    notes: function () { openOverlay("📌 Notes", notesHtml()); },
    solar: function () {
      openOverlay("Solar &amp; battery", solarDetailHtml());
      liveTimer = setInterval(function () { if (overlayOpen()) { $("panel-body").innerHTML = solarDetailHtml(); } }, 30000);
    },
    notifications: function () { openNotifications(); },
    feed: function () { openFeed(0); },
    music: function () {
      if (needsGesture) { playStation(stationIdx); return; }
      playStation((stationIdx + 1) % STATIONS.length);
      toast(STATIONS[stationIdx] ? "♫ " + STATIONS[stationIdx].name : "Music off");
    },
    weather: function () {
      var w = data("weather");
      if (!w) { return; }
      var hrs = upcomingHours(w, 24), rows = "", i;
      for (i = 0; i < hrs.length; i++) {
        var h = hrs[i];
        rows += "<tr><td>" + pad(parseLocal(h.time).getHours()) + ':00</td><td class="ic"><div>' + icon(h.icon, h.day) + "</div></td><td>" +
          round(h.temp) + "°</td><td>" + esc(h.label) + '</td><td style="color:#60a5fa">' + (h.pop || 0) + '% rain</td><td style="color:' +
          windColour(h.gust) + '">' + arrow(h.dir, 22) + " " + round(h.wind) + " mph, gusts " + round(h.gust) + "</td></tr>";
      }
      var days = "";
      for (i = 0; i < w.daily.length; i++) {
        var d = w.daily[i];
        days += "<tr><td>" + (i === 0 ? "Today" : DAYS[parseLocal(d.date).getDay()]) + '</td><td class="ic"><div>' + icon(d.icon, true) +
          "</div></td><td>" + round(d.max) + "° / " + round(d.min) + "°</td><td>" + esc(d.label) + '</td><td style="color:#60a5fa">' +
          (d.pop || 0) + "% rain</td><td>" + esc(d.compass) + " " + round(d.wind) + "–" + round(d.gust) + " mph</td><td class=\"muted\">☀ " +
          d.sunrise + " – " + d.sunset + "</td></tr>";
      }
      openOverlay("Weather · " + esc(w.place), "<h3>Next 24 hours</h3><table>" + rows + "</table><h3>Week ahead</h3><table>" + days + "</table>");
    },
    pier: function () {
      var m = data("marine"), p = data("pier"), html = "", i;
      if (m) {
        html += "<h3>Tides off " + esc(CONF.marine_place) + "</h3><table>";
        for (i = 0; i < m.events.length; i++) {
          var e = m.events[i];
          html += "<tr><td>" + (e.kind === "high" ? "▲ High water" : "▼ Low water") + "</td><td>" + e.day + "</td><td>" + e.time + "</td></tr>";
        }
        html += '</table><p class="muted" style="font-size:20px;margin-top:10px">Modelled tide times (±20 min) — check official local tide tables before relying on them.' +
          (m.waves != null ? " Waves now " + m.waves.toFixed(1) + " m." : "") + (m.sea_temp != null ? " Sea " + m.sea_temp.toFixed(1) + "°C." : "") + "</p>";
      }
      if (p) {
        html += "<h3>Fishing now: " + p.verdict.level + "</h3><p>" + esc(p.verdict.notes.join(" · ")) +
          (p.verdict.window ? "<br>Best around high water: " + p.verdict.window : "") + (p.verdict.dusk ? " · sunset " + p.verdict.dusk : "") + "</p>";
        html += "<h3>In season in " + esc(p.month) + " (★ = peak)</h3>";
        for (i = 0; i < p.fish.length; i++) {
          html += '<div class="fishrow"><b>' + (p.fish[i].best ? "★ " : "") + esc(p.fish[i].name) + "</b> <span>— " + esc(p.fish[i].tip) + "</span></div>";
        }
      }
      openOverlay(FISH_ICON.replace("<svg", '<svg width="60" height="36" style="vertical-align:-4px;margin-right:12px"') + "Wind, tides &amp; fishing", html);
    },
    kids: function () {
      var c = data("clubs");
      if (!c) { return; }
      var html = "", i, j, NAMES = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };
      for (i = 0; i < c.week.length; i++) {
        var d = c.week[i], rows = "";
        for (j = 0; j < d.clubs.length; j++) {
          var e = d.clubs[j];
          rows += "<div>" + kidChip(e) + esc(e.what) + ' <span class="muted">' + clubTime(e) +
            (e.where && e.what.indexOf(e.where) < 0 ? " · " + esc(e.where) : "") + "</span>" +
            (i === 0 && e.status === "now" ? ' <span class="club-now">● now</span>' : "") + "</div>";
        }
        html += '<div class="week-day' + (i === 0 ? " today" : "") + '"><div class="dn">' + (i === 0 ? "Today" : i === 1 ? "Tomorrow" : NAMES[d.day]) +
          '</div><div class="cl">' + (rows || '<span class="muted">—</span>') + "</div></div>";
      }
      openOverlay("The kids' week", html);
    },
    plexitem: function (el) {
      var p = data("plex"), it = p && p[el.getAttribute("data-list")][+el.getAttribute("data-i")];
      if (!it) { return; }
      var meta = [];
      if (it.year) { meta.push(it.year); }
      if (it.duration_min) { meta.push(Math.floor(it.duration_min / 60) + "h " + (it.duration_min % 60) + "m"); }
      if (it.content_rating) { meta.push(esc(it.content_rating)); }
      if (it.rating) { meta.push("★ " + (+it.rating).toFixed(1)); }
      if (it.genres && it.genres.length) { meta.push(esc(it.genres.join(", "))); }
      openOverlay(esc(it.title), '<div style="display:flex"><div style="width:300px;margin-right:44px;flex-shrink:0">' +
        img(it.art, 300, 450).replace("<img", '<img style="width:300px;height:450px;border-radius:16px;object-fit:cover"') + "</div><div>" +
        (it.subtitle && it.subtitle !== String(it.year) ? '<p style="font-size:30px">' + esc(it.subtitle) + "</p>" : "") +
        '<p class="muted">' + meta.join(" · ") + "</p><p>" + esc(it.summary || "No description.") + "</p>" +
        '<div class="ov-btns"><span class="ov-btn sel" data-act="openplex">▶ Open in Plex</span></div></div></div>');
    },
    app: function (el) {
      var a = APPS[el.getAttribute("data-app")];
      if (!a) { return; }
      if (shell("launch", { names: a.names, ids: a.ids })) { toast("Opening " + a.label + "…"); }
      else { toast(a.label + " opens from the TV app"); }
    },
    plex: function () {
      var px = APPS.plex || { names: ["Plex"], ids: [] };
      if (shell("launch", { names: px.names, ids: px.ids })) { toast("Opening Plex…"); }
      else { toast("Plex opens from the TV app"); }
    },
    network: function () {
      openOverlay('Network <span class="live-tag">● LIVE</span>', '<p class="muted">Reading the hub…</p>');
      function refresh() {
        getJSON("/api/network/live?t=" + Date.now(), function (d) {
          if (!overlayOpen() || !liveTimer) { return; }
          if (d && !d.error) { $("panel-body").innerHTML = netLiveHtml(d); }
        });
      }
      liveTimer = setInterval(refresh, 5000);
      refresh();
    },
    article: function (el) {
      var items = newsItems(), it = items[(newsIdx + (+el.getAttribute("data-idx"))) % items.length];
      if (!it || !it.link) { return; }
      showArticle(it);
      return;
      openOverlay(esc(it.title), '<p class="muted">Loading…</p>');
      getJSON("/api/article?url=" + encodeURIComponent(it.link), function (a) {
        if (!overlayOpen()) { return; }
        if (!a || a.error || !a.paragraphs || !a.paragraphs.length) {
          $("panel-body").innerHTML = "<p>" + esc(it.summary) + '</p><p class="muted">Full story unavailable on the TV.</p>';
          return;
        }
        var html = (it.image ? '<img src="' + newsImg(it.image, 960) + '" style="width:720px;border-radius:16px;display:block;margin-bottom:20px">' : "") +
          '<p class="muted" style="font-size:22px">' + esc(it.source) + "</p>", i;
        for (i = 0; i < a.paragraphs.length; i++) { html += "<p>" + esc(a.paragraphs[i]) + "</p>"; }
        $("panel-body").innerHTML = html;
      });
    },
    event: function () {
      var tab = 0, i;
      for (i = 0; i < TABS.length; i++) { if (TABS[i].events) { tab = i; } }
      openFeed(tab);
      if (!headerEvent) { return; }
      var items = feedItems(tab);
      for (i = 0; i < items.length; i++) {
        if (items[i].e === headerEvent) { feedState.sel = i; renderFeed(); openFeedItem(); return; }
      }
    },
    eventsOld: function () {
      var ev = data("events"), nb = data("nearby"), html = "", i, lastDay = "";
      if (ev && ev.items && ev.items.length) {
        html += "<h3>" + esc(ev.venue) + "</h3>";
        for (i = 0; i < ev.items.length; i++) {
          var e = ev.items[i], d = parseLocal(e.start);
          html += '<div class="evrow"><div class="evd">' + DAYS[d.getDay()].slice(0, 3) + " " + d.getDate() + " " + MONTHS[d.getMonth()].slice(0, 3) +
            "<br>" + pad(d.getHours()) + ":" + pad(d.getMinutes()) + '</div><div class="evt">' + esc(e.name) +
            (e.summary ? '<div class="muted">' + esc(e.summary) + "</div>" : "") + "</div></div>";
        }
      }
      if (nb && nb.items && nb.items.length) {
        var today = isoDate(new Date());
        for (i = 0; i < nb.items.length; i++) {
          var n = nb.items[i], day = n.ongoing ? "ongoing" : (n.start < today ? today : n.start);
          if (day !== lastDay) {
            var dd = parseLocal(day);
            html += "<h3>" + (day === "ongoing" ? "Ongoing" : day === today ? "Today" : DAYS[dd.getDay()] + " " + dd.getDate() + " " + MONTHS[dd.getMonth()]) + "</h3>";
            lastDay = day;
          }
          html += '<div class="evrow">' + (n.image ? '<div class="evi" style="background-image:url(\'' + newsImg(n.image, 320) + '\')"></div>' : '<div class="evi"></div>') +
            '<div class="evt">' + esc(n.name) + '<div class="muted">' + esc(n.place) + (n.miles ? " · " + n.miles + " mi" : "") + (n.when ? " · " + esc(n.when) : "") +
            (n.category ? " · " + esc(n.category) : "") + (n.end && n.end !== n.start ? " · until " + niceDate(n.end) : "") + "</div></div></div>";
        }
        html += '<p class="muted" style="font-size:18px;margin-top:16px">From regional what\'s-on listings, refreshed daily.</p>';
      }
      openOverlay("What's on nearby", html || '<p class="muted">Nothing listed in the next two weeks.</p>');
    }
  };

  /* ---------------- remote-control navigation ---------------- */
  var focused = null, idleTimer = null;
  function focusables() {
    var all = document.querySelectorAll(".focusable"), out = [], i;
    for (i = 0; i < all.length; i++) {
      var r = all[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && all[i].innerHTML.replace(/\s|&nbsp;/g, "") !== "") { out.push(all[i]); }
    }
    return out;
  }
  function setFocus(el) {
    if (focused) { focused.classList.remove("focused"); }
    focused = el;
    if (el) { el.classList.add("focused"); }
    document.body.classList.add("navigating");
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () { document.body.classList.remove("navigating"); }, 30000);
  }
  function move(dir) {
    var list = focusables();
    if (!list.length) { return; }
    if (!focused || list.indexOf(focused) < 0 || !document.body.classList.contains("navigating")) { setFocus(focused && list.indexOf(focused) >= 0 ? focused : list[0]); return; }
    var a = focused.getBoundingClientRect(), ax = a.left + a.width / 2, ay = a.top + a.height / 2, best = null, bestScore = 1e9, i;
    for (i = 0; i < list.length; i++) {
      if (list[i] === focused) { continue; }
      var b = list[i].getBoundingClientRect(), bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var dx = bx - ax, dy = by - ay, primary, secondary;
      if (dir === "left") { if (b.right > a.left + 5) { continue; } primary = -dx; secondary = Math.abs(dy); }
      else if (dir === "right") { if (b.left < a.right - 5) { continue; } primary = dx; secondary = Math.abs(dy); }
      else if (dir === "up") { if (b.bottom > a.top + 5) { continue; } primary = -dy; secondary = Math.abs(dx); }
      else { if (b.top < a.bottom - 5) { continue; } primary = dy; secondary = Math.abs(dx); }
      var score = primary + secondary * 2;
      if (score < bestScore) { bestScore = score; best = list[i]; }
    }
    if (best) { setFocus(best); }
  }
  function activate(el) {
    var fn = el && ACTIONS[el.getAttribute("data-action")];
    if (fn) { fn(el); }
  }
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode;
    if (overlayOpen() && feedState) {
      var n = feedItems(feedState.tab).length;
      if ((k === 37 || k === 39) && !feedState.notif) { feedState.tab = (feedState.tab + (k === 39 ? 1 : TABS.length - 1)) % TABS.length; feedState.sel = 0; renderFeed(); }
      else if (k === 38) { if (feedState.sel > 0) { feedState.sel--; markSelectedSeen(); renderFeed(); } }
      else if (k === 40) { if (feedState.sel < n - 1) { feedState.sel++; markSelectedSeen(); renderFeed(); } }
      else if (k === 13) { openFeedItem(); }
      else if (k === 10009 || k === 27 || k === 8) { closeOverlay(); renderBell(); }
      e.preventDefault(); return;
    }
    if (overlayOpen() && returnToFeed && (k === 10009 || k === 27 || k === 8)) {
      var back = returnToFeed;
      if (back.list) {
        openOverlay(BELL.replace("<svg", '<svg width="34" height="34" style="vertical-align:-4px;margin-right:10px"') + "New for you", "");
        feedState = back;
      } else { openFeed(back.tab); feedState.sel = back.sel; }
      renderFeed();
      e.preventDefault(); return;
    }
    if (needsGesture && !overlayOpen()) { playStation(stationIdx); }   // browsers: first key press starts the music
    if (overlayOpen()) {
      var body = $("panel-body"), btns = body.querySelectorAll(".ov-btn");
      if (btns.length && (k === 37 || k === 39)) {   // move between buttons inside the page
        var cur = 0, b;
        for (b = 0; b < btns.length; b++) { if (btns[b].classList.contains("sel")) { cur = b; } btns[b].classList.remove("sel"); }
        btns[Math.max(0, Math.min(btns.length - 1, cur + (k === 39 ? 1 : -1)))].classList.add("sel");
        e.preventDefault(); return;
      }
      if (k === 13 && btns.length) {
        var sel = body.querySelector(".ov-btn.sel") || btns[0];
        OV_ACTIONS[sel.getAttribute("data-act")] && OV_ACTIONS[sel.getAttribute("data-act")](sel);
        e.preventDefault(); return;
      }
      if (k === 10009 || k === 27 || k === 8 || k === 13) { closeOverlay(); e.preventDefault(); return; }
      var step = +(body.getAttribute("data-step") || 220);
      if (k === 40) { body.scrollTop += step; e.preventDefault(); }
      if (k === 38) { body.scrollTop -= step; e.preventDefault(); }
      return;
    }
    if (k === 37) { move("left"); e.preventDefault(); }
    else if (k === 38) { move("up"); e.preventDefault(); }
    else if (k === 39) { move("right"); e.preventDefault(); }
    else if (k === 40) { move("down"); e.preventDefault(); }
    else if (k === 13) {
      if (focused && document.body.classList.contains("navigating")) { activate(focused); } else { move("down"); }
      e.preventDefault();
    } else if (k === 10009) {
      if (document.body.classList.contains("navigating")) { document.body.classList.remove("navigating"); }
      else { shell("exit"); }
      e.preventDefault();
    }
  });
  document.addEventListener("click", function (e) {   // mouse/pointer support when viewed in a browser
    var el = e.target;
    while (el && el !== document.body) {
      if (el.classList && el.classList.contains("fitem") && feedState) { feedState.sel = +el.getAttribute("data-i"); markSelectedSeen(); openFeedItem(); return; }
      if (el.classList && el.classList.contains("ov-btn")) { var f = OV_ACTIONS[el.getAttribute("data-act")]; if (f) { f(el); } return; }
      if (el.id === "overlay") { closeOverlay(); return; }
      if (el.classList && el.classList.contains("focusable")) { setFocus(el); activate(el); return; }
      el = el.parentNode;
    }
  });

  /* ---------------- polling ---------------- */
  function renderAll() {
    var fns = [renderNotes, renderWarnings2, renderSolar, renderBell, renderHello, updateBackgrounds, renderWeather, renderWarnings, renderPier, renderPlex, renderNews, renderNet], i;
    for (i = 0; i < fns.length; i++) {
      try { fns[i](); } catch (e) { if (window.console) { console.log("render error", e && e.message); } }
    }
  }
  function poll() {
    getJSON("/api/state?t=" + Date.now() + (query ? "&" + query : ""), function (s) { if (s) { state = s; renderAll(); } });
  }

  function applyConfig(c) {
    CONF = c; W = c.widgets || {};
    if (c.household && c.household.title) { document.title = c.household.title; }
    TABS = [{ label: "All news" }].concat((c.news_tabs || []).map(function (t) { return { label: t.label, source: t.source }; }));
    if (W.events) { TABS.push({ label: "Events", events: true }); }
    STATIONS = [null].concat(c.radio || []);
    renderApps();
    var hide = { weather: ["weather"], marine: ["pier"], plex: ["plex"], news: ["news"], apps: ["apps"], solar: ["solar"], network: ["net"],
      music: ["music-state"], alerts: ["warnpill"], notes: ["notepill"], notifications: ["bell"] };
    for (var k in hide) {
      if (hide.hasOwnProperty(k) && !W[k]) { for (var i = 0; i < hide[k].length; i++) { $(hide[k][i]).classList.add("off"); } }
    }
    if (!W.music) { $("music-head").classList.remove("focusable"); }
  }
  document.addEventListener("click", function () { if (needsGesture) { playStation(stationIdx); } }, true);
  tickClock();
  setInterval(tickClock, 1000);
  getJSON("/api/config", function (c) {
    applyConfig(c || CONF);
    startMusicIfWanted();
    poll();
    setInterval(poll, 15000);
  });
  setInterval(rotateNews, 12000);
  setInterval(nextBackground, 120000);
  setTimeout(function () { location.reload(); }, 6 * 3600 * 1000);
})();
