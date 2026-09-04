import { api } from './api.js';
import { attentionStatus, barTone, escHtml, fmtCpu, fmtGi, fmtMem } from './format.js';
import { createSessionCard, isAttention, updateSessionCard, updateSessionMetrics } from './session-card.js';
import { createSessionForm } from './session-form.js';
import { setupResourceProfiles } from './resource-profiles.js';

const state = { sessions: [], filter: 'all', pending: new Set(), sessionTimer: null, cards: new Map() };
const settled = new Set(['running', 'degraded', 'failed']);
const $ = selector => document.querySelector(selector);

function openUrl(url) { window.open(url, '_blank', 'noopener'); }
function message(element, text, tone = 'muted') { element.textContent = text; element.style.color = `var(--${tone === 'success' ? 'green' : tone === 'error' ? 'red' : tone === 'warning' ? 'yellow' : 'muted'})`; }
function toast(text) { const element = document.createElement('div'); element.className = 'toast'; element.textContent = text; $('#toast-region').append(element); setTimeout(() => element.remove(), 3600); }

function setMeter(label, bar, value, limit, formatter) {
  if (value == null) return;
  label.textContent = formatter(value);
  const percent = limit ? Math.min(100, value / limit * 100) : 0;
  bar.style.width = `${percent}%`; bar.className = barTone(percent);
}

function scheduleSessions() { clearTimeout(state.sessionTimer); state.sessionTimer = setTimeout(loadSessions, state.pending.size ? 2000 : 10000); }
async function loadSessions() {
  try {
    const sessions = await api.sessions();
    state.sessions = sessions;
    for (const session of sessions) if (settled.has(session.status)) state.pending.delete(session.id);
    for (const id of [...state.pending]) if (!sessions.some(session => session.id === id)) state.pending.delete(id);
    renderSessions();
  } catch (error) {
    $('#sessions-container').innerHTML = `<div class="empty-state">${escHtml(error.message || 'Unable to load workspaces.')}</div>`;
  } finally { $('#sessions-container').setAttribute('aria-busy', 'false'); scheduleSessions(); }
}

function renderSessions() {
  const visible = state.sessions.filter(session => state.filter === 'all' || state.filter === 'running' && ['running', 'starting'].includes(session.status) || state.filter === 'attention' && isAttention(session));
  const running = state.sessions.filter(session => ['running', 'starting'].includes(session.status)).length;
  const attention = state.sessions.filter(isAttention).length;
  $('#count-all').textContent = state.sessions.length; $('#count-running').textContent = running; $('#count-attention').textContent = attention;
  $('#board-occupancy').textContent = `${visible.length} shown · ${running} attached`;
  $('#workspace-summary').textContent = state.sessions.length ? `${running} active · ${attention ? `${attention} need attention` : 'all systems responding'}` : 'No workspaces are running.';
  const container = $('#sessions-container');
  if (!visible.length) { container.innerHTML = `<div class="empty-state">${state.sessions.length ? 'No workspaces match this filter.' : 'No workspaces yet. Create one to start coding.'}</div>`; return; }
  let list = container.querySelector('.session-list');
  if (!list) { container.innerHTML = '<div class="session-list"></div>'; list = container.firstElementChild; state.cards.clear(); }
  const current = new Set(visible.map(session => session.id));
  for (const [id, card] of state.cards) if (!current.has(id)) { card.remove(); state.cards.delete(id); }
  visible.forEach((session, index) => {
    let card = state.cards.get(session.id);
    if (!card) { card = createSessionCard(session, { onTerminate: terminateSession, onOpenTerminal: session => openUrl(session.terminalUrl || `/tty/${encodeURIComponent(session.id)}/`), onOpenCodex: session => openUrl(session.codexUrl || `/codex/${encodeURIComponent(session.id)}/`), onOpenClaude: session => session.claudeUrl && openUrl(session.claudeUrl) }); state.cards.set(session.id, card); }
    else updateSessionCard(card, session);
    if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
  });
}

