// What the generator and History share about the panel: its size, the inks,
// reducing an image to them, and packing the result into the panel's frame.

export const SIZE = 240;

// Pure primaries, the values e-ink converters and drivers map to panel inks.
export const INK = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], yellow: [255, 255, 0],
  blue: [0, 0, 255], green: [0, 255, 0], orange: [255, 128, 0],
};

// Both displays are Spectra 6 panels, the 1.54inch e-Paper Module (E). Its
// color codes, from Waveshare's EPD_1in54e driver demo
// (github.com/waveshareteam/1.54inch_e-Paper_E) and checked with a color
// band test on the wired panel. Codes 4 and 7 are not inks.
export const PANEL_CODES = { black: 0x0, white: 0x1, yellow: 0x2, red: 0x3, blue: 0x5, green: 0x6 };

// The inks a frame for the panel must be reduced to.
export const PANEL_INKS = ['black', 'white', 'red', 'yellow', 'blue', 'green'];

function nearest(colors, r, g, b) {
  let best = colors[0];
  let bestDistance = Infinity;
  for (const c of colors) {
    const distance = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
    if (distance < bestDistance) { bestDistance = distance; best = c; }
  }
  return best;
}

// `source` (SIZE x SIZE ImageData) reduced to the given inks, as ImageData.
export function reduce(source, names, dither) {
  const colors = names.map((name) => INK[name]);
  const px = new Float32Array(source.data);
  const out = new ImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const c = nearest(colors, px[i], px[i + 1], px[i + 2]);
      for (let k = 0; k < 3; k++) {
        out.data[i + k] = c[k];
        if (!dither) continue;
        const error = px[i + k] - c[k];
        if (x + 1 < SIZE) px[i + 4 + k] += error * 7 / 16;
        if (y + 1 < SIZE) {
          if (x > 0) px[i + SIZE * 4 - 4 + k] += error * 3 / 16;
          px[i + SIZE * 4 + k] += error * 5 / 16;
          if (x + 1 < SIZE) px[i + SIZE * 4 + 4 + k] += error * 1 / 16;
        }
      }
      out.data[i + 3] = 255;
    }
  }
  return out;
}

// Scales an image onto the panel's pixels in `ctx` (a SIZE x SIZE canvas) and
// returns them. Anything not square is center-cropped, and transparency
// becomes white like the paper.
export function scale(ctx, img) {
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const left = (img.naturalWidth - side) / 2;
  const top = (img.naturalHeight - side) / 2;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, left, top, side, side, 0, 0, SIZE, SIZE);
  return ctx.getImageData(0, 0, SIZE, SIZE);
}

// The panel's frame: row by row from the top left, two pixels per byte,
// the left one in the high nibble. Every pixel must already be a pure ink.
export function packFrame(image) {
  const code = new Map(Object.entries(PANEL_CODES).map(([name, value]) => [INK[name].join(), value]));
  const frame = new Uint8Array(SIZE * SIZE / 2);
  for (let p = 0; p < SIZE * SIZE; p++) {
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
