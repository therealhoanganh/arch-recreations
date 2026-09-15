# ARCH Recreations — working notes

An Obsidian plugin for a film and series library in the vault: look a title up
on TMDB, write the note in the user's shape with full-size poster, banner and
backdrops saved into the vault, hand the download to Radarr (films) or Sonarr
(series), and fetch the subtitles when the files land. Games, anime, manga and
music are intended later and none of that is designed yet.

Read `CHANGELOG.md` before changing behaviour. Read `../CLAUDE.md` for what is
shared by the whole ARCH family — folder-setting shape, minimal frontmatter,
hand-added properties never destroyed, logging always on, external tools
detected by the plugin.

## Why it exists

The user tried obsidian-media-db-plugin. Its data was fine; the fight was that
it writes *its* frontmatter and he wants *his*, so he bolted Templater on top
and hand-deleted the leftover block. And the poster it gave was OMDb's 380×562
thumbnail, not downloaded. What he actually wants is a library that pulls him
in: art worth looking at, and film notes as a museum of stills. Every design
decision below follows from that, so do not build the metadata note first and
the art second — the art is the point.

## How a film goes through

1. `AddMovieModal` searches TMDB (`/search/movie`) and shows title, year and a
   line of overview. Picking one calls `addMovie(tmdbId, quality, sendToRadarr)`.
2. One TMDB request answers everything:
   `/movie/<id>?append_to_response=images,credits&include_image_language=en,null`.
   `lib/recreations.js::movieFromTmdb` shapes it — see the traps below.
