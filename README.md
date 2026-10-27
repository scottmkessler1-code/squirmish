# Caterpillar Continental Combat — online

`npm install`, `npm start` (port from `PORT`, default 3000), open `http://localhost:3000`.
`npm test` runs the determinism and server tests; `npm run check:browser` replays matches in Chromium.

## Layout
- `public/game.js` — the whole game as `createGame()`; simulation runs in Node too, drawing only with a canvas.
- `public/squirmish.html` — the page (served at `/` and `/r/CODE`).
- `server/rooms.js` — rooms, lobby, seats, host, start, return to lobby. No sockets, injected clock.
- `server/index.js` — Express + `ws` on `/ws`, rate limits, heartbeats, room cleanup.

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
| `ping {c}` | answered with `pong {c}` |
| `input`, `hash`, `snapshot` | steps 3 and 5 |

Server → client: `welcome {you, token, code, state, host, players, spectators, seatWanted, match?}`,
`lobby {state, host, players:[{id, slot, name, ready, connected}], spectators:[{id, name, connected}]}`,
`you {you}`, `start {seed, names, startFrame, you}`, `host {id, slot}`, `player_left {slot, id}`,
`match_over {winner, name, backInMs}`, `replaced`, `error {code}`, `pong {c}`.

`you = {id, name, role: 'player'|'spectator', slot, team}`. Spectators have `slot`/`team` −1. `host` is a member `id`
(spectators can be host). Slots stay packed 0..n−1 in the lobby, so slot = team index = colour.
After `match_over`, everyone returns to the same lobby 5 s later: ready flags reset, players who dropped lose their seat,
spectators stay spectators and can take a free seat.
