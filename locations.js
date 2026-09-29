(() => {
  'use strict';

  const ZONE_LABELS = {
    FG_STORAGE: 'Finished goods storage',
    RM_STORAGE: 'Raw material storage',
    RECEIVING: 'Receiving (inward)',
    QC_HOLD: 'Quality hold',
    STAGING: 'Dispatch staging',
    RETURNS: 'Returns & damaged',
  };

  const state = { warehouses: [], selectedId: null, showArchived: false, query: '', editing: null };
  const $ = (id) => document.getElementById(id);

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- network ----------
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      });
    } catch {
      throw Object.assign(new Error('No connection to the server. Check the internet and try again.'), { status: 0 });
    }
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      throw Object.assign(new Error(data.error || `Request failed (${res.status}).`), { status: res.status, field: data.field });
    }
    return data;
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.className = ''), bad ? 5000 : 2500);
  }

  async function load() {
    try {
      const data = await api('GET', '/api/locations');
      state.warehouses = data.warehouses;
      if (state.selectedId && !state.warehouses.some((w) => w.id === state.selectedId)) state.selectedId = null;
      render();
    } catch (e) {
      $('counts').textContent = e.message;
      toast(e.message, true);
    }
  }

  // ---------- rendering ----------
  function visibleWarehouses() {
    const q = state.query.toLowerCase();
    return state.warehouses.filter((w) =>
      (state.showArchived || w.is_active) &&
      (!q || w.name.toLowerCase().includes(q) || w.code.toLowerCase().includes(q)));
  }

  function render() {
    const active = state.warehouses.filter((w) => w.is_active);
    const zoneCount = active.reduce((n, w) => n + w.zones.filter((z) => z.is_active).length, 0);
    $('counts').textContent = `${active.length} warehouse${active.length === 1 ? '' : 's'}, ${zoneCount} zone${zoneCount === 1 ? '' : 's'}`;

    const list = visibleWarehouses();
    if (!state.selectedId && list.length && window.matchMedia('(min-width: 761px)').matches) {
      state.selectedId = list[0].id;
    }

    $('whList').innerHTML = list.length
      ? list.map((w) => {
          const zc = w.zones.filter((z) => z.is_active).length;
          return `<li><button class="wh-item" type="button" data-wh="${w.id}" aria-current="${w.id === state.selectedId}">
            <span class="tape${w.is_active ? '' : ' archived'}">${esc(w.code)}</span>
            <span><span class="nm">${esc(w.name)}</span><br><span class="sub">${zc} zone${zc === 1 ? '' : 's'}${w.is_active ? '' : ' · archived'}</span></span>
            <span class="walk">${w.walk_order ? 'Walk ' + w.walk_order : ''}</span>
          </button></li>`;
        }).join('')
      : `<li class="sub" style="padding:0.75rem 0.4rem;color:var(--muted)">${state.query ? 'No warehouse matches that search.' : ''}</li>`;

    renderDetail();
  }

  function renderDetail() {
    const d = $('detail');
    const w = state.warehouses.find((x) => x.id === state.selectedId);
    $('layout').classList.toggle('show-detail', !!w);

    if (!state.warehouses.length) {
      d.innerHTML = `<div class="empty">
        <h2>Add your first warehouse</h2>
        <p>Enter each godown you store goods in. Start with the one nearest the loading point and give it walking order 1, so pick lists can route pickers efficiently.</p>
        <button class="btn" type="button" data-act="add-wh">Add warehouse</button></div>`;
      return;
    }
    if (!w) {
      d.innerHTML = `<div class="empty"><p>Select a warehouse to see and manage its zones.</p></div>`;
      return;
    }

    const zones = w.zones.filter((z) => state.showArchived || z.is_active);
    const meta = [w.walk_order ? `Walking order ${w.walk_order}` : 'No walking order set', w.address].filter(Boolean);

    d.innerHTML = `
      <button class="btn quiet small back" type="button" data-act="back">All warehouses</button>
      <div class="wh-head">
        <span class="tape big${w.is_active ? '' : ' archived'}">${esc(w.code)}</span>
        <div class="grow">
          <h2>${esc(w.name)}</h2>
          <p class="meta">${meta.map(esc).join(' — ')}</p>
        </div>
        <div class="actions">
          ${w.is_active
            ? `<button class="btn quiet small" type="button" data-act="edit-wh">Edit</button>
               <button class="btn danger small" type="button" data-act="archive-wh">Archive</button>`
            : `<button class="btn quiet small" type="button" data-act="restore-wh">Restore</button>`}
        </div>
      </div>
      ${w.notes ? `<p class="notes">${esc(w.notes)}</p>` : ''}
      ${w.is_active ? '' : `<p class="archived-note">This warehouse is archived. It keeps its history but can't receive new zones or stock until restored.</p>`}

      <div class="zones-head">
        <h3>Zones</h3>
        ${w.is_active ? `<button class="btn small" type="button" data-act="add-zone">Add zone</button>` : ''}
      </div>
      ${zones.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Address</th><th>Zone</th><th>Type</th><th>Pick seq.</th><th><span class="sr">Actions</span></th></tr></thead>
        <tbody>${zones.map((z) => `
          <tr class="${z.is_active ? '' : 'is-archived'}">
            <td><span class="tape${z.is_active ? '' : ' archived'}">${esc(w.code)}-${esc(z.code)}</span></td>
            <td><strong>${esc(z.name)}</strong>${z.notes ? `<div class="znotes">${esc(z.notes)}</div>` : ''}</td>
            <td>${esc(ZONE_LABELS[z.zone_type] || z.zone_type)}</td>
            <td>${z.pick_sequence ?? '—'}</td>
            <td class="acts">${z.is_active
              ? `<button class="btn quiet small" type="button" data-act="edit-zone" data-z="${z.id}">Edit</button><button class="btn danger small" type="button" data-act="archive-zone" data-z="${z.id}">Archive</button>`
              : `<button class="btn quiet small" type="button" data-act="restore-zone" data-z="${z.id}">Restore</button>`}</td>
          </tr>`).join('')}
        </tbody></table></div>`
      : `<div class="empty" style="padding:1rem 0"><p>${w.is_active
          ? 'No zones yet. Split this warehouse into areas such as a raw material reel yard, finished goods storage and a dispatch staging area.'
          : 'No zones.'}</p></div>`}
    `;
  }

  // ---------- forms ----------
  function clearErrors(form, errEl) {
    form.querySelectorAll('.field').forEach((f) => { f.classList.remove('has-err'); f.querySelector('.err').textContent = ''; });
    errEl.hidden = true;
  }

  function showError(form, errEl, e) {
    const field = e.field && form.querySelector(`.field[data-f="${e.field}"]`);
    if (field) {
      field.classList.add('has-err');
      field.querySelector('.err').textContent = e.message;
      field.querySelector('input,select,textarea')?.focus();
    } else {
      errEl.textContent = e.message;
      errEl.hidden = false;
    }
  }

  function openWhForm(w) {
    state.editing = w || null;
    const f = $('formWh');
    f.reset();
    clearErrors(f, $('whFormErr'));
    $('dlgWhTitle').textContent = w ? `Edit ${w.code}` : 'Add warehouse';
    $('whSubmit').textContent = w ? 'Save changes' : 'Save warehouse';
    if (w) {
      f.name.value = w.name; f.code.value = w.code; f.walk_order.value = w.walk_order ?? '';
      f.address.value = w.address; f.notes.value = w.notes;
    }
    $('dlgWh').showModal();
    f.name.focus();
  }

  function openZoneForm(z) {
    state.editing = z || null;
    const f = $('formZone');
    f.reset();
    clearErrors(f, $('zoneFormErr'));
    const w = state.warehouses.find((x) => x.id === state.selectedId);
    $('dlgZoneTitle').textContent = z ? `Edit ${w.code}-${z.code}` : `Add zone to ${w.code}`;
    $('zSubmit').textContent = z ? 'Save changes' : 'Save zone';
    if (z) {
      f.name.value = z.name; f.zone_type.value = z.zone_type; f.code.value = z.code;
      f.pick_sequence.value = z.pick_sequence ?? ''; f.notes.value = z.notes;
    } else {
      f.zone_type.value = '';
    }
    $('dlgZone').showModal();
    f.name.focus();
  }

  async function submitForm(ev, kind) {
    ev.preventDefault();
    const f = ev.target;
    const errEl = kind === 'wh' ? $('whFormErr') : $('zoneFormErr');
    const btn = kind === 'wh' ? $('whSubmit') : $('zSubmit');
    if (btn.disabled) return; // blocks double-submit
    clearErrors(f, errEl);

    const body = Object.fromEntries(new FormData(f).entries());
    body.code = (body.code || '').trim().toUpperCase();
    const ed = state.editing;
    if (ed) body.version = ed.version;

    btn.disabled = true;
    try {
      let saved;
      if (kind === 'wh') {
        saved = ed ? await api('PUT', `/api/warehouses/${ed.id}`, body) : await api('POST', '/api/warehouses', body);
        state.selectedId = saved.id;
        toast(ed ? `Saved ${saved.code}` : `Added ${saved.code} — ${saved.name}`);
        $('dlgWh').close();
      } else {
        saved = ed ? await api('PUT', `/api/zones/${ed.id}`, body) : await api('POST', `/api/warehouses/${state.selectedId}/zones`, body);
        toast(ed ? `Saved zone ${saved.code}` : `Added zone ${saved.code} — ${saved.name}`);
        $('dlgZone').close();
      }
      await load();
    } catch (e) {
      showError(f, errEl, e);
      if (e.status === 409 && !e.field) await load(); // someone else changed it: refresh data
    } finally {
      btn.disabled = false;
    }
  }

  async function setStatus(kind, rec, action) {
    const label = kind === 'wh' ? `${rec.code} — ${rec.name}` : `zone ${rec.code} — ${rec.name}`;
    if (action === 'archive' && !confirm(`Archive ${label}? It will be hidden but its history is kept, and you can restore it later.`)) return;
    try {
      const url = kind === 'wh' ? `/api/warehouses/${rec.id}/${action}` : `/api/zones/${rec.id}/${action}`;
      await api('POST', url, { version: rec.version });
      toast(`${action === 'archive' ? 'Archived' : 'Restored'} ${label}`);
    } catch (e) {
      toast(e.message, true);
    }
    await load();
  }

  async function showAudit() {
    const list = $('auditList');
    list.innerHTML = '<li>Loading…</li>';
    $('dlgAudit').showModal();
    try {
      const { entries } = await api('GET', '/api/audit');
      const verbs = { create: 'added', update: 'edited', archive: 'archived', restore: 'restored' };
      list.innerHTML = entries.length ? entries.map((a) => {
        const r = a.after || a.before || {};
        const what = a.entity === 'warehouse' ? `warehouse ${r.code} (${r.name})` : `zone ${r.code} (${r.name})`;
        return `<li><strong>${esc(a.actor)}</strong> ${verbs[a.action] || esc(a.action)} ${esc(what)}
          <div class="when">${esc(new Date(a.at).toLocaleString())}</div></li>`;
      }).join('') : '<li>No changes yet.</li>';
    } catch (e) {
      list.innerHTML = `<li>${esc(e.message)}</li>`;
    }
  }

  // ---------- events ----------
  function init() {
    $('zType').innerHTML = '<option value="" disabled>Choose a type</option>' +
      Object.entries(ZONE_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('');

    $('btnAddWh').addEventListener('click', () => openWhForm());
    $('btnAudit').addEventListener('click', showAudit);
    $('search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
    $('showArchived').addEventListener('change', (e) => { state.showArchived = e.target.checked; render(); });
    $('formWh').addEventListener('submit', (e) => submitForm(e, 'wh'));
    $('formZone').addEventListener('submit', (e) => submitForm(e, 'zone'));
    document.querySelectorAll('dialog [data-close]').forEach((b) =>
      b.addEventListener('click', () => b.closest('dialog').close()));

    $('whList').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wh]');
      if (!b) return;
      state.selectedId = Number(b.dataset.wh);
      render();
      $('detail').scrollIntoView({ block: 'start' });
    });

    $('detail').addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const w = state.warehouses.find((x) => x.id === state.selectedId);
      const z = b.dataset.z && w?.zones.find((x) => x.id === Number(b.dataset.z));
      switch (b.dataset.act) {
        case 'add-wh': return openWhForm();
        case 'back': state.selectedId = null; return render();
        case 'edit-wh': return openWhForm(w);
        case 'archive-wh': return setStatus('wh', w, 'archive');
        case 'restore-wh': return setStatus('wh', w, 'restore');
        case 'add-zone': return openZoneForm();
        case 'edit-zone': return openZoneForm(z);
        case 'archive-zone': return setStatus('zone', z, 'archive');
        case 'restore-zone': return setStatus('zone', z, 'restore');
      }
    });

    load();
  }

  init();
})();
