# Changelog

Version lives in `manifest.json` — Obsidian reads it from there. This file
explains what changed at each version and why.

## 0.4.2 — current

- **Switch covers from GameTDB.** He asked, 2026-09-29: *"Also I don't find nintendo games in
  our base anymore."* He had made the CHAOS base's *Covers* view the first, and it showed only
  games with a cover; covers came from Steam's image server alone, so 48 games, mostly
  Nintendo exclusives, had none and were not in it. GameTDB needs no key: its database of
  Switch releases (`switchtdb.zip`, one XML file, fetched once a month into the plugin's folder
  and unzipped with the system's `unzip`) gives a game's id, and
  `art.gametdb.com/switch/coverHQ/US/<id>.jpg` its box art at 1166×1888. A game on the Switch
  without a Steam cover now gets one there, in *Add a Game* and the import alike, and the new
  command *Find Covers for Games without One* filled 29 of his notes. Titles are compared as
  RAWG's are, with ™ and ® left out (NFKD made "™" into "tm"), and "Pokémon Scarlet and
  Violet" takes Scarlet's box. The cover goes at the top of the body, as in a new note.
  19 games still have none: PlayStation and retro games, and a few RAWG does not list for the
  Switch.

## 0.4.1

- **Mac is a place to play.** His words, 2026-09-29: *"I think play on Mac could work for
  busy-screen indies, like play on small screen but still big enough."* `play-on` accepts
  Mac (and "macOS", "MacBook" in an imported list), and *Add a Game* offers it. The rule
  behind the places is in CHAOS's `Games/@Where to Play.md`.
  Then: *"Don't worry about now, this is just for prepare to try in future when I buy new
  M-chip Mac, right now I will play most on PC instead."* So the choice exists for later and
  no note says Mac yet; the busy-screen indies are on Linux.

## 0.4.0

- **Games**, the first kind after films and series, for CHAOS only. He asked on
  2026-09-29: *"Let's work on games. Like H-games, I want to create a library first, then we
  will move to Proton and Backup that will apply to both normal and h-games."* Asked where the
  code should live, he chose this plugin: *"I think we should, simplify thing, only CHAOS use
  this plugin so no need to care about universality."* His plan and answers are in
  `᭄᭡ CHAOS/CHAOS Plans.md`, item 8.
  - **RAWG for the facts, Steam's image server for the art.** Steam's store is blocked on his
    network (`store.steampowered.com` resolves to 127.0.0.1), but `cdn.akamai.steamstatic.com`
    is not, so a game whose RAWG store list has a Steam page gets Steam's library cover
    (`library_600x900_2x.jpg`) and banner (`library_hero.jpg`); others get RAWG's background as
    the banner and no cover. Screenshots come from RAWG resized to 1920 wide
    (`media.rawg.io/media/resize/1920/-/…`), a seventh of the original's bytes.
  - **The note**: `description`, `release-date`, `weighted-rating`, `rating`, `ratings-count`,
    `metacritic`, `play-on`, `rank`, `banner-p`, `genres`, `developers`, `publishers`,
    `platforms`, `banner`, `cover`, `URL` (RAWG), tag `game`; the body the cover and
    screenshots. **No status property**, his word: *"no need, like for Baldur's Gate 3, even
    though I spend like 150 hours finishing it, I will have this melancholic nostaliga and want
    to play it again some day"*, and not *"these bland "Completed" or "To Play" status"*.
  - **`play-on`** is his Notion list's category, *"desirable place to play"*: Linux (his
    Window and Steam Deck, at his word, since he will not buy a Steam Deck), Nintendo,
    RetroArch, PlayStation, Virtual. `play-on`, `cover` and `banner` are kept once a note has
    them (`writeMovieNote`'s new `keep`), so his own choices and art survive a re-import;
    Dispatch kept its hand-made cover and banner that way.
  - **`weighted-rating`** has the h-games' shape (ARCH Adult Contents): a Bayesian average
    towards the library's mean, plus 0.1 per tenfold more "added" than the library's median.
    The mean and median are measured from his notes after each import or refresh.
  - **Matching his titles** (`lib/games.js::pickGame`): exact after folding case, accents,
    punctuation, apostrophes and roman numerals; RAWG's own "(2018)" and "(itch)" ignored;
    plurals and joined words the same (No Man Sky, Rim World); add-ons, demos and demakes
    never picked unless his title says so. RAWG's search misses some famous games (The Last
    Guardian, Bloodborne, Persona 5 Royal, Yakuza Kiwami), so the game at the address his
    title would have is tried beside it. A pick with fewer than 10 people behind it, a
    starts-with match, or a same-named rival with a following is written but listed *to
    check*: the dry run on his 203 games found a jam game called *Fall Out* and a
    one-person *God Of War* that way. A RAWG address on a line pins the game.
  - Commands: *Add a Game* (search, pick, Play On), *Import a List of Games* (report under his
    list in `Games/@Import.md`), *Refresh Game Ratings from RAWG*. A note of his own under his
    name, without a RAWG URL, is renamed to RAWG's name and filled in rather than written
    beside (The Witcher 3); its body is kept, and the art it does not show yet is added at
    the end.
  - `writeMovieNote` and `setFields` take the kind's own keys, so a game's keys are not the
    film's.
  - **First run on his list, 2026-09-29**: 168 written, then RAWG answered HTTP 502 for 26
    games in a row. `rawg()` now tries a server error or a rate limit again after 5, 20 and
    60 seconds; the 26 went through on a second run. The run also showed an exact title must
    beat a near one (it picked *CHARMING HEART* over *Charming Hearts*), and that RAWG gives
    `rating: 0` for a game voted on but never scored, which is now no rating at all. Eleven
    titles RAWG's search could not place were pinned by address (Skyrim VR for his "Elder
    Scroll", *Needy Girl Overdose* for Needy Streamer Overload, and others); the list is in
    CHAOS's `Games/@Import.md`. 204 game notes in all, 154 with a Steam cover.

