const API = 'https://api.sleeper.app/v1';
const DEFAULT_LEAGUE_ID = '1313658287350087680';
const PLAYERS_CACHE_KEY = 'sleeper_dash_players_cache_v1';
const PLAYERS_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const FANTASY_POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF']);
const FLEX_ELIGIBLE = new Set(['RB', 'WR', 'TE']);
const SUPERFLEX_ELIGIBLE = new Set(['QB', 'RB', 'WR', 'TE']);
const BENCH_CUSHION = { QB: 1, RB: 2, WR: 2, TE: 1, K: 0, DEF: 0 };
// K/DEF are conventionally streamed, not stockpiled — depth heuristics only apply to skill positions.
const DEPTH_TRACKED_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
const BAD_INJURY_STATUSES = new Set(['Questionable', 'Doubtful', 'Out', 'IR', 'PUP', 'Suspended', 'NA']);

const state = {
  leagueId: null,
  league: null,
  rosters: [],
  users: [],
  players: {},
  nflState: null,
  trendingAdd: [],
  trendingDrop: [],
  weekMatchups: [],
  myUserId: null,
  refreshTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

function showError(msg) {
  const banner = $('#error-banner');
  banner.textContent = msg;
  banner.hidden = false;
}
function clearError() {
  $('#error-banner').hidden = true;
}

// ---------- Players cache ----------
async function loadPlayers() {
  try {
    const raw = localStorage.getItem(PLAYERS_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (Date.now() - cached.ts < PLAYERS_CACHE_MAX_AGE_MS) {
        return cached.players;
      }
    }
  } catch (e) { /* ignore corrupt cache */ }

  const all = await fetchJSON(`${API}/players/nfl`);
  const trimmed = {};
  for (const [id, p] of Object.entries(all)) {
    if (p && FANTASY_POSITIONS.has(p.position)) trimmed[id] = {
      player_id: id,
      full_name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id,
      position: p.position,
      team: p.team,
      status: p.status,
      injury_status: p.injury_status,
      injury_body_part: p.injury_body_part,
    };
  }
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), players: trimmed }));
  } catch (e) { /* quota exceeded, fine to skip caching */ }
  return trimmed;
}

function getPlayer(id) {
  return state.players[id] || { player_id: id, full_name: id, position: '', team: '' };
}

