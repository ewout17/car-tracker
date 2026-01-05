import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

app.use(express.static("public"));

/**
 * rooms[roomCode] = { ownerId, destination, pauseLog, users }
 */
const rooms = Object.create(null);

function ensureRoom(code) {
  if (!rooms[code]) rooms[code] = { ownerId: null, destination: null, pauseLog: [], users: {} };
  return rooms[code];
}

function sanitizeRoom(room, roomCode) {
  return {
    roomCode,
    ownerId: room.ownerId,
    destination: room.destination,
    pauseLog: room.pauseLog.slice(-25),
    users: Object.entries(room.users).map(([id, u]) => ({
      id,
      name: u.name,
      carType: u.carType,
      color: u.color,
      lat: u.lat,
      lon: u.lon,
      speedKmh: u.speedKmh,
      heading: u.heading,
      ts: u.ts
    }))
  };
}

// OSRM proxy: /api/route?from=lat,lon&to=lat,lon
app.get("/api/route", async (req, res) => {
  try {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");

    const [fLat, fLon] = from.split(",").map(Number);
    const [tLat, tLon] = to.split(",").map(Number);

    if (![fLat, fLon, tLat, tLon].every((v) => Number.isFinite(v))) {
      return res.status(400).json({ ok: false, error: "Invalid coordinates" });
    }

    const url =
      `https://router.project-osrm.org/route/v1/driving/` +
      `${fLon},${fLat};${tLon},${tLat}` +
      `?overview=full&geometries=geojson&steps=false`;

    const r = await fetch(url, { headers: { "User-Agent": "ski-tracker/5.0" } });
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
  socket.on("join", ({ roomCode, name, carType, color }) => {
    if (!roomCode || !name) return;
    roomCode = String(roomCode).trim().toUpperCase();
    name = String(name).trim().slice(0, 24);
    carType = String(carType || "car").trim().slice(0, 16);
    color = String(color || "#65B832").trim().slice(0, 20);

    const room = ensureRoom(roomCode);
    if (!room.ownerId) room.ownerId = socket.id;

    socket.data.roomCode = roomCode;

    room.users[socket.id] = {
      name, carType, color,
      lat: null, lon: null,
      speedKmh: null, heading: null,
      ts: Date.now()
    };

    socket.join(roomCode);
    io.to(roomCode).emit("state", sanitizeRoom(room, roomCode));
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

    io.to(roomCode).emit("state", sanitizeRoom(room, roomCode));
  });

  socket.on("setDestination", ({ label, lat, lon }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];
    if (socket.id !== room.ownerId) return;

    const nLat = Number(lat);
    const nLon = Number(lon);
    if (!Number.isFinite(nLat) || !Number.isFinite(nLon)) return;

    room.destination = { label: String(label || "Bestemming").slice(0, 80), lat: nLat, lon: nLon };

    io.to(roomCode).emit("state", sanitizeRoom(room, roomCode));
    io.to(roomCode).emit("roomMessage", {
      type: "destination",
      ts: Date.now(),
      by: room.users[socket.id]?.name || "Room eigenaar",
      text: `Bestemming ingesteld: ${room.destination.label}`
    });
  });

  socket.on("pause", ({ text }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;
    const room = rooms[roomCode];

    const by = room.users[socket.id]?.name || "Onbekend";
    const ts = Date.now();
    const msgText = String(text || "Pauze nemen").slice(0, 140);

    room.pauseLog.push({ by, byId: socket.id, ts, text: msgText });
    room.pauseLog = room.pauseLog.slice(-100);

    io.to(roomCode).emit("roomMessage", { type: "pause", ts, by, text: msgText });
    io.to(roomCode).emit("state", sanitizeRoom(room, roomCode));
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    if (!roomCode || !rooms[roomCode]) return;

    const room = rooms[roomCode];
    delete room.users[socket.id];

    if (room.ownerId === socket.id) room.ownerId = Object.keys(room.users)[0] || null;

    if (Object.keys(room.users).length === 0) {
      delete rooms[roomCode];
      return;
    }

    io.to(roomCode).emit("state", sanitizeRoom(room, roomCode));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
