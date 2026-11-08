/* homedash phone view. Same /api/config + /api/state as the TV dashboard; modern JS is fine here. */
"use strict";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const pad = (n) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WX = { clear: "☀️", partly: "⛅", cloud: "☁️", fog: "🌫️", drizzle: "🌦️", rain: "🌧️", showers: "🌦️", snow: "🌨️", thunder: "⛈️" };
let S = {}, feedTab = 0, feedShown = 8, TODAY_EVENTS = [];
let CONF = { household: {}, widgets: {}, news_tabs: [] }, W = {};
const data = (k) => S[k] && S[k].data;
const local = (s) => { const m = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d))?/.exec(s || ""); return m ? new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : new Date(NaN); };
const watts = (w) => w == null ? "–" : Math.abs(w) >= 1000 ? (Math.abs(w) / 1000).toFixed(1) + " kW" : Math.round(Math.abs(w)) + " W";
const rate = (b) => b == null ? "–" : b >= 1e6 ? (b / 1e6).toFixed(1) + " Mb/s" : b >= 1e3 ? Math.round(b / 1e3) + " kb/s" : Math.round(b) + " b/s";
const wxIcon = (k, day) => (k === "clear" && day === false) ? "🌙" : (WX[k] || "☁️");
const img = (u, w) => "/newsimg?u=" + encodeURIComponent(u) + "&w=" + w;
const ago = (ts) => { if (!ts) return ""; const m = Math.round((Date.now() / 1000 - ts) / 60); if (m < 60) return m + "m ago"; if (m < 1440) return Math.round(m / 60) + "h ago"; const d = new Date(ts * 1000); return d.getDate() + " " + MONTHS[d.getMonth()]; };

function clock() {
  const d = new Date();
  $("m-clock").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes());
  $("m-date").textContent = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()] + " " + d.getDate() + " " +
    ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getMonth()];
}

