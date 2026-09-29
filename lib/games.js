'use strict';

// Games (0.4.0). RAWG answers for the facts, because Steam's store is blocked on
// his network (store.steampowered.com resolves to 127.0.0.1) while Steam's image
// server is not: a game RAWG knows a Steam page for gets its cover and banner
// from there, the same art Steam's own library shows.

const RAWG = 'https://api.rawg.io/api';
const RAWG_SITE = 'https://rawg.io/games/';
const STEAM_ART = 'https://cdn.akamai.steamstatic.com/steam/apps';

const GAME_OWN_KEYS = new Set([
  'description', 'release-date', 'weighted-rating', 'rating', 'ratings-count', 'metacritic',
  'play-on', 'genres', 'developers', 'publishers', 'platforms', 'banner', 'cover', 'URL', 'tags',
]);

// His Notion categories, "desirable place to play", as the notes write them.
// Window and Steam Deck became Linux on 2026-09-29, his word: no Steam Deck,
// because of his note I Will Never Finish a Game.
const PLAY_ON = {
  window: 'Linux',
  windows: 'Linux',
  'steam deck': 'Linux',
  linux: 'Linux',
  pc: 'Linux',
  nintendo: 'Nintendo',
  switch: 'Nintendo',
  retroarch: 'RetroArch',
  playstation: 'PlayStation',
  virtual: 'Virtual',
  vr: 'Virtual',
};

function playOnOf(raw) {
  const k = String(raw || '').trim().toLowerCase();
  if (!k) return '';
  return PLAY_ON[k] || String(raw).trim();
}

// One game per line: "Title<TAB>Place", "Title | Place", or a bare title. A
// trailing "(BG3)" is his shorthand, not part of the name, so it is left out of
// the search but kept in the report.
function parseGameList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^#/.test(line)) continue;
    let parts = line.split(/\t+|\s+\|\s+|\s{2,}/).map((s) => s.trim()).filter(Boolean);
    // A RAWG address on the line pins the game, for when the search picks wrong.
    const pinned = parts.map(rawgSlugFromText).find(Boolean) || null;
    parts = parts.filter((x) => !rawgSlugFromText(x));
    if (!parts.length) continue;
    const title = parts[0];
    const place = parts.length > 1 ? parts[parts.length - 1] : '';
    const search = title.replace(/\s*\([A-Z0-9]{2,6}\)\s*$/, '').trim();
    out.push({ title, search, playOn: playOnOf(place), slug: pinned });
  }
  return out;
}

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15, xvi: 16 };

// For comparing his wording with RAWG's: case, accents, punctuation, "&",
// apostrophes and roman numerals do not make two titles different.
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .map((w) => (ROMAN[w] && w !== 'i' ? String(ROMAN[w]) : w))
    .join(' ');
}

// RAWG's own disambiguation, "(2018)" or "(itch)", is not part of the title.
function bareTitle(s) {
  return String(s || '').replace(/\s*\((?:\d{4}|itch|[^)]*\bversion\b[^)]*)\)\s*$/i, '').trim();
}

// Looser still: "No Man Sky" is No Man's Sky, "Rim World" is RimWorld,
// "Monster Hunter Wild" is Monster Hunter Wilds.
function looseTitle(s) {
  return normTitle(s).split(' ').map((w) => w.replace(/s$/, '')).join('');
}

// Add-ons, demos and fan remakes share a game's name; never the game he means
// unless his own title says so.
const NOT_THE_GAME = /\b(demo|dlc|season pass|expansion pass|booster|soundtrack|ost|bundle|goodie|upgrade|demake|randomizer|toolkit|starter pack|prologue|dedicated server|redkit)\b|\.exe\b/i;

