/* House Dashboard TV shell: hosts the dashboard (served by the homedash backend) full-screen.
   Kept in an external file: the Tizen app CSP refuses inline scripts and styles. */
(function () {
  // The dashboard is served by the homedash backend; this shell only hosts it full-screen.
  var URL = "{{DASHBOARD_URL}}";
  var frame = document.getElementById("dash"), msg = document.getElementById("msg");

  function check() {
    var x = new XMLHttpRequest();
    x.open("GET", URL + "health?t=" + Date.now(), true);
    x.timeout = 5000;
    x.onload = function () {
      if (x.status === 200) {
        msg.style.display = "none";
        if (!frame.getAttribute("src")) { frame.setAttribute("src", URL); }
      } else { down(); }
    };
    x.onerror = x.ontimeout = down;
    x.send();
  }
  function down() { msg.style.display = "block"; frame.removeAttribute("src"); }
  check();
  setInterval(check, 30000);

  try { webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF); } catch (e) {}

  // keys go to the dashboard inside the iframe
  frame.onload = function () { try { frame.contentWindow.focus(); } catch (e) {} };

  // Launch an installed TV app: first by exact name, then by partial name, then known app IDs.
  function launchApp(names, ids) {
    // exact app IDs first (most reliable), then names
    function byName() {
    try {
      tizen.application.getAppsInfo(function (apps) {
        var lower = [], i, j;
        for (j = 0; j < names.length; j++) { lower.push(names[j].toLowerCase()); }
        for (j = 0; j < lower.length; j++) {
          for (i = 0; i < apps.length; i++) { if ((apps[i].name || "").toLowerCase() === lower[j]) { tizen.application.launch(apps[i].id); return; } }
        }
        for (j = 0; j < lower.length; j++) {
          for (i = 0; i < apps.length; i++) { if ((apps[i].name || "").toLowerCase().indexOf(lower[j]) >= 0) { tizen.application.launch(apps[i].id); return; } }
        }
      }, function () {});
    } catch (e) {}
    }
    function tryIds(i) {
      if (i >= ids.length) { byName(); return; }
      try { tizen.application.launch(ids[i], null, function () { tryIds(i + 1); }); } catch (e) { tryIds(i + 1); }
    }
    tryIds(0);
  }

  // Requests from the dashboard (it can't call Tizen APIs itself from inside the iframe)
  window.addEventListener("message", function (ev) {
    var m;
    try { m = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch (e) { return; }
    if (!m || !m.homedash) { return; }
    if (m.action === "exit") {
      try { tizen.application.getCurrentApplication().exit(); } catch (e) {}
    } else if (m.action === "launch" && m.payload) {
      launchApp(m.payload.names || (m.payload.name ? [m.payload.name] : []), m.payload.ids || []);
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 10009) { try { tizen.application.getCurrentApplication().exit(); } catch (err) {} }   // Back
    if (e.keyCode === 13) { frame.setAttribute("src", URL + "?r=" + Date.now()); }                          // OK = reload
  });
})();
