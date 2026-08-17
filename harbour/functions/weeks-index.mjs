// Self-contained (see week.mjs for why — no imports from other project files).
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

async function getWeeksIndex(){
  const summary = (await store().get('weeks-summary', { type: 'json' })) || {};
  return Object.entries(summary).map(([iso, v])=>({ iso, pct: v.pct || 0 }));
}

export default async (req) => {
  if(!process.env.HARBOUR_SECRET){
    return json(500, { error: 'Server is missing the HARBOUR_SECRET environment variable.' });
  }
  if(!isAuthorized(req)) return json(401, { error: 'Unauthorized' });
  if(req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const weeks = await getWeeksIndex();
  return json(200, { weeks });
};
