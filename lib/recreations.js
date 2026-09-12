'use strict';

// Everything that can be reasoned about without Obsidian: shaping a TMDB
// answer into a note, choosing a subtitle, reading Radarr's config file. Nothing
// here may require('obsidian') -- that module is injected into main.js's scope
// only, and the build lists it as external so a stray require fails loudly.

const fs = require('fs');
const path = require('path');
const { encodeWebp } = require('./image.js');

/* ---------------- strings ---------------- */

function safeFileName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 110)
    .trim();
  return cleaned || fallback;
}

function yamlString(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '""';
  if (/^[\w .,\-/]+$/.test(s) && !/^\s|\s$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlString(item)}`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// "a, b, c" or one per line -> ['a', 'b', 'c']
function splitList(raw) {
  return String(raw || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// "key: value" lines from a default-properties setting. A number or a
// true/false is written as such, anything else as a string.
function parseDefaults(raw) {
  const out = {};
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*([^\s:#][^:]*?)\s*:\s*(.*?)\s*$/);
    if (!m || !m[2]) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = Number(v);
    else if (v === 'true' || v === 'false') out[m[1]] = v === 'true';
    else out[m[1]] = v;
  }
  return out;
}

// Adds every default the note does not already have. Never changes a value
// that is there: these are starting points for a human to edit.
function addMissingDefaults(fm, defaults) {
  let added = false;
  for (const [k, v] of Object.entries(defaults || {})) {
    if (Object.prototype.hasOwnProperty.call(fm, k)) continue;
    fm[k] = v;
    added = true;
  }
  return added;
}

// "TMDB name = your name" pairs, one per line or comma-separated. TMDB says
// "Science Fiction" where these vaults say Sci-Fi; the map is where that lives.
function parseRenameMap(raw) {
  const out = {};
  for (const pair of splitList(raw)) {
    const m = pair.match(/^(.+?)\s*=\s*(.+)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function wikilink(name) {
  const clean = String(name || '').replace(/[[\]|#^]/g, '').trim();
  return clean ? `[[${clean}]]` : '';
}

function fillTemplate(template, vars) {
  return String(template || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) =>
    vars[k] === undefined || vars[k] === null ? '' : String(vars[k])
  );
}

// Listed keys first, in that order; the rest keep their place after them. When
// `own` is given, an own (plugin-produced) key that is not listed is dropped --
// the order setting decides what this plugin writes, so a note can be slimmed
// without a code change -- while a key a person added by hand is always kept.
function applyOrder(fm, order, own) {
  const wanted = splitList(order);
  const ordered = {};
  for (const key of wanted) {
    if (Object.prototype.hasOwnProperty.call(fm, key)) ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) {
    if (key in ordered) continue;
    if (own && own.has(key) && wanted.length) continue;
    ordered[key] = fm[key];
  }
  for (const key of Object.keys(fm)) delete fm[key];
  Object.assign(fm, ordered);
  return fm;
}

/* ---------------- TMDB ---------------- */

const TMDB_IMAGE = 'https://image.tmdb.org/t/p/original';

function tmdbMovieUrl(id, title) {
  const slug = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `https://www.themoviedb.org/movie/${id}${slug ? '-' + slug : ''}`;
}

