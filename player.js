/* Daily Summaries shared player (2026-11-06, locked spec from the
   frontend design chat, default A; hero labels revised 2026-11-07 to the
   compact-top form: no "Play:" prefix, counts on line 1, truncated
   "Resumes <title> · <time> left" on line 2).
   One audio element for the whole archive. Playback starts on the root
   index or on any day page; the queue auto-advances with zero presses.
   State lives in localStorage only: pl:progress (per episode: position,
   finished, lastPlayedAt), pl:queue, pl:played, pl:rate. Progress is
   per-browser and does not sync; the Podcast Library app is the
   synced home. */
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
  function lsGetRaw(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  var progress = lsGet('pl:progress', {});
  var played = lsGet('pl:played', {});
  var queue = lsGet('pl:queue', []);
  var rate = lsGet('pl:rate', 1);
  var episodes = [];
  var bySlug = {};
  var current = null;
  var queueFinished = false;
  var errorStopped = false;
  var errorStreak = 0;
  var suppressError = false;
  var RATES = [1, 1.25, 1.5, 2];
  if (RATES.indexOf(rate) < 0) rate = 1;
  var lastSave = 0;

  var audio = new Audio();
  audio.preload = 'none';

  var pageDate = null;
  var m = location.pathname.match(/(\d{4}-\d{2}-\d{2})\.html/);
  if (m) pageDate = m[1];
  var onIndex = !pageDate;

  function fmt(sec) {
    if (!isFinite(sec) || sec == null) return '0:00';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600);
    var mm = Math.floor((sec % 3600) / 60);
    var ss = sec % 60;
    if (h > 0) return h + ':' + (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
    return mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function fmtLeft(totalSec) {
    var mins = Math.round(totalSec / 60);
    if (mins >= 60) {
      var h = Math.floor(mins / 60);
      var r = mins % 60;
      return h + 'h ' + (r < 10 ? '0' : '') + r + 'm';
    }
    return mins + 'm';
  }

  /* -------- episode state (locked definitions) -------- */

  function knownDur(slug) {
    var p = progress[slug];
    if (p && p.dur > 0) return p.dur;
    var ep = bySlug[slug];
    return ep && ep.duration_s ? ep.duration_s : 0;
  }
  function pctOf(slug) {
    var p = progress[slug];
    var d = knownDur(slug);
    if (!p || !d) return 0;
    return p.pos / d;
  }
  function isFinished(slug) {
    if (played[slug]) return true;
    var p = progress[slug];
    if (!p) return false;
    if (p.finished) return true;
    return pctOf(slug) >= 0.95;
  }
  function isInProgress(slug) {
    if (isFinished(slug)) return false;
    var p = progress[slug];
    return !!(p && p.pos > 0 && pctOf(slug) < 0.95);
  }
  function isUnplayed(slug) {
    return !isFinished(slug) && !isInProgress(slug);
  }
  function isLiked(slug) {
    return lsGetRaw('rating:' + slug) === 'up';
  }

  /* -------- queue construction (locked Option A) -------- */

  function segment1() {
    var list = episodes.filter(function (e) { return e.hasAudio && isInProgress(e.slug); })
      .map(function (e) { return e.slug; });
    list.sort(function (a, b) {
      var pa = progress[a] || {};
      var pb = progress[b] || {};
      var ta = pa.lastPlayedAt || pa.updated || 0;
      var tb = pb.lastPlayedAt || pb.updated || 0;
      if (tb !== ta) return tb - ta;
      var pc = pctOf(b) - pctOf(a);
      if (pc !== 0) return pc;
      return bySlug[b].date < bySlug[a].date ? -1 : 1;
    });
    return list;
  }

  function segment2() {
    return episodes.filter(function (e) { return e.hasAudio && isUnplayed(e.slug); })
      .map(function (e) { return e.slug; });
  }

  function defaultQueue() {
    var seen = {};
    return segment1().concat(segment2()).filter(function (s) {
      if (seen[s] || !bySlug[s]) return false;
      seen[s] = true;
      return true;
    });
  }

  function dayQueue(date) {
    return episodes.filter(function (e) { return e.hasAudio && e.date === date; })
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
    var prev = progress[current] || {};
    progress[current] = {
      pos: audio.currentTime,
      dur: audio.duration,
      finished: !!prev.finished,
      lastPlayedAt: prev.lastPlayedAt || Date.now()
    };
    saveProgress();
  }

  function markFinished(slug) {
    played[slug] = true;
    savePlayed();
    var p = progress[slug] || { pos: 0, dur: knownDur(slug) };
    p.finished = true;
    if (p.dur > 0) p.pos = p.dur;
    progress[slug] = p;
    saveProgress();
  }

  /* ---------------- UI scaffolding ---------------- */

  var bar, barTitle, barMeta, seek, timeLabel, playBtn, speedBtn, queueBtn;
  var replayBtn, likedBtn, sheet, sheetList, sheetNote, heroBtn, heroNote;
  var toastEl, toastTimer;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function showToast(msg) {
    if (!toastEl) {
      toastEl = el('div', 'pl-toast');
      toastEl.hidden = true;
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, 3500);
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

    replayBtn = el('button', 'pl-ctl pl-secondary', 'Replay queue');
    replayBtn.hidden = true;
    replayBtn.addEventListener('click', replayQueue);
    likedBtn = el('button', 'pl-ctl pl-secondary', 'Play liked');
    likedBtn.hidden = true;
    likedBtn.addEventListener('click', playLiked);
    speedBtn = el('button', 'pl-ctl pl-speed', rate + '×');
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
    row1.appendChild(replayBtn);
    row1.appendChild(likedBtn);
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
    var clearPlayed = el('button', 'pl-mini', 'Clear played');
    clearPlayed.title = 'Remove finished episodes from the queue';
    clearPlayed.addEventListener('click', function () {
      queue = queue.filter(function (s) { return s === current || !isFinished(s); });
      saveQueue();
      renderQueue();
      renderBar();
      refreshCardStates();
    });
    var rebuild = el('button', 'pl-mini', 'Rebuild queue');
    rebuild.title = 'Rebuild the queue: in-progress first, then newest unplayed';
    rebuild.addEventListener('click', function () {
      queue = defaultQueue();
      saveQueue();
      renderQueue();
      renderBar();
      refreshCardStates();
    });
    var close = el('button', 'pl-mini', 'Close');
    close.addEventListener('click', toggleSheet);
    sheetHead.appendChild(clearPlayed);
    sheetHead.appendChild(rebuild);
    sheetHead.appendChild(close);
    sheet.appendChild(sheetHead);
    sheetNote = el('p', 'pl-note',
      'Progress is saved in this browser only and does not sync. The Podcast Library app is the synced home.');
    sheet.appendChild(sheetNote);
    sheetList = el('div', 'pl-sheet-list');
    sheet.appendChild(sheetList);
    document.body.appendChild(sheet);
  }

  /* ---------------- hero ---------------- */

  function buildHero() {
    var lede = document.querySelector('.lede');
    if (!lede || !onIndex) return;
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
    var btn = el('button', 'pl-hero-btn', '▶ Play all');
    btn.addEventListener('click', function () {
      if (current && !audio.paused) { audio.pause(); return; }
      if (current && audio.paused) { audio.play(); return; }
      var q = dayQueue(pageDate);
      if (q.length) playSlug(q[0], q);
    });
    wrap.appendChild(btn);
    wrap.appendChild(el('span', 'pl-hero-note', 'Plays this whole day in order.'));
    head.parentNode.insertBefore(wrap, head.nextSibling);
  }

  function heroRemainingSeconds(slugs, fromProgress) {
    var total = 0;
    slugs.forEach(function (s) {
      var d = knownDur(s);
      if (!d) return;
      if (fromProgress && isInProgress(s)) total += Math.max(0, d - (progress[s] ? progress[s].pos : 0));
      else total += d;
    });
    return total;
  }

  function refreshHero() {
    if (!heroBtn) return;
    if (current) {
      heroBtn.disabled = false;
      heroBtn.textContent = 'View queue';
      heroNote.textContent = (audio.paused ? 'Paused: ' : 'Now playing: ') +
        (bySlug[current] ? bySlug[current].title : '');
      return;
    }
    var s1 = segment1();
    var s2 = segment2();
    if (!s1.length && !s2.length) {
      heroBtn.disabled = true;
      heroBtn.textContent = 'All caught up';
      heroNote.textContent = '';
      return;
    }
    heroBtn.disabled = false;
    var secs = heroRemainingSeconds(s1, true) + heroRemainingSeconds(s2, false);
    if (s1.length && s2.length) {
      heroBtn.textContent = s1.length + ' to finish + ' + s2.length + ' new';
      heroNote.textContent = 'Resumes ' + bySlug[s1[0]].title + ' · ' +
        fmtLeft(secs) + ' left';
    } else if (s1.length) {
      heroBtn.textContent = s1.length + ' to finish';
      heroNote.textContent = 'Resumes ' + bySlug[s1[0]].title + ' · ' +
        fmtLeft(secs) + ' left';
    } else {
      heroBtn.textContent = s2.length + ' new, ' + fmtLeft(secs);
      heroNote.textContent = 'Newest unplayed episodes, back to back.';
    }
  }

  function renderBar(stateText) {
    if (!bar) return;
    var ep = current ? bySlug[current] : null;
    var show = !!ep || queueFinished;
    bar.hidden = !show;
    document.body.classList.toggle('pl-has-bar', show);
    replayBtn.hidden = !queueFinished;
    likedBtn.hidden = !queueFinished;
    if (queueFinished && !ep) {
      barTitle.textContent = stateText || 'Queue finished';
      barMeta.textContent = '';
      playBtn.textContent = '▶';
      queueBtn.textContent = 'Queue (' + queue.length + ')';
      seek.max = '0';
      seek.value = '0';
      timeLabel.textContent = '0:00 / 0:00';
      return;
    }
    if (!ep) return;
    if (errorStopped) {
      barTitle.textContent = 'Playback stopped';
      barMeta.textContent = 'Two episodes in a row failed to load.';
      playBtn.textContent = '▶';
      queueBtn.textContent = 'Queue (' + queue.length + ')';
      return;
    }
    barTitle.textContent = ep.title;
    barMeta.textContent = stateText != null ? stateText :
      ep.channel + ' · ' + ep.date;
    playBtn.textContent = audio.paused ? '▶' : '⏸';
    speedBtn.textContent = rate + '×';
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
    if (queueFinished) {
      sheetNote.textContent = 'Queue finished. Progress is saved in this browser only and does not sync. The Podcast Library app is the synced home.';
    }
    queue.forEach(function (slug) {
      var ep = bySlug[slug];
      if (!ep) return;
      var item = el('div', 'pl-qitem' + (slug === current ? ' is-current' : ''));
      var main = el('div', 'pl-qmain');
      main.appendChild(el('div', 'pl-qtitle', (slug === current ? '▶ ' : '') + ep.title));
      main.appendChild(el('div', 'pl-qmeta',
        ep.channel + ' · ' + ep.date + (ep.duration ? ' · ' + ep.duration : '') +
        (isFinished(slug) ? ' · finished' : '')));
      item.appendChild(main);
      var rm = el('button', 'pl-qremove', '×');
      rm.title = 'Remove from queue';
      rm.setAttribute('aria-label', 'Remove from queue');
      rm.addEventListener('click', function (ev) {
        ev.stopPropagation();
        var wasCurrent = slug === current;
        queue = queue.filter(function (s) { return s !== slug; });
        saveQueue();
        renderQueue();
        renderBar();
        refreshCardStates();
        if (wasCurrent) playNext(true);
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
    queueFinished = false;
    errorStopped = false;
    var prev = progress[slug] || { pos: 0, dur: 0, finished: false };
    prev.lastPlayedAt = Date.now();
    progress[slug] = prev;
    saveProgress();
    audio.src = ep.audio_url;
    audio.playbackRate = rate;
    var p = progress[slug];
    var startAt = 0;
    if (p && p.pos > 0 && !isFinished(slug) && (!p.dur || p.pos < p.dur - 10)) {
      startAt = p.pos;
    }
    var seekOnLoad = function () {
      if (startAt > 0) {
        try { audio.currentTime = startAt; } catch (e) {}
      }
      audio.removeEventListener('loadedmetadata', seekOnLoad);
    };
    audio.addEventListener('loadedmetadata', seekOnLoad);
    var promise = audio.play();
    if (promise && promise.catch) {
      promise.catch(function () { handlePlayError(); });
    }
    renderBar();
    renderQueue();
    refreshHero();
    refreshCardStates();
  }

  function togglePlay() {
    if (!current) { heroPlay(); return; }
    if (errorStopped) {
      errorStopped = false;
      errorStreak = 0;
      playSlug(current, null);
      return;
    }
    if (audio.paused) audio.play(); else audio.pause();
  }

  function heroPlay() {
    if (current) {
      if (sheet) { sheet.hidden = false; renderQueue(); }
      return;
    }
    var standing = queue.filter(function (s) { return bySlug[s] && !isFinished(s); });
    if (standing.length) {
      playSlug(standing[0], queue);
      return;
    }
    var q = defaultQueue();
    if (q.length) playSlug(q[0], q);
  }

  function finishQueue() {
    current = null;
    queueFinished = true;
    suppressError = true;
    audio.removeAttribute('src');
    audio.load();
    suppressError = false;
    renderBar();
    refreshHero();
    refreshCardStates();
  }

  function playNext(auto) {
    if (!current && !auto) return;
    var from = current ? queue.indexOf(current) : -1;
    var next = null;
    for (var j = from + 1; j < queue.length; j++) {
      if (!isFinished(queue[j])) { next = queue[j]; break; }
    }
    if (next) { playSlug(next, null); return; }
    if (auto || current) finishQueue();
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
    lsSet('pl:rate', rate);
    speedBtn.textContent = rate + '×';
  }

  function replayQueue() {
    if (!queue.length) return;
    queue.forEach(function (s) {
      delete played[s];
      if (progress[s]) { progress[s].finished = false; progress[s].pos = 0; }
    });
    savePlayed();
    saveProgress();
    queueFinished = false;
    playSlug(queue[0], queue);
  }

  function playLiked() {
    var liked = episodes.filter(function (e) { return e.hasAudio && isLiked(e.slug); })
      .map(function (e) { return e.slug; });
    if (!liked.length) {
      showToast('No liked episodes yet. Thumbs up an episode to add it here.');
      return;
    }
    queueFinished = false;
    playSlug(liked[0], liked);
  }

  function handlePlayError() {
    if (!current || suppressError) return;
    var failedTitle = bySlug[current] ? bySlug[current].title : 'episode';
    errorStreak++;
    if (errorStreak >= 2) {
      errorStopped = true;
      try { audio.pause(); } catch (e) {}
      renderBar();
      showToast('Playback stopped: two episodes failed to load.');
      return;
    }
    showToast('Could not play "' + failedTitle + '", skipping.');
    playNext(true);
  }

  audio.addEventListener('error', function () { handlePlayError(); }, true);
  audio.addEventListener('playing', function () {
    errorStreak = 0;
    renderBar();
    refreshHero();
  });
  audio.addEventListener('waiting', function () {
    if (current) renderBar('Buffering…');
  });
  audio.addEventListener('play', function () { renderBar(); refreshHero(); });
  audio.addEventListener('pause', function () {
    saveCurrentProgress();
    renderBar();
    refreshHero();
    refreshCardStates();
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
      refreshCardStates();
    }
  });
  audio.addEventListener('ended', function () {
    if (!current) return;
    markFinished(current);
    refreshCardStates();
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

  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t) return;
    var tag = (t.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable) return;
    if (e.key === ' ') {
      if (tag === 'button') return;
      e.preventDefault();
      if (current) togglePlay(); else heroPlay();
    } else if (e.key === 'ArrowLeft') {
      if (current) { e.preventDefault(); seekBy(-15); }
    } else if (e.key === 'ArrowRight') {
      if (current) { e.preventDefault(); seekBy(30); }
    } else if (e.key === 'ArrowUp') {
      if (current) { e.preventDefault(); playPrev(); }
    } else if (e.key === 'ArrowDown') {
      if (current) { e.preventDefault(); playNext(false); }
    }
  });

  /* ---------------- per-card controls and states ---------------- */

  var cardPlayBtns = {};   // slug -> {btn, stateEl, kind}
  var dayCardChips = {};   // slug -> {chip, stateEl}

  function fillState(elm, slug) {
    if (!elm) return;
    elm.innerHTML = '';
    if (slug === current) {
      elm.appendChild(el('span', 'pl-state-now', audio.paused ? 'Paused in player' : 'Playing now'));
      return;
    }
    if (isFinished(slug)) {
      elm.appendChild(el('span', 'pl-state-done', '✓ Finished'));
      return;
    }
    if (isInProgress(slug)) {
      var d = knownDur(slug);
      var p = progress[slug];
      var pct = d ? Math.floor((p.pos / d) * 100) : 0;
      var wrap = el('span', 'pl-state-prog');
      var barOuter = el('span', 'pl-prog');
      var barInner = el('span', 'pl-prog-fill');
      barInner.style.width = pct + '%';
      barOuter.appendChild(barInner);
      wrap.appendChild(barOuter);
      wrap.appendChild(el('span', 'pl-state-text',
        pct + '% · ' + fmt(Math.max(0, d - p.pos)) + ' left'));
      elm.appendChild(wrap);
      return;
    }
    var qi = queue.indexOf(slug);
    if (qi >= 0) {
      elm.appendChild(el('span', 'pl-state-queued', 'Queued #' + (qi + 1)));
    }
  }

  function refreshCardStates() {
    Object.keys(cardPlayBtns).forEach(function (slug) {
      var rec = cardPlayBtns[slug];
      if (slug === current) {
        rec.btn.textContent = audio.paused ? '▶ Resume' : '⏸ Pause';
      } else {
        rec.btn.textContent = '▶ Play';
      }
      fillState(rec.stateEl, slug);
      if (rec.li) rec.li.classList.toggle('pl-is-played', isFinished(slug));
    });
    Object.keys(dayCardChips).forEach(function (slug) {
      var rec = dayCardChips[slug];
      rec.chip.textContent = slug === current && !audio.paused ? '⏸' : '▶';
      fillState(rec.stateEl, slug);
    });
    refreshHero();
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
    refreshCardStates();
  }

  function listOrderFrom(entries, startSlug) {
    var slugs = entries.map(function (e) { return e.slug; });
    var i = slugs.indexOf(startSlug);
    return i >= 0 ? slugs.slice(i) : slugs;
  }

  function decorateIndexEntries() {
    var lis = Array.prototype.slice.call(document.querySelectorAll('li.entry'));
    var domOrder = [];
    lis.forEach(function (li) {
      var a = li.querySelector('.entry-links a.link');
      if (!a) return;
      var href = a.getAttribute('href') || '';
      var hash = href.indexOf('#');
      if (hash < 0) return;
      var slug = href.slice(hash + 1);
      li.setAttribute('data-pl-slug', slug);
      if (bySlug[slug] && bySlug[slug].hasAudio) domOrder.push(slug);
    });
    lis.forEach(function (li) {
      var links = li.querySelector('.entry-links');
      var slug = li.getAttribute('data-pl-slug');
      if (!links || !slug || !bySlug[slug] || !bySlug[slug].hasAudio) return;
      var play = el('button', 'pl-btn pl-cardplay', '▶ Play');
      play.addEventListener('click', function () {
        if (slug === current) { togglePlay(); return; }
        playSlug(slug, listOrderFrom(domOrder.map(function (s) { return bySlug[s]; }), slug));
      });
      var add = el('button', 'pl-btn pl-cardadd', '+ Queue');
      add.addEventListener('click', function () { addToQueue(slug, add); });
      links.appendChild(play);
      links.appendChild(add);
      var state = el('span', 'pl-state');
      links.appendChild(state);
      cardPlayBtns[slug] = { btn: play, stateEl: state, li: li };
      if (isFinished(slug)) li.classList.add('pl-is-played');
    });
  }

  function decorateDayCards() {
    document.querySelectorAll('a.card').forEach(function (card) {
      var href = card.getAttribute('href') || '';
      if (href.charAt(0) !== '#') return;
      var slug = href.slice(1);
      if (!bySlug[slug] || !bySlug[slug].hasAudio) return;
      var chip = el('span', 'pl-chip', '▶');
      chip.setAttribute('role', 'button');
      chip.setAttribute('aria-label', 'Play this episode');
      chip.title = 'Play this episode';
      chip.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (slug === current) { togglePlay(); return; }
        var dq = dayQueue(pageDate);
        var i = dq.indexOf(slug);
        playSlug(slug, i >= 0 ? dq.slice(i) : [slug]);
      });
      card.appendChild(chip);
      var state = el('span', 'pl-state pl-cardstate');
      card.appendChild(state);
      dayCardChips[slug] = { chip: chip, stateEl: state };
    });
    document.querySelectorAll('section.article-view').forEach(function (sec) {
      var slug = sec.getAttribute('id');
      if (!slug || !bySlug[slug] || !bySlug[slug].hasAudio) return;
      var title = sec.querySelector('.episode-title');
      if (!title) return;
      var btn = el('button', 'pl-btn pl-article-btn', '▶ Play from here');
      btn.addEventListener('click', function () {
        if (slug === current) { togglePlay(); return; }
        var dq = dayQueue(pageDate);
        var i = dq.indexOf(slug);
        playSlug(slug, i >= 0 ? dq.slice(i) : [slug]);
      });
      title.parentNode.insertBefore(btn, title.nextSibling);
    });
  }

  /* ---------------- browse: collapse, search, filters (index) -------- */

  var filterMode = 'all';
  var filterQuery = '';
  var filterBar, filterCount, filterPlayAll, emptyState;
  var daySections = [];

  function entryMatches(li) {
    var slug = li.getAttribute('data-pl-slug');
    var ep = slug ? bySlug[slug] : null;
    if (filterQuery) {
      var title = ep ? ep.title : (li.querySelector('.entry-title') || {}).textContent || '';
      var chan = ep ? ep.channel : (li.querySelector('.entry-meta') || {}).textContent || '';
      var hay = (title + ' ' + chan).toLowerCase();
      if (hay.indexOf(filterQuery) < 0) return false;
    }
    if (filterMode === 'all') return true;
    if (!ep || !ep.hasAudio) return false;
    if (filterMode === 'unplayed') return isUnplayed(slug);
    if (filterMode === 'inprogress') return isInProgress(slug);
    if (filterMode === 'liked') return isLiked(slug);
    return true;
  }

  function filteringActive() {
    return filterMode !== 'all' || filterQuery.length > 0;
  }

  function applyFilter() {
    var visible = 0;
    var visiblePlayable = [];
    daySections.forEach(function (ds) {
      var sectionVisible = 0;
      ds.items.forEach(function (li) {
        var ok = entryMatches(li);
        li.style.display = ok ? '' : 'none';
        if (ok) {
          sectionVisible++;
          var slug = li.getAttribute('data-pl-slug');
          if (slug && bySlug[slug] && bySlug[slug].hasAudio) visiblePlayable.push(slug);
        }
      });
      visible += sectionVisible;
      if (filteringActive()) {
        ds.section.style.display = sectionVisible ? '' : 'none';
        ds.ul.hidden = false;
      } else {
        ds.section.style.display = '';
        ds.ul.hidden = ds.collapsed;
      }
    });
    if (filterCount) {
      filterCount.textContent = filteringActive() ? visible + ' results' : '';
    }
    if (filterPlayAll) {
      filterPlayAll.hidden = !filteringActive() || !visiblePlayable.length;
      filterPlayAll.onclick = function () {
        if (visiblePlayable.length) playSlug(visiblePlayable[0], visiblePlayable.slice());
      };
    }
    if (emptyState) emptyState.hidden = visible !== 0;
  }

  function buildBrowse() {
    if (!onIndex) return;
    document.querySelectorAll('section.day').forEach(function (section, idx) {
      var h2 = section.querySelector('h2.day-label');
      var ul = section.querySelector('ul');
      if (!h2 || !ul) return;
      var items = Array.prototype.slice.call(ul.querySelectorAll('li.entry'));
      var firstSlug = items.length ? items[0].getAttribute('data-pl-slug') : null;
      var date = firstSlug && bySlug[firstSlug] ? bySlug[firstSlug].date : null;
      var ds = { section: section, ul: ul, items: items, collapsed: idx !== 0, date: date };
      ul.hidden = ds.collapsed;
      section.classList.toggle('pl-collapsed', ds.collapsed);
      var playAll = el('button', 'pl-dayplay', '▶ Play all');
      playAll.title = 'Play this whole day in order';
      playAll.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (!date) return;
        var q = dayQueue(date);
        if (q.length) playSlug(q[0], q);
      });
      h2.appendChild(playAll);
      h2.classList.add('pl-daylabel');
      h2.addEventListener('click', function () {
        if (filteringActive()) return;
        ds.collapsed = !ds.collapsed;
        ds.ul.hidden = ds.collapsed;
        section.classList.toggle('pl-collapsed', ds.collapsed);
      });
      daySections.push(ds);
    });

    var hero = heroBtn ? heroBtn.parentNode : document.querySelector('.lede');
    if (!hero) return;
    filterBar = el('div', 'pl-filterbar');
    var search = document.createElement('input');
    search.type = 'search';
    search.className = 'pl-search';
    search.placeholder = 'Search episodes';
    search.setAttribute('aria-label', 'Search episodes');
    search.addEventListener('input', function () {
      filterQuery = search.value.trim().toLowerCase();
      applyFilter();
    });
    filterBar.appendChild(search);
    [['all', 'All'], ['unplayed', 'Unplayed'], ['inprogress', 'In progress'], ['liked', 'Liked']]
      .forEach(function (pair) {
        var chip = el('button', 'pl-fchip' + (pair[0] === 'all' ? ' is-on' : ''), pair[1]);
        chip.setAttribute('aria-pressed', pair[0] === 'all' ? 'true' : 'false');
        chip.addEventListener('click', function () {
          filterMode = pair[0];
          filterBar.querySelectorAll('.pl-fchip').forEach(function (c) {
            var on = c === chip;
            c.classList.toggle('is-on', on);
            c.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
          applyFilter();
        });
        filterBar.appendChild(chip);
      });
    filterCount = el('span', 'pl-fcount', '');
    filterBar.appendChild(filterCount);
    filterPlayAll = el('button', 'pl-btn pl-fplay', '▶ Play all results');
    filterPlayAll.hidden = true;
    filterBar.appendChild(filterPlayAll);
    hero.parentNode.insertBefore(filterBar, hero.nextSibling);

    emptyState = el('div', 'pl-empty');
    emptyState.hidden = true;
    emptyState.appendChild(el('span', null, 'No episodes match. '));
    var clear = el('button', 'pl-btn', 'Clear search');
    clear.addEventListener('click', function () {
      search.value = '';
      filterQuery = '';
      filterMode = 'all';
      filterBar.querySelectorAll('.pl-fchip').forEach(function (c, i) {
        c.classList.toggle('is-on', i === 0);
        c.setAttribute('aria-pressed', i === 0 ? 'true' : 'false');
      });
      applyFilter();
    });
    emptyState.appendChild(clear);
    var lastSection = daySections.length ? daySections[daySections.length - 1].section : null;
    if (lastSection && lastSection.parentNode) {
      lastSection.parentNode.insertBefore(emptyState, lastSection.nextSibling);
    }
  }

  /* ---------------- init ---------------- */

  function init() {
    buildBar();
    buildHero();
    buildDayPlay();
    decorateIndexEntries();
    decorateDayCards();
    buildBrowse();
    renderBar();
    refreshCardStates();
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
