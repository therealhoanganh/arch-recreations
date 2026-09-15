// Re-encoding a downloaded poster, banner or still. Runs in Obsidian's renderer, which
// carries Chromium's canvas encoder, so there is no external tool.
//
// Chromium encodes image/png, image/jpeg and image/webp and nothing else. WebP
// is what the video thumbnails become in this vault, and it is roughly half the
// size of the JPEG TMDB serves. This file is therefore renderer-only: unlike the
// rest of lib/ it cannot run under plain Node, because OffscreenCanvas does not
// exist there.

async function encodeWebp(blob, quality = 0.85, opts = {}) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality });
  const data = new Uint8Array(await out.arrayBuffer());
  // A small image can come out larger as WebP. By default the original is
  // kept then; `always` takes the WebP regardless, for a caller that wants
  // one extension on every file it writes.
  if (data.length >= blob.size && !opts.always) return { data: null, skipped: 'larger' };
  return { data, ext: '.webp', bytes: data.length };
}

module.exports = { encodeWebp };
