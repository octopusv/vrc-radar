/* VRC Radar SPA */
'use strict';

const $ = (sel, el) => (el || document).querySelector(sel);
const $$ = (sel, el) => [...(el || document).querySelectorAll(sel)];
const main = $('#main');
const tooltip = $('#tooltip');

const ACCT = (() => {
  const m = location.pathname.match(/^\/(\d+)/);
  return m ? +m[1] : 1;
})();

const KINDS = {
  gps: { label: '移動', color: '#3987e5' },
  online: { label: 'オンライン', color: '#d95926' },
  status: { label: 'ステータス', color: '#199e70' },
  avatar: { label: 'アバター', color: '#c98500' },
  bio: { label: 'bio', color: '#d55181' },
};
const KIND_ORDER = ['gps', 'online', 'status', 'avatar', 'bio'];

const TRUST = {
  'Trusted User': { label: 'Trusted', color: '#8143e6' },
  'Known User': { label: 'Known', color: '#ff7b42' },
  'User': { label: 'User', color: '#2bcf5c' },
  'New User': { label: 'New', color: '#1778ff' },
  'Visitor': { label: 'Visitor', color: '#cccccc' },
};
const STATUS = {
  'join me': { label: 'Join Me', color: '#42caff' },
  'active': { label: 'Active', color: '#51e57e' },
  'ask me': { label: 'Ask Me', color: '#e6a800' },
  'busy': { label: 'Busy', color: '#e05656' },
};

const state = {
  cleanup: [],
  resizeFns: [],
  routeToken: 0,
  feed: { kinds: new Set(KIND_ORDER), q: '', fav: false },
  feedItems: [],   // rows rendered on the current page, for expand-on-click
};

// A page awaits network before touching the DOM; if the user navigated away
// meanwhile its nodes are gone. Every page captures the token it started on
// and stops as soon as it is no longer the current one.
function currentRoute() {
  const token = state.routeToken;
  return () => token === state.routeToken;
}

function loadPref(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem('vrcradar.' + key));
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem('vrcradar.' + key, JSON.stringify(value)); }
  catch (e) { /* ignore */ }
}

{
  const savedKinds = loadPref('feedKinds', null);
  if (Array.isArray(savedKinds) && savedKinds.length) state.feed.kinds = new Set(savedKinds);
  state.feed.fav = !!loadPref('feedFav', false);
}

/* ---------------- helpers ---------------- */

function buildUrl(path, params) {
  const url = new URL(path, location.origin);
  url.searchParams.set('acct', ACCT);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== '' && v != null) url.searchParams.set(k, v);
  }
  return url;
}