3. The poster and N backdrops are downloaded from
   `image.tmdb.org/t/p/original/<file_path>`, encoded to WebP in the renderer
   (`lib/image.js`, a copy of YT Playlists'), and saved into the art folder as
   `<title> (<year>).webp` and `<title> (<year>) Backdrop 01.webp` onward. The
   note links the poster as `[[file.webp|Poster]]` and the **first backdrop**
   as `[[… Backdrop 01.webp|Banner]]` — one file, two roles; there is no
   separate banner download. Every image is `.webp`, even when the WebP is a
   few KB larger than the JPEG — the user asked for one extension over the
   bytes (`encodeWebp(…, { always: true })`).
4. The note is written: defaults (`watched`, `rank: 0` — the family's "never judged" — `banner-p`), the plugin's
   fields, then the body: the poster embedded first, then every backdrop. An existing note at that path has
   its properties refreshed and its body left alone.
5. Radarr is always *asked* whether it already has the film — a read-only
   lookup by TMDB id — so a film it downloaded earlier gets its file link
   whatever the modal's box says; the box only decides whether a download is
   *started*. A film Radarr already holds is never added again. The note gets
   `quality` (the profile's name, from Radarr if it already had the film) and
   `dl-ed: false` until the file is there. This came from a real slip: a note
   deleted and re-added with the box unticked came back without its file.
6. The command **Check Radarr for finished downloads** is the only way a note
   learns its file has landed. Every film note (a TMDB URL) without a `file`
   link is looked up in Radarr's movie list, fetched once per run; one with a
   file gets `dl-ed: true` and a `file` link, then subtitles. **It is a
   command and nothing else — no timer, no run at startup.** It also covers a
   file downloaded **by hand**: a film Radarr lacks is registered there
   *unmonitored* (no search, no download) so its folder is watched, every film
   without a file gets a `RescanMovie`, and the list is read again — so a 4K
   dropped into `4T-HDD/Movies/<Title (Year)>/` gets its link like any
   other. The folder name is Radarr's `{Movie Title} ({Release Year})`, the
   same as the note name. A version that
   checked every ten minutes and at vault open was built and rejected as
   "really passive and hard to test, an unnecessary background task". Do not
   bring it back. The link
   is `[Open](obsidian://arch-recreations?play=<path>)`, which the plugin's
   protocol handler answers with `open -a <player> <path>` — so the click goes
   to VLC (the `player` setting) while every other `.mp4` on the machine keeps
   its system default. VLC registers no `vlc://` scheme on macOS, which is why
   a plain link could not do this. With `player` empty it is a `file://` link.
   The link and the **Open this film** command run the same `playFile`, which
   is machine-independent: `lib::locateFile` tries the stored path, then the
   part after the drive's name (`Movies/<Title (Year)>/<file>`) under every
   mounted volume for the platform (`/Volumes/*`, drive letters, `/media`,
   `/run/media`, `/mnt`), and the player is asked for the platform's way —
   `open -a`, `start`, the bare command — falling back to the system default.
   Parentheses in the link are encoded by hand: `encodeURIComponent` leaves
   them alone and a `)` inside a markdown link address ends the link.
   The command **Download this film with Radarr** is the other half: a note
   made without Radarr can be sent later, with the note's own `quality` (the
   default when it has none). It exists because a note added with the box
   unticked was expected to get a file link from the check command — but
   nothing had ever been asked to download it.
7. Subtitles are three OpenSubtitles requests: search by IMDb id and file
   hash, `POST /download` for a link, save as `<film>.<lang>.srt` beside the
   film. Skipped if the `.srt` exists; put off if the film's path is not
   reachable, which is what an unplugged drive looks like.

## Things learned building it

**The poster is TMDB's primary, not the top-voted.** TMDB's film page shows
an editorially chosen primary poster (`poster_path`) and backdrop
(`backdrop_path`); its images list, sorted by vote average, ranks differently
— for *Blade Runner 2049* the primary is rated 3.1 with 104 votes, and
vote-sorting picked a 7.5-with-8-votes poster the user called ugly. "The first
one on TMDB" means the primary, so it comes first; the remaining backdrops
are the textless ones by votes.

**TMDB "backdrops" mix key art and real frames, with no flag.** The primary
one is usually key art — for *Alien* it is a painting of Ripley in a helmet —
which is why the first backdrop doubles as the banner. Some hand curation is
expected; the user chose 5 per film and the word "Backdrop" for the files,
matching TMDB's own page. Textless backdrops (`iso_639_1 == null`) are
preferred for everything.

**The property order the user asked for** puts `dl-ed` first, then the
hand-edited ones, then `quality` and `file` before `URL`. It is the default in
`DEFAULT_SETTINGS`; a vault with a saved `data.json` keeps whatever order it
saved.

**TMDB credits duplicate writers**: one entry per writing credit, so Dan
O'Bannon appears for story and for screenplay. `movieFromTmdb` dedupes by name.

**TMDB says "Science Fiction"; the notes say `[[Sci-Fi]]`.** The `genreMap`
setting ("TMDB name = your name") is where that lives. Default has that one
pair.

**`URL` is uppercase** because the user's own template writes it that way.
After Clipping scans every property for a URL, so a film note does reach it —
but themoviedb.org is not a media host, so it neither renames nor probes, and
the note's images are already local links, so nothing to swap. Verified by
reading its pipeline, not by running it; if After Clipping's log gets noisy
about film notes, the fix is adding the `movie` tag to its `otherArchTags`.

**The property order setting decides what is written.** `applyOrder(fm,
order, OWN_KEYS)` drops one of the plugin's own keys that is not listed, and
keeps any key it did not produce. So `quality`, `dl-ed`, `file` can be removed
from every future note by editing the setting, and a hand-added `rank` is safe
whatever the setting says.

**Radarr judges a release by its name.** It cannot tell a real UHD from an
upscale labelled 2160p, which is why the user's Radarr has exactly two
profiles, `1080p` (default) and `4K` (per film, chosen in the modal), and why
`quality` is a per-note property. Profile names are matched case-insensitively
against Radarr's list at add time; the id is never stored.

**Radarr's config lives under `~/Library/Application Support/Radarr/config.xml`
on macOS**, not `~/.config`. `readRadarrConfig` checks the platform's places
in order. It gives the API key and port; the library folder comes from
`GET /rootfolder`. Detection runs once on first load and on the settings
button, and fills settings — nothing to type.

**The OpenSubtitles hash** is file size plus every 8-byte word of the first and
last 64 KB, little-endian, summed mod 2^64. The user's consumer has *Under
dev* ticked, which allows 100 downloads a day on the key alone with no login.
`User-Agent` is sent naming the plugin; if OpenSubtitles ever refuses
`requestUrl`'s headers, the fallback is Node `https` in main.js.

**Subtitle pick rule**: hash match → not hearing-impaired → most downloads.
Proven on *Alien*: the hash-matched, non-HI one was the right file.

**`purgeModuleCache` has to compare against the resolved real path, not the
symlinked one.** Node caches a required module under its real path
(`fs.realpathSync`), and TESTFIELD's plugin folder is a symlink into this repo
in Documents -- so a module required as `.../TESTFIELD/.../lib/recreations.js`
is cached as `.../Documents/arch-recreations/lib/recreations.js`. Comparing the
cache keys against the symlinked path (what `pluginDir()` returns) never
matched, so a reload silently kept running the lib/ from *before* the edit --
caught when a newly added function showed up missing after a `plugin:reload`
right after editing it. The fix is `fs.realpathSync` on the compared directory.
**And the `require` handed to a plugin is Obsidian's wrapper, whose `.cache`
is not Node's** -- iterating it purges nothing. Node's own is `window.require`
(Electron), and that is the cache the purge has to walk. Both halves were
needed; with only the first, the purge still did nothing.
**ARCH YT Playlists has the identical `purgeModuleCache`, likely with the same
bug** -- not fixed here since it is a different repo, but worth checking.

**The plugin starts Radarr and the download client itself.** Before anything
that needs them — a lookup, a hand-off, the check — `ensureRadarr` and
`ensureDownloadClient` probe the port and, if it is closed, launch the app
(`open -g -a <name>` on macOS, so it stays behind Obsidian) and wait up to 30 s
for the port. The client's name and port come from Radarr's own
`/downloadclient` list, so there is nothing to configure; only apps on
`localhost` are started. The user asked for this so a download sent while
Transmission was quit does not silently sit in Radarr as "wanted".

**Seeding is off (ratio 0) on purpose.** A finished torrent's copy stays in
`~/Movies/Torrents/radarr` until Transmission has uploaded the set ratio, and
Radarr deletes it only then. The user's connection uploads nothing — ratio
0.00 after hours — so with the usual 1.0 the copies would have stayed on the
Mac forever, which defeats the external drive. Transmission's default ratio
limit is now 0 with the limit switched on, and Prowlarr's per-indexer seed
ratio is left *empty* (it refuses a literal 0) so the client's default
applies. The Mac holds a film only while it downloads.

**Minimum seeders is 10, and The Pirate Bay's "Top 100" is set to
Movies/TV.** Both in Prowlarr (the sync profile and the indexer), pushed into
Radarr by sync. The first came from Radarr grabbing a zero-seeder release at
the default of 1 — the site's count is stale — which sat at 0.0 GB forever. The
second is a trap the indexer form warns about: Radarr tests an indexer with an
empty query, TPB answers it from its recent top-100, and when that list has no
films the test fails, Prowlarr's push is refused, and Radarr sidelines the
indexer ("0 active indexers" in its log, a five-minute timeout that escalates).
Any change that makes Prowlarr re-push the indexer can trip it. The stuck
release was removed from the queue with `blocklist=true`, then
`MoviesSearch` re-run. Radarr's health endpoint (`/api/v3/health`) is where
"all indexers unavailable" shows; `/indexerstatus` is not a Radarr route.

## Series, and what Sonarr taught

Sonarr 4.0.19 at `localhost:8989`, Intel build installed by hand (the Homebrew
cask is disabled for the same Gatekeeper failure as Radarr's). Library
`/Volumes/4T-HDD/Series`, Transmission with category `sonarr`, the same `1080p`
and `4K` profiles and MB-per-minute size floors as Radarr, The Pirate Bay
pushed in by Prowlarr, a login item like the others.

**Sonarr's config is `~/.config/Sonarr/config.xml`, Radarr's is
`~/Library/Application Support/Radarr/config.xml`.** Same family, different
place, on the same machine. Detection has to look in both.

**`addOptions.monitor` overrides the per-season `monitored` flags in the same
POST.** Adding with `monitor: 'none'` and `seasons[1].monitored = true` in one
call comes back with season 1 *unmonitored*. Monitoring chosen seasons is two
calls: add with `monitor: 'none'`, then `PUT /series/<id>` with the seasons
set. Episodes follow the season automatically -- all 12 flipped to monitored
with no episode call.

**A season search is `GET /release?seriesId=<id>&seasonNumber=<n>`**, and it
returns season packs and single episodes together, each carrying `fullSeason`
and `episodeNumbers`. `lib::pickRelease` works on it unchanged -- the payload
has the same `seeders`/`rejected` shape as Radarr's. **Within a tier a season
search should prefer `fullSeason`**, so a season arrives as one torrent rather
than twelve.

**One grabbed season pack appears in the queue once per episode it satisfies.**
*Scavengers Reign* S01 showed 12 queue records, all with the same `downloadId`,
one torrent in Transmission. Dedupe by `downloadId` before reporting progress.

Proven by hand on *Scavengers Reign* (2023), tvdb 421287: added, season 1
monitored, season search, cascade picked the 497-seeder full-season pack at the
200+ floor, grabbed by `POST /release {guid, indexerId}`.

### How a series goes through

The user's shape: a **series note** `Title (Year)` like a film note (`creator`
where a film has `director`, `seasons` where it has `duration`, tag `series`),
its body the art and then a wikilink per season; a **season note** `Title –
Season N (Year)` (en dash, the season's first-aired year) with `season`,
`episodes`, `series: [[Title (Year)]]`, its own TMDB season poster, tag
`series/season` -- nested so a search for `series` finds both -- and an
episode list in the body. Each episode is a line `- S1E1 – Name` until its
file exists, then `- [S1E1 – Name](obsidian://arch-recreations?play=…)`, the
same Open link a film has, one per episode. The list sits between
`%% episodes %%` / `%% /episodes %%` comment markers, invisible in reading
view, so a check replaces just the list and leaves anything written around it.

`addSeries(tmdbId, quality, seasonNumbers)`: `seriesDetails` (one TMDB call
with `images,aggregate_credits,external_ids` -- TVDB id comes from
`external_ids`, Sonarr needs it), art via the shared `fetchArt`, then one
`seasonDetails` per season for its poster and episodes, season notes written
first so the series note can link them. Sonarr is asked what it has before
writing, as with Radarr. `seasonNumbers` is `null` for notes only, otherwise
the seasons to download; the modal offers *All seasons* and a box per season.

Commands: **Add a series**, **Download all seasons with Sonarr** (series
note), **Download this season with Sonarr** (season note -- `seasonOf` reads
`season` and follows the `series` wikilink to the series note's TMDB id),
**Check Sonarr for finished downloads**, **Detect Sonarr**. The check walks
every season note not yet `dl-ed: true`, asks Sonarr for the season's episodes
`includeEpisodeFile=true`, rewrites the episode block, fetches a subtitle per
new file (`parent_imdb_id` + `season_number` + `episode_number` + hash), marks
the season done when every *aired* episode has a file, and marks the series
done when all its season notes are. Completions are remembered in the run
rather than read back: the metadata cache lags a write by a moment, and the
series check runs in the same breath -- the first run left the series note at
`dl-ed: false` for exactly that reason.

Subtitles for twelve episodes cost twelve of the day's hundred OpenSubtitles
downloads; a long series will run out and pick up the next day, which is what
"put off" in the log means.

## Environment it was built against

macOS Intel, Obsidian 1.13. Radarr 6.3 at `localhost:7878`, Prowlarr 2.5 at
`:9696`, Transmission 4.1 as the client (remote access on `9091`, restricted to
`127.0.0.1`), downloads to `~/Movies/Torrents` on the internal disk on
purpose — the 4 TB library drive (`/Volumes/4T-HDD/Movies`, exFAT) is not
always plugged in, and a download folder on an absent drive would create a
stale `/Volumes/4T-HDD` that makes the real drive mount as `4T-HDD 1`. Radarr
moves finished files over whenever the drive is present. All three apps are
login items. Series will need Sonarr; `/Volumes/4T-HDD/Series` already exists.

## Development

`TESTFIELD` has this repo symlinked into `.obsidian/plugins/arch-recreations`.
`data.json` is gitignored and holds the test vault's keys. The repo runs
unbuilt — `main.js` loads `lib/` from disk when `ARCH_LIB` is undefined — and
`npm run build` produces `dist/main.js` for a release, with `lib/` inlined.
Never ship the repo's own `main.js`.

Pure logic lives in `lib/recreations.js` and can be exercised under plain Node:

```
node -e "const L=require('./lib/recreations.js'); console.log(L.movieFromTmdb(require('./sample.json')))"
```

A clean Node run is not evidence that the plugin works in Obsidian — every
Obsidian API call is in `main.js` and only a reload in TESTFIELD tests those.

Release: bump `manifest.json`, add a `CHANGELOG.md` entry, then

```
npm run build
git tag <version> && git push origin <version>
gh release create <version> dist/main.js dist/manifest.json --title <version> --notes "..."
```