## 0.3.4

- **Prowlarr is started when Radarr or Sonarr needs it**, like Radarr, Sonarr and
  Transmission already were. On 2026-09-27 he took Radarr and two others off his macOS
  login items and asked whether that was all right: *"I remove Radarr and two other app from
  auto open on login list in system setting, is that ok? Is that auto open default of the
  apps? Can we turn it off by default?"* They were not the apps' defaults; the session that
  set up the stack made all four login items. Three of them the plugin already starts on
  demand (`ensureRunning`), but not Prowlarr. Radarr's only indexer, *The Pirate Bay
  (Prowlarr)*, is a proxy at `localhost:9696`, so with Prowlarr closed a search would find
  nothing and Radarr would sideline the indexer. `ensureIndexerProxy` asks Radarr or Sonarr for
  its enabled indexers once the app is up and starts Prowlarr for any on this computer at port
  9696 or named for it. Tested by stopping Prowlarr and calling `ensureRadarr`: *Prowlarr is up
  after 4s*, and Radarr's health listed no indexer fault.

## 0.3.3

- **Search results can be picked with the keyboard**, from the web-design-guidelines review of 2026-09-27 (`~/Documents/ARCH UI Review.md`), whose whole list he approved: *"Yes, proceed on."* In *Add a Film* and *Add a
  Series* a result was a box with a click handler: Enter searched, and then the mouse was
  needed. Now ↓ from the search box (or Tab) reaches the results, ↑ and ↓ move between
  them and back up to the box, and Enter or Space picks one. A result is highlighted on
  hover and ringed on focus, from a style element added on load and removed on unload,
  because a release ships no `styles.css`. Tried with real key presses in TESTFIELD on
  *Scavengers Reign*: ↓ reached the result, ↑ went back, Enter opened its seasons.
- **Title Case in every label**, the older commands as well, which 0.3.2 left in sentence
  case until this review. Commands, setting names and headings, buttons, popup titles and dropdown choices, Chicago style (small words such as *for*, *the*, *before* stay lower case), as in ARCH Images Plus 0.7.6. His preference: *"Actually, I much prefer Title Case."* Descriptions and notices stay sentences, and the ones that name a command or setting use its new name. A hotkey set on a command survives, because Obsidian stores hotkeys by the command's id.
- **The settings headings are Obsidian's own** (`setHeading`), not plain `h3` text, and the
  popups' titles are real titles rather than headings drawn inside them. The series popup's
  *Add* button reads *Add Series*.
- The search box and the quality dropdown have names (the dropdown sat inside the
  Radarr/Sonarr checkbox's label, so it had none). A failed search says what to check
  (the connection, the TMDB API Key) unless its message already does, and "Radarr not
  configured" reads "Radarr is not set up in settings".
- A count and its word: "12 episodes", "3 of 5 film notes written", not "episode(s)".
  No spell-check underlines in the settings, whose fields hold keys, addresses and paths.

## 0.3.2

- **Reload This Tab, on Ctrl+R (Cmd+R on the Mac).** Hoang Anh: *"I want to have a
  reload page/note command hotkey which Obsidian doesn't have by default."* Obsidian
  has only *Reload app without saving*, which reloads the whole window. This rebuilds
  the tab in front (`leaf.rebuildView()`): a note is read and drawn again with its
  scroll position kept, and a Base runs again, so a shuffled gallery reshuffles. Asked
  which plugin should carry it, he answered *"I just need it in CHAOS so maybe in
  arch-recreations instead?"*: Recreations is the ARCH plugin only CHAOS has. The name
  is Title Case, his preference; the older commands here are still sentence case until
  this plugin's UI review.
  Tried with a real key press in TESTFIELD and CHAOS on the PC; on the Mac he confirmed
  Cmd+R: *"Yes, it works on mac"*.

## 0.3.1

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