// Picks RAWG's game for one of his titles. Exact after normTitle beats a title
// that starts with his (The Witcher 3 -> The Witcher 3: Wild Hunt), which beats
// one holding every word of his; within a tier, the one most people have added
// wins. `sure` is false whenever a person should look: not exact, or a second
// exact match with a real following (Resident Evil 4 is two games, 2005 and 2023).
function pickGame(query, results) {
  const q = normTitle(bareTitle(query));
  const ql = looseTitle(bareTitle(query));
  const qWords = q.split(' ').filter(Boolean);
  const scored = [];
  for (const r of results || []) {
    if (NOT_THE_GAME.test(r.name) && !NOT_THE_GAME.test(query)) continue;
    const n = normTitle(bareTitle(r.name));
    let score = 0;
    // Exact beats loose: "Charming Hearts" is not CHARMING HEART.
    if (n === q) score = 3;
    else if (looseTitle(bareTitle(r.name)) === ql) score = 2.5;
    else if (n.startsWith(q + ' ')) score = 2;
    else if (qWords.length && qWords.every((w) => (' ' + n + ' ').includes(' ' + w + ' '))) score = 1;
    if (score) scored.push({ r, score });
  }
  if (!scored.length) return { pick: null, sure: false, others: [] };
  const itch = (r) => (/\(itch\)\s*$/i.test(r.name) ? 1 : 0);
  scored.sort((a, b) => b.score - a.score || itch(a.r) - itch(b.r) || (b.r.added || 0) - (a.r.added || 0));
  const top = scored[0];
  const rival = scored.find((x, i) => i > 0 && x.score >= 2.5);
  // Fewer than 10 people added it: often a jam game sharing the name (his
  // "Fall Out" found one with none), so a person looks.
  const sure = top.score >= 2.5 && (top.r.added || 0) >= 10 && !itch(top.r) &&
    !(rival && (rival.r.added || 0) >= 0.25 * (top.r.added || 0) && (rival.r.added || 0) >= 20);
  return { pick: top.r, sure, score: top.score, others: scored.slice(1, 4).map((x) => x.r) };
}

