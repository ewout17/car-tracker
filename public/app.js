const $ = (id) => document.getElementById(id);
const socket = io();

let watchId = null;
let myId = null;
let lastState = null;

let map = null;
let markers = new Map();
let selectedUserId = null;

let routeLineToSelected = null;
let routeLineToDestination = null;

let destination = null;
let destinationAlerted = false;

let selectedRouteInfo = null;
let destinationRouteInfo = null;

const routeCache = new Map();
const ROUTE_CACHE_MS = 15000;

const sheet = $("sheet");
const toast = $("toast");
let toastTimer = null;

async function ensureGeoPermission(){
  // Must be HTTPS for geolocation (Render is HTTPS). If not, explain.
  if (!window.isSecureContext) {
    showToast("Locatie werkt alleen via HTTPS.");
    alert("Locatie werkt alleen via HTTPS. Open de site via https:// (Render link).");
    return false;
  }

  // If Permissions API available, give clear guidance when denied
  try {
    if (navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: "geolocation" });
      if (p.state === "denied") {
        showToast("Locatie is geblokkeerd.");
        alert(
          "Locatie is geblokkeerd in je browser.\n\n" +
          "iPhone (Safari): Instellingen > Safari > Locatie (of: Instellingen > Privacy > Locatievoorzieningen) en zet op 'Tijdens gebruik'.\n" +
          "Android (Chrome): Site-instellingen > Locatie > Toestaan.\n\n" +
          "Tip: herlaad daarna de pagina."
        );
        return false;
      }
    }
  } catch { /* ignore */ }

  return true;
}


// Install prompt (Android/Chrome)
let deferredInstallPrompt = null;

initPrefill();
initMap();
wireSheet();
wireTabs();
maybeRegisterSW();
maybeRequestNotificationPermission();

// Install prompt hook (Chrome/Android)
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = $("installBtn");
  if (btn) btn.hidden = false;
});
$("installBtn")?.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice.catch(()=>{});
  deferredInstallPrompt = null;
  const btn = $("installBtn");
  if (btn) btn.hidden = true;
});

// Menu openers
$("openPanel")?.addEventListener("click", () => openSheet(true));
$("miniHandle")?.addEventListener("click", () => openSheet(true));
$("closePanel")?.addEventListener("click", () => openSheet(false));
$("closePanel2")?.addEventListener("click", () => openSheet(false));

