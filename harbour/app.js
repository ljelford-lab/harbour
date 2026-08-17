/* ============================================================
   HARBOUR — app logic
   Data now lives in a small Netlify Blobs store via serverless functions
   at /.netlify/functions/week and /.netlify/functions/weeks-index, not in
   the browser — that's what lets the
   daily email (a server-side cron job) read your plan. A copy is
   still cached in localStorage under 'harbour_cache_v3' purely so
   the app has something to show instantly on load / while offline;
   the cache is never the source of truth once the network is up.
   `state` always points at the week currently being viewed —
   navigating weeks swaps which object it points to, so every
   render/edit function below just reads/writes `state` as before.
   Goals, Tasks, and CalendarBlocks stay separate objects, exactly
   as laid out in the spec: scheduling a thing never changes what
   kind of goal it is or how its progress is measured.
   ============================================================ */

const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const START_HOUR = 6;
const END_HOUR = 23; // exclusive end of grid
const ROW_PX = 48;
const CACHE_KEY = 'harbour_cache_v3';
const TOKEN_KEY = 'harbour_token';
const OLD_STORE_KEY = 'harbour_state_v1';    // pre-cloud single-week format
const OLDER_STORE_KEY = 'harbour_data_v2';   // pre-cloud multi-week format
const MOBILE_BREAKPOINT = 700;
const SAVE_DEBOUNCE_MS = 700;

// ---------- utils ----------
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function pad2(n){ return n.toString().padStart(2,'0'); }
function minutesToTime(m){ return pad2(Math.floor(m/60)) + ':' + pad2(m%60); }
function timeToMinutes(t){ const [h,m] = t.split(':').map(Number); return h*60+m; }
function clamp(v,lo,hi){ return Math.max(lo, Math.min(hi, v)); }
function isMobileView(){ return window.innerWidth <= MOBILE_BREAKPOINT; }