async function api(path, params) {
  const res = await fetch(buildUrl(path, params));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtRel(iso) {
  if (!iso) return '';
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60e3) return '今';
  if (d < 3600e3) return `${Math.floor(d / 60e3)}分前`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}時間前`;
  return `${Math.floor(d / 86400e3)}日前`;
}

function fmtTime(iso) {
  if (!iso) return '';
  const dt = new Date(iso);
  const now = new Date();
  const hm = dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (dt.toDateString() === now.toDateString()) return hm;
  return `${dt.getMonth() + 1}/${dt.getDate()} ${hm}`;
}

function fmtFull(iso) {
  return iso ? new Date(iso).toLocaleString('ja-JP') : '';
}

function fmtDur(ms) {
  ms = Number(ms) || 0;
  if (ms <= 0) return '';
  const m = Math.round(ms / 60e3);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  return `${h}時間${m % 60 ? `${m % 60}分` : ''}`;
}

function fmtHours(ms) {
  return (ms / 3600e3).toFixed(1) + 'h';
}

function parseLocation(loc) {
  if (!loc || loc === 'offline') return { kind: 'offline' };
  if (loc === 'private') return { kind: 'private' };
  if (loc === 'traveling') return { kind: 'traveling' };
  const m = loc.match(/^(wrld_[0-9a-f-]+):(.*)$/i);
  if (!m) return { kind: 'other', raw: loc };
  const tags = m[2];
  let access = 'Public';
  if (/~group\(/.test(tags)) {
    const at = (tags.match(/~groupAccessType\((\w+)\)/) || [])[1];
    access = at === 'public' ? 'Group Public' : at === 'plus' ? 'Group+' : 'Group';
  } else if (/~hidden\(/.test(tags)) access = 'Friends+';
  else if (/~friends\(/.test(tags)) access = 'Friends';
  else if (/~private\(/.test(tags)) {
    access = /~canRequestInvite/.test(tags) ? 'Invite+' : 'Invite';
  }
  const region = (tags.match(/~region\((\w+)\)/) || [])[1] || '';
  const instanceId = (tags.split('~')[0] || '').trim();
  return { kind: 'world', worldId: m[1], access, region, instanceId };
}

function locationBadges(loc) {
  const p = parseLocation(loc);
  if (p.kind !== 'world') return '';
  let html = `<span class="badge">${esc(p.access)}</span>`;
  if (p.region) html += `<span class="badge region">${esc(p.region)}</span>`;
  return html;
}

function stateLabel(s) {
  return { private: 'Private', traveling: '移動中', offline: 'オフライン' }[s]
    || '不明';
}

function trustBadge(level) {
  const t = TRUST[level];
  if (!t) return `<span class="trust" style="--trust-color:#898781">${esc(level || '—')}</span>`;
  return `<span class="trust" style="--trust-color:${t.color}">${t.label}</span>`;
}

function trustDot(level) {
  const t = TRUST[level];
  return `<span class="kind-dot" style="background:${t ? t.color : '#898781'}"`
    + ` title="${esc(t ? t.label : level || '')}"></span>`;
}

function statusChip(status, desc) {
  if (!status) return '<span class="muted">—</span>';
  const s = STATUS[status] || { label: status, color: '#898781' };
  const text = desc ? esc(desc) : s.label;
  return `<span class="status-chip" style="--status-color:${s.color}" title="${s.label}">${text}</span>`;
}

function userLink(uid, name) {
  return `<span class="feed-name" data-user="${esc(uid)}">${esc(name)}</span>`;
}

function statusColor(status) {
  return (STATUS[status] || { color: '#51e57e' }).color;
}

// image refs from the API are /api/image?fid=…&v=… paths; add the account
function imgUrl(ref) {
  return ref ? `${ref}&acct=${ACCT}` : '';
}

// high-resolution variant of the same image, for the lightbox
function imgUrlFull(ref) {
  return ref ? `${ref}&s=1024&acct=${ACCT}` : '';
}

// small round profile picture with an initial fallback and an optional
// status dot (VRCX-style friend list). The large (user page) variant is
// tappable and opens the lightbox.
function pfpHtml(image, name, dotColor, cls) {
  const init = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
  const zoom = cls === 'lg' && image;
  return `<span class="pfp${cls ? ' ' + cls : ''}">`
    + (image ? `<img class="im${zoom ? ' zoomable' : ''}" src="${esc(imgUrl(image))}" loading="lazy" alt=""${zoom ? ` data-full="${esc(imgUrlFull(image))}" data-caption="${esc(name || '')}"` : ''} onerror="this.remove()">` : '')
    + `<span class="init">${init}</span>`
    + (dotColor ? `<span class="dot" style="background:${dotColor}"></span>` : '')
    + '</span>';
}

/* ---------------- lightbox ---------------- */

let lightbox = null;
let lbToken = 0;

function openLightbox(thumbSrc, fullSrc, caption) {
  if (!lightbox) {
    lightbox = document.createElement('div');
    lightbox.id = 'lightbox';
    lightbox.hidden = true;
    lightbox.innerHTML = '<img alt=""><div class="cap"></div>';
    lightbox.addEventListener('click', closeLightbox);
    addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    document.body.appendChild(lightbox);
  }
  const t = ++lbToken;
  const img = lightbox.querySelector('img');
  // show the thumbnail immediately, swap in the 1024px version when ready
  img.src = thumbSrc;
  lightbox.querySelector('.cap').textContent = caption || '';
  lightbox.hidden = false;
  if (fullSrc && fullSrc !== thumbSrc) {
    const pre = new Image();
    pre.onload = () => { if (t === lbToken && !lightbox.hidden) img.src = fullSrc; };
    pre.src = fullSrc;
  }
}

function closeLightbox() {
  lbToken++;
  if (lightbox) {
    lightbox.hidden = true;
    lightbox.querySelector('img').src =
      'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
  }
}

const REGION_FLAGS = { jp: '🇯🇵', us: '🇺🇸', use: '🇺🇸', usw: '🇺🇸', usx: '🇺🇸', eu: '🇪🇺' };

function favMark(isFav) {
  return isFav ? '<span class="fav-mark" title="VRChatのお気に入り">★</span>' : '';
}

function favGroupPills(groups) {
  if (!groups || !groups.length) return '';
  return `<span class="fav-groups">${groups.map(g =>
    `<span class="fav-pill">★ ${esc(g)}</span>`).join('')}</span>`;
}

function favChip(id, on, label) {
  return `<span class="chip fav-chip${on ? ' on' : ''}" id="${id}">★ ${label || 'お気に入り'}</span>`;
}

function favWarnHtml(status) {
  if (!status || status.ok) return '';
  return `<div class="fav-warn">お気に入りを取得できません: ${esc(status.error || '不明なエラー')}</div>`;
}

function liveWarnHtml(status, favStatus) {
  if (!status || status.ok) return '';
  // same root cause as the favorites banner (e.g. not logged in) → show once
  if (favStatus && !favStatus.ok && favStatus.error === status.error) return '';
  return `<div class="fav-warn">オンライン状態をVRChatで確認できません（VRCXの記録のみで表示中）: ${esc(status.error || '不明なエラー')}</div>`;
}

function showTooltip(html, x, y) {
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  const r = tooltip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 10;
  if (top + r.height > innerHeight - 8) top = y - r.height - 10;
  tooltip.style.left = left + 'px';
  tooltip.style.top = top + 'px';
}
function hideTooltip() { tooltip.hidden = true; }

function onCleanup(fn) { state.cleanup.push(fn); }
function onResize(fn) { state.resizeFns.push(fn); }

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { for (const fn of state.resizeFns) { try { fn(); } catch (e) { /* ignore */ } } }, 200);
});

main.addEventListener('click', (e) => {
  const z = e.target.closest('img.zoomable');
  if (z) {
    openLightbox(z.currentSrc || z.src, z.dataset.full || '', z.dataset.caption || '');
    return;
  }
  const u = e.target.closest('[data-user]');
  if (u) { location.hash = '#/user/' + u.dataset.user; return; }
  if (e.target.closest('.feed-expand')) return;  // clicks inside stay put
  const row = e.target.closest('.feed-row.expandable');
  if (row) toggleFeedRow(row);
});

function toggleFeedRow(row) {
  const open = row.classList.toggle('open');
  let ex = row.querySelector('.feed-expand');
  if (!ex && open) {
    const it = state.feedItems[+row.dataset.idx];
    if (!it) return;
    ex = document.createElement('div');
    ex.className = 'feed-expand';
    ex.innerHTML = feedExpandHtml(it);
    row.querySelector('.feed-body').appendChild(ex);
  } else if (ex) {
    ex.hidden = !open;
  }
}

/* ---------------- feed row rendering ---------------- */

function feedExpandable(it) {
  switch (it.kind) {
    case 'gps': return true;
    case 'avatar': return !!(it.image || it.previous_image);
    case 'status': return !!(it.previous_status || it.previous_status_description);
    case 'bio': return !!it.previous_bio || (it.bio || '').length > 120;
    default: return false;
  }
}

// one "place" line inside an expanded row: flag + world name + badges
function fxLocLine(loc, worldName, extraHtml) {
  const p = parseLocation(loc || '');
  let inner;
  if (p.kind === 'world') {
    const flag = REGION_FLAGS[(p.region || '').toLowerCase()] || '';
    inner = `${flag ? flag + ' ' : ''}<span class="world">${esc(worldName || '(不明なワールド)')}</span>${locationBadges(loc)}`;
  } else {
    inner = `<span class="muted">${loc ? esc(stateLabel(loc)) : '不明'}</span>`;
  }
  return `<div class="fx-loc">${inner}${extraHtml || ''}</div>`;
}

function feedExpandHtml(it) {
  switch (it.kind) {
    case 'gps': {
      // VRCX: previous instance (+ time spent there) ↓ new instance
      const dur = fmtDur(it.time);
      const durChip = dur ? ` <span class="dur-chip" title="滞在時間">${dur}</span>` : '';
      let html = '';
      if (it.previous_location) {
        html += fxLocLine(it.previous_location, it.previous_world_name, durChip)
          + '<div class="fx-down">↓</div>';
      }
      html += fxLocLine(it.location, it.world_name,
        it.group_name ? ` <span class="muted">${esc(it.group_name)}</span>` : '');
      return html;
    }
    case 'avatar': {
      const fig = (ref, label, cap) =>
        `<img class="zoomable" src="${esc(imgUrl(ref))}" loading="lazy" alt="${label}" title="${label}（タップで拡大）" data-full="${esc(imgUrlFull(ref))}" data-caption="${esc(cap)}" onerror="this.remove()">`;
      const name = it.avatar_name || '';
      let html = '<div class="fx-imgs">';
      if (it.previous_image) html += fig(it.previous_image, '変更前', '変更前のアバター');
      if (it.previous_image && it.image) html += '<span class="fx-arrow">→</span>';
      if (it.image) html += fig(it.image, '変更後', name || '変更後のアバター');
      html += '</div>';
      html += `<div class="fx-caption">${esc(name || '(非公開アバター)')}</div>`;
      return html;
    }
    case 'status':
      return `<div class="fx-loc">${statusChip(it.previous_status, it.previous_status_description)}</div>`
        + '<div class="fx-down">↓</div>'
        + `<div class="fx-loc">${statusChip(it.status, it.status_description)}</div>`;
    case 'bio': {
      let html = `<div class="fx-caption" style="margin-top:0;white-space:pre-wrap">${esc(it.bio || '')}</div>`;
      if (it.previous_bio) {
        const prev = it.previous_bio.length > 300 ? it.previous_bio.slice(0, 300) + '…' : it.previous_bio;
        html += `<div class="fx-prev">以前: ${esc(prev)}</div>`;
      }
      return html;
    }
  }
  return '';
}

function feedRowHtml(it) {
  const k = KINDS[it.kind] || { color: '#898781' };
  let detail = '';
  let sub = '';
  switch (it.kind) {
    case 'gps': {
      const world = it.world_name || '(非公開)';
      detail = `<span class="world">${esc(world)}</span> へ移動${locationBadges(it.location)}`;
      if (it.group_name) sub = esc(it.group_name);
      break;
    }
    case 'online':
      if (it.type === 'Online') {
        detail = `オンライン${it.world_name ? ` — <span class="world">${esc(it.world_name)}</span>` : ''}`;
      } else {
        detail = 'オフライン';
        const d = fmtDur(it.time);
        if (d) sub = `セッション ${d}`;
      }
      break;
    case 'status': {
      const s = STATUS[it.status] || { label: it.status, color: '#898781' };
      detail = `<span class="status-chip" style="--status-color:${s.color}">${s.label}</span>`
        + (it.status_description ? ` <span class="world">${esc(it.status_description)}</span>` : '');
      if (it.previous_status_description && it.previous_status_description !== it.status_description) {
        sub = `← ${esc(it.previous_status_description)}`;
      }
      break;
    }
    case 'avatar':
      detail = `アバター変更: <span class="world">${esc(it.avatar_name || '(非公開アバター)')}</span>`;
      break;
    case 'bio':
      detail = 'bioを更新';
      sub = esc((it.bio || '').slice(0, 120));
      break;
  }
  const idx = state.feedItems.push(it) - 1;
  const canEx = feedExpandable(it);
  return `<div class="feed-row${canEx ? ' expandable' : ''}" data-idx="${idx}">
    <span class="feed-toggle${canEx ? '' : ' none'}"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></span>
    <span class="feed-time" title="${esc(fmtFull(it.created_at))}">${fmtTime(it.created_at)}</span>
    <span class="kind-dot" style="background:${k.color}" title="${k.label || ''}"></span>
    <div class="feed-body">
      ${userLink(it.user_id, it.display_name)}
      <span class="feed-detail"> ${detail}</span>
      ${sub ? `<div class="feed-sub">${sub}</div>` : ''}
    </div>
  </div>`;
}

/* ---------------- charts ---------------- */

function roundedTopRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y}`
    + ` L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function renderStackedBars(container, buckets, kinds) {
  const W = container.clientWidth || 600;
  const H = 220;
  const pad = { l: 36, r: 8, t: 10, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const totals = buckets.map(b => kinds.reduce((s, k) => s + (b.values[k] || 0), 0));
  const maxV = Math.max(1, ...totals);
  const n = buckets.length;
  const gap = n > 40 ? 1 : 2;
  const bw = Math.max(2, Math.floor(iw / n) - gap);
  const y = v => pad.t + ih * (1 - v / maxV);

  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" height="${H}">`;
  const ticks = 3;
  for (let i = 1; i <= ticks; i++) {
    const v = Math.round(maxV * i / ticks);
    const gy = y(v);
    svg += `<line x1="${pad.l}" y1="${gy}" x2="${W - pad.r}" y2="${gy}" stroke="#2c2c2a" stroke-width="1"/>`;
    svg += `<text x="${pad.l - 6}" y="${gy + 4}" text-anchor="end" font-size="11" fill="#898781">${v}</text>`;
  }
  svg += `<line x1="${pad.l}" y1="${pad.t + ih}" x2="${W - pad.r}" y2="${pad.t + ih}" stroke="#383835" stroke-width="1"/>`;

  const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 60)));
  buckets.forEach((b, i) => {
    const x = pad.l + i * (iw / n) + gap / 2;
    let acc = 0;
    const total = totals[i];
    const segs = kinds.filter(k => (b.values[k] || 0) > 0);
    segs.forEach((k, si) => {
      const v = b.values[k];
      const y0 = y(acc + v), y1 = y(acc);
      const isTop = si === segs.length - 1;
      // 2px surface gap sits at the top of every segment that has one above it
      const yy = isTop ? y0 : y0 + 2;
      const h = Math.max(y1 - yy, 1.2);
      if (isTop) {
        svg += `<path d="${roundedTopRect(x, yy, bw, h, 3)}" fill="${KINDS[k].color}" data-i="${i}"/>`;
      } else {
        svg += `<rect x="${x}" y="${yy}" width="${bw}" height="${h}" fill="${KINDS[k].color}" data-i="${i}"/>`;
      }
      acc += v;
    });
    if (total === 0) {
      svg += `<rect x="${x}" y="${pad.t + ih - 1}" width="${bw}" height="1" fill="#2c2c2a" data-i="${i}"/>`;
    }
    if (i % labelEvery === 0) {
      svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle" font-size="11" fill="#898781">${esc(b.label)}</text>`;
    }
  });
  svg += '</svg>';
  container.innerHTML = svg;

  const el = container.firstElementChild;
  el.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) { hideTooltip(); return; }
    const b = buckets[+t.dataset.i];
    let rows = kinds
      .filter(k => (b.values[k] || 0) > 0)
      .map(k => `<div class="t-row"><span class="sw" style="background:${KINDS[k].color}"></span>${KINDS[k].label} <b style="margin-left:auto">${b.values[k]}</b></div>`)
      .join('');
    if (!rows) rows = '<div class="t-row muted">イベントなし</div>';
    showTooltip(`<div class="t-title">${esc(b.tip || b.label)}</div>${rows}`, e.clientX, e.clientY);
  });
  el.addEventListener('mouseleave', hideTooltip);
}

