'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath, requestUrl } = require('obsidian');
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
  defaultQuality: '1080p',
  checkMinutes: 10,

  // where film notes go. 'same' and 'subfolder' are relative to the note that
  // is open when the film is added.
  movieLocationMode: 'specified', // vault | same | subfolder | specified
  movieSubfolder: 'Movies',
  movieFolder: 'Movies',
  // where the art goes, relative to the film note.
  imageLocationMode: 'subfolder', // vault | same | subfolder | specified
  imageSubfolder: 'Images',
  imageFolder: '',

  // the note
  noteNameTemplate: '{{title}} ({{year}})',
  posterTemplate: '{{title}} ({{year}})',
  bannerTemplate: '{{title}} ({{year}}) Banner',
  stillTemplate: '{{title}} ({{year}}) Still {{n}}',
  posterLabel: 'Poster',
  bannerLabel: 'Banner',
  stillsCount: 5,
  actorsCount: 5,
  genreMap: 'Science Fiction = Sci-Fi',
  movieTags: ['movie'],
  // Listed keys are written in this order; an own key left out is not
  // written; a key a person added by hand is always kept.
  movieNoteOrder: 'watched, rank, banner-p, duration, year, URL, poster, banner, genres, director, writer, actors, quality, dl-ed, file, tags',
  // "key: value" per line, written on every new note so the property exists to
  // be edited. A value already on a note is never changed.
  movieNoteDefaults: 'watched: false\nrank: 5\nbanner-p: 50',

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
    this.addCommand({
      id: 'check-downloads',
      name: 'Check Radarr for finished downloads',
      callback: () => this.checkDownloads(true),
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
    this.addCommand({ id: 'detect-radarr', name: 'Detect Radarr', callback: () => this.detectRadarr(true) });

    this.app.workspace.onLayoutReady(async () => {
      if (!this.settings.setupDone) {
        await this.detectRadarr(false);
        this.settings.setupDone = true;
        await this.saveSettings();
      }
      // Radarr keeps working while Obsidian is closed, so the first thing to do
      // on opening is ask what finished meanwhile.
      this.checkDownloads(false).catch((e) => this.log('download check failed:', e.message));
      const every = Math.max(1, Number(this.settings.checkMinutes) || 10) * 60 * 1000;
      this.registerInterval(
        window.setInterval(() => this.checkDownloads(false).catch((e) => this.log('download check failed:', e.message)), every)
      );
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
      dir = path.join(this.pluginDir(), 'lib');
    } catch (_) {
      return;
    }
    for (const key of Object.keys(require.cache || {})) {
      if (key.startsWith(dir)) delete require.cache[key];
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
      stills: Number(this.settings.stillsCount) || 0,
      actors: Number(this.settings.actorsCount) || 5,
      genreMap: parseRenameMap(this.settings.genreMap),
    });
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

  async radarrProfiles() {
    return (await this.radarr('GET', '/qualityprofile')).map((p) => ({ id: p.id, name: p.name }));
  }

  async radarrMovieByTmdb(tmdbId) {
    const list = await this.radarr('GET', `/movie?tmdbId=${tmdbId}`);
    return Array.isArray(list) && list.length ? list[0] : null;
  }

  // Adds the film and starts the search in one call. A film Radarr already has
  // is left as it is -- Radarr refuses duplicates, and re-adding is not what a
  // second note means.
  async addToRadarr(tmdbId, qualityName) {
    const existing = await this.radarrMovieByTmdb(tmdbId);
    if (existing) {
      this.log('already in Radarr, not added again:', existing.title, existing.hasFile ? '(has file)' : '(no file yet)');
      return existing;
    }
    const profiles = await this.radarrProfiles();
    const profile = profiles.find((p) => p.name.toLowerCase() === String(qualityName || '').toLowerCase());
    if (!profile) throw new Error(`Radarr has no quality profile named "${qualityName}". It has: ${profiles.map((p) => p.name).join(', ')}.`);
    let root = this.settings.radarrRootFolder;
    if (!root) {
      const roots = await this.radarr('GET', '/rootfolder');
      root = roots.length ? roots[0].path : '';
      if (!root) throw new Error('Radarr has no library folder set.');
    }
    const added = await this.radarr('POST', '/movie', {
      tmdbId,
      qualityProfileId: profile.id,
      rootFolderPath: root,
      monitored: true,
      minimumAvailability: 'released',
      addOptions: { searchForMovie: true },
    });
    this.log(`sent to Radarr as ${profile.name}:`, added.title, added.year, '->', added.path);
    return added;
  }

  /* ---------------- folders ---------------- */

  cleanFolder(s) {
    return String(s || '').replace(/^\/+|\/+$/g, '').trim();
  }

  activeNoteFolder() {
    const f = this.app.workspace.getActiveFile();
    return f && f.parent ? f.parent.path.replace(/^\/$/, '') : '';
  }

  resolveMovieFolder() {
    const s = this.settings;
    const mode = s.movieLocationMode || 'specified';
    const anchor = this.activeNoteFolder();
    if (mode === 'vault') return '';
    if (mode === 'same') return anchor;
    if (mode === 'subfolder') {
      const sub = this.cleanFolder(s.movieSubfolder) || 'Movies';
      return anchor ? `${anchor}/${sub}` : sub;
    }
    return this.cleanFolder(s.movieFolder);
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
  // Plus, because the original is not kept.
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
      const encoded = await encodeWebp(new Blob([res.arrayBuffer], { type }), 0.9);
      if (encoded.data) bytes = encoded.data;
      else {
        out = normalizePath(target.replace(/\.webp$/, type.includes('png') ? '.png' : '.jpg'));
        this.log('kept the original format, WebP would be larger:', stem);
      }
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
  async addMovie(tmdbId, quality, sendToRadarr) {
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
      const noteFolder = this.resolveMovieFolder();
      await this.ensureFolder(noteFolder);
      const noteName = L.safeFileName(L.fillTemplate(this.settings.noteNameTemplate, vars));
      const notePath = normalizePath(noteFolder ? `${noteFolder}/${noteName}.md` : `${noteName}.md`);

      const imageFolder = this.resolveImageFolder(noteFolder);
      await this.ensureFolder(imageFolder);
      const links = {};
      const stillLinks = [];
      const art = async (url, template, n, alias) => {
        if (!url) return '';
        const stem = L.safeFileName(L.fillTemplate(template, { ...vars, n }));
        try {
          const file = await this.saveImage(url, imageFolder, stem);
          return file ? this.linkFor(file, notePath, alias) : '';
        } catch (e) {
          this.log(`image failed (${stem}):`, e.message);
          return '';
        }
      };
      links.poster = await art(movie.poster, this.settings.posterTemplate, '', this.settings.posterLabel);
      links.banner = await art(movie.banner, this.settings.bannerTemplate, '', this.settings.bannerLabel);
      for (let i = 0; i < movie.stills.length; i++) {
        const l = await art(movie.stills[i], this.settings.stillTemplate, i + 1, '');
        if (l) stillLinks.push(l);
      }
      lap(`art: ${[links.poster && 'poster', links.banner && 'banner'].filter(Boolean).join(', ')}, ${stillLinks.length} still(s)`);

      const radarr = !!sendToRadarr && this.radarrConfigured();
      const fields = L.movieNoteFields(movie, links, {
        tags: this.settings.movieTags,
        quality: radarr ? quality : undefined,
        radarr,
      });
      const file = await this.writeMovieNote(notePath, fields, L.movieNoteBody(stillLinks));
      lap(`note ${file.path}`);

      if (radarr) {
        try {
          const r = await this.addToRadarr(tmdbId, quality);
          if (r && r.hasFile && r.movieFile && r.movieFile.path) {
            await this.markDownloaded(file, r.movieFile.path);
            this.subtitlesFor(file, r).catch((e) => this.log('subtitles failed:', e.message));
          }
        } catch (e) {
          this.log('Radarr step failed:', e.message);
          new Notice(`Note written, but Radarr said: ${e.message}`, 12000);
        }
      } else if (sendToRadarr) {
        this.log('Radarr not configured; note written without a download');
      }

      new Notice(`${movie.title} (${movie.year}) added.`, 5000);
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      return file;
    } finally {
      this.inFlight.delete(key);
    }
  }

  // A new note gets defaults, the plugin's fields and the stills wall. A note
  // that already exists keeps its body and every property it holds; only the
  // plugin's own fields are refreshed. Hand-edited values are never touched.
  async writeMovieNote(notePath, fields, body) {
    const L = this.lib();
    const defaults = L.parseDefaults(this.settings.movieNoteDefaults);
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
        L.applyOrder(fm, this.settings.movieNoteOrder, L.OWN_KEYS);
      });
      this.log('note existed, properties refreshed and body left alone:', notePath);
      return existing;
    }
    const fm = { ...defaults, ...fields };
    L.applyOrder(fm, this.settings.movieNoteOrder, L.OWN_KEYS);
    await this.app.vault.create(notePath, L.buildFrontmatter(fm) + (body ? '\n' + body : ''));
    const file = this.app.vault.getAbstractFileByPath(notePath);
    return file;
  }

  async setFields(file, fields) {
    const L = this.lib();
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(fields)) fm[k] = v;
      L.applyOrder(fm, this.settings.movieNoteOrder, L.OWN_KEYS);
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

  /* ---------------- downloads ---------------- */

  async markDownloaded(file, moviePath) {
    const { fileLink } = this.lib();
    await this.setFields(file, { 'dl-ed': true, file: fileLink(moviePath) });
    this.log('downloaded:', file.path, '->', moviePath);
  }

  // Every film note still waiting on a file, asked about in one pass. Radarr
  // not running is one log line, not an error per note.
  async checkDownloads(manual) {
    if (!this.radarrConfigured()) {
      if (manual) new Notice('Radarr is not configured.');
      return;
    }
    const waiting = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && fm['dl-ed'] === false && this.tmdbIdOf(f);
    });
    if (!waiting.length) {
      this.log('download check: no film is waiting');
      if (manual) new Notice('No film is waiting on a download.');
      return;
    }
    let movies;
    try {
      movies = await this.radarr('GET', '/movie');
    } catch (e) {
      this.log(`download check: Radarr not answering (${e.message}); ${waiting.length} note(s) still waiting`);
      if (manual) new Notice(`Radarr is not answering: ${e.message}`, 8000);
      return;
    }
    const byTmdb = new Map(movies.map((m) => [m.tmdbId, m]));
    let landed = 0;
    for (const file of waiting) {
      const id = this.tmdbIdOf(file);
      const m = byTmdb.get(id);
      if (!m) {
        this.log('waiting, but Radarr does not have it:', file.path);
        continue;
      }
      if (!m.hasFile || !m.movieFile || !m.movieFile.path) {
        this.log('still downloading:', file.path);
        continue;
      }
      await this.markDownloaded(file, m.movieFile.path);
      landed++;
      await this.subtitlesFor(file, m).catch((e) => this.log('subtitles failed:', e.message));
    }
    this.log(`download check: ${waiting.length} waiting, ${landed} landed`);
    if (manual) new Notice(`${landed} of ${waiting.length} waiting film(s) landed.`);
  }

  /* ---------------- subtitles ---------------- */

  async subtitlesForNote(file) {
    const id = this.tmdbIdOf(file);
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
    const L = this.lib();
    const lang = (this.settings.subtitleLanguage || 'en').trim();
    if (!this.settings.openSubtitlesApiKey) {
      this.log('subtitles skipped, no OpenSubtitles key');
      return '';
    }
    const moviePath = radarrMovie.movieFile.path;
    const target = L.subtitlePath(moviePath, lang);
    if (fs.existsSync(target)) {
      this.log('subtitles already there:', target);
      return target;
    }
    if (!fs.existsSync(moviePath)) {
      this.log('subtitles put off, the film is not reachable (drive unplugged?):', moviePath);
      return '';
    }
    const params = { languages: lang, moviehash: L.openSubtitlesHash(moviePath), order_by: 'download_count', order_direction: 'desc' };
    const imdb = String(radarrMovie.imdbId || '').replace(/^tt/, '');
    if (imdb) params.imdb_id = imdb;
    else params.tmdb_id = String(radarrMovie.tmdbId);
    const found = await this.openSubtitles('GET', '/subtitles', params);
    const pick = L.pickSubtitle(found.data);
    if (!pick) {
      this.log(`no ${lang} subtitles on OpenSubtitles for`, radarrMovie.title);
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
      .setName('Default quality')
      .setDesc('The Radarr quality profile pre-selected when adding a film; it is written to the note as `quality`.')
      .addText((t) =>
        t.setValue(s.defaultQuality).onChange(async (v) => {
          s.defaultQuality = v.trim() || '1080p';
          await this.save();
        })
      );
    new Setting(containerEl)
      .setName('Check for finished downloads every (minutes)')
      .setDesc('Also checked when the vault opens. A film that landed gets `dl-ed: true`, a `file` link, and its subtitles.')
      .addText((t) =>
        t.setValue(String(s.checkMinutes)).onChange(async (v) => {
          s.checkMinutes = Math.max(1, Number(v) || 10);
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
      .setName('Art location')
      .setDesc('Where the poster, banner and stills go. Same folder and subfolder are relative to the film note.')
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
      .setName('Poster, banner and still file names')
      .setDesc('Placeholders: {{title}}, {{year}}, and {{n}} for the still number. Saved as WebP.')
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.posterTemplate).setValue(s.posterTemplate).onChange(async (v) => {
          s.posterTemplate = v.trim() || DEFAULT_SETTINGS.posterTemplate;
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.bannerTemplate).setValue(s.bannerTemplate).onChange(async (v) => {
          s.bannerTemplate = v.trim() || DEFAULT_SETTINGS.bannerTemplate;
          await this.save();
        })
      )
      .addText((t) =>
        t.setPlaceholder(DEFAULT_SETTINGS.stillTemplate).setValue(s.stillTemplate).onChange(async (v) => {
          s.stillTemplate = v.trim() || DEFAULT_SETTINGS.stillTemplate;
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
      .setName('Stills per film')
      .setDesc('Frames from the film, embedded in the note body as a wall. TMDB\'s most-voted backdrop becomes the banner; the stills are the ones after it. 0 for none.')
      .addText((t) =>
        t.setValue(String(s.stillsCount)).onChange(async (v) => {
          s.stillsCount = Math.max(0, Math.floor(Number(v) || 0));
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