function mondayOf(date){
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // 0 = Monday
  d.setDate(d.getDate() - day);
  d.setHours(0,0,0,0);
  return d;
}
// Local-calendar-date formatter. Deliberately NOT toISOString() — that
// converts to UTC first, which silently rolls the date back a day for
// anyone in a UTC+ timezone (e.g. UK on BST in summer).
function isoDate(d){ return d.getFullYear() + '-' + pad2(d.getMonth()+1) + '-' + pad2(d.getDate()); }
function fmtDay(d){ return d.toLocaleDateString('en-GB', { day:'numeric', month:'short' }); }
function fmtDayShort(d){ return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' }); }
function currentMondayIso(){ return isoDate(mondayOf(new Date())); }

// ---------- cloud store ----------
function emptyWeek(){
  return { goals:[], tasks:[], blocks:[], shifts:[], reflection:{ wentWell:'', notWell:'', improve:'' } };
}

let db = { weeks:{} };                          // in-memory cache of weeks fetched so far: { isoMonday: weekObj }
let weeksIndexCache = [];                        // [{iso, pct}] for the Past weeks panel
let viewingWeekStart = currentMondayIso();
let state = emptyWeek();                         // the week object currently being viewed/edited
let mobileDay = null;                            // session-only, which day the mobile single-day view is showing
let saveTimers = {};                             // per-week debounce timers
let isOnline = true;                             // flips to false if a save/fetch fails
let lastSyncError = '';                          // human-readable reason for the last failure, shown in the badge
let lastSyncNote = '';                           // non-error info (e.g. "server had nothing saved yet")
let token = localStorage.getItem(TOKEN_KEY) || '';

function readLocalCache(){
  try{
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : { weeks:{} };
  }catch(e){ return { weeks:{} }; }
}
function writeLocalCache(){
  try{ localStorage.setItem(CACHE_KEY, JSON.stringify(db)); }
  catch(e){ console.error('Harbour: could not write local cache.', e); }
}
// one-off migration note for anyone upgrading from the pure-localStorage
// versions: their old data stays in the browser under the old keys, but
// isn't automatically pushed to the cloud (that data never had a server
// to go to). Surface it once so it isn't silently lost.
function hasLegacyLocalData(){
  return !!(localStorage.getItem(OLD_STORE_KEY) || localStorage.getItem(OLDER_STORE_KEY));
}

async function apiFetch(path, opts={}){
  const res = await fetch(path, {
    ...opts,
    headers: {
      'Content-Type':'application/json',
      'x-harbour-token': token,
      ...(opts.headers||{})
    }
  });
  if(res.status===401){
    token = '';
    localStorage.removeItem(TOKEN_KEY);
    showTokenGate('Your access code was rejected — enter it again.');
    throw new Error('unauthorized');
  }
  if(!res.ok) throw new Error('request failed: ' + res.status);
  return res.status===204 ? null : res.json();
}

async function fetchWeek(iso){
  try{
    const result = await apiFetch(`/.netlify/functions/week?iso=${iso}`);
    const hadData = !!(result && result.data);
    const wk = hadData ? result.data : emptyWeek();
    if(!wk.reflection) wk.reflection = { wentWell:'', notWell:'', improve:'' };
    db.weeks[iso] = wk;
    isOnline = true;
    lastSyncError = '';
    lastSyncNote = hadData ? '' : `server has no saved data for ${iso} yet`;
    writeLocalCache();
    return wk;
  }catch(e){
    console.error('Harbour: fetch failed, falling back to local cache.', e);
    isOnline = false;
    lastSyncError = (e && e.message) ? e.message : String(e);
    const cache = readLocalCache();
    return cache.weeks[iso] || emptyWeek();
  }
}

function scheduleSave(iso){
  clearTimeout(saveTimers[iso]);
  saveTimers[iso] = setTimeout(async ()=>{
    try{
      await apiFetch(`/.netlify/functions/week?iso=${iso}`, { method:'PUT', body: JSON.stringify(db.weeks[iso]) });
      isOnline = true;
      lastSyncError = '';
      refreshWeeksIndex();
    }catch(e){
      console.error('Harbour: save failed — your last change is only stored on this device for now.', e);
      isOnline = false;
      lastSyncError = (e && e.message) ? e.message : String(e);
    }
    updateOnlineBadge();
  }, SAVE_DEBOUNCE_MS);
  writeLocalCache(); // cache instantly, network save is debounced above
}

async function refreshWeeksIndex(){
  try{
    const result = await apiFetch('/.netlify/functions/weeks-index');
    weeksIndexCache = (result.weeks||[]).sort((a,b)=> b.iso.localeCompare(a.iso));
    renderPastWeeks();
  }catch(e){ /* keep showing whatever we already had */ }
}

async function goToWeek(iso){
  viewingWeekStart = iso;
  mobileDay = null;
  state = db.weeks[iso] || (db.weeks[iso] = await fetchWeek(iso));
  await refreshWeeksIndex();
  renderAll();
}
function shiftWeek(delta){
  const d = new Date(viewingWeekStart + 'T00:00:00');
  d.setDate(d.getDate() + delta*7);
  goToWeek(isoDate(d));
}

// ---------- derived helpers ----------
function weekDates(){
  const start = new Date(viewingWeekStart + 'T00:00:00');
  return Array.from({length:7}, (_,i) => {
    const d = new Date(start); d.setDate(d.getDate()+i); return d;
  });
}
function todayIndex(){
  const start = new Date(viewingWeekStart + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((today - start) / 86400000);
  return clamp(diff, 0, 6);
}
function isTodayWithinWeek(){
  const start = new Date(viewingWeekStart + 'T00:00:00');
  const today = new Date(); today.setHours(0,0,0,0);
  const diff = Math.round((today - start) / 86400000);
  return diff >= 0 && diff <= 6;
}
function isViewingCurrentWeek(){ return viewingWeekStart === currentMondayIso(); }
function blocksFor(kind, id){ return state.blocks.filter(b => b.kind===kind && b.refId===id); }
function goalById(id){ return state.goals.find(g=>g.id===id); }
function taskById(id){ return state.tasks.find(t=>t.id===id); }


function goalProgressFraction(g){
  if(g.type==='completion' || g.type==='simple'){
    if(g.status==='complete') return 1;
    if(g.status==='in_progress') return 0.5;
    return 0;
  }
  if(g.type==='checklist'){
    const linked = state.tasks.filter(t=>t.goalId===g.id);
    if(linked.length===0) return 0;
    return linked.filter(t=>t.status==='done').length / linked.length;
  }
  // time, quantity, repetitions
  if(!g.targetValue) return 0;
  return clamp((g.currentValue||0) / g.targetValue, 0, 1);
}

function tideline(){
  if(state.goals.length===0) return 0;
  const total = state.goals.reduce((sum,g)=>sum+goalProgressFraction(g),0);
  return Math.round((total/state.goals.length)*100);
}

// completed time-blocked minutes for a goal (drives "time" goal progress)
function completedMinutesForGoal(goalId){
  return state.blocks
    .filter(b=>b.kind==='goal' && b.refId===goalId && b.completed)
    .reduce((sum,b)=>sum + (timeToMinutes(b.end)-timeToMinutes(b.start)), 0);
}

// ============================================================
// RENDER
// ============================================================
function renderAll(){
  renderHeader();
  renderGoalList();
  renderUnscheduled();
  renderPastWeeks();
  renderCalendar();
  renderToday();
  renderReflect();
  scheduleSave(viewingWeekStart);
}

function renderHeader(){
  const dates = weekDates();
  document.getElementById('weekRange').textContent =
    (isViewingCurrentWeek() ? 'This week · ' : '') + `${fmtDay(dates[0])} – ${fmtDay(dates[6])}`;
  document.getElementById('todayJumpBtn').style.display = isViewingCurrentWeek() ? 'none' : 'inline-block';
  const pct = tideline();
  document.getElementById('tidelineFill').style.width = pct + '%';
  document.getElementById('tidelineLabel').textContent = pct + '%';
}

// ---------- Goal list (sidebar) ----------
function unitLabel(g){ return g.targetUnit ? g.targetUnit : ''; }

function renderGoalList(){
  const wrap = document.getElementById('goalList');
  wrap.innerHTML = '';
  if(state.goals.length===0){
    wrap.innerHTML = '<div class="empty-hint">No goals yet — add one to get started.</div>';
    return;
  }
  state.goals.forEach(g=>{
    const card = document.createElement('div');
    card.className = 'goal-card';
    card.draggable = true;
    card.title = 'Drag onto the calendar to book a session — you can do this as many times as you like';
    card.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({kind:'goal', id:g.id}));
    });

    const top = document.createElement('div');
    top.className = 'goal-card-top';
    top.innerHTML = `
      <div>
        <div class="goal-card-title">${escapeHtml(g.title)}</div>
        <div class="goal-card-type">${typeLabel(g.type)}</div>
      </div>
      <div class="goal-progress-num">${progressText(g)}</div>
    `;
    card.appendChild(top);

    if(['time','quantity','repetitions'].includes(g.type)){
      const bar = document.createElement('div');
      bar.className='goal-bar';
      bar.innerHTML = `<div class="goal-bar-fill" style="width:${goalProgressFraction(g)*100}%"></div>`;
      card.appendChild(bar);

      const controls = document.createElement('div');
      controls.className = 'goal-controls';
      const step = g.type==='time' ? 0.5 : 1;
      controls.innerHTML = `
        <button class="btn small ghost" data-act="dec">−</button>
        <span style="font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">${g.currentValue||0} ${unitLabel(g)}</span>
        <button class="btn small ghost" data-act="inc">+</button>
      `;
      controls.querySelector('[data-act="inc"]').onclick = ()=>bumpGoal(g.id, step);
      controls.querySelector('[data-act="dec"]').onclick = ()=>bumpGoal(g.id, -step);
      card.appendChild(controls);
      if(g.type==='time'){
        const hint = document.createElement('div');
        hint.className='empty-hint';
        hint.style.marginTop='4px';
        hint.textContent = `${(completedMinutesForGoal(g.id)/60).toFixed(1)}h from completed calendar sessions`;
        card.appendChild(hint);
      }
    }

    if(g.type==='checklist'){
      const linked = state.tasks.filter(t=>t.goalId===g.id);
      const bar = document.createElement('div');
      bar.className='goal-bar';
      bar.innerHTML = `<div class="goal-bar-fill" style="width:${goalProgressFraction(g)*100}%"></div>`;
      card.appendChild(bar);
      const list = document.createElement('div');
      list.className = 'goal-checklist';
      if(linked.length===0){
        list.innerHTML = '<div class="empty-hint">Add tasks and link them to this goal.</div>';
      }
      linked.forEach(t=>{
        const row = document.createElement('label');
        row.innerHTML = `<input type="checkbox" ${t.status==='done'?'checked':''}> <span style="${t.status==='done'?'text-decoration:line-through;opacity:.5;':''}">${escapeHtml(t.title)}</span>`;
        row.querySelector('input').onchange = (e)=>{
          t.status = e.target.checked ? 'done' : 'open';
          renderAll();
        };
        list.appendChild(row);
      });
      card.appendChild(list);
    }

    if(g.type==='completion' || g.type==='simple'){
      const pill = document.createElement('button');
      pill.className = 'goal-status-pill' + (g.status==='complete' ? ' complete' : '');
      pill.style.marginTop='8px';
      pill.textContent = statusLabel(g);
      pill.onclick = ()=>{ cycleStatus(g); renderAll(); };
      card.appendChild(pill);
    }

    if(g.deadline){
      const dl = document.createElement('div');
      dl.className='empty-hint';
      dl.style.marginTop='6px';
      dl.textContent = 'Due ' + g.deadline;
      card.appendChild(dl);
    }

    const del = document.createElement('button');
    del.className='btn small ghost';
    del.style.marginTop='8px';
    del.textContent='Remove';
    del.onclick = ()=>{ removeGoal(g.id); };
    card.appendChild(del);

    wrap.appendChild(card);
  });
}

