const $ = (id) => document.getElementById(id);
const socket = io();

let watchId = null;
let myId = null;

let lastState = null;

// Leaflet
let map = null;
let markers = new Map(); // socketId -> marker
let selectedUserId = null;
let routeLine = null;

// Routing cache & throttling
const routeCache = new Map(); // key -> {ts, data}
const ROUTE_CACHE_MS = 12000;
const ROUTE_MIN_INTERVAL_MS = 4000;
let lastRouteCallAt = 0;

initPrefill();
initMap();

$("join").addEventListener("click", () => {
  const roomCode = $("room").value.trim().toUpperCase();
  const myName = $("name").value.trim();

  if (!roomCode || !myName) {
    alert("Vul room code en auto naam in.");
    return;
  }

  localStorage.setItem("ski_room", roomCode);
  localStorage.setItem("ski_name", myName);

  socket.emit("join", { roomCode, name: myName });

  $("start").disabled = false;
  $("join").disabled = true;
  $("share").disabled = false;

  setStatus("Verbonden. Start tracking om live GPS te delen.");
});

$("share").addEventListener("click", async () => {
  const rc = ($("room").value || "").trim().toUpperCase();
  const nm = ($("name").value || "").trim();
  if (!rc || !nm) return alert("Room en naam invullen voor delen.");

  const url = new URL(window.location.href);
  url.searchParams.set("room", rc);
  url.searchParams.set("name", nm);

  try {
    await navigator.clipboard.writeText(url.toString());
    setStatus("Deellink gekopieerd naar klembord ✅");
  } catch {
    prompt("Kopieer deze link:", url.toString());
  }
});

$("start").addEventListener("click", async () => {
  if (!("geolocation" in navigator)) {
    alert("Geolocation niet beschikbaar op dit apparaat.");
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude, longitude, speed, heading, accuracy } = pos.coords;
      const speedKmh = speed == null ? null : speed * 3.6;

      socket.emit("pos", {
        lat: latitude,
        lon: longitude,
        speedKmh,
        heading: heading == null ? null : heading,
        ts: pos.timestamp || Date.now()
      });

      // optimistic marker update
      upsertMarker(myId, "Ik", latitude, longitude, true);

      if ($("followMe").checked) {
        map.setView([latitude, longitude], Math.max(map.getZoom(), 10), { animate: true });
      }

      setStatus(
        `Tracking actief · nauwkeurigheid ~${Math.round(accuracy)}m · ` +
        `snelheid: ${speedKmh == null ? "—" : speedKmh.toFixed(0) + " km/u"}`
      );
    },
    (err) => alert("Locatie fout: " + err.message),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );

  $("start").disabled = true;
  $("stop").disabled = false;
});

$("stop").addEventListener("click", () => {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  $("start").disabled = false;
  $("stop").disabled = true;
  setStatus("Tracking gestopt.");
});

$("showRoutes").addEventListener("change", () => {
  if (!$("showRoutes").checked) clearRouteLine();
  if ($("showRoutes").checked && lastState) render(lastState);
});

socket.on("connect", () => { myId = socket.id; });
socket.on("state", (payload) => { lastState = payload; render(payload); });

function initPrefill() {
  const url = new URL(window.location.href);
  const qRoom = url.searchParams.get("room");
  const qName = url.searchParams.get("name");

  const savedRoom = localStorage.getItem("ski_room");
  const savedName = localStorage.getItem("ski_name");

  $("room").value = (qRoom || savedRoom || "").toUpperCase();
  $("name").value = (qName || savedName || "");
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView([52.0, 6.7], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap"
  }).addTo(map);
}

function setStatus(t) { $("status").textContent = t; }