$("join").addEventListener("click", () => {
  const roomCode = $("room").value.trim().toUpperCase();
  const myName = $("name").value.trim();
  const carType = $("carType").value;
  const color = $("carColor").value;

  if (!roomCode || !myName) return showToast("Vul room code en auto naam in.");

  localStorage.setItem("ski_room", roomCode);
  localStorage.setItem("ski_name", myName);
  localStorage.setItem("ski_carType", carType);
  localStorage.setItem("ski_color", color);

  if (!("geolocation" in navigator)) {
    alert("Locatie (GPS) is niet beschikbaar op dit toestel/browser.");
    return;
  }

  // Make sure permission isn't blocked + require secure context
  ensureGeoPermission().then((ok) => {
    if (!ok) return;

    navigator.geolocation.getCurrentPosition(
      () => {
        socket.emit("join", { roomCode, name: myName, carType, color });
        afterJoin(roomCode);
        openSheet(false);
        showToast("Verbonden ✅ (locatie actief)");
      },
      (err) => {
        const msg = err?.message || "Onbekende fout";
        showToast("Locatie toestemming nodig");
        alert(
          "We kunnen je locatie niet ophalen.\n\n" +
          "Fout: " + msg + "\n\n" +
          "Check:\n" +
          "1) Sta locatie toe (browser prompt)\n" +
          "2) iPhone: zet 'Precieze locatie' aan\n" +
          "3) Gebruik Safari/Chrome (geen incognito)\n" +
          "4) Herlaad de pagina"
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
    );
  });
});

function afterJoin(roomCode){
  $("start").disabled = false;
  $("share").disabled = false;
  $("pauseBtn").disabled = false;
  $("pauseBtn2") && ($("pauseBtn2").disabled = false);
  $("roomPill").textContent = `Room: ${roomCode}`;
  $("hudStatus").textContent = "Klaar om te starten";
}

$("share").addEventListener("click", async () => {
  const rc = ($("room").value || "").trim().toUpperCase();
  const nm = ($("name").value || "").trim();
  if (!rc || !nm) return showToast("Vul room + naam in.");

  const url = new URL(window.location.href);
  url.searchParams.set("room", rc);
  url.searchParams.set("name", nm);

  try {
    await navigator.clipboard.writeText(url.toString());
    showToast("Deellink gekopieerd ✅");
  } catch {
    prompt("Kopieer deze link:", url.toString());
  }
});

$("pauseBtn2")?.addEventListener("click", () => $("pauseBtn").click());

$("pauseBtn").addEventListener("click", () => {
  const txt = prompt("Pauze melding (optioneel):", "Pauze nemen");
  if (txt === null) return;
  socket.emit("pause", { text: txt || "Pauze nemen" });
});

$("start").addEventListener("click", () => {
  if (!("geolocation" in navigator)) return alert("Geolocation niet beschikbaar.");
  ensureGeoPermission().then((ok) => {
    if (!ok) return;

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, speed, heading, accuracy } = pos.coords;
      const speedKmh = speed == null ? null : speed * 3.6;

      if (isBadFix(latitude, longitude, accuracy)) {
        $("hudStatus").textContent = "Wachten op GPS-fix…";
        return;
      }

      socket.emit("pos", {
        lat: latitude,
        lon: longitude,
        speedKmh,
        heading: heading == null ? null : heading,
        ts: pos.timestamp || Date.now()
      });

      if ($("followMe").checked) map.panTo([latitude, longitude], { animate:true, duration:0.5 });

      $("hudStatus").textContent =
        `Live · ~${Math.round(accuracy)}m · ${speedKmh == null ? "—" : speedKmh.toFixed(0)+" km/u"} · ${latitude.toFixed(4)},${longitude.toFixed(4)}`;
    },
    (err) => alert("Locatie fout: " + err.message),
    { enableHighAccuracy:true, maximumAge:1000, timeout:8000 }
  );

  }); // ensureGeoPermission

  $("start").disabled = true;
  $("stop").disabled = false;
  showToast("Tracking gestart ▶");
});

$("stop").addEventListener("click", () => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("start").disabled = false;
  $("stop").disabled = true;
  $("hudStatus").textContent = "Tracking gestopt";
  showToast("Tracking gestopt ■");
});

$("followSelected").addEventListener("change", () => { if ($("followSelected").checked) $("followMe").checked = false; });
$("followMe").addEventListener("change", () => { if ($("followMe").checked) $("followSelected").checked = false; });