function typeLabel(t){
  return { completion:'Completion', time:'Time', quantity:'Quantity', repetitions:'Repetitions', checklist:'Checklist', simple:'Simple' }[t] || t;
}
function statusLabel(g){
  if(g.type==='completion') return g.status==='complete' ? 'Complete ✓' : 'Incomplete';
  return { not_started:'Not started', in_progress:'In progress', complete:'Complete ✓' }[g.status] || 'Not started';
}
function cycleStatus(g){
  if(g.type==='completion'){
    g.status = g.status==='complete' ? 'incomplete' : 'complete';
  } else {
    const order = ['not_started','in_progress','complete'];
    const i = order.indexOf(g.status);
    g.status = order[(i+1) % order.length];
  }
}
function progressText(g){
  if(g.type==='completion' || g.type==='simple') return statusLabel(g);
  if(g.type==='checklist'){
    const linked = state.tasks.filter(t=>t.goalId===g.id);
    return `${linked.filter(t=>t.status==='done').length}/${linked.length}`;
  }
  return `${g.currentValue||0}/${g.targetValue||0}`;
}
function bumpGoal(id, delta){
  const g = goalById(id); if(!g) return;
  g.currentValue = Math.max(0, +(( (g.currentValue||0) + delta ).toFixed(2)));
  renderAll();
}
function removeGoal(id){
  if(!confirm('Remove this goal? Linked tasks will stay, but any calendar sessions for it will be cleared.')) return;
  state.goals = state.goals.filter(g=>g.id!==id);
  state.blocks = state.blocks.filter(b=>!(b.kind==='goal' && b.refId===id));
  state.tasks.forEach(t=>{ if(t.goalId===id) t.goalId=null; });
  renderAll();
}

// ---------- Unscheduled panel ----------
function renderUnscheduled(){
  const goalsWrap = document.getElementById('unschedGoals');
  const tasksWrap = document.getElementById('unschedTasks');
  goalsWrap.innerHTML=''; tasksWrap.innerHTML='';

  const unschedGoals = state.goals.filter(g => !g.assignedDay && blocksFor('goal',g.id).length===0);
  const unschedTasks = state.tasks.filter(t => t.status!=='done' && !t.assignedDay && blocksFor('task',t.id).length===0);

  if(unschedGoals.length===0) goalsWrap.innerHTML = '<div class="empty-hint">Nothing unscheduled.</div>';
  unschedGoals.forEach(g=>{
    const el = document.createElement('div');
    el.className='unsched-item';
    el.draggable = true;
    el.innerHTML = `<span>${escapeHtml(g.title)}</span><span class="tag">${typeLabel(g.type)}</span>`;
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({kind:'goal', id:g.id}));
    });
    goalsWrap.appendChild(el);
  });

  if(unschedTasks.length===0) tasksWrap.innerHTML = '<div class="empty-hint">Nothing unscheduled.</div>';
  unschedTasks.forEach(t=>{
    const el = document.createElement('div');
    el.className='unsched-item';
    el.draggable = true;
    const goal = t.goalId ? goalById(t.goalId) : null;
    el.innerHTML = `<span>${escapeHtml(t.title)}</span><span class="tag">${goal? escapeHtml(goal.title).slice(0,14):''}</span>`;
    el.addEventListener('dragstart', e=>{
      e.dataTransfer.setData('text/plain', JSON.stringify({kind:'task', id:t.id}));
    });
    tasksWrap.appendChild(el);
  });

  const dropZone = document.getElementById('unscheduledDrop');
  dropZone.ondragover = e=>{ e.preventDefault(); dropZone.classList.add('dragover'); };
  dropZone.ondragleave = ()=> dropZone.classList.remove('dragover');
  dropZone.ondrop = e=>{
    e.preventDefault(); dropZone.classList.remove('dragover');
    const payload = safeParse(e.dataTransfer.getData('text/plain'));
    if(!payload) return;
    if(payload.kind==='block'){
      const block = state.blocks.find(b=>b.id===payload.blockId);
      if(block) state.blocks = state.blocks.filter(b=>b.id!==block.id);
    } else if(payload.kind==='anytime'){
      if(payload.itemKind==='task'){ const t=taskById(payload.id); if(t) t.assignedDay=null; }
      if(payload.itemKind==='goal'){ const g=goalById(payload.id); if(g) g.assignedDay=null; }
    }
    renderAll();
  };
}

function safeParse(str){ try{ return JSON.parse(str); }catch(e){ return null; } }

// ---------- Past weeks (sidebar look-back list) ----------
function renderPastWeeks(){
  const wrap = document.getElementById('pastWeeksList');
  if(!wrap) return;
  wrap.innerHTML='';
  const weeks = weeksIndexCache.filter(w => w.iso !== viewingWeekStart);
  if(weeks.length===0){
    wrap.innerHTML = '<div class="empty-hint">Past weeks will show up here once one is behind you.</div>';
    return;
  }
  weeks.slice(0,10).forEach(({iso,pct})=>{
    const start = new Date(iso + 'T00:00:00');
    const end = new Date(start); end.setDate(end.getDate()+6);
    const row = document.createElement('div');
    row.className = 'unsched-item past-week-row';
    row.innerHTML = `
      <span class="pw-jump">${fmtDay(start)} – ${fmtDay(end)} <span class="tag">${pct}%</span></span>
      <button class="btn small ghost" data-act="merge" title="Copy everything from this week into the week you're currently viewing">→ here</button>
    `;
    row.querySelector('.pw-jump').onclick = ()=> goToWeek(iso);
    row.querySelector('[data-act="merge"]').onclick = (e)=>{
      e.stopPropagation();
      mergeWeekInto(iso, viewingWeekStart);
    };
    wrap.appendChild(row);
  });
}

