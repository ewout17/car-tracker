# Ski Car Tracker v5 (Menu fix + Installeren)

## Fixes
- Menu/topbar zichtbaar op mobiel (safe-area correct)
- Altijd zichtbare knop **▲ Menu** op de kaart
- Install-knop (Android/Chrome) + PWA icons + apple-touch-icon

## Installeren op mobiel
- **Android (Chrome):** open de site → knop **Installeren**
- **iPhone (Safari):** Deel-knop → **Zet op beginscherm**

## Render
Build: npm install
Start: npm start


## Locatie permissions (troubleshooting)
- Locatie werkt alleen via **HTTPS**.
- Als je ooit op **Blokkeren** hebt gedrukt:
  - iPhone: Instellingen → Privacy en beveiliging → Locatievoorzieningen → Safari Websites → Tijdens gebruik (en ‘Precieze locatie’ aan)
  - Android: Chrome → Site-instellingen → Locatie → Toestaan
- Herlaad daarna de pagina.


## GPS springt naar Afrika (0,0) / oceaan?
Sommige telefoons geven heel even (0,0) terug of een onbruikbare fix.
De app negeert nu zulke fixes en toont **“Wachten op GPS-fix…”** tot er een goede locatie is.
