/**
 * app.js — LONGSHOT dashboard controller.
 *
 * Dark trading-desk aesthetic. Manages state, tabs, live/simulated odds,
 * weekly portfolio creation, and manual settlement.
 */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const S = {
  transport: null, // null = network, or localFetch function
  state: null,
  activeWeek: null,
  selectedDayIndex: 0,
  settings: null,
  quota: { remaining: null, used: null },
  marketScan: null,
  liveBoards: {},
};

const LS_KEY = 'longshot.oddsApiKey';

/* ───────────────────────── Transport & API ───────────────────────── */

async function api(path, opts = {}) {
  const fetcher = S.transport || window.fetch;
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const res = await fetcher(path, {
    ...opts,
    headers,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });

  if (!res.ok) {
    let errBody = null;
    try {
      errBody = await res.json();
    } catch {}
    const err = new Error(errBody?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = errBody?.code;
    throw err;
  }
  return res.json();
}

async function initTransport() {
  const badge = $('#storage-badge');
  badge.textContent = 'detecting…';

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch('/api/state', { signal: ctrl.signal });
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      if (data.runtime?.persistent === false) {
        // Vercel serverless with no writable disk -> switch to local browser engine
        await switchToLocal('Stateless Vercel host — running engine locally in browser with localStorage.');
        return;
      }
      // Server is persistent
      S.transport = null;
      badge.textContent = 'server';
      badge.className = 'storage-badge';
      return;
    }
  } catch {}

  // Fallback to in-browser local engine
  await switchToLocal('Server unreachable or timeout — running engine in browser.');
}

async function switchToLocal(reason) {
  const badge = $('#storage-badge');
  try {
    const { default: localFetch } = await import('/local-api.js?v=1.0.0');
    S.transport = localFetch;
    badge.textContent = 'localStorage';
    badge.className = 'storage-badge badge-local';
    badge.title = reason;
  } catch (err) {
    console.error('Failed to load local engine bundle:', err);
    badge.textContent = 'offline';
  }
}

/* ───────────────────────── Formatting Helpers ───────────────────────── */