// Copies goals/tasks/sessions/shifts from one week into another (e.g. moving
// misfiled data into the correct week) and removes the empty source week.
// Used from the Past weeks panel's "→ here" button.
async function mergeWeekInto(fromIso, toIso){
  if(fromIso === toIso) return;
  const label = `${fmtDay(new Date(fromIso+'T00:00:00'))} into ${toIso===currentMondayIso() ? 'this week' : fmtDay(new Date(toIso+'T00:00:00'))}`;
  if(!confirm(`Move everything from ${label}? The old week will be cleared once merged.`)) return;
  const fromWk = db.weeks[fromIso] || await fetchWeek(fromIso);
  const toWk = db.weeks[toIso] || (db.weeks[toIso] = await fetchWeek(toIso));
  toWk.goals = toWk.goals.concat(fromWk.goals);
  toWk.tasks = toWk.tasks.concat(fromWk.tasks);
  toWk.blocks = toWk.blocks.concat(fromWk.blocks);
  toWk.shifts = toWk.shifts.concat(fromWk.shifts);
  try{ await apiFetch(`/.netlify/functions/week?iso=${fromIso}`, { method:'DELETE' }); }
  catch(e){ console.error('Harbour: could not clear the old week after merging.', e); }
  delete db.weeks[fromIso];
  if(viewingWeekStart === toIso){ scheduleSave(toIso); renderAll(); }
  else { await goToWeek(toIso); }
}

// ---------- Reflect view ----------
function renderReflect(){
  const wentWell = document.getElementById('reflectWentWell');
  const notWell = document.getElementById('reflectNotWell');
  const improve = document.getElementById('reflectImprove');
  if(!wentWell) return;
  if(document.activeElement !== wentWell) wentWell.value = state.reflection.wentWell || '';
  if(document.activeElement !== notWell) notWell.value = state.reflection.notWell || '';
  if(document.activeElement !== improve) improve.value = state.reflection.improve || '';
  document.getElementById('reflectWeekLabel').textContent =
    (isViewingCurrentWeek() ? 'This week' : `${fmtDay(weekDates()[0])} – ${fmtDay(weekDates()[6])}`);
}

// ---------- Calendar ----------
function renderCalendar(){
  const grid = document.getElementById('calendarGrid');
  grid.innerHTML='';
  const dates = weekDates();
  const todIdx = isTodayWithinWeek() ? todayIndex() : -1;

  // mobile day-jump bar
  const jumpBar = document.getElementById('dayJumpBar');
  jumpBar.innerHTML='';
  dates.forEach((d,i)=>{
    const btn = document.createElement('button');
    btn.className = i===todIdx ? 'is-today' : '';
    btn.textContent = DAY_NAMES[i] + ' ' + d.getDate();
    btn.onclick = ()=>{
      const col = grid.querySelectorAll('.cal-daybody')[i];
      if(col) col.scrollIntoView({ behavior:'smooth', inline:'start', block:'nearest' });
    };
    jumpBar.appendChild(btn);
  });

  // header row
  const headerRow = document.createElement('div');
  headerRow.className='cal-header-row';
  headerRow.appendChild(makeDiv('cal-header-spacer'));
  dates.forEach((d,i)=>{
    const h = document.createElement('div');
    h.className = 'cal-header-day' + (i===todIdx ? ' is-today':'');
    h.innerHTML = `<div class="dname">${DAY_NAMES[i]}</div><div class="ddate">${fmtDay(d)}</div>`;
    headerRow.appendChild(h);
  });
  grid.appendChild(headerRow);

  // anytime row
  const anyRow = document.createElement('div');
  anyRow.className='cal-anytime-row';
  anyRow.appendChild(makeDiv('cal-anytime-spacer'));
  for(let day=0; day<7; day++){
    const cell = document.createElement('div');
    cell.className='cal-anytime-day';
    const items = [
      ...state.tasks.filter(t=>t.assignedDay===day && t.status!=='done' && blocksFor('task',t.id).length===0).map(t=>({itemKind:'task', obj:t})),
      ...state.goals.filter(g=>g.assignedDay===day && blocksFor('goal',g.id).length===0).map(g=>({itemKind:'goal', obj:g}))
    ];
    if(items.length===0){
      cell.innerHTML = '<div class="anytime-empty">Anytime</div>';
    }
    items.forEach(({itemKind,obj})=>{
      const el = document.createElement('div');
      el.className='anytime-task' + (itemKind==='task' && obj.status==='done' ? ' done':'');
      el.draggable = true;
      if(itemKind==='task'){
        el.innerHTML = `<input type="checkbox" ${obj.status==='done'?'checked':''}><span>${escapeHtml(obj.title)}</span>`;
        el.querySelector('input').onchange = (e)=>{ obj.status = e.target.checked?'done':'open'; renderAll(); };
      } else {
        el.innerHTML = `<span>${escapeHtml(obj.title)}</span>`;
      }
      el.addEventListener('dragstart', e=>{
        e.dataTransfer.setData('text/plain', JSON.stringify({kind:'anytime', itemKind, id:obj.id}));
      });
      cell.appendChild(el);
    });
    cell.ondragover = e=>{ e.preventDefault(); cell.classList.add('dragover'); };
    cell.ondragleave = ()=> cell.classList.remove('dragover');
    cell.ondrop = e=>{
      e.preventDefault(); cell.classList.remove('dragover');
      const payload = safeParse(e.dataTransfer.getData('text/plain'));
      if(!payload) return;
      if(payload.kind==='task'){ const t=taskById(payload.id); if(t) t.assignedDay=day; }
      if(payload.kind==='goal'){ const g=goalById(payload.id); if(g) g.assignedDay=day; }
      if(payload.kind==='anytime'){
        if(payload.itemKind==='task'){ const t=taskById(payload.id); if(t) t.assignedDay=day; }
        else { const g=goalById(payload.id); if(g) g.assignedDay=day; }
      }
      if(payload.kind==='block'){
        const b = state.blocks.find(x=>x.id===payload.blockId);
        if(b){
          if(b.kind==='task'){ const t=taskById(b.refId); if(t) t.assignedDay=day; }
          else { const g=goalById(b.refId); if(g) g.assignedDay=day; }
          state.blocks = state.blocks.filter(x=>x.id!==b.id);
        }
      }
      renderAll();
    };
    anyRow.appendChild(cell);
  }
  grid.appendChild(anyRow);

  // body row
  const bodyRow = document.createElement('div');
  bodyRow.className='cal-body-row';

  const hourLabels = document.createElement('div');
  hourLabels.className='cal-hourlabels';
  for(let h=START_HOUR; h<END_HOUR; h++){
    const lbl = document.createElement('div');
    lbl.className='cal-hourlabel';
    lbl.textContent = pad2(h)+':00';
    hourLabels.appendChild(lbl);
  }
  bodyRow.appendChild(hourLabels);

  for(let day=0; day<7; day++){
    const dayBody = document.createElement('div');
    dayBody.className='cal-daybody';
    dayBody.style.height = ((END_HOUR-START_HOUR)*ROW_PX)+'px';

    for(let h=START_HOUR; h<END_HOUR; h++){
      const cell = document.createElement('div');
      const onShift = state.shifts.some(s=> s.day===day && timeToMinutes(s.start) <= h*60 && h*60 < timeToMinutes(s.end));
      cell.className = 'cal-hourcell' + (onShift ? ' shift':'');
      cell.dataset.day = day; cell.dataset.hour = h;
      cell.ondragover = e=>{ e.preventDefault(); cell.classList.add('dragover'); };
      cell.ondragleave = ()=> cell.classList.remove('dragover');
      cell.ondrop = e=>{
        e.preventDefault(); cell.classList.remove('dragover');
        handleCalendarDrop(e, day, h);
      };
      dayBody.appendChild(cell);
    }

    // blocks layer (shift blocks + item blocks)
    const layer = document.createElement('div');
    layer.className='cal-blockslayer';

    state.shifts.filter(s=>s.day===day).forEach(s=>{
      const el = makeBlockEl({
        start:s.start, end:s.end,
        title:s.label || 'Work', sub:s.start+'–'+s.end,
        extraClass:'shift-block', clickable:true
      });
      el.addEventListener('click', ()=> openShiftEditModal(s.id));
      layer.appendChild(el);
    });

    state.blocks.filter(b=>b.day===day).forEach(b=>{
      const item = b.kind==='goal' ? goalById(b.refId) : taskById(b.refId);
      if(!item) return;
      const el = makeBlockEl({
        start:b.start, end:b.end,
        title:item.title, sub:b.start+'–'+b.end,
        extraClass: b.completed ? 'completed' : '',
        clickable:true
      });
      el.draggable = true;
      el.addEventListener('dragstart', e=>{
        e.dataTransfer.setData('text/plain', JSON.stringify({kind:'block', blockId:b.id}));
      });
      el.addEventListener('click', ()=> openBlockModal(b.id));
      layer.appendChild(el);
    });

    dayBody.appendChild(layer);
    bodyRow.appendChild(dayBody);
  }

  grid.appendChild(bodyRow);
}

