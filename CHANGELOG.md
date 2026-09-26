# Changelog

Version lives in `manifest.json` — Obsidian reads it from there. This file
explains what changed at each version and why.

## 0.3.1 — current

- **A film's link opens in VLC on the Ubuntu PC.** Hoang Anh clicked a film
  link there on 2026-09-26 and VLC answered *"VLC is unable to open the MRL
  'file:///Volumes/4T-HDD/Movies/Alien%20%281979%29/…'"*. The stored path
  exists on the PC through the link `/Volumes/4T-HDD` → `/run/media/hoanganh/4T-HDD`
  (Backup Strategy, Part 2), so `locateFile` accepted it as it was, but VLC
  there is a snap built on `core24`, and a snap's filesystem has no `/Volumes`
  at all; it can reach `/run/media` through its `removable-media` connection.
  `locateFile` now returns the found path with symlinks resolved, so any
  sandboxed player gets the real address.

## 0.3.0

- **`plot`, TMDB's overview, at the top of every film, series and season
  note.** Hoang Anh's words on 2026-09-25, when asked whether to keep the
  `plot` property the old Media DB notes in CHAOS carried: *"Why don't Arch
  Recreation have this? This is important and we should have this for all
  other notes! Help me fix this, add plot property location at the top of
  frontmatter."* It leads all three property-order defaults. A property order
  saved before this version gets `plot` put at its top once, on load (the
  `plotAdded` flag), because an own key missing from a saved order is dropped;
  taking it out afterwards sticks. A newline in a text property is now written
  as `\n` inside the quoted YAML string, since an overview can carry one.
- **Add plots from TMDB to notes without one**, a command: every film, series
  and season note inside the film and series folders that has no `plot` gets
  TMDB's overview, and nothing else is written. It looks only inside the
  folders set in settings because its first run also wrote into the old
  Media DB notes kept for comparison in `_/Old Film Notes`, which carry the
  same TMDB link; those were restored from the backup's versions folder. A
  note TMDB has no overview for (many season notes) is logged and left alone.

The entries below were already in the 0.2.0 assets, rebuilt from `94ad4ab` on
2026-09-16 without a version bump; 0.3.0 is the first number that names them.

- **4K picks the smallest well-seeded release, not the most seeded one.** At
  the "4K" quality profile the seeder floors step aside: among releases with
  at least *4K: enough seeders* (50) behind them, the smallest wins, an HDR
  one first. Only when nothing is that well seeded do the floors decide, so
  a thinly seeded file is never chosen just for being small. A season takes a
  whole-season pack whenever a fit one exists — one torrent from one release
  group, and grabbing a single-episode release would have fetched only that
  episode. Ruled out of 4K altogether: anything not 2160p, AV1 (no hardware
  decoding on this Mac, so it stutters), remuxes, and Dolby Vision with no
  HDR layer (VLC plays those purple and green). Every release left out is
  logged with the reason.
- **A 4K film or series downloads into the `4K` root folder** when Radarr or
  Sonarr has one, matching where its note goes in the vault.
- Fixed: the first search for a newly added series found nothing. Sonarr
  fetches a new series' episode list in the background and answers a release
  search for a season it does not know yet with an empty list rather than an
  error, so the search now waits for the season to appear.

- **A film or series at the "4K" quality profile goes into a `4K` subfolder**
  of wherever movies or series otherwise land (`Movies/4K`, `Series/4K`, by
  default), so the two collections don't mix in the same folder listing. The
  note's name is unaffected — only its location changes. Applies wherever a
  quality name is already known: *Add a film*'s dropdown, *Import existing
  films from Radarr*, *Import existing series from Sonarr*, and *Import films
  from the library folder*, which now scans every root folder Radarr knows
  about and treats a root named "4K" as 4K quality — so a second library
  folder kept just for 4K rips is picked up on its own once it's registered
  as a Radarr (and Sonarr) root folder.
- **Import existing films from Radarr** and **Import existing series from
  Sonarr**: one command each, writing a note (with its Open link once a file
  is there) for everything those apps already track that has no note yet —
  for a library built before this plugin existed, or added to Radarr/Sonarr
  directly.
