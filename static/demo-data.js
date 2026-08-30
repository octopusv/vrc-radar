/* VRC Radar demo dataset (/dev).

   Every user, world, avatar, and event in this module is fictional —
   nothing is read from the VRCX database or the VRChat API, and all
   "profile pictures" are generated SVG data URIs. The exported demoApi()
   answers the same JSON shapes the real backend would, so the SPA runs
   unchanged and the /dev page can be shown to anyone without exposing
   real friends. */

/* ---------------- deterministic generation ---------------- */

// mulberry32: same layout on every load, timestamps relative to "now"
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260830);
const rint = (a, b) => a + Math.floor(rand() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const NOW = Date.now();
const MIN = 60e3, HOUR = 3600e3, DAY = 86400e3;
const iso = (t) => new Date(t).toISOString();

const uid = (n) => `usr_00000000-0000-4000-a000-${String(n).padStart(12, '0')}`;
const wid = (n) => `wrld_00000000-0000-4000-b000-${String(n).padStart(12, '0')}`;
const OWN_ID = uid(900);

/* ---------------- generated images (SVG data URIs) ---------------- */

function art(label, hue, w = 96, h = 96) {
  const fs = Math.round(label.length > 1
    ? Math.min(h * 0.3, (w * 0.9) / label.length)
    : Math.min(w, h) * 0.46);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'>`
    + `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>`
    + `<stop offset='0' stop-color='hsl(${hue},46%,30%)'/>`
    + `<stop offset='1' stop-color='hsl(${(hue + 55) % 360},52%,15%)'/></linearGradient></defs>`
    + `<rect width='${w}' height='${h}' fill='url(#g)'/>`
    + `<circle cx='${Math.round(w * 0.8)}' cy='${Math.round(h * 0.22)}' r='${Math.round(h * 0.34)}'`
    + ` fill='hsl(${(hue + 95) % 360},55%,45%)' opacity='0.3'/>`
    + `<text x='50%' y='53%' text-anchor='middle' dominant-baseline='central'`
    + ` font-family='system-ui,sans-serif' font-weight='600' font-size='${fs}'`
    + ` fill='rgba(255,255,255,0.93)'>${label}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

const pfpImg = (name, hue) =>
  art((name || '?').trim().charAt(0).toUpperCase(), hue);

const AV_IMG = new Map();   // avatar name -> stable 4:3 preview image
function avImg(name) {
  if (!AV_IMG.has(name)) {
    let hue = 0;
    for (const c of name) hue = (hue + c.codePointAt(0) * 37) % 360;
    const label = name.length > 7 ? name.slice(0, 7) + '…' : name;
    AV_IMG.set(name, art(label, hue, 240, 180));
  }
  return AV_IMG.get(name);
}

/* ---------------- fictional roster ---------------- */

const GROUP_DEFS = [
  { key: 'group_0', name: 'よく遊ぶ' },
  { key: 'group_1', name: '寝落ち勢' },
  { key: 'group_2', name: 'イベント仲間' },
];

const AVATAR_NAMES = [
  'しろねこメイド', 'Cyber Fox v3', 'うさみみパーカー', 'ふゆごもりちゃん',
  'Aqua Marine', '黒猫ゴシック', 'パステルドラゴン', 'Neon Runner',
  'こぎつね和装', 'Starlit Witch', 'もちもちペンギン', 'Void Walker',
  'ひまわりワンピ', 'Chrome Bunny', '雨宿りフード', 'Sakura Frost',
];

// [name, trust level, hue, favorite group names]
const ROSTER = [
  ['みかづき', 'Trusted User', 210, ['よく遊ぶ']],
  ['Luno', 'Trusted User', 265, []],
  ['sora_v2', 'Known User', 195, []],
  ['ぽんず', 'Known User', 25, ['よく遊ぶ', '寝落ち勢']],
  ['Nachtfee', 'User', 285, []],
  ['きつね日和', 'Trusted User', 35, ['よく遊ぶ']],
  ['Vex', 'Known User', 0, []],
  ['まろん', 'User', 20, ['寝落ち勢']],
  ['Hikari_dev', 'User', 50, []],
  ['しらたま', 'New User', 330, []],
  ['Aster', 'Trusted User', 150, []],
  ['yuki*', 'Known User', 200, []],
  ['テト', 'User', 310, []],
  ['Mochizuki', 'Trusted User', 230, ['寝落ち勢']],
  ['GhostPepper', 'Known User', 10, []],
  ['ろく', 'User', 100, []],
  ['Nia', 'New User', 340, []],
  ['はなび', 'Known User', 15, ['イベント仲間']],
  ['Cider', 'User', 45, []],
  ['ミルフィ', 'User', 300, []],
  ['Kestrel', 'Trusted User', 175, ['イベント仲間']],
  ['あんこ', 'Known User', 350, []],
  ['Prism', 'New User', 260, []],
  ['灯-akari-', 'Visitor', 55, []],
  ['CoffeeBreak', 'Known User', 30, []],
  ['ゆずぽん', 'User', 60, ['よく遊ぶ']],
  ['Wraith04', 'Known User', 240, []],
  ['ことり', 'Trusted User', 130, ['イベント仲間', '寝落ち勢']],
];

const TRUST_BELOW = {
  'Trusted User': 'Known User', 'Known User': 'User', 'User': 'New User',
};

const FRIENDS = [];
{
  let fn = rint(1, 8);
  ROSTER.forEach(([name, trust, hue, fav], i) => {
    const avatars = [];
    const n = rint(2, 4);
    while (avatars.length < n) {
      const a = pick(AVATAR_NAMES);
      if (!avatars.includes(a)) avatars.push(a);
    }
    FRIENDS.push({
      i, id: uid(i + 1), name, trust, hue, fav, avatars,
      friend_number: fn, image: pfpImg(name, hue),
      friendedAt: NOW - rint(45, 720) * DAY,
      lastSeen: iso(NOW - rint(2 * 60, 20 * 24 * 60) * MIN),
      sessions: [], flog: [],
    });
    fn += rint(3, 28);
  });
}
const BY_ID = new Map(FRIENDS.map(f => [f.id, f]));

GROUP_DEFS.forEach(g => {
  g.count = FRIENDS.filter(f => f.fav.includes(g.name)).length;
});

/* ---------------- worlds / instances ---------------- */

const WORLDS = [
  { id: wid(1), name: 'ふわふわ雲の上ラウンジ' },
  { id: wid(2), name: 'Neon Alley Arcade' },
  { id: wid(3), name: 'こたつのある部屋' },
  { id: wid(4), name: '静かな図書館カフェ' },
  { id: wid(5), name: 'Moonlit Rooftop Bar' },
  { id: wid(6), name: '真夜中の水族館' },
  { id: wid(7), name: 'Sunset Pier' },
  { id: wid(8), name: '森のキャンプ場' },
  { id: wid(9), name: 'Retro Diner 1985' },
  { id: wid(10), name: '屋上プラネタリウム' },
  { id: wid(11), name: 'Crystal Cavern' },
  { id: wid(12), name: 'ねこカフェ・にゃんだふる' },
];

// the four instances friends currently occupy (Friends+ / Public / own / Group+)
const INSTANCES = [
  { w: 0, loc: `${WORLDS[0].id}:34521~hidden(${uid(1)})~region(jp)`, group: '' },
  { w: 1, loc: `${WORLDS[1].id}:87730~region(us)`, group: '' },
  { w: 2, loc: `${WORLDS[2].id}:12083~friends(${OWN_ID})~region(jp)`, group: '', own: true },
  { w: 3, loc: `${WORLDS[3].id}:55610~group(grp_00000000-0000-4000-c000-000000000001)~groupAccessType(plus)~region(jp)`, group: '夜ふかし読書会' },
];

const INSTANCE_GROUPS = ['夜ふかし読書会', 'アバター試着会', 'ワールド巡り部'];

function randLoc() {
  const w = pick(WORLDS);
  const tail = pick([
    '', '', '',
    `~hidden(${uid(rint(1, 28))})`,
    `~friends(${uid(rint(1, 28))})`,
    `~private(${uid(rint(1, 28))})~canRequestInvite`,
  ]);
  const region = pick(['jp', 'jp', 'jp', 'us', 'eu']);
  return {
    id: w.id, name: w.name,
    loc: `${w.id}:${rint(10000, 99999)}${tail}~region(${region})`,
  };
}

/* ---------------- who is online right now ---------------- */

// [roster index, instance index (-1 private / -2 traveling), status, desc, online minutes]
const ONLINE_SPEC = [
  [0, 0, 'join me', 'まったり歓談中', 186],
  [1, 0, 'active', '', 122],
  [3, 0, 'active', '作業しながら', 63],
  [5, 0, 'ask me', '', 41],
  [6, 1, 'active', '', 95],
  [9, 1, 'join me', 'だれでもどうぞ！', 28],
  [13, 2, 'busy', '配信中', 132],
  [12, 2, 'active', '', 47],
  [17, 3, 'ask me', 'イベントのリハ中', 74],
  [10, -1, 'ask me', '', 205],
  [19, -2, 'join me', '', 8],
];

const PRESENCE = new Map();   // roster index -> live state
for (const [i, inst, status, desc, sinceMin] of ONLINE_SPEC) {
  const locatedMin = Math.max(2, Math.round(sinceMin * 0.4));
  PRESENCE.set(i, {
    inst, status, desc,
    online_since: iso(NOW - sinceMin * MIN),
    located_at: iso(NOW - locatedMin * MIN),
  });
  FRIENDS[i].lastSeen = iso(NOW - sinceMin * MIN);
}

/* ---------------- feed events (30 days) ---------------- */

const STATUS_POOL = ['join me', 'active', 'active', 'ask me', 'busy'];
const DESC_POOL = ['', '', '', 'まったり', '作業中', '寝落ちするかも',
  'フレリク開放中', 'お誘い歓迎', '低浮上', '歌の練習中', '写真撮ってます'];
const BIO_POOL = [
  'のんびりVRChatしてます。フレリクはお気軽に！',
  '週末の夜によくいます 🌙',
  'ワールド巡りが好き / 写真撮ってます 📷',
  'アバター改変沼の住人',
  '最近は音楽イベントによく出没します',
  'VR睡眠を極めたい',
  '日本語 / English OK!',
  '木曜以外の夜にいます。お誘いはいつでも歓迎',
];

// two-hump hour-of-day weighting so the 24h activity chart looks alive
const HOUR_POOL = [];
[3, 3, 2, 2, 1, 1, 1, 1, 2, 2, 2, 3, 3, 3, 2, 2, 1, 1, 1, 1, 2, 2, 3, 3]
  .forEach((w, h) => { for (let j = 0; j < w; j++) HOUR_POOL.push(h); });

const KIND_POOL = ['gps', 'gps', 'gps', 'gps', 'online', 'online', 'online',
  'status', 'avatar', 'bio'];

const FRIEND_POOL = [];
FRIENDS.forEach((f, i) => {
  const w = 1 + (f.fav.length ? 2 : 0) + (f.trust === 'Trusted User' ? 1 : 0);
  for (let j = 0; j < w; j++) FRIEND_POOL.push(i);
});

const EVENTS = [];
for (let day = 0; day < 30; day++) {
  const n = rint(24, 60) + (day === 0 ? 12 : 0);
  for (let k = 0; k < n; k++) {
    const t = NOW - day * DAY - pick(HOUR_POOL) * HOUR
      - rint(0, 59) * MIN - rint(0, 59) * 1e3;
    const f = FRIENDS[pick(FRIEND_POOL)];
    const kind = pick(KIND_POOL);
    const e = {
      kind, created_at: iso(t), user_id: f.id, display_name: f.name,
    };
    if (kind === 'gps') {
      const to = randLoc();
      const from = rand() < 0.85 ? randLoc() : null;
      e.location = to.loc;
      e.world_name = to.name;
      e.previous_location = from ? from.loc : '';
      e.previous_world_name = from ? from.name : '';
      e.time = from ? rint(8, 150) * MIN : 0;
      e.group_name = rand() < 0.15 ? pick(INSTANCE_GROUPS) : '';
    } else if (kind === 'online') {
      const on = rand() < 0.5;
      const l = on && rand() < 0.7 ? randLoc() : null;
      e.type = on ? 'Online' : 'Offline';
      e.location = l ? l.loc : '';
      e.world_name = l ? l.name : '';
      e.time = on ? 0 : rint(20, 260) * MIN;
    } else if (kind === 'status') {
      e.status = pick(STATUS_POOL);
      e.status_description = pick(DESC_POOL);
      e.previous_status = pick(STATUS_POOL);
      e.previous_status_description = pick(DESC_POOL);
    } else if (kind === 'avatar') {
      const av = pick(f.avatars);
      e.avatar_name = av;
      e.owner_id = f.id;
      e.image = avImg(av);
      e.previous_image = rand() < 0.8 ? avImg(pick(f.avatars)) : '';
    } else {
      e.bio = pick(BIO_POOL);
      e.previous_bio = rand() < 0.6 ? pick(BIO_POOL) : '';
    }
    EVENTS.push(e);
  }
}
EVENTS.sort((a, b) => b.created_at.localeCompare(a.created_at));
EVENTS.forEach((e, i) => { e.id = EVENTS.length - i; });

/* ---------------- per-friend sessions (30 days) ---------------- */

for (const f of FRIENDS) {
  const p = 0.25 + (f.fav.length ? 0.35 : 0)
    + (f.trust === 'Trusted User' ? 0.15 : 0);
  for (let day = 0; day < 30; day++) {
    if (rand() >= p) continue;
    const m = rand() < 0.25 ? 2 : 1;
    for (let s = 0; s < m; s++) {
      const start = NOW - day * DAY - rint(2, 20) * HOUR - rint(0, 59) * MIN;
      const end = Math.min(start + rint(40, 320) * MIN, NOW);
      if (end > start) f.sessions.push({ start_at: start, end_at: end, is_open_tail: 0 });
    }
  }
  const live = PRESENCE.get(f.i);
  if (live) {
    f.sessions.push({
      start_at: new Date(live.online_since).getTime(),
      end_at: NOW, is_open_tail: 1,
    });
  }
  f.sessions.sort((a, b) => a.start_at - b.start_at);
}

/* ---------------- friend log history ---------------- */

for (const f of FRIENDS) {
  let id = 1;
  f.flog.push({
    id: id++, created_at: iso(f.friendedAt), type: 'Friend',
    display_name: f.name, previous_display_name: '',
    trust_level: '', previous_trust_level: '',
  });
  if (TRUST_BELOW[f.trust] && rand() < 0.7) {
    f.flog.push({
      id: id++, created_at: iso(NOW - rint(5, 40) * DAY), type: 'TrustLevel',
      display_name: f.name, previous_display_name: '',
      trust_level: f.trust, previous_trust_level: TRUST_BELOW[f.trust],
    });
  }
  if (rand() < 0.18) {
    f.flog.push({
      id: id++, created_at: iso(NOW - rint(10, 200) * DAY), type: 'DisplayName',
      display_name: f.name, previous_display_name: f.name + '_v1',
      trust_level: '', previous_trust_level: '',
    });
  }
  f.flog.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

const NOTES = {
  0: '初めて会ったのは屋上プラネタリウム。ワールド情報にとても詳しい',
  13: '配信者さん。コラボの相談は木曜以外でとのこと',
};
const MEMOS = {
  3: '誕生日 7/22 🎂 / 好きな飲み物はメロンソーダ',
};

/* ---------------- mutual graph ---------------- */

const LINKS = [];
{
  const seen = new Set();
  const add = (a, b) => {
    if (a === b) return;
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) return;
    seen.add(key);
    LINKS.push(a < b ? [a, b] : [b, a]);
  };
  const clusters = [
    [0, 1, 3, 5, 8, 13, 22, 25, 27],
    [6, 9, 12, 15, 19, 24, 26],
    [2, 4, 10, 17, 21, 23],
    [7, 11, 14, 16, 18, 20],
    [0, 13, 17, 20, 27],
    [3, 6, 25, 12],
  ];
  for (const c of clusters) {
    for (let a = 0; a < c.length; a++) {
      for (let b = a + 1; b < c.length; b++) {
        if (rand() < 0.5) add(c[a], c[b]);
      }
    }
  }
  for (let j = 0; j < 10; j++) add(rint(0, 27), rint(0, 27));
}
const DEG = FRIENDS.map(() => 0);
const NEIGHBORS = FRIENDS.map(() => []);
for (const [a, b] of LINKS) {
  DEG[a]++; DEG[b]++;
  NEIGHBORS[a].push(b); NEIGHBORS[b].push(a);
}

/* ---------------- own game log ---------------- */

const GAMELOG = [];
{
  let id = 1;
  const row = (r) => GAMELOG.push({ id: id++, ...r });
  // current visit: the "own" kotatsu instance the radar page also shows
  const curStart = NOW - 52 * MIN;
  row({
    kind: 'location', created_at: iso(curStart), location: INSTANCES[2].loc,
    world_id: WORLDS[2].id, world_name: WORLDS[2].name, time: null, group_name: '',
  });
  for (const [fi, joinMin] of [[13, 47], [12, 33]]) {
    row({
      kind: 'join_leave', created_at: iso(NOW - joinMin * MIN),
      type: 'OnPlayerJoined', display_name: FRIENDS[fi].name,
      location: INSTANCES[2].loc, user_id: FRIENDS[fi].id, time: null,
    });
  }
  // earlier visits going back a few days
  let cursor = curStart;
  for (let v = 0; v < 14; v++) {
    const end = cursor - rint(10, 300) * MIN;
    const dur = rint(25, 170) * MIN;
    const start = end - dur;
    const l = randLoc();
    row({
      kind: 'location', created_at: iso(start), location: l.loc,
      world_id: l.id, world_name: l.name, time: dur,
      group_name: rand() < 0.25 ? pick(INSTANCE_GROUPS) : '',
    });
    for (let j = rint(0, 3); j > 0; j--) {
      const f = FRIENDS[rint(0, FRIENDS.length - 1)];
      const jt = start + rint(1, Math.max(2, Math.floor(dur / MIN) - 10)) * MIN;
      const stay = rint(5, Math.max(6, Math.floor((end - jt) / MIN))) * MIN;
      row({
        kind: 'join_leave', created_at: iso(jt), type: 'OnPlayerJoined',
        display_name: f.name, location: l.loc, user_id: f.id, time: null,
      });
      if (jt + stay < end) {
        row({
          kind: 'join_leave', created_at: iso(jt + stay), type: 'OnPlayerLeft',
          display_name: f.name, location: l.loc, user_id: f.id, time: stay,
        });
      }
    }
    cursor = start;
  }
  GAMELOG.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/* ---------------- notifications ---------------- */

const NOTIFS = [
  ['group.announcement', '金曜ワールド巡り、今週は22時集合！',
    '今週の行き先は「Crystal Cavern」。集合はいつものラウンジで、遅刻参加も歓迎です🍀', '', 3],
  ['invite', 'インバイト', '「真夜中の水族館」に招待されました', 'ぽんず', 5],
  ['friendRequest', 'フレンドリクエスト', '', 'Comet_9', 9],
  ['group.event.created', 'アバター試着会 vol.12',
    '9/6(土) 21:00〜 参加自由。新作アバターの試着スペースを用意します', '', 26],
  ['group.invite', 'バーチャル天文部', 'グループに招待されました', 'Kestrel', 50],
  ['group.announcement', '写真コンテスト結果発表📷',
    '今月のテーマ「夜景」の入賞作品を発表しました。たくさんのご参加ありがとうございました！', '', 70],
  ['invite', 'インバイト', '「Retro Diner 1985」に招待されました', 'はなび', 96],
].map(([type, title, message, sender, hoursAgo], i) => ({
  id: i + 1, created_at: iso(NOW - hoursAgo * HOUR - rint(0, 50) * MIN),
  type, title, message, sender_username: sender, link: '', link_text: '',
}));

/* ---------------- API answers ---------------- */

const favStatus = () => ({
  ok: true, error: '',
  groups: GROUP_DEFS.map(g => ({ key: g.key, name: g.name, count: g.count })),
  fetched_at: iso(NOW - 4 * MIN),
});
const liveStatus = () => ({ ok: true, error: '', fetched_at: iso(Date.now() - 35e3) });

function presenceEntry(f) {
  const p = PRESENCE.get(f.i);
  if (!p) return null;
  const inst = p.inst >= 0 ? INSTANCES[p.inst] : null;
  return {
    online_since: p.online_since,
    located_at: p.located_at,
    location: inst ? inst.loc : '',
    world_name: inst ? WORLDS[inst.w].name : '',
    state: p.inst === -1 ? 'private' : p.inst === -2 ? 'traveling' : '',
    status: p.status,
    status_description: p.desc,
  };
}

function apiSummary() {
  const online = [];
  for (const f of FRIENDS) {
    const p = presenceEntry(f);
    if (!p) continue;
    online.push({
      user_id: f.id, display_name: f.name, online_since: p.online_since,
      location: p.location || p.state, world_name: p.world_name,
      status: p.status, status_description: p.status_description,
      is_fav: f.fav.length > 0, fav_groups: f.fav, image: f.image,
    });
  }
  online.sort((a, b) => b.online_since.localeCompare(a.online_since));
  const cutoff = iso(NOW - DAY);
  return {
    friends_total: FRIENDS.length,
    online_count: online.length,
    online_friends: online,
    events_24h: EVENTS.filter(e => e.created_at >= cutoff).length,
    latest_event_at: EVENTS[0] ? EVENTS[0].created_at : '',
    own_last_location: {
      created_at: iso(NOW - 52 * MIN), location: INSTANCES[2].loc,
      world_id: WORLDS[2].id, world_name: WORLDS[2].name,
      group_name: '', time: null,
    },
    fav_status: favStatus(),
    live_status: liveStatus(),
    server_time: iso(Date.now()),
  };
}

function apiLocations() {
  const instances = INSTANCES.map(inst => ({
    location: inst.loc,
    world_id: WORLDS[inst.w].id,
    world_name: WORLDS[inst.w].name,
    group_name: inst.group,
    is_own: !!inst.own,
    friends: [],
  }));
  const hidden = [];
  for (const f of FRIENDS) {
    const p = presenceEntry(f);
    if (!p) continue;
    const entry = {
      user_id: f.id, display_name: f.name, trust_level: f.trust,
      since: p.located_at, status: p.status,
      status_description: p.status_description,
      is_fav: f.fav.length > 0, fav_groups: f.fav, image: f.image,
    };
    if (p.state) hidden.push({ ...entry, state: p.state });
    else instances[PRESENCE.get(f.i).inst].friends.push(entry);
  }
  for (const inst of instances) {
    inst.friends.sort((a, b) => b.since.localeCompare(a.since));
    inst.count = inst.friends.length;
    inst.fav_count = inst.friends.filter(f => f.is_fav).length;
    inst.newest = inst.friends.length ? inst.friends[0].since : '';
  }
  instances.sort((a, b) => b.count - a.count || b.newest.localeCompare(a.newest));
  hidden.sort((a, b) => b.since.localeCompare(a.since));
  return {
    instances, hidden,
    online_count: instances.reduce((s, i) => s + i.count, 0) + hidden.length,
    own_location: INSTANCES[2].loc,
    own_world_name: WORLDS[2].name,
    fav_status: favStatus(),
    live_status: liveStatus(),
    server_time: iso(Date.now()),
  };
}

function pageOf(items, params, maxLimit, defLimit) {
  const limit = Math.min(Math.max(+(params.limit || defLimit) || defLimit, 1), maxLimit);
  if (params.before) items = items.filter(e => e.created_at < params.before);
  const page = items.slice(0, limit);
  return { items: page, next: page.length === limit ? page[page.length - 1].created_at : '' };
}

function apiFeed(params) {
  const kinds = new Set((params.types || 'gps,online,status,avatar,bio')
    .split(',').filter(Boolean));
  const q = (params.q || '').trim().toLowerCase();
  let items = EVENTS.filter(e => kinds.has(e.kind));
  if (params.fav === '1') {
    items = items.filter(e => (BY_ID.get(e.user_id) || {}).fav?.length);
  }
  if (q) items = items.filter(e => e.display_name.toLowerCase().includes(q));
  const out = pageOf(items, params, 200, 50);
  if (params.fav === '1') out.fav_status = favStatus();
  return out;
}

function apiFriends() {
  return {
    friends: FRIENDS.map(f => {
      const p = presenceEntry(f);
      return {
        user_id: f.id, display_name: f.name, trust_level: f.trust,
        friend_number: f.friend_number,
        is_online: !!p,
        last_seen: p ? p.online_since : f.lastSeen,
        location: p ? p.location : '',
        world_name: p ? p.world_name : '',
        status: p ? p.status : '',
        status_description: p ? p.status_description : '',
        is_fav: f.fav.length > 0, fav_groups: f.fav, image: f.image,
      };
    }),
    fav_status: favStatus(),
    live_status: liveStatus(),
  };
}

function apiUser(params) {
  const f = BY_ID.get(params.id);
  if (!f) {
    return {
      profile: {
        user_id: params.id || '', display_name: '不明なユーザー',
        trust_level: '', friend_number: null, is_friend: false,
        is_fav: false, fav_groups: [], image: '',
      },
      note: null, memo: null, mutuals: [], friend_log: [],
      avatars: [], sessions: [], fav_status: favStatus(),
    };
  }
  const mutuals = NEIGHBORS[f.i].map(j => ({
    user_id: FRIENDS[j].id, display_name: FRIENDS[j].name,
    is_friend: true, is_fav: FRIENDS[j].fav.length > 0,
  })).sort((a, b) => a.display_name.localeCompare(b.display_name, 'ja'));
  const cutoff = NOW - 30 * DAY;
  return {
    profile: {
      user_id: f.id, display_name: f.name, trust_level: f.trust,
      friend_number: f.friend_number, is_friend: true,
      is_fav: f.fav.length > 0, fav_groups: f.fav, image: f.image,
    },
    note: NOTES[f.i] ? { note: NOTES[f.i], created_at: iso(NOW - 33 * DAY) } : null,
    memo: MEMOS[f.i] ? { memo: MEMOS[f.i], edited_at: iso(NOW - 12 * DAY) } : null,
    mutuals,
    friend_log: f.flog,
    avatars: f.avatars.map((a, j) => ({
      avatar_name: a, times: rint(1, 40) + j,
      last_used: iso(NOW - (j * rint(2, 6) + (PRESENCE.get(f.i) ? 0 : 1)) * DAY - rint(1, 20) * HOUR),
      image: avImg(a),
    })),
    sessions: f.sessions.filter(s => s.end_at >= cutoff || s.is_open_tail),
    fav_status: favStatus(),
  };
}

function apiUserFeed(params) {
  return pageOf(EVENTS.filter(e => e.user_id === params.id), params, 200, 50);
}

function apiGamelog(params) {
  return pageOf(GAMELOG, params, 300, 100);
}

function apiGraph() {
  return {
    nodes: FRIENDS.map(f => ({
      id: f.id, name: f.name, trust: f.trust, deg: DEG[f.i],
      fav: f.fav.length > 0,
    })),
    links: LINKS,
    fav_status: favStatus(),
  };
}

function apiNotifications(params) {
  return pageOf(NOTIFS, params, 200, 50);
}

function apiActivity(params) {
  const days = [1, 7, 30].includes(+params.days) ? +params.days : 7;
  const cutoff = iso(NOW - days * DAY);
  const series = { gps: {}, online: {}, status: {}, avatar: {}, bio: {} };
  for (const e of EVENTS) {
    if (e.created_at < cutoff) break;   // EVENTS is sorted desc
    const b = e.created_at.slice(0, 13);
    series[e.kind][b] = (series[e.kind][b] || 0) + 1;
  }
  const winStart = NOW - days * DAY;
  const top = FRIENDS.map(f => {
    let ms = 0;
    for (const s of f.sessions) {
      const end = s.is_open_tail ? NOW : Math.min(s.end_at, NOW);
      const start = Math.max(s.start_at, winStart);
      if (end > start) ms += end - start;
    }
    // 実装側は「同じインスタンスの重なり」だが、デモはセッション時間の
    // 一部を一緒にいた時間として見せる（meets/worldsは決定的に生成）
    ms = Math.round(ms * 0.4);
    return {
      user_id: f.id, display_name: f.name, ms,
      meets: Math.max(1, Math.min(days === 1 ? 2 : days, Math.round(ms / (3.5 * HOUR)))),
      worlds: [...new Set([WORLDS[f.i % WORLDS.length].name,
                           WORLDS[(f.i * 7 + 3) % WORLDS.length].name])],
    };
  }).filter(r => r.ms > 0).sort((a, b) => b.ms - a.ms).slice(0, 15);
  return { days, series, top_friends: top, server_time: iso(Date.now()) };
}

function apiUpdates(params) {
  let count = 0;
  if (params.after) {
    for (const e of EVENTS) {
      if (e.created_at > params.after) count++;
      else break;
    }
  }
  return { latest: EVENTS[0] ? EVENTS[0].created_at : '', new_count: count };
}

const ROUTES = {
  '/api/accounts': () => ({ accounts: [{ idx: 1, label: 'デモアカウント', user: OWN_ID }] }),
  '/api/favorites': () => ({
    ...favStatus(),
    total: FRIENDS.filter(f => f.fav.length).length,
  }),
  '/api/summary': apiSummary,
  '/api/locations': apiLocations,
  '/api/feed': apiFeed,
  '/api/friends': apiFriends,
  '/api/user': apiUser,
  '/api/user_feed': apiUserFeed,
  '/api/gamelog': apiGamelog,
  '/api/graph': apiGraph,
  '/api/notifications': apiNotifications,
  '/api/activity': apiActivity,
  '/api/updates': apiUpdates,
};

export function demoApi(path, params) {
  const fn = ROUTES[path];
  if (!fn) return Promise.reject(new Error(`demo: unknown endpoint ${path}`));
  // a touch of latency so loading states render believably
  return new Promise(resolve =>
    setTimeout(() => resolve(fn(params || {})), 120 + Math.random() * 180));
}
