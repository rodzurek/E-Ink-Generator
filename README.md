# Homelab app template

A starting point for an app you install from the dashboard with **Install app →
git**. Node 18+, standard library only, so the install needs no setup commands
and nothing to build. It runs as a systemd **user** unit the agent writes for
you, which needs no root and no sudoers line.

```
server.js           the app: static files from public/, /api/health, optional TOKEN
public/index.html   the page; replace it with yours
server.test.mjs     node --test, run with `npm test`
homelab-template.json  a dashboard template; copy into hub/catalog/ to prefill the dialog
```

## Make it yours

1. Copy this folder into a new repo and push it (GitHub, Gitea, anything the node
   can clone over https or ssh).
2. Replace `public/` and extend `server.js`. Keep `/api/health` answering
   `{ ok, uptime }` and nothing more: the dashboard probes it from the node,
   outside the token check.
3. `npm test` before pushing.

## Install it from the dashboard

The node needs `ALLOW_INSTALL=1` in `/etc/homelab-agent.env`, and `node` on the
agent user's login `PATH` (the unit starts it with `sh -lc`, so nvm works).

In **Install app**, pick kind **git** and fill:

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Name           | `my-app` (letters, digits, `.` `_` `-`) |
| Repo           | `https://github.com/you/my-app.git`     |
| Setup          | leave empty — there are no dependencies |
| Start command  | `node server.js`                        |
| Environment    | `APP_NAME=my-app`, and `TOKEN=…` if you want one |
| Port           | `8090`                                  |
| Health         | `/api/health`                           |

The agent clones into the install root, writes
`~/.config/systemd/user/my-app.service` with `PORT=8090` set from the port field,
enables it, and writes the app's `homelab.json`. The card turns green once
`/api/health` answers.

To skip typing that each time, copy `homelab-template.json` into `hub/catalog/`
on the hub (rename it, set `repo`), push, and **Update hub** — it then appears in
the dialog's template list. Or fill the form once and press **Save as template**.

## Things that trip this up

- **Lingering.** A user unit needs `sudo loginctl enable-linger rod` on that node.
  Enrolment does it; a node set up by hand may not have it. The install then
  writes the unit, does not start it, and says so.
- **Ports already taken on this fleet:** 3001 (pi-main, uptime-kuma), 5178
  (pi-mp4), 8080 (PiHole admin). Pick another if 8090 is used; the app prints
  `port … is already taken` in **Logs** when it is.
- **Private repos** must use an `ssh://` or `git@` URL with a key the agent user
  already has. There is no terminal to type a password into, so an https URL to a
  private repo fails at once rather than hanging.
- **The repo's own `homelab.json` is replaced** by the one the dialog writes, so
  do not rely on shipping one. Edit it on the node afterwards if you want an
  `update` list, e.g. `["git pull --ff-only", "systemctl --user restart my-app"]`.
- **Setup commands** run with `bash -lc` in the checkout. If you add npm
  dependencies later, put `npm ci --omit=dev` there.
- **Line endings.** `.gitattributes` keeps everything LF; a CRLF shebang or
  script breaks on the Pi. The exec bit does not survive a push from Windows —
  call scripts as `bash script.sh`.

## Token

With `TOKEN` set, every path except `/api/health` wants `?token=` or an
`x-token` header. Set the same token on the app card with **Link** and the
dashboard link opens it signed in. Anyone who can open the dashboard can then
open the app; the dashboard can already stop it, so that grant is small but real.
