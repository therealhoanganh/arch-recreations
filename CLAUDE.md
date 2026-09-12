# ARCH Recreations — working notes

An Obsidian plugin for a film library in the vault: look a title up on TMDB,
write the note in the user's shape with full-size poster, banner and stills
saved into the vault, hand the download to Radarr, and fetch the subtitles when
the file lands. Movies only so far; series (Sonarr), games, anime, manga and
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
3. Poster, banner and N stills are downloaded from
   `image.tmdb.org/t/p/original/<file_path>`, encoded to WebP in the renderer
   (`lib/image.js`, a copy of YT Playlists'), and saved into the art folder.
   The note links them as `[[file.webp|Poster]]`.
4. The note is written: defaults (`watched`, `rank`, `banner-p`), the plugin's
   fields, the stills as embeds in the body. An existing note at that path has
   its properties refreshed and its body left alone.
5. If Radarr is configured and the box was ticked, the film is added by TMDB
   id with the chosen quality profile and `searchForMovie: true`. The note gets
   `quality` and `dl-ed: false`.
6. `checkDownloads` runs at vault open and every `checkMinutes`: every note
   with `dl-ed: false` and a TMDB URL is looked up in Radarr's movie list; one
   with a file gets `dl-ed: true` and a `file` link (`[Open](file://…)`), then
   subtitles.
7. Subtitles are three OpenSubtitles requests: search by IMDb id and file
   hash, `POST /download` for a link, save as `<film>.<lang>.srt` beside the
   film. Skipped if the `.srt` exists; put off if the film's path is not
   reachable, which is what an unplugged drive looks like.

## Things learned building it

**TMDB "backdrops" mix key art and real frames, with no flag.** The most-voted
one is usually key art — for *Alien* it is a painting of Ripley in a helmet —
so it serves as the banner, and the stills are the ones after it. Some hand
curation of stills is expected; the user chose 5 per film. Textless backdrops
(`iso_639_1 == null`) are preferred for everything.

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
