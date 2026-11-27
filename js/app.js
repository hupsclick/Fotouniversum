"use strict";
(function () {
  const APP_VERSION = "1.1.0"; /* identisch mit VERSION in sw.js halten */
  const $ = id => document.getElementById(id);
  const video = $("video"), statusEl = $("status"), toast = $("toast");

  let stream = null, track = null, caps = {}, settings = {};
  let facing = "environment", modes = [], mode = null, busy = false;
  let peak = 1, count = 0;
  let videoDevices = []; // list of {deviceId, label, facingMode?}
  let currentDeviceId = null;

  // Eingebettete Standard-Modi (funktioniert auch unter file:// ohne CORS-Probleme)
  const DEFAULT_MODES = [
    { "id": "auto", "label": "Auto", "hint": "Dauerhafter Autofokus für alltägliche Motive.",
      "focus": "continuous", "zoom": 1, "exposure": "continuous", "burst": 1, "still": true },
    { "id": "fast", "label": "Schnell", "hint": "Kurze Belichtung (ca. 1/1000 s) und Serie: das schärfste Bild wird automatisch gewählt.",
      "focus": "continuous", "zoom": 1, "exposure": "fast", "shutter100us": 10, "isoShare": 0.6, "burst": 6, "still": false, "fps": 60 },
    { "id": "macro", "label": "Makro", "hint": "Fokus auf Nahdistanz. Gerät ruhig halten und mit dem Fokus-Regler feinjustieren.",
      "focus": "near", "zoom": 1, "exposure": "continuous", "burst": 3, "still": true },
    { "id": "far", "label": "Fern", "hint": "Fokus auf Unendlich mit Zoom. Für ruhige Aufnahmen Gerät abstützen.",
      "focus": "far", "zoomShare": 0.35, "exposure": "continuous", "burst": 3, "still": true }
  ];

  $("year").textContent = new Date().getFullYear();
  $("ver").textContent = APP_VERSION;

  /* ---------- Uhrzeit & Datum ---------- */
  function tick() {
    const n = new Date();
    $("clockTime").textContent = n.toLocaleTimeString("de-DE");
    $("clockDate").textContent = n.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" });
  }
  tick(); setInterval(tick, 1000);

  function say(t) { statusEl.textContent = t; }
  function note(t, ms) { toast.textContent = t; toast.hidden = false; clearTimeout(note.t); if (ms) note.t = setTimeout(() => toast.hidden = true, ms); }

  /* ---------- Geräte auflisten ---------- */
  async function refreshDevices() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
      const all = await navigator.mediaDevices.enumerateDevices();
      videoDevices = all.filter(d => d.kind === "videoinput");
      // Auf manchen Systemen sind Labels erst nach getUserMedia sichtbar
      if (videoDevices.length && !videoDevices[0].label) {
        // Labels bleiben leer bis Permission erteilt – ok
      }
    } catch (e) {
      videoDevices = [];
    }
  }

  /* ---------- Kamera ---------- */
  async function startCamera(preferredDeviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      say("Kamera nicht verfügbar. Bitte über HTTPS oder localhost öffnen."); return;
    }
    stopCamera();
    say("Kamera wird gestartet …");

    // Constraints bauen: bevorzugt deviceId, sonst facingMode
    const constraints = {
      audio: false,
      video: {
        width: { ideal: 4096 },
        height: { ideal: 2160 },
        frameRate: { ideal: 60 }
      }
    };

    if (preferredDeviceId) {
      constraints.video.deviceId = { exact: preferredDeviceId };
    } else {
      constraints.video.facingMode = { ideal: facing };
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      // Fallback: ohne exact / ohne facingMode versuchen
      try {
        const fallback = {
          audio: false,
          video: preferredDeviceId
            ? { deviceId: preferredDeviceId }
            : { facingMode: facing }
        };
        stream = await navigator.mediaDevices.getUserMedia(fallback);
      } catch (e2) {
        // Letzter Versuch: irgendeine Kamera
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
        } catch (e3) {
          say(e3.name === "NotAllowedError"
            ? "Kamerazugriff verweigert. Bitte in den Browser-Einstellungen erlauben."
            : "Kamera konnte nicht gestartet werden: " + e3.message);
          return;
        }
      }
    }

    video.srcObject = stream;
    track = stream.getVideoTracks()[0];
    const settingsNow = track.getSettings ? track.getSettings() : {};
    currentDeviceId = settingsNow.deviceId || preferredDeviceId || null;
    if (settingsNow.facingMode) facing = settingsNow.facingMode;

    caps = track.getCapabilities ? track.getCapabilities() : {};
    settings = settingsNow;

    await video.play().catch(() => {});
    await refreshDevices(); // Labels jetzt ggf. verfügbar
    say("Bereit" + (videoDevices.length > 1 ? ` · ${videoDevices.length} Kameras` : ""));
    buildSliders();
    // Modus anwenden – falls noch keiner gewählt, den ersten nehmen
    const m = mode || (modes.length ? modes[0] : null);
    if (m) applyMode(m);
    else say("Bereit (keine Modi geladen)");
  }

  function stopCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());
    stream = track = null;
    caps = {};
    settings = {};
  }

  async function apply(c) {
    if (!track) return;
    for (const k in c) {
      try {
        await track.applyConstraints({ advanced: [{ [k]: c[k] }] });
      } catch (e) { /* Capability nicht unterstützt – still */ }
    }
    settings = track.getSettings ? track.getSettings() : {};
  }

  /* ---------- Regler ---------- */
  // Interne Position 0..1000; Belichtung/ISO logarithmisch -> feinfühlig im unteren Bereich
  const POS = 1000;
  const sl = {
    zoom: { el: $("zoom"), row: $("rowZoom"), out: $("zoomOut"), fmt: v => (+v).toFixed(1) + "×" },
    focusDistance: { el: $("focus"), row: $("rowFocus"), out: $("focusOut"), fmt: v => (+v).toFixed(2) + " m" },
    exposureTime: { el: $("exp"), row: $("rowExp"), out: $("expOut"), log: true, fmt: v => "1/" + Math.round(10000 / Math.max(+v, 0.0001)) + " s" },
    iso: { el: $("iso"), row: $("rowIso"), out: $("isoOut"), log: true, fmt: v => Math.round(v) }
  };
  const sliderById = {};
  for (const k in sl) sliderById[sl[k].el.id] = k;

  function posToVal(s, p) {
    const f = p / POS;
    if (s.log && s.min > 0) return s.min * Math.pow(s.max / s.min, f);
    return s.min + (s.max - s.min) * f;
  }
  function valToPos(s, v) {
    v = Math.max(s.min, Math.min(s.max, +v));
    if (s.max === s.min) return 0;
    if (s.log && s.min > 0) return Math.round(POS * Math.log(v / s.min) / Math.log(s.max / s.min));
    return Math.round(POS * (v - s.min) / (s.max - s.min));
  }
  function snap(s, v) {
    if (s.step > 0 && !s.log) v = s.min + Math.round((v - s.min) / s.step) * s.step;
    return Math.max(s.min, Math.min(s.max, v));
  }
  function paint(s) { s.el.style.setProperty("--fill", (s.el.value / POS * 100) + "%"); }

  // Nur der jeweils neueste Wert wird angewendet -> keine Verzögerung beim Ziehen
  const pending = {}; let pumping = false;
  async function pump() {
    if (pumping) return; pumping = true;
    while (Object.keys(pending).length) {
      const k = Object.keys(pending)[0], adv = pending[k]; delete pending[k];
      await apply(adv);
    }
    pumping = false;
  }

  function buildSliders() {
    for (const k in sl) {
      const s = sl[k], c = caps[k];
      const supported = c && typeof c.min === "number" && c.max > c.min;
      s.row.hidden = !supported;
      if (!supported) continue;
      s.min = c.min; s.max = c.max; s.step = c.step || 0;
      s.el.min = 0; s.el.max = POS; s.el.step = 1;
      const cur = (settings[k] != null ? settings[k] : c.min);
      s.el.value = valToPos(s, cur);
      s.out.textContent = s.fmt(cur);
      paint(s);
      s.el.oninput = () => {
        const v = snap(s, posToVal(s, +s.el.value));
        s.out.textContent = s.fmt(v);
        paint(s);
        const adv = {};
        if (k === "focusDistance") adv.focusMode = "manual";
        if (k === "exposureTime" || k === "iso") adv.exposureMode = "manual";
        adv[k] = v;
        pending[k] = adv; pump();
      };
    }
  }

  function setSlider(k, v) {
    const s = sl[k];
    if (s && !s.row.hidden) {
      s.el.value = valToPos(s, v);
      s.out.textContent = s.fmt(v);
      paint(s);
    }
  }

  // +/- Tasten (mit Dauerdruck-Wiederholung) für Feineinstellung
  document.querySelectorAll(".step").forEach(btn => {
    let timer = null, rep = null;
    const go = () => {
      const k = sliderById[btn.dataset.for], s = sl[k];
      if (!s || s.row.hidden) return;
      const d = +btn.dataset.dir * 10; // 1 % pro Schritt
      s.el.value = Math.max(0, Math.min(POS, +s.el.value + d));
      s.el.oninput && s.el.oninput();
    };
    const stop = () => { clearTimeout(timer); clearInterval(rep); };
    btn.addEventListener("pointerdown", e => { e.preventDefault(); go(); timer = setTimeout(() => { rep = setInterval(go, 70); }, 380); });
    ["pointerup", "pointerleave", "pointercancel"].forEach(ev => btn.addEventListener(ev, stop));
    btn.addEventListener("contextmenu", e => e.preventDefault());
  });

  /* ---------- Pinch-Zoom auf der Vorschau ---------- */
  (function () {
    const stage = $("stage"), pts = new Map(); let d0 = 0, z0 = 1, hideT = null;
    const dist = () => { const a = [...pts.values()]; return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y); };
    stage.addEventListener("pointerdown", e => {
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && sl.zoom && !sl.zoom.row.hidden) { d0 = dist(); z0 = snap(sl.zoom, posToVal(sl.zoom, +sl.zoom.el.value)); }
    });
    stage.addEventListener("pointermove", e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const s = sl.zoom;
      if (pts.size !== 2 || !s || s.row.hidden || !d0) return;
      const v = Math.max(s.min, Math.min(s.max, z0 * dist() / d0));
      s.el.value = valToPos(s, v);
      s.el.oninput();
      const b = $("zoomBadge"); b.textContent = s.fmt(v); b.hidden = false;
      clearTimeout(hideT); hideT = setTimeout(() => b.hidden = true, 900);
    });
    const up = e => { pts.delete(e.pointerId); if (pts.size < 2) d0 = 0; };
    ["pointerup", "pointercancel", "pointerleave"].forEach(ev => stage.addEventListener(ev, up));
    // Tippen auf die Vorschau schließt das Einstellungsfenster
    stage.addEventListener("click", () => setSheet(false));
  })();

  /* ---------- Einstellungsfenster (Bottom-Sheet) ---------- */
  function syncDock() { document.documentElement.style.setProperty("--dock-h", document.querySelector(".dock").offsetHeight + "px"); }
  function setSheet(open, tab) {
    const sh = $("sheet");
    if (tab) showTab(tab);
    sh.hidden = !open;
    $("settingsBtn").setAttribute("aria-expanded", open && (tab || curTab) === "ctrl" ? "true" : "false");
    syncDock();
  }
  let curTab = "ctrl";
  function showTab(t) {
    curTab = t;
    document.querySelectorAll(".tab").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"));
    document.querySelectorAll(".pane").forEach(p => p.hidden = p.dataset.pane !== t);
  }
  document.querySelectorAll(".tab").forEach(b => b.onclick = () => { showTab(b.dataset.tab); $("settingsBtn").setAttribute("aria-expanded", b.dataset.tab === "ctrl" ? "true" : "false"); });
  $("settingsBtn").onclick = () => { const open = $("sheet").hidden || curTab !== "ctrl"; setSheet(open, "ctrl"); };
  $("galleryBtn").onclick = () => { const open = $("sheet").hidden || curTab !== "gal"; setSheet(open, "gal"); };
  $("sheetClose").onclick = () => setSheet(false);
  window.addEventListener("resize", syncDock);
  window.addEventListener("orientationchange", () => setTimeout(syncDock, 200));
  syncDock();
  const has = (k, v) => caps[k] && (!v || (Array.isArray(caps[k]) ? caps[k].includes(v) : true));

  /* ---------- Modi ---------- */
  function buildModes() {
    const box = $("modes");
    box.innerHTML = "";
    modes.forEach(m => {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.textContent = m.label;
      b.dataset.id = m.id;
      b.onclick = () => applyMode(m);
      box.appendChild(b);
    });
  }

  async function applyMode(m) {
    if (!m) {
      console.warn("applyMode: kein Modus übergeben");
      return;
    }
    mode = m;
    document.querySelectorAll("#modes button").forEach(b => {
      b.setAttribute("aria-selected", b.dataset.id === m.id ? "true" : "false");
    });
    $("modeHint").textContent = m.hint || "";
    if (m.hint) note(m.label + ": " + m.hint.split(". ")[0].replace(/\.$/, ""), 2200);
    if ($("burst")) $("burst").value = String(m.burst || 1);

    if (!track) return; // Kamera noch nicht bereit – Einstellungen werden beim Start angewendet

    const c = {};
    if (m.focus === "continuous" && has("focusMode", "continuous")) c.focusMode = "continuous";
    if (m.focus === "near" && caps.focusDistance) {
      c.focusMode = "manual";
      c.focusDistance = caps.focusDistance.min;
    }
    if (m.focus === "far" && caps.focusDistance) {
      c.focusMode = "manual";
      c.focusDistance = caps.focusDistance.max;
    }
    if (m.zoom != null && caps.zoom) {
      c.zoom = Math.max(caps.zoom.min, Math.min(m.zoom, caps.zoom.max));
    }
    if (m.zoomShare != null && caps.zoom) {
      c.zoom = caps.zoom.min + (caps.zoom.max - caps.zoom.min) * m.zoomShare;
    }
    if (m.exposure === "continuous" && has("exposureMode", "continuous")) c.exposureMode = "continuous";
    if (m.exposure === "fast" && has("exposureMode", "manual") && caps.exposureTime) {
      c.exposureMode = "manual";
      c.exposureTime = Math.max(caps.exposureTime.min, Math.min(m.shutter100us || 10, caps.exposureTime.max));
      if (caps.iso) c.iso = caps.iso.min + (caps.iso.max - caps.iso.min) * (m.isoShare || 0.5);
    }
    await apply(c);
    for (const k in sl) if (c[k] != null) setSlider(k, c[k]);
    if (m.fps) {
      try { await track.applyConstraints({ frameRate: { ideal: m.fps } }); } catch (e) {}
    }
    if (m.id === "fast" && !caps.exposureTime) {
      note("Hinweis: Dieses Gerät erlaubt keine manuelle Belichtungszeit. Die Serienauswahl wird trotzdem genutzt.", 4000);
    }
  }

  /* ---------- Live-Schärfeanzeige ---------- */
  setInterval(() => {
    if (!video.videoWidth || document.hidden) return;
    const s = ImgTools.sharpness(video, video.videoWidth, video.videoHeight, 200);
    peak = Math.max(peak * 0.995, s, 1);
    $("meterFill").style.height = Math.min(100, (s / peak) * 100) + "%";
  }, 250);

  /* ---------- Aufnahme (PNG) ---------- */
  const wait = ms => new Promise(r => setTimeout(r, ms));
  function frameCanvas() {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    return c;
  }
  async function stillCanvas() {
    if (!("ImageCapture" in window) || !track) return null;
    try {
      const ic = new ImageCapture(track);
      const pc = await ic.getPhotoCapabilities();
      const opt = pc.imageWidth ? { imageWidth: pc.imageWidth.max, imageHeight: pc.imageHeight.max } : undefined;
      const blob = await ic.takePhoto(opt);
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      return c;
    } catch (e) { return null; }
  }
  const toPNG = c => new Promise(r => c.toBlob(r, "image/png"));
  function stamp() {
    const n = new Date(), p = v => String(v).padStart(2, "0");
    return `Fotouniversum_${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}_${p(n.getHours())}-${p(n.getMinutes())}-${p(n.getSeconds())}.png`;
  }
  function save(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  async function capture() {
    if (busy || !track || !video.videoWidth) return;
    busy = true;
    $("shutter").disabled = true;
    const n = +$("burst").value || 1;
    let best = null, bestScore = -1;
    try {
      if (n <= 1 && mode && mode.still) {
        say("Aufnahme …");
        best = await stillCanvas();
      }
      if (!best) {
        for (let i = 0; i < n; i++) {
          say(n > 1 ? `Serie ${i + 1}/${n} …` : "Aufnahme …");
          const c = frameCanvas();
          const s = ImgTools.sharpness(c, c.width, c.height, 320);
          if (s > bestScore) { bestScore = s; best = c; }
          if (i < n - 1) await wait(35);
        }
      }
      say("Wird als PNG gespeichert …");
      const blob = await toPNG(best);
      const name = stamp();
      $("flash").classList.add("on");
      setTimeout(() => $("flash").classList.remove("on"), 120);
      addThumb(blob, name, best.width, best.height);
      if ($("autosave").checked) save(blob, name);
      say(`Gespeichert: ${best.width}×${best.height} px · PNG`);
    } catch (e) {
      say("Fehler bei der Aufnahme: " + e.message);
    }
    busy = false;
    $("shutter").disabled = false;
  }

  function addThumb(blob, name, w, h) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.title = `${name} (${w}×${h})`;
    const img = new Image();
    img.src = url;
    img.alt = name;
    a.appendChild(img);
    const g = $("gallery");
    g.prepend(a);
    $("lastThumb").src = url; $("lastThumb").hidden = false; $("lastThumbEmpty").hidden = true;
    $("galEmpty").hidden = true;
    if (navigator.vibrate) navigator.vibrate(30);
    if (++count > 24) {
      const l = g.lastElementChild;
      if (l) { URL.revokeObjectURL(l.href); l.remove(); }
    }
  }

  $("shutter").onclick = capture;
  document.addEventListener("keydown", e => {
    if ((e.code === "Space" || e.code === "Enter") && e.target === document.body) {
      e.preventDefault();
      capture();
    }
  });

  /* ---------- Kamera wechseln (robust) ---------- */
  $("switchCam").onclick = async () => {
    if (busy) return;
    await refreshDevices();
    if (videoDevices.length <= 1) {
      // Nur eine Kamera oder Labels noch nicht da → klassischer facing-Mode-Toggle
      facing = facing === "environment" ? "user" : "environment";
      currentDeviceId = null;
      note("Wechsle zu " + (facing === "user" ? "Frontkamera" : "Rückkamera") + " …", 2000);
      startCamera();
      return;
    }
    // Mehrere Kameras: zur nächsten springen
    let idx = videoDevices.findIndex(d => d.deviceId === currentDeviceId);
    if (idx < 0) idx = 0;
    const next = videoDevices[(idx + 1) % videoDevices.length];
    currentDeviceId = next.deviceId;
    // facing aus Label/Settings schätzen
    const label = (next.label || "").toLowerCase();
    if (label.includes("front") || label.includes("user") || label.includes("facetime")) facing = "user";
    else if (label.includes("back") || label.includes("rear") || label.includes("environment")) facing = "environment";
    note("Kamera: " + (next.label || "Gerät " + ((idx + 1) % videoDevices.length + 1)), 2500);
    startCamera(next.deviceId);
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCamera();
    else if (!stream) startCamera(currentDeviceId);
  });

  /* ---------- Installation ---------- */
  let deferred = null;
  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();
    deferred = e;
    $("installBtn").hidden = false;
  });
  $("installBtn").onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $("installBtn").hidden = true;
  };
  window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });

  /* ---------- Service Worker & automatische Updates ---------- */
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloading) return;
      reloading = true;
      note("Update installiert – App wird neu geladen …");
      setTimeout(() => location.reload(), 800);
    });
    navigator.serviceWorker.register("sw.js").then(reg => {
      const check = () => reg.update().catch(() => {});
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (w) w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            note("Neue Version gefunden – wird aktiviert …");
            w.postMessage("SKIP_WAITING");
          }
        });
      });
      setInterval(check, 60 * 1000);
      document.addEventListener("visibilitychange", () => { if (!document.hidden) check(); });
      window.addEventListener("online", check);
    }).catch(() => {});
  }

  /* ---------- Start ---------- */
  // Zuerst eingebaute Modi verwenden (file:// sicher)
  modes = DEFAULT_MODES.slice();
  buildModes();

  // Optional versuchen, modes.json nachzuladen (falls über HTTP/HTTPS)
  if (location.protocol !== "file:") {
    fetch("data/modes.json")
      .then(r => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(d => {
        if (d && Array.isArray(d.modes) && d.modes.length) {
          modes = d.modes;
          buildModes();
          // aktuellen Modus aktualisieren falls vorhanden
          if (mode) {
            const found = modes.find(m => m.id === mode.id);
            if (found) applyMode(found);
          }
        }
      })
      .catch(() => { /* still – wir haben DEFAULT_MODES */ });
  }

  // Kamera starten
  startCamera();
})();