function renderHBars(container, rows) {
  const W = container.clientWidth || 500;
  const rowH = 26;
  const H = rows.length * rowH + 6;
  const labelW = Math.min(150, W * 0.32);
  const valueW = 48;
  const iw = W - labelW - valueW - 10;
  const maxV = Math.max(1, ...rows.map(r => r.value));
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" height="${H}">`;
  rows.forEach((r, i) => {
    const yy = i * rowH + 4;
    const bw = Math.max(2, iw * r.value / maxV);
    svg += `<text class="hbar-label" x="${labelW}" y="${yy + 13}" text-anchor="end"><title>${esc(r.label)}</title>${esc(r.label.length > 11 ? r.label.slice(0, 10) + '…' : r.label)}</text>`;
    const x = labelW + 8, h = rowH - 9, rr = 3;
    svg += `<path d="M${x},${yy} L${x + bw - rr},${yy} Q${x + bw},${yy} ${x + bw},${yy + rr} L${x + bw},${yy + h - rr} Q${x + bw},${yy + h} ${x + bw - rr},${yy + h} L${x},${yy + h} Z" fill="#3987e5" data-i="${i}"/>`;
    svg += `<text class="hbar-value" x="${x + bw + 6}" y="${yy + 13}">${esc(r.valueLabel)}</text>`;
  });
  svg += '</svg>';
  container.innerHTML = svg;
  const el = container.firstElementChild;
  el.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-i]');
    if (!t) { hideTooltip(); return; }
    const r = rows[+t.dataset.i];
    showTooltip(`<div class="t-title">${esc(r.label)}</div><div class="t-row">${esc(r.valueLabel)}</div>`, e.clientX, e.clientY);
  });
  el.addEventListener('mouseleave', hideTooltip);
  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-i]');
    if (t && rows[+t.dataset.i].user_id) location.hash = '#/user/' + rows[+t.dataset.i].user_id;
  });
}

function legendHtml(kinds) {
  return `<div class="legend">${kinds.map(k =>
    `<span class="item"><span class="sw" style="background:${KINDS[k].color}"></span>${KINDS[k].label}</span>`).join('')}</div>`;
}

