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
// The poster is TMDB's own primary (`poster_path`) -- the one its film page
// shows, chosen by editors, not by votes; sorting by vote average once picked
// a poster the user found ugly over the one he saw first on TMDB. Backdrop 01
// is likewise the primary `backdrop_path`; the rest are the textless ones by
// votes. The first backdrop is what the banner property points at -- the same
// file, not a second download.
function movieFromTmdb(json, opts = {}) {
  const lang = opts.language || 'en';
  const backdropCount = Number.isFinite(opts.backdrops) ? opts.backdrops : 5;
  const actors = Number.isFinite(opts.actors) ? opts.actors : 5;
  const rename = opts.genreMap || {};

  const crew = (json.credits && json.credits.crew) || [];
  const cast = (json.credits && json.credits.cast) || [];
  const images = json.images || {};

  const posters = (images.posters || []).slice().sort(byVotes);
  const poster =
    (json.poster_path ? { file_path: json.poster_path } : null) ||
    posters.find((p) => p.iso_639_1 === lang) ||
    posters.find((p) => !p.iso_639_1) ||
    posters[0] ||
    null;

  const backdrops = (images.backdrops || []).slice().sort(byVotes);
  const textless = backdrops.filter((b) => !b.iso_639_1);
  let ordered = (textless.length ? textless : backdrops).filter((b) => b.file_path !== json.backdrop_path);
  if (json.backdrop_path) ordered.unshift({ file_path: json.backdrop_path });

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
    backdrops: ordered.slice(0, backdropCount).map((b) => TMDB_IMAGE + b.file_path),
    url: tmdbMovieUrl(json.id, json.title),
  };
}

function tmdbTvUrl(id, name) {
  const slug = String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `https://www.themoviedb.org/tv/${id}${slug ? '-' + slug : ''}`;
}

