# E-Ink Generator

Type a prompt, get an image reduced to the colors of a colored e-ink panel: the
1.54inch 240x240 one or the 7.3inch 800x480 Spectra 6 one. Built on the homelab app template: Node 18+, standard library only, so
the install needs no setup commands and nothing to build. It runs as a systemd
**user** unit the agent writes for you, which needs no root and no sudoers line.

```
server.js           static files from public/, /api/health, /api/generate, /api/dithered, /api/send, /api/delete, /api/device/*, who is calling
access.js           Cloudflare Access token check, config.json users and devices
config.example.json users, partners and devices; copy to config.json (git-ignored)
public/index.html   the page: prompt, palette, downscale and dither, PNG download
public/panel.js     shared by both pages: the inks, reduce and dither, packing the panel's frame
public/history.html the last 50 generations, each with Send to the partner and Delete
public/icon-*.png   app icons for the Android install
server.test.mjs     node --test, run with `npm test`
homelab-template.json  a dashboard template; copy into hub/catalog/ to prefill the dialog
```

## How it works

1. The page posts the prompt to `/api/generate`.
2. The server calls the OpenAI image API with `OPENAI_API_KEY`, so the key never
   reaches the browser. The API has no panel's exact size, so it asks for the
   nearest: 1024x1024 for the 240x240 panel, 1536x1024 for the 800x480 one.
3. The page fits the whole result into the panel's size on a canvas, with black
   bars where the shapes differ, and maps
   every pixel to the chosen panel palette, with Floyd–Steinberg dithering unless
   you turn it off. Changing the palette or the dither re-renders without another
   API call.
4. **Download PNG** saves the result at the panel's size. It contains only the palette's
   pure colors (black `000000`, white `ffffff`, red `ff0000`, yellow `ffff00`,
   blue `0000ff`, green `00ff00`, orange `ff8000`).

## Panels

The **Display** picklist sets the size of everything: what is generated, what
is converted, what is shown and what is sent. Both panels are e-ink Spectra 6,
and their definitions are `PANELS` in `public/panel.js`:

| Panel                              | Size    | Frame         | OpenAI size                |
| ---------------------------------- | ------- | ------------- | -------------------------- |
| 1.54inch e-Paper Module (E)        | 240x240 | 28,800 bytes  | 1024x1024                  |
| 7.3inch e-Paper HAT (E), Spectra 6 | 800x480 | 192,000 bytes | 1536x1024 (fitted, black bars) |

Each display in `config.json` names its panel with `"panel": "7.3"`; without
one it is the 1.54inch panel. Its `"orientation"` is `landscape` by default, or
`portrait` for a display mounted upright. The **Orientation** picklist shapes
what is generated, converted and shown. A portrait image is turned clockwise
into the panel's raster before packing, so a display mounted upright shows it
upright; if a picture comes out turned the other way, the turn in `toPanel`
(`public/panel.js`) has the wrong direction. A frame goes to all of the
partner's displays, and the server takes the panel from the frame's length, so
a frame of the wrong size is refused. Which board gets it is up to the route
the board calls (see below), not to `config.json`. The browser remembers the chosen Display, like
the style.

The 7.3inch ink codes are the ones the board's firmware draws with
(`main/epd_7in3e.h` in ESP-Ink-Generator), checked with its color bar test on
the wired panel. They are the same as the 1.54inch codes:

| Ink    | 7.3inch code |
| ------ | ------------ |
| black  | `0x0`        |
| white  | `0x1`        |
| yellow | `0x2`        |
| red    | `0x3`        |
| blue   | `0x5`        |
| green  | `0x6`        |

The display's own firmware is not in this repo: it has to fetch the 192,000-byte
frame from `/api/device/frame-7in3` and draw it.

## Styles

The **Style** picklist wraps what you type as the subject of a style sentence
(anime, pixel art, comic book, …) and ends every prompt with the same rules for
the panel: its size, only the selected palette's colors, flat fills, thick
outlines, no gradients, no text. Type the subject as a noun phrase, e.g. "a red
fox under a yellow moon". There is no option to send the text bare: without
the panel rules the result does not hold up on the display. The styles are
`STYLES` in `public/index.html`.

## Install on Android

Open the site in Chrome on the phone, then menu → **Add to Home screen** →
**Install**. It then opens full screen from its own icon, like an app.

Chrome only offers **Install** over `https` (or on `localhost`), so this needs
the public address; over plain `http` on the LAN it only offers a shortcut.
Behind Cloudflare Access the installed app signs in like the browser does.
Without Access but with `TOKEN` set, open the page with `?token=` before
installing: the token is written into the installed app's start address, so
changing `TOKEN` later means installing again. There is no service worker, so the app needs the server to be
reachable and never shows a stale page.

## Converting your own image