function buildBuckets(series, days) {
  const kinds = KIND_ORDER;
  const now = new Date();
  const buckets = [];
  if (days === 1) {
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600e3);
      const utcKey = d.toISOString().slice(0, 13);
      const values = {};
      for (const k of kinds) values[k] = (series[k] || {})[utcKey] || 0;
      buckets.push({
        label: `${d.getHours()}時`,
        tip: `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:00`,
        values,
      });
    }
  } else {
    const byDay = new Map();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      const b = { label: `${d.getMonth() + 1}/${d.getDate()}`, tip: d.toLocaleDateString('ja-JP'), values: {} };
      for (const k of kinds) b.values[k] = 0;
      byDay.set(key, b); buckets.push(b);
    }
    for (const k of kinds) {
      for (const [utcKey, c] of Object.entries(series[k] || {})) {
        const d = new Date(utcKey + ':00:00Z');
        const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
        const b = byDay.get(key);
        if (b) b.values[k] += c;
      }
    }
  }
  return buckets;
}

/* ---------------- pages ---------------- */

function setNav(name) {
  $$('#sidebar a[data-nav]').forEach(a => {
    a.classList.toggle('active', a.dataset.nav === name);
  });
}

function runCleanup() {
  state.routeToken++;
  for (const fn of state.cleanup) { try { fn(); } catch (e) { /* ignore */ } }
  state.cleanup = [];
  state.resizeFns = [];
  state.feedItems = [];
  hideTooltip();
  closeLightbox();
}

async function pageDashboard() {
  setNav('dashboard');
  const alive = currentRoute();
  main.innerHTML = '<h1>ダッシュボード</h1><div class="center">読み込み中…</div>';
  let sum, act;
  try {
    [sum, act] = await Promise.all([api('/api/summary'), api('/api/activity', { days: 7 })]);
  } catch (e) {
    if (!alive()) return;
    main.innerHTML = `<h1>ダッシュボード</h1><div class="card center">読み込みに失敗しました: ${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;
  const own = sum.own_last_location;
  let onlineFav = !!loadPref('onlineFav', false);
  const favOnline = sum.online_friends.filter(f => f.is_fav).length;

  main.innerHTML = `
    <h1>ダッシュボード</h1>
    ${favWarnHtml(sum.fav_status)}
    ${liveWarnHtml(sum.live_status, sum.fav_status)}
    <div class="tiles">
      <div class="tile"><div class="label">フレンド</div><div class="value">${sum.friends_total}</div></div>
      <div class="tile"><div class="label">オンライン中</div><div class="value">${sum.online_count}</div>
        <div class="sub">うち ★お気に入り ${favOnline}人</div></div>
      <div class="tile"><div class="label">24時間のイベント</div><div class="value">${sum.events_24h}</div></div>
      <div class="tile"><div class="label">自分の最終ワールド</div>
        <div class="value" style="font-size:15px;line-height:1.4;padding-top:5px;overflow-wrap:anywhere">${esc(own ? own.world_name : '—')}</div>
        <div class="sub">${own ? fmtRel(own.created_at) : ''}${own && own.group_name ? ' · ' + esc(own.group_name) : ''}</div>
      </div>
    </div>
    <div class="card">
      <div class="chart-head"><h2 style="margin:0">アクティビティ（イベント数）</h2>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          ${legendHtml(KIND_ORDER)}
          <span class="seg-control" id="act-range">
            <button data-days="1">24時間</button>
            <button data-days="7" class="on">7日</button>
            <button data-days="30">30日</button>
          </span>
        </div>
      </div>
      <div id="act-chart"></div>
    </div>
    <div class="grid cols-2">
      <div class="card">
        <div class="chart-head" style="margin-bottom:8px">
          <h2 style="margin:0">オンライン中 <span class="muted" id="online-count">(${sum.online_count})</span></h2>
          ${favChip('online-fav', onlineFav)}
        </div>
        <div class="table-scroll scroll-y"><table class="list"><tbody id="online-list"></tbody></table></div>
      </div>
      <div class="card">
        <h2>一緒にいた時間が長いフレンド <span class="muted">(7日)</span></h2>
        <div id="top-friends"></div>
        <div class="muted" style="font-size:11px;margin-top:8px">VRCXが記録したオンラインセッション時間の合計</div>
      </div>
    </div>`;

  const renderOnline = () => {
    const rows = sum.online_friends.filter(f => !onlineFav || f.is_fav);
    $('#online-count').textContent = `(${rows.length})`;
    $('#online-list').innerHTML = rows.length ? rows.map(f => `
      <tr class="clickable" data-user="${esc(f.user_id)}">
        <td class="name-cell"><div class="nm-wrap">
          ${pfpHtml(f.image, f.display_name, statusColor(f.status))}
          <span class="nm">${favMark(f.is_fav)} ${esc(f.display_name)}</span>
        </div></td>
        <td class="hide-m">${statusChip(f.status, f.status_description)}</td>
        <td class="ellip loc-cell">${f.world_name ? esc(f.world_name) + locationBadges(f.location) : '<span class="muted">Private</span>'}</td>
        <td class="num" title="${esc(fmtFull(f.online_since))}">${fmtRel(f.online_since)}</td>
      </tr>`).join('')
      : `<tr><td class="center">${onlineFav ? 'お気に入りのフレンドはオンラインにいません' : 'オンラインのフレンドはいません'}</td></tr>`;
  };
  renderOnline();
  $('#online-fav').addEventListener('click', () => {
    onlineFav = !onlineFav;
    savePref('onlineFav', onlineFav);
    $('#online-fav').classList.toggle('on', onlineFav);
    renderOnline();
  });

  let actData = act, actDays = 7;
  const drawActivity = () => {
    renderStackedBars($('#act-chart'), buildBuckets(actData.series, actDays), KIND_ORDER);
    const rows = actData.top_friends.map(t => ({
      label: t.display_name, value: t.ms, valueLabel: fmtHours(t.ms), user_id: t.user_id,
    }));
    if (rows.length) renderHBars($('#top-friends'), rows);
    else $('#top-friends').innerHTML = '<div class="center">データがまだありません</div>';
  };
  drawActivity();
  onResize(drawActivity);

  $('#act-range').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-days]');
    if (!btn) return;
    $$('#act-range button').forEach(b => b.classList.toggle('on', b === btn));
    try {
      actDays = +btn.dataset.days;
      actData = await api('/api/activity', { days: actDays });
      drawActivity();
    } catch (err) { /* keep old chart */ }
  });
}

async function pageLocations() {
  setNav('locations');
  const alive = currentRoute();
  main.innerHTML = '<h1>フレンドの現在地</h1><div class="center">読み込み中…</div>';
  let data;
  try { data = await api('/api/locations'); }
  catch (e) {
    if (!alive()) return;
    main.innerHTML = `<h1>フレンドの現在地</h1><div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  let favOnly = !!loadPref('locFav', false);
  let q = '';

  main.innerHTML = `
    <h1>フレンドの現在地</h1>
    ${favWarnHtml(data.fav_status)}
    ${liveWarnHtml(data.live_status, data.fav_status)}
    <div class="chips">
      ${favChip('loc-fav', favOnly)}
      <input type="search" id="loc-q" placeholder="フレンド名・ワールド名で検索">
      <button class="btn" id="loc-reload">更新</button>
    </div>
    <div class="inst-summary" id="loc-summary"></div>
    <div class="inst-list" id="loc-list"></div>`;

  const render = () => {
    const ql = q.toLowerCase();
    const match = (inst) => {
      const friends = inst.friends.filter(f =>
        (!favOnly || f.is_fav)
        && (!ql || f.display_name.toLowerCase().includes(ql)
          || (inst.world_name || '').toLowerCase().includes(ql)));
      return friends.length ? { ...inst, friends } : null;
    };
    const rows = data.instances.map(match).filter(Boolean);
    rows.sort((a, b) => b.friends.length - a.friends.length
      || (b.newest || '').localeCompare(a.newest || ''));

    const hidden = data.hidden.filter(f =>
      (!favOnly || f.is_fav) && (!ql || f.display_name.toLowerCase().includes(ql)));
    const shown = rows.reduce((s, r) => s + r.friends.length, 0);

    $('#loc-summary').innerHTML =
      `${shown}人が ${rows.length}個のインスタンスにいます`
      + (hidden.length ? ` · 非公開/移動中 ${hidden.length}人` : '')
      + `<span class="muted"> · ${fmtRel(data.server_time)}時点</span>`;

    const cardHtml = (inst) => {
      const p = parseLocation(inst.location);
      const favN = inst.friends.filter(f => f.is_fav).length;
      return `<div class="inst-card${inst.is_own ? ' is-own' : ''}${favN ? ' has-fav' : ''}">
        <div class="inst-head">
          <span class="inst-count"><b>${inst.friends.length}</b><span>人</span></span>
          <div class="inst-title">
            <div class="inst-world">${esc(inst.world_name || '(不明なワールド)')}</div>
            <div class="inst-meta">
              <span class="badge" style="margin-left:0">${esc(p.access || '—')}</span>
              ${p.region ? `<span class="badge region" style="margin-left:0">${esc(p.region)}</span>` : ''}
              ${inst.group_name ? `<span>${esc(inst.group_name)}</span>` : ''}
              ${favN ? `<span style="color:var(--fav)">★ ${favN}</span>` : ''}
              ${inst.is_own ? '<span class="own-tag">あなたのインスタンス</span>' : ''}
            </div>
          </div>
        </div>
        <div class="inst-friends">
          ${inst.friends.map(f => `
            <div class="inst-friend" data-user="${esc(f.user_id)}">
              ${pfpHtml(f.image, f.display_name, statusColor(f.status))}
              ${trustDot(f.trust_level)}
              <span class="nm">${favMark(f.is_fav)} ${esc(f.display_name)}</span>
              <span class="meta">
                ${f.status_description ? `<span class="ellip" style="max-width:150px">${esc(f.status_description)}</span>` : ''}
                <span title="${esc(fmtFull(f.since))}">${fmtRel(f.since)}</span>
              </span>
            </div>`).join('')}
        </div>
      </div>`;
    };

    const hiddenHtml = hidden.length ? `
      <div class="inst-card">
        <div class="inst-head">
          <span class="inst-count"><b>${hidden.length}</b><span>人</span></span>
          <div class="inst-title">
            <div class="inst-world muted">場所非公開 / 移動中</div>
            <div class="inst-meta">インスタンスが分からないオンラインのフレンド</div>
          </div>
        </div>
        <div class="inst-friends">
          ${hidden.map(f => `
            <div class="inst-friend" data-user="${esc(f.user_id)}">
              ${pfpHtml(f.image, f.display_name, statusColor(f.status))}
              ${trustDot(f.trust_level)}
              <span class="nm">${favMark(f.is_fav)} ${esc(f.display_name)}</span>
              <span class="meta">
                <span class="badge" style="margin-left:0">${esc(stateLabel(f.state))}</span>
                <span title="${esc(fmtFull(f.since))}">${fmtRel(f.since)}</span>
              </span>
            </div>`).join('')}
        </div>
      </div>` : '';

    $('#loc-list').innerHTML = (rows.length || hidden.length)
      ? rows.map(cardHtml).join('') + hiddenHtml
      : '<div class="card center">該当するフレンドがいません</div>';
  };
  render();

  const reload = async () => {
    try {
      const fresh = await api('/api/locations');
      if (!alive()) return;
      data = fresh;
      render();
    } catch (e) { /* keep showing the previous snapshot */ }
  };

  $('#loc-fav').addEventListener('click', () => {
    favOnly = !favOnly;
    savePref('locFav', favOnly);
    $('#loc-fav').classList.toggle('on', favOnly);
    render();
  });
  let qTimer;
  $('#loc-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { q = e.target.value.trim(); render(); }, 250);
  });
  $('#loc-reload').addEventListener('click', reload);
  const timer = setInterval(reload, 60e3);
  onCleanup(() => { clearInterval(timer); clearTimeout(qTimer); });
}