function renderTop() {
  const w = data("weather"), f = data("family"), h = new Date().getHours();
  if (w) {
    const n = w.now;
    $("m-now").innerHTML = `<div class="row" style="justify-content:flex-end"><span class="e">${wxIcon(n.icon, n.day)}</span><span class="t">${Math.round(n.temp)}°</span></div>
      <div class="l">${esc(n.label)} · ${esc(n.wind.compass)} ${Math.round(n.wind.speed)} mph</div>`;
  }
  let g = (h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening") + (CONF.household.greeting_name ? ", " + esc(CONF.household.greeting_name) : "");
  if (f && f.today && f.today.length) g = "🎂 " + f.today.map((p) => (p.ordinal ? `Happy ${p.ordinal} birthday, ` : "Happy birthday, ") + esc(p.name) + "!").join(" ");
  $("m-greet").innerHTML = g;
}

function clubTime(e) {
  if (e.school) return "";
  if (!e.start) return e.note ? "(" + esc(e.note) + ")" : "";
  const t = (s) => { const [h, m] = s.split(":"); return (h > 12 ? h - 12 : +h) + (m !== "00" ? ":" + m : ""); };
  return t(e.start) + "–" + t(e.end) + (+e.end.split(":")[0] >= 12 ? "pm" : "am");
}

function renderNotes() {
  if (!W.notes) return;
  const ns = (data("notices") || []).slice().reverse(), card = $("c-notes");
  if (!ns.length) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  $("m-notes").innerHTML = ns.map((n) => { const u = new Date(n.until * 1000); return `<div class="li"><div style="font-size:17px">${esc(n.text)}<div class="muted" style="font-size:12px">${n.by ? esc(n.by) + " · " : ""}${ago(n.created)} · until ${DAYS[u.getDay()]} ${pad(u.getHours())}:${pad(u.getMinutes())}</div></div></div>`; }).join("");
}

function renderAlerts() {
  if (!W.alerts) return;
  const al = data("alerts"), card = $("c-alerts");
  if (!al || (!al.count && !al.nie_message)) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");
  const title = (a) => a.category === "power" ? `Power cut · ${a.postcodes || "area"}${a.customers ? " · " + a.customers + " homes" : ""}` : (a.headline || a.title);
  const col = { high: "var(--bad)", medium: "#eab308", low: "#64748b" };
  const rows = [...al.power.map((a) => ({ ...a, category: "power" })), ...al.traffic.map((a) => ({ ...a, category: "traffic" }))];
  $("m-alerts").innerHTML = (al.nie_message ? `<p class="soon" style="font-size:14px">${esc(al.nie_message)}</p>` : "") + rows.slice(0, 6).map((a) =>
    `<div class="li"><div class="ico"><span class="dot" style="background:${col[a.severity]}"></span></div><div>${a.category === "power" ? "⚡ " : ""}${esc(title(a))}${a.near_home ? ' <span class="soon">near home</span>' : ""}
      <div class="muted" style="font-size:13px">${a.category === "power" ? esc(a.status) + " · restore " + esc(a.restore || "?") : a.from ? "Works " + esc(a.from.slice(11)) + "–" + esc(a.to.slice(11)) + " " + esc(a.to.slice(0, 10)) : esc((a.detail || "").slice(0, 140))}</div></div></div>`).join("") +
    (rows.length > 6 ? `<p class="muted" style="font-size:13px">+${rows.length - 6} more</p>` : "");
}

function renderToday() {
  const out = [], b = data("bins"), c = data("clubs"), f = data("family"), ev = data("events"), nb = data("nearby");
  if (W.bins && (b)) {
    const dots = (bs) => bs.map((x) => `<span class="bin ${x}"></span>`).join("");
    out.push(`<div class="li"><div class="ico">🗑️</div><div>${b.days === 0 ? "<b>Bin day today</b>" : b.days === 1 ? "<b>Bins out tonight</b>" : "Bins Sunday"}: ${dots(b.bins)}${esc(b.label)}
      <span class="muted"> · then ${dots(b.following.bins)}${esc(b.following.label)}</span></div></div>`);
  }
  if (W.clubs && (c)) {
    const list = c.show === "today" ? c.today : c.tomorrow;
    const rows = list.map((e) => {
      let st = "";
      if (c.show === "today") st = e.status === "now" ? ' <span class="now">● now</span>' : (e.status === "upcoming" && e.starts_in_min != null && e.starts_in_min <= 60 ? ` <span class="soon">in ${e.starts_in_min} min</span>` : "");
      return `<div><span class="chip" style="background:${e.colour}">${esc(e.who)}</span><span class="${e.status === "done" && c.show === "today" ? "done" : ""}">${esc(e.what)}</span> <span class="muted">${clubTime(e)}${e.where && !e.what.includes(e.where) ? " · " + esc(e.where) : ""}</span>${st}</div>`;
    }).join("");
    out.push(`<div class="li"><div class="ico">🎒</div><div style="flex:1"><div class="muted" style="font-size:13px">${c.show === "today" ? "Today" : "Tomorrow"}</div>${rows || '<span class="muted">No clubs</span>'}
      <button class="more" data-act="week">The kids' week</button></div></div>`);
  }
  if (W.birthdays && (f && f.soon && f.soon.length)) {
    const s = f.soon[0];
    out.push(`<div class="li"><div class="ico">🎈</div><div>${esc(s.name)}'s ${s.ordinal ? s.ordinal + " " : ""}birthday ${s.days === 1 ? "is tomorrow" : "in " + s.days + " days"}</div></div>`);
  }
  const soon = [];
  (ev && ev.items || []).forEach((e) => { if (local(e.start) - Date.now() < 36 * 3600e3) soon.push({ kind: "event", name: e.name, title: e.name, when: e.start, place: ev.venue, summary: e.summary, src: ev.venue, url: e.url }); });
  (nb && nb.items || []).filter((e) => !e.ongoing && e.near).slice(0, 3).forEach((e) => soon.push({ kind: "event", name: e.name, title: e.name, when: e.start, end: e.end, place: e.place, image: e.image, summary: e.summary, src: e.source, url: e.url }));
  TODAY_EVENTS = soon.slice(0, 4);
  if (W.events && (soon.length)) {
    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    out.push(`<div class="li"><div class="ico">📍</div><div>${soon.slice(0, 4).map((e) => { const d = local(e.when); const when = d < today0 ? "on now" : DAYS[d.getDay()] + " " + d.getDate() + (d.getHours() ? " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) : ""); return `<div class="ev-link" data-ev="${TODAY_EVENTS.indexOf(e)}">${esc(e.name)} <span class="muted">· ${when} · ${esc((e.place || "").split(",")[0])}</span> <span class="go">›</span></div>`; }).join("")}</div></div>`);
  }
  $("m-today").innerHTML = out.join("") || '<span class="muted">Nothing on</span>';
}

function solarSvg(hist) {
  if (!hist || hist.length < 2) return "";
  const W = 340, H = 140, L = 30, T = 6, B = 18, pw = W - L - 6, ph = H - T - B;
  const d0 = new Date(hist[0].t * 1000); d0.setHours(0, 0, 0, 0); const t0 = d0 / 1000;
  let max = 1000; hist.forEach((h) => { max = Math.max(max, h.pv, h.home, Math.max(h.grid, 0)); }); max = Math.ceil(max / 1000) * 1000;
  const x = (t) => L + (t - t0) / 86400 * pw, y = (v) => T + ph - Math.max(0, v) / max * ph;
  const path = (k) => hist.map((h, i) => (i ? "L" : "M") + x(h.t).toFixed(1) + " " + y(h[k]).toFixed(1)).join(" ");
  let g = "";
  for (let k = 0; k <= 2; k++) { const gy = T + ph - ph * k / 2; g += `<line x1="${L}" y1="${gy}" x2="${L + pw}" y2="${gy}" stroke="rgba(255,255,255,${k ? .07 : .2})"/><text x="${L - 4}" y="${gy + 4}" font-size="10" fill="#8a94a6" text-anchor="end">${k ? (max * k / 2000).toFixed(1).replace(".0", "") + "k" : 0}</text>`; }
  for (let k = 0; k <= 24; k += 6) g += `<text x="${x(t0 + k * 3600)}" y="${H - 4}" font-size="10" fill="#8a94a6" text-anchor="middle">${pad(k % 24)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}<path d="${path("pv")} L${x(hist[hist.length - 1].t)} ${T + ph} L${x(hist[0].t)} ${T + ph} Z" fill="var(--solar)" fill-opacity=".2"/>
    <path d="${path("grid")}" fill="none" stroke="var(--grid)" stroke-width="1.6"/><path d="${path("home")}" fill="none" stroke="var(--home)" stroke-width="1.6"/>
    <path d="${path("pv")}" fill="none" stroke="var(--solar)" stroke-width="1.8"/></svg>
    <div class="legend"><i style="background:var(--solar)"></i>Panels<i style="background:var(--home)"></i>House<i style="background:var(--grid)"></i>Grid import</div>`;
}

function renderSolar() {
  if (!W.solar) return;
  const s = data("solar");
  if (!s) { $("m-solar").innerHTML = '<span class="muted">Waiting for SolaX…</span>'; return; }
  const t = s.today || {}, bat = s.battery_w || 0, grid = s.grid_w || 0, soc = s.soc || 0;
  $("m-solar-sub").textContent = `${(t.solar_kwh || 0).toFixed(1)} kWh made · ${(t.consumption_kwh || 0).toFixed(1)} used`;
  $("m-solar").innerHTML = `<div class="stats">
    <div class="stat"><div class="v">${watts(s.pv_w)}</div><div class="l"><span class="k" style="background:var(--solar)"></span>Panels</div></div>
    <div class="stat"><div class="v">${watts(s.home_w)}</div><div class="l"><span class="k" style="background:var(--home)"></span>House</div></div>
    <div class="stat"><div class="v">${s.soc ?? "–"}%</div><div class="l">${bat > 20 ? "Charging" : bat < -20 ? "Battery ↓" : "Battery"}</div></div>
    <div class="stat"><div class="v">${watts(grid)}</div><div class="l"><span class="k" style="background:var(--grid)"></span>${grid > 20 ? "Import" : grid < -20 ? "Export" : "Grid"}</div></div></div>
    <div class="bar"><div style="width:${soc}%;background:${soc >= 50 ? "var(--good)" : soc >= 20 ? "#eab308" : "var(--bad)"}"></div></div>
    <div class="muted" style="font-size:13px">${bat < -20 ? "Battery covering " + watts(bat) + (s.battery_kwh != null ? " · " + s.battery_kwh + " kWh left" : "") : bat > 20 ? "Charging at " + watts(bat) : "Battery idle"}
      · imported ${(t.imported_kwh || 0).toFixed(1)} kWh · exported ${(t.exported_kwh || 0).toFixed(1)} kWh</div>${solarSvg(s.history)}`;
}

function renderWeather() {
  if (!W.weather) return;
  const w = data("weather"); if (!w) return;
  const now = Date.now();
  $("m-hourly").innerHTML = w.hourly.filter((h) => local(h.time) >= now - 3600e3).slice(0, 24).map((h, i) =>
    `<div class="hour"><div class="muted" style="font-size:12px">${i ? pad(local(h.time).getHours()) : "Now"}</div><div class="e">${wxIcon(h.icon, h.day)}</div><div>${Math.round(h.temp)}°</div><div class="p">${h.pop >= 20 ? h.pop + "%" : ""}</div><div class="w">${Math.round(h.wind)}</div></div>`).join("");
  $("m-daily").innerHTML = w.daily.slice(1, 6).map((d) => { const dd = local(d.date); return `<div class="day"><div>${DAYS[dd.getDay()]}</div><div>${wxIcon(d.icon, true)}</div>
    <div class="muted" style="font-size:13px">${esc(d.label)}${d.pop >= 20 ? " · " + d.pop + "%" : ""} · ${esc(d.compass)} ${Math.round(d.wind)}–${Math.round(d.gust)}</div><div><b>${Math.round(d.max)}°</b> <span class="muted">${Math.round(d.min)}°</span></div></div>`; }).join("");
  if (w.daily[0]) $("m-sun").textContent = `☀ ${w.daily[0].sunrise} – ${w.daily[0].sunset}`;
}

function renderPier() {
  if (!W.marine) return;
  const m = data("marine"), p = data("pier"), w = data("weather"); let h = "";
  if (w) { const wd = w.now.wind; h += `<div class="li"><div class="ico">💨</div><div>${Math.round(wd.speed)} mph from the ${esc(wd.compass)}, gusting ${Math.round(wd.gust)} <span class="muted">· Force ${wd.force} ${esc(wd.force_name)}</span></div></div>`; }
  if (m) h += `<div class="li"><div class="ico">🌊</div><div>High water <b>${m.next_high ? m.next_high.time : "–"}</b> · low <b>${m.next_low ? m.next_low.time : "–"}</b> <span class="muted">· ${m.rising ? "rising" : "falling"}${m.sea_temp != null ? " · sea " + Math.round(m.sea_temp) + "°" : ""}</span></div></div>`;
  if (p) h += `<div class="li"><div class="ico">🎣</div><div>Fishing: <b>${p.verdict.level}</b>${p.verdict.window ? ` <span class="muted">· best ${p.verdict.window}</span>` : ""}<div class="muted" style="font-size:13px">In season: ${p.fish.slice(0, 6).map((f) => esc(f.name)).join(", ")}</div></div></div>`;
  $("m-pier").innerHTML = h + (m || p ? '<button class="more" data-act="pier">Tide times &amp; fishing guide</button>' : "");
}

function pierSheet() {
  const m = data("marine"), p = data("pier"), w = data("weather");
  let h = "";
  if (w) { const wd = w.now.wind; h += `<h1>Wind</h1><p>${Math.round(wd.speed)} mph from the ${esc(wd.compass)} (${Math.round(wd.dir)}°), gusting ${Math.round(wd.gust)} mph — Force ${wd.force}, ${esc(wd.force_name)}.</p>`; }
  if (m) {
    h += `<h1>Tides off ${esc(CONF.marine_place)}</h1>` + (m.events || []).map((e) => `<div class="li"><div class="ico">${e.kind === "high" ? "▲" : "▼"}</div><div style="flex:1">${e.kind === "high" ? "High water" : "Low water"}</div><div class="muted">${esc(e.day)}</div><div style="width:60px;text-align:right"><b>${esc(e.time)}</b></div></div>`).join("") +
      `<p class="muted" style="font-size:14px">${m.rising ? "Rising" : "Falling"} now${m.waves != null ? " · waves " + m.waves.toFixed(1) + " m" : ""}${m.sea_temp != null ? " · sea " + m.sea_temp.toFixed(1) + "°C" : ""}. Modelled times (±20 min) — check official local tide tables before relying on them.</p>`;
  }
  if (p) {
    h += `<h1>Fishing now: ${esc(p.verdict.level)}</h1><p>${esc(p.verdict.notes.join(" · "))}${p.verdict.window ? `<br>Best around high water: <b>${esc(p.verdict.window)}</b>` : ""}${p.verdict.dusk ? ` · sunset ${esc(p.verdict.dusk)}` : ""}</p>
      <h1>In season in ${esc(p.month)}</h1>` + p.fish.map((f) => `<div class="li"><div class="ico">${f.best ? "★" : "🐟"}</div><div><b>${esc(f.name)}</b>${f.best ? ' <span class="soon">peak</span>' : ""}<div class="muted" style="font-size:14px">${esc(f.tip)}</div></div></div>`).join("");
  }
  openSheet("Wind, tides & fishing", h || '<p class="muted">No marine data yet.</p>');
}

let TABS = [["All"]];   // [label, source, isEvents] — rebuilt from config
function feedItems() {
  const t = TABS[feedTab];
  if (t[2]) {
    const ev = data("events"), nb = data("nearby"), out = [];
    (ev && ev.items || []).forEach((e) => out.push({ kind: "event", title: e.name, when: e.start, place: ev.venue, summary: e.summary, src: ev.venue, url: e.url }));
    (nb && nb.items || []).forEach((e) => out.push({ kind: "event", title: e.name, when: e.start, end: e.end, place: (e.place || "").split(",")[0], image: e.image, summary: e.summary, src: e.source, ongoing: e.ongoing, url: e.url }));
    return out;
  }
  return ((data("news") || {}).items || []).filter((n) => !t[1] || n.source === t[1]).map((n) => Object.assign({ kind: "news" }, n));
}
function renderFeed() {
  if (!W.news) return;
  $("m-tabs").innerHTML = TABS.map((t, i) => `<button class="${i === feedTab ? "on" : ""}" data-tab="${i}">${t[0]}</button>`).join("");
  const items = feedItems();
  $("m-feed").innerHTML = items.slice(0, feedShown).map((it, i) => {
    const th = it.image ? `style="background-image:url('${img(it.image, 240)}')"` : "";
    let meta;
    if (it.kind === "news") meta = `<span class="src ${it.local ? "" : "bbc"}">${esc((CONF.news_tabs.find((t) => t.source === it.source) || { label: it.source }).label)}</span>${ago(it.ts)}`;
    else { const d = local(it.when), t0 = new Date(); t0.setHours(0, 0, 0, 0); meta = `<span class="src">${esc(it.src || "Event")}</span>${it.ongoing ? "ongoing" : d < t0 ? "on now" : DAYS[d.getDay()] + " " + d.getDate() + " " + MONTHS[d.getMonth()] + (d.getHours() ? " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) : "")}${it.place ? " · " + esc(it.place) : ""}`; }
    return `<div class="item" data-i="${i}"><div class="th" ${th}></div><div><div class="tt">${esc(it.title)}</div><div class="mm">${meta}</div></div></div>`;
  }).join("") + (items.length > feedShown ? `<button class="more" data-act="more">Show more (${items.length - feedShown})</button>` : "") + (items.length ? "" : '<p class="muted">Nothing here right now.</p>');
}

function openSheet(title, html) { $("sheet-title").textContent = title; $("sheet-body").innerHTML = html; $("sheet").classList.remove("hidden"); $("sheet").scrollTop = 0; history.pushState({ sheet: 1 }, ""); }
function closeSheet() { $("sheet").classList.add("hidden"); }
window.addEventListener("popstate", closeSheet);
$("sheet-close").addEventListener("click", () => history.back());

const origLink = (u) => u ? `<p style="margin-top:22px"><a href="${esc(u)}" target="_blank" rel="noopener">Open the original ↗</a></p>` : "";
async function openItem(it) {
  if (it.kind === "event") {
    openSheet(it.title, (it.image ? `<img src="${img(it.image, 960)}">` : "") + `<h1>${esc(it.title)}</h1><p class="muted">${esc(it.place || "")}</p><p>${esc(it.summary || "")}</p>` + origLink(it.url));
    return;
  }
  if (/facebook\.com/.test(it.link || "")) {
    openSheet(it.source, `<h1>${esc(it.title)}</h1><p>${esc(it.text || it.summary)}</p>` + (it.images || (it.image ? [it.image] : [])).map((u) => `<img src="${img(u, 960)}">`).join("") + origLink(it.link));
    return;
  }
  openSheet(it.source, `<h1>${esc(it.title)}</h1><p class="muted">Loading…</p>`);
  try {
    const a = await (await fetch("/api/article?url=" + encodeURIComponent(it.link))).json();
    let h = (it.image ? `<img src="${img(it.image, 960)}">` : "") + `<h1>${esc(it.title)}</h1>`;
    if (a.pdf) {
      const info = await (await fetch("/api/pdfinfo?u=" + encodeURIComponent(a.pdf))).json();
      h = `<h1>${esc(it.title)}</h1>` + Array.from({ length: Math.min(info.pages || 0, 30) }, (_, p) => `<img src="/pdfpage?u=${encodeURIComponent(a.pdf)}&p=${p}&w=1200" loading="lazy">`).join("") + `<p><a href="${esc(a.pdf)}">Open the PDF</a></p>`;
    } else if (a.paragraphs && a.paragraphs.length) h += a.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("");
    else h += `<p>${esc(it.summary)}</p>`;
    $("sheet-body").innerHTML = h + origLink(it.link);
  } catch (e) { $("sheet-body").innerHTML += '<p class="muted">Couldn\'t load the story.</p>'; }
}

function weekSheet() {
  const c = data("clubs"); if (!c) return;
  openSheet("The kids' week", c.week.map((d, i) => `<h1 style="font-size:17px;margin:14px 0 6px">${i === 0 ? "Today" : i === 1 ? "Tomorrow" : { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" }[d.day]}</h1>` +
    (d.clubs.map((e) => `<div><span class="chip" style="background:${e.colour}">${esc(e.who)}</span>${esc(e.what)} <span class="muted">${clubTime(e)}${e.where && !e.what.includes(e.where) ? " · " + esc(e.where) : ""}</span></div>`).join("") || '<span class="muted">—</span>')).join(""));
}

function renderPlex() {
  if (!W.plex) return;
  const p = data("plex"); if (!p) return;
  if (p.playing.length) {
    $("m-plex-title").textContent = "Plex · now playing";
    $("m-plex").innerHTML = p.playing.map((s) => `<div class="np">${s.art ? `<img src="/img?p=${encodeURIComponent(s.art)}&w=180&h=270">` : ""}<div style="flex:1"><b>${esc(s.title)}</b><div class="muted">${esc(s.subtitle)}</div>
      <div class="muted" style="font-size:13px;margin-top:6px">${esc(s.user)} · ${esc(s.player)}${s.state === "paused" ? " · paused" : ""}</div><div class="prog"><div style="width:${Math.round(s.progress * 100)}%"></div></div>
      ${s.remaining_min != null ? `<div class="muted" style="font-size:12px;margin-top:4px">${s.remaining_min} min left</div>` : ""}</div></div>`).join("");
  } else {
    $("m-plex-title").textContent = "Plex · recently added";
    $("m-plex").innerHTML = p.recent.map((r) => `<div class="poster">${r.art ? `<img src="/img?p=${encodeURIComponent(r.art)}&w=208&h=312">` : ""}<div class="c">${esc(r.title)}</div></div>`).join("");
  }
}

function renderNet() {
  if (!W.network) return;
  const h = data("hub"), l = data("latency"); if (!h && !l) return;
  const up = l ? l.internet : h && h.broadband === "Connected";
  $("m-net").innerHTML = `<div class="stats" style="grid-template-columns:repeat(3,1fr)">
    <div class="stat"><div class="v"><span class="dot ${up ? "" : "bad"}"></span>${up ? "Online" : "Offline"}</div><div class="l">${l && l.ms != null ? Math.round(l.ms) + " ms" : ""}</div></div>
    <div class="stat"><div class="v">↓ ${rate(h && h.rate_down)}</div><div class="l">↑ ${rate(h && h.rate_up)}</div></div>
    <div class="stat"><div class="v">${h ? h.online : "–"}</div><div class="l">devices</div></div></div>
    <div class="muted" style="font-size:13px;margin-top:8px">${h && h.busiest && h.busiest[0] ? "Busiest: " + esc(h.busiest[0].name) + " (" + rate(h.busiest[0].down + h.busiest[0].up) + ")" : ""}
    ${l ? " · " + Object.keys(l.services).map((k) => `<span class="dot ${l.services[k] ? "" : "bad"}" style="width:8px;height:8px;margin:0 3px 0 6px"></span>${esc(k)}`).join("") : ""}</div>`;
}

document.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-tab]");
  if (tab) { feedTab = +tab.dataset.tab; feedShown = 8; renderFeed(); return; }
  const act = e.target.closest("[data-act]");
  if (act && act.dataset.act === "more") { feedShown += 10; renderFeed(); return; }
  if (act && act.dataset.act === "week") { weekSheet(); return; }
  if (act && act.dataset.act === "pier") { pierSheet(); return; }
  const evl = e.target.closest(".ev-link");
  if (evl && TODAY_EVENTS[+evl.dataset.ev]) { openItem(TODAY_EVENTS[+evl.dataset.ev]); return; }
  if (e.target.closest("#c-pier") && !e.target.closest("button")) { pierSheet(); return; }
  const it = e.target.closest(".item");
  if (it) openItem(feedItems()[+it.dataset.i]);
});

async function poll() {
  try {
    S = await (await fetch("/api/state?t=" + Date.now())).json();
    [renderTop, renderNotes, renderAlerts, renderToday, renderSolar, renderWeather, renderPier, renderFeed, renderPlex, renderNet].forEach((f) => { try { f(); } catch (err) { console.log(f.name, err); } });
    $("m-updated").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  } catch (e) { $("m-updated").textContent = "offline"; }
}
function applyConfig(c) {
  CONF = c; W = c.widgets || {};
  if (c.household.title) document.title = c.household.title;
  TABS = [["All"], ...(c.news_tabs || []).map((t) => [t.label, t.source]), ...(W.events ? [["Events", null, true]] : [])];
  $("m-route").textContent = c.alerts_route_label || "";
  const hide = { weather: "c-weather", marine: "c-pier", news: "c-feed", plex: "c-plex", network: "c-net", solar: "c-solar", alerts: "c-alerts", notes: "c-notes" };
  for (const [k, id] of Object.entries(hide)) if (!W[k]) $(id).remove();
}
clock(); setInterval(clock, 10000);
fetch("/api/config").then((r) => r.json()).then(applyConfig).catch(() => {}).finally(() => { poll(); setInterval(poll, 30000); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
