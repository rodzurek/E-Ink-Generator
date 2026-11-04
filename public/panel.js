// What the generator, History and the server share about the panels: their
// sizes, the inks, reducing an image to them, and packing the result into a
// panel's frame. The server imports this file too, so keep it free of browser
// calls outside functions.

// Pure primaries, the values e-ink converters and drivers map to panel inks.
export const INK = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], yellow: [255, 255, 0],
  blue: [0, 0, 255], green: [0, 255, 0], orange: [255, 128, 0],
};

// The inks a frame for a panel must be reduced to.
export const PANEL_INKS = ['black', 'white', 'red', 'yellow', 'blue', 'green'];

// The panels a display can have. The id is what config.json's device `panel`
// and a generation's `panel` name. `api` is the size asked of OpenAI, the
// nearest one it offers; the page fits the result into width x height.
// `width` x `height` is the panel's own raster, landscape; a display mounted
// upright in portrait shows it turned, see toPanel.
export const PANELS = {
  // The 1.54inch e-Paper Module (E), a Spectra 6 panel. Its color codes are
  // from Waveshare's EPD_1in54e driver demo (github.com/waveshareteam/1.54inch_e-Paper_E)
  // and were checked with a color band test on the wired panel.
  '1.54': {
    label: '1.54″ 240×240', width: 240, height: 240, api: '1024x1024', apiPortrait: '1024x1024',
    codes: { black: 0x0, white: 0x1, yellow: 0x2, red: 0x3, blue: 0x5, green: 0x6 },
  },
  // The 7.3inch e-Paper HAT (E), a Spectra 6 panel. Its codes are the ones
  // the board's firmware draws with (main/epd_7in3e.h in ESP-Ink-Generator),
  // checked with its color bar test on the wired panel. Orange and clean are not inks here.
  '7.3': {
    label: '7.3″ 800×480', width: 800, height: 480, api: '1536x1024', apiPortrait: '1024x1536',
    codes: { black: 0x0, white: 0x1, yellow: 0x2, red: 0x3, blue: 0x5, green: 0x6 },
  },
};

export const DEFAULT_PANEL = '1.54';
export const ORIENTATIONS = ['landscape', 'portrait'];
export const DEFAULT_ORIENTATION = 'landscape';

// What the Display picklist offers: a panel shown in an orientation.
export const DISPLAYS = [
  { id: '1.54', label: '1.54″ 240×240', panel: '1.54', orientation: 'landscape' },
  { id: '7.3-landscape', label: '7.3″ 800×480 landscape', panel: '7.3', orientation: 'landscape' },
  { id: '7.3-portrait', label: '7.3″ 800×480 portrait', panel: '7.3', orientation: 'portrait' },
];

// The frame's size in bytes: two pixels per byte, at 4 bits each.
export function frameBytes({ width, height }) {
  return width * height / 2;
}

// The shape an image takes on a panel in an orientation: portrait swaps the sides.
export function viewOf(panel, orientation) {
  const { width, height } = PANELS[panel];
  return orientation === 'portrait' ? { width: height, height: width } : { width, height };
}

// An image as shown in an orientation, turned into the panel's landscape raster.
// Portrait is turned clockwise, so a display mounted upright shows it upright.
export function toPanel(image, orientation) {
  if (orientation !== 'portrait') return image;
  const { width: w, height: h } = image;
  // The result is h wide and w high: the source's column x becomes row x, its row y becomes column h - 1 - y.
  const out = new ImageData(h, w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const from = (y * w + x) * 4;
      const to = (x * h + (h - 1 - y)) * 4;
      out.data.set(image.data.subarray(from, from + 4), to);
    }
  }
  return out;
}

function nearest(colors, r, g, b) {
  let best = colors[0];
  let bestDistance = Infinity;
  for (const c of colors) {
    const distance = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = c; }
  }
  return best;
}

// `source` (an ImageData, any size) reduced to the given inks, as ImageData of the same size.
export function reduce(source, names, dither) {
  const { width, height } = source;
  const colors = names.map((name) => INK[name]);
  const px = new Float32Array(source.data);
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = nearest(colors, px[i], px[i + 1], px[i + 2]);
      for (let k = 0; k < 3; k++) {
        out.data[i + k] = c[k];
        if (!dither) continue;
        const error = px[i + k] - c[k];
        if (x + 1 < width) px[i + 4 + k] += error * 7 / 16;
        if (y + 1 < height) {
          if (x > 0) px[i + width * 4 - 4 + k] += error * 3 / 16;
          px[i + width * 4 + k] += error * 5 / 16;
          if (x + 1 < width) px[i + width * 4 + 4 + k] += error * 1 / 16;
        }
      }
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// Scales an image onto a panel's pixels in `ctx`, sets the canvas to the
// panel's size and returns them. The whole image is fitted in and centered,
// nothing cut off: where its shape differs from the panel's, the rest is
// black bars (a 1536x1024 generation on the 800x480 panel gets 40px each side).
// Transparency inside the image becomes white like the paper.
export function scale(ctx, img, { width, height }) {
  ctx.canvas.width = width;
  ctx.canvas.height = height;
  const fit = Math.min(width / img.naturalWidth, height / img.naturalHeight);
  const drawWidth = Math.round(img.naturalWidth * fit);
  const drawHeight = Math.round(img.naturalHeight * fit);
  const left = Math.floor((width - drawWidth) / 2);
  const top = Math.floor((height - drawHeight) / 2);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fff';
  ctx.fillRect(left, top, drawWidth, drawHeight);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, left, top, drawWidth, drawHeight);
  return ctx.getImageData(0, 0, width, height);
}

// The panel's frame: row by row from the top left, two pixels per byte,
// the left one in the high nibble. Every pixel must already be a pure ink.
export function packFrame(image, panel) {
  const code = new Map(Object.entries(panel.codes).map(([name, value]) => [INK[name].join(), value]));
  const count = image.width * image.height;
  const frame = new Uint8Array(count / 2);
  for (let p = 0; p < count; p++) {
    const value = code.get(`${image.data[p * 4]},${image.data[p * 4 + 1]},${image.data[p * 4 + 2]}`);
    frame[p >> 1] |= (p & 1) ? value : value << 4;
  }
  return frame;
}

export function base64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}
