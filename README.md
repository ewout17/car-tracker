# Ski Car Tracker (Leaflet + Live GPS + Route ETA)

## Wat is dit?
Een simpele webapp voor 3 auto's (of meer) om live locaties te delen in een room, met:
- Live kaart (Leaflet/OpenStreetMap)
- Route-ETA (rijtijd/afstand) naar de andere auto's via OSRM
- Voor/achter indicatie (heuristiek op basis van A->B vs B->A rijtijd)
- Deellink knop + onthouden van room/naam

## Lokaal draaien
```bash
npm install
npm start
```
Open: http://localhost:3000

## Deploy naar Render
- New + -> Web Service
- Environment: Node
- Build Command: npm install
- Start Command: npm start
- Let op: server luistert op process.env.PORT (is ingebouwd)

## Bestanden
- server.js (Express + Socket.IO + OSRM proxy)
- public/ (frontend)