function tmdbTvIdFromText(text) {
  const m = String(text == null ? '' : text).match(/themoviedb\.org\/tv\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// One TMDB answer (tv + images + credits + external_ids) shaped for the
// series note. Seasons are the real ones -- season 0 is specials and is left
// out. Sonarr wants the TVDB id, which TMDB carries in external_ids.
function seriesFromTmdb(json, opts = {}) {
  const lang = opts.language || 'en';
  const backdropCount = Number.isFinite(opts.backdrops) ? opts.backdrops : 5;
  const actors = Number.isFinite(opts.actors) ? opts.actors : 5;
  const rename = opts.genreMap || {};
  const images = json.images || {};
  const cast = (json.credits && json.credits.cast) || (json.aggregate_credits && json.aggregate_credits.cast) || [];

  const posters = (images.posters || []).slice().sort(byVotes);
  const poster =
    (json.poster_path ? { file_path: json.poster_path } : null) ||
    posters.find((p) => p.iso_639_1 === lang) ||
    posters.find((p) => !p.iso_639_1) ||
    posters[0] ||
    null;
  const backdrops = (images.backdrops || []).slice().sort(byVotes);
  const textless = backdrops.filter((b) => !b.iso_639_1);
  let ordered = (textless.length ? textless : backdrops).filter((b) => b.file_path !== json.backdrop_path);
  if (json.backdrop_path) ordered.unshift({ file_path: json.backdrop_path });

  const year = String(json.first_air_date || '').slice(0, 4);
  const ext = json.external_ids || {};
  return {
    tmdbId: json.id,
    tvdbId: ext.tvdb_id || null,
    imdbId: ext.imdb_id || '',
    title: json.name || json.original_name || '',
    year: year ? Number(year) : null,
    status: json.status || '',
    overview: json.overview || '',
    genres: (json.genres || []).map((g) => rename[g.name] || g.name),
    creators: dedupe((json.created_by || []).map((c) => c.name)),
    actors: dedupe(cast.slice(0, actors).map((c) => c.name)),
    seasons: (json.seasons || [])
      .filter((x) => x.season_number > 0)
      .map((x) => ({
        number: x.season_number,
        name: x.name || `Season ${x.season_number}`,
        episodeCount: x.episode_count || 0,
        year: x.air_date ? Number(String(x.air_date).slice(0, 4)) : null,
        poster: x.poster_path ? TMDB_IMAGE + x.poster_path : '',
      })),
    poster: poster ? TMDB_IMAGE + poster.file_path : '',
    backdrops: ordered.slice(0, backdropCount).map((b) => TMDB_IMAGE + b.file_path),
    url: tmdbTvUrl(json.id, json.name),
  };
}

// One TMDB season answer (season + images). The poster is TMDB's primary for
// the season, the one its season page shows; TMDB has no season backdrops.
function seasonFromTmdb(json, opts = {}) {
  const lang = opts.language || 'en';
  const images = json.images || {};
  const posters = (images.posters || []).slice().sort(byVotes);
  const poster =
    (json.poster_path ? { file_path: json.poster_path } : null) ||
    posters.find((p) => p.iso_639_1 === lang) ||
    posters.find((p) => !p.iso_639_1) ||
    posters[0] ||
    null;
  return {
    number: json.season_number,
    name: json.name || `Season ${json.season_number}`,
    year: json.air_date ? Number(String(json.air_date).slice(0, 4)) : null,
    overview: json.overview || '',
    poster: poster ? TMDB_IMAGE + poster.file_path : '',
    episodes: (json.episodes || []).map((e) => ({
      number: e.episode_number,
      title: e.name || `Episode ${e.episode_number}`,
      airDate: e.air_date || '',
      runtime: e.runtime || null,
    })),
  };
}

/* ---------------- the note ---------------- */

// The plugin's own properties for a film note, in template order. `links` are
// the already-saved images as aliased wikilinks. Every key here is one the
// order setting may drop; hand-added ones are never in this set.
const OWN_KEYS = new Set([
  'duration', 'year', 'URL', 'poster', 'banner', 'genres', 'director', 'writer', 'actors',
  'quality', 'dl-ed', 'file', 'tags',
  'seasons', 'episodes', 'creator', 'series', 'season',
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

// The body is the museum wall: the poster, then one embed per backdrop.
function movieNoteBody(posterLink, backdropLinks) {
  const all = [posterLink, ...backdropLinks].filter(Boolean);
  if (!all.length) return '';
  return all.map((l) => `!${l}`).join('\n') + '\n';
}

// A series note reads like a film note: `creator` where a film has
// `director`, `seasons` where it has `duration`.
function seriesNoteFields(series, links, opts = {}) {
  const tags = (opts.tags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
  return {
    // The season notes themselves, as wikilinks, so the properties panel is
    // the way into them.
    seasons: opts.seasonLinks && opts.seasonLinks.length ? opts.seasonLinks : undefined,
    year: series.year || undefined,
    URL: `[TMDB](${series.url})`,
    poster: links.poster || undefined,
    banner: links.banner || undefined,
    genres: series.genres.map(wikilink),
    creator: series.creators.map(wikilink),
    actors: series.actors.map(wikilink),
    quality: opts.quality || undefined,
    'dl-ed': opts.sonarr ? false : undefined,
    tags,
  };
}

// The same wall as a film note; the seasons are in the properties.
function seriesNoteBody(posterLink, backdropLinks) {
  return movieNoteBody(posterLink, backdropLinks);
}

function seasonNoteFields(season, seriesLink, links, opts = {}) {
  const tags = (opts.tags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
  return {
    episodes: season.episodes.length || undefined,
    year: season.year || undefined,
    quality: opts.quality || undefined,
    'dl-ed': opts.sonarr ? false : undefined,
    series: seriesLink || undefined,
    poster: links.poster || undefined,
    tags,
  };
}

// One line per episode: an Open link once the file is there, plain text until
// then. Every line has the same shape, "- S1E1 – Name" or "- [S1E1 – Name](…)",
// and that shape is how a later check finds the block to replace it -- no
// markers in the note.
const EPISODE_LINE = /^- (?:\[)?S\d+E\d+ \u2013 /;

function episodeList(episodes, files, player) {
  return episodes
    .map((e) => {
      const label = `S${e.season}E${e.number} \u2013 ${e.title}`;
      const file = files && files[`${e.season}:${e.number}`];
      return file ? `- ${fileLink(file, player, label)}` : `- ${label}`;
    })
    .join('\n');
}

// Episodes first, so the note opens on the list; the poster under them,
// after three blank lines -- the user's spacing.
function seasonNoteBody(posterLink, episodes, files, player) {
  const parts = [episodeList(episodes, files, player)];
  if (posterLink) parts.push(`!${posterLink}`);
  return parts.join('\n\n\n\n') + '\n';
}

// Swaps the episode block in an existing body -- the first run of episode
// lines -- and also clears the comment markers an earlier version wrote.
// A body with no block gets one at the top.
function replaceEpisodeList(body, episodes, files, player) {
  const block = episodeList(episodes, files, player);
  const lines = String(body || '').replace(/^%% \/?episodes %%\n?/gm, '').split('\n');
  const start = lines.findIndex((l) => EPISODE_LINE.test(l));
  if (start < 0) return block + '\n\n\n\n' + lines.join('\n').replace(/^\n+/, '');
  let end = start;
  while (end + 1 < lines.length && EPISODE_LINE.test(lines[end + 1])) end++;
  return [...lines.slice(0, start), block, ...lines.slice(end + 1)].join('\n');
}

// A film outside the vault as a link the properties panel can click. With a
// player named, the link is an obsidian:// address this plugin answers by
// opening the file in that app -- so the link goes to VLC while every other
// .mp4 on the machine keeps its system default. Without one, a file:// link.
// Parentheses are encoded by hand: encodeURIComponent leaves them alone, and
// a ")" inside a markdown link's address ends the link early -- film folders
// are full of "(1979)".
function fileLink(absPath, player, label = 'Open') {
  const parens = (u) => u.replace(/[()]/g, (c) => (c === '(' ? '%28' : '%29'));
  const text = String(label).replace(/[[\]]/g, '');
  if (player) return `[${text}](obsidian://arch-recreations?play=${parens(encodeURIComponent(absPath))})`;
  return `[${text}](file://${parens(encodeURI(absPath))})`;
}

/* ---------------- picking a release by seeder tiers ---------------- */

// "100, 50, 20, 10" -> [100, 50, 20, 10], descending, de-duplicated. This is
// the cascade: try the highest floor first, and only drop to the next one if
// nothing clears it.
function parseSeederTiers(raw) {
  const nums = String(raw || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return [...new Set(nums)].sort((a, b) => b - a);
}

// Radarr's own release list, already carrying its rejections (quality,
// its indexer's minimum seeders, size floors). Among what Radarr has not
// rejected, the first tier that has any candidates wins, and the most-seeded
// release in that tier is the one returned -- so a floor of 100 with a
// 433-seeder release available never settles for one at 11.
// With `preferFullSeason`, a season pack beats single episodes inside a tier,
// so a season arrives as one torrent rather than twelve.
function pickRelease(releases, tiers, opts = {}) {
  const candidates = (releases || []).filter((r) => !r.rejected);
  for (const floor of tiers.length ? tiers : [0]) {
    const pool = candidates.filter((r) => (r.seeders || 0) >= floor);
    if (!pool.length) continue;
    pool.sort(
      (a, b) =>
        (opts.preferFullSeason ? Number(!!b.fullSeason) - Number(!!a.fullSeason) : 0) ||
        (b.seeders || 0) - (a.seeders || 0) ||
        (b.customFormatScore || 0) - (a.customFormatScore || 0)
    );
    return { release: pool[0], floor };
  }
  return null;
}

/* ---------------- finding the film on this machine ---------------- */

// The path on the note is where Radarr put the file on the machine that
// downloaded it. On another machine the same drive mounts somewhere else, so
// the part after the drive's name is what to look for: "Movies/Alien
// (1979)/x.mp4" under every mounted volume.
function splitAtVolume(absPath) {
  const p = String(absPath || '');
  let m;
  if ((m = p.match(/^\/Volumes\/([^/]+)\/(.+)$/))) return { volume: m[1], rel: m[2] };
  if ((m = p.match(/^\/(?:media|run\/media)\/[^/]+\/([^/]+)\/(.+)$/))) return { volume: m[1], rel: m[2] };
  if ((m = p.match(/^\/mnt\/([^/]+)\/(.+)$/))) return { volume: m[1], rel: m[2] };
  if ((m = p.match(/^[A-Za-z]:[\\/](.+)$/))) return { volume: '', rel: m[1].replace(/\\/g, '/') };
  return null;
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
}

// Every place the file could be on this machine, most likely first: the
// stored path, the same drive name at this platform's mount point, then every
// mounted drive. The first that exists wins.
function locateFile(absPath, platform = process.platform) {
  if (absPath && fs.existsSync(absPath)) return absPath;
  const split = splitAtVolume(absPath);
  if (!split) return null;
  const rel = split.rel;
  const candidates = [];
  if (platform === 'darwin') {
    if (split.volume) candidates.push(path.join('/Volumes', split.volume, rel));
    for (const v of listDir('/Volumes')) candidates.push(path.join('/Volumes', v, rel));
  } else if (platform === 'win32') {
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') candidates.push(`${letter}:\\${rel.replace(/\//g, '\\')}`);
  } else {
    for (const base of ['/media', '/run/media']) {
      for (const user of listDir(base)) {
        if (split.volume) candidates.push(path.join(base, user, split.volume, rel));
        for (const v of listDir(path.join(base, user))) candidates.push(path.join(base, user, v, rel));
      }
    }
    if (split.volume) candidates.push(path.join('/mnt', split.volume, rel));
    for (const v of listDir('/mnt')) candidates.push(path.join('/mnt', v, rel));
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {
      /* unreadable mount */
    }
  }
  return null;
}

// The path held by a `file` property, whichever form it has: the plugin's own
// obsidian:// link, a file:// link, or a bare path.
function pathFromFileProperty(value) {
  const s = String(value == null ? '' : value).trim();
  let m;
  if ((m = s.match(/obsidian:\/\/arch-recreations\?play=([^)\s]+)/))) return decodeURIComponent(m[1]);
  if ((m = s.match(/file:\/\/([^)\s]+)/))) return decodeURIComponent(m[1]);
  if ((m = s.match(/^\[[^\]]*\]\(([^)]+)\)$/))) return m[1];
  return s;
}

/* ---------------- Radarr ---------------- */

// Radarr and Sonarr keep their API key in a config.xml. Where that is depends
// on the OS -- and, on this Mac, on the app: Radarr writes under Application
// Support, Sonarr under ~/.config. Both places are tried for both.
function arrConfigCandidates(app, platform, home, env = {}) {
  const c = [];
  if (platform === 'darwin') c.push(path.join(home, 'Library', 'Application Support', app, 'config.xml'));
  if (platform === 'win32' && env.ProgramData) c.push(path.join(env.ProgramData, app, 'config.xml'));
  c.push(path.join(home, '.config', app, 'config.xml'));
  return c;
}

function parseArrConfig(xml, defaultPort) {
  const pick = (tag) => {
    const m = String(xml || '').match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return m ? m[1].trim() : '';
  };
  const port = Number(pick('Port')) || defaultPort;
  const base = pick('UrlBase').replace(/^\/+|\/+$/g, '');
  return {
    apiKey: pick('ApiKey'),
    url: `http://localhost:${port}${base ? '/' + base : ''}`,
  };
}

function readArrConfig(app, defaultPort, platform, home, env) {
  for (const file of arrConfigCandidates(app, platform, home, env)) {
    try {
      const xml = fs.readFileSync(file, 'utf8');
      const parsed = parseArrConfig(xml, defaultPort);
      if (parsed.apiKey) return { ...parsed, file };
    } catch (_) {
      /* not there */
    }
  }
  return null;
}

const radarrConfigCandidates = (platform, home, env) => arrConfigCandidates('Radarr', platform, home, env);
const parseRadarrConfig = (xml) => parseArrConfig(xml, 7878);
const readRadarrConfig = (platform, home, env) => readArrConfig('Radarr', 7878, platform, home, env);
const readSonarrConfig = (platform, home, env) => readArrConfig('Sonarr', 8989, platform, home, env);

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
  readSonarrConfig,
  readArrConfig,
  tmdbTvUrl,
  tmdbTvIdFromText,
  seriesFromTmdb,
  seasonFromTmdb,
  seriesNoteFields,
  seriesNoteBody,
  seasonNoteFields,
  seasonNoteBody,
  replaceEpisodeList,
  openSubtitlesHash,
  pickSubtitle,
  subtitlePath,
  splitAtVolume,
  locateFile,
  pathFromFileProperty,
  parseSeederTiers,
  pickRelease,
  encodeWebp,
};
