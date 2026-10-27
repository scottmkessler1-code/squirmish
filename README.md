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
| `start {}` | host only, ≥2 players, all connected and ready |
| `over {frame, winner}` | players report the end; a majority of connected players must agree |
| `leave {}` | gone at once, no grace |
| `input {k, d}` | seated players during a match; the server stamps `f` and `p` |
| `ack {frame}` | the frame the client has simulated to, at most every 200 ms |
| `ping {c}` | answered with `pong {c}` |
| `hash`, `snapshot` | step 5 |

Server → client: `welcome {you, token, code, state, host, players, spectators, seatWanted, match?}`,
`lobby {state, host, players:[{id, slot, name, ready, connected}], spectators:[{id, name, connected}]}`,
`you {you}`, `start {seed, names, startFrame, you}`, `host {id, slot}`, `player_left {slot, id}`,
`match_over {winner, name, backInMs}`, `replaced`, `error {code}`, `pong {c}`,
`step {upTo, inputs:[{f, p, k, d}]}`, `stall {waiting:[id]}` (empty list = running again).
During a match, `welcome.match = {seed, names, startFrame, inputs, upTo, done}`: the full input log, so a late joiner or
reconnecting player rebuilds the match by fast-forwarding from frame 0.

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