**Take photo** opens the phone's camera and **Choose image** its photo library
or files; on a computer both open the file picker, and Ctrl+V anywhere on the
page pastes an image. Any picture the browser can open works. The page fits all
of it into the Display's panel, with black bars where the shapes differ and renders it with
the same palette and dither settings. It costs nothing: OpenAI is not called. The conversion
happens in the browser and the original file never reaches the server. It is
stored in `images/` only when it is sent (the copy and the frame); otherwise
use **Download PNG** to keep the result.

## Sending to the partner's display

Once an image is on screen, generated or converted, **Send to <partner>**
appears. It packs the image into the frame of the panel picked in **Display**
and posts it to `/api/send`; the server stores it and makes it the current frame for the
partner's display, which fetches it from there (the device endpoints).

**Broadcast**, next to it on the generator and on History, sends the same frame
to every display in `config.json`, your own included. It needs a signed-in user
but no partner. The frame still only lands in the inbox of its own panel, so a
7.3 broadcast reaches the 7.3 boards and leaves the 1.54 inboxes as they were.

Both displays are Spectra 6 panels, so the frame is always reduced to the
Spectra 6 inks, whatever the palette picklist shows; the dither setting is
kept. The other palettes only change the preview and the download.

A frame is the panel's pixels at 4 bits: row by row from the top left, two
pixels per byte, the left pixel in the high nibble. That is 28,800 bytes for
the 240x240 panel and 192,000 for the 800x480 one. The 1.54inch ink codes are
those of the 1.54inch e-Paper Module (E), taken from Waveshare's `EPD_1in54e`
driver demo (github.com/waveshareteam/1.54inch_e-Paper_E) and checked with a
color band test on the wired panel; the 7.3inch codes are in **Panels**:

| Ink    | Code  |
| ------ | ----- |
| black  | `0x0` |
| white  | `0x1` |
| yellow | `0x2` |
| red    | `0x3` |
| blue   | `0x5` |
| green  | `0x6` |

The codes are in `PANELS` in `public/panel.js`. The server refuses a frame with
a code its panel does not have, or whose length is neither 28,800 nor 192,000
bytes.

`POST /api/send` takes `{ frame, name }` for a stored generation, or
`{ frame, image }` with the PNG at the panel's size for a converted image, which
the server has never seen. The frame is written as `images/<stamp>-<width>.bin`
(`-240.bin` or `-800.bin`), so one generation can go to both panels. A converted
image gets its own entry: `<stamp>-<width>.png`, `<stamp>-<width>.bin` and a
`.json` with `created`, `createdBy`, `source: "upload"`, `panel` and `orientation`.
`orientation` (default `landscape`) only picks the size of a converted image
and the frame's file name; it does not pick a display. Then, for each of the
partner's displays in `config.json`, the inbox of the frame's panel
(git-ignored, `INBOX_DIR`): `inbox/<device>.json` for a 1.54 frame,
`inbox/<device>-7in3.json` for a 7.3 one. It holds `frame` (the stamp),
`panel`, `orientation`, `sentBy`, `sentAt` and `deliveredAt` (`null` until
the board acknowledges). There is no queue: a newer send for that panel
replaces the frame, and leaves the other panel's inbox as it was. Sending needs a signed-in user (or `DEV_USER`)
whose partner has a display. With `to: "all"` in the body (Broadcast) the frame
goes to that panel's inbox of every display in `config.json` instead, no partner
needed; the answer then has `to: "all"`. Any other `to` is refused with 400.

## The display's endpoints

Displays pull; nothing is pushed to them. Both endpoints need a display's
identity (its Access service token, or `DEV_DEVICE` locally), and a display
only ever sees its own inbox.

- `GET /api/device/frame?after=<frame id>` is the 1.54inch boards' route and
  only ever hands out 240x240 frames (28,800 bytes). It answers **204** when
  no 1.54 frame was sent to the display yet, or when `after` is already the
  current one. Otherwise **200** with the raw frame as
  `application/octet-stream`, a `Content-Length`, and the frame id (the stamp)
  in `X-Frame-Id`. Leave `after` empty on the first call.
- `GET /api/device/frame-7in3?after=<frame id>` is the same for the 7.3inch
  board, and only ever hands out 800x480 frames (192,000 bytes). Its frame ids
  end in `-7in3`, so an acknowledge says which board drew it.

Because each panel has its own inbox, the 1.54 and the 7.3 board can use the
same service token: each sees only frames of its own size.

- `POST /api/device/ack?frame=<frame id>` records `deliveredAt` in the
  inbox the id is from after it has drawn the frame and answers **200** with
  `{ frame, deliveredAt }`. Acknowledging again keeps the first time. A frame
  that has since been replaced by a newer send answers **409** and leaves
  the newer one undelivered; with nothing sent, **404**.

