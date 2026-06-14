'use strict';

// REST base — mounted by the server under the plugin id.
const API = '/plugins/signalk-rules/api';
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// operator -> short label for the table summary
const OP_LABEL = {
  greaterThan: '>', greaterThanInclusive: '≥', lessThan: '<', lessThanInclusive: '≤',
  equal: '=', notEqual: '≠', contains: 'contains', doesNotContain: 'excludes',
  in: 'in', notIn: 'not in', isTrue: 'is true', isFalse: 'is false',
  withinRadius: 'within', outsideRadius: 'outside',
};

let rules = [];
let editingId = null; // null => creating

const $ = (id) => document.getElementById(id);

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => (t.className = 'toast'), 2800);
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error((data && data.error) || res.statusText);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
  );
}

const rulesById = (id) => rules.find((r) => r.id === id);

async function detectType(path) {
  return api('GET', '/paths/' + encodeURIComponent(path) + '/type');
}

// ---- table render ---------------------------------------------------------

function fmtVal(v) {
  if (v && typeof v === 'object') {
    if ('latitude' in v) return `${v.latitude},${v.longitude} r${v.radius}m`;
    return JSON.stringify(v);
  }
  return String(v);
}
function shortPath(p) {
  const parts = String(p).split('.');
  return parts.length > 2 ? '…' + parts.slice(-2).join('.') : p;
}

function describeCondition(t) {
  const c = t.conditions || {};
  const tests = c.all || c.any || [];
  const join = c.all ? ' AND ' : ' OR ';
  const txt = tests
    .map((l) => `${shortPath(l.fact)} ${OP_LABEL[l.operator] || l.operator} ${l.value && typeof l.value === 'object' ? '' : esc(fmtVal(l.value))}`)
    .join(join);
  return `<span class="chip cond">condition</span> <span class="mono">${txt}</span>`;
}

function describeWhen(r) {
  const t = r.trigger || {};
  if (t.kind === 'condition') return describeCondition(t);
  if (t.kind === 'schedule') {
    if (t.schedule === 'clock') {
      const days = t.days && t.days.length ? t.days.map((d) => DAY_NAMES[d]).join(',') : 'daily';
      return `<span class="chip sched">schedule</span> ${esc(t.time || '??:??')} <span class="muted">${esc(days)}</span>`;
    }
    const off = t.offsetMinutes ? ` ${t.offsetMinutes > 0 ? '+' : ''}${t.offsetMinutes}m` : '';
    return `<span class="chip sched">schedule</span> ${esc(t.schedule)}${esc(off)}`;
  }
  return '<span class="muted">—</span>';
}

function describeThen(r) {
  const acts = r.actions || [];
  if (!acts.length) return '<span class="muted">—</span>';
  return acts
    .map((a) =>
      a.type === 'put'
        ? `<span class="chip">put</span> <span class="mono">${esc(shortPath(a.path))}=${esc(fmtVal(a.value))}</span>`
        : `<span class="chip">notify</span> <span class="mono">${esc(shortPath(a.path))}:${esc(a.state)}</span>`
    )
    .join('<br/>');
}

function describeLastFired(r) {
  const lr = r.lastResult;
  if (!lr) return '<span class="muted">never</span>';
  const when = new Date(lr.at).toLocaleString();
  const cls = lr.ok ? 'ok' : 'fail';
  return `<span class="${cls}">${lr.ok ? 'ok' : 'failed'}</span> <span class="muted">${esc(when)} (${esc(lr.trigger)})</span>`;
}