async function terminateSession(session) {
  if (!await choose('Terminate workspace', `Terminate “${session.displayName}”? Its pod stops, but its checkout and uncommitted work remain in persistent storage.`, [{ key: 'cancel', label: 'Cancel', kind: 'button--quiet' }, { key: 'ok', label: 'Terminate', kind: 'button--danger' }])) return;
  try { await api.removeSession(session.id); toast('Workspace termination requested.'); loadSessions(); } catch (error) { choose('Could not terminate workspace', error.message, [{ key: 'ok', label: 'OK', kind: 'button--primary' }]); }
}

async function removeInactive() {
  const inactive = state.sessions.filter(session => ['failed', 'degraded'].includes(session.status));
  if (!inactive.length) return choose('No inactive workspaces', 'There are no failed or degraded workspaces to remove.', [{ key: 'ok', label: 'OK', kind: 'button--primary' }]);
  if (!await choose('Remove inactive workspaces', `Remove ${inactive.length} inactive workspace(s)? Persistent storage is kept.`, [{ key: 'cancel', label: 'Cancel', kind: 'button--quiet' }, { key: 'ok', label: 'Remove', kind: 'button--danger' }])) return;
  const button = $('#remove-inactive-btn'); button.disabled = true;
  try { await Promise.all(inactive.map(session => api.removeSession(session.id))); toast('Inactive workspaces removed.'); loadSessions(); } catch (error) { choose('Removal failed', error.message, [{ key: 'ok', label: 'OK', kind: 'button--primary' }]); } finally { button.disabled = false; }
}

async function loadResources() {
  try {
    const data = await api.resources();
    if (data.source === 'unavailable') { $('#metrics-hint').textContent = 'Live metrics unavailable'; return; }
    $('#metrics-hint').textContent = '';
    for (const [id, stats] of Object.entries(data.sessions || {})) updateSessionMetrics(state.cards.get(id), stats);
    if (data.totals) { setMeter($('#overall-cpu'), $('#overall-cpu-bar'), data.totals.cpuMillicores, data.totals.cpuLimitMillicores, fmtCpu); setMeter($('#overall-mem'), $('#overall-mem-bar'), data.totals.memMiB, data.totals.memLimitMiB, fmtMem); }
  } catch { /* transient resource errors do not disrupt the workspace list */ }
}

function renderWorkspaces(items) {
  const container = $('#workspaces-container');
  if (!items.length) { container.innerHTML = '<div class="empty-state">No persistent workspace storage yet.</div>'; return; }
  container.innerHTML = `<table><thead><tr><th></th><th>Repository</th><th class="num">Used</th><th class="num">Capacity</th><th class="num">Idle</th><th></th></tr></thead><tbody>${items.map(item => `<tr><td><span class="use-dot ${item.inUse ? 'on' : ''}" title="${item.inUse ? 'In use' : 'Idle'}"></span></td><td>${escHtml(item.repoFullName || item.name)}</td><td class="num">${fmtGi(item.usedGi)}${item.live ? '' : ' *'}</td><td class="num">${fmtGi(item.capacityGi)}</td><td class="num">${item.ageDays == null ? '—' : `${item.ageDays}d`}</td><td class="num"><button class="button button--danger button--small" data-workspace="${escHtml(item.name)}" ${item.inUse ? 'disabled title="Terminate its workspace first"' : ''}>Delete</button></td></tr>`).join('')}</tbody></table>`;
  container.querySelectorAll('[data-workspace]').forEach(button => button.addEventListener('click', () => deleteWorkspace(button.dataset.workspace)));
}