function render({ users }) {
  const withPos = users.filter(u => isFinite(u.lat) && isFinite(u.lon));
  const me = withPos.find(u => u.id === myId);
  const others = withPos.filter(u => u.id !== myId);

  // Update markers
  for (const u of withPos) {
    upsertMarker(u.id, u.name, u.lat, u.lon, u.id === myId);
  }

  // Remove missing
  const alive = new Set(withPos.map(u => u.id));
  for (const [id, m] of markers.entries()) {
    if (!alive.has(id)) {
      map.removeLayer(m);
      markers.delete(id);
    }
  }

  const list = $("list");
  list.innerHTML = "";

  if (!me) {
    list.innerHTML = `<div class="small">Wacht op jouw GPS (start tracking) of join opnieuw…</div>`;
    clearRouteLine();
    return;
  }
  if (others.length === 0) {
    list.innerHTML = `<div class="small">Nog geen andere auto's in deze room.</div>`;
    clearRouteLine();
    return;
  }

  if (!selectedUserId || !others.some(o => o.id === selectedUserId)) {
    selectedUserId = others[0].id;
  }

  for (const o of others) {
    const card = document.createElement("div");
    card.className = "kpi" + (o.id === selectedUserId ? " selected" : "");
    card.innerHTML = `
      <div>
        <b>${escapeHtml(o.name)} <span class="badge">live</span></b>
        <div class="small">Laatste update: ${timeAgo(o.ts)}</div>
        <button class="selectBtn">${o.id === selectedUserId ? "Geselecteerd" : "Selecteer"}</button>
      </div>
      <div>
        <b>Voor/achter</b>
        <div class="small" id="pos-${o.id}">Berekenen…</div>
      </div>
      <div>
        <b>Route-ETA</b>
        <div class="small" id="eta-${o.id}">Berekenen…</div>
      </div>
    `;
    list.appendChild(card);

    card.querySelector(".selectBtn").addEventListener("click", () => {
      selectedUserId = o.id;
      focusOnUser(o.id);
      render(lastState);
    });

    computeRouteAndRelative(me, o).then((info) => {
      const etaEl = document.getElementById(`eta-${o.id}`);
      const posEl = document.getElementById(`pos-${o.id}`);
      if (etaEl) etaEl.textContent = info.etaText;
      if (posEl) posEl.textContent = info.aheadBehindText;

      if ($("showRoutes").checked && o.id === selectedUserId && info.geometry) {
        drawRouteLine(info.geometry);
      }
    }).catch(() => {
      const etaEl = document.getElementById(`eta-${o.id}`);
      const posEl = document.getElementById(`pos-${o.id}`);
      if (etaEl) etaEl.textContent = "Route-ETA niet beschikbaar";
      if (posEl) posEl.textContent = "—";
      if (o.id === selectedUserId) clearRouteLine();
    });
  }
}

function focusOnUser(userId) {
  const m = markers.get(userId);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 11), { animate: true });
}

function upsertMarker(id, name, lat, lon, isMe) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

  const label = isMe ? `🟢 ${name} (ik)` : `🔵 ${name}`;
  const existing = markers.get(id);

  if (existing) {
    existing.setLatLng([lat, lon]);
    existing.setPopupContent(label);
  } else {
    const marker = L.marker([lat, lon]);
    marker.addTo(map).bindPopup(label);
    marker.on("click", () => {
      if (id !== myId) {
        selectedUserId = id;
        render(lastState);
      }
      marker.openPopup();
    });
    markers.set(id, marker);
  }
}

function clearRouteLine() {
  if (routeLine) {
    map.removeLayer(routeLine);
    routeLine = null;
  }
}

function drawRouteLine(geometryGeoJson) {
  clearRouteLine();
  routeLine = L.geoJSON(geometryGeoJson, { weight: 5, opacity: 0.7 }).addTo(map);
}

async function computeRouteAndRelative(me, other) {
  const now = Date.now();
  if (now - lastRouteCallAt > ROUTE_MIN_INTERVAL_MS) {
    lastRouteCallAt = now;
  }

  const a = `${me.lat.toFixed(5)},${me.lon.toFixed(5)}`;
  const b = `${other.lat.toFixed(5)},${other.lon.toFixed(5)}`;

  const keyAB = `AB:${a}->${b}`;
  const keyBA = `BA:${b}->${a}`;

  const [ab, ba] = await Promise.all([
    getRouteCached(keyAB, a, b),
    getRouteCached(keyBA, b, a)
  ]);

  let etaText = "Route-ETA niet beschikbaar";
  let geometry = null;

  if (ab?.ok) {
    etaText = `~ ${formatDuration(ab.duration_s)} · ${formatKm(ab.distance_m)} km`;
    geometry = ab.geometry_geojson;
  }

  let aheadBehindText = "Onbekend";
  if (ab?.ok && ba?.ok) {
    const d1 = ab.duration_s;
    const d2 = ba.duration_s;
    const ratio = Math.max(d1, d2) / Math.max(1, Math.min(d1, d2));

    if (ratio < 1.25) {
      aheadBehindText = "Ongeveer gelijk / niet duidelijk";
    } else {
      aheadBehindText = (d1 < d2)
        ? `${other.name} rijdt waarschijnlijk vóór je`
        : `${other.name} rijdt waarschijnlijk achter je`;
    }
  }

  return { etaText, aheadBehindText, geometry };
}

async function getRouteCached(cacheKey, from, to) {
  const hit = routeCache.get(cacheKey);
  if (hit && (Date.now() - hit.ts) < ROUTE_CACHE_MS) return hit.data;

  const url = `/api/route?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const r = await fetch(url, { cache: "no-store" });
  const data = await r.json().catch(() => ({ ok: false }));

  routeCache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return "—";
  const totalMin = Math.round(seconds / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} min`;
  return `${h}u ${m}m`;
}
function formatKm(meters) {
  if (!Number.isFinite(meters)) return "—";
  return (meters / 1000).toFixed(1);
}
function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return "net";
  if (s < 60) return `${s}s geleden`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);
  return `${h}u geleden`;
}
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