// The TMDB id out of whatever the URL property holds: a markdown link, a bare
// address, or just the number.
function tmdbIdFromText(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/themoviedb\.org\/movie\/(\d+)/) || s.match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function dedupe(names) {
  const seen = new Set();
  return names.filter((n) => {
    const k = String(n || '').trim();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// Most voted first. TMDB's vote_average is 0 for an unrated image, so a
// handful of rated ones always lead, then the rest in TMDB's own order.
function byVotes(a, b) {
  return b.vote_average - a.vote_average || b.vote_count - a.vote_count;
}

// One TMDB answer (movie + images + credits) shaped into what the note needs.
// Posters prefer the note's language, then textless; backdrops are the
// textless ones, most voted first. The top backdrop is usually key art, which
// is what a banner wants, and the stills are the ones after it.
function movieFromTmdb(json, opts = {}) {
  const lang = opts.language || 'en';
  const stills = Number.isFinite(opts.stills) ? opts.stills : 5;
  const actors = Number.isFinite(opts.actors) ? opts.actors : 5;
  const rename = opts.genreMap || {};

  const crew = (json.credits && json.credits.crew) || [];
  const cast = (json.credits && json.credits.cast) || [];
  const images = json.images || {};

  const posters = (images.posters || []).slice().sort(byVotes);
  const poster =
    posters.find((p) => p.iso_639_1 === lang) ||
    posters.find((p) => !p.iso_639_1) ||
    posters[0] ||
    (json.poster_path ? { file_path: json.poster_path } : null);

  const backdrops = (images.backdrops || []).slice().sort(byVotes);
  const textless = backdrops.filter((b) => !b.iso_639_1);
  const ordered = textless.length ? textless : backdrops;
  const banner = ordered[0] || (json.backdrop_path ? { file_path: json.backdrop_path } : null);
  const stillList = ordered.slice(1, 1 + stills);

  const year = String(json.release_date || '').slice(0, 4);
  return {
    tmdbId: json.id,
    imdbId: json.imdb_id || '',
    title: json.title || json.original_title || '',
    year: year ? Number(year) : null,
    runtime: json.runtime || null,
    overview: json.overview || '',
    genres: (json.genres || []).map((g) => rename[g.name] || g.name),
    directors: dedupe(crew.filter((c) => c.job === 'Director').map((c) => c.name)),
    writers: dedupe(crew.filter((c) => c.department === 'Writing').map((c) => c.name)),
    actors: dedupe(cast.slice(0, actors).map((c) => c.name)),
    poster: poster ? TMDB_IMAGE + poster.file_path : '',
    banner: banner ? TMDB_IMAGE + banner.file_path : '',
    stills: stillList.map((b) => TMDB_IMAGE + b.file_path),
    url: tmdbMovieUrl(json.id, json.title),
  };
}

/* ---------------- the note ---------------- */

// The plugin's own properties for a film note, in template order. `links` are
// the already-saved images as aliased wikilinks. Every key here is one the
// order setting may drop; hand-added ones are never in this set.
const OWN_KEYS = new Set([
  'duration', 'year', 'URL', 'poster', 'banner', 'genres', 'director', 'writer', 'actors',
  'quality', 'dl-ed', 'file', 'tags',
]);

function movieNoteFields(movie, links, opts = {}) {
  const tags = (opts.tags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
  return {
    duration: movie.runtime || undefined,
    year: movie.year || undefined,
    URL: `[TMDB](${movie.url})`,
    poster: links.poster || undefined,
    banner: links.banner || undefined,
    genres: movie.genres.map(wikilink),
    director: movie.directors.map(wikilink),
    writer: movie.writers.map(wikilink),
    actors: movie.actors.map(wikilink),
    quality: opts.quality || undefined,
    'dl-ed': opts.radarr ? false : undefined,
    tags,
  };
}

// The body is the museum wall: one embed per still, nothing else.
function movieNoteBody(stillLinks) {
  if (!stillLinks.length) return '';
  return stillLinks.map((l) => `!${l}`).join('\n') + '\n';
}

// A file outside the vault as a link the properties panel can open.
function fileLink(absPath, label = 'Open') {
  const url = 'file://' + encodeURI(absPath).replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  return `[${label}](${url})`;
}

/* ---------------- Radarr ---------------- */

// Radarr keeps its API key in config.xml. Where that is depends on the OS; the
// macOS app writes under Application Support, not ~/.config.
function radarrConfigCandidates(platform, home, env = {}) {
  const c = [];
  if (platform === 'darwin') c.push(path.join(home, 'Library', 'Application Support', 'Radarr', 'config.xml'));
  if (platform === 'win32' && env.ProgramData) c.push(path.join(env.ProgramData, 'Radarr', 'config.xml'));
  c.push(path.join(home, '.config', 'Radarr', 'config.xml'));
  return c;
}

function parseRadarrConfig(xml) {
  const pick = (tag) => {
    const m = String(xml || '').match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() : '';
  };
  const port = Number(pick('Port')) || 7878;
  const base = pick('UrlBase').replace(/^\/+|\/+$/g, '');
  return {
    apiKey: pick('ApiKey'),
    url: `http://localhost:${port}${base ? '/' + base : ''}`,
  };
}

function readRadarrConfig(platform, home, env) {
  for (const file of radarrConfigCandidates(platform, home, env)) {
    try {
      const xml = fs.readFileSync(file, 'utf8');
      const parsed = parseRadarrConfig(xml);
      if (parsed.apiKey) return { ...parsed, file };
    } catch (_) {
      /* not there */
    }
  }
  return null;
}

/* ---------------- OpenSubtitles ---------------- */

// The OpenSubtitles hash: file size plus every 8-byte word of the first and
// last 64 KB, little-endian, summed modulo 2^64. Cheap on a 2 GB file because
// only 128 KB are read.
function openSubtitlesHash(file) {
  const size = fs.statSync(file).size;
  const chunk = 65536;
  const fd = fs.openSync(file, 'r');
  try {
    let sum = BigInt(size);
    const add = (buf) => {
      for (let i = 0; i + 8 <= buf.length; i += 8) sum = (sum + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    };
    const head = Buffer.alloc(Math.min(chunk, size));
    fs.readSync(fd, head, 0, head.length, 0);
    add(head);
    const tail = Buffer.alloc(Math.min(chunk, size));
    fs.readSync(fd, tail, 0, tail.length, Math.max(0, size - chunk));
    add(tail);
    return sum.toString(16).padStart(16, '0');
  } finally {
    fs.closeSync(fd);
  }
}

// Hash match first (timed to this exact file), then not hearing-impaired (no
// [door creaks] captions), then the most downloaded.
function pickSubtitle(results) {
  const rows = (results || [])
    .map((r) => r.attributes || {})
    .filter((a) => a.files && a.files.length && a.files[0].file_id);
  rows.sort(
    (a, b) =>
      Number(!!b.moviehash_match) - Number(!!a.moviehash_match) ||
      Number(!!a.hearing_impaired) - Number(!!b.hearing_impaired) ||
      (b.download_count || 0) - (a.download_count || 0)
  );
  const best = rows[0];
  if (!best) return null;
  return {
    fileId: best.files[0].file_id,
    release: best.release || '',
    hashMatch: !!best.moviehash_match,
    hearingImpaired: !!best.hearing_impaired,
    downloads: best.download_count || 0,
  };
}

// "<movie>.en.srt" beside the film: the name every player picks up unasked.
function subtitlePath(moviePath, lang) {
  const ext = path.extname(moviePath);
  return moviePath.slice(0, moviePath.length - ext.length) + `.${lang}.srt`;
}

module.exports = {
  safeFileName,
  yamlString,
  buildFrontmatter,
  splitList,
  parseDefaults,
  addMissingDefaults,
  parseRenameMap,
  wikilink,
  fillTemplate,
  applyOrder,
  tmdbMovieUrl,
  tmdbIdFromText,
  movieFromTmdb,
  movieNoteFields,
  movieNoteBody,
  fileLink,
  OWN_KEYS,
  radarrConfigCandidates,
  parseRadarrConfig,
  readRadarrConfig,
  openSubtitlesHash,
  pickSubtitle,
  subtitlePath,
  encodeWebp,
};
