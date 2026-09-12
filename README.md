# ARCH Recreations

An Obsidian plugin for a film library that lives in the vault.

Type a title, pick the film, and the plugin writes a note with the poster,
banner and a handful of stills saved into the vault at full size, the credits
as wikilinks, and a link back to TMDB. If Radarr is running on the machine, the
film is handed to it with the quality profile you chose, and when the download
lands the note gets a link to the file and English subtitles appear beside it.

Desktop only. Needs a free TMDB API key; OpenSubtitles and Radarr are optional.

## Settings

- **Keys** — TMDB (required), OpenSubtitles (for subtitles), subtitle language.
- **Radarr** — detected from Radarr's own config file with one button; the
  library folder and quality profiles are read from Radarr.
- **Where things go** — film notes and their art, each with the same five
  choices as Obsidian's attachment setting.
- **The note** — file-name templates, labels on the image links, stills per
  film, actors listed, genre renames, tags, property order, default properties.

## Coupling to the rest of the ARCH family

Images are encoded to WebP here, so ARCH Images Plus leaves them alone. After
Clipping sees the TMDB link but themoviedb.org is not a media host, so it does
nothing with a film note.