function makeBlockEl({start,end,title,sub,extraClass,clickable}){
  const el = document.createElement('div');
  el.className = 'cal-block ' + (extraClass||'');
  const top = ((timeToMinutes(start) - START_HOUR*60)/60) * ROW_PX;
  const height = Math.max(((timeToMinutes(end)-timeToMinutes(start))/60) * ROW_PX, 20);
  el.style.top = top+'px';
  el.style.height = height+'px';
  el.innerHTML = `<span class="btitle">${escapeHtml(title)}</span><span class="btime">${sub}</span>`;
  if(!clickable) el.style.cursor='default';
  return el;
}
function makeDiv(cls){ const d=document.createElement('div'); d.className=cls; return d; }

function handleCalendarDrop(e, day, hour){
  const payload = safeParse(e.dataTransfer.getData('text/plain'));
  if(!payload) return;
  const defaultStart = pad2(hour)+':00';
  const defaultEnd = pad2(Math.min(hour+1, END_HOUR))+':00';

  if(payload.kind==='goal'){
    state.blocks.push({id:uid(), kind:'goal', refId:payload.id, day, start:defaultStart, end:defaultEnd, completed:false});
  } else if(payload.kind==='task'){
    state.blocks.push({id:uid(), kind:'task', refId:payload.id, day, start:defaultStart, end:defaultEnd, completed:false});
  } else if(payload.kind==='anytime'){
    state.blocks.push({id:uid(), kind:payload.itemKind, refId:payload.id, day, start:defaultStart, end:defaultEnd, completed:false});
  } else if(payload.kind==='block'){
    const b = state.blocks.find(x=>x.id===payload.blockId);
    if(b){
      const dur = timeToMinutes(b.end)-timeToMinutes(b.start);
      b.day = day;
      b.start = defaultStart;
      b.end = minutesToTime(clamp(timeToMinutes(defaultStart)+dur, 0, END_HOUR*60));
    }
  }
  renderAll();
}

// ---------- Today view ----------
function renderToday(){
  const idx = isTodayWithinWeek() ? todayIndex() : 0;
  const scheduled = document.getElementById('todayScheduled');
  const doToday = document.getElementById('todayDoToday');
  const available = document.getElementById('todayAvailable');
  scheduled.innerHTML=''; doToday.innerHTML=''; available.innerHTML='';

  const blocksToday = state.blocks.filter(b=>b.day===idx).sort((a,b)=>timeToMinutes(a.start)-timeToMinutes(b.start));
  if(blocksToday.length===0) scheduled.innerHTML = '<div class="empty-hint">Nothing timed today.</div>';
  blocksToday.forEach(b=>{
    const item = b.kind==='goal' ? goalById(b.refId) : taskById(b.refId);
    if(!item) return;
    const el = document.createElement('div');
    el.className='today-item' + (b.completed?' done':'');
    el.innerHTML = `<input type="checkbox" ${b.completed?'checked':''}><span class="time">${b.start}</span><span>${escapeHtml(item.title)}</span>`;
    el.querySelector('input').onchange = (e)=>{ b.completed = e.target.checked; renderAll(); };
    scheduled.appendChild(el);
  });

  const dayTasks = state.tasks.filter(t=>t.assignedDay===idx && t.status!=='done' && blocksFor('task',t.id).length===0);
  const dayGoals = state.goals.filter(g=>g.assignedDay===idx && blocksFor('goal',g.id).length===0);
  if(dayTasks.length===0 && dayGoals.length===0) doToday.innerHTML = '<div class="empty-hint">Nothing assigned to today.</div>';
  dayTasks.forEach(t=>{
    const el = document.createElement('div');
    el.className='today-item';
    el.innerHTML = `<input type="checkbox"><span>${escapeHtml(t.title)}</span>`;
    el.querySelector('input').onchange = (e)=>{ t.status = e.target.checked?'done':'open'; renderAll(); };
    doToday.appendChild(el);
  });
  dayGoals.forEach(g=>{
    const el = document.createElement('div');
    el.className='today-item';
    el.innerHTML = `<span>${escapeHtml(g.title)}</span>`;
    doToday.appendChild(el);
  });

  const flexTasks = state.tasks.filter(t=>t.status!=='done' && !t.assignedDay && blocksFor('task',t.id).length===0);
  if(flexTasks.length===0) available.innerHTML = '<div class="empty-hint">Nothing flexible waiting.</div>';
  flexTasks.forEach(t=>{
    const el = document.createElement('div');
    el.className='today-item';
    el.innerHTML = `<span>${escapeHtml(t.title)}</span>`;
    available.appendChild(el);
  });
}

