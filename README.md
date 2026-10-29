# TAG

Local multiplayer tag for 2-4 players on one keyboard.
Python backend, HTML + CSS frontend (a small `game.js` drives the game loop and keyboard).

## Run

    python server.py            # needs Python 3.9+, no packages to install

Open http://127.0.0.1:8000 and press **Space**.
Use `--port 9000` to change the port, or `--host 0.0.0.0` to open it from other devices on your network.

## How to play

- One player is **it** (gold arrow). Touch someone to pass it on. There is a 1 second grace period after every tag.
- When the timer hits zero, whoever is still **it** loses the round. Everybody else scores a point.
- The chaser is slightly faster, so run, jump, and use the map.

| Player | Left | Right | Jump |
|--------|------|-------|------|
| P1 | A | D | W |
| P2 | Left | Right | Up |
| P3 | J | L | I |
| P4 | Numpad 4 | Numpad 6 | Numpad 8 |

## Bots

On the menu choose **Humans** (0-4) and **Bots** (0-4); together they must make 2-4 players, and the
other box adjusts itself if you go over or under. One human + one bot works for solo play, and
0 humans lets you watch bots play each other.

Bot skill: **Easy** is slower and sloppy, **Normal** is a fair match, **Hard** is as fast as you,
leads its tags and dodges a lot. Bots use the same physics and the same jump height as humans.
They chase the nearest player when they are "it" and run to far-away platforms when they are not.
Bots take the slots after the humans (P1 is always a human if there is one) and show a small antenna.
Your menu choices are remembered in the browser.

`Enter` = next round, `Esc` = back to the menu. Keyboards can only register a few keys at once,
so 4 players may feel cramped on a laptop.

## Layout

    server.py        HTTP server + JSON API + result storage (stdlib only)
    maps.py          level data: platforms, bounce pads, portals, spawns
    static/
      index.html     menu, HUD and arena markup
      style.css      all visuals (platforms, players, animations)
      game.js        physics, tagging rules, input
    data/            results.json is created here on the first finished round

## API

    GET  /api/maps      level data
    GET  /api/stats     rounds played, who got caught most, recent rounds
    POST /api/results   {"map","players","loser","seconds","tags"}

## Adding a map

Add an entry to `MAPS` in `maps.py`. One-way platforms (`solid=False`) can be jumped up through;
solid ones block from every side. It shows up in the menu automatically. Keep vertical gaps
under about 125px, which is a full jump.
