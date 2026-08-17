import { isAuthorized, json } from './lib/_auth.mjs';
import { getWeek, saveWeek, deleteWeek } from './lib/_store.mjs';

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