$("destSearch").addEventListener("click", async () => {
  const label = $("destLabel").value.trim();
  if (!label) return showToast("Vul een bestemming in.");

  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(label)}&limit=1`;
  const r = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await r.json().catch(() => []);
  if (!data?.[0]) return showToast("Geen resultaat. Probeer specifieker.");

  const lat = Number(data[0].lat);
  const lon = Number(data[0].lon);
  const nice = (data[0].display_name || label).slice(0, 80);

  socket.emit("setDestination", { label: nice, lat, lon });
  showToast("Bestemming verstuurd 📍");
});

socket.on("connect", () => { myId = socket.id; });

socket.on("state", (payload) => {
  lastState = payload;
  destination = payload.destination || null;
  updateDestinationUI(payload);
  render(payload);
});

socket.on("roomMessage", (msg) => {
  addRoomMessage(msg);

  if ($("enableAlerts").checked) {
    if (msg.type === "pause") notify("⏸ Pauze", `${msg.by} wil pauze: ${msg.text}`);
    if (msg.type === "destination") { notify("📍 Bestemming", msg.text); destinationAlerted = false; }
  }

  if (msg.type === "pause") showToast(`⏸ ${msg.by} wil pauze: ${msg.text}`);
  if (msg.type === "destination") showToast(`📍 ${msg.text}`);
});

function initPrefill() {
  const url = new URL(window.location.href);
  const qRoom = url.searchParams.get("room");
  const qName = url.searchParams.get("name");

  $("room").value = (qRoom || localStorage.getItem("ski_room") || "").toUpperCase();
  $("name").value = (qName || localStorage.getItem("ski_name") || "");
  $("carType").value = localStorage.getItem("ski_carType") || "car";
  $("carColor").value = localStorage.getItem("ski_color") || "#65B832";
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.0, 6.7], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom:19, attribution:"&copy; OpenStreetMap"
  }).addTo(map);
}

function wireSheet(){ $("sheetHandle").addEventListener("click", () => openSheet(!sheet.classList.contains("open"))); }
function openSheet(open){
  sheet.classList.toggle("open", !!open);
  sheet.setAttribute("aria-hidden", open ? "false" : "true");
}
function wireTabs(){
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const id = btn.getAttribute("data-tab");
      document.querySelectorAll(".tabPane").forEach(p => p.classList.remove("active"));
      document.getElementById(id).classList.add("active");
    });
  });
}

function showToast(text){
  toast.textContent = text;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}

function updateDestinationUI(state) {
  const isOwner = state.ownerId === myId;
  $("destSearch").disabled = !isOwner;

  if (destination) {
    $("destInfo").textContent = `Bestemming: ${destination.label}`;
    $("hudDestValue").textContent = destination.label;
  } else {
    $("destInfo").textContent = "Nog geen bestemming ingesteld.";
    $("hudDestValue").textContent = "Nog niet ingesteld";
  }
}

function addRoomMessage(msg){
  const box = $("messages");
  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `<b>${escapeHtml(msg.by || "Room")}</b> — ${escapeHtml(msg.text || "")}
    <div class="meta">${new Date(msg.ts || Date.now()).toLocaleTimeString()}</div>`;
  box.prepend(el);
  while (box.children.length > 20) box.removeChild(box.lastChild);
}

function maybeRequestNotificationPermission(){
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") Notification.requestPermission().catch(()=>{});
}
function notify(title, body){
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try { new Notification(title, { body }); } catch {}
}
function maybeRegisterSW(){
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(()=>{});
}

function render(state){
  const users = state.users || [];
  const withPos = users.filter(u => isFinite(u.lat) && isFinite(u.lon));
  const me = withPos.find(u => u.id === myId);
  const others = withPos.filter(u => u.id !== myId);

  for (const u of withPos) upsertMarker(u);

  const alive = new Set(withPos.map(u => u.id));
  for (const [id, m] of markers.entries()){
    if (!alive.has(id)){
      map.removeLayer(m);
      markers.delete(id);
    }
  }

  if ($("followSelected").checked && selectedUserId){
    const m = markers.get(selectedUserId);
    if (m) map.panTo(m.getLatLng(), { animate:true, duration:0.5 });
  }

  const list = $("list");
  list.innerHTML = "";

  if (!me){
    list.innerHTML = `<div class="hint">Start tracking om jouw GPS te delen…</div>`;
    clearRoutes();
    return;
  }

  if (!selectedUserId || !others.some(o => o.id === selectedUserId)){
    selectedUserId = others[0]?.id || null;
  }

  if ($("showRoutes").checked && destination) drawRouteToDestination(me);
  else { clearDestinationRoute(); destinationRouteInfo = null; updateRoutePanels(); }

  for (const o of others){
    const distKm = haversineKm(me.lat, me.lon, o.lat, o.lon);

    const row = document.createElement("div");
    row.className = "cardRow" + (o.id === selectedUserId ? " selected" : "");
    row.innerHTML = `
      <div class="left">
        <span class="dot" style="background:${escapeHtml(o.color || "#65B832")}"></span>
        <div style="min-width:0">
          <div class="name">${escapeHtml(o.name)}</div>
          <div class="meta">Afstand ${distKm.toFixed(1)} km · ${timeAgo(o.ts)} geleden</div>
        </div>
      </div>
      <div class="right">
        <div class="pill">${typeEmoji(o.carType)} <span id="eta-${o.id}">${o.id === selectedUserId ? "…" : "—"}</span></div>
      </div>
    `;
    row.addEventListener("click", () => {
      selectedUserId = o.id;
      focusOnUser(o.id);
      render(lastState);
      showToast(`Geselecteerd: ${o.name}`);
    });
    list.appendChild(row);

    if (o.id === selectedUserId){
      computeRouteShort(me, o).then((info) => {
        const etaEl = document.getElementById(`eta-${o.id}`);
        if (etaEl) etaEl.textContent = info.etaShort;
        selectedRouteInfo = info;
        updateRoutePanels();
        if ($("showRoutes").checked && info.geometry) drawRouteToSelected(info.geometry);
        else clearSelectedRoute();
      }).catch(() => {
        const etaEl = document.getElementById(`eta-${o.id}`);
        if (etaEl) etaEl.textContent = "—";
        selectedRouteInfo = null;
        updateRoutePanels();
        clearSelectedRoute();
      });
    }
  }
}

function focusOnUser(userId){
  const m = markers.get(userId);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 11), { animate:true });
}

function upsertMarker(u){
  const id = u.id;
  const lat = Number(u.lat), lon = Number(u.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const icon = L.divIcon({
    className: "leaflet-div-icon",
    html: `<div class="carIcon" style="background:${escapeHtml(u.color || "#65B832")}">${typeEmoji(u.carType)}</div>`,
    iconSize: [34,34],
    iconAnchor: [17,17]
  });

  const label = `${typeEmoji(u.carType)} ${u.name}`;
  const existing = markers.get(id);

  if (existing){
    existing.setLatLng([lat, lon]);
    existing.setIcon(icon);
    existing.setPopupContent(label);
  } else {
    const marker = L.marker([lat, lon], { icon }).addTo(map).bindPopup(label);
    marker.on("click", () => {
      if (id !== myId){
        selectedUserId = id;
        render(lastState);
      }
      marker.openPopup();
    });
    markers.set(id, marker);
  }
}

