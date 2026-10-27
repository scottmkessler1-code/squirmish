# Deploying

The server is one Node process holding all rooms in memory. Run **exactly one instance**, and don't let the host put it
to sleep while people play (sleeping or restarting ends every open room). HTTPS on the host gives `wss://` automatically:
the page connects to the WebSocket on its own origin.

## Render (simplest)
1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo. `render.yaml` creates one web service
   (`npm ci --omit=dev`, `npm start`, health check `/healthz`).
3. Open the `.onrender.com` URL, create a room, send the link.

The free plan sleeps after ~15 minutes without HTTP traffic, which drops open rooms; the `starter` plan in
`render.yaml` stays up. Change `plan:` if you just want to try it.

## Fly.io
```
fly launch --copy-config --no-deploy   # pick a unique app name and the region nearest your players
fly deploy
fly scale count 1
```
`fly.toml` keeps one machine always running (`auto_stop_machines = "off"`).

## Railway
New project → Deploy from GitHub repo. It builds the `Dockerfile`; Railway sets `PORT`. Keep replicas at 1.

## Checks after deploying
- `https://<host>/healthz` → `{"ok":true,"rooms":N}`
- Two browsers (one private window): create a room, join by link, play a turn each.
- Add `#debug` to the URL on each machine to see `seed / frame / hash`; at the same frame the hashes must match.
  If browsers ever disagree, the server resyncs the odd one out (you'll see "Out of sync, re-syncing…").

## Settings worth knowing (server/rooms.js, server/index.js)
| | |
|---|---|
| port | `PORT` env var, default 3000 |
| rooms | max 500; deleted 30 min after the last person leaves |
| reconnect | 60 s grace in the lobby and mid-match, then the seat is freed / the team forfeits |
| limits | 30 msg/s per socket (burst 60), 2 KB messages (snapshots 1 MB), 20 new rooms per IP per minute |
