'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath, requestUrl } = require('obsidian');
const { execFile } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DEFAULT_SETTINGS = {
  // keys
  tmdbApiKey: '',
  openSubtitlesApiKey: '',
  subtitleLanguage: 'en',

  // Radarr. Filled in by detection on first run; the API key is read from
  // Radarr's own config.xml, the same way yt-dlp's path is found elsewhere.
  radarrUrl: '',
  radarrApiKey: '',
  radarrRootFolder: '',
  // Sonarr, the same way, for series.
  sonarrUrl: '',
  sonarrApiKey: '',
  sonarrRootFolder: '',
  defaultQuality: '1080p',
  // Tried in order, highest first: the first floor with any (non-rejected)
  // release clears is the one used, and the most-seeded release at that
  // floor is what gets grabbed. Radarr's own per-indexer minimum seeders
  // stays underneath this as a hard floor -- a release below it never
  // appears in the list at all.
  seederTiers: '1000, 500, 200, 100, 50, 20, 10',
  // At the "4K" quality profile, size comes first: among releases with at
  // least this many seeders, the smallest is grabbed. Fewer than this and
  // the floors above decide instead, since a thinly seeded file takes
  // forever however small it is.
  fourKEnoughSeeders: 50,
  // The app the note's file link opens the film in. Only that link is
  // affected; the system default for .mp4 stays what it is. Empty for the
  // system default.
  player: 'VLC',

  // where film notes go. 'same' and 'subfolder' are relative to the note that
  // is open when the film is added.
  movieLocationMode: 'specified', // vault | same | subfolder | specified
  movieSubfolder: 'Movies',
  movieFolder: 'Movies',
  // where series notes go, with their season notes beside them.
  seriesLocationMode: 'specified', // vault | same | subfolder | specified
  seriesSubfolder: 'Series',
  seriesFolder: 'Series',
  // where the art goes, relative to the film or series note.
  imageLocationMode: 'subfolder', // vault | same | subfolder | specified
  imageSubfolder: 'Images',
  imageFolder: '',

  // the note
  noteNameTemplate: '{{title}} ({{year}})',
  posterTemplate: '{{title}} ({{year}})',
  backdropTemplate: '{{title}} ({{year}}) Backdrop {{n}}',
  posterLabel: 'Poster',
  bannerLabel: 'Banner',
  backdropsCount: 5,
  actorsCount: 5,
  genreMap: 'Science Fiction = Sci-Fi\nSci-Fi & Fantasy = Sci-Fi',
  movieTags: ['movie'],
  // series and season notes
  seasonNoteNameTemplate: '{{title}} \u2013 Season {{n}} ({{year}})',
  seasonPosterTemplate: '{{title}} \u2013 Season {{n}} ({{year}})',
  seriesTags: ['series'],
  seasonTags: ['series/season'],
  seriesNoteOrder: 'plot, dl-ed, watched, rank, banner-p, year, quality, URL, poster, banner, genres, creator, actors, seasons, tags',
  seasonNoteOrder: 'plot, dl-ed, watched, rank, season, episodes, year, quality, poster, series, tags',
  seriesNoteDefaults: 'watched: false\nrank: 0\nbanner-p: 50',
  seasonNoteDefaults: 'watched: false\nrank: 0',
  // Listed keys are written in this order; an own key left out is not
  // written; a key a person added by hand is always kept.
  movieNoteOrder: 'plot, dl-ed, watched, rank, banner-p, duration, year, quality, file, URL, poster, banner, genres, director, writer, actors, tags',
  // "key: value" per line, written on every new note so the property exists to
  // be edited. A value already on a note is never changed.
  movieNoteDefaults: 'watched: false\nrank: 0\nbanner-p: 50',

  setupDone: false,
};

const TMDB = 'https://api.themoviedb.org/3';
const OPENSUBTITLES = 'https://api.opensubtitles.com/api/v1';

class ArchRecreationsPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new RecreationsSettingTab(this.app, this));
    this.inFlight = new Set();

    this.addRibbonIcon('clapperboard', 'Add a film', () => this.openAddMovie());
    this.addCommand({ id: 'add-movie', name: 'Add a film', callback: () => this.openAddMovie() });
    this.addCommand({ id: 'add-series', name: 'Add a series', callback: () => this.openAddSeries() });
    this.addCommand({
      id: 'check-sonarr',
      name: 'Check Sonarr for finished downloads',
      callback: () => this.checkSonarr(true),
    });
    this.addCommand({
      id: 'download-series',
      name: 'Download all seasons with Sonarr',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md' || !this.tmdbTvIdOf(f)) return false;
        if (!checking) this.downloadSeriesNote(f).catch((e) => this.fail(e));
        return true;
      },
    });
    this.addCommand({
      id: 'download-season',
      name: 'Download this season with Sonarr',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md' || !this.seasonOf(f)) return false;
        if (!checking) this.downloadSeasonNote(f).catch((e) => this.fail(e));
        return true;
      },
    });
    this.addCommand({ id: 'detect-sonarr', name: 'Detect Sonarr', callback: () => this.detectSonarr(true) });
    this.addCommand({
      id: 'import-series',
      name: 'Import existing series from Sonarr',
      callback: () => this.importExistingSeries(true).catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: 'check-downloads',
      name: 'Check Radarr for finished downloads',
      callback: () => this.checkDownloads(true),
    });
    this.addCommand({
      id: 'import-movies',
      name: 'Import existing films from Radarr',
      callback: () => this.importExistingMovies(true).catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: 'import-films-from-disk',
      name: 'Import films from the library folder',
      callback: () => this.importFilmsFromDisk(true).catch((e) => this.fail(e)),
    });
    this.addCommand({
      id: 'subtitles-for-note',
      name: 'Fetch subtitles for this film',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md' || !this.tmdbIdOf(f)) return false;
        if (!checking) this.subtitlesForNote(f).catch((e) => this.fail(e));
        return true;
      },
    });
    this.addCommand({
      id: 'download-note',
      name: 'Download this film with Radarr',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md' || !this.tmdbIdOf(f)) return false;
        if (!checking) this.downloadNote(f).catch((e) => this.fail(e));
        return true;
      },
    });
    // Named after the player so it reads the way it is looked for ("Open this
    // film in VLC"); the name is fixed at load, so a changed player setting
    // shows after a reload.
    const player = (this.settings.player || '').trim();
    this.addCommand({
      id: 'open-film',
      name: player ? `Open this film in ${player}` : 'Open this film',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        const fm = f && f.extension === 'md' ? this.app.metadataCache.getFileCache(f)?.frontmatter : null;
        if (!fm || !fm.file) return false;
        if (!checking) this.playFile(this.lib().pathFromFileProperty(fm.file));
        return true;
      },
    });
    this.addCommand({
      id: 'add-plots',
      name: 'Add plots from TMDB to notes without one',
      callback: () => this.addPlots().catch((e) => this.fail(e)),
    });
    this.addCommand({ id: 'detect-radarr', name: 'Detect Radarr', callback: () => this.detectRadarr(true) });

    // Reload the tab in front, as a browser's reload does: a note is read and
    // drawn again, a Base runs again (a shuffled gallery reshuffles). Obsidian
    // has only a whole-app reload. Here because he wanted it in CHAOS only, and
    // this is the ARCH plugin CHAOS alone has (0.3.2). Ctrl+R, Cmd+R on the Mac.
    this.addCommand({
      id: 'reload-tab',
      name: 'Reload This Tab',
      hotkeys: [{ modifiers: ['Mod'], key: 'r' }],
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf || typeof leaf.rebuildView !== 'function') return false;
        if (!checking) leaf.rebuildView();
        return true;
      },
    });

    // obsidian://arch-recreations?play=<path> -- what the note's file link is.
    this.registerObsidianProtocolHandler('arch-recreations', (params) => {
      if (params.play) this.playFile(params.play);
    });

    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.setupDone) {
        await this.detectRadarr(false);
        await this.detectSonarr(false);
        this.settings.setupDone = true;
        await this.saveSettings();
      }
    });
  }

  onunload() {
    this.purgeModuleCache();
  }

  log(...args) {
    // Always on. A log that is off by default is a log nobody has when they
    // need it.
    console.log('[ArchRecreations]', ...args);
  }

  fail(e) {
    console.error('[ArchRecreations]', e);
    new Notice(`ARCH Recreations: ${e && e.message ? e.message : e}`, 10000);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // `plot` came in 0.3.0. A property order saved before then does not list
    // it, and an own key missing from the order is dropped -- so it is put at
    // the top of each saved order once. Taking it out again afterwards sticks.
    if (!this.settings.plotAdded) {
      for (const k of ['movieNoteOrder', 'seriesNoteOrder', 'seasonNoteOrder']) {
        const v = String(this.settings[k] || '');
        if (v.trim() && !/(^|[,\n])\s*plot\s*($|[,\n])/.test(v)) this.settings[k] = 'plot, ' + v;
      }
      this.settings.plotAdded = true;
      await this.saveSettings();
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  pluginDir() {
    const base = this.app.vault.adapter && this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : '';
    return path.join(base, this.manifest.dir || '');
  }

  lib() {
    if (typeof ARCH_LIB !== 'undefined') return ARCH_LIB;
    return require(path.join(this.pluginDir(), 'lib', 'recreations.js'));
  }

  purgeModuleCache() {
    let dir;
    try {
      // Node caches a required module under its resolved real path, not the
      // path it was asked for -- so a symlinked dev install (TESTFIELD) is
      // cached under the repo's own path in Documents. Comparing against the
      // symlinked path here never matched, so an edited lib/ was silently
      // never purged on reload; realpathSync matches what Node actually did.
      dir = fs.realpathSync(path.join(this.pluginDir(), 'lib'));
    } catch (_) {
      return;
    }
    // The `require` a plugin is handed is Obsidian's wrapper, and its
    // `.cache` is not Node's -- the loop below saw an empty object and purged
    // nothing. Electron's real one is `window.require`.
    const cache = (typeof window !== 'undefined' && window.require && window.require.cache) || require.cache || {};
    for (const key of Object.keys(cache)) {
      if (key.startsWith(dir)) delete cache[key];
    }
  }

  /* ---------------- HTTP ---------------- */

  // requestUrl is Obsidian's own client: no CORS, follows redirects.
  async json(opts) {
    const res = await requestUrl({ ...opts, throw: false });
    let body = null;
    try {
      body = res.json;
    } catch (_) {
      body = null;
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (body && (body.message || body.error)) || (Array.isArray(body) && body[0] && body[0].errorMessage) || res.text || '';
      throw new Error(`HTTP ${res.status} from ${opts.url.replace(/\?.*$/, '')}${msg ? ': ' + String(msg).slice(0, 200) : ''}`);
    }
    return body;
  }

  tmdb(pathname, params = {}) {
    if (!this.settings.tmdbApiKey) throw new Error('No TMDB API key in settings.');
    const q = new URLSearchParams({ api_key: this.settings.tmdbApiKey, ...params });
    return this.json({ url: `${TMDB}${pathname}?${q}` });
  }

  radarr(method, pathname, body) {
    const { radarrUrl, radarrApiKey } = this.settings;
    if (!radarrUrl || !radarrApiKey) throw new Error('Radarr is not configured. Run "Detect Radarr" or fill in the settings.');
    return this.json({
      url: `${radarrUrl.replace(/\/+$/, '')}/api/v3${pathname}`,
      method,
      headers: { 'X-Api-Key': radarrApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  sonarr(method, pathname, body) {
    const { sonarrUrl, sonarrApiKey } = this.settings;
    if (!sonarrUrl || !sonarrApiKey) throw new Error('Sonarr is not configured. Run "Detect Sonarr" or fill in the settings.');
    return this.json({
      url: `${sonarrUrl.replace(/\/+$/, '')}/api/v3${pathname}`,
      method,
      headers: { 'X-Api-Key': sonarrApiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  openSubtitles(method, pathname, params, body) {
    if (!this.settings.openSubtitlesApiKey) throw new Error('No OpenSubtitles API key in settings.');
    const q = params ? '?' + new URLSearchParams(params) : '';
    return this.json({
      url: `${OPENSUBTITLES}${pathname}${q}`,
      method,
      headers: {
        'Api-Key': this.settings.openSubtitlesApiKey,
        'User-Agent': `arch-recreations v${this.manifest.version}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  // Opens the film in the player named in settings, on whatever machine this
  // is. The file is looked for wherever the drive is mounted here (lib's
  // locateFile), and the player is asked for the way this platform asks --
  // `open -a` on macOS, `start` on Windows, the bare command on Linux -- with
  // the system default as the fallback when the player is not installed.
  playFile(stored) {
    const { locateFile } = this.lib();
    const player = (this.settings.player || '').trim();
    const file = locateFile(stored);
    if (!file) {
      this.log('film not found on any mounted drive:', stored);
      new Notice(`The film is not on any drive plugged into this machine: ${path.basename(stored)}`, 8000);
      return;
    }
    if (file !== stored) this.log('film found at a different mount point on this machine:', file);
    const attempts = [];
    if (process.platform === 'darwin') {
      if (player) attempts.push(['open', ['-a', player, file]]);
      attempts.push(['open', [file]]);
    } else if (process.platform === 'win32') {
      if (player) attempts.push(['cmd', ['/c', 'start', '', player, file]]);
      attempts.push(['cmd', ['/c', 'start', '', file]]);
    } else {
      if (player) attempts.push([player.toLowerCase(), [file]]);
      attempts.push(['xdg-open', [file]]);
    }
    const tryNext = (i) => {
      if (i >= attempts.length) {
        new Notice(`Could not open ${path.basename(file)} with anything on this machine.`, 8000);
        return;
      }
      const [cmd, args] = attempts[i];
      execFile(cmd, args, (err) => {
        if (err) {
          this.log(`${cmd} ${args[0] === '-a' ? args[1] : ''} could not open it (${err.message.split('\n')[0]}), trying the next`);
          tryNext(i + 1);
        } else this.log(`opened with ${cmd}${args[0] === '-a' ? ' ' + args[1] : ''}:`, file);
      });
    };
    tryNext(0);
  }

  /* ---------------- TMDB ---------------- */

  async searchMovies(query) {
    const r = await this.tmdb('/search/movie', { query, include_adult: 'false' });
    return (r.results || []).map((m) => ({
      tmdbId: m.id,
      title: m.title,
      year: String(m.release_date || '').slice(0, 4),
      overview: m.overview || '',
    }));
  }

  async movieDetails(tmdbId) {
    const { movieFromTmdb, parseRenameMap } = this.lib();
    const json = await this.tmdb(`/movie/${tmdbId}`, {
      append_to_response: 'images,credits',
      include_image_language: 'en,null',
    });
    return movieFromTmdb(json, {
      backdrops: Number(this.settings.backdropsCount) || 0,
      actors: Number(this.settings.actorsCount) || 5,
      genreMap: parseRenameMap(this.settings.genreMap),
    });
  }

  async searchSeries(query) {
    const r = await this.tmdb('/search/tv', { query, include_adult: 'false' });
    return (r.results || []).map((m) => ({
      tmdbId: m.id,
      title: m.name,
      year: String(m.first_air_date || '').slice(0, 4),
      overview: m.overview || '',
    }));
  }

  async seriesDetails(tmdbId) {
    const { seriesFromTmdb, parseRenameMap } = this.lib();
    const json = await this.tmdb(`/tv/${tmdbId}`, {
      append_to_response: 'images,aggregate_credits,external_ids',
      include_image_language: 'en,null',
    });
    return seriesFromTmdb(json, {
      backdrops: Number(this.settings.backdropsCount) || 0,
      actors: Number(this.settings.actorsCount) || 5,
      genreMap: parseRenameMap(this.settings.genreMap),
    });
  }

  async seasonDetails(tmdbId, number) {
    const { seasonFromTmdb } = this.lib();
    const json = await this.tmdb(`/tv/${tmdbId}/season/${number}`, {
      append_to_response: 'images',
      include_image_language: 'en,null',
    });
    return seasonFromTmdb(json);
  }

  /* ---------------- Radarr ---------------- */

  // Reads Radarr's own config.xml for the key and port, then asks it for the
  // library folder. Nothing to type; a Radarr that is not there is reported.
  async detectRadarr(manual) {
    const { readRadarrConfig } = this.lib();
    const found = readRadarrConfig(process.platform, os.homedir(), process.env);
    if (!found) {
      this.log('Radarr config.xml not found; Radarr is optional, notes and art still work');
      if (manual) new Notice('Radarr not found on this machine. It is optional: notes and art work without it.', 8000);
      return false;
    }
    this.settings.radarrUrl = found.url;
    this.settings.radarrApiKey = found.apiKey;
    this.log('Radarr found via', found.file, '->', found.url);
    try {
      const roots = await this.radarr('GET', '/rootfolder');
      if (roots.length && !this.settings.radarrRootFolder) this.settings.radarrRootFolder = roots[0].path;
      const profiles = await this.radarr('GET', '/qualityprofile');
      const names = profiles.map((p) => p.name);
      if (!names.some((n) => n.toLowerCase() === String(this.settings.defaultQuality).toLowerCase()) && names.length) {
        this.settings.defaultQuality = names[0];
      }
      this.log(`Radarr: library ${this.settings.radarrRootFolder || '(none)'}, profiles ${names.join(', ')}`);
      if (manual) new Notice(`Radarr found at ${found.url}. Profiles: ${names.join(', ')}.`, 8000);
    } catch (e) {
      this.log('Radarr found but not answering:', e.message);
      if (manual) new Notice(`Radarr's config was found but it is not answering: ${e.message}`, 10000);
    }
    await this.saveSettings();
    return true;
  }

  radarrConfigured() {
    return !!(this.settings.radarrUrl && this.settings.radarrApiKey);
  }

  /* ---------------- Sonarr ---------------- */

  sonarrConfigured() {
    return !!(this.settings.sonarrUrl && this.settings.sonarrApiKey);
  }

  async detectSonarr(manual) {
    const { readSonarrConfig } = this.lib();
    const found = readSonarrConfig(process.platform, os.homedir(), process.env);
    if (!found) {
      this.log('Sonarr config.xml not found; Sonarr is optional, series notes and art still work');
      if (manual) new Notice('Sonarr not found on this machine. It is optional: series notes and art work without it.', 8000);
      return false;
    }
    this.settings.sonarrUrl = found.url;
    this.settings.sonarrApiKey = found.apiKey;
    this.log('Sonarr found via', found.file, '->', found.url);
    try {
      const roots = await this.sonarr('GET', '/rootfolder');
      if (roots.length && !this.settings.sonarrRootFolder) this.settings.sonarrRootFolder = roots[0].path;
      const names = (await this.sonarr('GET', '/qualityprofile')).map((p) => p.name);
      this.log(`Sonarr: library ${this.settings.sonarrRootFolder || '(none)'}, profiles ${names.join(', ')}`);
      if (manual) new Notice(`Sonarr found at ${found.url}. Profiles: ${names.join(', ')}.`, 8000);
    } catch (e) {
      this.log('Sonarr found but not answering:', e.message);
      if (manual) new Notice(`Sonarr's config was found but it is not answering: ${e.message}`, 10000);
    }
    await this.saveSettings();
    return true;
  }

  async ensureSonarr() {
    if (!this.sonarrConfigured()) return false;
    let port = 8989;
    let host = 'localhost';
    try {
      const u = new URL(this.settings.sonarrUrl);
      host = u.hostname || host;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch (_) {
      /* keep the defaults */
    }
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return this.portOpen(host, port);
    return this.ensureRunning('Sonarr', host, port);
  }

  async sonarrProfiles() {
    return (await this.sonarr('GET', '/qualityprofile')).map((p) => ({ id: p.id, name: p.name }));
  }

  // Where a new download lands: at the "4K" profile, the app's root folder
  // named "4K" when it has one (/Volumes/4T-HDD/4K, shared by both apps), so
  // 4K rips sit apart on the drive as their notes do in the vault; otherwise
  // the library folder from settings, or the app's first root folder.
  async rootFor(app, qualityName) {
    const call = app === 'radarr' ? this.radarr.bind(this) : this.sonarr.bind(this);
    const setting = app === 'radarr' ? this.settings.radarrRootFolder : this.settings.sonarrRootFolder;
    const roots = await call('GET', '/rootfolder');
    if (String(qualityName || '').toLowerCase() === '4k') {
      const fourK = roots.find((r) => path.basename(r.path).toLowerCase() === '4k');
      if (fourK) return fourK.path;
      this.log(`${app} has no root folder named 4K; this 4K title goes to the main library`);
    }
    const root = setting || (roots.length ? roots[0].path : '');
    if (!root) throw new Error(`${app === 'radarr' ? 'Radarr' : 'Sonarr'} has no library folder set.`);
    return root;
  }

  // Sonarr's series carry both ids; TMDB's is what the note holds.
  async sonarrSeriesByTmdb(tmdbId, tvdbId) {
    const all = await this.sonarr('GET', '/series');
    return all.find((x) => x.tmdbId === tmdbId) || (tvdbId ? all.find((x) => x.tvdbId === tvdbId) : null) || null;
  }

  // Adds with nothing monitored and no search: `addOptions.monitor` overrides
  // the per-season flags sent in the same call, so seasons are chosen in a
  // second call (`monitorSeasons`) and the searching is the plugin's.
  async addToSonarr(series, qualityName) {
    await this.ensureSonarr();
    if (!series.tvdbId) throw new Error(`TMDB has no TVDB id for ${series.title}, and Sonarr needs one.`);
    const existing = await this.sonarrSeriesByTmdb(series.tmdbId, series.tvdbId);
    if (existing) {
      this.log('already in Sonarr, not added again:', existing.title);
      return existing;
    }
    const profiles = await this.sonarrProfiles();
    const profile = profiles.find((p) => p.name.toLowerCase() === String(qualityName || '').toLowerCase());
    if (!profile) throw new Error(`Sonarr has no quality profile named "${qualityName}". It has: ${profiles.map((p) => p.name).join(', ')}.`);
    const root = await this.rootFor('sonarr', qualityName);
    const found = await this.sonarr('GET', `/series/lookup?term=${encodeURIComponent('tvdb:' + series.tvdbId)}`);
    if (!found || !found.length) throw new Error(`Sonarr could not find tvdb:${series.tvdbId}.`);
    const body = {
      ...found[0],
      qualityProfileId: profile.id,
      rootFolderPath: root,
      monitored: true,
      seasonFolder: true,
      addOptions: { searchForMissingEpisodes: false, searchForCutoffUnmetEpisodes: false, monitor: 'none' },
    };
    const added = await this.sonarr('POST', '/series', body);
    this.log(`added to Sonarr as ${profile.name}:`, added.title, added.year, '->', added.path);
    return added;
  }

  // Turns the chosen seasons on, leaves the rest as they are. Episodes follow
  // their season on Sonarr's side.
  async monitorSeasons(sonarrSeries, numbers) {
    const wanted = new Set(numbers);
    let changed = false;
    for (const x of sonarrSeries.seasons) {
      if (wanted.has(x.seasonNumber) && !x.monitored) {
        x.monitored = true;
        changed = true;
      }
    }
    if (!sonarrSeries.monitored) {
      sonarrSeries.monitored = true;
      changed = true;
    }
    if (!changed) return sonarrSeries;
    const updated = await this.sonarr('PUT', `/series/${sonarrSeries.id}`, sonarrSeries);
    this.log(`monitoring season(s) ${[...wanted].join(', ')} of ${updated.title}`);
    return updated;
  }

  async seasonInQueue(seriesId, seasonNumber) {
    const q = await this.sonarr('GET', '/queue?pageSize=200');
    return (q.records || []).some((r) => r.seriesId === seriesId && r.seasonNumber === seasonNumber);
  }

  async seasonHasAllFiles(seriesId, seasonNumber) {
    const eps = await this.sonarr('GET', `/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}`);
    const aired = eps.filter((e) => e.airDate && e.airDate <= new Date().toISOString().slice(0, 10));
    return aired.length > 0 && aired.every((e) => e.hasFile);
  }

  // The season search: packs and single episodes together, the cascade
  // preferring a pack inside a tier so the season is one torrent.
  // A series added a moment ago has no episode list yet -- Sonarr fetches it
  // in the background -- and a release search for a season it does not know
  // returns an empty list straight away rather than an error. Waiting for the
  // season to appear is what makes the first search of a new series work.
  async waitForSeason(seriesId, seasonNumber, waitMs = 60000) {
    const started = Date.now();
    for (;;) {
      const eps = await this.sonarr('GET', `/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}`);
      if (eps && eps.length) return true;
      if (Date.now() - started > waitMs) {
        this.log(`Sonarr still lists no episodes for series ${seriesId} season ${seasonNumber} after ${Math.round(waitMs / 1000)}s`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  async searchAndGrabSeason(seriesId, seasonNumber, title) {
    await this.ensureDownloadClient('sonarr');
    await this.waitForSeason(seriesId, seasonNumber);
    let releases;
    try {
      releases = await this.sonarr('GET', `/release?seriesId=${seriesId}&seasonNumber=${seasonNumber}`);
    } catch (e) {
      this.log(`release search failed for ${title} season ${seasonNumber}:`, e.message);
      return false;
    }
    const tiers = this.lib().parseSeederTiers(this.settings.seederTiers);
    const series = await this.sonarr('GET', `/series/${seriesId}`);
    const is4K = String(await this.sonarrProfileNameOf(series.qualityProfileId, '')).toLowerCase() === '4k';
    const label = `${title} season ${seasonNumber}`;
    const picked = is4K
      ? this.pick4K(releases, tiers, label, { season: true })
      : this.lib().pickRelease(releases, tiers, { preferFullSeason: true });
    if (!picked) {
      this.log(`no release cleared any seeder floor (${tiers.join(', ') || 'none set'}) for ${label}; nothing grabbed`);
      return false;
    }
    await this.sonarr('POST', '/release', { guid: picked.release.guid, indexerId: picked.release.indexerId });
    this.log(
      `grabbed ${this.pickedHow(picked)} (${picked.release.seeders} seeders, ${this.gb(picked.release.size)}, ${picked.release.fullSeason ? 'season pack' : 'single episodes'}) for ${label}:`,
      picked.release.title
    );
    return true;
  }

  // One season: monitored in Sonarr, then searched unless it is already
  // complete or already in the queue.
  async downloadSeason(sonarrSeries, seasonNumber) {
    const updated = await this.monitorSeasons(sonarrSeries, [seasonNumber]);
    if (await this.seasonHasAllFiles(updated.id, seasonNumber)) {
      this.log(`season ${seasonNumber} of ${updated.title} already has every episode`);
      return updated;
    }
    if (await this.seasonInQueue(updated.id, seasonNumber)) {
      this.log(`season ${seasonNumber} of ${updated.title} is already in Sonarr's queue`);
      return updated;
    }
    await this.searchAndGrabSeason(updated.id, seasonNumber, updated.title);
    return updated;
  }

  /* ---------------- keeping the apps alive ---------------- */

  portOpen(host, port) {
    return new Promise((resolve) => {
      const sock = net.connect({ host: host || 'localhost', port: Number(port) });
      const done = (ok) => {
        try {
          sock.destroy();
        } catch (_) {
          /* gone */
        }
        resolve(ok);
      };
      sock.setTimeout(800);
      sock.once('connect', () => done(true));
      sock.once('timeout', () => done(false));
      sock.once('error', () => done(false));
    });
  }

  // Launches an app in the background -- `open -g` on macOS keeps it behind
  // Obsidian -- and waits until its port answers. Nothing to configure: the
  // app's name is what the platform launches by.
  async ensureRunning(appName, host, port, waitMs = 30000) {
    if (await this.portOpen(host, port)) return true;
    this.log(`${appName} is not running, starting it`);
    const launch =
      process.platform === 'darwin' ? ['open', ['-g', '-a', appName]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', appName]]
      : [appName.toLowerCase(), []];
    await new Promise((resolve) => execFile(launch[0], launch[1], (err) => {
      if (err) this.log(`could not start ${appName}:`, err.message.split('\n')[0]);
      resolve();
    }));
    const started = Date.now();
    while (Date.now() - started < waitMs) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await this.portOpen(host, port)) {
        this.log(`${appName} is up after ${Math.round((Date.now() - started) / 1000)}s`);
        return true;
      }
    }
    this.log(`${appName} did not answer on port ${port} within ${waitMs / 1000}s`);
    return false;
  }

  async ensureRadarr() {
    if (!this.radarrConfigured()) return false;
    let port = 7878;
    let host = 'localhost';
    try {
      const u = new URL(this.settings.radarrUrl);
      host = u.hostname || host;
      port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    } catch (_) {
      /* keep the defaults */
    }
    // Only an app on this machine can be started from here.
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return this.portOpen(host, port);
    return this.ensureRunning('Radarr', host, port);
  }

  // Radarr says which client it hands downloads to -- Transmission,
  // qBittorrent -- and on which port; that is enough to start it and know
  // when it is ready.
  async ensureDownloadClient(app = 'radarr') {
    let clients;
    try {
      clients = await (app === 'sonarr' ? this.sonarr('GET', '/downloadclient') : this.radarr('GET', '/downloadclient'));
    } catch (e) {
      this.log(`could not ask ${app === 'sonarr' ? 'Sonarr' : 'Radarr'} for its download client:`, e.message);
      return false;
    }
    const c = clients.find((x) => x.enable) || clients[0];
    if (!c) {
      this.log(`${app === 'sonarr' ? 'Sonarr' : 'Radarr'} has no download client configured`);
      return false;
    }
    const field = (name) => (c.fields.find((f) => f.name === name) || {}).value;
    const host = field('host') || 'localhost';
    const port = field('port') || (c.implementation === 'Transmission' ? 9091 : 8080);
    if (!['localhost', '127.0.0.1', '::1'].includes(host)) return this.portOpen(host, port);
    return this.ensureRunning(c.implementation, host, port);
  }

  async radarrProfiles() {
    return (await this.radarr('GET', '/qualityprofile')).map((p) => ({ id: p.id, name: p.name }));
  }

  // The profile's name for a film Radarr already holds; the id is Radarr's
  // and never goes on a note.
  async profileNameOf(profileId, fallback) {
    try {
      const p = (await this.radarrProfiles()).find((x) => x.id === profileId);
      return p ? p.name : fallback;
    } catch (_) {
      return fallback;
    }
  }

  async radarrMovieByTmdb(tmdbId) {
    const list = await this.radarr('GET', `/movie?tmdbId=${tmdbId}`);
    return Array.isArray(list) && list.length ? list[0] : null;
  }

  // Runs a Radarr command and waits for it to finish, briefly: a rescan of one
  // folder takes a second or two, and the answer is only useful once it has.
  async radarrCommand(body, timeoutMs = 30000) {
    const cmd = await this.radarr('POST', '/command', body);
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await new Promise((r) => setTimeout(r, 1000));
      const c = await this.radarr('GET', `/command/${cmd.id}`);
      if (c.status === 'completed' || c.status === 'failed' || c.status === 'aborted') return c;
    }
    this.log(`Radarr command ${body.name} still running after ${timeoutMs / 1000}s, not waiting further`);
    return null;
  }

  // Registers a film with Radarr without downloading it -- unmonitored, no
  // search -- so a file put in its library folder by hand is adopted on the
  // next rescan. That is how a manual 4K download gets its link. `knownPath`
  // pins the movie to a folder that already exists under a name Radarr would
  // not have generated itself -- the usual case for a film that predates
  // this plugin -- so the rescan looks in the right place instead of the
  // empty folder Radarr's own naming format would have produced from the
  // title alone.
  async registerInRadarr(tmdbId, knownPath, qualityName) {
    let root = this.settings.radarrRootFolder;
    if (!root) {
      const roots = await this.radarr('GET', '/rootfolder');
      root = roots.length ? roots[0].path : '';
      if (!root) throw new Error('Radarr has no library folder set.');
    }
    const profiles = await this.radarrProfiles();
    const profile = profiles.find((p) => p.name.toLowerCase() === String(qualityName || this.settings.defaultQuality).toLowerCase()) || profiles[0];
    if (!profile) throw new Error('Radarr has no quality profile.');
    const body = {
      tmdbId,
      qualityProfileId: profile.id,
      rootFolderPath: root,
      monitored: false,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false },
    };
    if (knownPath) body.path = knownPath;
    const added = await this.radarr('POST', '/movie', body);
    this.log('registered in Radarr, unmonitored, so its folder is watched:', added.title, '->', added.path);
    return added;
  }

  // Adds the film and searches for it in one call. A film Radarr already has
  // is left as it is -- Radarr refuses duplicates, and re-adding is not what a
  // second note means. The search Radarr would run on its own is skipped
  // (`searchForMovie: false`); `searchAndGrab` does it instead, so the
  // seeder-tier cascade decides what gets grabbed rather than Radarr's own
  // pick.
  async addToRadarr(tmdbId, qualityName) {
    await this.ensureRadarr();
    const existing = await this.radarrMovieByTmdb(tmdbId);
    if (existing) {
      this.log('already in Radarr, not added again:', existing.title, existing.hasFile ? '(has file)' : '(no file yet)');
      return existing;
    }
    const profiles = await this.radarrProfiles();
    const profile = profiles.find((p) => p.name.toLowerCase() === String(qualityName || '').toLowerCase());
    if (!profile) throw new Error(`Radarr has no quality profile named "${qualityName}". It has: ${profiles.map((p) => p.name).join(', ')}.`);
    const root = await this.rootFor('radarr', qualityName);
    await this.ensureDownloadClient();
    const added = await this.radarr('POST', '/movie', {
      tmdbId,
      qualityProfileId: profile.id,
      rootFolderPath: root,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: false },
    });
    this.log(`added to Radarr as ${profile.name}:`, added.title, added.year, '->', added.path);
    await this.searchAndGrab(added.id, added.title);
    return added;
  }

  // The cascade: Radarr's own live release search (the same one its
  // interactive search uses), then the highest seeder tier that has any
  // non-rejected release wins, most-seeded release in that tier grabbed by
  // its own guid -- so Radarr never gets to fall back to its default pick.
  async searchAndGrab(movieId, title) {
    await this.ensureDownloadClient();
    let releases;
    try {
      releases = await this.radarr('GET', `/release?movieId=${movieId}`);
    } catch (e) {
      this.log(`release search failed for ${title}:`, e.message);
      return false;
    }
    const tiers = this.lib().parseSeederTiers(this.settings.seederTiers);
    const movie = await this.radarr('GET', `/movie/${movieId}`);
    const is4K = String(await this.profileNameOf(movie.qualityProfileId, '')).toLowerCase() === '4k';
    const picked = is4K ? this.pick4K(releases, tiers, title) : this.lib().pickRelease(releases, tiers);
    if (!picked) {
      this.log(`no release cleared any seeder floor (${tiers.join(', ') || 'none set'}) for ${title}; nothing grabbed`);
      return false;
    }
    await this.radarr('POST', '/release', { guid: picked.release.guid, indexerId: picked.release.indexerId });
    this.log(
      `grabbed ${this.pickedHow(picked)} (${picked.release.seeders} seeders, ${this.gb(picked.release.size)}) for ${title}:`,
      picked.release.title
    );
    return true;
  }

  // The 4K rule (lib's pick4KRelease), with every release it ruled out
  // logged and why -- a 4K search that grabs nothing should say whether
  // nothing was there or everything was the wrong kind.
  pick4K(releases, tiers, label, opts = {}) {
    const L = this.lib();
    for (const r of releases || []) {
      const why = !r.rejected && L.unfit4K(r);
      if (why) this.log(`4K rule, left out for ${label} (${why}):`, r.title);
    }
    const enough = Number(this.settings.fourKEnoughSeeders) || 0;
    return L.pick4KRelease(releases, tiers, enough, opts);
  }

  pickedHow(picked) {
    return picked.smallest ? `as the smallest with ${picked.floor}+ seeders` : `at the ${picked.floor}+ seeder floor`;
  }

  gb(bytes) {
    return `${((bytes || 0) / 1e9).toFixed(1)} GB`;
  }

  /* ---------------- folders ---------------- */

  cleanFolder(s) {
    return String(s || '').replace(/^\/+|\/+$/g, '').trim();
  }

  activeNoteFolder() {
    const f = this.app.workspace.getActiveFile();
    return f && f.parent ? f.parent.path.replace(/^\/$/, '') : '';
  }

  // `quality` is the profile name a film is going to (or already sits in)
  // Radarr under. A film at the "4K" profile goes into a "4K" subfolder of
  // wherever movies otherwise land, so the two collections don't mix in the
  // same listing; everything else about the setting is unchanged.
  resolveMovieFolder(quality) {
    const s = this.settings;
    const mode = s.movieLocationMode || 'specified';
    const anchor = this.activeNoteFolder();
    let folder;
    if (mode === 'vault') folder = '';
    else if (mode === 'same') folder = anchor;
    else if (mode === 'subfolder') {
      const sub = this.cleanFolder(s.movieSubfolder) || 'Movies';
      folder = anchor ? `${anchor}/${sub}` : sub;
    } else folder = this.cleanFolder(s.movieFolder);
    if (String(quality || '').trim().toLowerCase() === '4k') {
      folder = folder ? `${folder}/4K` : '4K';
    }
    return folder;
  }

  // Mirrors resolveMovieFolder: a series at the "4K" profile goes into a "4K"
  // subfolder of wherever series otherwise land.
  resolveSeriesFolder(quality) {
    const s = this.settings;
    const mode = s.seriesLocationMode || 'specified';
    const anchor = this.activeNoteFolder();
    let folder;
    if (mode === 'vault') folder = '';
    else if (mode === 'same') folder = anchor;
    else if (mode === 'subfolder') {
      const sub = this.cleanFolder(s.seriesSubfolder) || 'Series';
      folder = anchor ? `${anchor}/${sub}` : sub;
    } else folder = this.cleanFolder(s.seriesFolder);
    if (String(quality || '').trim().toLowerCase() === '4k') {
      folder = folder ? `${folder}/4K` : '4K';
    }
    return folder;
  }

  resolveImageFolder(noteFolder) {
    const s = this.settings;
    const mode = s.imageLocationMode || 'subfolder';
    if (mode === 'vault') return '';
    if (mode === 'same') return noteFolder;
    if (mode === 'specified') return this.cleanFolder(s.imageFolder) || noteFolder;
    const sub = this.cleanFolder(s.imageSubfolder) || 'Images';
    return noteFolder ? `${noteFolder}/${sub}` : sub;
  }

  async ensureFolder(folder) {
    if (!folder) return;
    const p = normalizePath(folder);
    if (this.app.vault.getAbstractFileByPath(p) instanceof TFolder) return;
    await this.app.vault.createFolder(p).catch(() => {});
  }

  /* ---------------- images ---------------- */

  // Encoded to WebP here rather than left for ARCH Images Plus: the note is
  // written moments after the image, and a link written as .jpg to a file that
  // becomes .webp a second later is a race. Quality 0.90, the same as Images
  // Plus, because the original is not kept. Always .webp, even when the WebP
  // is a little larger than the JPEG -- one extension for every image the
  // plugin writes, which the user asked for over a few KB.
  async saveImage(url, folder, stem) {
    const target = normalizePath(folder ? `${folder}/${stem}.webp` : `${stem}.webp`);
    const already = this.app.vault.getAbstractFileByPath(target);
    if (already instanceof TFile) {
      this.log('image already on disk, kept:', target);
      return already;
    }
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200 || !res.arrayBuffer || !res.arrayBuffer.byteLength) throw new Error(`HTTP ${res.status} for ${url}`);
    const type = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || 'image/jpeg';
    let bytes = new Uint8Array(res.arrayBuffer);
    let out = target;
    try {
      const { encodeWebp } = this.lib();
      const encoded = await encodeWebp(new Blob([res.arrayBuffer], { type }), 0.9, { always: true });
      bytes = encoded.data;
    } catch (e) {
      out = normalizePath(target.replace(/\.webp$/, type.includes('png') ? '.png' : '.jpg'));
      this.log('WebP encode failed, keeping the original:', e.message);
    }
    await this.app.vault.createBinary(out, bytes);
    this.log('saved', out, `${Math.round(bytes.length / 1024)} KB`);
    const file = this.app.vault.getAbstractFileByPath(out);
    return file instanceof TFile ? file : null;
  }

  linkFor(file, fromNotePath, alias) {
    let link = file.path;
    try {
      link = this.app.metadataCache.fileToLinktext(file, fromNotePath || '', true);
    } catch (_) {
      /* fall back to the full path */
    }
    return alias ? `[[${link}|${alias}]]` : `[[${link}]]`;
  }

  // The poster and the backdrops for one note, saved and turned into links.
  // Backdrops are numbered 01, 02, ... and the banner property points at the
  // first of them: one file, two roles. Shared by films, series and seasons.
  async fetchArt(where, posterUrl, backdropUrls, posterTemplate, backdropTemplate) {
    const L = this.lib();
    const { vars, imageFolder, notePath } = where;
    const art = async (url, template, n) => {
      if (!url) return null;
      const stem = L.safeFileName(L.fillTemplate(template, { ...vars, n }));
      try {
        return await this.saveImage(url, imageFolder, stem);
      } catch (e) {
        this.log(`image failed (${stem}):`, e.message);
        return null;
      }
    };
    const links = {};
    const backdropLinks = [];
    const posterFile = await art(posterUrl, posterTemplate, vars.n || '');
    if (posterFile) links.poster = this.linkFor(posterFile, notePath, this.settings.posterLabel);
    for (let i = 0; i < (backdropUrls || []).length; i++) {
      const n = String(i + 1).padStart(2, '0');
      const f = await art(backdropUrls[i], backdropTemplate, n);
      if (!f) continue;
      backdropLinks.push(this.linkFor(f, notePath, ''));
      if (!links.banner) links.banner = this.linkFor(f, notePath, this.settings.bannerLabel);
    }
    return { posterFile, links, backdropLinks };
  }

  /* ---------------- adding a film ---------------- */

  openAddMovie() {
    if (!this.settings.tmdbApiKey) {
      new Notice('Put your TMDB API key in the ARCH Recreations settings first.', 8000);
      return;
    }
    new AddMovieModal(this.app, this).open();
  }

  // The whole thing for one film: details, art, note, Radarr. Each step logs
  // what it decided so a run can be read back.
  async addMovie(tmdbId, quality, sendToRadarr, opts = {}) {
    const open = opts.open !== false;
    const key = `tmdb:${tmdbId}`;
    if (this.inFlight.has(key)) {
      new Notice('That film is already being added.');
      return;
    }
    this.inFlight.add(key);
    const t0 = Date.now();
    const lap = (label) => this.log(`${label}: ${Date.now() - t0}ms`);
    try {
      const L = this.lib();
      const movie = await this.movieDetails(tmdbId);
      lap(`details for ${movie.title} (${movie.year})`);

      const vars = { title: L.safeFileName(movie.title), year: movie.year || '' };
      const noteFolder = this.resolveMovieFolder(quality);
      await this.ensureFolder(noteFolder);
      const noteName = L.safeFileName(L.fillTemplate(this.settings.noteNameTemplate, vars));
      const notePath = normalizePath(noteFolder ? `${noteFolder}/${noteName}.md` : `${noteName}.md`);

      const imageFolder = this.resolveImageFolder(noteFolder);
      await this.ensureFolder(imageFolder);
      const { posterFile, links, backdropLinks } = await this.fetchArt(
        { vars, imageFolder, notePath },
        movie.poster,
        movie.backdrops,
        this.settings.posterTemplate,
        this.settings.backdropTemplate
      );
      lap(`art: ${links.poster ? 'poster, ' : ''}${backdropLinks.length} backdrop(s)`);

      // Radarr is always asked what it already has -- a read-only lookup --
      // so a film it downloaded earlier gets its file link whatever the box
      // says. The box only decides whether a download is started.
      let known = null;
      if (this.radarrConfigured()) {
        try {
          await this.ensureRadarr();
          known = await this.radarrMovieByTmdb(tmdbId);
          if (known) this.log('Radarr already has it:', known.title, known.hasFile ? '(file done)' : '(no file yet)');
        } catch (e) {
          this.log('Radarr not answering, note written without it:', e.message);
        }
      }
      const willDownload = !!sendToRadarr && this.radarrConfigured();
      const radarr = !!known || willDownload;
      const qualityName = known ? await this.profileNameOf(known.qualityProfileId, quality) : quality;
      const fields = L.movieNoteFields(movie, links, {
        tags: this.settings.movieTags,
        quality: radarr ? qualityName : undefined,
        radarr,
      });
      const body = L.movieNoteBody(posterFile ? this.linkFor(posterFile, notePath, '') : '', backdropLinks);
      const file = await this.writeMovieNote(notePath, fields, body);
      lap(`note ${file.path}`);

      if (willDownload && !known) {
        try {
          known = await this.addToRadarr(tmdbId, quality);
        } catch (e) {
          this.log('Radarr step failed:', e.message);
          new Notice(`Note written, but Radarr said: ${e.message}`, 12000);
        }
      } else if (sendToRadarr && !this.radarrConfigured()) {
        this.log('Radarr not configured; note written without a download');
      }
      if (known && known.hasFile && known.movieFile && known.movieFile.path) {
        await this.markDownloaded(file, known.movieFile.path);
        this.subtitlesFor(file, known).catch((e) => this.log('subtitles failed:', e.message));
      }

      if (open) {
        new Notice(`${movie.title} (${movie.year}) added.`, 5000);
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
      return file;
    } finally {
      this.inFlight.delete(key);
    }
  }

  // A new note gets defaults, the plugin's fields and the backdrop wall. A note
  // that already exists keeps its body and every property it holds; only the
  // plugin's own fields are refreshed. Hand-edited values are never touched.
  async writeMovieNote(notePath, fields, body, order = this.settings.movieNoteOrder, defaultsRaw = this.settings.movieNoteDefaults) {
    const L = this.lib();
    const defaults = L.parseDefaults(defaultsRaw);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await this.app.fileManager.processFrontMatter(existing, (fm) => {
        for (const [k, v] of Object.entries(fields)) {
          if (v === undefined || v === null || v === '') continue;
          if (k === 'tags') {
            const had = [].concat(fm.tags ?? []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
            fm.tags = [...had, ...v.filter((t) => !had.includes(t))];
          } else if (k === 'dl-ed' && fm['dl-ed'] === true) {
            /* a note that already has its file stays downloaded */
          } else fm[k] = v;
        }
        L.addMissingDefaults(fm, defaults);
        L.applyOrder(fm, order, L.OWN_KEYS);
      });
      this.log('note existed, properties refreshed and body left alone:', notePath);
      return existing;
    }
    const fm = { ...defaults, ...fields };
    L.applyOrder(fm, order, L.OWN_KEYS);
    await this.app.vault.create(notePath, L.buildFrontmatter(fm) + (body ? '\n' + body : ''));
    const file = this.app.vault.getAbstractFileByPath(notePath);
    return file;
  }

  // Every film, series and season note with no `plot` gets TMDB's overview.
  // Nothing else in the note is touched, except that its properties are put
  // in the order setting's order. A note TMDB has no overview for is
  // left as it is and says so in the log.
  async addPlots() {
    const done = [];
    const empty = [];
    // With folders set in settings, only notes inside them: a film note copied
    // elsewhere to compare against, as the old CHAOS notes were, is not ours.
    const roots = [];
    if ((this.settings.movieLocationMode || 'specified') === 'specified') roots.push(this.resolveMovieFolder());
    if ((this.settings.seriesLocationMode || 'specified') === 'specified') roots.push(this.resolveSeriesFolder());
    const inRoots = (f) => roots.length < 2 || roots.some((r) => !r || f.path.startsWith(r + '/'));
    for (const file of this.app.vault.getMarkdownFiles().filter(inRoots)) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm || (fm.plot != null && String(fm.plot).trim())) continue;
      let plot = null;
      let order = null;
      // Only a note this plugin wrote: its own `URL` property, or a season
      // note linking one. A Media DB note carries the same TMDB link under
      // `url` or `tmdb`, and a copy kept for comparison must not be edited.
      const L = this.lib();
      const url = typeof fm.URL === 'string' ? fm.URL : '';
      const movieId = /themoviedb\.org\/movie\//.test(url) ? L.tmdbIdFromText(url) : null;
      const tvId = movieId ? null : L.tmdbTvIdFromText(url);
      const season = movieId || tvId || url ? null : this.seasonOf(file);
      try {
        if (movieId) {
          plot = (await this.movieDetails(movieId)).overview;
          order = this.settings.movieNoteOrder;
        } else if (tvId) {
          plot = (await this.seriesDetails(tvId)).overview;
          order = this.settings.seriesNoteOrder;
        } else if (season) {
          plot = (await this.seasonDetails(season.tmdbId, season.number)).overview;
          order = this.settings.seasonNoteOrder;
        } else continue;
      } catch (e) {
        this.log('plot: TMDB failed for', file.path, e.message);
        continue;
      }
      if (!plot) {
        empty.push(file.path);
        this.log('plot: TMDB has no overview, left alone:', file.path);
        continue;
      }
      await this.setFields(file, { plot }, order);
      done.push(file.path);
      this.log('plot added:', file.path);
    }
    new Notice(`ARCH Recreations: plot added to ${done.length} note(s)${empty.length ? `, ${empty.length} with none on TMDB` : ''}.`, 8000);
    return { done, empty };
  }

  async setFields(file, fields, order = this.settings.movieNoteOrder) {
    const L = this.lib();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(fields)) fm[k] = v;
      L.applyOrder(fm, order, L.OWN_KEYS);
    });
  }

  tmdbIdOf(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return null;
    const { tmdbIdFromText } = this.lib();
    for (const v of Object.values(fm)) {
      const id = typeof v === 'string' ? tmdbIdFromText(v) : null;
      if (id && /themoviedb\.org/.test(v)) return id;
    }
    return null;
  }

  tmdbTvIdOf(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm) return null;
    const { tmdbTvIdFromText } = this.lib();
    for (const v of Object.values(fm)) {
      const id = typeof v === 'string' ? tmdbTvIdFromText(v) : null;
      if (id) return id;
    }
    return null;
  }

  // A season note: its `season` number and the series note it links to.
  seasonOf(file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!fm || !Number.isFinite(Number(fm.season)) || !fm.series) return null;
    const m = String(fm.series).match(/\[\[([^\]|]+)/);
    if (!m) return null;
    const seriesFile = this.app.metadataCache.getFirstLinkpathDest(m[1].trim(), file.path);
    if (!(seriesFile instanceof TFile)) return null;
    const tmdbId = this.tmdbTvIdOf(seriesFile);
    if (!tmdbId) return null;
    return { number: Number(fm.season), seriesFile, tmdbId };
  }

  /* ---------------- adding a series ---------------- */

  openAddSeries() {
    if (!this.settings.tmdbApiKey) {
      new Notice('Put your TMDB API key in the ARCH Recreations settings first.', 8000);
      return;
    }
    new AddSeriesModal(this.app, this).open();
  }

  // The whole thing for one series: details, art, the series note, one note
  // per season with its own poster and episode list, then Sonarr for the
  // seasons chosen. `seasonNumbers` is null for notes only.
  async addSeries(tmdbId, quality, seasonNumbers, opts = {}) {
    const open = opts.open !== false;
    const key = `tv:${tmdbId}`;
    if (this.inFlight.has(key)) {
      new Notice('That series is already being added.');
      return;
    }
    this.inFlight.add(key);
    const t0 = Date.now();
    const lap = (label) => this.log(`${label}: ${Date.now() - t0}ms`);
    try {
      const L = this.lib();
      const series = await this.seriesDetails(tmdbId);
      lap(`details for ${series.title} (${series.year}), ${series.seasons.length} season(s)`);

      const vars = { title: L.safeFileName(series.title), year: series.year || '' };
      const noteFolder = this.resolveSeriesFolder(quality);
      await this.ensureFolder(noteFolder);
      const noteName = L.safeFileName(L.fillTemplate(this.settings.noteNameTemplate, vars));
      const notePath = normalizePath(noteFolder ? `${noteFolder}/${noteName}.md` : `${noteName}.md`);
      const imageFolder = this.resolveImageFolder(noteFolder);
      await this.ensureFolder(imageFolder);

      const { posterFile, links, backdropLinks } = await this.fetchArt(
        { vars, imageFolder, notePath },
        series.poster,
        series.backdrops,
        this.settings.posterTemplate,
        this.settings.backdropTemplate
      );
      lap(`art: ${links.poster ? 'poster, ' : ''}${backdropLinks.length} backdrop(s)`);

      // Sonarr is asked what it has before the notes are written, so a season
      // it already holds gets its episode links straight away.
      let known = null;
      const wantsSonarr = Array.isArray(seasonNumbers) && seasonNumbers.length > 0 && this.sonarrConfigured();
      if (this.sonarrConfigured()) {
        try {
          await this.ensureSonarr();
          known = await this.sonarrSeriesByTmdb(series.tmdbId, series.tvdbId);
          if (known) this.log('Sonarr already has it:', known.title);
        } catch (e) {
          this.log('Sonarr not answering, notes written without it:', e.message);
        }
      }
      const sonarr = !!known || wantsSonarr;
      const qualityName = known ? await this.sonarrProfileNameOf(known.qualityProfileId, quality) : quality;

      // Season notes first, so the series note can link them.
      const seriesLink = `[[${noteName}]]`;
      const seasonLinks = [];
      for (const sn of series.seasons) {
        const season = await this.seasonDetails(tmdbId, sn.number);
        const svars = { ...vars, n: sn.number, year: season.year || series.year || '' };
        const seasonName = L.safeFileName(L.fillTemplate(this.settings.seasonNoteNameTemplate, svars));
        const seasonPath = normalizePath(noteFolder ? `${noteFolder}/${seasonName}.md` : `${seasonName}.md`);
        const art = await this.fetchArt({ vars: svars, imageFolder, notePath: seasonPath }, season.poster, [], this.settings.seasonPosterTemplate, '');
        const chosen = sonarr && (!Array.isArray(seasonNumbers) || seasonNumbers.includes(sn.number));
        const fields = L.seasonNoteFields(season, seriesLink, art.links, {
          tags: this.settings.seasonTags,
          quality: chosen ? qualityName : undefined,
          sonarr: chosen,
        });
        fields.season = sn.number;
        const episodes = season.episodes.map((e) => ({ season: sn.number, ...e }));
        const files = known ? await this.episodeFiles(known.id, sn.number) : {};
        const body = L.seasonNoteBody(art.posterFile ? this.linkFor(art.posterFile, seasonPath, '') : '', episodes, files, (this.settings.player || '').trim());
        await this.writeSeasonNote(seasonPath, fields, body, episodes, files);
        seasonLinks.push(`[[${seasonName}]]`);
      }
      lap(`${seasonLinks.length} season note(s)`);

      const fields = L.seriesNoteFields(series, links, {
        tags: this.settings.seriesTags,
        quality: sonarr ? qualityName : undefined,
        sonarr,
        seasonLinks,
      });
      const body = L.seriesNoteBody(posterFile ? this.linkFor(posterFile, notePath, '') : '', backdropLinks);
      const file = await this.writeMovieNote(notePath, fields, body, this.settings.seriesNoteOrder, this.settings.seriesNoteDefaults);
      lap(`note ${file.path}`);

      if (wantsSonarr) {
        try {
          const target = known || (await this.addToSonarr(series, quality));
          const numbers = Array.isArray(seasonNumbers) ? seasonNumbers : series.seasons.map((x) => x.number);
          let current = target;
          for (const n of numbers) current = await this.downloadSeason(current, n);
        } catch (e) {
          this.log('Sonarr step failed:', e.message);
          new Notice(`Notes written, but Sonarr said: ${e.message}`, 12000);
        }
      } else if (Array.isArray(seasonNumbers) && seasonNumbers.length && !this.sonarrConfigured()) {
        this.log('Sonarr not configured; notes written without a download');
      }

      if (open) {
        new Notice(`${series.title} (${series.year}) added, ${seasonLinks.length} season(s).`, 5000);
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(file);
      }
      return file;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async sonarrProfileNameOf(profileId, fallback) {
    try {
      const p = (await this.sonarrProfiles()).find((x) => x.id === profileId);
      return p ? p.name : fallback;
    } catch (_) {
      return fallback;
    }
  }

  // A season note that exists keeps its properties and whatever is written
  // around the episode block; only the block itself is replaced.
  async writeSeasonNote(seasonPath, fields, body, episodes, files) {
    const L = this.lib();
    const existing = this.app.vault.getAbstractFileByPath(seasonPath);
    if (existing instanceof TFile) {
      await this.writeMovieNote(seasonPath, fields, '', this.settings.seasonNoteOrder, this.settings.seasonNoteDefaults);
      await this.app.vault.process(existing, (text) => {
        const m = text.match(/^---\n[\s\S]*?\n---\n?/);
        const fm = m ? m[0] : '';
        const rest = text.slice(fm.length);
        return fm + L.replaceEpisodeList(rest, episodes, files, (this.settings.player || '').trim());
      });
      return existing;
    }
    return this.writeMovieNote(seasonPath, fields, body, this.settings.seasonNoteOrder, this.settings.seasonNoteDefaults);
  }

  // Sonarr's files for one season, keyed "season:episode" -> path.
  async episodeFiles(seriesId, seasonNumber) {
    const eps = await this.sonarr('GET', `/episode?seriesId=${seriesId}&seasonNumber=${seasonNumber}&includeEpisodeFile=true`);
    const files = {};
    for (const e of eps) {
      if (e.hasFile && e.episodeFile && e.episodeFile.path) files[`${e.seasonNumber}:${e.episodeNumber}`] = e.episodeFile.path;
    }
    return files;
  }

  // "Download all seasons with Sonarr", on a series note.
  async downloadSeriesNote(file) {
    if (!this.sonarrConfigured()) {
      new Notice('Sonarr is not configured. Run "Detect Sonarr" first.');
      return;
    }
    const tmdbId = this.tmdbTvIdOf(file);
    const series = await this.seriesDetails(tmdbId);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const quality = String(fm.quality || this.settings.defaultQuality || '1080p');
    let target = await this.addToSonarr(series, quality);
    const qualityName = await this.sonarrProfileNameOf(target.qualityProfileId, quality);
    await this.setFields(file, { quality: qualityName, 'dl-ed': false }, this.settings.seriesNoteOrder);
    for (const sn of series.seasons) target = await this.downloadSeason(target, sn.number);
    new Notice(`${series.title}: ${series.seasons.length} season(s) sent to Sonarr as ${qualityName}. Run "Check Sonarr for finished downloads" later.`, 8000);
  }

  // "Download this season with Sonarr", on a season note.
  async downloadSeasonNote(file) {
    if (!this.sonarrConfigured()) {
      new Notice('Sonarr is not configured. Run "Detect Sonarr" first.');
      return;
    }
    const season = this.seasonOf(file);
    const series = await this.seriesDetails(season.tmdbId);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const quality = String(fm.quality || this.settings.defaultQuality || '1080p');
    const target = await this.addToSonarr(series, quality);
    const qualityName = await this.sonarrProfileNameOf(target.qualityProfileId, quality);
    await this.setFields(file, { quality: qualityName, 'dl-ed': false }, this.settings.seasonNoteOrder);
    await this.downloadSeason(target, season.number);
    new Notice(`${series.title} season ${season.number} sent to Sonarr as ${qualityName}. Run "Check Sonarr for finished downloads" later.`, 8000);
  }

  // "Check Sonarr for finished downloads": every season note not yet complete
  // gets its episode links refreshed from Sonarr's files, subtitles for each
  // new file, `dl-ed: true` once every aired episode has one; a series note
  // turns `dl-ed: true` when all its season notes have. A command and nothing
  // else, like the Radarr one.
  async checkSonarr(manual) {
    if (!this.sonarrConfigured()) {
      if (manual) new Notice('Sonarr is not configured.');
      return;
    }
    const seasonNotes = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && fm['dl-ed'] !== true && this.seasonOf(f);
    });
    if (!seasonNotes.length) {
      this.log('Sonarr check: every season note is complete');
      if (manual) new Notice('Every season note is already complete.');
      return;
    }
    let all;
    try {
      await this.ensureSonarr();
      all = await this.sonarr('GET', '/series');
    } catch (e) {
      this.log(`Sonarr check: not answering (${e.message}); ${seasonNotes.length} season note(s) still waiting`);
      if (manual) new Notice(`Sonarr is not answering: ${e.message}`, 8000);
      return;
    }
    const L = this.lib();
    let completed = 0;
    const touchedSeries = new Set();
    // Remembered here rather than read back: the metadata cache lags a write
    // by a moment, and the series check below runs in the same breath.
    const completeNow = new Set();
    for (const file of seasonNotes) {
      const season = this.seasonOf(file);
      const sonarrSeries = all.find((x) => x.tmdbId === season.tmdbId);
      if (!sonarrSeries) {
        this.log('no files, and Sonarr does not have the series:', file.path);
        continue;
      }
      const eps = await this.sonarr('GET', `/episode?seriesId=${sonarrSeries.id}&seasonNumber=${season.number}&includeEpisodeFile=true`);
      const files = {};
      for (const e of eps) if (e.hasFile && e.episodeFile && e.episodeFile.path) files[`${e.seasonNumber}:${e.episodeNumber}`] = e.episodeFile.path;
      const episodes = eps.map((e) => ({ season: e.seasonNumber, number: e.episodeNumber, title: e.title || `Episode ${e.episodeNumber}` }));
      await this.app.vault.process(file, (text) => {
        const m = text.match(/^---\n[\s\S]*?\n---\n?/);
        const fm = m ? m[0] : '';
        return fm + L.replaceEpisodeList(text.slice(fm.length), episodes, files, (this.settings.player || '').trim());
      });
      const have = Object.keys(files).length;
      const today = new Date().toISOString().slice(0, 10);
      const aired = eps.filter((e) => e.airDate && e.airDate <= today).length;
      this.log(`${file.basename}: ${have} of ${aired} aired episode(s) have a file`);
      for (const e of eps) {
        const p = files[`${e.seasonNumber}:${e.episodeNumber}`];
        if (p) await this.subtitlesForEpisode(p, sonarrSeries.imdbId, e.seasonNumber, e.episodeNumber, `${sonarrSeries.title} S${e.seasonNumber}E${e.episodeNumber}`).catch((err) => this.log('subtitles failed:', err.message));
      }
      if (aired > 0 && have >= aired) {
        await this.setFields(file, { 'dl-ed': true }, this.settings.seasonNoteOrder);
        completed++;
        completeNow.add(file.path);
        touchedSeries.add(season.seriesFile.path);
      }
    }
    // A series is done when every one of its season notes is.
    for (const seriesPath of touchedSeries) {
      const seriesFile = this.app.vault.getAbstractFileByPath(seriesPath);
      if (!(seriesFile instanceof TFile)) continue;
      const siblings = this.app.vault.getMarkdownFiles().filter((f) => {
        const so = this.seasonOf(f);
        return so && so.seriesFile.path === seriesPath;
      });
      const done = siblings.every((f) => completeNow.has(f.path) || this.app.metadataCache.getFileCache(f)?.frontmatter?.['dl-ed'] === true);
      if (done) {
        await this.setFields(seriesFile, { 'dl-ed': true }, this.settings.seriesNoteOrder);
        this.log('every season complete:', seriesFile.path);
      }
    }
    this.log(`Sonarr check: ${seasonNotes.length} season note(s) looked at, ${completed} now complete`);
    if (manual) new Notice(`${completed} of ${seasonNotes.length} season note(s) are now complete.`);
  }

  // "Import existing series from Sonarr": one series note plus one season note
  // per season for every series Sonarr already holds and that has no note yet,
  // carrying whatever episode files Sonarr already has. `seasonNumbers: null`
  // means notes only -- nothing new is sent to Sonarr, exactly like unticking
  // every season in "Add a series".
  async importExistingSeries(manual) {
    if (!this.sonarrConfigured()) {
      if (manual) new Notice('Sonarr is not configured.');
      return;
    }
    let series;
    try {
      await this.ensureSonarr();
      series = await this.sonarr('GET', '/series');
    } catch (e) {
      this.log('import series: Sonarr not answering:', e.message);
      if (manual) new Notice(`Sonarr is not answering: ${e.message}`, 8000);
      return;
    }
    const known = new Set(this.app.vault.getMarkdownFiles().map((f) => this.tmdbTvIdOf(f)).filter(Boolean));
    const missing = series.filter((s) => s.tmdbId && !known.has(s.tmdbId));
    if (!missing.length) {
      this.log('import series: every series in Sonarr already has a note');
      if (manual) new Notice('Every series in Sonarr already has a note.');
      return;
    }
    this.log(`import series: ${missing.length} series in Sonarr without a note`);
    let made = 0;
    for (const s of missing) {
      try {
        const quality = await this.sonarrProfileNameOf(s.qualityProfileId, this.settings.defaultQuality);
        await this.addSeries(s.tmdbId, quality, null, { open: false });
        made++;
      } catch (e) {
        this.log('import failed:', s.title, e.message);
      }
    }
    this.log(`import series: ${made} of ${missing.length} note(s) written`);
    if (manual) new Notice(`${made} of ${missing.length} series note(s) written.`, 8000);
  }

  /* ---------------- downloads ---------------- */

  async markDownloaded(file, moviePath) {
    const { fileLink } = this.lib();
    await this.setFields(file, { 'dl-ed': true, file: fileLink(moviePath, (this.settings.player || '').trim()) });
    this.log('downloaded:', file.path, '->', moviePath);
  }

  // The command "Check Radarr for finished downloads": every film note without
  // a file link, checked against Radarr's whole list in one request -- so a
  // note written before the film landed, or without Radarr at all, gets its
  // link. A command and nothing else: no timer, no run at startup. Something
  // that runs by itself cannot be watched, and so cannot be tested.
  async checkDownloads(manual) {
    if (!this.radarrConfigured()) {
      if (manual) new Notice('Radarr is not configured.');
      return;
    }
    const waiting = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && !fm.file && fm['dl-ed'] !== true && this.tmdbIdOf(f);
    });
    if (!waiting.length) {
      this.log('download check: every film note has its file');
      if (manual) new Notice('Every film note already has its file.');
      return;
    }
    let movies;
    try {
      await this.ensureRadarr();
      movies = await this.radarr('GET', '/movie');
    } catch (e) {
      this.log(`download check: Radarr not answering (${e.message}); ${waiting.length} note(s) still waiting`);
      if (manual) new Notice(`Radarr is not answering: ${e.message}`, 8000);
      return;
    }
    let byTmdb = new Map(movies.map((m) => [m.tmdbId, m]));

    // A file put in the library by hand is only known to Radarr after a
    // rescan, and only for a film Radarr has. So: register the ones it lacks
    // (unmonitored -- nothing is downloaded), rescan every film still without
    // a file, then read the list again.
    const rescan = [];
    for (const file of waiting) {
      const id = this.tmdbIdOf(file);
      let m = byTmdb.get(id);
      if (!m) {
        try {
          m = await this.registerInRadarr(id);
          byTmdb.set(id, m);
        } catch (e) {
          this.log('could not register in Radarr:', file.path, e.message);
          continue;
        }
      }
      if (!m.hasFile) rescan.push(m.id);
    }
    if (rescan.length) {
      this.log(`asking Radarr to rescan ${rescan.length} film folder(s) for files put there by hand`);
      await this.radarrCommand({ name: 'RescanMovie', movieIds: rescan }).catch((e) => this.log('rescan failed:', e.message));
      byTmdb = new Map((await this.radarr('GET', '/movie')).map((m) => [m.tmdbId, m]));
    }

    let landed = 0;
    for (const file of waiting) {
      const id = this.tmdbIdOf(file);
      const m = byTmdb.get(id);
      if (!m) continue;
      if (!m.hasFile || !m.movieFile || !m.movieFile.path) {
        this.log(m.monitored ? 'still downloading:' : 'no file yet, folder watched:', file.path);
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        // A note written without Radarr, for a film Radarr turns out to be
        // fetching: say so on the note rather than leave it looking untouched.
        if (m.monitored && fm['dl-ed'] === undefined) await this.setFields(file, { 'dl-ed': false });
        continue;
      }
      await this.markDownloaded(file, m.movieFile.path);
      landed++;
      await this.subtitlesFor(file, m).catch((e) => this.log('subtitles failed:', e.message));
    }
    this.log(`download check: ${waiting.length} without a file, ${landed} landed`);
    if (manual) new Notice(`${landed} of ${waiting.length} film note(s) without a file got one.`);
  }

  // "Import existing films from Radarr": one note for every film Radarr
  // already holds and that has no note yet, written the way "Add a film"
  // would with the box unticked -- Radarr is only ever asked what it already
  // has, so nothing new is downloaded. A film still fetching gets its note
  // without a file link; "Check Radarr for finished downloads" catches it up
  // once it lands.
  async importExistingMovies(manual) {
    if (!this.radarrConfigured()) {
      if (manual) new Notice('Radarr is not configured.');
      return;
    }
    let movies;
    try {
      await this.ensureRadarr();
      movies = await this.radarr('GET', '/movie');
    } catch (e) {
      this.log('import films: Radarr not answering:', e.message);
      if (manual) new Notice(`Radarr is not answering: ${e.message}`, 8000);
      return;
    }
    const known = new Set(this.app.vault.getMarkdownFiles().map((f) => this.tmdbIdOf(f)).filter(Boolean));
    const missing = movies.filter((m) => m.tmdbId && !known.has(m.tmdbId));
    if (!missing.length) {
      this.log('import films: every film in Radarr already has a note');
      if (manual) new Notice('Every film in Radarr already has a note.');
      return;
    }
    this.log(`import films: ${missing.length} film(s) in Radarr without a note`);
    let made = 0;
    for (const m of missing) {
      try {
        const quality = await this.profileNameOf(m.qualityProfileId, this.settings.defaultQuality);
        await this.addMovie(m.tmdbId, quality, false, { open: false });
        made++;
      } catch (e) {
        this.log('import failed:', m.title, e.message);
      }
    }
    this.log(`import films: ${made} of ${missing.length} note(s) written`);
    if (manual) new Notice(`${made} of ${missing.length} film note(s) written.`, 8000);
  }

  // "Import films from the library folder": for every folder shaped
  // "Title (Year)" directly under one of Radarr's library folders that
  // Radarr does not have yet -- a film dropped there by hand, from before
  // this plugin or from outside it entirely -- looks the title up on TMDB
  // and writes its note. Every root folder Radarr knows about is scanned, not
  // just the one in settings, so a root added for a specific purpose (a "4K"
  // folder, say) is picked up too; a root folder named "4K" gets its films
  // the "4K" quality (and so the "4K" vault subfolder) instead of the usual
  // default. "Check Radarr for finished downloads", run once at the end
  // here, is what registers the folder with Radarr and adds the file link,
  // exactly as it already does for a manually placed download.
  async importFilmsFromDisk(manual) {
    if (this.inFlight.has('import-films-from-disk')) {
      new Notice('Already importing films from the library folder.');
      return;
    }
    this.inFlight.add('import-films-from-disk');
    try {
      if (!this.radarrConfigured()) {
        if (manual) new Notice('Radarr is not configured.');
        return;
      }
      let movies, roots;
      try {
        await this.ensureRadarr();
        movies = await this.radarr('GET', '/movie');
        roots = await this.radarr('GET', '/rootfolder');
      } catch (e) {
        this.log('import from disk: Radarr not answering:', e.message);
        if (manual) new Notice(`Radarr is not answering: ${e.message}`, 8000);
        return;
      }
      if (this.settings.radarrRootFolder && !roots.some((r) => path.normalize(r.path) === path.normalize(this.settings.radarrRootFolder))) {
        roots = [{ path: this.settings.radarrRootFolder }, ...roots];
      }
      const byTmdb = new Map(movies.map((m) => [m.tmdbId, m]));
      const knownPaths = new Set(movies.map((m) => path.normalize(m.path)));
      const knownNotes = new Set(this.app.vault.getMarkdownFiles().map((f) => this.tmdbIdOf(f)).filter(Boolean));
      let made = 0;
      const skipped = [];
      for (const r of roots) {
        const root = r.path;
        if (!root || !fs.existsSync(root)) {
          this.log('import from disk: library folder not reachable:', root || '(none set)');
          continue;
        }
        const quality = path.basename(root).toLowerCase() === '4k' ? '4K' : this.settings.defaultQuality;
        const entries = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.'));
        for (const d of entries) {
          const full = path.normalize(path.join(root, d.name));
          if (knownPaths.has(full)) continue;
          const m = d.name.match(/^(.+?)\s*\((\d{4})\)$/);
          if (!m) {
            this.log('import from disk: not a "Title (Year)" folder, skipped:', d.name);
            skipped.push(d.name);
            continue;
          }
          const [, title, year] = m;
          try {
            const results = await this.searchMovies(title);
            const hit = results.find((r2) => r2.year === year) || results[0];
            if (!hit) {
              this.log('import from disk: no TMDB match, skipped:', d.name);
              skipped.push(d.name);
              continue;
            }
            if (knownNotes.has(hit.tmdbId)) continue;
            // Radarr only ever holds one entry per film, so a folder that
            // turns out to be a second copy of a film Radarr already has
            // under a different root (a 4K rip of something already tracked
            // at 1080p, say) can't be registered here -- doing so would
            // silently take over the existing entry's file and quality.
            // Left for a person to write that note by hand instead.
            if (byTmdb.has(hit.tmdbId)) {
              this.log('import from disk: already in Radarr as a different copy, skipped:', d.name);
              skipped.push(d.name);
              continue;
            }
            // Radarr's own naming format would sanitise the title
            // differently than however this folder actually got named (a
            // colon in the title becoming " -", say), so the folder is
            // pinned explicitly rather than left for Radarr to guess --
            // otherwise the rescan below looks in a folder that doesn't
            // exist and never finds the file.
            const registered = await this.registerInRadarr(hit.tmdbId, full, quality);
            byTmdb.set(hit.tmdbId, registered);
            await this.addMovie(hit.tmdbId, quality, false, { open: false });
            knownNotes.add(hit.tmdbId);
            made++;
          } catch (e) {
            this.log('import from disk failed:', d.name, e.message);
            skipped.push(d.name);
          }
        }
      }
      if (made) await this.checkDownloads(false);
      this.log(`import from disk: ${made} note(s) written${skipped.length ? `, skipped: ${skipped.join(', ')}` : ''}`);
      if (manual) {
        new Notice(
          `${made} film note(s) written.${skipped.length ? ` ${skipped.length} folder(s) skipped -- see the console.` : ''}`,
          8000
        );
      }
    } finally {
      this.inFlight.delete('import-films-from-disk');
    }
  }

  // The command "Download this film with Radarr", for a note made without
  // Radarr -- or with it unticked -- that is wanted after all. The note's own
  // `quality` decides the profile; the default when it has none.
  async downloadNote(file) {
    if (!this.radarrConfigured()) {
      new Notice('Radarr is not configured. Run "Detect Radarr" first.');
      return;
    }
    const tmdbId = this.tmdbIdOf(file);
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const quality = String(fm.quality || this.settings.defaultQuality || '1080p');
    const r = await this.addToRadarr(tmdbId, quality);
    const qualityName = await this.profileNameOf(r.qualityProfileId, quality);
    if (r.hasFile && r.movieFile && r.movieFile.path) {
      await this.setFields(file, { quality: qualityName });
      await this.markDownloaded(file, r.movieFile.path);
      new Notice(`${r.title}: Radarr already has the file. Link written.`, 6000);
      this.subtitlesFor(file, r).catch((e) => this.log('subtitles failed:', e.message));
      return;
    }
    await this.setFields(file, { quality: qualityName, 'dl-ed': false });
    // A film Radarr already had without a file: nothing was added, so nothing
    // searched. Search now -- this is how a hand-off that failed because
    // Transmission was not running is retried.
    if (!r.monitored || !(r.addOptions && r.addOptions.searchForMovie)) {
      if (!r.monitored) await this.radarr('PUT', `/movie/${r.id}`, { ...r, monitored: true });
      const inQueue = (await this.radarr('GET', '/queue')).records.some((q) => q.movieId === r.id);
      if (inQueue) {
        this.log('already in Radarr\'s queue, not searched again:', r.title);
      } else {
        await this.searchAndGrab(r.id, r.title);
      }
    }
    new Notice(`${r.title} sent to Radarr as ${qualityName}. Run "Check Radarr for finished downloads" later.`, 8000);
  }

  /* ---------------- subtitles ---------------- */

  async subtitlesForNote(file) {
    const id = this.tmdbIdOf(file);
    await this.ensureRadarr();
    const m = await this.radarrMovieByTmdb(id);
    if (!m || !m.hasFile || !m.movieFile) {
      new Notice('Radarr has no file for this film yet.');
      return;
    }
    const got = await this.subtitlesFor(file, m);
    new Notice(got ? `Subtitles saved: ${path.basename(got)}` : 'No subtitles were saved. See the console.', 6000);
  }

  // Three requests: search by IMDb id and file hash, ask for a link, save the
  // .srt beside the film. Skipped when it is already there, and put off when
  // the drive holding the film is not plugged in.
  async subtitlesFor(file, radarrMovie) {
    const imdb = String(radarrMovie.imdbId || '').replace(/^tt/, '');
    const query = imdb ? { imdb_id: imdb } : { tmdb_id: String(radarrMovie.tmdbId) };
    return this.subtitleForFile(radarrMovie.movieFile.path, query, radarrMovie.title);
  }

  // An episode is found by the series' IMDb id plus season and episode
  // number -- OpenSubtitles calls the series id `parent_imdb_id`.
  async subtitlesForEpisode(path_, seriesImdbId, season, episode, label) {
    const imdb = String(seriesImdbId || '').replace(/^tt/, '');
    if (!imdb) {
      this.log('subtitles skipped, no IMDb id for the series:', label);
      return '';
    }
    return this.subtitleForFile(path_, { parent_imdb_id: imdb, season_number: String(season), episode_number: String(episode) }, label);
  }

  async subtitleForFile(moviePath, query, label) {
    const L = this.lib();
    const lang = (this.settings.subtitleLanguage || 'en').trim();
    if (!this.settings.openSubtitlesApiKey) {
      this.log('subtitles skipped, no OpenSubtitles key');
      return '';
    }
    const target = L.subtitlePath(moviePath, lang);
    if (fs.existsSync(target)) {
      this.log('subtitles already there:', target);
      return target;
    }
    if (!fs.existsSync(moviePath)) {
      this.log('subtitles put off, the file is not reachable (drive unplugged?):', moviePath);
      return '';
    }
    const params = { ...query, languages: lang, moviehash: L.openSubtitlesHash(moviePath), order_by: 'download_count', order_direction: 'desc' };
    const found = await this.openSubtitles('GET', '/subtitles', params);
    const pick = L.pickSubtitle(found.data);
    if (!pick) {
      this.log(`no ${lang} subtitles on OpenSubtitles for`, label);
      return '';
    }
    this.log(`subtitle chosen: ${pick.release} (hash match ${pick.hashMatch}, HI ${pick.hearingImpaired}, ${pick.downloads} downloads)`);
    const dl = await this.openSubtitles('POST', '/download', null, { file_id: pick.fileId });
    if (!dl.link) throw new Error(`OpenSubtitles gave no link: ${dl.message || 'unknown reason'}`);
    const res = await requestUrl({ url: dl.link, throw: false });
    if (res.status !== 200 || !res.arrayBuffer) throw new Error(`HTTP ${res.status} fetching the subtitle file`);
    fs.writeFileSync(target, Buffer.from(res.arrayBuffer));
    this.log(`subtitles saved: ${target} (${dl.remaining} downloads left today)`);
    return target;
  }
}

/* ---------------- add-film modal ---------------- */

class AddMovieModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.results = [];
    this.profiles = null;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('arch-recreations-add');
    contentEl.createEl('h3', { text: 'Add a film' });

    const row = contentEl.createDiv({ cls: 'arch-recreations-row' });
    const input = row.createEl('input', { type: 'text', placeholder: 'Title, e.g. Alien' });
    input.style.flex = '1';
    const searchBtn = row.createEl('button', { text: 'Search' });

    const options = contentEl.createDiv({ cls: 'arch-recreations-row' });
    options.style.marginTop = '8px';
    const radarrOn = this.plugin.radarrConfigured();
    const send = options.createEl('label');
    const sendBox = send.createEl('input', { type: 'checkbox' });
    sendBox.checked = radarrOn;
    sendBox.disabled = !radarrOn;
    send.appendText(radarrOn ? ' Send to Radarr as ' : ' Radarr not configured — note and art only');
    const quality = send.createEl('select');
    quality.disabled = !radarrOn;
    const fill = (names) => {
      quality.empty();
      for (const n of names) quality.createEl('option', { text: n, value: n });
      quality.value = names.includes(this.plugin.settings.defaultQuality) ? this.plugin.settings.defaultQuality : names[0] || '';
    };
    fill([this.plugin.settings.defaultQuality || '1080p']);
    if (radarrOn) {
      this.plugin
        .radarrProfiles()
        .then((p) => fill(p.map((x) => x.name)))
        .catch((e) => this.plugin.log('could not list Radarr profiles:', e.message));
    }

    const list = contentEl.createDiv({ cls: 'arch-recreations-results' });
    list.style.marginTop = '10px';
    list.style.maxHeight = '50vh';
    list.style.overflowY = 'auto';

    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      list.empty();
      list.createDiv({ text: 'Searching…' });
      try {
        this.results = await this.plugin.searchMovies(q);
      } catch (e) {
        list.empty();
        list.createDiv({ text: e.message });
        return;
      }
      list.empty();
      if (!this.results.length) {
        list.createDiv({ text: 'Nothing found.' });
        return;
      }
      for (const r of this.results) {
        const item = list.createDiv({ cls: 'arch-recreations-result' });
        item.style.padding = '6px 8px';
        item.style.cursor = 'pointer';
        item.style.borderBottom = '1px solid var(--background-modifier-border)';
        item.createEl('strong', { text: `${r.title}${r.year ? ` (${r.year})` : ''}` });
        if (r.overview) {
          const p = item.createDiv({ text: r.overview.length > 160 ? r.overview.slice(0, 157) + '…' : r.overview });
          p.style.fontSize = '0.85em';
          p.style.opacity = '0.8';
        }
        item.addEventListener('click', () => {
          this.close();
          this.plugin.addMovie(r.tmdbId, quality.value, sendBox.checked).catch((e) => this.plugin.fail(e));
        });
      }
    };
    searchBtn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    input.focus();
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------------- add-series modal ---------------- */

// Search, pick, then choose: which seasons to download (all ticked by
// default), or none for notes and art only.
class AddSeriesModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Add a series' });
    const row = contentEl.createDiv();
    row.style.display = 'flex';
    row.style.gap = '6px';
    const input = row.createEl('input', { type: 'text', placeholder: 'Title, e.g. Scavengers Reign' });
    input.style.flex = '1';
    const searchBtn = row.createEl('button', { text: 'Search' });
    const list = contentEl.createDiv();
    list.style.marginTop = '10px';
    list.style.maxHeight = '50vh';
    list.style.overflowY = 'auto';

    const run = async () => {
      const q = input.value.trim();
      if (!q) return;
      list.empty();
      list.createDiv({ text: 'Searching\u2026' });
      let results;
      try {
        results = await this.plugin.searchSeries(q);
      } catch (e) {
        list.empty();
        list.createDiv({ text: e.message });
        return;
      }
      list.empty();
      if (!results.length) {
        list.createDiv({ text: 'Nothing found.' });
        return;
      }
      for (const r of results) {
        const item = list.createDiv();
        item.style.padding = '6px 8px';
        item.style.cursor = 'pointer';
        item.style.borderBottom = '1px solid var(--background-modifier-border)';
        item.createEl('strong', { text: `${r.title}${r.year ? ` (${r.year})` : ''}` });
        if (r.overview) {
          const p = item.createDiv({ text: r.overview.length > 160 ? r.overview.slice(0, 157) + '\u2026' : r.overview });
          p.style.fontSize = '0.85em';
          p.style.opacity = '0.8';
        }
        item.addEventListener('click', () => this.chooseSeasons(r));
      }
    };
    searchBtn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    });
    input.focus();
  }

  async chooseSeasons(r) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: `${r.title}${r.year ? ` (${r.year})` : ''}` });
    const info = contentEl.createDiv({ text: 'Loading seasons\u2026' });
    let series;
    try {
      series = await this.plugin.seriesDetails(r.tmdbId);
    } catch (e) {
      info.setText(e.message);
      return;
    }
    info.remove();

    const sonarrOn = this.plugin.sonarrConfigured();
    const top = contentEl.createDiv();
    top.style.marginBottom = '8px';
    const dl = top.createEl('label');
    const dlBox = dl.createEl('input', { type: 'checkbox' });
    dlBox.checked = sonarrOn;
    dlBox.disabled = !sonarrOn;
    dl.appendText(sonarrOn ? ' Download with Sonarr as ' : ' Sonarr not configured \u2014 notes and art only');
    const quality = dl.createEl('select');
    quality.disabled = !sonarrOn;
    const fill = (names) => {
      quality.empty();
      for (const n of names) quality.createEl('option', { text: n, value: n });
      quality.value = names.includes(this.plugin.settings.defaultQuality) ? this.plugin.settings.defaultQuality : names[0] || '';
    };
    fill([this.plugin.settings.defaultQuality || '1080p']);
    if (sonarrOn) this.plugin.sonarrProfiles().then((p) => fill(p.map((x) => x.name))).catch(() => {});

    const seasonsEl = contentEl.createDiv();
    seasonsEl.style.margin = '8px 0';
    const boxes = [];
    const allRow = seasonsEl.createEl('label');
    allRow.style.display = 'block';
    const allBox = allRow.createEl('input', { type: 'checkbox' });
    allBox.checked = true;
    allRow.appendText(' All seasons');
    for (const sn of series.seasons) {
      const row = seasonsEl.createEl('label');
      row.style.display = 'block';
      row.style.marginLeft = '18px';
      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = true;
      row.appendText(` Season ${sn.number}${sn.year ? ` (${sn.year})` : ''} \u2014 ${sn.episodeCount} episode(s)`);
      boxes.push({ box, number: sn.number });
      box.addEventListener('change', () => {
        allBox.checked = boxes.every((b) => b.box.checked);
      });
    }
    allBox.addEventListener('change', () => {
      for (const b of boxes) b.box.checked = allBox.checked;
    });
    const sync = () => {
      const on = dlBox.checked;
      allBox.disabled = !on;
      for (const b of boxes) b.box.disabled = !on;
    };
    dlBox.addEventListener('change', sync);
    sync();

    const actions = contentEl.createDiv();
    actions.style.marginTop = '10px';
    const add = actions.createEl('button', { text: 'Add' });
    add.addEventListener('click', () => {
      const chosen = dlBox.checked ? boxes.filter((b) => b.box.checked).map((b) => b.number) : null;
      this.close();
      this.plugin.addSeries(r.tmdbId, quality.value, chosen).catch((e) => this.plugin.fail(e));
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------------- settings ---------------- */

class RecreationsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async save() {
    await this.plugin.saveSettings();
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    containerEl.createEl('h3', { text: 'Keys' });
    new Setting(containerEl)
      .setName('TMDB API key')
      .setDesc('Free, from themoviedb.org → Settings → API. Everything about a film comes from here.')
      .addText((t) =>
        t.setValue(s.tmdbApiKey).onChange(async (v) => {
          s.tmdbApiKey = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('OpenSubtitles API key')
      .setDesc('From opensubtitles.com → Profile → API consumers, with "Under dev" ticked so the key alone allows 100 downloads a day. Leave empty to skip subtitles.')
      .addText((t) =>
        t.setValue(s.openSubtitlesApiKey).onChange(async (v) => {
          s.openSubtitlesApiKey = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Subtitle language')
      .setDesc('Two-letter code. The file is saved beside the film as <film>.<code>.srt.')
      .addText((t) =>
        t.setValue(s.subtitleLanguage).onChange(async (v) => {
          s.subtitleLanguage = v.trim() || 'en';
          await this.save();
        })
      );

    containerEl.createEl('h3', { text: 'Radarr' });
    new Setting(containerEl)
      .setName('Detect Radarr')
      .setDesc('Reads the address and API key from Radarr\'s own config file and asks it for the library folder and quality profiles.')
      .addButton((b) => b.setButtonText('Detect').onClick(async () => {
        await this.plugin.detectRadarr(true);
        this.display();
      }));
    new Setting(containerEl)
      .setName('Radarr address')
      .addText((t) =>
        t.setPlaceholder('http://localhost:7878').setValue(s.radarrUrl).onChange(async (v) => {
          s.radarrUrl = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Radarr API key')
      .addText((t) =>
        t.setValue(s.radarrApiKey).onChange(async (v) => {
          s.radarrApiKey = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Radarr library folder')
      .setDesc('Where Radarr puts finished films. Filled in by detection from Radarr\'s first root folder.')
      .addText((t) =>
        t.setValue(s.radarrRootFolder).onChange(async (v) => {
          s.radarrRootFolder = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Seeder floors, highest first')
      .setDesc('Comma-separated. Radarr\'s live search runs once; the highest floor with any release clears it wins, and the most-seeded release at that floor is grabbed. Radarr\'s own per-indexer minimum seeders still applies underneath, as a hard cutoff.')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.seederTiers).setValue(s.seederTiers).onChange(async (v) => {
          s.seederTiers = v.trim() || DEFAULT_SETTINGS.seederTiers;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('4K: enough seeders')
      .setDesc('At the "4K" quality profile, the smallest release with at least this many seeders is grabbed, and a season takes a whole-season pack whenever one exists. Below this, the seeder floors decide. Left out of 4K entirely: AV1, remuxes, and Dolby Vision with no HDR layer.')
      .addText((t) =>
        t.setPlaceholder(String(DEFAULT_SETTINGS.fourKEnoughSeeders)).setValue(String(s.fourKEnoughSeeders)).onChange(async (v) => {
          const n = Number(v);
          s.fourKEnoughSeeders = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SETTINGS.fourKEnoughSeeders;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Default quality')
      .setDesc('The Radarr quality profile pre-selected when adding a film; it is written to the note as `quality`.')
      .addText((t) =>
        t.setValue(s.defaultQuality).onChange(async (v) => {
          s.defaultQuality = v.trim() || '1080p';
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Open films in')
      .setDesc('The app the note\'s file link opens the film in, e.g. VLC. Only that link is affected; double-clicking an .mp4 anywhere else still uses the system default. Empty for the system default.')
      .addText((t) =>
        t.setPlaceholder('VLC').setValue(s.player).onChange(async (v) => {
          s.player = v.trim();
          await this.save();
        })
      );

    containerEl.createEl('h3', { text: 'Sonarr' });
    new Setting(containerEl)
      .setName('Detect Sonarr')
      .setDesc('Reads the address and API key from Sonarr\'s own config file and asks it for the library folder and quality profiles.')
      .addButton((b) => b.setButtonText('Detect').onClick(async () => {
        await this.plugin.detectSonarr(true);
        this.display();
      }));
    new Setting(containerEl).setName('Sonarr address').addText((t) =>
      t.setPlaceholder('http://localhost:8989').setValue(s.sonarrUrl).onChange(async (v) => {
        s.sonarrUrl = v.trim();
        await this.save();
      })
    );
    new Setting(containerEl).setName('Sonarr API key').addText((t) =>
      t.setValue(s.sonarrApiKey).onChange(async (v) => {
        s.sonarrApiKey = v.trim();
        await this.save();
      })
    );
    new Setting(containerEl)
      .setName('Sonarr library folder')
      .setDesc('Where Sonarr puts finished episodes, one folder per series with a folder per season.')
      .addText((t) =>
        t.setValue(s.sonarrRootFolder).onChange(async (v) => {
          s.sonarrRootFolder = v.trim();
          await this.save();
        })
      );

    containerEl.createEl('h3', { text: 'Where things go' });
    new Setting(containerEl)
      .setName('Film note location')
      .setDesc('Same folder and subfolder are relative to the note that is open when you add a film.')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('same', 'Same folder as the open note')
          .addOption('subfolder', 'In subfolder under the open note')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.movieLocationMode || 'specified')
          .onChange(async (v) => {
            s.movieLocationMode = v;
            await this.save();
            this.display();
          })
      );
    if ((s.movieLocationMode || 'specified') === 'subfolder') {
      new Setting(containerEl).setName('Film note subfolder name').addText((t) =>
        t.setValue(s.movieSubfolder).onChange(async (v) => {
          s.movieSubfolder = v.trim() || 'Movies';
          await this.save();
        })
      );
    }
    if ((s.movieLocationMode || 'specified') === 'specified') {
      new Setting(containerEl)
        .setName('Film note folder')
        .setDesc('Path from the vault root.')
        .addText((t) =>
          t.setValue(s.movieFolder).onChange(async (v) => {
            s.movieFolder = v.trim();
            await this.save();
          })
        );
    }
    new Setting(containerEl)
      .setName('Series note location')
      .setDesc('Series notes and their season notes go together. Same folder and subfolder are relative to the note that is open when you add a series.')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('same', 'Same folder as the open note')
          .addOption('subfolder', 'In subfolder under the open note')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.seriesLocationMode || 'specified')
          .onChange(async (v) => {
            s.seriesLocationMode = v;
            await this.save();
            this.display();
          })
      );
    if ((s.seriesLocationMode || 'specified') === 'subfolder') {
      new Setting(containerEl).setName('Series note subfolder name').addText((t) =>
        t.setValue(s.seriesSubfolder).onChange(async (v) => {
          s.seriesSubfolder = v.trim() || 'Series';
          await this.save();
        })
      );
    }
    if ((s.seriesLocationMode || 'specified') === 'specified') {
      new Setting(containerEl)
        .setName('Series note folder')
        .setDesc('Path from the vault root.')
        .addText((t) =>
          t.setValue(s.seriesFolder).onChange(async (v) => {
            s.seriesFolder = v.trim();
            await this.save();
          })
        );
    }
    new Setting(containerEl)
      .setName('Art location')
      .setDesc('Where the poster and backdrops go. Same folder and subfolder are relative to the film note.')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('same', 'Same folder as the note')
          .addOption('subfolder', 'In subfolder under the note')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.imageLocationMode || 'subfolder')
          .onChange(async (v) => {
            s.imageLocationMode = v;
            await this.save();
            this.display();
          })
      );
    if ((s.imageLocationMode || 'subfolder') === 'subfolder') {
      new Setting(containerEl).setName('Art subfolder name').addText((t) =>
        t.setValue(s.imageSubfolder).onChange(async (v) => {
          s.imageSubfolder = v.trim() || 'Images';
          await this.save();
        })
      );
    }
    if (s.imageLocationMode === 'specified') {
      new Setting(containerEl)
        .setName('Art folder')
        .setDesc('Path from the vault root.')
        .addText((t) =>
          t.setValue(s.imageFolder).onChange(async (v) => {
            s.imageFolder = v.trim();
            await this.save();
          })
        );
    }

    containerEl.createEl('h3', { text: 'The note' });
    new Setting(containerEl)
      .setName('Note name')
      .setDesc('Placeholders: {{title}}, {{year}}.')
      .addText((t) =>
        t.setValue(s.noteNameTemplate).onChange(async (v) => {
          s.noteNameTemplate = v.trim() || DEFAULT_SETTINGS.noteNameTemplate;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Poster and backdrop file names')
      .setDesc('Placeholders: {{title}}, {{year}}, and {{n}} for the backdrop number (01, 02, …). Saved as WebP. The banner property links the first backdrop.')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.posterTemplate).setValue(s.posterTemplate).onChange(async (v) => {
          s.posterTemplate = v.trim() || DEFAULT_SETTINGS.posterTemplate;
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.backdropTemplate).setValue(s.backdropTemplate).onChange(async (v) => {
          s.backdropTemplate = v.trim() || DEFAULT_SETTINGS.backdropTemplate;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Labels on the poster and banner links')
      .setDesc('Written as [[file|Label]], so the properties panel shows the label instead of the file name.')
      .addText((t) =>
        t.setPlaceholder('Poster').setValue(s.posterLabel).onChange(async (v) => {
          s.posterLabel = v.trim();
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder('Banner').setValue(s.bannerLabel).onChange(async (v) => {
          s.bannerLabel = v.trim();
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Backdrops per film')
      .setDesc('TMDB\'s backdrops, most voted first — key art and frames from the film — embedded in the note body as a wall. The first one is also the banner.')
      .addText((t) =>
        t.setValue(String(s.backdropsCount)).onChange(async (v) => {
          s.backdropsCount = Math.max(1, Math.floor(Number(v) || 1));
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Actors listed')
      .setDesc('How many of the cast, in billing order.')
      .addText((t) =>
        t.setValue(String(s.actorsCount)).onChange(async (v) => {
          s.actorsCount = Math.max(0, Math.floor(Number(v) || 0));
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Genre names')
      .setDesc('"TMDB name = your name", one per line. TMDB says Science Fiction where these notes say Sci-Fi.')
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setValue(s.genreMap).onChange(async (v) => {
          s.genreMap = v;
          await this.save();
        });
      });
    new Setting(containerEl)
      .setName('Tags')
      .setDesc('Comma-separated, put on every film note.')
      .addText((t) =>
        t.setValue((s.movieTags || []).join(', ')).onChange(async (v) => {
          s.movieTags = this.plugin.lib().splitList(v);
          await this.save();
        })
      );
    containerEl.createEl('h3', { text: 'Series and season notes' });
    new Setting(containerEl)
      .setName('Season note and poster names')
      .setDesc('Placeholders: {{title}}, {{year}} (the season\'s first-aired year), {{n}} the season number. The series note itself uses the film note name.')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.seasonNoteNameTemplate).setValue(s.seasonNoteNameTemplate).onChange(async (v) => {
          s.seasonNoteNameTemplate = v.trim() || DEFAULT_SETTINGS.seasonNoteNameTemplate;
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.seasonPosterTemplate).setValue(s.seasonPosterTemplate).onChange(async (v) => {
          s.seasonPosterTemplate = v.trim() || DEFAULT_SETTINGS.seasonPosterTemplate;
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Series and season tags')
      .setDesc('Comma-separated, one box each. A nested tag such as series/season keeps seasons under series in tag searches.')
      .addText((t) =>
        t.setPlaceholder('series').setValue((s.seriesTags || []).join(', ')).onChange(async (v) => {
          s.seriesTags = this.plugin.lib().splitList(v);
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder('series/season').setValue((s.seasonTags || []).join(', ')).onChange(async (v) => {
          s.seasonTags = this.plugin.lib().splitList(v);
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Series note property order')
      .setDesc('Same rule as the film order: listed properties are written in this order, an own one left out is not written, hand-added ones are kept.')
      .addTextArea((t) => {
        t.inputEl.rows = 2;
        t.inputEl.style.width = '100%';
        t.setValue(s.seriesNoteOrder).onChange(async (v) => {
          s.seriesNoteOrder = v;
          await this.save();
        });
      });
    new Setting(containerEl).setName('Season note property order').addTextArea((t) => {
      t.inputEl.rows = 2;
      t.inputEl.style.width = '100%';
      t.setValue(s.seasonNoteOrder).onChange(async (v) => {
        s.seasonNoteOrder = v;
        await this.save();
      });
    });
    new Setting(containerEl)
      .setName('Series and season default properties')
      .setDesc('"key: value" per line, one box each. Written on every new note; a value already on a note is never changed.')
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setValue(s.seriesNoteDefaults).onChange(async (v) => {
          s.seriesNoteDefaults = v;
          await this.save();
        });
      })
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.setValue(s.seasonNoteDefaults).onChange(async (v) => {
          s.seasonNoteDefaults = v;
          await this.save();
        });
      });

    containerEl.createEl('h3', { text: 'Film notes' });
    new Setting(containerEl)
      .setName('Property order')
      .setDesc('Comma-separated. Listed properties are written in this order; one of the plugin\'s own left out is not written at all. Anything you add to a note by hand is always kept.')
      .addTextArea((t) => {
        t.inputEl.rows = 3;
        t.inputEl.style.width = '100%';
        t.setValue(s.movieNoteOrder).onChange(async (v) => {
          s.movieNoteOrder = v;
          await this.save();
        });
      });
    new Setting(containerEl)
      .setName('Default properties')
      .setDesc('"key: value" per line, written on every new note so the property exists to be edited. A value already on a note is never changed.')
      .addTextArea((t) => {
        t.inputEl.rows = 4;
        t.setValue(s.movieNoteDefaults).onChange(async (v) => {
          s.movieNoteDefaults = v;
          await this.save();
        });
      });
  }
}

module.exports = ArchRecreationsPlugin;
