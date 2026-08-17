// Fully self-contained on purpose: earlier versions imported shared helpers
// from a lib/ subfolder, but Netlify's production function-packaging step
// silently failed to bundle anything when that pattern was used (worked
// fine in local dev, failed only in the real deploy, with no error shown).
// Rather than chase that further, each function file here duplicates its
// small amount of shared logic instead of importing it.
import { getStore } from '@netlify/blobs';

function isAuthorized(req){
  if(!process.env.HARBOUR_SECRET) return false;
  const token = req.headers.get('x-harbour-token');
  return !!token && token === process.env.HARBOUR_SECRET;
}
function json(statusCode, obj){
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
}

function store(){ return getStore('harbour'); }

async function getWeek(iso){
  return (await store().get(`week:${iso}`, { type: 'json' })) || null;
}
async function saveWeek(iso, data){
  const s = store();
  await s.setJSON(`week:${iso}`, data);
  const summary = (await s.get('weeks-summary', { type: 'json' })) || {};
  summary[iso] = { pct: computeWeekPct(data), updatedAt: Date.now() };
  await s.setJSON('weeks-summary', summary);
}
async function deleteWeek(iso){
  const s = store();
  await s.delete(`week:${iso}`);
  const summary = (await s.get('weeks-summary', { type: 'json' })) || {};
  delete summary[iso];
  await s.setJSON('weeks-summary', summary);
}
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

export default async (req) => {
  if(!process.env.HARBOUR_SECRET){
    return json(500, { error: 'Server is missing the HARBOUR_SECRET environment variable.' });
  }
  if(!isAuthorized(req)) return json(401, { error: 'Unauthorized' });

  const url = new URL(req.url);
  const iso = url.searchParams.get('iso');
  if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    return json(400, { error: 'Missing or invalid iso query param (expected YYYY-MM-DD).' });
  }

  if(req.method === 'GET'){
    const data = await getWeek(iso);
    return json(200, { data });
  }

  if(req.method === 'PUT'){
    let body;
    try{ body = await req.json(); }
    catch(e){ return json(400, { error: 'Body was not valid JSON.' }); }
    if(!body || typeof body !== 'object'){
      return json(400, { error: 'Missing week data in request body.' });
    }
    await saveWeek(iso, body);
    return json(200, { ok: true });
  }

  if(req.method === 'DELETE'){
    await deleteWeek(iso);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
};