// RAWG addresses to try beside the search, which misses some famous games
// (The Last Guardian, Bloodborne, Persona 5 Royal) that the address finds.
function slugGuesses(title) {
  const base = bareTitle(title)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' ')
    .replace(/['\u2019`.]/g, '');
  const words = base.replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const out = [words.join('-')];
  if (words.length === 2) out.push(words.join(''));
  return [...new Set(out.filter(Boolean))];
}

// RAWG serves any image resized; 1920 wide is a seventh of the original's bytes.
function rawgResized(url, width = 1920) {
  return String(url || '').replace('://media.rawg.io/media/', `://media.rawg.io/media/resize/${width}/-/`);
}

function steamAppIdOf(storeUrls) {
  for (const u of storeUrls || []) {
    const m = String(u || '').match(/store\.steampowered\.com\/app\/(\d+)/);
    if (m) return m[1];
  }
  return null;
}

// RAWG's description, first paragraph or two: many carry a second language
// after the English, and the property is for reading at a glance.
function shortDescription(raw, max = 700) {
  const text = String(raw || '').replace(/\r/g, '');
  const cut = text.search(/\n\s*(Español|Espanol|Русский|Deutsch|Français|Português)\b/);
  const english = (cut > 0 ? text.slice(0, cut) : text).trim();
  const paras = english.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  let out = '';
  for (const p of paras) {
    if (!out) out = p;
    else if (out.length + p.length + 1 <= max) out += ' ' + p;
    else break;
  }
  if (out.length > max + 300) out = out.slice(0, max).replace(/\s+\S*$/, '') + '…';
  return out;
}

function gameFromRawg(detail, extra = {}) {
  const names = (xs, k = 'name') => (xs || []).map((x) => (x && x[k] ? x[k] : x && x.platform ? x.platform.name : '')).filter(Boolean);
  const steamAppId = steamAppIdOf(extra.storeUrls);
  const year = String(detail.released || '').slice(0, 4);
  return {
    id: detail.id,
    slug: detail.slug,
    name: detail.name,
    year,
    released: detail.released || '',
    url: RAWG_SITE + detail.slug,
    description: shortDescription(detail.description_raw),
    rating: detail.rating || 0,
    votes: detail.ratings_count || 0,
    added: detail.added || 0,
    metacritic: detail.metacritic || null,
    genres: names(detail.genres),
    developers: names(detail.developers),
    publishers: names(detail.publishers),
    platforms: (detail.platforms || []).map((p) => p.platform && p.platform.name).filter(Boolean),
    steamAppId,
    cover: steamAppId ? `${STEAM_ART}/${steamAppId}/library_600x900_2x.jpg` : null,
    steamBanner: steamAppId ? `${STEAM_ART}/${steamAppId}/library_hero.jpg` : null,
    rawgBanner: detail.background_image ? rawgResized(detail.background_image) : null,
    screenshots: (extra.screenshots || []).map((s) => s.image && rawgResized(s.image)).filter(Boolean),
  };
}

function rawgSlugFromText(text) {
  const m = String(text || '').match(/rawg\.io\/games\/([\w-]+)/);
  return m ? m[1] : null;
}

// The same shape as the h-games' weighted-rating (ARCH Adult Contents): a
// Bayesian average that pulls a rating with few votes towards the library's
// mean, plus a small lift for how many people added the game, kept small on
// purpose so a little-known good game can rise above a famous one.
function weightedRating(rating, votes, added, o = {}) {
  const R = Number(rating) || 0;
  const V = Number(votes) || 0;
  if (!R || !V) return null;
  const C = Number(o.average) || 3.9;
  const m = Number(o.prior) || 10;
  const w = o.popularityWeight === undefined ? 0.1 : Number(o.popularityWeight);
  const med = Number(o.popularityMedian) || 1000;
  const bayes = (V * R + m * C) / (V + m);
  const lift = w * Math.log10(Math.max(Number(added) || 1, 1) / med);
  return Math.round((bayes + lift) * 100) / 100;
}

function gameNoteFields(game, links, opts = {}) {
  const tags = (opts.tags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
  const wl = (n) => {
    const clean = String(n || '').replace(/[[\]|#^]/g, '').trim();
    return clean ? `[[${clean}]]` : '';
  };
  const map = opts.genreMap || {};
  return {
    description: game.description || undefined,
    'release-date': game.released || undefined,
    'weighted-rating': opts.weighted == null ? undefined : opts.weighted,
    // RAWG gives a rating of 0 for a game voted on but not scored; that is no rating.
    rating: game.votes && game.rating ? game.rating : undefined,
    'ratings-count': game.votes && game.rating ? game.votes : undefined,
    metacritic: game.metacritic || undefined,
    'play-on': opts.playOn || undefined,
    genres: game.genres.map((g) => wl(map[g] || g)).filter(Boolean),
    developers: game.developers.map(wl).filter(Boolean),
    publishers: game.publishers.map(wl).filter(Boolean),
    platforms: game.platforms.length ? game.platforms : undefined,
    banner: links.banner || undefined,
    cover: links.cover || undefined,
    URL: `[RAWG](${game.url})`,
    tags,
  };
}

// The cover, then one embed per screenshot: the same museum wall a film has.
function gameNoteBody(coverLink, screenshotLinks) {
  const all = [coverLink, ...(screenshotLinks || [])].filter(Boolean);
  if (!all.length) return '';
  return all.map((l) => `!${l}`).join('\n') + '\n';
}

module.exports = {
  RAWG,
  GAME_OWN_KEYS,
  playOnOf,
  parseGameList,
  normTitle,
  bareTitle,
  pickGame,
  slugGuesses,
  rawgResized,
  steamAppIdOf,
  shortDescription,
  gameFromRawg,
  rawgSlugFromText,
  weightedRating,
  gameNoteFields,
  gameNoteBody,
};