- **Import films from the library folder**: the same, starting from disk
  instead of from Radarr — for a folder shaped `Title (Year)` sitting in the
  library that Radarr has never seen. Fixed alongside it: registering such a
  folder used to hand Radarr its own generated folder name (a title's colon
  becoming " -", say) instead of the name the folder actually has on disk, so
  the rescan that was supposed to find the file looked in a folder that
  didn't exist and never found it.

## 0.2.0

- **Series.** *Add a series* searches TMDB, then offers the seasons to
  download — all, some, or none for notes and art only. A series note reads
  like a film note (`creator`, `seasons`, tag `series`) and lists its seasons;
  each season note (`Title – Season N (Year)`, tag `series/season`) carries
  TMDB's season poster and the episode list, one Open link per episode once
  its file is there. *Download all seasons with Sonarr*, *Download this
  season with Sonarr* and *Check Sonarr for finished downloads* mirror the
  film commands; the check also fetches a subtitle per episode.
- **Sonarr**, detected from its own config file like Radarr — which on this
  Mac lives in `~/.config`, not Application Support; both places are tried.
- **Seeder floors.** Radarr and Sonarr no longer choose the release. The plugin
  runs their live search itself and tries the floors in *Seeder floors,
  highest first* (default `1000, 500, 200, 100, 50, 20, 10`) in order: the
  first floor with any surviving release wins, and the most-seeded release at
  that floor is grabbed — a season pack before single episodes. Two films had
  stalled on releases the site claimed had seeders and did not.
- **Open in VLC.** The `file` property is an `[Open](obsidian://…)` link the
  plugin answers by opening the file in the player named in settings (VLC),
  without changing what double-clicking an `.mp4` does anywhere else. The
  same link and the *Open this film in VLC* command find the film wherever the
  drive is mounted on the machine they run on.
- **Radarr and Transmission are started when needed** (`open -g -a`, kept
  behind Obsidian), so a film sent while Transmission was quit no longer sits
  in Radarr as merely wanted.
- **Check Radarr** covers files downloaded by hand: a film Radarr lacks is
  registered unmonitored so its folder is watched, and every film without a
  file gets a rescan. It is a command and nothing else — a version that ran on
  a timer was built and rejected.
- **Adding a film always asks Radarr what it has**, so a note deleted and
  re-added without the download box still gets its file link. *Download this
  film with Radarr* sends a note made without Radarr, and re-searches one
  Radarr holds without a file.
- Backdrops are `… Backdrop 01.webp` onward, the banner is the first of them,
  the poster and first backdrop are TMDB's primary ones (its film page's, not
  the top-voted), the poster is embedded at the top of the body, and every
  image is `.webp`. New notes start at `rank: 0`.
- Fixed: library edits were silently ignored on reload — the module-cache
  purge compared against the symlinked path and walked Obsidian's wrapper
  `require` instead of Node's.

## 0.1.0

First version. Films only.

- **Add a film**: a search box over TMDB; picking a result writes the note in
  the user's shape — `watched`, `rank`, `banner-p` as editable defaults,
  `duration`, `year`, `URL` as a markdown link to TMDB, `poster` and `banner`
  as aliased wikilinks to files saved in the vault, `genres`, `director`,
  `writer`, `actors` as wikilinks, `tags`. TMDB's backdrops — key art and
  frames from the film — are saved as `… Backdrop 01.webp` onward and embedded
  in the body, five by default; the banner property points at the first.
- **Art is downloaded at full size** from TMDB and encoded to WebP in the
  renderer: a 2000×3000 poster where media-db gave a 380×562 thumbnail.
- **Radarr**, if present, is detected from its own config file — key and port
  read, library folder asked for — and a film can be sent to it with a quality
  profile chosen in the modal. The note carries `quality` and `dl-ed: false`
  until the file lands, then `dl-ed: true` and a `file` link that opens the
  film in VLC (a setting) without changing what double-clicking an `.mp4`
  does anywhere else. The command *Check Radarr for finished downloads* does
  that for every film note without a file — on purpose a command, not a timer.
- **Subtitles** come from OpenSubtitles the moment a film lands — search by
  IMDb id and file hash, prefer the hash match, then non-hearing-impaired, then
  most downloaded — and are saved beside the film as `<film>.en.srt`.
- Folder settings follow the family's five-option shape; the property order
  setting decides what is written as well as the order; hand-added properties
  are never touched; logging is always on.
