# Caterpillar Continental Combat — online

`npm install`, `npm start` (port from `PORT`, default 3000), open `http://localhost:3000`.
`npm test` runs the determinism, server and lockstep tests. With Playwright installed, `npm run check:browser` replays
matches in Chromium and `npm run check:online` plays a match across three browser profiles (screenshots in `screens/`).

## Layout
- `public/game.js` — the whole game as `createGame()`; simulation runs in Node too, drawing only with a canvas.
- `public/squirmish.html` — markup and styles (served at `/` and `/r/CODE`).
- `public/app.js` — the page: home, join and lobby screens, online match view, offline hot-seat, sound, weapon bar.
- `server/rooms.js` — rooms, lobby, seats, host, start, return to lobby. No sockets, injected clock.
- `server/index.js` — Express + `ws` on `/ws`, rate limits, heartbeats, room cleanup, the 50 ms clock tick.
- `public/lockstep.js` — client side of the lockstep: applies server-stamped inputs, runs only up to `upTo`, acks, reports the end.

## Protocol (JSON over one WebSocket per tab)
Rooms are created with `POST /api/rooms` → `{code}`; `GET /api/rooms/CODE` → `{state, players, spectators}` or 404.

Client → server
| msg | notes |
|---|---|
| `join {room, name, token?, spectate?}` | must be first. `token` reclaims a seat (60 s grace in the lobby). |
| `ready {ready}` | players, lobby only |
| `name {name}` / `role {spectate}` | lobby only; taking a seat needs a free one |
| `settings {worms?, turn?}` | host only, lobby only: worms per team 1–4, turn 10/15/20/30/45/60 s; resets everyone's ready |
| `start {}` | host only, ≥2 players, all connected and ready |
| `over {frame, winner}` | players report the end; a majority of connected players must agree |
| `leave {}` | gone at once, no grace |
| `input {k, d}` | seated players during a match; the server stamps `f` and `p` |
| `ack {frame}` | the frame the client has simulated to, at most every 200 ms |
| `ping {c}` | answered with `pong {c}` |
| `hash {frame, h, e}` | every 120 frames; `e` = snapshots loaded so far |
| `snapshot {data}` | only from the client the server asked (`snapshot_req`) |
| `resync {}` | the client knows it diverged (at most once per 5 s) |

Server → client: `welcome {you, token, code, state, host, players, spectators, seatWanted, match?}`,
`lobby {state, host, settings:{worms, turn}, players:[{id, slot, name, ready, connected}], spectators:[{id, name, connected}]}`,
`you {you}`, `start {seed, names, settings, startFrame, you}`, `host {id, slot}`, `player_left {slot, id, reason: 'left'|'timeout'}`,
`match_over {winner, name, backInMs}`, `replaced`, `error {code}`, `pong {c}`,
`step {upTo, inputs:[{f, p, k, d}]}`, `stall {waiting:[id]}` (empty list = running again),
`desync {frame}`, `snapshot_req {}`, `snapshot {data, inputs, upTo, e}`.
During a match, `welcome.match = {seed, names, startFrame, snapshot?, inputs, upTo, done, e}`: the latest checkpoint
snapshot (if any) and every input after it, so a late joiner or reconnecting player fast-forwards from there.

`you = {id, name, role: 'player'|'spectator', slot, team}`. Spectators have `slot`/`team` −1. `host` is a member `id`
(spectators can be host). Slots stay packed 0..n−1 in the lobby, so slot = team index = colour.
After `match_over`, everyone returns to the same lobby 5 s later: ready flags reset, players who dropped lose their seat,
spectators stay spectators and can take a free seat.

## Lockstep clock
The server counts frames at 60/s and every 50 ms sends `step`. An input received at server frame `S` is stamped
`f = S + 6` (never at or below an `upTo` already sent), so clients may run up to `upTo = S + 5`.
If a connected, caught-up player's `ack` falls more than 1.5 s behind, the clock pauses (`stall`) until they are within
0.75 s; after 8 s of waiting it stops waiting for them. Spectators and players still catching up never pause it.

## Client behaviour
- Online, the simulation runs at 60 fps up to `upTo`; behind by more than 120 frames it fast-forwards on an 8 ms budget per
  animation frame with sound muted. Hidden tabs keep simulating from a 250 ms timer.
- Inputs are sent only while it is your team's turn; the weapon bar shows your own team's ammo and is dimmed otherwise.
- The reconnect token is kept in `localStorage` per room, so a reload or a dropped connection rejoins the same seat.
- Add `#debug` to the URL for the seed/frame/hash readout and `window.__sq` (game, lockstep, net).

## Desync detection and recovery
Clients report `stateHash()` every 120 frames. The server compares a frame once everyone connected has reported it (or
after 3 s). The majority hash wins; on a tie, the host's side. Each client that disagrees gets `desync`, and a client on
the good side (host first) is asked for a snapshot; the diverged clients load it plus every logged input after its frame.
In-sync clients are not paused. A provider that doesn't answer within 5 s is replaced. The latest snapshot is kept as a
checkpoint for late joiners, and one is also taken every 2 minutes while everyone agrees.

Snapshots (`game.getSnapshot()` / `loadSnapshot()`) hold the full simulation state as JSON, about 5–10 KB: worms, teams
and ammo, projectiles, crates, turn state, RNG state, held keys, and the terrain as run lengths. Loading rebuilds the
landscape picture from the seed and erases the craters.

## Leaving and dropping out
- **Leave** during a match: the server stamps a `forfeit` input for that team (`{f, p, k:'forfeit', d:true}`), so every
  client knocks that team out on the same frame. Clients can't send `forfeit` themselves.
- **Dropped connection**: the player has 60 s to come back with their token (the page reconnects on its own). Their turns
  time out meanwhile. After 60 s, their team forfeits.
- A forfeit that leaves one team ends the current turn at once, so the result shows straight away.
- If nobody who could report the end is still connected, the server ends the match itself and returns to the lobby.
- The host leaving or dropping hands the host role to the next connected player (or a spectator if none).

## Deploying
See [DEPLOY.md](DEPLOY.md): Render blueprint (`render.yaml`), `fly.toml`, and a `Dockerfile` for Railway or anything else.

## Map size
The map is 960 px wide for up to 6 worms in total, then 160 px wider per extra worm, up to 3840 px (`worldWidth()` in
`public/game.js`); height stays 540. Caves, crates and decoration scale with the width. On wide maps the camera follows the
newest projectile, else the worm whose turn it is, else anything flying; players can drag the view with the right mouse button (or a finger) or click the minimap. Left click = Space.
