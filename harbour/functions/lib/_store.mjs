// All persistent data lives in Netlify Blobs — a zero-configuration
// key/value store built into Netlify, no separate database to provision.
// Each week is one JSON blob under `week:<monday-iso-date>`, matching the
// shape the front end already uses — goals/tasks/blocks/shifts/reflection.
// A second blob, `weeks-summary`, holds a small {iso: {pct, updatedAt}}
// map so the Past weeks panel can list history without fetching every
// single week individually.
import { getStore } from '@netlify/blobs';

function store(){ return getStore('harbour'); }

export async function getWeek(iso){
  return (await store().get(`week:${iso}`, { type: 'json' })) || null;
}

export async function saveWeek(iso, data){
  const s = store();
  await s.setJSON(`week:${iso}`, data);
  const summary = (await s.get('weeks-summary', { type: 'json' })) || {};
  summary[iso] = { pct: computeWeekPct(data), updatedAt: Date.now() };
  await s.setJSON('weeks-summary', summary);
}

export async function deleteWeek(iso){
  const s = store();
  await s.delete(`week:${iso}`);
  const summary = (await s.get('weeks-summary', { type: 'json' })) || {};
  delete summary[iso];
  await s.setJSON('weeks-summary', summary);
}

export async function getWeeksIndex(){
  const summary = (await store().get('weeks-summary', { type: 'json' })) || {};
  return Object.entries(summary).map(([iso, v])=>({ iso, pct: v.pct || 0 }));
}

// mirrors goalProgressFraction() in app.js so the summary and the in-app
// tideline agree on what "% complete" means
function goalProgressFraction(g, wk){
  if(g.type==='completion' || g.type==='simple'){
    if(g.status==='complete') return 1;
    if(g.status==='in_progress') return 0.5;
    return 0;
  }
  if(g.type==='checklist'){
    const linked = (wk.tasks||[]).filter(t=>t.goalId===g.id);
    if(linked.length===0) return 0;
    return linked.filter(t=>t.status==='done').length / linked.length;
  }
  if(!g.targetValue) return 0;
  return Math.max(0, Math.min(1, (g.currentValue||0) / g.targetValue));
}
function computeWeekPct(wk){
  const goals = wk.goals || [];
  if(goals.length===0) return 0;
  const total = goals.reduce((s,g)=>s+goalProgressFraction(g, wk), 0);
  return Math.round((total/goals.length)*100);
}
