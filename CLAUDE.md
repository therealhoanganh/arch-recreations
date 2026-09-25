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
4. The note is written: `plot` (TMDB's overview) at the very top, because the
   user asked for it there when he found Recreations lacked it (0.3.0), then
   defaults (`watched`, `rank: 0` — the family's "never judged" — `banner-p`), the plugin's
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
Confirmed by reading its code on 2026-09-23: it has both faults. It is open work
in `../CLAUDE.md`.

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
its `seasons` property the season notes as wikilinks (the user asked for the
property, not a list in the body), its body the art like a film's; a **season
note** `Title – Season N (Year)` (en dash, the season's first-aired year) with
`season`, `episodes`, `series: [[Title (Year)]]`, its own TMDB season poster,
tag `series/season` -- nested so a search for `series` finds both -- and the
episode list **first** in the body, the poster under it after three blank lines,
so the note opens on the list rather than on a tall image. Each episode is a
line `- S1E1 – Name` until its file exists, then
`- [S1E1 – Name](obsidian://arch-recreations?play=…)`, the same Open link a
film has, one per episode. A check finds the block by that line shape
(`lib::EPISODE_LINE`) and replaces the first run of such lines, leaving
anything else in the body alone. An earlier version wrapped the list in
`%% episodes %%` comment markers; the user asked what they were and they went
-- `replaceEpisodeList` still strips them from a note that has them.

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

## Bringing an existing library in

Three commands write notes for what's already there rather than for
something new: **Import existing films from Radarr** and **Import existing
series from Sonarr** walk what those apps already track and write a note
(with its Open link, if a file is there) for anything missing one --
`addMovie`/`addSeries` called with `sendToRadarr`/`seasonNumbers` false/null,
`{ open: false }` so a bulk run doesn't flip through a tab per item. **Import
films from the library folder** goes one step further: it reads every root
folder Radarr knows about (not just the one in settings) and, for a
subfolder shaped `Title (Year)` that Radarr has never seen, looks the title
up on TMDB and writes its note too.

That command is also why `registerInRadarr(tmdbId, knownPath, qualityName)`
takes a real folder path now. Radarr's own naming format sanitises a title
differently than however a folder already got named by hand -- a colon
becomes " -", so `Star Wars: Episode I - The Phantom Menace` (Radarr's own
choice) didn't match `Star Wars Episode I The Phantom Menace (1999)` (the
folder actually on disk). Registering with the generated name meant the
rescan afterward looked in a folder that didn't exist and never found the
file -- three Star Wars notes sat with no Open link until this was caught
and the existing Radarr entries were repointed by hand. `knownPath` is set
whenever the folder is already known (never left for Radarr to guess), and
`qualityName` is passed explicitly too, for the same reason: leaving it out
silently registers everything under the global default quality regardless
of which root folder -- and so which real quality -- it came from.

A folder Radarr already tracks under a *different* copy (a 4K rip of a film
already held at 1080p, found while scanning a second root) is skipped with a
log line rather than registered -- Radarr holds one entry per film, so
registering again would silently take over the existing entry's file and
quality. That note gets written by hand instead: `movieDetails`, `fetchArt`,
`movieNoteFields`/`movieNoteBody`, `writeMovieNote`, then `markDownloaded`
with the real file path -- the same pieces `addMovie` uses, run directly, with
the existing Radarr entry (same TMDB id, so the same IMDb id) good enough for
the subtitle lookup. Dunkirk's 4K copy went in this way.

## 4K: a second root folder, not a name in the note

The user tried a "4K" prefix on the note's name first and changed his mind --
a subfolder instead, the note's own name untouched. `resolveMovieFolder` and
`resolveSeriesFolder` both take the quality name now and append a `4K`
subfolder when it's exactly that string (case-insensitively): `Movies/4K`,
`Series/4K` by default. Wherever a quality name is already known when the
note is written -- the *Add a film*/*Add a series* dropdowns, both `import
existing …` commands (they read the real profile per item off Radarr/Sonarr)
-- a 4K item lands there on its own.

On disk, this is `/Volumes/4T-HDD/4K`, registered as an *additional* root
folder in both Radarr and Sonarr (not a replacement for `Movies`/`Series`) --
the user keeps 4K rips there regardless of whether they turn out to be a
film or a series. `importFilmsFromDisk` scans every root Radarr has, and a
root folder whose name is exactly `4K` gets its films the `4K` quality
instead of the settings default, so a plain `Title (Year)` folder dropped
there is picked up and correctly labelled with no further steps. There is no
equivalent for series yet -- nothing has needed it -- but the same idea
(`resolveSeriesFolder` already takes the quality) is what it would extend.

Adding a 4K title also *downloads* it there: `rootFor(app, qualityName)`
returns the root folder named `4K` when the quality is 4K and the app has
one, and the settings library folder otherwise. Both `addToRadarr` and
`addToSonarr` go through it. Without a `4K` root it falls back to the main
library and says so in the log rather than failing.

## What "4K" grabs, and why the rule is a rule

The seeder cascade suits 1080p, where sizes are close enough that most-seeded
is simply best. At 2160p the same release exists at 5 GB and at 58 GB, so the
user asked for the smallest -- but only among releases seeded well enough to
actually finish. `pick4KRelease` is that: releases with at least
`fourKEnoughSeeders` (50) behind them, smallest first, an HDR one before one
without; and if nothing is that well seeded, the ordinary cascade over what
is left. He chose 50 from watching his own downloads.

`unfit4K` is the filter, and every rule in it has a reason on this machine:

- **not 2160p** -- the 4K profiles in both apps allow 1080p as a fallback,
  which is right for the profile but wrong for a note filed under `4K`.
- **AV1** -- the MacBookPro16,2 (10th-gen Intel, Iris Plus) decodes HEVC in
  hardware and AV1 not at all; 4K AV1 stutters in VLC.
- **remux** -- tens of gigabytes for a picture usually watched on a 13"
  non-HDR screen. (The HDR monitor and the TV come second and third.)
- **Dolby Vision with no HDR in the name** -- profile 5, which VLC renders
  purple and green. `DV HDR` carries an HDR10 fallback and is fine, so the
  test is "DV present *and* HDR absent", not "DV present".

The names are matched on the release *title*, and The Pirate Bay truncates
them mid-word (`… DDP5 1 DV HDR H 2`), so the codec can never be *required*
by name -- only ruled out when it is stated. Resolution comes from Radarr and
Sonarr's own parse instead, which is reliable.

A season takes **packs only** when any fit pack exists. Two reasons: the user
wants one release group across the season, and `searchAndGrabSeason` grabs a
single release -- so a single-episode release winning the pick would have
quietly fetched one episode and called the season done. That gap had never
shown because every season tried before had a pack at a high floor.

Minimum size is deliberately *not* in the plugin. Radarr and Sonarr already
reject a too-small release through their quality definitions' minimum MB per
minute (30 for WEBDL-2160p here), which scales to runtime on its own.

**Sonarr answers a release search for a brand-new series with an empty list.**
It fetches the episode list in the background after `POST /series`, and until
that lands, `/release?seriesId&seasonNumber` returns `[]` immediately -- not
an error, so it looks exactly like "nothing was found". *Alien: Earth* was
added and grabbed nothing for this reason; `waitForSeason` now polls
`/episode` for up to a minute before searching.

## Reading a 4K release by its name, and checking a file afterwards

What a good 2160p release name looks like for this setup, in the order the
words matter:

- `2160p` **and** `WEB-DL` or `BluRay`, with `x265`/`H.265`/`HEVC` — the
  normal case. 10–20 GB for a film, 4–8 GB for an hour-long episode.
- `HDR`, `HDR10`, `HDR10+` — wanted. `DV HDR` is wanted too: Dolby Vision
  layered on an HDR10 base, which VLC falls back to.
- `DV` with no `HDR` beside it, or `DV.P5` — **avoid**, purple and green in
  VLC.
- `AV1` — **avoid**, no hardware decoding on this Mac.
- `REMUX`, or a BluRay release around 50–80 GB (untouched disc, whether or
  not it says remux) — avoid unless nothing else exists.
- `WEBRip`, `HDTV`, `BDRip` at 2160p — usually a re-encode of a re-encode.
  Sonarr's quality definitions already reject the small ones.
- A release under about 8 GB for a 2-hour 4K film is over-compressed.

A name can lie, and a 4K file is not necessarily HDR. `ffprobe` settles it,
and is already installed:

```
ffprobe -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,color_transfer,color_primaries \
  -show_entries stream_side_data=dv_profile -show_entries format=bit_rate \
  -of default=nw=1 "<file>"
```

`color_transfer=smpte2084` with `color_primaries=bt2020` is real HDR10;
`bt709` is ordinary colour however large the file. A `dv_profile` of 5 is the
Dolby Vision that breaks in VLC, 7 or 8 is fine.

### The 4K films on the drive, checked this way

Checked 2026-09-25, after the films from his PC arrived. The folders were
renamed to `Title (Year)` then:

- **HDR10, good**: Interstellar (x265, 28 Mbit/s), Oppenheimer (HDR with DV
  profile 8, fine in VLC, 17 Mbit/s), Ghost in the Shell 1995 (19 Mbit/s),
  Pacific Rim (36 Mbit/s), Ready Player One (20 Mbit/s).
- **HDR10 remuxes**: Blade Runner 2049 (78 GB, 68 Mbit/s) and Ghost in the
  Shell 2017 (56 GB, 75 Mbit/s). Kept as they are; he brought them.
- **SDR, about 7 Mbit/s, YTS**: The Batman (its only copy, so it has a
  note), Blade Runner 1982 and The Dark Knight. For those two he chose to keep
  the 1080p copy, so their 4K folders (`Blade Runner 4K (1982)`, `The Dark
  Knight (2008) [2160p] …`) have no note and are not in Radarr. An import from
  the library folder skips them, because Radarr already holds both films.

Earlier, the two that came first:

- **Dunkirk** (`…iMAX.MULTi.UHD.Blu-ray.2160p.HDR…HEVC-DDR`, 18 GB) — HEVC,
  3840×2160, genuine HDR10, ~25 Mbit/s. A good copy; leave it alone.
- **Solo: A Star Wars Story** (`…2160p.MA.WEB-DL…H.265-PandaQT`, 24 GB) —
  HEVC 2160p at ~25 Mbit/s but **BT.709, not HDR** (checked at frame level
  too). Sharp, but 24 GB for no HDR.

A replacement for Solo was searched for in September 2026 and there was
nothing worth taking: the only sensibly sized HDR encode (17.1 GB) had 4
seeders — under the indexer's 10-seeder minimum, so the plugin will not even
see it — the AV1 copy (19.5 GB) and the remux (57.9 GB) are both ruled out,
and the one HDR release that was seeded (16) is 58.8 GB, effectively the
whole disc. The user chose to keep the SDR copy and look again later. **If a
well-seeded HDR encode of Solo around 12–20 GB ever appears, that is the
upgrade to take**; Radarr already holds Solo at the 4K profile with its path
pinned to `/Volumes/4T-HDD/4K/Solo A Star Wars Story (2018)`.

## Environment it was built against

macOS Intel, Obsidian 1.13. Radarr 6.3 at `localhost:7878`, Prowlarr 2.5 at
`:9696`, Transmission 4.1 as the client (remote access on `9091`, restricted to
`127.0.0.1`), downloads to `~/Movies/Torrents` on the internal disk on
purpose — the 4 TB library drive (`/Volumes/4T-HDD/Movies`, exFAT) is not
always plugged in, and a download folder on an absent drive would create a
stale `/Volumes/4T-HDD` that makes the real drive mount as `4T-HDD 1`. Radarr
moves finished files over whenever the drive is present. All three apps are
login items. Sonarr came later and is set up the same way; see *Series, and what
Sonarr taught*.

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

## Where things stand (checked 2026-09-25)

Edit this section in place; what changed and why goes in `CHANGELOG.md`.

**Release 0.3.0 is current** (adds `plot`). The plugin is installed in `᭄᭡ CHAOS`
through BRAT, with TESTFIELD's settings, and runs in `TESTFIELD` through the
symlink.

The download stack: Radarr `:7878`, Sonarr `:8989`, Prowlarr `:9696`,
Transmission `:9091`, all login items, seeding off. Libraries on `4T-HDD`:
`Movies`, `Series`, and `4K`, a root folder in both Radarr and Sonarr.

**The library lives in `᭄᭡ CHAOS` now** (`Movies`, `Movies/4K`, `Series`, their
`Images`). On 2026-09-25 TESTFIELD's notes and art were copied there; **the
TESTFIELD copies were left in place for him to compare and delete**, per his rule
for moved notes. CHAOS's own older Media DB notes were rebuilt by the plugin and
the originals kept in `᭄᭡ CHAOS/_/Old Film Notes/` for the same reason. What
CHAOS holds and what was done is in that vault's `CLAUDE.md` and `CHANGELOG.md`.

**4K replaced 1080p** for Blade Runner 2049, Interstellar, Oppenheimer and
Dunkirk: Radarr points at the `4K` folder with the 4K profile, unmonitored (as
Solo already was, so no "upgrade" is ever searched), the notes are in
`Movies/4K`, and the 1080p folders are in 4T-HDD's Trash until he empties it.

Still loose:

- **Nothing seeded well enough** (10+) for *The Divine Fury*, *Underworld: Rise
  of the Lycans* and *Kingdom* (2012 anime) season 1. All stay wanted; Radarr
  and Sonarr grab them from RSS if a seeded release appears.
- The other downloads sent on 2026-09-25 (Alien: Covenant, Barbie, Kingdom 2019,
  both Mortal Kombats, Alice in Borderland S1, Vox Machina S1) all landed and are
  linked; the checks were run at 15:20.
- Several 4K subtitles are not hash matches (the log says so per film); if one is
  off, *Fetch subtitles for this film* after deleting the `.srt` tries again.
- Series from his PC were registered in Sonarr unmonitored. Avatar's and Over the
  Garden Wall's episode files were renamed with an `S01E01` prefix first, because
  Sonarr filed `Book 3; Fire/314 - …` under season 1. Their `.srt` files kept their
  own names, so VLC does not pick them up by name.
- The imported series' complete seasons were marked `dl-ed: true` by hand, so
  *Check Sonarr for finished downloads* skips them and fetches no subtitles for
  them; only incomplete seasons (Love, Death & Robots S01) are checked.
- *Love, Death & Robots* S01 lacks episodes 13, 14, 17; *King of the Hill* has
  seasons 1–13, not the 2025 revival.
- Two loose `President.Curtis.S01E05/06` files sit in the `Series` root, untouched.
  *One Piece (Pace)*, a fan recut, was left alone by choice.
- The *Add a series* dialog and the two per-note download commands have not been
  clicked by a human; the code beneath them ran through the CLI.
- Solo's 4K upgrade, if one appears: *The 4K films on the drive*, above.
- Games, anime, manga and music are not designed.
