import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(express.static("public"));

/** In-memory state */
const rooms = Object.create(null);
function ensureRoom(code) {
  if (!rooms[code]) rooms[code] = { users: {} };
  return rooms[code];
}
function sanitizeUsers(usersObj) {
  return Object.entries(usersObj).map(([id, u]) => ({
    id,
    name: u.name,
    lat: u.lat,
    lon: u.lon,
    speedKmh: u.speedKmh,
    heading: u.heading,
    ts: u.ts
  }));
}

/**
 * OSRM proxy (avoids CORS issues + lets us add small safety validation).
 * GET /api/route?from=lat,lon&to=lat,lon
 * Returns: { ok:true, distance_m, duration_s, geometry_geojson } OR { ok:false, error }
 */
app.get("/api/route", async (req, res) => {
  try {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    const [fLat, fLon] = from.split(",").map(Number);
    const [tLat, tLon] = to.split(",").map(Number);

    if (![fLat, fLon, tLat, tLon].every((v) => Number.isFinite(v))) {
      return res.status(400).json({ ok: false, error: "Invalid coordinates" });
    }

    // OSRM expects lon,lat
    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fLon},${fLat};${tLon},${tLat}` +
      `?overview=full&geometries=geojson&steps=false`;

    const r = await fetch(url, { headers: { "User-Agent": "ski-tracker/2.0" } });
    if (!r.ok) return res.status(502).json({ ok: false, error: "OSRM upstream error" });

    const data = await r.json();
    if (!data?.routes?.[0]) return res.status(502).json({ ok: false, error: "No route" });

    const route = data.routes[0];
    return res.json({
      ok: true,
      distance_m: route.distance,
      duration_s: route.duration,
      geometry_geojson: route.geometry
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Server error" });
  }
});

io.on("connection", (socket) => {
  socket.on("join", ({ roomCode, name }) => {
    if (!roomCode || !name) return;
    roomCode = String(roomCode).trim().toUpperCase();
    name = String(name).trim().slice(0, 24);

    socket.data.roomCode = roomCode;
    socket.data.name = name;

    const room = ensureRoom(roomCode);
    room.users[socket.id] = {
      name,
      lat: null,
      lon: null,
      speedKmh: null,
      heading: null,
      ts: Date.now()
    };

    socket.join(roomCode);

    io.to(roomCode).emit("state", {
      roomCode,
      users: sanitizeUsers(room.users)
    });
  });

  socket.on("pos", ({ lat, lon, speedKmh, heading, ts }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    const u = room.users[socket.id];
    if (!u) return;

    u.lat = Number(lat);
    u.lon = Number(lon);
    u.speedKmh = speedKmh == null ? null : Number(speedKmh);
    u.heading = heading == null ? null : Number(heading);
    u.ts = ts ? Number(ts) : Date.now();

    io.to(roomCode).emit("state", {
      roomCode,
      users: sanitizeUsers(room.users)
    });
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    delete room.users[socket.id];

    if (Object.keys(room.users).length === 0) {
      delete rooms[roomCode];
      return;
    }

    io.to(roomCode).emit("state", {
      roomCode,
      users: sanitizeUsers(room.users)
    });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
