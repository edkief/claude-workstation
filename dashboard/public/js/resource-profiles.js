import { api } from './api.js';
import { escHtml } from './format.js';

const $ = selector => document.querySelector(selector);

function resourceSummary(profile) {
  const { requests, limits } = profile.resources;
  return `${requests.cpu}–${limits.cpu} CPU · ${requests.memory}–${limits.memory} memory · ${requests['ephemeral-storage']}–${limits['ephemeral-storage']} ephemeral`;
}

export function setupResourceProfiles({ choose, toast }) {
  const form = $('#profile-form');
  let state = { profiles: [], defaultProfileId: null };

  function fill(profile = null) {
    form.reset();
    form.elements.id.disabled = Boolean(profile);
    form.elements.id.value = profile?.id || '';
    form.elements.name.value = profile?.name || '';
    form.elements.description.value = profile?.description || '';
    const requests = profile?.resources.requests || {};
    const limits = profile?.resources.limits || {};
    form.elements.cpuRequest.value = requests.cpu || '250m';
    form.elements.cpuLimit.value = limits.cpu || '2';
    form.elements.memoryRequest.value = requests.memory || '1Gi';
    form.elements.memoryLimit.value = limits.memory || '4Gi';
    form.elements.ephemeralRequest.value = requests['ephemeral-storage'] || '2Gi';
    form.elements.ephemeralLimit.value = limits['ephemeral-storage'] || '12Gi';
    $('#profile-form-title').textContent = profile ? `Edit ${profile.name}` : 'Add profile';
    $('#profile-cancel-btn').hidden = !profile;
    $('#profile-result').textContent = '';
  }

  function render() {
    const body = $('#profiles-body');
    body.innerHTML = state.profiles.map(profile => `<tr><td><strong>${escHtml(profile.name)}</strong><small>${escHtml(profile.description || profile.id)}</small></td><td>${escHtml(resourceSummary(profile))}</td><td class="num"><span class="status ${profile.id === state.defaultProfileId ? 'status--running' : ''}">${profile.id === state.defaultProfileId ? 'Default' : 'Available'}</span></td><td class="num"><button class="button button--quiet button--small" data-profile-default="${escHtml(profile.id)}" ${profile.id === state.defaultProfileId ? 'disabled' : ''}>Make default</button><button class="button button--secondary button--small" data-profile-edit="${escHtml(profile.id)}">Edit</button><button class="button button--danger button--small" data-profile-delete="${escHtml(profile.id)}" ${state.profiles.length === 1 ? 'disabled' : ''}>Delete</button></td></tr>`).join('');
    body.querySelectorAll('[data-profile-default]').forEach(button => button.addEventListener('click', () => setDefault(button.dataset.profileDefault)));
    body.querySelectorAll('[data-profile-edit]').forEach(button => button.addEventListener('click', () => fill(state.profiles.find(profile => profile.id === button.dataset.profileEdit))));
    body.querySelectorAll('[data-profile-delete]').forEach(button => button.addEventListener('click', () => remove(button.dataset.profileDelete)));
  }

  async function load() {
    try {
      state = await api.resourceProfiles();
      $('#profile-persistence').textContent = 'Saved on dashboard PVC';
      render();
    } catch (error) {
      $('#profiles-body').innerHTML = `<tr><td colspan="4">${escHtml(error.message || 'Profiles unavailable')}</td></tr>`;
    }
  }

  async function setDefault(id) {
    try { await api.setDefaultResourceProfile(id); toast('Default resource profile updated.'); await load(); document.dispatchEvent(new Event('resource-profiles-changed')); }
    catch (error) { $('#profile-result').textContent = error.message; }
  }

  async function remove(id) {
    const profile = state.profiles.find(item => item.id === id);
    if (!await choose('Delete resource profile', `Delete “${profile?.name || id}”? Running workspaces keep their current resources.`, [{ key:'cancel', label:'Cancel', kind:'button--quiet' }, { key:'ok', label:'Delete', kind:'button--danger' }])) return;
    try { await api.removeResourceProfile(id); toast('Resource profile deleted.'); fill(); await load(); document.dispatchEvent(new Event('resource-profiles-changed')); }
    catch (error) { $('#profile-result').textContent = error.message; }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const fields = form.elements;
    const id = fields.id.value.trim();
    const body = {
      name: fields.name.value.trim(), description: fields.description.value.trim(),
      resources: {
        requests: { cpu: fields.cpuRequest.value.trim(), memory: fields.memoryRequest.value.trim(), 'ephemeral-storage': fields.ephemeralRequest.value.trim() },
        limits: { cpu: fields.cpuLimit.value.trim(), memory: fields.memoryLimit.value.trim(), 'ephemeral-storage': fields.ephemeralLimit.value.trim() },
      },
    };
    const button = $('#profile-save-btn'); button.disabled = true;
    try { await api.saveResourceProfile(id, body); toast('Resource profile saved.'); fill(); await load(); document.dispatchEvent(new Event('resource-profiles-changed')); }
    catch (error) { $('#profile-result').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#profile-cancel-btn').addEventListener('click', () => fill());
  fill();
  load();
}
