import { api } from './api.js';
import { attentionStatus, barTone, escHtml, fmtCpu, fmtDate, fmtMem } from './format.js';

const PANEL_MS = { health: 5000, logs: 3000 };

function meter(label, id) {
  return `<div class="meter"><div class="meter--compact"><span>${label}</span><strong data-metric="${id}">—</strong><i><b data-metric-bar="${id}"></b></i></div></div>`;
}

function summary(health) {
  if (!health.available) return 'unreachable';
  const result = health.health || {};
  return [result.ready ? 'ready' : 'not ready', result.stage, result.terminalReady ? 'terminal up' : 'terminal down'].filter(Boolean).join(' · ');
}

function statusClass(status) { return `status status--${String(status || 'unknown').replace(/[^a-z-]/g, '')}`; }

export function createSessionCard(session, { onTerminate, onOpenTerminal, onOpenCodex }) {
  const card = document.createElement('article');
  card.className = 'session-card';
  card.dataset.session = session.id;
  card.innerHTML = `
    <div class="session-card__main">
      <div>
        <div class="session-title"><h3 data-role="name"></h3><span data-role="status"></span></div>
        <div class="session-meta"><span data-role="repo"></span><span data-role="started"></span></div>
        <p class="session-message" data-role="message"></p>
      </div>
      <div class="session-side">
        <div class="session-meters">${meter('CPU', 'cpu')}${meter('Memory', 'memory')}</div>
        <div class="session-actions">
          <button class="button button--primary button--small" data-action="codex">Open Codex</button>
          <button class="button button--secondary button--small" data-action="terminal">Terminal</button>
          <button class="button button--danger button--small" data-action="terminate">Terminate</button>
        </div>
      </div>
    </div>
    <details class="details" data-panel="health"><summary>Health <span class="details__status" data-panel-status="health"></span></summary><div class="diagnostic"><div class="diagnostic-toolbar"><label><input type="checkbox" checked data-auto="health"> Auto-refresh</label><a data-raw="health" target="_blank" rel="noopener">Open raw</a></div><pre data-panel-output="health">Open to load health information.</pre></div></details>
    <details class="details" data-panel="logs"><summary>Logs <span class="details__status" data-panel-status="logs"></span></summary><div class="diagnostic"><div class="diagnostic-toolbar"><label><input type="checkbox" checked data-auto="logs"> Auto-refresh</label><label>Lines <select data-lines><option value="200">200</option><option value="500" selected>500</option><option value="2000">2000</option><option value="5000">5000</option></select></label><a data-raw="logs" target="_blank" rel="noopener">Open raw</a></div><pre data-panel-output="logs">Open to load logs.</pre></div></details>`;

  const action = role => card.querySelector(`[data-action="${role}"]`);
  action('codex').addEventListener('click', () => onOpenCodex(card._session));
  action('terminal').addEventListener('click', () => onOpenTerminal(card._session));
  action('terminate').addEventListener('click', () => onTerminate(card._session));
  wirePanels(card);
  updateSessionCard(card, session);
  return card;
}

export function updateSessionCard(card, session) {
  card._session = session;
  card.querySelector('[data-role="name"]').textContent = session.displayName;
  const badge = card.querySelector('[data-role="status"]');
  badge.className = statusClass(session.status);
  badge.textContent = session.status || 'unknown';
  const oom = session.restartCount > 0 && session.lastTerminationReason === 'OOMKilled' ? ` · restarted ${session.restartCount}× (OOMKilled)` : '';
  card.querySelector('[data-role="repo"]').innerHTML = `${escHtml(session.repoFullName)} <span class="branch">${escHtml(session.branch)}</span>${oom}`;
  card.querySelector('[data-role="started"]').textContent = fmtDate(session.startedAt);
  card.querySelector('[data-role="message"]').textContent = session.message || '';
  const terminal = card.querySelector('[data-action="terminal"]');
  terminal.disabled = !session.terminalReady;
  terminal.title = !session.terminalReady ? session.message || 'Workspace is still starting' : session.authFailed ? 'Claude needs a login — run /login here' : '';
  const codex = card.querySelector('[data-action="codex"]');
  codex.disabled = session.phase !== 'Running';
  codex.title = codex.disabled ? session.message || 'Workspace is still starting' : '';
  card.querySelector('[data-raw="health"]').href = `/api/sessions/${encodeURIComponent(session.id)}/health`;
  card.querySelector('[data-raw="logs"]').href = `/api/sessions/${encodeURIComponent(session.id)}/logs?tail=${card.querySelector('[data-lines]').value}`;
}

export function updateSessionMetrics(card, stats) {
  if (!card || !stats) return;
  setMetric(card, 'cpu', stats.cpuMillicores, stats.cpuLimitMillicores, fmtCpu);
  setMetric(card, 'memory', stats.memMiB, stats.memLimitMiB, fmtMem);
}

function setMetric(card, name, value, limit, formatter) {
  const label = card.querySelector(`[data-metric="${name}"]`);
  const bar = card.querySelector(`[data-metric-bar="${name}"]`);
  if (!label || value == null) return;
  label.textContent = formatter(value);
  const percent = limit ? Math.min(100, value / limit * 100) : 0;
  bar.style.width = `${percent}%`;
  bar.className = barTone(percent);
}

function wirePanels(card) {
  for (const kind of Object.keys(PANEL_MS)) {
    const panel = card.querySelector(`[data-panel="${kind}"]`);
    panel.addEventListener('toggle', () => panel.open ? refreshPanel(card, kind, true) : stopPanel(card, kind));
    card.querySelector(`[data-auto="${kind}"]`).addEventListener('change', () => { stopPanel(card, kind); if (panel.open) refreshPanel(card, kind, true); });
  }
  card.querySelector('[data-lines]').addEventListener('change', event => {
    const session = card._session;
    card.querySelector('[data-raw="logs"]').href = `/api/sessions/${encodeURIComponent(session.id)}/logs?tail=${event.target.value}`;
    if (card.querySelector('[data-panel="logs"]').open) refreshPanel(card, 'logs', true);
  });
}

function stopPanel(card, kind) { clearTimeout(card._panelTimers?.[kind]); }

async function refreshPanel(card, kind, schedule) {
  const panel = card.querySelector(`[data-panel="${kind}"]`);
  if (!panel.open || !card.isConnected) return stopPanel(card, kind);
  const out = card.querySelector(`[data-panel-output="${kind}"]`);
  const status = card.querySelector(`[data-panel-status="${kind}"]`);
  try {
    if (kind === 'health') {
      const data = await api.health(card._session.id);
      out.textContent = data.available ? JSON.stringify(data.health, null, 2) : data.message || 'No health information';
      status.textContent = summary(data);
    } else {
      const text = await api.logs(card._session.id, card.querySelector('[data-lines]').value);
      const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
      out.textContent = text || '(no output yet)';
      if (atBottom) out.scrollTop = out.scrollHeight;
      status.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    }
  } catch (error) { status.textContent = error.message || 'Fetch failed'; }
  if (schedule && card.querySelector(`[data-auto="${kind}"]`).checked) {
    card._panelTimers ||= {};
    stopPanel(card, kind);
    card._panelTimers[kind] = setTimeout(() => refreshPanel(card, kind, true), PANEL_MS[kind]);
  }
}

export function isAttention(session) { return attentionStatus(session.status); }