function clearRoutes(){ clearSelectedRoute(); clearDestinationRoute(); }
function clearSelectedRoute(){ if (routeLineToSelected){ map.removeLayer(routeLineToSelected); routeLineToSelected=null; } }
function clearDestinationRoute(){ if (routeLineToDestination){ map.removeLayer(routeLineToDestination); routeLineToDestination=null; } }

function drawRouteToSelected(geometry){
  clearSelectedRoute();
  routeLineToSelected = L.geoJSON(geometry, { weight:5, opacity:0.75 }).addTo(map);
}

async function drawRouteToDestination(me){
  if (!destination) return;

  const from = `${me.lat.toFixed(5)},${me.lon.toFixed(5)}`;
  const to = `${destination.lat.toFixed(5)},${destination.lon.toFixed(5)}`;
  const key = `DEST:${from}->${to}`;

  const data = await getRouteCached(key, from, to);
  if (!data?.ok) return;

  clearDestinationRoute();
  routeLineToDestination = L.geoJSON(data.geometry_geojson, { weight:6, opacity:0.45 }).addTo(map);
  destinationRouteInfo = { etaShort: formatDuration(data.duration_s), distanceText: formatDistance(data.distance_m), maneuvers: Array.isArray(data.maneuvers)?data.maneuvers:[] };
  updateRoutePanels();

  if ($("enableAlerts").checked) checkDestinationAlert(data.distance_m, destination.label);
}

function checkDestinationAlert(distanceMeters, label){
  const limitKm = Number($("alertKm").value || 10);
  const distKm = distanceMeters / 1000;
  if (!destinationAlerted && distKm <= limitKm){
    destinationAlerted = true;
    notify("📍 Bestemming dichtbij", `Nog ${distKm.toFixed(1)} km tot ${label}`);
    showToast(`Nog ${distKm.toFixed(1)} km tot bestemming`);
  }
}

async function computeRouteShort(me, other){
  const a = `${me.lat.toFixed(5)},${me.lon.toFixed(5)}`;
  const b = `${other.lat.toFixed(5)},${other.lon.toFixed(5)}`;

  const keyAB = `AB:${a}->${b}`;
  const ab = await getRouteCached(keyAB, a, b);

  let geometry = null;
  let etaShort = "—";
  let distanceText = "—";
  let maneuvers = [];
  if (ab?.ok){
    etaShort = formatDuration(ab.duration_s);
    distanceText = formatDistance(ab.distance_m);
    geometry = ab.geometry_geojson;
    maneuvers = Array.isArray(ab.maneuvers) ? ab.maneuvers : [];
  }
  return { etaShort, geometry, distanceText, maneuvers };
}

