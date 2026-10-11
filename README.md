# E-Ink Generator

Type a prompt, get a 240x240 image reduced to the colors of a colored e-ink
panel. Built on the homelab app template: Node 18+, standard library only, so
the install needs no setup commands and nothing to build. It runs as a systemd
**user** unit the agent writes for you, which needs no root and no sudoers line.

```
server.js           static files from public/, /api/health, /api/generate, /api/dithered, optional TOKEN
public/index.html   the page: prompt, palette, downscale and dither, PNG download
public/history.html the last 50 generations
public/icon-*.png   app icons for the Android install
server.test.mjs     node --test, run with `npm test`
homelab-template.json  a dashboard template; copy into hub/catalog/ to prefill the dialog
```

## How it works

1. The page posts the prompt to `/api/generate`.
2. The server calls the OpenAI image API with `OPENAI_API_KEY`, so the key never
   reaches the browser. The API has no 240x240 size, so it asks for 1024x1024.
3. The page scales the result to 240x240 on a canvas and maps every pixel to the
   chosen panel palette, with Floyd–Steinberg dithering unless you turn it off.
   Changing the palette or the dither re-renders without another API call.
4. **Download PNG** saves the 240x240 result. It contains only the palette's
   pure colors (black `000000`, white `ffffff`, red `ff0000`, yellow `ffff00`,
   blue `0000ff`, green `00ff00`, orange `ff8000`).

## Styles

The **Style** picklist wraps what you type as the subject of a style sentence
(anime, pixel art, comic book, …) and ends every prompt with the same rules for
the panel: its size, only the selected palette's colors, flat fills, thick
outlines, no gradients, no text. Type the subject as a noun phrase, e.g. "a red
fox under a yellow moon". **No style — send my text as written** sends exactly
what was typed, with nothing added. The styles are `STYLES` in
`public/index.html`.

## Install on Android

Open the site in Chrome on the phone, then menu → **Add to Home screen** →
**Install**. It then opens full screen from its own icon, like an app.

Chrome only offers **Install** over `https` (or on `localhost`), so this needs
the public address; over plain `http` on the LAN it only offers a shortcut.
With `TOKEN` set, open the page with `?token=` before installing: the token is
written into the installed app's start address, so changing `TOKEN` later means
installing again. There is no service worker, so the app needs the server to be
reachable and never shows a stale page.

## Converting your own image

**Take photo** opens the phone's camera and **Choose image** its photo library
or files; on a computer both open the file picker, and Ctrl+V anywhere on the
page pastes an image. Any picture the browser can open works. The page crops it
to a centered square, scales it to 240x240 and renders it with the same palette
and dither settings. It costs nothing: OpenAI is not called. The conversion
happens in the browser and the file never reaches the server, so it is not
stored in `images/`; use **Download PNG** to keep the result.

## Stored images

Every generation is written to `images/` (git-ignored) as three files with the
same timestamped name:

- `.png` — the 1024x1024 original from OpenAI, before scaling and dithering,
  so it can be re-rendered for any palette later
- `-240.png` — the 240x240 dithered result, the same file **Download PNG**
  gives. The page sends it back through `/api/dithered` after rendering, and
  again when the palette or dither setting changes, so it always holds the
  last render and earlier ones are overwritten.
- `.json` — `created`, `subject` (what was typed), `style` (the style
  picked), `prompt` (what was sent),
  `model`, `quality`, and `usage`: the token counts OpenAI reported for that
  generation (`total_tokens`, `input_tokens`, `output_tokens`), or `null` if
  the model reported none. The page shows the same counts after generating.

**History** (`/history.html`, linked from the top of the generator) shows the
last 50 generations, newest first: the 240x240 image, what was typed, the
style, model, date and tokens, with the full prompt behind **Prompt sent**.
Clicking an image opens its 1024x1024 original. It reads `images/` through
`/api/generations` and `/api/images/<name>.png`; images converted from a photo
or upload are not listed, because those are never stored.

If the folder cannot be written the image is still returned and the reason is
logged. Nothing is ever deleted, so clear the folder yourself.

## Environment

| Variable               | Default       | Meaning                                        |
| ---------------------- | ------------- | ---------------------------------------------- |
| `OPENAI_API_KEY`       | —             | required; without it `/api/generate` answers 503 |
| `OPENAI_IMAGE_MODEL`   | `gpt-image-1` | the model the page starts on; the picklist is `MODELS` in `server.js` |
| `OPENAI_IMAGE_QUALITY` | `low`         | `low`, `medium` or `high`; low is plenty at 240px |
| `IMAGES_DIR`           | `images`      | where generations are stored; relative to the app folder |
| `TOKEN`                | —             | see **Token** below                            |
| `PORT`                 | `8090`        |                                                |

Each generation is billed to the key. Set `TOKEN` if the app is reachable by
anyone you would not hand the key to.

## Run it locally

Copy `.env.example` to `.env` (it is git-ignored), fill in the key, then:

```
npm start
```

The server reads `.env` itself on Node 20.12+. Restart it after editing `.env`.

`npm test` runs the tests; they stub the OpenAI call and spend nothing.

## Install it from the dashboard

The node needs `ALLOW_INSTALL=1` in `/etc/homelab-agent.env`, and `node` on the
agent user's login `PATH` (the unit starts it with `sh -lc`, so nvm works).

In **Install app**, pick kind **git** and fill:

| Field          | Value                                   |
| -------------- | --------------------------------------- |
| Name           | `e-ink-generator` (letters, digits, `.` `_` `-`) |
| Repo           | `https://github.com/you/e-ink-generator.git` |
| Setup          | leave empty — there are no dependencies |
| Start command  | `node server.js`                        |
| Environment    | `OPENAI_API_KEY=…`, and `TOKEN=…` if you want one |
| Port           | `8090`                                  |
| Health         | `/api/health`                           |

The agent clones into the install root, writes
`~/.config/systemd/user/e-ink-generator.service` with `PORT=8090` set from the port field,
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
  `update` list, e.g. `["git pull --ff-only", "systemctl --user restart e-ink-generator"]`.
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
