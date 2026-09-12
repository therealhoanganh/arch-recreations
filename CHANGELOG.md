# Changelog

Version lives in `manifest.json` — Obsidian reads it from there. This file
explains what changed at each version and why.

## 0.1.0 — current

First version. Films only.

- **Add a film**: a search box over TMDB; picking a result writes the note in
  the user's shape — `watched`, `rank`, `banner-p` as editable defaults,
  `duration`, `year`, `URL` as a markdown link to TMDB, `poster` and `banner`
  as aliased wikilinks to files saved in the vault, `genres`, `director`,
  `writer`, `actors` as wikilinks, `tags`. Stills from the film are embedded in
  the body, five by default.
- **Art is downloaded at full size** from TMDB and encoded to WebP in the
  renderer: a 2000×3000 poster where media-db gave a 380×562 thumbnail.
- **Radarr**, if present, is detected from its own config file — key and port
  read, library folder asked for — and a film can be sent to it with a quality
  profile chosen in the modal. The note carries `quality` and `dl-ed: false`
  until the file lands, then `dl-ed: true` and a `file` link. Checked when the
  vault opens and every ten minutes.
- **Subtitles** come from OpenSubtitles the moment a film lands — search by
  IMDb id and file hash, prefer the hash match, then non-hearing-impaired, then
  most downloaded — and are saved beside the film as `<film>.en.srt`.
- Folder settings follow the family's five-option shape; the property order
  setting decides what is written as well as the order; hand-added properties
  are never touched; logging is always on.