// ---------- Data load ----------
async function loadAll(leagueId) {
  clearError();
  $('#loading-overlay').hidden = false;
  try {
    const [league, rosters, users, nflState, players] = await Promise.all([
      fetchJSON(`${API}/league/${leagueId}`),
      fetchJSON(`${API}/league/${leagueId}/rosters`),
      fetchJSON(`${API}/league/${leagueId}/users`),
      fetchJSON(`${API}/state/nfl`),
      loadPlayers(),
    ]);
    if (!league || league.error) throw new Error('League not found');

    state.leagueId = leagueId;
    state.league = league;
    state.rosters = rosters || [];
    state.users = users || [];
    state.nflState = nflState;
    state.players = players;

    const [trendingAdd, trendingDrop] = await Promise.all([
      fetchJSON(`${API}/players/nfl/trending/add?lookback_hours=24&limit=60`).catch(() => []),
      fetchJSON(`${API}/players/nfl/trending/drop?lookback_hours=24&limit=60`).catch(() => []),
    ]);
    state.trendingAdd = trendingAdd || [];
    state.trendingDrop = trendingDrop || [];

    state.weekMatchups = [];
    if (league.season === nflState.season && ['in_season', 'complete'].includes(league.status)) {
      const week = nflState.display_week || nflState.week;
      if (week) {
        state.weekMatchups = await fetchJSON(`${API}/league/${leagueId}/matchups/${week}`).catch(() => []);
      }
    }

    populateTeamSelector();
    renderAll();
    $('#last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.error(err);
    showError(`Couldn't load that league (${err.message}). Double-check the League ID.`);
  } finally {
    $('#loading-overlay').hidden = true;
  }
}

function myTeamStorageKey(leagueId) { return `sleeper_dash_myuser_${leagueId}`; }

function populateTeamSelector() {
  const select = $('#my-team-select');
  select.innerHTML = '<option value="">Select your team…</option>';
  const sortedUsers = [...state.users].sort((a, b) => displayName(a).localeCompare(displayName(b)));
  for (const u of sortedUsers) {
    select.appendChild(el('option', { value: u.user_id }, displayName(u)));
  }
  const saved = localStorage.getItem(myTeamStorageKey(state.leagueId));
  if (saved && state.users.some((u) => u.user_id === saved)) {
    select.value = saved;
    state.myUserId = saved;
  } else {
    state.myUserId = null;
  }
}

function displayName(user) {
  return (user.metadata && user.metadata.team_name) || user.display_name || 'Unnamed team';
}

function myRoster() {
  return state.rosters.find((r) => r.owner_id === state.myUserId) || null;
}

function userForRoster(roster) {
  return state.users.find((u) => u.user_id === roster.owner_id) || null;
}

function combinedFpts(settings, prefix) {
  if (!settings) return 0;
  return (settings[prefix] || 0) + (settings[`${prefix}_decimal`] || 0) / 100;
}

function scoringFormatLabel() {
  const rec = state.league?.scoring_settings?.rec;
  if (rec === 1) return 'PPR';
  if (rec === 0.5) return 'Half-PPR';
  return 'Standard';
}

function isFAAB() {
  return !!(state.league?.settings?.waiver_budget);
}

function sortedStandings() {
  return [...state.rosters].sort((a, b) => {
    const aw = (a.settings?.wins || 0) + (a.settings?.ties || 0) * 0.5;
    const bw = (b.settings?.wins || 0) + (b.settings?.ties || 0) * 0.5;
    if (bw !== aw) return bw - aw;
    return combinedFpts(b.settings, 'fpts') - combinedFpts(a.settings, 'fpts');
  });
}

// ---------- Roster need analysis ----------
function positionDepth(roster) {
  const depth = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  for (const pid of roster.players || []) {
    const p = getPlayer(pid);
    if (depth[p.position] !== undefined) depth[p.position]++;
  }
  return depth;
}

function starterSlotCounts() {
  const positions = state.league?.roster_positions || [];
  const counts = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
  let flex = 0, superflex = 0;
  for (const slot of positions) {
    if (counts[slot] !== undefined) counts[slot]++;
    else if (slot === 'FLEX' || slot === 'WRRB_FLEX') flex++;
    else if (slot === 'SUPER_FLEX') superflex++;
  }
  return { counts, flex, superflex };
}

function positionNeed(position, depthCount) {
  const { counts, flex, superflex } = starterSlotCounts();
  let starterShare = counts[position] || 0;
  if (FLEX_ELIGIBLE.has(position)) starterShare += flex / 3;
  if (SUPERFLEX_ELIGIBLE.has(position)) starterShare += superflex / 4;
  const recommended = Math.ceil(starterShare) + (BENCH_CUSHION[position] || 0);
  if (depthCount <= Math.ceil(starterShare)) return 'High';
  if (depthCount < recommended) return 'Medium';
  return 'Low';
}

// ---------- Rendering ----------
function renderAll() {
  renderOverview();
  renderMyTeam();
  renderStandings();
  renderWaiver();
  renderStrategy();
}

function statusChip(injuryStatus) {
  if (!injuryStatus || injuryStatus === 'Active') return null;
  let cls = 'status-warning';
  if (['Out', 'Doubtful', 'Suspended'].includes(injuryStatus)) cls = 'status-serious';
  if (['IR', 'PUP', 'NA'].includes(injuryStatus)) cls = 'status-critical';
  return el('span', { class: `status-chip ${cls}` }, injuryStatus);
}

function posBadge(pos) {
  return el('span', { class: `badge badge-pos-${pos}` }, pos);
}

function renderOverview() {
  const league = state.league;
  const stats = $('#overview-stats');
  stats.innerHTML = '';
  const roster = myRoster();
  const standings = sortedStandings();
  const myRank = roster ? standings.findIndex((r) => r.roster_id === roster.roster_id) + 1 : null;

  $('#league-name').textContent = league.name || 'Sleeper League';
  $('#league-meta').textContent = `${league.season} · ${scoringFormatLabel()} · ${league.total_rosters} teams · ${statusLabel(league.status)}`;
  const avatarImg = $('#league-avatar');
  if (league.avatar) {
    avatarImg.src = `https://sleepercdn.com/avatars/${league.avatar}`;
    avatarImg.hidden = false;
  } else {
    avatarImg.hidden = true;
  }

  const tiles = [];
  if (roster) {
    const w = roster.settings?.wins || 0, l = roster.settings?.losses || 0, t = roster.settings?.ties || 0;
    tiles.push(tile('My Record', `${w}-${l}${t ? '-' + t : ''}`, myRank ? `Rank #${myRank} of ${standings.length}` : ''));
    tiles.push(tile('Points For', combinedFpts(roster.settings, 'fpts').toFixed(1), ''));
    tiles.push(tile('Points Against', combinedFpts(roster.settings, 'fpts_against').toFixed(1), ''));
    if (isFAAB()) {
      const total = state.league.settings.waiver_budget;
      const used = roster.settings?.waiver_budget_used || 0;
      tiles.push(tile('FAAB Remaining', `$${total - used}`, `of $${total}`));
    } else {
      tiles.push(tile('Waiver Priority', `#${roster.settings?.waiver_position ?? '—'}`, 'lower = higher priority'));
    }
  } else {
    tiles.push(tile('My Team', 'Not selected', 'Pick your team above'));
  }
  tiles.push(tile('NFL Week', `${state.nflState?.display_week ?? state.nflState?.week ?? '—'}`, state.nflState?.season_type || ''));
  for (const t of tiles) stats.appendChild(t);

  const preview = $('#overview-standings-preview');
  preview.innerHTML = '';
  preview.appendChild(buildStandingsTable(standings.slice(0, 5)));
}

function tile(label, value, sub) {
  return el('div', { class: 'stat-tile' }, [
    el('div', { class: 'stat-label' }, label),
    el('div', { class: 'stat-value' }, value),
    sub ? el('div', { class: 'stat-sub' }, sub) : null,
  ]);
}

function statusLabel(status) {
  return { pre_draft: 'Pre-draft', drafting: 'Drafting', in_season: 'In season', complete: 'Complete' }[status] || status;
}

function buildStandingsTable(rosters) {
  const table = el('table', {});
  table.appendChild(el('thead', {}, el('tr', {}, [
    el('th', {}, '#'), el('th', {}, 'Team'), el('th', {}, 'Record'), el('th', {}, 'PF'), el('th', {}, 'PA'),
  ])));
  const tbody = el('tbody');
  const all = sortedStandings();
  rosters.forEach((r) => {
    const rank = all.findIndex((x) => x.roster_id === r.roster_id) + 1;
    const user = userForRoster(r);
    const isMe = state.myUserId && r.owner_id === state.myUserId;
    const w = r.settings?.wins || 0, l = r.settings?.losses || 0, t = r.settings?.ties || 0;
    tbody.appendChild(el('tr', { class: isMe ? 'me' : '' }, [
      el('td', {}, String(rank)),
      el('td', {}, user ? displayName(user) : `Roster ${r.roster_id}`),
      el('td', {}, `${w}-${l}${t ? '-' + t : ''}`),
      el('td', {}, combinedFpts(r.settings, 'fpts').toFixed(1)),
      el('td', {}, combinedFpts(r.settings, 'fpts_against').toFixed(1)),
    ]));
  });
  table.appendChild(tbody);
  return el('div', { class: 'table-scroll' }, table);
}

function renderStandings() {
  const container = $('#standings-table');
  container.innerHTML = '';
  if (!state.rosters.length) { container.appendChild(emptyState('No rosters yet.')); return; }
  container.appendChild(buildStandingsTable(sortedStandings()));
}

function emptyState(text) {
  return el('div', { class: 'empty-state' }, text);
}

function weekPointsFor(playerId) {
  if (!state.weekMatchups.length) return null;
  for (const m of state.weekMatchups) {
    if (m.players_points && playerId in m.players_points) return m.players_points[playerId];
  }
  return null;
}

function playerRowNode(playerId, slotLabel) {
  const p = getPlayer(playerId);
  const pts = weekPointsFor(playerId);
  const row = el('div', { class: 'player-row' });
  if (slotLabel) row.appendChild(posBadge(slotLabel));
  row.appendChild(el('span', { class: 'player-name' }, p.full_name));
  row.appendChild(el('span', { class: 'player-meta' }, [p.position, p.team].filter(Boolean).join(' · ')));
  const chip = statusChip(p.injury_status);
  if (chip) row.appendChild(chip);
  if (pts != null) row.appendChild(el('span', { class: 'player-meta' }, `${pts} pts`));
  return row;
}

function renderMyTeam() {
  const startersEl = $('#myteam-starters');
  const benchEl = $('#myteam-bench');
  const irCard = $('#myteam-ir-card');
  const irEl = $('#myteam-ir');
  startersEl.innerHTML = '';
  benchEl.innerHTML = '';
  irEl.innerHTML = '';
  irCard.hidden = true;

  const roster = myRoster();
  if (!roster) { startersEl.appendChild(emptyState('Select your team from the header to see your roster.')); return; }
  if (!roster.players || !roster.players.length) { startersEl.appendChild(emptyState('No players on this roster yet — draft hasn\'t happened.')); return; }

  const nonBenchSlots = (state.league.roster_positions || []).filter((s) => s !== 'BN');
  const starters = roster.starters || [];
  const wrap = el('div');
  starters.forEach((pid, i) => {
    if (pid === '0' || !pid) return;
    wrap.appendChild(playerRowNode(pid, nonBenchSlots[i] || 'FLEX'));
  });
  startersEl.appendChild(wrap.children.length ? wrap : emptyState('No starters set.'));

  const benchIds = (roster.players || []).filter(
    (pid) => !starters.includes(pid) && !(roster.reserve || []).includes(pid) && !(roster.taxi || []).includes(pid)
  );
  const benchWrap = el('div');
  benchIds.forEach((pid) => benchWrap.appendChild(playerRowNode(pid, 'BN')));
  benchEl.appendChild(benchWrap.children.length ? benchWrap : emptyState('No bench players.'));

  const irIds = [...(roster.reserve || []), ...(roster.taxi || [])];
  if (irIds.length) {
    irCard.hidden = false;
    (roster.reserve || []).forEach((pid) => irEl.appendChild(playerRowNode(pid, 'IR')));
    (roster.taxi || []).forEach((pid) => irEl.appendChild(playerRowNode(pid, 'TAXI')));
  }
}

function allRosteredIds() {
  const set = new Set();
  for (const r of state.rosters) for (const pid of r.players || []) set.add(pid);
  return set;
}

function renderWaiver() {
  const targetsEl = $('#waiver-targets');
  const dropsEl = $('#waiver-drops');
  targetsEl.innerHTML = '';
  dropsEl.innerHTML = '';

  const roster = myRoster();
  const rostered = allRosteredIds();
  const myDepth = roster ? positionDepth(roster) : null;

  const available = state.trendingAdd
    .filter((t) => !rostered.has(t.player_id))
    .map((t) => ({ ...t, player: getPlayer(t.player_id) }))
    .filter((t) => FANTASY_POSITIONS.has(t.player.position));

  if (!available.length) {
    targetsEl.appendChild(emptyState('No trending free agents found right now.'));
  } else {
    available.forEach((t) => {
      const need = (myDepth && DEPTH_TRACKED_POSITIONS.includes(t.player.position))
        ? positionNeed(t.player.position, myDepth[t.player.position]) : null;
      const row = el('div', { class: 'player-row' });
      row.appendChild(posBadge(t.player.position));
      row.appendChild(el('span', { class: 'player-name' }, t.player.full_name));
      row.appendChild(el('span', { class: 'player-meta' }, t.player.team || 'FA'));
      const chip = statusChip(t.player.injury_status);
      if (chip) row.appendChild(chip);
      row.appendChild(el('span', { class: 'player-meta' }, `+${t.count.toLocaleString()} adds/24h`));
      if (need) row.appendChild(el('span', { class: `need-${need}` }, `${need} need`));
      targetsEl.appendChild(row);
    });
  }

  if (roster) {
    const myDrops = state.trendingDrop.filter((t) => (roster.players || []).includes(t.player_id));
    if (!myDrops.length) {
      dropsEl.appendChild(emptyState('Nothing on your roster is trending down.'));
    } else {
      myDrops.forEach((t) => {
        const p = getPlayer(t.player_id);
        const row = el('div', { class: 'player-row' });
        row.appendChild(posBadge(p.position));
        row.appendChild(el('span', { class: 'player-name' }, p.full_name));
        const chip = statusChip(p.injury_status);
        if (chip) row.appendChild(chip);
        row.appendChild(el('span', { class: 'player-meta status-warning' }, `${t.count.toLocaleString()} drops/24h league-wide`));
        dropsEl.appendChild(row);
      });
    }
  } else {
    dropsEl.appendChild(emptyState('Select your team to see this.'));
  }
}

function insightNode(icon, cls, title, detail) {
  return el('div', { class: 'insight' }, [
    el('div', { class: `insight-icon ${cls}` }, icon),
    el('div', { class: 'insight-body' }, [
      el('div', { class: 'insight-title' }, title),
      el('div', { class: 'insight-detail' }, detail),
    ]),
  ]);
}

function renderStrategy() {
  const container = $('#strategy-list');
  container.innerHTML = '';
  const roster = myRoster();
  if (!roster) { container.appendChild(emptyState('Select your team from the header to see personalized suggestions.')); return; }
  if (!roster.players || !roster.players.length) {
    container.appendChild(insightNode('📋', 'status-good', 'Get ready to draft',
      'Your roster is empty — this league hasn\'t drafted yet. Come back after draft day for roster-specific advice.'));
    return;
  }

  const insights = [];
  const starters = roster.starters || [];

  // 1. Injured/out starters
  starters.forEach((pid) => {
    if (!pid || pid === '0') return;
    const p = getPlayer(pid);
    if (BAD_INJURY_STATUSES.has(p.injury_status)) {
      const severe = ['Out', 'Doubtful', 'IR', 'PUP', 'Suspended'].includes(p.injury_status);
      insights.push({
        icon: severe ? '🚨' : '⚠️',
        cls: severe ? 'status-critical' : 'status-warning',
        title: `${p.full_name} (${p.position}) is ${p.injury_status}`,
        detail: 'This player is starting on your roster. Line up a replacement from your bench or the waiver wire before kickoff.',
      });
    }
  });

  // 2. Position depth (skill positions only — K/DEF are meant to be streamed, not stockpiled)
  const depth = positionDepth(roster);
  for (const pos of DEPTH_TRACKED_POSITIONS) {
    const need = positionNeed(pos, depth[pos]);
    if (need === 'High') {
      insights.push({
        icon: '🧩', cls: 'status-critical',
        title: `Thin at ${pos} — only ${depth[pos]} rostered`,
        detail: 'You have no cushion at this position if a starter gets hurt or has a bye. Check the Waiver Targets tab for options.',
      });
    } else if (need === 'Medium') {
      insights.push({
        icon: '🔍', cls: 'status-warning',
        title: `Light depth at ${pos}`,
        detail: `${depth[pos]} rostered — one solid add here would give you real bye-week and injury insurance.`,
      });
    }
  }
  for (const pos of ['K', 'DEF']) {
    if (depth[pos] === 0) {
      insights.push({
        icon: '🚨', cls: 'status-critical',
        title: `No ${pos} on your roster`,
        detail: `You have an empty ${pos} starting slot. Grab any available one off waivers — even a low-upside streamer beats a zero.`,
      });
    }
  }

  // 3. Schedule luck: PF rank vs standings rank
  const standings = sortedStandings();
  const myRank = standings.findIndex((r) => r.roster_id === roster.roster_id) + 1;
  const byPF = [...state.rosters].sort((a, b) => combinedFpts(b.settings, 'fpts') - combinedFpts(a.settings, 'fpts'));
  const myPFRank = byPF.findIndex((r) => r.roster_id === roster.roster_id) + 1;
  const totalTeams = state.rosters.length;
  if (totalTeams >= 4 && (roster.settings?.wins || 0) + (roster.settings?.losses || 0) > 0) {
    if (myPFRank <= Math.ceil(totalTeams / 3) && myRank >= Math.ceil((2 * totalTeams) / 3)) {
      insights.push({
        icon: '📈', cls: 'status-good',
        title: 'Your scoring is ahead of your record',
        detail: `You rank #${myPFRank} in points scored but #${myRank} in the standings — that usually evens out. Keep the roster steady rather than panic-trading.`,
      });
    } else if (myPFRank >= Math.ceil((2 * totalTeams) / 3) && myRank <= Math.ceil(totalTeams / 3)) {
      insights.push({
        icon: '🎯', cls: 'status-warning',
        title: 'Your record is ahead of your scoring',
        detail: `You rank #${myRank} in the standings but only #${myPFRank} in points scored — schedule has been kind. Shore up depth now before it evens out.`,
      });
    }
  }

  // 4. Trade angles: my surplus vs others' need
  const others = state.rosters.filter((r) => r.roster_id !== roster.roster_id);
  const tradeAngles = [];
  for (const pos of DEPTH_TRACKED_POSITIONS) {
    if (positionNeed(pos, depth[pos]) !== 'Low') continue;
    for (const other of others) {
      const otherDepth = positionDepth(other);
      if (positionNeed(pos, otherDepth[pos]) === 'High') {
        const user = userForRoster(other);
        tradeAngles.push({ pos, name: user ? displayName(user) : `Roster ${other.roster_id}` });
      }
    }
  }
  tradeAngles.slice(0, 2).forEach((t) => {
    insights.push({
      icon: '🤝', cls: 'status-good',
      title: `Trade angle: your ${t.pos} surplus for ${t.name}'s need`,
      detail: `${t.name} is thin at ${t.pos} while you're deep there. Worth floating a trade before the waiver wire evens things out.`,
    });
  });

  if (!insights.length) {
    insights.push({ icon: '✅', cls: 'status-good', title: 'Your roster looks solid', detail: 'No injured starters and no glaring depth gaps right now — check Waiver Targets for upside adds.' });
  }

  insights.forEach((i) => container.appendChild(insightNode(i.icon, i.cls, i.title, i.detail)));
}

// ---------- Wiring ----------
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
}

function initTheme() {
  const saved = localStorage.getItem('sleeper_dash_theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  $('#theme-toggle').addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') ||
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('sleeper_dash_theme', next);
  });
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.leagueId) loadAll(state.leagueId);
  }, REFRESH_INTERVAL_MS);
}

function init() {
  initTheme();
  document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

  const input = $('#league-id-input');
  input.value = localStorage.getItem('sleeper_dash_league_id') || DEFAULT_LEAGUE_ID;

  $('#refresh-btn').addEventListener('click', () => {
    const id = input.value.trim();
    if (!id) return;
    localStorage.setItem('sleeper_dash_league_id', id);
    loadAll(id);
  });

  $('#my-team-select').addEventListener('change', (e) => {
    state.myUserId = e.target.value || null;
    if (state.myUserId) localStorage.setItem(myTeamStorageKey(state.leagueId), state.myUserId);
    else localStorage.removeItem(myTeamStorageKey(state.leagueId));
    renderAll();
  });

  loadAll(input.value.trim());
  scheduleAutoRefresh();
}

document.addEventListener('DOMContentLoaded', init);