async function pageFeed() {
  setNav('feed');
  const alive = currentRoute();
  main.innerHTML = `
    <h1>フィード</h1>
    <div id="feed-warn"></div>
    <div class="chips" id="feed-chips">
      ${favChip('feed-fav', state.feed.fav)}
      ${KIND_ORDER.map(k => `<span class="chip ${state.feed.kinds.has(k) ? 'on' : 'off'}" data-kind="${k}">
        <span class="swatch" style="background:${KINDS[k].color}"></span>${KINDS[k].label}</span>`).join('')}
      <input type="search" id="feed-q" placeholder="名前で検索" value="${esc(state.feed.q)}">
    </div>
    <div class="new-banner" id="new-banner" hidden><button class="btn primary" id="new-btn"></button></div>
    <div class="card" style="padding:8px 16px"><div id="feed-list"></div>
      <div class="loadmore" id="feed-more"><span class="muted">読み込み中…</span></div>
    </div>`;

  const list = $('#feed-list');
  const moreEl = $('#feed-more');
  let cursor = '';
  let loading = false;
  let done = false;
  let newestLoaded = '';

  const load = async (reset) => {
    if (loading) return;
    loading = true;
    if (reset) { cursor = ''; done = false; list.innerHTML = ''; newestLoaded = ''; $('#new-banner').hidden = true; }
    moreEl.innerHTML = '<span class="muted">読み込み中…</span>';
    try {
      const data = await api('/api/feed', {
        types: [...state.feed.kinds].join(','),
        q: state.feed.q, before: cursor, limit: 60,
        fav: state.feed.fav ? '1' : '',
      });
      if (!alive()) return;
      $('#feed-warn').innerHTML = favWarnHtml(data.fav_status);
      if (data.items.length && !newestLoaded) newestLoaded = data.items[0].created_at;
      list.insertAdjacentHTML('beforeend', data.items.map(feedRowHtml).join(''));
      cursor = data.next;
      if (!cursor) { done = true; moreEl.innerHTML = list.children.length ? '<span class="muted">これ以上ありません</span>' : '<span class="muted">該当するイベントがありません</span>'; }
      else moreEl.innerHTML = '';
    } catch (e) {
      if (alive()) moreEl.innerHTML = `<span class="muted">読み込み失敗: ${esc(e.message)} — スクロールで再試行</span>`;
    }
    loading = false;
  };

  const io = new IntersectionObserver((entries) => {
    if (entries.some(en => en.isIntersecting) && !done && !loading) load(false);
  }, { rootMargin: '400px' });
  io.observe(moreEl);
  onCleanup(() => io.disconnect());

  $('#feed-fav').addEventListener('click', () => {
    state.feed.fav = !state.feed.fav;
    savePref('feedFav', state.feed.fav);
    $('#feed-fav').classList.toggle('on', state.feed.fav);
    load(true);
  });

  $('#feed-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip[data-kind]');
    if (!chip) return;
    const k = chip.dataset.kind;
    if (state.feed.kinds.has(k) && state.feed.kinds.size > 1) state.feed.kinds.delete(k);
    else state.feed.kinds.add(k);
    chip.classList.toggle('on', state.feed.kinds.has(k));
    chip.classList.toggle('off', !state.feed.kinds.has(k));
    savePref('feedKinds', [...state.feed.kinds]);
    load(true);
  });

  let qTimer;
  $('#feed-q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { state.feed.q = e.target.value.trim(); load(true); }, 350);
  });
  onCleanup(() => clearTimeout(qTimer));

  const poll = setInterval(async () => {
    if (!newestLoaded) return;
    try {
      const u = await api('/api/updates', { after: newestLoaded });
      if (u.new_count > 0) {
        $('#new-btn').textContent = `新着 ${u.new_count}件を表示`;
        $('#new-banner').hidden = false;
      }
    } catch (e) { /* ignore */ }
  }, 45e3);
  onCleanup(() => clearInterval(poll));
  $('#new-btn').addEventListener('click', () => load(true));

  load(true);
}

