/**
 * Minimal PNG encoder and RGBA scaling — no external dependencies.
 * Format: 8 bits per channel, color type 6 (RGBA), no interlace.
 */
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * @param {{width:number,height:number,data:Uint8Array}} image RGBA frame (width*height*4 bytes).
 * @param {{level?:number}} [options] zlib level.
 * @returns {Buffer} PNG file.
 */
export function encodePng(image, options = {}) {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // None filter: simpler and more predictable for screenshots
    Buffer.from(data.buffer ?? data, data.byteOffset ?? 0, data.length).copy(
      raw,
      y * (stride + 1) + 1,
      y * stride,
      y * stride + stride,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: options.level ?? 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Frame downscaling with an integer box filter (block averaging).
 * @param {{width:number,height:number,data:Uint8Array}} image the source RGBA frame.
 * @param {number} factor an integer ≥ 1; 1 returns the source frame.
 * @returns {{width:number,height:number,data:Uint8Array,scale:number}}
 */
export function downscaleBox(image, factor) {
  const step = Math.max(1, Math.floor(factor));
  if (step === 1) return { ...image, scale: 1 };
  const width = Math.max(1, Math.floor(image.width / step));
  const height = Math.max(1, Math.floor(image.height / step));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let dy = 0; dy < step; dy += 1) {
        const sy = y * step + dy;
        if (sy >= image.height) break;
        for (let dx = 0; dx < step; dx += 1) {
          const sx = x * step + dx;
          if (sx >= image.width) break;
          const i = (sy * image.width + sx) * 4;
          r += image.data[i];
          g += image.data[i + 1];
          b += image.data[i + 2];
          a += image.data[i + 3];
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width, height, data: out, scale: 1 / step };
}

/**
 * An almost single-colour frame: most often a blanked display or a black lock screen.
 * The check samples coarsely instead of scanning a million pixels. It lives here, not in
 * the tools, because the observation panel needs the very same verdict.
 * @param {{width:number,height:number,data:Uint8Array}} image RGBA frame.
 * @returns {boolean} true when the frame is practically one colour.
 */
export function looksBlank(image) {
  const step = Math.max(4, Math.floor((image.width * image.height) / 4096)) * 4;
  let min = 255;
  let max = 0;
  for (let i = 0; i < image.data.length; i += step) {
    const value = image.data[i];
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return max - min <= 6;
}

/**
 * Rectangle cropping; the coordinates are clipped to the frame.
 * @param {{width:number,height:number,data:Uint8Array}} image the source RGBA frame.
 * @param {{x:number,y:number,width:number,height:number}} region the rectangle.
 * @returns {{width:number,height:number,data:Uint8Array,x:number,y:number}}
 */
export function cropRegion(image, region) {
  const x = Math.max(0, Math.min(image.width - 1, Math.floor(region.x)));
  const y = Math.max(0, Math.min(image.height - 1, Math.floor(region.y)));
  const width = Math.max(1, Math.min(image.width - x, Math.floor(region.width)));
  const height = Math.max(1, Math.min(image.height - y, Math.floor(region.height)));
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    out.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data: out, x, y };
}
