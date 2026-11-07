/* Daily Summaries shared player (added 2026-11-06).
   One audio element for the whole archive. Playback starts on the root
   index or on any day page; the queue auto-advances with zero presses.
   State lives in localStorage only, namespaced pl:progress, pl:queue,
   pl:played. Progress is per-browser and does not sync; the Podcast
   Library app is the synced home. */
(function () {
  'use strict';

  var script = document.currentScript;
  var base = script && script.src ? script.src.replace(/[^/]*$/, '') : '';

  function lsGet(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
  }

  var progress = lsGet('pl:progress', {});
  var played = lsGet('pl:played', {});
  var queue = lsGet('pl:queue', []);
  var episodes = [];
  var bySlug = {};
  var current = null;
  var rate = 1;
  var RATES = [1, 1.25, 1.5, 1.75, 2];
  var lastSave = 0;

  var audio = new Audio();
  audio.preload = 'none';

  var pageDate = null;
  var m = location.pathname.match(/(\d{4}-\d{2}-\d{2})\.html/);
  if (m) pageDate = m[1];

  function fmt(sec) {
    if (!isFinite(sec) || sec == null) return '0:00';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var mm = Math.floor((sec % 3600) / 60);
    var ss = sec % 60;
    if (h > 0) return h + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function hasProgress(slug) {
    return !!(progress[slug] && progress[slug].pos > 5 && !played[slug]);
  }

  function defaultQueue() {
    var inProg = Object.keys(progress).filter(hasProgress);
    inProg.sort(function (a, b) {
      return (progress[b].updated || 0) - (progress[a].updated || 0);
    });
    var rest = [];
    for (var i = episodes.length - 1; i >= 0; i--) {
      var e = episodes[i];
      if (!played[e.slug] && !hasProgress(e.slug)) rest.push(e.slug);
    }
    var seen = {};
    return inProg.concat(rest).filter(function (s) {
      if (seen[s] || !bySlug[s]) return false;
      seen[s] = true;
      return true;
    });
  }

  function dayQueue() {
    if (!pageDate) return [];
    return episodes.filter(function (e) { return e.date === pageDate; })
      .map(function (e) { return e.slug; });
  }

  function dedupe(list) {
    var seen = {};
    return list.filter(function (s) {
      if (seen[s] || !bySlug[s]) return false;
      seen[s] = true;
      return true;
    });
  }

  function saveQueue() { lsSet('pl:queue', queue); }
  function saveProgress() { lsSet('pl:progress', progress); }
  function savePlayed() { lsSet('pl:played', played); }

  function saveCurrentProgress() {
    if (!current || !isFinite(audio.duration) || audio.duration <= 0) return;
    progress[current] = {
      pos: audio.currentTime,
      dur: audio.duration,
      updated: Date.now()
    };
    saveProgress();
  }

  /* ---------------- UI scaffolding ---------------- */

  var bar, barTitle, barMeta, seek, timeLabel, playBtn, speedBtn, queueBtn;
  var sheet, sheetList, heroBtn, heroNote;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function buildBar() {
    bar = el('div', 'pl-bar');
    bar.hidden = true;

    var row1 = el('div', 'pl-row pl-row-main');
    var prevBtn = el('button', 'pl-ctl', '⏮');
    prevBtn.title = 'Previous episode';
    prevBtn.setAttribute('aria-label', 'Previous episode');
    prevBtn.addEventListener('click', playPrev);
    var backBtn = el('button', 'pl-ctl', '↺ 15');
    backBtn.title = 'Back 15 seconds';
    backBtn.setAttribute('aria-label', 'Back 15 seconds');
    backBtn.addEventListener('click', function () { seekBy(-15); });
    playBtn = el('button', 'pl-ctl pl-playpause', '▶');
    playBtn.title = 'Play or pause';
    playBtn.setAttribute('aria-label', 'Play or pause');
    playBtn.addEventListener('click', togglePlay);
    var fwdBtn = el('button', 'pl-ctl', '30 ↷');
    fwdBtn.title = 'Forward 30 seconds';
    fwdBtn.setAttribute('aria-label', 'Forward 30 seconds');
    fwdBtn.addEventListener('click', function () { seekBy(30); });
    var nextBtn = el('button', 'pl-ctl', '⏭');
    nextBtn.title = 'Next episode';
    nextBtn.setAttribute('aria-label', 'Next episode');
    nextBtn.addEventListener('click', function () { playNext(false); });

    var mid = el('div', 'pl-mid');
    barTitle = el('div', 'pl-title', '');
    barMeta = el('div', 'pl-meta', '');
    mid.appendChild(barTitle);
    mid.appendChild(barMeta);

    speedBtn = el('button', 'pl-ctl pl-speed', '1×');
    speedBtn.title = 'Playback speed';
    speedBtn.setAttribute('aria-label', 'Playback speed');
    speedBtn.addEventListener('click', cycleSpeed);
    queueBtn = el('button', 'pl-ctl pl-queuebtn', 'Queue');
    queueBtn.title = 'Show the queue';
    queueBtn.setAttribute('aria-label', 'Show the queue');
    queueBtn.addEventListener('click', toggleSheet);

    row1.appendChild(prevBtn);
    row1.appendChild(backBtn);
    row1.appendChild(playBtn);
    row1.appendChild(fwdBtn);
    row1.appendChild(nextBtn);
    row1.appendChild(mid);
    row1.appendChild(speedBtn);
    row1.appendChild(queueBtn);

    var row2 = el('div', 'pl-row pl-row-seek');
    seek = document.createElement('input');
    seek.type = 'range';
    seek.className = 'pl-seek';
    seek.min = '0';
    seek.max = '0';
    seek.step = '1';
    seek.value = '0';
    seek.setAttribute('aria-label', 'Seek');
    seek.addEventListener('input', function () {
      if (isFinite(audio.duration)) audio.currentTime = Number(seek.value);
    });
    timeLabel = el('span', 'pl-time', '0:00 / 0:00');
    row2.appendChild(seek);
    row2.appendChild(timeLabel);

    bar.appendChild(row1);
    bar.appendChild(row2);
    document.body.appendChild(bar);

    sheet = el('div', 'pl-sheet');
    sheet.hidden = true;
    var sheetHead = el('div', 'pl-sheet-head');
    sheetHead.appendChild(el('strong', null, 'Up next'));
    var rebuild = el('button', 'pl-mini', 'Reset queue');
    rebuild.title = 'Rebuild the queue: in-progress first, then newest unplayed';
    rebuild.addEventListener('click', function () {
      queue = defaultQueue();
      saveQueue();
      renderQueue();
      renderBar();
    });
    var close = el('button', 'pl-mini', 'Close');
    close.addEventListener('click', toggleSheet);
    sheetHead.appendChild(rebuild);
    sheetHead.appendChild(close);
    sheet.appendChild(sheetHead);
    sheet.appendChild(el('p', 'pl-note',
      'Progress is saved in this browser only and does not sync. The Podcast Library app is the synced home.'));
    sheetList = el('div', 'pl-sheet-list');
    sheet.appendChild(sheetList);
    document.body.appendChild(sheet);
  }

  function buildHero() {
    var lede = document.querySelector('.lede');
    if (!lede || pageDate) return;
    var wrap = el('div', 'pl-hero');
    heroBtn = el('button', 'pl-hero-btn', '▶ Play');
    heroBtn.addEventListener('click', heroPlay);
    heroNote = el('span', 'pl-hero-note', '');
    wrap.appendChild(heroBtn);
    wrap.appendChild(heroNote);
    lede.parentNode.insertBefore(wrap, lede.nextSibling);
    refreshHero();
  }

  function buildDayPlay() {
    if (!pageDate) return;
    var head = document.querySelector('.index-view .masthead') ||
      document.querySelector('.masthead');
    if (!head) return;
    var wrap = el('div', 'pl-hero');
    var btn = el('button', 'pl-hero-btn', '▶ Play this day');
    btn.addEventListener('click', function () {
      if (current && !audio.paused) { audio.pause(); return; }
      if (current && audio.paused) { audio.play(); return; }
      var dq = dayQueue().filter(function (s) { return !played[s]; });
      var q = dedupe(dq.concat(defaultQueue()));
      if (q.length) playSlug(q[0], q);
    });
    wrap.appendChild(btn);
    wrap.appendChild(el('span', 'pl-hero-note',
      'Plays this day in order, then continues with in-progress and newest unplayed episodes.'));
    head.parentNode.insertBefore(wrap, head.nextSibling);
  }

  function refreshHero() {
    if (!heroBtn) return;
    if (current) {
      heroBtn.textContent = audio.paused ? '▶ Resume' : '⏸ Pause';
      heroNote.textContent = 'Now playing: ' + (bySlug[current] ? bySlug[current].title : '');
      return;
    }
    var inProg = Object.keys(progress).filter(hasProgress);
    if (inProg.length) {
      var latest = inProg.sort(function (a, b) {
        return (progress[b].updated || 0) - (progress[a].updated || 0);
      })[0];
      heroBtn.textContent = '▶ Resume listening';
      heroNote.textContent = 'Pick up "' + bySlug[latest].title + '" where you left off, then newest unplayed episodes play automatically.';
    } else {
      heroBtn.textContent = '▶ Play';
      heroNote.textContent = 'Plays the newest unplayed episodes back to back, automatically.';
    }
  }

  function renderBar() {
    if (!bar) return;
    var ep = current ? bySlug[current] : null;
    bar.hidden = !ep;
    document.body.classList.toggle('pl-has-bar', !!ep);
    if (!ep) return;
    barTitle.textContent = ep.title;
    barMeta.textContent = ep.channel + ' · ' + ep.date;
    playBtn.textContent = audio.paused ? '▶' : '⏸';
    queueBtn.textContent = 'Queue (' + queue.length + ')';
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: ep.title,
          artist: ep.channel,
          album: 'Daily Summaries'
        });
      } catch (e) {}
    }
  }

  function renderQueue() {
    if (!sheetList) return;
    sheetList.innerHTML = '';
    if (!queue.length) {
      sheetList.appendChild(el('div', 'pl-qempty', 'The queue is empty.'));
      return;
    }
    queue.forEach(function (slug) {
      var ep = bySlug[slug];
      if (!ep) return;
      var item = el('div', 'pl-qitem' + (slug === current ? ' is-current' : ''));
      var main = el('div', 'pl-qmain');
      main.appendChild(el('div', 'pl-qtitle', (slug === current ? '▶ ' : '') + ep.title));
      main.appendChild(el('div', 'pl-qmeta',
        ep.channel + ' · ' + ep.date + (ep.duration ? ' · ' + ep.duration : '') + (played[slug] ? ' · played' : '')));
      item.appendChild(main);
      var rm = el('button', 'pl-qremove', '×');
      rm.title = 'Remove from queue';
      rm.setAttribute('aria-label', 'Remove from queue');
      rm.addEventListener('click', function (ev) {
        ev.stopPropagation();
        queue = queue.filter(function (s) { return s !== slug; });
        saveQueue();
        renderQueue();
        renderBar();
      });
      item.appendChild(rm);
      item.addEventListener('click', function () { playSlug(slug, null); });
      sheetList.appendChild(item);
    });
  }

  function toggleSheet() {
    if (!sheet) return;
    sheet.hidden = !sheet.hidden;
    if (!sheet.hidden) renderQueue();
  }

  /* ---------------- playback ---------------- */

  function playSlug(slug, newQueue) {
    var ep = bySlug[slug];
    if (!ep) return;
    if (newQueue) {
      queue = dedupe(newQueue);
      saveQueue();
    }
    if (queue.indexOf(slug) < 0) {
      queue.unshift(slug);
      saveQueue();
    }
    saveCurrentProgress();
    current = slug;
    audio.src = ep.audio_url;
    audio.playbackRate = rate;
    var p = progress[slug];
    var startAt = 0;
    if (p && p.pos > 5 && (!p.dur || p.pos < p.dur - 10)) startAt = p.pos;
    var seekOnLoad = function () {
      if (startAt > 0) {
        try { audio.currentTime = startAt; } catch (e) {}
      }
      audio.removeEventListener('loadedmetadata', seekOnLoad);
    };
    audio.addEventListener('loadedmetadata', seekOnLoad);
    var promise = audio.play();
    if (promise && promise.catch) promise.catch(function () {});
    renderBar();
    renderQueue();
    refreshHero();
    markPlayingCards();
  }

  function togglePlay() {
    if (!current) { heroPlay(); return; }
    if (audio.paused) audio.play(); else audio.pause();
  }

  function heroPlay() {
    if (current) { togglePlay(); return; }
    if (queue.length && queue.some(function (s) { return !played[s]; })) {
      var first = queue.filter(function (s) { return !played[s]; })[0];
      playSlug(first, queue);
      return;
    }
    var q = defaultQueue();
    if (q.length) playSlug(q[0], q);
  }

  function playNext(auto) {
    if (!current) return;
    var i = queue.indexOf(current);
    var next = null;
    for (var j = i + 1; j < queue.length; j++) {
      if (!played[queue[j]]) { next = queue[j]; break; }
    }
    if (next) { playSlug(next, null); return; }
    if (auto) {
      current = null;
      audio.removeAttribute('src');
      audio.load();
      renderBar();
      refreshHero();
      markPlayingCards();
    }
  }

  function playPrev() {
    if (!current) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    var i = queue.indexOf(current);
    if (i > 0) playSlug(queue[i - 1], null);
  }

  function seekBy(delta) {
    if (!isFinite(audio.duration)) return;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), audio.duration);
  }

  function cycleSpeed() {
    var i = RATES.indexOf(rate);
    rate = RATES[(i + 1) % RATES.length];
    audio.playbackRate = rate;
    speedBtn.textContent = rate + '×';
  }

  audio.addEventListener('play', function () { renderBar(); refreshHero(); });
  audio.addEventListener('pause', function () {
    saveCurrentProgress();
    renderBar();
    refreshHero();
  });
  audio.addEventListener('timeupdate', function () {
    if (!current) return;
    if (isFinite(audio.duration) && audio.duration > 0) {
      seek.max = String(Math.floor(audio.duration));
      seek.value = String(Math.floor(audio.currentTime));
      timeLabel.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration);
    }
    var now = Date.now();
    if (now - lastSave > 5000) {
      lastSave = now;
      saveCurrentProgress();
    }
  });
  audio.addEventListener('ended', function () {
    if (!current) return;
    played[current] = true;
    savePlayed();
    delete progress[current];
    saveProgress();
    markPlayingCards();
    playNext(true);
  });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { audio.play(); });
      navigator.mediaSession.setActionHandler('pause', function () { audio.pause(); });
      navigator.mediaSession.setActionHandler('previoustrack', playPrev);
      navigator.mediaSession.setActionHandler('nexttrack', function () { playNext(false); });
      navigator.mediaSession.setActionHandler('seekbackward', function () { seekBy(-15); });
      navigator.mediaSession.setActionHandler('seekforward', function () { seekBy(30); });
    } catch (e) {}
  }

  /* ---------------- per-card controls ---------------- */

  function markPlayingCards() {
    document.querySelectorAll('li.entry').forEach(function (li) {
      var a = li.querySelector('.entry-links a.link');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      var hash = href.indexOf('#');
      if (hash < 0) return;
      var slug = href.slice(hash + 1);
      li.classList.toggle('pl-is-played', !!played[slug]);
    });
  }

  function addToQueue(slug, btn) {
    if (queue.indexOf(slug) < 0) {
      queue.push(slug);
      saveQueue();
    }
    if (btn) {
      var old = btn.textContent;
      btn.textContent = 'Queued ✓';
      setTimeout(function () { btn.textContent = old; }, 1200);
    }
    renderBar();
    renderQueue();
  }

  function decorateIndexEntries() {
    document.querySelectorAll('li.entry').forEach(function (li) {
      var links = li.querySelector('.entry-links');
      var a = li.querySelector('.entry-links a.link');
      if (!links || !a) return;
      var href = a.getAttribute('href') || '';
      var hash = href.indexOf('#');
      if (hash < 0) return;
      var slug = href.slice(hash + 1);
      if (!bySlug[slug]) return;
      var play = el('button', 'pl-btn pl-cardplay', '▶ Play');
      play.addEventListener('click', function () {
        playSlug(slug, dedupe([slug].concat(defaultQueue())));
      });
      var add = el('button', 'pl-btn pl-cardadd', '+ Queue');
      add.addEventListener('click', function () { addToQueue(slug, add); });
      links.appendChild(play);
      links.appendChild(add);
      if (played[slug]) {
        li.classList.add('pl-is-played');
        links.appendChild(el('span', 'pl-played-tag', 'Played'));
      }
    });
  }

  function decorateDayCards() {
    document.querySelectorAll('a.card').forEach(function (card) {
      var href = card.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var slug = href.slice(1);
      if (!bySlug[slug]) return;
      var chip = el('span', 'pl-chip', '▶');
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-label', 'Play this episode');
      chip.title = 'Play this episode';
      chip.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        var dq = dayQueue();
        var i = dq.indexOf(slug);
        var rest = i >= 0 ? dq.slice(i + 1) : [];
        playSlug(slug, dedupe([slug].concat(rest).concat(defaultQueue())));
      });
      card.appendChild(chip);
    });
    document.querySelectorAll('section.article-view').forEach(function (sec) {
      var slug = sec.getAttribute('id');
      if (!slug || !bySlug[slug]) return;
      var title = sec.querySelector('.episode-title');
      if (!title) return;
      var btn = el('button', 'pl-btn pl-article-btn', '▶ Play in queue');
      btn.addEventListener('click', function () {
        var dq = dayQueue();
        var i = dq.indexOf(slug);
        var rest = i >= 0 ? dq.slice(i + 1) : [];
        playSlug(slug, dedupe([slug].concat(rest).concat(defaultQueue())));
      });
      title.parentNode.insertBefore(btn, title.nextSibling);
    });
  }

  /* ---------------- init ---------------- */

  function init() {
    buildBar();
    buildHero();
    buildDayPlay();
    decorateIndexEntries();
    decorateDayCards();
    renderBar();
  }

  function start() {
    fetch(base + 'episodes.json', { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('episodes.json ' + r.status);
        return r.json();
      })
      .then(function (data) {
        episodes = (data && data.episodes) || [];
        episodes.forEach(function (e) { bySlug[e.slug] = e; });
        if (document.readyState === 'loading') {
          document.addEventListener('DOMContentLoaded', init);
        } else {
          init();
        }
      })
      .catch(function () { /* player layer stays off; archive works as before */ });
  }

  start();
})();