async function pageFriends() {
  setNav('friends');
  const alive = currentRoute();
  main.innerHTML = '<h1>フレンド</h1><div class="center">読み込み中…</div>';
  let data;
  try { data = await api('/api/friends'); }
  catch (e) {
    if (alive()) main.innerHTML = `<h1>フレンド</h1><div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  const friends = data.friends;
  let favOnly = !!loadPref('friendsFav', false);
  let group = '';
  const groups = (data.fav_status.groups || []).map(g => g.name);

  main.innerHTML = `
    <h1>フレンド <span class="muted" style="font-size:15px" id="fr-count"></span></h1>
    ${favWarnHtml(data.fav_status)}
    ${liveWarnHtml(data.live_status, data.fav_status)}
    <div class="chips">
      ${favChip('fr-fav', favOnly)}
      ${groups.length ? `<select id="fr-group">
        <option value="">すべてのグループ</option>
        ${groups.map(g => `<option value="${esc(g)}">★ ${esc(g)}</option>`).join('')}
      </select>` : ''}
      <input type="search" id="fr-q" placeholder="名前で検索">
      <select id="fr-sort">
        <option value="online">オンライン優先</option>
        <option value="name">名前順</option>
        <option value="trust">Trustレベル順</option>
        <option value="number">フレンド番号順</option>
        <option value="seen">最終確認順</option>
      </select>
    </div>
    <div class="card" style="padding:8px 12px"><div class="table-scroll">
      <table class="list">
        <thead><tr><th>名前</th><th class="hide-m">Trust</th><th class="hide-m">ステータス</th><th class="loc-cell">場所</th><th class="num">最終確認</th><th class="hide-m">#</th></tr></thead>
        <tbody id="fr-body"></tbody>
      </table>
    </div></div>`;

  const trustRank = { 'Trusted User': 0, 'Known User': 1, 'User': 2, 'New User': 3, 'Visitor': 4 };
  const render = () => {
    const q = $('#fr-q').value.trim().toLowerCase();
    const sort = $('#fr-sort').value;
    const rows = friends.filter(f =>
      (!favOnly || f.is_fav)
      && (!group || (f.fav_groups || []).includes(group))
      && (!q || f.display_name.toLowerCase().includes(q)));
    const cmp = {
      online: (a, b) => (b.is_online - a.is_online) || (b.last_seen || '').localeCompare(a.last_seen || ''),
      name: (a, b) => a.display_name.localeCompare(b.display_name, 'ja'),
      trust: (a, b) => (trustRank[a.trust_level] ?? 9) - (trustRank[b.trust_level] ?? 9) || a.display_name.localeCompare(b.display_name, 'ja'),
      number: (a, b) => (a.friend_number || 1e9) - (b.friend_number || 1e9),
      seen: (a, b) => (b.last_seen || '').localeCompare(a.last_seen || ''),
    }[sort];
    rows.sort(cmp);
    $('#fr-count').textContent = (favOnly || group || q)
      ? `${rows.length} / ${friends.length}人` : `${friends.length}人`;
    $('#fr-body').innerHTML = rows.map(f => `
      <tr class="clickable" data-user="${esc(f.user_id)}">
        <td class="name-cell"><div class="nm-wrap">
          ${pfpHtml(f.image, f.display_name, f.is_online ? statusColor(f.status) : '')}
          <div class="nm-txt">
            <div class="nm">${favMark(f.is_fav)} ${esc(f.display_name)}</div>
            ${f.status_description ? `<div class="feed-sub m-only ellip">${esc(f.status_description)}</div>` : ''}
          </div>
        </div></td>
        <td class="hide-m">${trustBadge(f.trust_level)}</td>
        <td class="ellip hide-m" style="max-width:180px">${statusChip(f.status, f.status_description)}</td>
        <td class="ellip loc-cell">${f.world_name ? esc(f.world_name) + locationBadges(f.location) : (f.is_online ? '<span class="muted">Private</span>' : '<span class="muted">—</span>')}</td>
        <td class="num" title="${esc(fmtFull(f.last_seen))}">${f.last_seen ? fmtRel(f.last_seen) : '—'}</td>
        <td class="num hide-m">${f.friend_number ?? ''}</td>
      </tr>`).join('') || '<tr><td colspan="6" class="center">該当なし</td></tr>';
  };
  render();
  $('#fr-fav').addEventListener('click', () => {
    favOnly = !favOnly;
    savePref('friendsFav', favOnly);
    $('#fr-fav').classList.toggle('on', favOnly);
    render();
  });
  if (groups.length) {
    $('#fr-group').addEventListener('change', (e) => { group = e.target.value; render(); });
  }
  $('#fr-q').addEventListener('input', render);
  $('#fr-sort').addEventListener('change', render);
}

async function pageGamelog() {
  setNav('gamelog');
  const alive = currentRoute();
  main.innerHTML = '<h1>ゲームログ</h1><div class="center">読み込み中…</div>';
  let data;
  try { data = await api('/api/gamelog', { limit: 200 }); }
  catch (e) {
    if (alive()) main.innerHTML = `<h1>ゲームログ</h1><div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  const rows = data.items.map(it => {
    if (it.kind === 'location') {
      return `<tr>
        <td class="num time-col" title="${esc(fmtFull(it.created_at))}">${fmtTime(it.created_at)}</td>
        <td><span class="world">${esc(it.world_name)}</span>${locationBadges(it.location)}</td>
        <td class="ellip hide-m">${esc(it.group_name || '')}</td>
        <td class="num">${fmtDur(it.time) || '—'}</td>
      </tr>`;
    }
    return `<tr>
      <td class="num time-col" title="${esc(fmtFull(it.created_at))}">${fmtTime(it.created_at)}</td>
      <td colspan="2">${it.type === 'OnPlayerJoined' ? 'Join' : 'Leave'}: ${userLink(it.user_id, it.display_name)}</td>
      <td class="num">${fmtDur(it.time) || ''}</td>
    </tr>`;
  }).join('');

  main.innerHTML = `
    <h1>ゲームログ <span class="muted" style="font-size:14px">自分のインスタンス履歴</span></h1>
    <div class="card" style="padding:8px 12px"><div class="table-scroll">
      <table class="list">
        <thead><tr><th class="num time-col">日時</th><th>ワールド / プレイヤー</th><th class="hide-m">グループ</th><th class="num">滞在</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="center">まだ記録がありません</td></tr>'}</tbody>
      </table>
    </div></div>`;
}

async function pageGraph() {
  setNav('graph');
  const alive = currentRoute();
  main.innerHTML = `
    <h1>フレンド相関グラフ</h1>
    <div class="chips">
      <input type="search" id="g-q" placeholder="名前で検索してハイライト">
      <span class="legend">${Object.entries(TRUST).map(([k, t]) =>
        `<span class="item"><span class="sw" style="background:${t.color};border-radius:50%"></span>${t.label}</span>`).join('')}
        <span class="item"><span class="sw" style="background:transparent;border:1.5px solid #eda100;border-radius:50%"></span>★お気に入り</span>
      </span>
    </div>
    <div id="graph-wrap"><canvas id="graph-canvas"></canvas></div>
    <div class="graph-hint">相互フレンド関係をリンクで表示。ドラッグで移動、ホイール/ピンチでズーム、ノードタップで詳細へ。</div>`;

  let data;
  try { data = await api('/api/graph'); }
  catch (e) {
    if (alive()) $('#graph-wrap').innerHTML = `<div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  const canvas = $('#graph-canvas');
  const wrap = $('#graph-wrap');
  const dpr = devicePixelRatio || 1;
  let W = wrap.clientWidth;
  let H = Math.max(420, Math.min(innerHeight - 230, 760));
  const applySize = () => {
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.height = H + 'px';
  };
  applySize();
  const ctx = canvas.getContext('2d');

  const nodes = data.nodes.map((n, i) => ({ ...n, i }));
  const links = data.links.map(([a, b]) => ({ source: a, target: b }));
  const neighbors = new Map();
  for (const l of data.links) {
    (neighbors.get(l[0]) || neighbors.set(l[0], new Set()).get(l[0])).add(l[1]);
    (neighbors.get(l[1]) || neighbors.set(l[1], new Set()).get(l[1])).add(l[0]);
  }

  const radius = n => 3 + Math.sqrt(n.deg || 0) * 0.9;
  let transform = d3.zoomIdentity;
  let hover = null;
  let highlight = null;

  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).distance(38).strength(0.25))
    .force('charge', d3.forceManyBody().strength(-42).theta(0.95))
    .force('center', d3.forceCenter(W / 2, H / 2))
    .force('collide', d3.forceCollide().radius(n => radius(n) + 2))
    .velocityDecay(0.32);
  onCleanup(() => sim.stop());

  const draw = () => {
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const focus = hover != null ? new Set([hover.i, ...(neighbors.get(hover.i) || [])]) : null;

    ctx.lineWidth = 0.6 / transform.k;
    for (const l of links) {
      const active = focus && (l.source.i === hover.i || l.target.i === hover.i);
      ctx.strokeStyle = active ? 'rgba(57,135,229,0.85)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      ctx.moveTo(l.source.x, l.source.y);
      ctx.lineTo(l.target.x, l.target.y);
      ctx.stroke();
    }
    for (const n of nodes) {
      const t = TRUST[n.trust];
      const dimmed = (focus && !focus.has(n.i)) || (highlight && !highlight.has(n.i));
      ctx.globalAlpha = dimmed ? 0.16 : 1;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius(n), 0, 2 * Math.PI);
      ctx.fillStyle = t ? t.color : '#898781';
      ctx.fill();
      if (n.fav && !dimmed) {
        ctx.strokeStyle = '#eda100';
        ctx.lineWidth = 1.4 / transform.k;
        ctx.stroke();
      }
      if ((hover && n.i === hover.i) || (highlight && highlight.has(n.i))) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5 / transform.k;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    const showAll = transform.k > 2.2;
    ctx.font = `${11 / transform.k}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const n of nodes) {
      const show = showAll || (hover && (n.i === hover.i || (focus && focus.has(n.i) && transform.k > 1.2)))
        || (highlight && highlight.has(n.i));
      if (!show) continue;
      if (highlight && !highlight.has(n.i) && !(hover && n.i === hover.i)) continue;
      ctx.fillStyle = '#c3c2b7';
      ctx.fillText(n.name, n.x, n.y - radius(n) - 3 / transform.k);
    }
    ctx.restore();
  };
  sim.on('tick', draw);
  onResize(() => {
    W = wrap.clientWidth;
    H = Math.max(420, Math.min(innerHeight - 230, 760));
    applySize();
    draw();
  });

  const pt = (e) => {
    const r = canvas.getBoundingClientRect();
    return transform.invert([e.clientX - r.left, e.clientY - r.top]);
  };

  d3.select(canvas)
    .call(d3.drag()
      .container(canvas)
      .subject((e) => {
        const [x, y] = pt(e.sourceEvent || e);
        return sim.find(x, y, 12 / transform.k);
      })
      .on('start', (e) => { if (!e.active) sim.alphaTarget(0.25).restart(); e.subject.fx = e.subject.x; e.subject.fy = e.subject.y; })
      .on('drag', (e) => {
        const [x, y] = pt(e.sourceEvent);
        e.subject.fx = x; e.subject.fy = y;
      })
      .on('end', (e) => { if (!e.active) sim.alphaTarget(0); e.subject.fx = null; e.subject.fy = null; }))
    .call(d3.zoom()
      .scaleExtent([0.25, 8])
      .filter((e) => {
        if (e.type === 'mousedown' || e.type === 'touchstart') {
          const src = e.touches ? e.touches[0] : e;
          return !sim.find(...pt(src), 12 / transform.k);
        }
        return true;
      })
      .on('zoom', (e) => { transform = e.transform; draw(); }));

  canvas.addEventListener('mousemove', (e) => {
    const [x, y] = pt(e);
    const n = sim.find(x, y, 14 / transform.k);
    if (n !== hover) { hover = n || null; draw(); }
    if (hover) {
      const t = TRUST[hover.trust];
      showTooltip(`<div class="t-title">${hover.fav ? '★ ' : ''}${esc(hover.name)}</div>
        <div class="t-row"><span class="sw" style="background:${t ? t.color : '#898781'};border-radius:50%"></span>${t ? t.label : esc(hover.trust || '')}</div>
        <div class="t-row">相互リンク ${hover.deg}</div>`, e.clientX, e.clientY);
      canvas.style.cursor = 'pointer';
    } else { hideTooltip(); canvas.style.cursor = 'grab'; }
  });
  canvas.addEventListener('mouseleave', () => { hover = null; hideTooltip(); draw(); });
  canvas.addEventListener('click', (e) => {
    const n = sim.find(...pt(e), 12 / transform.k);
    if (n) location.hash = '#/user/' + n.id;
  });

  $('#g-q').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    highlight = q ? new Set(nodes.filter(n => n.name.toLowerCase().includes(q)).map(n => n.i)) : null;
    if (highlight && !highlight.size) highlight = null;
    draw();
  });
}