function formatNaira(n) {
  const num = Number(n) || 0;
  const isNeg = num < 0;
  const abs = Math.abs(num);
  return `${isNeg ? '-' : ''}₦${abs.toLocaleString('en-NG', {
    minimumFractionDigits: abs % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(v, dp = 1) {
  return `${Number(v).toFixed(dp)}%`;
}

function round(v, dp = 2) {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/* ───────────────────────── State Loading ───────────────────────── */

async function loadState() {
  try {
    const st = await api('/api/state');
    S.state = st;
    S.settings = st.settings || {};
    S.activeWeek = st.activeWeek || null;

    // Restore locally saved API key into settings if server had none
    const savedKey = localStorage.getItem(LS_KEY);
    if (savedKey && !S.settings.oddsApi?.key) {
      S.settings.oddsApi = S.settings.oddsApi || {};
      S.settings.oddsApi.key = savedKey;
      await api('/api/settings', { method: 'POST', body: { oddsApi: { key: savedKey } } });
    }

    // Default today index
    if (S.activeWeek) {
      S.selectedDayIndex = S.activeWeek.todayIndex >= 0 ? S.activeWeek.todayIndex : 0;
    }

    renderAll();

    // Auto-create initial week if none exists
    if (!S.activeWeek) {
      await autoCreateInitialWeek();
    }
  } catch (err) {
    console.error('Failed to load state:', err);
    toast('Error loading engine state', err.message, 'err');
  }
}

async function autoCreateInitialWeek() {
  try {
    const key = S.settings?.oddsApi?.key || localStorage.getItem(LS_KEY) || '';
    const res = await api('/api/weeks', {
      method: 'POST',
      body: {
        goal: S.settings.goal || 2,
        apiKey: key,
      },
    });
    if (res.week) {
      S.activeWeek = res.week;
      S.selectedDayIndex = res.week.todayIndex >= 0 ? res.week.todayIndex : 0;
      renderAll();
    }
  } catch (err) {
    console.error('Auto week creation error:', err);
  }
}

/* ───────────────────────── Render Everything ───────────────────────── */

function renderAll() {
  renderTopbar();
  renderSimulatedBanner();
  renderWeekBoard();
  renderTodayTicket();
  renderMarketTab();
  renderSettingsTab();
}

function renderTopbar() {
  const week = S.activeWeek;
  const goalVal = $('#topbar-goal-val');
  const stakedVal = $('#topbar-staked-val');
  const returnedVal = $('#topbar-returned-val');
  const pnlVal = $('#topbar-pnl-val');
  const pnlPill = $('#topbar-pnl-pill');

  if (!week || !week.stats) {
    goalVal.textContent = '0.00 / 2';
    stakedVal.textContent = '₦0';
    returnedVal.textContent = '₦0';
    pnlVal.textContent = '₦0.00';
    pnlPill.className = 'metric-pill pnl-pill';
    return;
  }

  const s = week.stats;
  goalVal.textContent = `${s.expectedWins.toFixed(2)} / ${s.goal}`;
  stakedVal.textContent = formatNaira(s.totalStaked);
  returnedVal.textContent = formatNaira(s.totalReturned);
  pnlVal.textContent = formatNaira(s.netPnl);

  pnlPill.className = `metric-pill pnl-pill ${s.netPnl > 0 ? 'pnl-pos' : s.netPnl < 0 ? 'pnl-neg' : ''}`;

  // Quota pill
  const quotaPill = $('#topbar-quota-pill');
  const quotaText = $('#topbar-quota-text');
  if (S.quota.remaining !== null) {
    quotaPill.hidden = false;
    quotaText.textContent = `Quota: ${S.quota.remaining}`;
  } else {
    quotaPill.hidden = true;
  }
}

function renderSimulatedBanner() {
  const banner = $('#simulated-banner');
  const reasonEl = $('#simulated-reason');
  const week = S.activeWeek;

  if (!week) {
    banner.hidden = true;
    return;
  }

  // Find if any ticket fell back or is simulated
  const simTicket = week.tickets.find((t) => t.provider?.used === 'sim' || t.provider?.fellBack);
  if (simTicket) {
    banner.hidden = false;
    reasonEl.textContent =
      simTicket.provider?.reason ||
      'No Odds API key configured or fetch failed. These prices are simulated models of vig and noise, not real bookmaker quotes.';
  } else {
    banner.hidden = true;
  }
}

/* ───────────────────────── TAB 1: WEEK BOARD ───────────────────────── */

function renderWeekBoard() {
  const week = S.activeWeek;
  const title = $('#week-title');
  const subtitle = $('#week-subtitle');
  const counterChip = $('#issued-counter-chip');
  const verdictBanner = $('#verdict-banner');
  const verdictHeadline = $('#verdict-headline');
  const verdictSub = $('#verdict-sub');
  const goalRealityDesc = $('#goal-reality-desc');
  const goalRealitySub = $('#goal-reality-sub');
  const goalOddsBand = $('#goal-odds-band');
  const grid = $('#tickets-grid');

  if (!week) {
    title.textContent = 'No Active Portfolio';
    subtitle.textContent = 'Click "Build this week" to price 7 longshot accumulators.';
    grid.innerHTML = '<div class="empty-state"><p>No week active. Build a new weekly portfolio to begin.</p></div>';
    return;
  }

  title.textContent = `Week of ${week.mondayDate} – ${week.sundayDate}`;
  subtitle.textContent = `7 accumulators landing in 10.0 – 1000.0 odds (Africa/Lagos)`;

  const stats = week.stats;
  counterChip.textContent = `${stats.issuedCount} of 7 issued`;
  counterChip.className = `issued-counter ${stats.issuedCount === 7 ? '' : 'issued-partial'}`;

  // Verdict Banner
  if (stats.verdict) {
    verdictBanner.hidden = false;
    verdictHeadline.textContent = stats.verdict;
    verdictSub.textContent = `Current week P&L: ${formatNaira(stats.netPnl)} (${stats.wonCount} won, ${stats.lostCount} lost).`;
    if (stats.wonCount >= 2) triggerConfetti();
  } else {
    verdictBanner.hidden = true;
  }

  // Honest Goal Assessment
  const ga = stats.goalAssessment;
  if (ga) {
    goalRealityDesc.textContent = ga.analysis;
    goalRealitySub.textContent = ga.explanation;
    goalOddsBand.textContent = `Optimal Odds Band: ${ga.recommendedOddsBand}`;
  }

  // Render 7 Cards
  grid.innerHTML = '';
  for (const ticket of week.tickets) {
    const card = document.createElement('div');
    const isToday = ticket.isToday;
    const statusClass =
      ticket.status === 'won'
        ? 'ticket-won'
        : ticket.status === 'lost'
        ? 'ticket-lost'
        : !ticket.issued
        ? 'ticket-unissued'
        : '';

    card.className = `ticket-card ${isToday ? 'is-today' : ''} ${statusClass}`;

    const isSimulated = ticket.provider?.used === 'sim' || ticket.provider?.fellBack;
    const provBadge = isSimulated
      ? `<span class="prov-badge prov-sim" title="${ticket.provider?.reason || 'Simulated'}">SIMULATED</span>`
      : `<span class="prov-badge prov-live">LIVE</span>`;

    const statusBadge =
      ticket.status === 'won'
        ? `<span class="badge badge-won">WON</span>`
        : ticket.status === 'lost'
        ? `<span class="badge badge-lost">LOST</span>`
        : !ticket.issued
        ? `<span class="badge badge-unissued">UNISSUED</span>`
        : `<span class="badge badge-pending">PENDING</span>`;

    if (!ticket.issued || !ticket.slip) {
      card.innerHTML = `
        <div>
          <div class="ticket-head">
            <div>
              <h3 class="ticket-day-title">${ticket.dayName}</h3>
              <span class="ticket-date-sub">${ticket.date}</span>
            </div>
            <div class="ticket-badges">
              ${isToday ? '<span class="badge badge-today">TODAY</span>' : ''}
              ${statusBadge}
            </div>
          </div>
          <div style="padding: 24px 0; color: var(--dim); font-size: 13px;">
            <p><b>No Ticket Issued:</b> ${ticket.message}</p>
            <p class="panel-note">The engine refused to roll a coin-flip. Refusing is a feature.</p>
          </div>
        </div>
        <div class="ticket-provider-line">${provBadge} <span>Synchronous fallback</span></div>
      `;
      grid.appendChild(card);
      continue;
    }

    const s = ticket.slip;
    let settleHtml = '';
    if (ticket.status === 'pending') {
      settleHtml = `
        <div class="ticket-settlement-actions">
          <button class="btn-settle-action btn-won-sm" data-action="settle" data-day="${ticket.dayIndex}" data-outcome="won">✓ Won</button>
          <button class="btn-settle-action btn-lost-sm" data-action="settle" data-day="${ticket.dayIndex}" data-outcome="lost">✗ Lost</button>
        </div>
      `;
    } else if (ticket.status === 'won') {
      settleHtml = `<div class="ticket-settled-result settled-won-box">PAYS ${formatNaira(ticket.payout)} (+${formatNaira(ticket.profit)})</div>`;
    } else {
      settleHtml = `<div class="ticket-settled-result settled-lost-box">MISSED (-${formatNaira(s.stake)})</div>`;
    }

    card.innerHTML = `
      <div>
        <div class="ticket-head">
          <div>
            <h3 class="ticket-day-title">${ticket.dayName}</h3>
            <span class="ticket-date-sub">${ticket.date}</span>
          </div>
          <div class="ticket-badges">
            ${isToday ? '<span class="badge badge-today">TODAY</span>' : ''}
            ${statusBadge}
          </div>
        </div>

        <div class="ticket-hero-stat">
          <div class="ticket-odds-wrap">
            <span class="ticket-odds-num">${s.odds.toFixed(2)}</span>
            <span class="ticket-odds-lbl">Combined Odds</span>
          </div>
          <div class="ticket-stake-wrap">
            <span class="ticket-stake-num">${formatNaira(s.stake)}</span>
            <div><span class="ticket-band-chip">Band ${s.band}</span></div>
          </div>
        </div>

        <div class="ticket-metrics-row">
          <div class="t-metric">
            <span class="t-metric-lbl">Win Prob</span>
            <span class="t-metric-val">${s.winProbPct}%</span>
          </div>
          <div class="t-metric">
            <span class="t-metric-lbl">1-in-X</span>
            <span class="t-metric-val">1-in-${s.oneInX}</span>
          </div>
          <div class="t-metric">
            <span class="t-metric-lbl">Edge / EV</span>
            <span class="t-metric-val pos">+${s.edgePct}%</span>
          </div>
        </div>

        <div class="ticket-provider-line">
          ${provBadge}
          <span>${s.legCount} legs · ${s.sports.join(', ')}</span>
        </div>
      </div>

      <div>
        ${settleHtml}
        <button class="btn btn-ghost btn-sm btn-view-slip" data-action="view-slip" data-day="${ticket.dayIndex}">
          View Full Slip →
        </button>
      </div>
    `;

    grid.appendChild(card);
  }
}

/* ───────────────────────── TAB 2: TODAY'S TICKET ───────────────────────── */

function renderTodayTicket() {
  const week = S.activeWeek;
  const navContainer = $('#slip-nav-days');
  const eyebrow = $('#slip-eyebrow');
  const title = $('#slip-day-title');
  const provLine = $('#slip-provider-line');
  const oddsEl = $('#slip-combined-odds');
  const winProbEl = $('#slip-win-prob');
  const oneInXEl = $('#slip-one-in-x');
  const stakeEl = $('#slip-stake');
  const confBandEl = $('#slip-conf-band');
  const bandBadge = $('#slip-band-badge');
  const bandReason = $('#slip-band-reason');
  const fairOddsEl = $('#slip-fair-odds');
  const totalEdgeEl = $('#slip-total-edge');
  const evEl = $('#slip-ev');
  const corrEl = $('#slip-corr');
  const tierLabelEl = $('#slip-tier-label');
  const legCountEl = $('#slip-leg-count');
  const tbody = $('#legs-table-body');
  const settlePanel = $('#slip-settlement-panel');

  if (!week || !week.tickets.length) {
    title.textContent = 'No ticket available';
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:20px;">No tickets issued for this week.</td></tr>';
    return;
  }

  // Render Mon..Sun nav buttons
  navContainer.innerHTML = '';
  week.tickets.forEach((t) => {
    const btn = document.createElement('button');
    btn.className = `btn-day-nav ${t.dayIndex === S.selectedDayIndex ? 'is-selected' : ''}`;
    btn.textContent = `${t.shortName} ${t.isToday ? '★' : ''}`;
    btn.addEventListener('click', () => {
      S.selectedDayIndex = t.dayIndex;
      renderTodayTicket();
    });
    navContainer.appendChild(btn);
  });

  const ticket = week.tickets[S.selectedDayIndex] || week.tickets[0];
  eyebrow.textContent = `TICKET ${ticket.dayIndex + 1} · ${ticket.dayName.toUpperCase()} (${ticket.date}) ${ticket.isToday ? '★ TODAY' : ''}`;

  if (!ticket.issued || !ticket.slip) {
    title.textContent = 'No Ticket Issued for this day';
    provLine.textContent = `Refusal: ${ticket.message}`;
    oddsEl.textContent = '—';
    winProbEl.textContent = '—';
    oneInXEl.textContent = '—';
    stakeEl.textContent = '—';
    confBandEl.textContent = '—';
    bandBadge.textContent = 'UNISSUED';
    bandReason.textContent = ticket.message;
    legCountEl.textContent = '0';
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:30px; color:var(--dim);">Nothing in today’s market cleared the edge floor. Refusing is a feature.</td></tr>';
    settlePanel.hidden = true;
    return;
  }

  settlePanel.hidden = false;
  const s = ticket.slip;
  title.textContent = `${s.odds.toFixed(2)} Longshot Accumulator (${s.legCount} legs)`;

  const isSim = ticket.provider?.used === 'sim' || ticket.provider?.fellBack;
  provLine.innerHTML = isSim
    ? `<span class="prov-badge prov-sim">SIMULATED</span> ${ticket.provider?.reason || 'Simulated market models'}`
    : `<span class="prov-badge prov-live">LIVE</span> The Odds API v4 · Real line-shopping`;

  oddsEl.textContent = s.odds.toFixed(2);
  winProbEl.textContent = `${s.winProbPct}%`;
  oneInXEl.textContent = `1 in ${s.oneInX}`;
  stakeEl.textContent = formatNaira(s.stake);
  confBandEl.textContent = `Band ${s.band} Confidence`;

  bandBadge.textContent = `BAND ${s.band}`;
  bandReason.textContent = s.bandReason;

  fairOddsEl.textContent = s.fairOdds.toFixed(2);
  totalEdgeEl.textContent = `+${s.edgePct}%`;
  evEl.textContent = `+${s.evPct}%`;
  corrEl.textContent = `${Math.round((1 - s.correlation) * 100)}% haircut`;
  tierLabelEl.textContent = s.edgeTier;
  legCountEl.textContent = String(s.legs.length);

  // Table rows
  tbody.innerHTML = '';
  s.legs.forEach((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${l.sport}</b><br><span style="font-size:11px; color:var(--dimmer);">${l.league}</span></td>
      <td><b>${l.home}</b> vs <b>${l.away}</b></td>
      <td style="font-family:var(--mono); font-size:11px;">${l.kickoff ? new Date(l.kickoff).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '—'}</td>
      <td>${l.market}</td>
      <td style="color:var(--text); font-weight:600;">${l.pick}</td>
      <td><span class="book-tag">${l.book}</span></td>
      <td class="odds-highlight">${l.odds.toFixed(2)}</td>
      <td style="font-family:var(--mono);">${l.modelProbPct}%</td>
      <td class="edge-pos">+${l.edgePct}pp</td>
      <td><span class="badge badge-pending">Band ${l.band || 'B'}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

/* ───────────────────────── TAB 3: MARKET & QUOTA ───────────────────────── */

async function renderMarketTab() {
  const chipsGrid = $('#league-chips-grid');
  const quotaNums = $('#quota-nums');
  const quotaFill = $('#quota-bar-fill');
  const datePicker = $('#market-date-picker');

  if (!datePicker.value) {
    datePicker.value = new Date().toISOString().slice(0, 10);
  }

  // Quota bar
  if (S.quota.remaining !== null) {
    const rem = S.quota.remaining;
    const used = S.quota.used || 0;
    const total = rem + used || 500;
    const pctRemain = Math.max(0, Math.min(100, Math.round((rem / total) * 100)));
    quotaNums.textContent = `Remaining: ${rem} / Used: ${used} (${pctRemain}% allowance)`;
    quotaFill.style.width = `${pctRemain}%`;
  } else {
    quotaNums.textContent = 'Quota status pending live scan…';
    quotaFill.style.width = '100%';
  }

  // Render 23 leagues from sportMap
  const sports = S.state?.sportMap || [];
  chipsGrid.innerHTML = '';
  sports.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'league-chip';

    // Check if we have fixture results for this league
    const match = S.marketScan?.leagues?.find((l) => l.key === s.key);
    let statusBadge = '<span class="league-status l-zero">idle</span>';
    if (match) {
      if (match.ok && match.fixtures > 0) {
        statusBadge = `<span class="league-status l-ok">${match.fixtures} fixtures</span>`;
      } else if (match.ok) {
        statusBadge = `<span class="league-status l-zero">0 fixtures</span>`;
      } else {
        statusBadge = `<span class="league-status l-err">${match.status === 404 ? 'out of season' : match.status}</span>`;
      }
    }

    chip.innerHTML = `
      <span class="league-name">${s.league}</span>
      ${statusBadge}
    `;
    chipsGrid.appendChild(chip);
  });

  // Render market legs table
  renderMarketLegs();
}

function renderMarketLegs() {
  const tbody = $('#market-legs-body');
  const poolCount = $('#market-pool-count');
  const sportFilter = $('#filter-market-sport').value;
  const posEdgeOnly = $('#filter-market-pos-edge').checked;

  const legs = S.marketScan?.legs || [];
  let filtered = legs;

  if (sportFilter !== 'all') {
    filtered = filtered.filter((l) => l.sport.toLowerCase() === sportFilter.toLowerCase());
  }
  if (posEdgeOnly) {
    filtered = filtered.filter((l) => l.edge > 0);
  }

  poolCount.textContent = String(filtered.length);
  tbody.innerHTML = '';

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding:24px; color:var(--dim);">No legs match filter. Click "Scan LIVE Odds" or "Scan Simulated" above.</td></tr>';
    return;
  }

  filtered.slice(0, 80).forEach((l) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${l.sport}</td>
      <td>${l.league}</td>
      <td>${l.home} vs ${l.away}</td>
      <td>${l.market}</td>
      <td style="font-weight:600;">${l.pick}</td>
      <td><span class="book-tag">${l.book}</span></td>
      <td class="odds-highlight">${l.odds.toFixed(2)}</td>
      <td style="font-family:var(--mono);">${round(l.modelProb * 100, 1)}%</td>
      <td class="${l.edge > 0 ? 'edge-pos' : ''}">${round(l.edge * 100, 2)}pp</td>
      <td><span class="badge badge-pending">Band ${l.band || 'C'}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

/* ───────────────────────── TAB 4: HISTORY ───────────────────────── */

async function renderHistoryTab() {
  const tbody = $('#history-table-body');
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:16px;">Loading history…</td></tr>';

  try {
    const { history } = await api('/api/history');
    tbody.innerHTML = '';
    if (!history || !history.length) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding:24px; color:var(--dim);">No settled weeks recorded yet. Completed weeks will appear here.</td></tr>';
      return;
    }

    history.forEach((h) => {
      const tr = document.createElement('tr');
      const isPos = h.netPnl > 0;
      tr.innerHTML = `
        <td><b>${h.mondayDate}</b></td>
        <td><span class="badge ${h.status === 'completed' ? 'badge-won' : 'badge-pending'}">${h.status}</span></td>
        <td>${h.goal} wins</td>
        <td><b>${h.wonCount}</b> / 7</td>
        <td style="font-family:var(--mono);">${formatNaira(h.totalStaked)}</td>
        <td style="font-family:var(--mono);">${formatNaira(h.totalReturned)}</td>
        <td style="font-family:var(--mono); font-weight:700; color:${isPos ? 'var(--green)' : 'var(--red)'};">${formatNaira(h.netPnl)}</td>
        <td style="font-size:12px; color:var(--dim);">${h.verdict || '—'}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="color:var(--red);">Failed to load history: ${err.message}</td></tr>`;
  }
}

/* ───────────────────────── TAB 5: SETTINGS ───────────────────────── */

function renderSettingsTab() {
  const keyInput = $('#input-api-key');
  const keyStatus = $('#key-status-text');
  const goalSelect = $('#input-goal');
  const edgeSelect = $('#input-min-edge');
  const bandA = $('#stake-band-a');
  const bandB = $('#stake-band-b');
  const bandC = $('#stake-band-c');
  const bandD = $('#stake-band-d');
  const trimGrid = $('#trim-checkbox-grid');

  const s = S.settings || {};
  const currentKey = s.oddsApi?.key || localStorage.getItem(LS_KEY) || '';

  keyInput.value = currentKey;
  if (currentKey) {
    keyStatus.textContent = `✓ Key active (${currentKey.slice(0, 4)}…${currentKey.slice(-4)})`;
    keyStatus.style.color = 'var(--green)';
  } else {
    keyStatus.textContent = 'No key configured (using SIMULATED fallback)';
    keyStatus.style.color = 'var(--gold)';
  }

  goalSelect.value = String(s.goal || 2);
  edgeSelect.value = String(s.minEdgePerLeg !== undefined ? s.minEdgePerLeg : '0.012');

  const sb = s.stakeBands || { A: 500, B: 350, C: 200, D: 100 };
  bandA.value = sb.A;
  bandB.value = sb.B;
  bandC.value = sb.C;
  bandD.value = sb.D;

  // Render 23 trim checkboxes
  const sports = S.state?.sportMap || [];
  const selectedKeys = s.oddsApi?.sports?.length ? s.oddsApi.sports : sports.map((x) => x.key);

  trimGrid.innerHTML = '';
  sports.forEach((sp) => {
    const label = document.createElement('label');
    label.className = 'checkbox-card';
    const isChecked = selectedKeys.includes(sp.key);
    label.innerHTML = `
      <input type="checkbox" name="trim-sport" value="${sp.key}" ${isChecked ? 'checked' : ''} />
      <span>${sp.league} (${sp.sport})</span>
    `;
    trimGrid.appendChild(label);
  });
}

/* ───────────────────────── Navigation Tabs ───────────────────────── */

function switchTab(tabId) {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === tabId));
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${tabId}`));

  if (tabId === 'today-ticket') renderTodayTicket();
  if (tabId === 'market') renderMarketTab();
  if (tabId === 'history') renderHistoryTab();
  if (tabId === 'settings') renderSettingsTab();
}