async function loadDisk() {
  try { const data = await api.disk(); const percent = data.totalCapacityGi ? Math.min(100, data.totalUsedGi / data.totalCapacityGi * 100) : 0; $('#disk-usage').textContent = `${fmtGi(data.totalUsedGi)} / ${fmtGi(data.totalCapacityGi)}`; const bar = $('#disk-bar'); bar.style.width = `${percent}%`; bar.className = barTone(percent); renderWorkspaces(data.items || []); } catch { $('#workspaces-container').innerHTML = '<div class="empty-state">Storage data is temporarily unavailable.</div>'; }
}

async function deleteWorkspace(name) {
  if (!await choose('Delete workspace storage', `Delete the volume for “${name}”? Its checkout and uncommitted work will be permanently lost.`, [{ key: 'cancel', label: 'Cancel', kind: 'button--quiet' }, { key: 'ok', label: 'Delete', kind: 'button--danger' }])) return;
  try { await api.removeWorkspace(name); toast('Workspace storage deleted.'); loadDisk(); } catch (error) { choose('Could not delete storage', error.message, [{ key: 'ok', label: 'OK', kind: 'button--primary' }]); }
}

async function cleanupWorkspaces() {
  const days = Number($('#cleanup-days').value); const result = $('#cleanup-result');
  if (!Number.isInteger(days) || days < 1) return message(result, 'Enter a whole number of days.', 'error');
  if (!await choose('Clean up workspace storage', `Delete idle workspaces untouched for ${days} or more days? Volumes in use are skipped; other checkouts and uncommitted work are permanently lost.`, [{ key: 'cancel', label: 'Cancel', kind: 'button--quiet' }, { key: 'ok', label: 'Clean up', kind: 'button--danger' }])) return;
  const button = $('#cleanup-btn'); button.disabled = true;
  try { const data = await api.prune(days); message(result, data.deleted.length ? `Deleted ${data.deleted.length} workspace(s), freeing ${data.totalFreedGi} GiB.` : 'No workspaces matched the retention rule.', data.deleted.length ? 'success' : 'muted'); loadDisk(); } catch (error) { message(result, error.message, 'error'); } finally { button.disabled = false; }
}

async function loadConfig() {
  try { const data = await api.configStatus(); const summary = !data.available ? data.message || 'Sync unavailable' : data.configured === false ? 'S3 is not configured' : [`Version ${data.remoteVersion}`, `push policy: ${data.pushPolicy}`, data.behind && 'pull required', data.localChanges?.length && `${data.localChanges.length} local changes`].filter(Boolean).join(' · '); $('#config-summary').textContent = summary; } catch { $('#config-summary').textContent = 'Sync unavailable'; }
}
async function pushConfig() {
  const button = $('#config-push-btn'), result = $('#config-result'); button.disabled = true;
  try { await api.pushConfig(); message(result, 'Configuration synced to S3.', 'success'); } catch (error) { message(result, error.message, error.response?.status === 409 ? 'warning' : 'error'); } finally { button.disabled = false; loadConfig(); }
}

const tokenTone = { expiring:'warning', stale:'warning', expired:'error', missing:'error', unreadable:'error' };
async function loadToken(fresh = false) {
  const banner = $('#token-banner');
  try { const data = await api.token(fresh); const autoFailure = data.autoRefresh?.last?.ok === false && data.autoRefresh.last.action !== 'disabled' ? `Auto-refresh ${data.autoRefresh.last.action}: ${data.autoRefresh.last.message || 'see dashboard logs'}` : null; const tone = tokenTone[data.state] || (autoFailure ? 'warning' : null); if (!tone) { banner.hidden = true; return; } banner.hidden = false; banner.style.borderColor = `var(--${tone === 'error' ? 'red' : 'yellow'})`; $('#token-banner-text').textContent = [tokenTone[data.state] && (data.message || data.state), autoFailure].filter(Boolean).join(' — '); } catch { banner.hidden = true; }
}
async function refreshToken() { const button = $('#token-refresh-btn'); button.disabled = true; try { const data = await api.refreshToken(); toast(data.message || 'Login refresh requested.'); } catch (error) { toast(`Login refresh failed: ${error.message}`); } finally { button.disabled = false; loadToken(true); } }

