# ARCH Recreations

## Rules

### What It Is

- An Obsidian plugin for a film, series and game library in the vault.
- It looks a title up on TMDB (games: RAWG), writes the note in his shape with full-size art, hands the download to Radarr or Sonarr, and fetches subtitles when the files land.
- Used in CHAOS only, so nothing needs to suit another vault. His answer, Sep 29.
- Anime, manga and music are meant for later. None is designed.
- Read `CHANGELOG.md` before changing behaviour. It records why each thing is the way it is.
- The old file word for word, with every walk-through and measurement: `Documents/_/AI/arch-recreations/Details.md`.
- CHAOS's `CLAUDE.md` has the vault side: folders, one copy per film, his properties.

### The Art Is the Point

- He left obsidian-media-db-plugin because it wrote its frontmatter, not his, and gave a 380×562 poster it never downloaded.
- He wants a library that pulls him in, and film notes as a museum of stills. Never build the metadata note first and the art second.
- The poster is TMDB's primary (`poster_path`), not the top-voted. Vote-sorting picked one he called ugly.
- The first backdrop is the primary too, usually key art, and it doubles as the banner: `[[… Backdrop 01.webp|Banner]]`. No separate banner file.
- Then textless backdrops (`iso_639_1 == null`) by votes, 5 per film, his choice. Files are named `Backdrop`, as on TMDB's page.
- Every image is `.webp`, even when larger than the JPEG, his wish (`encodeWebp(…, { always: true })`). `lib/image.js` is a copy of YT Playlists'.

### Film Notes

- One TMDB request answers everything: `/movie/<id>?append_to_response=images,credits&include_image_language=en,null`. `movieFromTmdb` shapes it.
- `plot` sits at the very top, his request. Then `watched`, `rank: 0`, `banner-p`, then the plugin's fields.
- The body is the poster, then every backdrop. An existing note gets fresh properties and keeps its body.
- The property order setting decides what is written (`applyOrder`). A key the plugin did not produce is always kept.
- `URL` is uppercase, from his template.
- TMDB credits list a writer once per credit. `movieFromTmdb` dedupes by name.
- `genreMap` turns TMDB's names into his, such as Science Fiction into `[[Sci-Fi]]`.
- After Clipping reads film notes but does nothing, since TMDB is not a media site. If its log gets noisy, add the `movie` tag to its `otherArchTags`.
- A title's colon becomes " - " in a note name. Older names are still found (0.4.4).

### Radarr and the Downloads

- Radarr is always asked, read-only, whether it has the film, so an earlier download gets its file link whatever the box says. The box only starts a download.
- A film Radarr holds is never added again.
- `quality` is per note. Radarr has two profiles, `1080p` (default) and `4K`, because it judges a release by its name. Profiles are matched by name, never by stored id.
- Check Radarr for Finished Downloads is the only way a note learns its file landed. A command, never a timer or a startup run: he rejected that as "really passive and hard to test, an unnecessary background task".
- That check registers a film Radarr lacks as unmonitored and rescans, so a file dropped in by hand gets its link too.
- `registerInRadarr` always gets the real folder path and the quality. Radarr names folders its own way, and three Star Wars notes sat with no link.
- A folder Radarr tracks under another copy is skipped with a log line, never registered over it.
- Download This Film with Radarr sends a note made without Radarr, with its own `quality`.
- The plugin starts Radarr, Sonarr, Prowlarr and the download client when it needs them (`open -g -a`), and waits up to 30 s for the port. None is a login item, and never make one.
- A new app the searches depend on needs the same, or it is off after a restart.
- `readRadarrConfig` checks `~/Library/Application Support/Radarr/config.xml` on macOS. Sonarr's is `~/.config/Sonarr/config.xml`. Detection looks in both.
- Downloads go to `~/Movies/Torrents` on the Mac's own disk. A folder on an absent 4T-HDD would make the real drive mount as `4T-HDD 1`.
- Seeding is off (ratio 0), because his connection uploads nothing. Prowlarr's seed ratio stays empty; it refuses a literal 0.
- Minimum seeders is 10, in Prowlarr. The Pirate Bay's Top 100 is set to Movies/TV, or Radarr's empty-query test fails and it drops the indexer.
- "All indexers unavailable" shows in `/api/v3/health`. `/indexerstatus` is not a Radarr route.

### Opening a File

- The link is `[Open](obsidian://arch-recreations?play=<path>)`. The plugin opens it with the `player` setting (VLC), and every other `.mp4` keeps its default.
- `locateFile` tries the stored path, then the path after the drive's name under every mounted volume, and returns it with symlinks resolved. The PC's snap VLC cannot see `/Volumes`.
- Parentheses in the link are encoded by hand. `encodeURIComponent` leaves them, and a `)` ends a markdown link.

### Subtitles

- Three OpenSubtitles requests: search by IMDb id and file hash, `POST /download`, save `<film>.<lang>.srt` beside the film.
- Skipped if the `.srt` exists. Put off if the file is unreachable, which is how an unplugged drive looks.
- The pick: hash match, then not hearing-impaired, then most downloads.
- The key allows 100 downloads a day. A long series runs out and goes on the next day.

### Series