/* ───────────────────────── Confetti ───────────────────────── */

function triggerConfetti() {
  const canvas = $('#confetti');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const particles = Array.from({ length: 65 }, () => ({
    x: Math.random() * canvas.width,
    y: Math.random() * -canvas.height * 0.5,
    size: Math.random() * 7 + 4,
    color: ['#3ddc97', '#ffc857', '#57b6ff', '#ffffff'][Math.floor(Math.random() * 4)],
    vy: Math.random() * 3 + 2,
    vx: (Math.random() - 0.5) * 3,
  }));

  let frames = 0;
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles.forEach((p) => {
      p.y += p.vy;
      p.x += p.vx;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x, p.y, p.size, p.size);
    });
    frames++;
    if (frames < 140) requestAnimationFrame(draw);
    else ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(draw);
}

/* ───────────────────────── Toast Notifications ───────────────────────── */

function toast(title, msg = '', type = 'ok', duration = 5000) {
  const container = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<strong>${title}</strong>${msg ? `<div style="font-size:12px; margin-top:2px;">${msg}</div>` : ''}`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, duration);
}

/* ───────────────────────── Event Listeners ───────────────────────── */

function setupEventListeners() {
  // Tabs
  $('#tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) switchTab(tab.dataset.tab);
  });

  // Settings button in topbar
  $('#btn-quick-settings').addEventListener('click', () => switchTab('settings'));
  $('#btn-sim-fix').addEventListener('click', () => switchTab('settings'));

  // Build This Week button -> opens modal
  $('#btn-build-week').addEventListener('click', () => {
    const modal = $('#modal-setup');
    $('#modal-setup-error').hidden = true;
    const dateInput = $('#modal-week-date');
    dateInput.value = new Date().toISOString().slice(0, 10);
    modal.hidden = false;
  });

  $('#btn-close-setup').addEventListener('click', () => ($('#modal-setup').hidden = true));
  $('#btn-cancel-setup').addEventListener('click', () => ($('#modal-setup').hidden = true));

  // Build Portfolio Action with Watchdog & Error Box
  $('#btn-confirm-create-week').addEventListener('click', async () => {
    const btn = $('#btn-confirm-create-week');
    const errBox = $('#modal-setup-error');
    errBox.hidden = true;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';

    const watchdog = setTimeout(() => {
      if (btn.disabled) {
        errBox.hidden = false;
        errBox.textContent = 'Operation taking longer than 20 seconds. If using live scan, leagues may be timing out. Check browser console for details.';
      }
    }, 20000);

    try {
      const weekDate = $('#modal-week-date').value;
      const provider = $('#modal-provider-select').value;
      const goal = Number($('#modal-goal-select').value) || 2;
      const key = S.settings?.oddsApi?.key || localStorage.getItem(LS_KEY) || '';

      const body = { weekDate, goal, provider, apiKey: key };

      // In browser-local mode, if oddsapi is requested, fetch live board first
      if (S.transport && provider === 'oddsapi' && key) {
        try {
          const liveRes = await api(`/api/scan/live?date=${weekDate}&apiKey=${encodeURIComponent(key)}`);
          if (liveRes.builder) {
            body.liveBoards = { [weekDate]: { scan: liveRes, builder: liveRes.builder } };
          }
        } catch {}
      }

      const res = await api('/api/weeks', { method: 'POST', body });
      S.activeWeek = res.week;
      S.selectedDayIndex = res.week.todayIndex >= 0 ? res.week.todayIndex : 0;
      $('#modal-setup').hidden = true;
      renderAll();
      toast('Weekly Portfolio Built', `${res.week.stats?.issuedCount || 7} tickets issued landing in 10.0–1000.0`, 'ok');
    } catch (err) {
      errBox.hidden = false;
      errBox.textContent = `Build failed: ${err.message || err}`;
    } finally {
      clearTimeout(watchdog);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  // Rescan Week Action
  $('#btn-rescan-week').addEventListener('click', async () => {
    const btn = $('#btn-rescan-week');
    btn.disabled = true;
    btn.textContent = 'Rescanning…';
    try {
      const key = S.settings?.oddsApi?.key || localStorage.getItem(LS_KEY) || '';
      const res = await api(`/api/weeks/${S.activeWeek.id}/rescan`, {
        method: 'POST',
        body: { apiKey: key },
      });
      S.activeWeek = res.week;
      renderAll();
      toast('Portfolio Rescanned', 'All 7 daily accumulators updated.', 'ok');
    } catch (err) {
      toast('Rescan Failed', err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Rescan';
    }
  });

  // Rescan Single Ticket
  $('#btn-rescan-single-ticket').addEventListener('click', async () => {
    const btn = $('#btn-rescan-single-ticket');
    btn.disabled = true;
    btn.textContent = 'Rescanning…';
    try {
      const key = S.settings?.oddsApi?.key || localStorage.getItem(LS_KEY) || '';
      const res = await api(`/api/weeks/${S.activeWeek.id}/rescan`, {
        method: 'POST',
        body: { dayIndex: S.selectedDayIndex, apiKey: key },
      });
      S.activeWeek = res.week;
      renderAll();
      toast('Ticket Rescanned', `Day ${S.selectedDayIndex + 1} updated.`, 'ok');
    } catch (err) {
      toast('Rescan Failed', err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Rescan today';
    }
  });

  // Ticket Grid Delegated Actions (Settle & View Slip)
  $('#tickets-grid').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const action = btn.dataset.action;
    const day = Number(btn.dataset.day);

    if (action === 'view-slip') {
      S.selectedDayIndex = day;
      switchTab('today-ticket');
      return;
    }

    if (action === 'settle') {
      const outcome = btn.dataset.outcome;
      try {
        const res = await api(`/api/weeks/${S.activeWeek.id}/tickets/${day}/settle`, {
          method: 'POST',
          body: { outcome },
        });
        S.activeWeek = res.week;
        renderAll();
        toast(`Ticket Settled as ${outcome.toUpperCase()}`, `Running P&L: ${formatNaira(res.week.stats.netPnl)}`, 'ok');
      } catch (err) {
        toast('Settlement Failed', err.message, 'err');
      }
    }
  });

  // Settle buttons on Today's Ticket tab
  $('#btn-settle-won').addEventListener('click', async () => {
    try {
      const res = await api(`/api/weeks/${S.activeWeek.id}/tickets/${S.selectedDayIndex}/settle`, {
        method: 'POST',
        body: { outcome: 'won' },
      });
      S.activeWeek = res.week;
      renderAll();
      toast('Ticket Settled: WON', `P&L updated to ${formatNaira(res.week.stats.netPnl)}`, 'ok');
    } catch (err) {
      toast('Settlement error', err.message, 'err');
    }
  });

  $('#btn-settle-lost').addEventListener('click', async () => {
    try {
      const res = await api(`/api/weeks/${S.activeWeek.id}/tickets/${S.selectedDayIndex}/settle`, {
        method: 'POST',
        body: { outcome: 'lost' },
      });
      S.activeWeek = res.week;
      renderAll();
      toast('Ticket Settled: LOST', `P&L updated to ${formatNaira(res.week.stats.netPnl)}`, 'warn');
    } catch (err) {
      toast('Settlement error', err.message, 'err');
    }
  });

  // Live scan in Market Tab
  $('#btn-scan-live').addEventListener('click', async () => {
    const btn = $('#btn-scan-live');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Fetching Live Quotes…';

    const date = $('#market-date-picker').value || new Date().toISOString().slice(0, 10);
    const key = S.settings?.oddsApi?.key || localStorage.getItem(LS_KEY) || '';

    if (!key) {
      toast('API Key Required', 'Paste your Odds API key in Settings before running a live scan.', 'warn');
      btn.disabled = false;
      btn.textContent = originalText;
      switchTab('settings');
      return;
    }

    try {
      const res = await api(`/api/scan/live?date=${date}&apiKey=${encodeURIComponent(key)}`);
      S.marketScan = res;
      if (res.quota) {
        S.quota = res.quota;
      }
      renderMarketTab();
      renderTopbar();
      toast('Live Market Scanned', `${res.events?.length || 0} fixtures priced. Quota: ${res.quota?.remaining || '—'} left.`, 'ok');
    } catch (err) {
      toast('Live Scan Failed', err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });

  $('#btn-scan-sim').addEventListener('click', async () => {
    const date = $('#market-date-picker').value || new Date().toISOString().slice(0, 10);
    try {
      const res = await api(`/api/scan?date=${date}&provider=sim`);
      S.marketScan = res;
      renderMarketTab();
      toast('Simulated Scan Complete', `${res.events?.length || 0} fixtures generated.`, 'ok');
    } catch (err) {
      toast('Scan error', err.message, 'err');
    }
  });

  // Filter controls in Market Tab
  $('#filter-market-sport').addEventListener('change', renderMarketLegs);
  $('#filter-market-pos-edge').addEventListener('change', renderMarketLegs);

  // Settings Tab Saves
  $('#btn-save-api-key').addEventListener('click', async () => {
    const key = $('#input-api-key').value.trim();
    localStorage.setItem(LS_KEY, key);
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { oddsApi: { key }, provider: key ? 'oddsapi' : 'sim' },
      });
      S.settings.oddsApi = S.settings.oddsApi || {};
      S.settings.oddsApi.key = key;
      renderSettingsTab();
      renderSimulatedBanner();
      toast('Settings Saved', key ? 'Odds API key stored and verified.' : 'Key cleared.', 'ok');
    } catch (err) {
      toast('Failed to save settings', err.message, 'err');
    }
  });

  $('#btn-save-goals').addEventListener('click', async () => {
    const goal = Number($('#input-goal').value) || 2;
    const minEdge = Number($('#input-min-edge').value) || 0.012;
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { goal, minEdgePerLeg: minEdge },
      });
      S.settings.goal = goal;
      S.settings.minEdgePerLeg = minEdge;
      toast('Goals Updated', `Target set to ${goal} wins/week.`, 'ok');
    } catch (err) {
      toast('Failed to save goal', err.message, 'err');
    }
  });

  $('#btn-save-stakes').addEventListener('click', async () => {
    const stakeBands = {
      A: Number($('#stake-band-a').value) || 500,
      B: Number($('#stake-band-b').value) || 350,
      C: Number($('#stake-band-c').value) || 200,
      D: Number($('#stake-band-d').value) || 100,
    };
    try {
      await api('/api/settings', { method: 'POST', body: { stakeBands } });
      S.settings.stakeBands = stakeBands;
      toast('Stake Bands Saved', `Band A: ${formatNaira(stakeBands.A)} · D: ${formatNaira(stakeBands.D)}`, 'ok');
    } catch (err) {
      toast('Failed to save stake bands', err.message, 'err');
    }
  });

  $('#btn-save-trim').addEventListener('click', async () => {
    const checked = $$('input[name="trim-sport"]:checked').map((cb) => cb.value);
    try {
      await api('/api/settings', {
        method: 'POST',
        body: { oddsApi: { ...(S.settings.oddsApi || {}), sports: checked } },
      });
      S.settings.oddsApi = S.settings.oddsApi || {};
      S.settings.oddsApi.sports = checked;
      toast('Board Trim Saved', `${checked.length} of 23 competitions active.`, 'ok');
    } catch (err) {
      toast('Failed to save trim', err.message, 'err');
    }
  });

  $('#btn-trim-all').addEventListener('click', () => {
    $$('input[name="trim-sport"]').forEach((cb) => (cb.checked = true));
  });
  $('#btn-trim-football-only').addEventListener('click', () => {
    $$('input[name="trim-sport"]').forEach((cb) => {
      cb.checked = cb.value.startsWith('soccer_');
    });
  });
  $('#btn-trim-top-tiers').addEventListener('click', () => {
    const top = ['soccer_epl', 'soccer_spain_la_liga', 'soccer_uefa_champs_league', 'basketball_nba'];
    $$('input[name="trim-sport"]').forEach((cb) => {
      cb.checked = top.includes(cb.value);
    });
  });

  // Africa/Lagos live clock updater
  setInterval(() => {
    const clock = $('#clock');
    if (clock) {
      const now = new Date();
      clock.textContent = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Africa/Lagos',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(now);
    }
  }, 1000);
}

/* ───────────────────────── Boot ───────────────────────── */

async function boot() {
  setupEventListeners();
  await initTransport();
  await loadState();
}

window.addEventListener('DOMContentLoaded', boot);