// ---------- misc ----------
function escapeHtml(s){
  const d = document.createElement('div'); d.textContent = s==null?'':s; return d.innerHTML;
}

// ============================================================
// MODALS
// ============================================================
function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('[data-close]').forEach(btn=>{
  btn.addEventListener('click', e=>{
    e.target.closest('.modal-backdrop').classList.remove('open');
  });
});
document.querySelectorAll('.modal-backdrop').forEach(bd=>{
  if(bd.id==='tokenGateModal') return; // must be unlocked with a code, no click-away dismiss
  bd.addEventListener('click', e=>{ if(e.target===bd) bd.classList.remove('open'); });
});

// -- add dropdown --
const addBtn = document.getElementById('addBtn');
const addDropdown = document.getElementById('addDropdown');
addBtn.addEventListener('click', e=>{ e.stopPropagation(); addDropdown.classList.toggle('open'); });
document.addEventListener('click', ()=> addDropdown.classList.remove('open'));
addDropdown.querySelectorAll('button').forEach(b=>{
  b.addEventListener('click', ()=>{
    addDropdown.classList.remove('open');
    if(b.dataset.open==='taskModal') populateTaskGoalSelect();
    if(b.dataset.open==='shiftModal') populateShiftDaySelect();
    openModal(b.dataset.open);
  });
});

// -- tabs --
document.querySelectorAll('.tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    tab.classList.add('active');
    const view = tab.dataset.view;
    document.getElementById('weekView').style.display = view==='week' ? 'flex':'none';
    document.getElementById('todayView').style.display = view==='today' ? 'flex':'none';
    document.getElementById('reflectView').style.display = view==='reflect' ? 'flex':'none';
    if(view==='today') renderToday();
    if(view==='reflect') renderReflect();
  });
});

// -- week navigation --
document.getElementById('prevWeekBtn').addEventListener('click', ()=> shiftWeek(-1));
document.getElementById('nextWeekBtn').addEventListener('click', ()=> shiftWeek(1));
document.getElementById('todayJumpBtn').addEventListener('click', ()=> goToWeek(currentMondayIso()));

// -- reflect inputs --
['reflectWentWell','reflectNotWell','reflectImprove'].forEach(id=>{
  document.getElementById(id).addEventListener('input', e=>{
    const key = id==='reflectWentWell' ? 'wentWell' : id==='reflectNotWell' ? 'notWell' : 'improve';
    state.reflection[key] = e.target.value;
    scheduleSave(viewingWeekStart);
  });
});

// -- mobile calendar resize --
let resizeTimer = null;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(renderCalendar, 150);
});

// -- goal modal --
document.getElementById('goalType').addEventListener('change', updateGoalTargetVisibility);
function updateGoalTargetVisibility(){
  const type = document.getElementById('goalType').value;
  const row = document.getElementById('goalTargetRow');
  row.style.display = ['time','quantity','repetitions'].includes(type) ? 'flex' : 'none';
}
updateGoalTargetVisibility();

document.getElementById('saveGoal').addEventListener('click', ()=>{
  const title = document.getElementById('goalTitle').value.trim();
  if(!title){ alert('Give the goal a title first.'); return; }
  const type = document.getElementById('goalType').value;
  const g = {
    id: uid(), title, type,
    targetValue: +document.getElementById('goalTargetValue').value || 0,
    targetUnit: document.getElementById('goalTargetUnit').value.trim(),
    currentValue: 0,
    status: 'not_started',
    deadline: document.getElementById('goalDeadline').value || null,
    assignedDay: null
  };
  state.goals.push(g);
  ['goalTitle','goalTargetValue','goalTargetUnit','goalDeadline'].forEach(id=>document.getElementById(id).value='');
  document.getElementById('goalType').value='completion';
  updateGoalTargetVisibility();
  closeModal('goalModal');
  renderAll();
});

// -- task modal --
function populateTaskGoalSelect(){
  const sel = document.getElementById('taskGoal');
  sel.innerHTML = '<option value="">— none —</option>';
  state.goals.forEach(g=>{
    const opt = document.createElement('option');
    opt.value = g.id; opt.textContent = g.title;
    sel.appendChild(opt);
  });
}
document.getElementById('saveTask').addEventListener('click', ()=>{
  const title = document.getElementById('taskTitle').value.trim();
  if(!title){ alert('Give the task a title first.'); return; }
  const t = {
    id: uid(), title,
    goalId: document.getElementById('taskGoal').value || null,
    assignedDay: null,
    deadline: document.getElementById('taskDeadline').value || null,
    status: 'open'
  };
  state.tasks.push(t);
  ['taskTitle','taskDeadline'].forEach(id=>document.getElementById(id).value='');
  closeModal('taskModal');
  renderAll();
});

// -- shift modal --
function populateShiftDaySelect(){
  const sel = document.getElementById('shiftDay');
  sel.innerHTML = DAY_NAMES.map((d,i)=>`<option value="${i}">${d}</option>`).join('');
}
document.getElementById('saveShift').addEventListener('click', ()=>{
  const day = +document.getElementById('shiftDay').value;
  const start = document.getElementById('shiftStart').value;
  const end = document.getElementById('shiftEnd').value;
  if(timeToMinutes(end) <= timeToMinutes(start)){ alert('End time must be after start time.'); return; }
  state.shifts.push({ id: uid(), day, start, end, label: document.getElementById('shiftLabel').value.trim() });
  closeModal('shiftModal');
  renderAll();
});

// -- block modal --
let activeBlockId = null;
function openBlockModal(blockId){
  const b = state.blocks.find(x=>x.id===blockId);
  if(!b) return;
  activeBlockId = blockId;
  const item = b.kind==='goal' ? goalById(b.refId) : taskById(b.refId);
  document.getElementById('blockModalTitle').textContent = item ? item.title : 'Session';
  document.getElementById('blockStart').value = b.start;
  document.getElementById('blockEnd').value = b.end;
  document.getElementById('blockCompleted').checked = !!b.completed;
  openModal('blockModal');
}
document.getElementById('saveBlock').addEventListener('click', ()=>{
  const b = state.blocks.find(x=>x.id===activeBlockId);
  if(!b) return;
  const start = document.getElementById('blockStart').value;
  const end = document.getElementById('blockEnd').value;
  if(timeToMinutes(end) <= timeToMinutes(start)){ alert('End time must be after start time.'); return; }
  b.start = start; b.end = end;
  b.completed = document.getElementById('blockCompleted').checked;
  closeModal('blockModal');
  renderAll();
});
document.getElementById('deleteBlock').addEventListener('click', ()=>{
  state.blocks = state.blocks.filter(x=>x.id!==activeBlockId);
  closeModal('blockModal');
  renderAll();
});