function render() {
  const body = $('rulesBody');
  body.innerHTML = '';
  $('emptyState').classList.toggle('hidden', rules.length > 0);
  $('rulesTable').classList.toggle('hidden', rules.length === 0);
  for (const r of rules) {
    const isCond = r.trigger && r.trigger.kind === 'condition';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><label class="switch"><input type="checkbox" ${r.enabled ? 'checked' : ''} data-enable="${esc(r.id)}" /><span class="slider"></span></label></td>
      <td><strong>${esc(r.name)}</strong></td>
      <td>${describeWhen(r)}</td>
      <td>${describeThen(r)}</td>
      <td>${describeLastFired(r)}</td>
      <td><div class="row-actions">
        ${isCond ? `<button class="small" data-check="${esc(r.id)}">Check</button>` : ''}
        <button class="small" data-run="${esc(r.id)}">Run</button>
        <button class="small" data-edit="${esc(r.id)}">Edit</button>
      </div></td>`;
    body.appendChild(tr);
  }
}

async function load() {
  try {
    const data = await api('GET', '/rules');
    rules = (data && data.rules) || [];
    render();
  } catch (e) {
    toast('Failed to load rules: ' + e.message, true);
  }
  loadPaths();
}

async function loadPaths() {
  try {
    const data = await api('GET', '/paths');
    $('pathOptions').innerHTML = ((data && data.paths) || [])
      .sort()
      .map((p) => `<option value="${esc(p)}"></option>`)
      .join('');
  } catch {
    /* picker is a nicety */
  }
}

// ---- condition test rows --------------------------------------------------

function renderValueInput(container, kind, preset) {
  if (kind === 'none') {
    container.innerHTML = '';
  } else if (kind === 'number') {
    container.innerHTML = `<input type="number" class="v-num" placeholder="value" value="${preset != null ? esc(preset) : ''}" />`;
  } else if (kind === 'radius') {
    const v = preset && typeof preset === 'object' ? preset : {};
    container.innerHTML = `<div class="vbox">
        <input type="number" class="v-lat" placeholder="lat" value="${v.latitude != null ? esc(v.latitude) : ''}" />
        <input type="number" class="v-lon" placeholder="lon" value="${v.longitude != null ? esc(v.longitude) : ''}" />
        <input type="number" class="v-rad" placeholder="metres" value="${v.radius != null ? esc(v.radius) : ''}" />
      </div>`;
  } else {
    container.innerHTML = `<input type="text" class="v-txt" placeholder="value" value="${preset != null && typeof preset !== 'object' ? esc(preset) : ''}" />`;
  }
}

function selectedOpKind(opSelect) {
  const opt = opSelect.options[opSelect.selectedIndex];
  return (opt && opt.dataset.kind) || 'text';
}

function testRow(leaf) {
  leaf = leaf || { fact: '', operator: '', value: '' };
  const div = document.createElement('div');
  div.className = 'test-row';
  div.innerHTML = `
    <input type="text" class="t-path" list="pathOptions" placeholder="navigation.depth.belowKeel" value="${esc(leaf.fact)}" />
    <select class="t-op"><option value="">choose path…</option></select>
    <div class="t-val"></div>
    <button class="small danger t-del" type="button">✕</button>
    <div class="nowval"></div>`;

  const pathIn = div.querySelector('.t-path');
  const opSel = div.querySelector('.t-op');
  const valBox = div.querySelector('.t-val');
  const now = div.querySelector('.nowval');

  div.querySelector('.t-del').onclick = () => div.remove();
  opSel.onchange = () => renderValueInput(valBox, selectedOpKind(opSel), undefined);

  async function refreshForPath(presetOp, presetVal) {
    const path = pathIn.value.trim();
    if (!path) return;
    try {
      const info = await detectType(path);
      const ops = info.operators || [];
      opSel.innerHTML = ops
        .map((o) => `<option value="${esc(o.op)}" data-kind="${esc(o.value)}">${esc(o.label)}</option>`)
        .join('') || '<option value="">(no operators)</option>';
      if (presetOp) opSel.value = presetOp;
      now.textContent =
        `type: ${info.dataType}${info.unit ? ' (' + info.unit + ')' : ''} · current: ` +
        (info.current === undefined ? '(no value)' : fmtVal(info.current));
      renderValueInput(valBox, selectedOpKind(opSel), presetVal);
    } catch (e) {
      now.textContent = 'could not detect type: ' + e.message;
    }
  }

  pathIn.onchange = () => refreshForPath();
  // existing leaf: populate immediately
  if (leaf.fact) refreshForPath(leaf.operator, leaf.value);
  return div;
}

function collectLeaf(div) {
  const fact = div.querySelector('.t-path').value.trim();
  const opSel = div.querySelector('.t-op');
  const operator = opSel.value;
  const kind = selectedOpKind(opSel);
  let value;
  if (kind === 'none') value = operator === 'isFalse' ? false : true;
  else if (kind === 'number') value = Number(div.querySelector('.v-num')?.value);
  else if (kind === 'radius')
    value = {
      latitude: Number(div.querySelector('.v-lat')?.value),
      longitude: Number(div.querySelector('.v-lon')?.value),
      radius: Number(div.querySelector('.v-rad')?.value),
    };
  else value = div.querySelector('.v-txt')?.value ?? '';
  return { fact, operator, value };
}

function collectConditions() {
  const match = $('f-match').value; // 'all' | 'any'
  const tests = [...$('testsList').querySelectorAll('.test-row')]
    .map(collectLeaf)
    .filter((l) => l.fact && l.operator);
  return { [match]: tests };
}

// ---- action rows ----------------------------------------------------------

function inferVtype(v) {
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return 'number';
  return 'text';
}

function actionRow(a) {
  a = a || { type: 'put', path: '', value: '' };
  const div = document.createElement('div');
  div.className = 'action-row';
  const vtype = a.type === 'put' ? inferVtype(a.value) : 'text';
  const vstr = a.type === 'put' && vtype !== 'true' && vtype !== 'false' && a.value != null ? a.value : '';
  div.innerHTML = `
    <div class="vbox">
      <select class="a-type" style="max-width:150px">
        <option value="put">set a value</option>
        <option value="notification">raise notification</option>
      </select>
      <input type="text" class="a-path" list="pathOptions" placeholder="electrical.switches.nav.state" value="${esc(a.path)}" />
      <button class="small danger a-del" type="button">✕</button>
    </div>
    <div class="a-put vbox" style="margin-top:6px">
      <select class="a-vtype" style="max-width:130px">
        <option value="number">Number</option>
        <option value="text">Text</option>
        <option value="true">On (true)</option>
        <option value="false">Off (false)</option>
      </select>
      <input type="text" class="a-value" placeholder="value to set" value="${esc(vstr)}" />
      <button class="small a-now" type="button" title="show current value">now?</button>
    </div>
    <div class="a-notif" style="margin-top:6px">
      <div class="grid2">
        <select class="a-state">
          <option value="alarm">alarm</option><option value="warn">warn</option>
          <option value="alert">alert</option><option value="normal">normal</option>
          <option value="emergency">emergency</option>
        </select>
        <input type="text" class="a-message" placeholder="message" value="${esc(a.message || '')}" />
      </div>
      <div style="margin-top:6px; display:flex; gap:14px; align-items:center;">
        <span class="muted" style="font-size:12px">Notify by:</span>
        <label style="display:inline-flex;gap:4px;align-items:center;font-weight:500;margin:0;"><input type="checkbox" class="a-method" value="visual" ${!a.methods || a.methods.includes('visual') ? 'checked' : ''}/> visual</label>
        <label style="display:inline-flex;gap:4px;align-items:center;font-weight:500;margin:0;"><input type="checkbox" class="a-method" value="sound" ${a.methods && a.methods.includes('sound') ? 'checked' : ''}/> sound</label>
      </div>
    </div>`;

  const typeSel = div.querySelector('.a-type');
  const vSel = div.querySelector('.a-vtype');
  const vInput = div.querySelector('.a-value');
  typeSel.value = a.type || 'put';
  vSel.value = vtype;
  if (a.type === 'notification' && a.state) div.querySelector('.a-state').value = a.state;

  const syncType = () => {
    const isPut = typeSel.value === 'put';
    div.querySelector('.a-put').classList.toggle('hidden', !isPut);
    div.querySelector('.a-notif').classList.toggle('hidden', isPut);
  };
  const syncVtype = () => {
    vInput.style.visibility = vSel.value === 'true' || vSel.value === 'false' ? 'hidden' : 'visible';
  };
  typeSel.onchange = syncType;
  vSel.onchange = syncVtype;
  div.querySelector('.a-del').onclick = () => div.remove();

  // auto-pick value type from the path, and show current value
  div.querySelector('.a-path').onchange = async () => {
    const path = div.querySelector('.a-path').value.trim();
    if (!path || typeSel.value !== 'put') return;
    try {
      const info = await detectType(path);
      if (info.dataType === 'boolean') vSel.value = info.current === false ? 'false' : 'true';
      else if (info.dataType === 'numeric' || info.dataType === 'angular') vSel.value = 'number';
      else vSel.value = 'text';
      syncVtype();
    } catch {
      /* ignore */
    }
  };
  div.querySelector('.a-now').onclick = async () => {
    const path = div.querySelector('.a-path').value.trim();
    if (!path) return;
    try {
      const info = await detectType(path);
      toast('current ' + shortPath(path) + ' = ' + (info.current === undefined ? '(none)' : fmtVal(info.current)));
    } catch (e) {
      toast(e.message, true);
    }
  };

  syncType();
  syncVtype();
  return div;
}

function collectAction(div) {
  const type = div.querySelector('.a-type').value;
  const path = div.querySelector('.a-path').value.trim();
  if (type === 'put') {
    const vt = div.querySelector('.a-vtype').value;
    let value;
    if (vt === 'true') value = true;
    else if (vt === 'false') value = false;
    else if (vt === 'number') value = Number(div.querySelector('.a-value').value);
    else value = div.querySelector('.a-value').value;
    return { type, path, value };
  }
  const methods = [...div.querySelectorAll('.a-method:checked')].map((c) => c.value);
  return {
    type,
    path,
    state: div.querySelector('.a-state').value,
    message: div.querySelector('.a-message').value.trim(),
    methods: methods.length ? methods : ['visual'],
  };
}

// ---- trigger visibility ---------------------------------------------------

function syncTriggerVisibility() {
  const kind = $('f-trigger-kind').value;
  $('cond-fields').classList.toggle('hidden', kind !== 'condition');
  $('sched-fields').classList.toggle('hidden', kind !== 'schedule');
  const sched = $('f-schedule').value;
  $('clock-fields').classList.toggle('hidden', sched !== 'clock');
  $('sun-fields').classList.toggle('hidden', sched === 'clock');
}

function buildDays(selected) {
  $('daysList').innerHTML = DAY_NAMES.map(
    (d, i) => `<label><input type="checkbox" class="day" value="${i}" ${selected && selected.includes(i) ? 'checked' : ''}/> ${d}</label>`
  ).join('');
}

// ---- modal open / collect / save ------------------------------------------

function openModal(rule) {
  editingId = rule ? rule.id : null;
  $('modalTitle').textContent = rule ? 'Edit rule' : 'Add rule';
  $('deleteBtn').classList.toggle('hidden', !rule);
  $('checkResult').classList.add('hidden');

  $('f-id').value = rule ? rule.id : '';
  $('f-name').value = rule ? rule.name : '';
  $('f-debounce').value = rule && rule.debounceMs != null ? rule.debounceMs : '';

  const t = (rule && rule.trigger) || { kind: 'condition', conditions: { all: [] }, edge: 'rising' };
  $('f-trigger-kind').value = t.kind || 'condition';
  $('f-edge').value = t.edge || 'rising';
  $('f-schedule').value = t.schedule || 'clock';
  $('f-time').value = t.time || '';
  $('f-offset').value = t.offsetMinutes != null ? t.offsetMinutes : '';

  // condition tests
  const cond = t.kind === 'condition' ? t.conditions || { all: [] } : { all: [] };
  $('f-match').value = cond.any ? 'any' : 'all';
  const tests = cond.all || cond.any || [];
  $('testsList').innerHTML = '';
  (tests.length ? tests : [{ fact: '', operator: '', value: '' }]).forEach((l) =>
    $('testsList').appendChild(testRow(l))
  );

  buildDays(t.days || []);

  $('actionsList').innerHTML = '';
  const acts = rule && rule.actions && rule.actions.length ? rule.actions : [{ type: 'put', path: '', value: '' }];
  acts.forEach((a) => $('actionsList').appendChild(actionRow(a)));

  syncTriggerVisibility();
  $('backdrop').classList.add('show');
}

function closeModal() {
  $('backdrop').classList.remove('show');
  editingId = null;
}

function collectRule() {
  const kind = $('f-trigger-kind').value;
  let trigger;
  if (kind === 'condition') {
    trigger = { kind, conditions: collectConditions(), edge: $('f-edge').value };
  } else {
    trigger = { kind: 'schedule', schedule: $('f-schedule').value };
    if (trigger.schedule === 'clock') {
      trigger.time = $('f-time').value.trim();
      trigger.days = [...$('daysList').querySelectorAll('.day:checked')].map((c) => Number(c.value));
    } else {
      const off = $('f-offset').value.trim();
      if (off !== '') trigger.offsetMinutes = Number(off);
    }
  }
  const actions = [...$('actionsList').querySelectorAll('.action-row')].map(collectAction);
  const rule = { name: $('f-name').value.trim(), enabled: editingId ? !!rulesById(editingId)?.enabled : true, trigger, actions };
  const deb = $('f-debounce').value.trim();
  if (deb !== '') rule.debounceMs = Number(deb);
  if (editingId) rule.id = editingId;
  return rule;
}

async function save() {
  const rule = collectRule();
  if (!rule.name) return toast('Name is required', true);
  if (!rule.actions.length) return toast('Add at least one action', true);
  if (rule.trigger.kind === 'condition') {
    const tests = rule.trigger.conditions.all || rule.trigger.conditions.any || [];
    if (!tests.length) return toast('Add at least one condition test', true);
  }
  try {
    if (editingId) await api('PUT', '/rules/' + encodeURIComponent(editingId), rule);
    else await api('POST', '/rules', rule);
    toast('Saved');
    closeModal();
    await load();
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  }
}

async function doDelete() {
  if (!editingId || !confirm('Delete this rule?')) return;
  try {
    await api('DELETE', '/rules/' + encodeURIComponent(editingId));
    toast('Deleted');
    closeModal();
    await load();
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

function renderCheck(out) {
  const box = $('checkResult');
  box.classList.remove('hidden');
  if (out.error) {
    box.innerHTML = `<div class="verdict e">Error: ${esc(out.error)}</div>`;
    return;
  }
  const verdict = out.result
    ? '<span class="verdict t">● TRUE — would fire on a rising edge</span>'
    : '<span class="verdict f">○ FALSE — not firing right now</span>';
  const facts = Object.entries(out.facts || {})
    .map(([k, v]) => `<div><span class="mono">${esc(shortPath(k))}</span> = <span class="mono">${esc(fmtVal(v))}</span></div>`)
    .join('');
  box.innerHTML = `<div>${verdict}</div><div class="eval-facts">${facts}</div>`;
}

async function checkNow() {
  const conditions = collectConditions();
  const tests = conditions.all || conditions.any || [];
  if (!tests.length) return toast('Add a test first', true);
  try {
    renderCheck(await api('POST', '/evaluate', { conditions }));
  } catch (e) {
    toast('Check failed: ' + e.message, true);
  }
}

// ---- table actions --------------------------------------------------------

document.addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.dataset.edit) openModal(rulesById(t.dataset.edit));
  else if (t.dataset.run) {
    const rule = rulesById(t.dataset.run);
    try {
      // Respect the condition: for a condition rule, only fire if it's true now.
      if (rule && rule.trigger && rule.trigger.kind === 'condition') {
        const ev2 = await api('POST', '/evaluate', { conditions: rule.trigger.conditions });
        if (ev2.error) return toast('Condition error: ' + ev2.error, true);
        if (!ev2.result) return toast('Condition is false right now — actions not run');
      }
      const r = await api('POST', '/rules/' + encodeURIComponent(t.dataset.run) + '/test');
      const failed = (r.actionResults || []).filter((a) => !a.ok);
      if (r.ok) toast('Ran ' + r.actionResults.length + ' action(s) ok');
      else toast('Ran with failures: ' + failed.map((a) => a.message).join('; '), true);
      await load();
    } catch (e) {
      toast('Run failed: ' + e.message, true);
    }
  } else if (t.dataset.check) {
    const r = rulesById(t.dataset.check);
    try {
      const out = await api('POST', '/evaluate', { conditions: r.trigger.conditions });
      if (out.error) toast('Condition error: ' + out.error, true);
      else toast('Condition is ' + (out.result ? 'TRUE' : 'false') + ' right now');
    } catch (e) {
      toast('Check failed: ' + e.message, true);
    }
  }
});

document.addEventListener('change', async (ev) => {
  const id = ev.target.dataset.enable;
  if (!id) return;
  try {
    await api('POST', '/rules/' + encodeURIComponent(id) + '/enabled', { enabled: ev.target.checked });
    const r = rulesById(id);
    if (r) r.enabled = ev.target.checked;
    toast(ev.target.checked ? 'Enabled' : 'Disabled');
  } catch (e) {
    toast('Failed: ' + e.message, true);
    ev.target.checked = !ev.target.checked;
  }
});

// ---- wire up --------------------------------------------------------------

$('addBtn').onclick = () => openModal(null);
$('cancelBtn').onclick = closeModal;
$('saveBtn').onclick = save;
$('deleteBtn').onclick = doDelete;
$('addTestBtn').onclick = () => $('testsList').appendChild(testRow());
$('addActionBtn').onclick = () => $('actionsList').appendChild(actionRow());
$('checkBtn').onclick = checkNow;
$('f-trigger-kind').onchange = syncTriggerVisibility;
$('f-schedule').onchange = syncTriggerVisibility;
$('backdrop').onclick = (e) => {
  if (e.target === $('backdrop')) closeModal();
};

load();