Every call a display makes on these routes is written to
`inbox/<device>.seen` as an ISO time. `/api/info` returns it as `displays`
(`{ id, owner, lastSeen }` for the user's and the partner's displays), and the
main page shows it under the title: "Rod's display seen 3 min ago", with the
exact time on hover, refreshed every minute.

The app also answers 401 or 403 on these routes when it refuses an Access
token that Cloudflare let through (a display not in `config.json`); those
come with a JSON body, Cloudflare's own refusals do not.

To try it through the tunnel, with a display's service token (the secret
stays in your shell, never in a file in the repo):

```
export CF_ID='<service token Client ID>'
export CF_SECRET='<service token Client Secret>'
AUTH=(-H "CF-Access-Client-Id: $CF_ID" -H "CF-Access-Client-Secret: $CF_SECRET")

# 1. Send an image to that display's owner from the other partner's phone.
# 2. Fetch it: note X-Frame-Id in the headers; the frame lands in frame.bin.
curl -sS -D - -o frame.bin "${AUTH[@]}" 'https://ink.rod.la/api/device/frame?after='
# 3. Asking again with that id answers 204.
curl -sS -o /dev/null -w '%{http_code}\n' "${AUTH[@]}" 'https://ink.rod.la/api/device/frame?after=<frame id>'
# 4. Acknowledge it.
curl -sS -X POST "${AUTH[@]}" 'https://ink.rod.la/api/device/ack?frame=<frame id>'
```

Without the two headers, or with a revoked or expired token, Cloudflare stops
the request (a redirect to its login, or a refusal), so it never reaches the app.

## Stored images

Every generation is written to `images/` (git-ignored) as three files with the
same timestamped name:

- `.png` — the 1024x1024 original from OpenAI, before scaling and dithering,
  so it can be re-rendered for any palette later
- `-240.png` or `-800.png` (`-480-portrait.png` for portrait) — the dithered result at the panel's size, the same
  file **Download PNG** gives. The page sends it back through `/api/dithered`
  after rendering, and again when the palette or dither setting changes, so it
  always holds the last render and earlier ones are overwritten. A generation
  can have one copy per panel.
- `.json` — `created`, `createdBy` (the email of the partner who generated
  it, or `null` without Access or a stand-in user), `subject` (what was typed), `style` (the style
  picked), `prompt` (what was sent), `panel` (`1.54` or `7.3`, the Display it
  was made for; `1.54` for generations from before panels), `orientation`
  (`landscape` or `portrait`; `landscape` for older ones), `model`, `quality`,
  and `usage`: the token counts OpenAI reported for that
  generation (`total_tokens`, `input_tokens`, `output_tokens`), or `null` if
  the model reported none. The page shows the same counts after generating.

**History** (`/history.html`, linked from the top of the generator) shows the
last 50 generations, newest first: the image at its panel's size, what was typed, the
style, model, date and tokens, with the full prompt behind **Prompt sent**.
Clicking an image opens its 1024x1024 original. It reads `images/` through
`/api/generations` and `/api/images/<name>.png`; images converted from a photo
or upload are not listed: they are stored only when sent, without an original.