// -- shift edit modal --
let activeShiftId = null;
function openShiftEditModal(shiftId){
  const s = state.shifts.find(x=>x.id===shiftId);
  if(!s) return;
  activeShiftId = shiftId;
  const daySel = document.getElementById('shiftEditDay');
  daySel.innerHTML = DAY_NAMES.map((d,i)=>`<option value="${i}" ${s.day===i?'selected':''}>${d}</option>`).join('');
  document.getElementById('shiftEditStart').value = s.start;
  document.getElementById('shiftEditEnd').value = s.end;
  document.getElementById('shiftEditLabel').value = s.label || '';
  openModal('shiftEditModal');
}
document.getElementById('saveShiftEdit').addEventListener('click', ()=>{
  const s = state.shifts.find(x=>x.id===activeShiftId);
  if(!s) return;
  const start = document.getElementById('shiftEditStart').value;
  const end = document.getElementById('shiftEditEnd').value;
  if(timeToMinutes(end) <= timeToMinutes(start)){ alert('End time must be after start time.'); return; }
  s.day = +document.getElementById('shiftEditDay').value;
  s.start = start; s.end = end;
  s.label = document.getElementById('shiftEditLabel').value.trim();
  closeModal('shiftEditModal');
  renderAll();
});
document.getElementById('deleteShift').addEventListener('click', ()=>{
  state.shifts = state.shifts.filter(x=>x.id!==activeShiftId);
  closeModal('shiftEditModal');
  renderAll();
});

// ============================================================
// PLAN MY WEEK WIZARD
// ============================================================
let wizard = null;

document.getElementById('planWeekBtn').addEventListener('click', ()=>{
  wizard = { step:0, shifts:[], goals:[] }; // goals: [{title,type,targetValue,targetUnit,schedule:'flex'|'day', day:0}]
  renderWizard();
  openModal('planModal');
});

const WIZARD_STEPS = ['Work shifts','What do you want to achieve?','How is each one measured?','When will you work on them?'];

function renderWizard(){
  document.getElementById('wizardTitle').textContent = 'Plan my week — ' + WIZARD_STEPS[wizard.step];
  const stepsEl = document.getElementById('wizardSteps');
  stepsEl.innerHTML = WIZARD_STEPS.map((_,i)=>
    `<div class="dot ${i===wizard.step?'active':(i<wizard.step?'done':'')}"></div>`).join('');

  const body = document.getElementById('wizardBody');
  body.innerHTML='';
  if(wizard.step===0) renderWizardShifts(body);
  if(wizard.step===1) renderWizardGoalsIntake(body);
  if(wizard.step===2) renderWizardGoalTypes(body);
  if(wizard.step===3) renderWizardScheduling(body);

  document.getElementById('wizardBack').style.visibility = wizard.step===0 ? 'hidden' : 'visible';
  document.getElementById('wizardNext').textContent = wizard.step===3 ? 'Finish' : 'Next';
}

function renderWizardShifts(body){
  const p = document.createElement('p');
  p.className='empty-hint';
  p.style.fontSize='12.5px';
  p.textContent = 'Add your work shifts so goals get planned around them. You can add more from the calendar later.';
  body.appendChild(p);

  const list = document.createElement('div');
  list.className='wizard-list';
  wizard.shifts.forEach((s,i)=>{
    const row = document.createElement('div');
    row.className='wizard-item-row';
    row.innerHTML = `<div class="wi-title">${DAY_NAMES[s.day]} · ${s.start}–${s.end}${s.label? ' · '+escapeHtml(s.label):''}</div>`;
    const rm = document.createElement('button');
    rm.className='btn small ghost'; rm.textContent='Remove';
    rm.onclick = ()=>{ wizard.shifts.splice(i,1); renderWizard(); };
    row.appendChild(rm);
    list.appendChild(row);
  });
  body.appendChild(list);

  const form = document.createElement('div');
  form.className='wizard-item-row';
  form.innerHTML = `
    <div class="row">
      <select id="wzDay">${DAY_NAMES.map((d,i)=>`<option value="${i}">${d}</option>`).join('')}</select>
      <input type="time" id="wzStart" value="09:00">
      <input type="time" id="wzEnd" value="17:00">
    </div>
    <div class="wizard-inline-add">
      <input type="text" id="wzLabel" placeholder="Label (optional)">
      <button class="btn primary small" id="wzAddShift">Add</button>
    </div>
  `;
  body.appendChild(form);
  form.querySelector('#wzAddShift').onclick = ()=>{
    const day = +form.querySelector('#wzDay').value;
    const start = form.querySelector('#wzStart').value;
    const end = form.querySelector('#wzEnd').value;
    if(timeToMinutes(end)<=timeToMinutes(start)){ alert('End must be after start.'); return; }
    wizard.shifts.push({day,start,end,label:form.querySelector('#wzLabel').value.trim()});
    renderWizard();
  };
}

function renderWizardGoalsIntake(body){
  const p = document.createElement('p');
  p.className='empty-hint'; p.style.fontSize='12.5px';
  p.textContent = 'What do you want to achieve this week? Add as many as you like.';
  body.appendChild(p);

  const list = document.createElement('div');
  list.className='wizard-list';
  wizard.goals.forEach((g,i)=>{
    const row = document.createElement('div');
    row.className='wizard-item-row';
    row.innerHTML = `<div class="wi-title">${escapeHtml(g.title)}</div>`;
    const rm = document.createElement('button');
    rm.className='btn small ghost'; rm.textContent='Remove';
    rm.onclick = ()=>{ wizard.goals.splice(i,1); renderWizard(); };
    row.appendChild(rm);
    list.appendChild(row);
  });
  body.appendChild(list);

  const addRow = document.createElement('div');
  addRow.className='wizard-inline-add';
  addRow.innerHTML = `<input type="text" id="wzGoalTitle" placeholder="e.g. Contact 20 potential clients"><button class="btn primary small" id="wzAddGoal">Add</button>`;
  body.appendChild(addRow);
  const commit = ()=>{
    const input = addRow.querySelector('#wzGoalTitle');
    const title = input.value.trim();
    if(!title) return;
    wizard.goals.push({ title, type: suggestType(title), targetValue:'', targetUnit:'', schedule:'flex', day:0 });
    input.value='';
    renderWizard();
  };
  addRow.querySelector('#wzAddGoal').onclick = commit;
  addRow.querySelector('#wzGoalTitle').addEventListener('keydown', e=>{ if(e.key==='Enter') commit(); });
}

