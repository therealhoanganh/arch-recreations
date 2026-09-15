# Changelog

Version lives in `manifest.json` — Obsidian reads it from there. This file
explains what changed at each version and why.

## 0.2.0 — current

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