async function pageNotifications() {
  setNav('notifications');
  const alive = currentRoute();
  main.innerHTML = '<h1>通知</h1><div class="center">読み込み中…</div>';
  let data;
  try { data = await api('/api/notifications', { limit: 100 }); }
  catch (e) {
    if (alive()) main.innerHTML = `<h1>通知</h1><div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  const typeLabel = t => ({
    'group.announcement': 'グループお知らせ',
    'group.event.created': 'グループイベント',
    'group.informative': 'グループ',
    'group.invite': 'グループ招待',
    'friendRequest': 'フレンド申請',
    'invite': 'インバイト',
  }[t] || t);

  main.innerHTML = `<h1>通知</h1>` + (data.items.length
    ? data.items.map(n => `
      <div class="card" style="padding:13px 18px;margin-bottom:10px">
        <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
          <span class="badge" style="margin-left:0">${esc(typeLabel(n.type))}</span>
          <b>${esc(n.title || '')}</b>
          <span class="muted" style="margin-left:auto;font-size:12px" title="${esc(fmtFull(n.created_at))}">${fmtRel(n.created_at)}</span>
        </div>
        ${n.message ? `<div style="color:var(--ink-2);margin-top:6px;white-space:pre-wrap">${esc(n.message.length > 400 ? n.message.slice(0, 400) + '…' : n.message)}</div>` : ''}
        ${n.sender_username ? `<div class="muted" style="font-size:12px;margin-top:4px">from ${esc(n.sender_username)}</div>` : ''}
      </div>`).join('')
    : '<div class="card center">通知はありません</div>');
}

async function pageUser(uid) {
  setNav('');
  const alive = currentRoute();
  main.innerHTML = '<div class="center">読み込み中…</div>';
  let data;
  try { data = await api('/api/user', { id: uid }); }
  catch (e) {
    if (alive()) main.innerHTML = `<div class="card center">${esc(e.message)}</div>`;
    return;
  }
  if (!alive()) return;

  const p = data.profile;
  const sessions30 = data.sessions.reduce((s, x) => s + Math.max(0, (x.is_open_tail ? Date.now() : x.end_at) - x.start_at), 0);

  main.innerHTML = `
    <span class="back-link" onclick="history.back()">← 戻る</span>
    <div class="user-head">
      ${pfpHtml(p.image, p.display_name, '', 'lg')}
      <h1>${p.is_fav ? '<span class="fav-mark" style="color:var(--fav)">★</span> ' : ''}${esc(p.display_name)}</h1>
      ${trustBadge(p.trust_level)}
      ${p.friend_number ? `<span class="muted">フレンド #${p.friend_number}</span>` : ''}
      ${p.is_friend ? '' : '<span class="badge" style="margin-left:0">フレンド外</span>'}
      ${favGroupPills(p.fav_groups)}
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:14px">${esc(p.user_id)}</div>
    ${data.note && data.note.note ? `<div class="note-block">📝 ${esc(data.note.note)}</div>` : ''}
    ${data.memo && data.memo.memo ? `<div class="note-block">🗒 ${esc(data.memo.memo)}</div>` : ''}
    <div class="tiles" style="margin-top:14px">
      <div class="tile"><div class="label">相互フレンド</div><div class="value">${data.mutuals.length}</div></div>
      <div class="tile"><div class="label">オンライン時間（30日・記録分）</div><div class="value">${fmtHours(sessions30)}</div></div>
      <div class="tile"><div class="label">セッション数（30日）</div><div class="value">${data.sessions.length}</div></div>
      <div class="tile"><div class="label">アバター（記録数）</div><div class="value">${data.avatars.length}</div></div>
    </div>
    <div class="grid cols-2">
      <div>
        <div class="card">
          <h2>最近のアクティビティ</h2>
          <div id="u-feed"></div>
          <div class="loadmore" id="u-more" hidden><button class="btn">さらに読み込む</button></div>
        </div>
      </div>
      <div>
        ${data.mutuals.length ? `<div class="card"><h2>相互フレンド</h2>
          <div class="mutual-chips">${data.mutuals.map(m =>
            `<span class="chip" data-user="${esc(m.user_id)}">${m.is_fav ? '★ ' : ''}${esc(m.display_name)}</span>`).join('')}</div></div>` : ''}
        ${data.avatars.length ? `<div class="card"><h2>使用アバター履歴</h2>
          <div class="table-scroll"><table class="list"><tbody>${data.avatars.map(a =>
            `<tr><td class="ava-cell">${a.image ? `<img class="ava-thumb zoomable" src="${esc(imgUrl(a.image))}" loading="lazy" alt="" title="タップで拡大" data-full="${esc(imgUrlFull(a.image))}" data-caption="${esc(a.avatar_name)}" onerror="this.remove()">` : ''}</td><td class="ellip">${esc(a.avatar_name)}</td><td class="num">${a.times}回</td><td class="num" title="${esc(fmtFull(a.last_used))}">${fmtRel(a.last_used)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
        ${data.friend_log.length ? `<div class="card"><h2>フレンドログ</h2>${data.friend_log.map(h =>
          `<div class="feed-row"><span class="feed-time">${fmtTime(h.created_at)}</span><div class="feed-body feed-detail">${esc(h.type)}${h.previous_display_name ? `: ${esc(h.previous_display_name)} → ${esc(h.display_name)}` : ''}${h.previous_trust_level ? `: ${esc(h.previous_trust_level)} → ${esc(h.trust_level)}` : ''}</div></div>`).join('')}</div>` : ''}
      </div>
    </div>`;

  const feedEl = $('#u-feed');
  const moreWrap = $('#u-more');
  let cursor = '';
  const loadFeed = async () => {
    try {
      const d = await api('/api/user_feed', { id: uid, before: cursor, limit: 40 });
      if (!alive()) return;
      feedEl.insertAdjacentHTML('beforeend', d.items.map(feedRowHtml).join(''));
      cursor = d.next;
      moreWrap.hidden = !cursor;
      if (!d.items.length && !feedEl.children.length) feedEl.innerHTML = '<div class="center">記録がありません</div>';
    } catch (e) {
      if (alive()) feedEl.insertAdjacentHTML('beforeend', `<div class="center">${esc(e.message)}</div>`);
    }
  };
  moreWrap.querySelector('button').addEventListener('click', loadFeed);
  loadFeed();
}

/* ---------------- accounts / freshness ---------------- */

async function initAccounts() {
  try {
    const data = await api('/api/accounts');
    const el = $('#acct-switch');
    if (!data.accounts || data.accounts.length < 2) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = data.accounts.map(a => `
      <span class="acct${a.idx === ACCT ? ' on' : ''}" data-acct="${a.idx}" title="${esc(a.label)}">
        <span class="n">${a.idx}</span><span class="label">${esc(a.label)}</span>
      </span>`).join('');
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-acct]');
      if (!t) return;
      const idx = +t.dataset.acct;
      if (idx !== ACCT) location.href = `/${idx}${location.hash || '#/dashboard'}`;
    });
  } catch (e) { /* single-account fallback */ }
}

async function refreshFreshness() {
  let el = $('#freshness');
  if (!el) return;
  try {
    const u = await api('/api/updates');
    el = $('#freshness');
    if (!el) return;
    if (!u.latest) { el.innerHTML = '<span class="dot"></span>データなし'; return; }
    const age = Date.now() - new Date(u.latest).getTime();
    const stale = age > 15 * 60e3;
    el.classList.toggle('stale', stale);
    el.innerHTML = `<span class="dot"></span>最終イベント ${fmtRel(u.latest)}` +
      (stale ? '<div style="margin-top:2px">VRCXからの更新が止まっている可能性</div>' : '');
  } catch (e) {
    el = $('#freshness');
    if (!el) return;
    el.classList.add('stale');
    el.innerHTML = '<span class="dot"></span>サーバーに接続できません';
  }
}
setInterval(refreshFreshness, 60e3);
refreshFreshness();
initAccounts();

/* ---------------- router ---------------- */

const routes = {
  dashboard: pageDashboard,
  locations: pageLocations,
  feed: pageFeed,
  friends: pageFriends,
  gamelog: pageGamelog,
  graph: pageGraph,
  notifications: pageNotifications,
};

function route() {
  runCleanup();
  const hash = location.hash || '#/dashboard';
  const mUser = hash.match(/^#\/user\/(usr_[0-9a-fA-F-]+)/);
  if (mUser) { pageUser(mUser[1]); return; }
  const name = (hash.match(/^#\/(\w+)/) || [])[1] || 'dashboard';
  (routes[name] || pageDashboard)();
  window.scrollTo(0, 0);
}

addEventListener('hashchange', route);
route();