With a partner set (see Sending to the partner's display), each card has **Send to <partner>**. It packs
the frame again from the original, reduced to Spectra 6 and dithered, the
generator's defaults, so a stored copy rendered in another palette still comes
out right on the panel. It replaces whatever the
partner's display shows, like Send on the generator.

**Delete** on a card asks first, then removes that generation for good:
`POST /api/delete` with `{ name }` deletes `<name>.png`, its `-240.png` and
`-800.png` copies, `<name>.json`, and its frames (`-240.bin`, `-800.bin` and any
older `<name>.bin`). A frame that is still the current one in a
display's inbox is kept, so that display can still fetch it; the answer says
so with `frameKept: true`. Either partner can delete any generation.

If the folder cannot be written the image is still returned and the reason is
logged. Nothing is deleted except through **Delete** on History, and a frame
kept for a display stays until you clear it yourself.

## OpenAI API key

The server is the only place the key lives; the page never sees it.

1. Sign in at <https://platform.openai.com>, add billing under **Settings →
   Billing**, and set a monthly budget under **Limits** so a runaway prompt
   loop cannot get expensive.
2. The GPT Image models need a verified organization: **Settings →
   Organization → General → Verify Organization**. Without it every
   generation fails with an error from OpenAI, shown on the page.
3. Under **API keys**, create a new secret key, ideally in its own project.
   With permissions set to **Restricted**, the app needs write access to
   **Images** only. Copy the key: it is shown once.
4. Give it to the server as `OPENAI_API_KEY`:
   - **Locally:** put `OPENAI_API_KEY=sk-...` in `.env` (copied from
     `.env.example`; git-ignored) and restart `npm start`.
   - **Dashboard install:** add `OPENAI_API_KEY=sk-...` to the **Environment**
     field (see **Install it from the dashboard**), then restart the app.

To check it: the page's header line reads "colored e-ink images for the 1.54″ and 7.3″ displays" when
the key is set and "OPENAI_API_KEY is not set on the server" when it is not.
To rotate it, create a new key, swap it in, restart, then revoke the old one.
Never commit it: `.env` is ignored, `.env.example` must only ever hold
`sk-change-me`.

## Environment

| Variable               | Default       | Meaning                                        |
| ---------------------- | ------------- | ---------------------------------------------- |
| `OPENAI_API_KEY`       | —             | required; without it `/api/generate` answers 503 |
| `OPENAI_IMAGE_MODEL`   | `gpt-image-1` | the model the page starts on; the picklist is `MODELS` in `server.js` |
| `OPENAI_IMAGE_QUALITY` | `low`         | `low`, `medium` or `high`; low is plenty at 240px |
| `IMAGES_DIR`           | `images`      | where generations are stored; relative to the app folder |
| `ACCESS_TEAM_DOMAIN`   | —             | e.g. `your-team.cloudflareaccess.com`; see **Cloudflare Access** |
| `ACCESS_AUD`           | —             | the Access application's audience (AUD) tag    |
| `INBOX_DIR`            | `inbox`       | each display's current frame; relative to the app folder |
| `CONFIG_FILE`          | `config.json` | users, partners and devices; relative to the app folder |
| `DEV_USER`             | —             | without Access: act as this user (an email in `config.json`) |
| `DEV_DEVICE`           | —             | without Access: act as this device (an `id` in `config.json`) on `/api/device/*` |
| `TOKEN`                | —             | without Access only; see **Token** below       |
| `PORT`                 | `8090`        |                                                |
| `HOST`                 | `0.0.0.0`     | `127.0.0.1` when cloudflared runs on the same node, so the app is reachable only through the tunnel |

Each generation is billed to the key. Put the app behind Cloudflare Access (or
at least set `TOKEN`) if it is reachable by anyone you would not hand the key to.

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
| Environment    | `OPENAI_API_KEY=…`, `ACCESS_TEAM_DOMAIN=…`, `ACCESS_AUD=…` |
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

## Cloudflare Access

The public address is published through a Cloudflare Tunnel with Cloudflare
Zero Trust (Access) in front, so the app has no login of its own. Every request
Access lets through carries a signed token in the `Cf-Access-Jwt-Assertion`
header. With `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` set, the app checks that
token on every request except `/api/health`: the RS256 signature against the
team's keys at `https://<team>/cdn-cgi/access/certs` (fetched once and kept
for an hour), the audience tag, the issuer and the expiry. Then it looks the
caller up in `config.json`:

- **A partner** signs in with their email; the token carries it. The email must
  be a user in `config.json`.
- **A display** uses its own Access service token, sending
  `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Cloudflare checks them
  and forwards a token with no email and the token's Client ID as
  `common_name`, which must be a device's `clientId` in `config.json`.

Anything else is refused: no token 401, a bad, expired or foreign token 401,
a valid token for someone not in `config.json` 403. A display can use only
`/api/device/*` and a partner only the rest. If the signing keys cannot be
fetched the app answers 503 rather than letting anyone in.

`config.json` is git-ignored, so copy it to the node by hand next to
`server.js`. Each user has an `email`, a `name` and their `partner`'s email;
each device has an `id` (lowercase letters, digits and `-`), the `clientId` of
its service token, its `owner`'s email, its `panel` (`1.54` by default, or
`7.3`) and its `orientation` (`landscape` by default, or `portrait`). `panel`
and `orientation` only label the display in the page; they do not decide what
it is sent. The Client ID is an identifier, not
a secret; the Client Secret lives only on the device and is never written into
the app. A mistake in the file stops the server at start-up with the reason.

While Access is configured, `TOKEN`, `DEV_USER` and `DEV_DEVICE` are ignored.
Never run with Access off on an address the internet can reach: the headers
are then not checked at all. Set `HOST=127.0.0.1` when cloudflared runs on the
same node, so the app cannot be reached past the tunnel.

When an Access session expires, Cloudflare answers the page's API calls with a
redirect to its login. The pages notice and reload, which takes the browser
through the login and back.

**Local runs** have no Cloudflare in front. Leave the two `ACCESS_` variables
unset and set `DEV_USER` to a user's email to act as that partner on the
website, and `DEV_DEVICE` to a device id to act as that display on
`/api/device/*`. Without them the website is open and nobody is recorded.

## Token

Only without Cloudflare Access. With `TOKEN` set, every path except `/api/health` wants `?token=` or an
`x-token` header. Set the same token on the app card with **Link** and the
dashboard link opens it signed in. Anyone who can open the dashboard can then
open the app; the dashboard can already stop it, so that grant is small but real.