- A series note `Title (Year)` is shaped like a film's: `creator`, `seasons` as wikilinks to the season notes, tag `series`.
- A season note is `Title – Season N (Year)`, with `season`, `episodes`, `series`, its own poster and tag `series/season`.
- A season note opens on the episode list, the poster under it after three blank lines.
- An episode line is `- S1E1 – Name`, then `- [S1E1 – Name](obsidian://arch-recreations?play=…)` once the file exists. `EPISODE_LINE` finds the block, and nothing else in the body is touched.
- `addOptions.monitor` overrides per-season `monitored` in the same POST. Monitoring chosen seasons is two calls.
- A brand-new series returns an empty release list until Sonarr has its episodes. `waitForSeason` polls `/episode` for up to a minute.
- One season pack shows once per episode in the queue. Dedupe by `downloadId`.
- A season takes packs only when a fit pack exists. `searchAndGrabSeason` grabs one release.
- The check remembers completions within the run, because the cache lags a write.

### 4K

- A 4K title's note goes in a `4K` subfolder, its name untouched. He tried a "4K" prefix and changed his mind.
- `/Volumes/4T-HDD/4K` is an extra root folder in both Radarr and Sonarr. `rootFor` sends a 4K download there.
- `pick4KRelease`: releases with at least 50 seeders (`fourKEnoughSeeders`, his number), smallest first, HDR before not.
- `unfit4K` rules out: not 2160p, AV1 (this Mac cannot decode it), remux, and Dolby Vision without HDR (purple and green in VLC).
- The Pirate Bay cuts names mid-word, so a codec is only ruled out when stated. Resolution comes from Radarr's parse.
- Minimum size stays in Radarr and Sonarr's quality definitions, never in the plugin.
- A name can lie. `ffprobe` settles HDR: `smpte2084` with `bt2020` is HDR10, `dv_profile` 5 breaks in VLC. The command and a guide to release names: `Details.md`.

### Games

- His plan and answers: `CHAOS Plans.md`, item 8. The design: `CHANGELOG.md`, 0.4.0.
- Steam's store and community sites are blocked on his network. Steam's image server and `api.steampowered.com` are not.
- RAWG gives the facts and the Steam app id, from which the cover and banner come.
- Newer games keep their art under a hashed folder, found through `IStoreBrowseService/GetItems`. The plugin does not use it yet.
- No status property. He refused "these bland "Completed" or "To Play" status". Never add `played`, `status` or `watched` to a game note.
- `play-on`, `cover` and `banner` are his once set. An import writes them only when missing.
- The cover is a property, never in the body. The body is the screenshots.
- RAWG's search is weak and its names noisy. `pickGame` and `slugGuesses` handle each case from his list.
- RAWG goes down for minutes. `rawg()` retries, and an import is safe to run again.
- Switch games get covers from GameTDB, only when RAWG lists the game for Switch. `switchtdb.xml` is cached, gitignored.
- A note name is RAWG's name without its disambiguation and without a year.

### Development

- TESTFIELD has the symlink. Its `data.json` is gitignored and holds the test keys.
- CHAOS's `data.json` holds his API keys. It never goes in git.
- The repo runs unbuilt. `npm run build` inlines `lib/` into `dist/main.js`. Never ship the repo's `main.js`.
- `purgeModuleCache` compares real paths and walks `window.require.cache`. Both halves are needed.
- Pure logic in `lib/recreations.js` runs under plain Node. A clean Node run says nothing about the Obsidian calls in `main.js`.

## Mistakes and Lessons

- A note deleted and added again with the box unticked came back without its file. Hence the read-only Radarr lookup.
- A note added with the box unticked waited for a link from a download nobody started. Hence Download This Film with Radarr.
- A timer that checked Radarr every ten minutes was built, and he rejected it.
- Three Star Wars notes had no link, because Radarr was registered with its own folder name.
- Radarr grabbed a zero-seeder release at the default minimum of 1, which sat at 0.0 GB.
- Alien: Earth grabbed nothing: Sonarr's empty release list looked like nothing found.
- The first series check left the series note at `dl-ed: false`, because the cache lagged.
- `%% episodes %%` markers wrapped the episode list until he asked what they were.
- A reload kept running the old `lib/`, because the purge compared symlinked paths and walked the wrong cache.
- Sep 30: this file said Steam's API was blocked. It was not.
- 0.4.3: the cover in the body hid the screenshots.

## Where It Stands

- 0.4.5 is current (Oct 9). CHAOS has it, copied in by hand the same day so Recreations and Thema Support never both hold Cmd + R. BRAT keeps it current from there. TESTFIELD has the symlink.
- The library is in CHAOS since Sep 25. CHAOS's `CLAUDE.md` has the counts and the notes waiting for him.
- Reload This Tab moved to Thema Support on Oct 9, his word. 0.4.5 has no copy.
- As of Sep 25, not checked since:
	- Nothing seeded enough for *The Divine Fury*, *Underworld: Rise of the Lycans* and *Kingdom* (2012) season 1. They stay wanted.
	- Solo's 4K is SDR. A well-seeded HDR encode of 12 to 20 GB is the upgrade to take. Radarr holds Solo at 4K, unmonitored.
	- Several 4K subtitles are not hash matches. Delete the `.srt` and run Fetch Subtitles for This Film.
	- Avatar's and Over the Garden Wall's `.srt` files kept their old names, so VLC does not pick them up.
	- Imported complete seasons were marked `dl-ed: true` by hand, so the check fetches no subtitles for them.
	- *Love, Death & Robots* S01 lacks episodes 13, 14 and 17. *King of the Hill* has seasons 1 to 13.
	- Two loose `President.Curtis.S01E05/06` files sit in the `Series` root. *One Piece (Pace)* was left alone by choice.
- No person has clicked Add a Series or the two per-note download commands.
- Steam's hashed art paths could give covers to games without one. Not built.
