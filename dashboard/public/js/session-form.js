import { api } from './api.js';
import { escHtml } from './format.js';

export function createSessionForm({ onSubmit }) {
  const form = document.getElementById('start-form');
  const drawer = document.getElementById('session-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const filter = document.getElementById('repo-filter');
  const list = document.getElementById('repo-list');
  const selected = document.getElementById('repo-select-value');
  const branch = document.getElementById('branch-select');
  const error = document.getElementById('msg-error');
  const success = document.getElementById('msg-success');
  let repos = [], manual = false, manualBranch = false, active = -1, opener = null;

  const open = event => { opener = event?.currentTarget || document.activeElement; drawer.hidden = false; backdrop.hidden = false; document.body.style.overflow = 'hidden'; setTimeout(() => (manual ? document.getElementById('project-manual') : filter).focus(), 0); };
  const close = () => { drawer.hidden = true; backdrop.hidden = true; document.body.style.overflow = ''; opener?.focus(); };
  document.getElementById('open-session-drawer').addEventListener('click', open);
  document.getElementById('close-session-drawer').addEventListener('click', close);
  document.getElementById('cancel-session').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', event => {
    if (drawer.hidden) return;
    if (event.key === 'Escape') return close();
    if (event.key !== 'Tab') return;
    const focusable = [...drawer.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(item => !item.hidden && item.offsetParent !== null);
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  function setManual(value) { manual = value; document.getElementById('repo-picker-field').hidden = value; document.getElementById('repo-manual-field').hidden = !value; }
  function setManualBranch(value) { manualBranch = value; document.getElementById('branch-picker-field').hidden = value; document.getElementById('branch-manual-field').hidden = !value; }
  document.getElementById('toggle-manual').addEventListener('click', () => setManual(true));
  document.getElementById('toggle-picker').addEventListener('click', () => setManual(false));
  document.getElementById('toggle-branch-manual').addEventListener('click', () => setManualBranch(true));
  document.getElementById('toggle-branch-picker').addEventListener('click', () => setManualBranch(false));

  function renderOptions(query = '') {
    const matching = repos.filter(repo => repo.fullName.toLowerCase().includes(query.trim().toLowerCase()));
    active = matching.length ? 0 : -1;
    list.innerHTML = matching.length ? matching.map((repo, index) => `<button type="button" class="combo-option${index === active ? ' is-active' : ''}" role="option" aria-selected="${index === active}" data-index="${index}">${escHtml(repo.fullName)}${repo.private ? ' 🔒' : ''}</button>`).join('') : '<p class="combo-option">No matching repositories</p>';
    list.hidden = false; filter.setAttribute('aria-expanded', 'true'); list._matching = matching;
  }
  function closeOptions() { list.hidden = true; filter.setAttribute('aria-expanded', 'false'); }
  async function selectRepo(repo) {
    filter.value = repo.fullName; selected.value = repo.sshUrl; closeOptions();
    branch.disabled = true; branch.innerHTML = '<option>Loading branches…</option>';
    try {
      const branches = await api.branches(repo.fullName);
      branch.innerHTML = branches.map(item => `<option value="${escHtml(item)}"${item === repo.defaultBranch ? ' selected' : ''}>${escHtml(item)}</option>`).join('');
      document.getElementById('branch-manual').value = repo.defaultBranch || '';
    } catch { branch.innerHTML = '<option value="">Branches unavailable — enter manually</option>'; document.getElementById('branch-manual').value = repo.defaultBranch || ''; setManualBranch(true); }
    finally { branch.disabled = false; }
  }
  filter.addEventListener('focus', () => renderOptions(filter.value));
  filter.addEventListener('input', () => { selected.value = ''; renderOptions(filter.value); });
  filter.addEventListener('keydown', event => {
    const matching = list._matching || [];
    if (event.key === 'Escape') return closeOptions();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); if (!matching.length) return; active = (active + (event.key === 'ArrowDown' ? 1 : matching.length - 1)) % matching.length; [...list.querySelectorAll('.combo-option')].forEach((item, index) => item.classList.toggle('is-active', index === active)); }
    if (event.key === 'Enter' && !list.hidden && matching[active]) { event.preventDefault(); selectRepo(matching[active]); }
  });
  list.addEventListener('click', event => { const option = event.target.closest('[data-index]'); if (option) selectRepo((list._matching || [])[Number(option.dataset.index)]); });
  document.addEventListener('click', event => { if (!event.target.closest('.combobox')) closeOptions(); });

  (async () => {
    try { repos = await api.repos(); filter.placeholder = 'Search repositories…'; document.getElementById('repo-hint').textContent = `${repos.length} repositories available`; }
    catch { filter.placeholder = 'Repositories unavailable — use a URL'; document.getElementById('repo-hint').textContent = 'You can enter a Git URL manually.'; }
  })();

  form.addEventListener('submit', async event => {
    event.preventDefault(); error.textContent = ''; success.textContent = '';
    const project = manual ? document.getElementById('project-manual').value.trim() : selected.value;
    const branchName = manualBranch ? document.getElementById('branch-manual').value.trim() : branch.value.trim();
    if (!project) { error.textContent = manual ? 'Enter a Git URL.' : 'Select a repository.'; return; }
    if (!branchName) { error.textContent = 'Select or enter a branch.'; return; }
    const newBranch = document.getElementById('new-branch').value.trim();
    const button = document.getElementById('start-session-btn');
    button.disabled = true; button.innerHTML = '<span class="spinner"></span>Starting…';
    try {
      const result = await onSubmit({ project, branch: branchName, resetHard: form.resetHard.checked, ...(newBranch && { newBranch }) });
      if (result?.started) { success.textContent = `Starting “${result.started.displayName}”…`; form.reset(); selected.value = ''; branch.innerHTML = '<option value="">Select a repository first</option>'; setTimeout(close, 700); }
    } catch (reason) { error.textContent = reason.message || 'Could not start the workspace.'; }
    finally { button.disabled = false; button.textContent = 'Start workspace'; }
  });
  return { open, close };
}