async function getRouteCached(cacheKey, from, to){
  const hit = routeCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < ROUTE_CACHE_MS) return hit.data;

  const url = `/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const r = await fetch(url, { cache:"no-store" });
  const data = await r.json().catch(() => ({ ok:false }));
  routeCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

function haversineKm(lat1, lon1, lat2, lon2){
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
function formatDuration(seconds){
  if (!Number.isFinite(seconds)) return "—";
  const totalMin = Math.round(seconds/60);
  const h = Math.floor(totalMin/60);
  const m = totalMin % 60;
  return h <= 0 ? `${m}m` : `${h}u ${m}m`;
}
function timeAgo(ts){
  const s = Math.max(0, Math.floor((Date.now() - (ts || Date.now()))/1000));
  if (s < 10) return "net";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m/60)}u`;
}
function typeEmoji(t){ return t === "bus" ? "🚌" : (t === "audi" ? "🚙" : "🚗"); }
function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}


function isBadFix(lat, lon, accuracy){
  // Some devices briefly return 0,0 or huge accuracy; ignore those.
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return true;
  if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return true; // Gulf of Guinea (0,0)
  if (Number.isFinite(accuracy) && accuracy > 5000) return true; // >5km is likely not usable
  return false;
}

function maneuverText(m){
  const type = (m.type || "").toLowerCase();
  const mod = (m.modifier || "").toLowerCase();
  const name = (m.name || "").trim();
  // Simple NL-ish wording
  if (type === "depart") return "Vertrek";
  if (type === "arrive") return "Aankomst";
  if (type === "roundabout") return "Rotonde";
  if (type === "merge") return "Invoegen";
  if (type === "on ramp") return "Oprit";
  if (type === "off ramp") return "Afrit";
  if (type === "turn") return `Afslag ${mod || ""}`.trim();
  if (type === "continue") return "Volg";
  return (type || "Ga verder");
}

function formatDistance(meters){
  if (!Number.isFinite(meters)) return "—";
  if (meters < 1000) return `${Math.round(meters)} m`;
  const km = meters/1000;
  return `${km.toFixed(km < 10 ? 1 : 0)} km`;
}


function updateRoutePanels(){
  const selBox = document.getElementById("routeSelected");
  const destBox = document.getElementById("routeDestination");
  if (selBox){
    if (selectedRouteInfo){
      const steps = (selectedRouteInfo.maneuvers || []).slice(0, 4).map((m) => {
        const txt = maneuverText(m);
        const road = m.name ? ` · ${escapeHtml(m.name)}` : "";
        return `<li>${escapeHtml(txt)}${road} <span class="muted">(${formatDistance(m.distance_m)})</span></li>`;
      }).join("");
      selBox.innerHTML = `<div class="routeHead">Naar geselecteerde auto</div>
        <div class="routeMeta">${selectedRouteInfo.distanceText} · ${selectedRouteInfo.etaShort}</div>
        <ul class="routeSteps">${steps || "<li>Route berekend.</li>"}</ul>`;
    } else {
      selBox.innerHTML = `<div class="routeHead">Naar geselecteerde auto</div><div class="routeMeta">Selecteer een auto…</div>`;
    }
  }
  if (destBox){
    if (destination && destinationRouteInfo){
      const steps = (destinationRouteInfo.maneuvers || []).slice(0, 4).map((m) => {
        const txt = maneuverText(m);
        const road = m.name ? ` · ${escapeHtml(m.name)}` : "";
        return `<li>${escapeHtml(txt)}${road} <span class="muted">(${formatDistance(m.distance_m)})</span></li>`;
      }).join("");
      destBox.innerHTML = `<div class="routeHead">Naar bestemming</div>
        <div class="routeMeta">${destinationRouteInfo.distanceText} · ${destinationRouteInfo.etaShort}</div>
        <ul class="routeSteps">${steps || "<li>Route berekend.</li>"}</ul>`;
    } else {
      destBox.innerHTML = `<div class="routeHead">Naar bestemming</div><div class="routeMeta">Nog geen bestemming…</div>`;
    }
  }
}