function chooseAction(title, body, options) {
  return new Promise(resolve => {
    const overlay = $('#modal-overlay'), actions = $('#modal-actions'), prior = document.activeElement;
    $('#modal-title').textContent = title; $('#modal-message').textContent = body; actions.innerHTML = '';
    const dismiss = value => { overlay.hidden = true; document.removeEventListener('keydown', keydown); prior?.focus(); resolve(value); };
    options.forEach(option => { const button = document.createElement('button'); button.className = `button ${option.kind}`; button.textContent = option.label; button.addEventListener('click', () => dismiss(option.key)); actions.append(button); });
    const focusable = () => [...actions.querySelectorAll('button')];
    function keydown(event) { if (event.key === 'Escape') dismiss('cancel'); if (event.key === 'Tab') { const items = focusable(); if (!items.length) return; const first = items[0], last = items.at(-1); if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }
    overlay.onclick = event => { if (event.target === overlay) dismiss('cancel'); }; document.addEventListener('keydown', keydown); overlay.hidden = false; focusable()[0]?.focus();
  });
}
const choose = (title, body, options) => chooseAction(title, body, options).then(key => key === 'ok');

async function submitSession(body) {
  try { const session = await api.createSession(body); state.pending.add(session.id); loadSessions(); return { started: session }; }
  catch (error) {
    if (error.response?.status !== 409 || error.data?.error !== 'workspace_busy' || !error.data.session) throw error;
    const session = error.data.session;
    const choice = await chooseAction('Workspace already running', error.data.message, [{ key:'cancel', label:'Cancel', kind:'button--quiet' }, { key:'terminal', label:'Open terminal', kind:'button--secondary' }, { key:'codex', label:'Open Codex', kind:'button--primary' }, { key:'replace', label:'Replace', kind:'button--danger' }]);
    if (choice === 'terminal') { openUrl(session.terminalUrl || `/tty/${encodeURIComponent(session.id)}/`); return {}; }
    if (choice === 'codex') { openUrl(session.codexUrl || `/codex/${encodeURIComponent(session.id)}/`); return {}; }
    if (choice === 'replace') return submitSession({ ...body, replace: true });
    return {};
  }
}

function setupTabs() { const tabs = [['storage-tab','storage-panel'],['profiles-tab','profiles-panel'],['config-tab','config-panel']]; tabs.forEach(([tabId]) => $("#" + tabId).addEventListener('click', () => { for (const [otherTab, otherPanel] of tabs) { const active = otherTab === tabId; $("#" + otherTab).classList.toggle('is-active', active); $("#" + otherTab).setAttribute('aria-selected', String(active)); $("#" + otherPanel).hidden = !active; } })); }

document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => { state.filter = button.dataset.filter; document.querySelectorAll('[data-filter]').forEach(item => item.classList.toggle('is-active', item === button)); renderSessions(); }));
$('#remove-inactive-btn').addEventListener('click', removeInactive); $('#cleanup-btn').addEventListener('click', cleanupWorkspaces); $('#config-push-btn').addEventListener('click', pushConfig); $('#token-refresh-btn').addEventListener('click', refreshToken); $('#token-recheck-btn').addEventListener('click', () => loadToken(true));
createSessionForm({ onSubmit: submitSession }); setupTabs();
setupResourceProfiles({ choose, toast });
api.info().then(data => { if (data.dashboardPod) { $('#pod-name').textContent = data.dashboardPod; $('#pod-name').hidden = false; } if (data.metricsAvailable === false) $('#metrics-hint').textContent = 'Live metrics unavailable'; }).catch(() => {});
loadSessions(); loadResources(); loadDisk(); loadConfig(); loadToken();
setInterval(loadResources, 5000); setInterval(loadDisk, 60000); setInterval(loadConfig, 60000); setInterval(loadToken, 300000);