function suggestType(title){
  const t = title.toLowerCase();
  if(/\bhours?\b/.test(t)) return 'time';
  if(/\b(\d+)\s*(times?|sessions?)\b/.test(t) || /\bgym\b|\bworkout/.test(t)) return 'repetitions';
  if(/\b\d+\b/.test(t) && /(contact|call|email|send|apply|application|lead|business|businesses|client|clients)/.test(t)) return 'quantity';
  if(/^finish|^complete|^launch/.test(t)) return 'completion';
  return 'simple';
}

function renderWizardGoalTypes(body){
  if(wizard.goals.length===0){
    body.innerHTML = '<div class="empty-hint">No goals added yet — go back and add some.</div>';
    return;
  }
  const list = document.createElement('div');
  list.className='wizard-list';
  wizard.goals.forEach((g)=>{
    const row = document.createElement('div');
    row.className='wizard-item-row';
    const needsTarget = ['time','quantity','repetitions'].includes(g.type);
    row.innerHTML = `
      <div class="wi-title">${escapeHtml(g.title)}</div>
      <div class="choice-group" data-role="types">
        ${['completion','time','quantity','repetitions','checklist','simple'].map(ty=>
          `<button class="choice-btn ${g.type===ty?'selected':''}" data-type="${ty}">${typeLabel(ty)}</button>`).join('')}
      </div>
      <div class="row" data-role="targetRow" style="display:${needsTarget?'flex':'none'}">
        <input type="number" min="0" step="0.5" placeholder="target" class="grow" data-role="target" value="${g.targetValue}">
        <input type="text" placeholder="unit" class="grow" data-role="unit" value="${g.targetUnit}">
      </div>
    `;
    row.querySelectorAll('[data-type]').forEach(btn=>{
      btn.onclick = ()=>{
        g.type = btn.dataset.type;
        renderWizard();
      };
    });
    const targetInput = row.querySelector('[data-role="target"]');
    const unitInput = row.querySelector('[data-role="unit"]');
    if(targetInput) targetInput.oninput = ()=>{ g.targetValue = targetInput.value; };
    if(unitInput) unitInput.oninput = ()=>{ g.targetUnit = unitInput.value; };
    list.appendChild(row);
  });
  body.appendChild(list);
}

function renderWizardScheduling(body){
  if(wizard.goals.length===0){
    body.innerHTML = '<div class="empty-hint">No goals to schedule.</div>';
    return;
  }
  const list = document.createElement('div');
  list.className='wizard-list';
  wizard.goals.forEach(g=>{
    const row = document.createElement('div');
    row.className='wizard-item-row';
    row.innerHTML = `
      <div class="wi-title">${escapeHtml(g.title)}</div>
      <div class="choice-group">
        <button class="choice-btn ${g.schedule==='day'?'selected':''}" data-sch="day">Choose a day</button>
        <button class="choice-btn ${g.schedule==='flex'?'selected':''}" data-sch="flex">Leave flexible</button>
      </div>
      <select data-role="day" style="display:${g.schedule==='day'?'block':'none'}">
        ${DAY_NAMES.map((d,i)=>`<option value="${i}" ${g.day===i?'selected':''}>${d}</option>`).join('')}
      </select>
      <div class="empty-hint">You can always drag it onto an exact hour on the calendar afterwards.</div>
    `;
    row.querySelectorAll('[data-sch]').forEach(btn=>{
      btn.onclick = ()=>{ g.schedule = btn.dataset.sch; renderWizard(); };
    });
    const daySel = row.querySelector('[data-role="day"]');
    if(daySel) daySel.onchange = ()=>{ g.day = +daySel.value; };
    list.appendChild(row);
  });
  body.appendChild(list);
}

document.getElementById('wizardBack').addEventListener('click', ()=>{
  if(wizard.step>0){ wizard.step--; renderWizard(); }
});
document.getElementById('wizardNext').addEventListener('click', ()=>{
  if(wizard.step<3){ wizard.step++; renderWizard(); return; }
  // finish: commit to state
  wizard.shifts.forEach(s=> state.shifts.push({id:uid(), ...s}));
  wizard.goals.forEach(g=>{
    state.goals.push({
      id: uid(), title:g.title, type:g.type,
      targetValue: +g.targetValue || 0,
      targetUnit: g.targetUnit || '',
      currentValue: 0, status:'not_started',
      deadline: null,
      assignedDay: g.schedule==='day' ? g.day : null
    });
  });
  closeModal('planModal');
  renderAll();
});

// ============================================================
// TOKEN GATE + ONLINE STATUS
// ============================================================
function showTokenGate(message){
  const el = document.getElementById('tokenGateMessage');
  if(el) el.textContent = message || "Enter the access code you set when you deployed Harbour.";
  openModal('tokenGateModal');
}
document.getElementById('saveToken').addEventListener('click', ()=>{
  const val = document.getElementById('tokenInput').value.trim();
  if(!val) return;
  token = val;
  localStorage.setItem(TOKEN_KEY, token);
  document.getElementById('tokenInput').value='';
  closeModal('tokenGateModal');
  boot();
});
document.getElementById('tokenInput').addEventListener('keydown', e=>{
  if(e.key==='Enter') document.getElementById('saveToken').click();
});

function updateOnlineBadge(){
  const badge = document.getElementById('syncBadge');
  if(!badge) return;
  if(isOnline){
    badge.textContent = lastSyncNote ? `Synced (${lastSyncNote})` : 'Synced';
    badge.className = 'sync-badge';
  } else {
    badge.textContent = `Offline: ${lastSyncError || 'unknown error'}`;
    badge.className = 'sync-badge offline';
  }
}

// ============================================================
// INIT
// ============================================================
async function boot(){
  if(!token){ showTokenGate(); return; }
  document.getElementById('loadingOverlay').style.display = 'flex';
  await goToWeek(viewingWeekStart);
  document.getElementById('loadingOverlay').style.display = 'none';
  updateOnlineBadge();

  if(hasLegacyLocalData()){
    console.warn('Harbour: found data from an earlier local-only version in this browser. It was not automatically copied to the cloud — check the README if you need to bring it across by hand.');
  }
}
boot();
