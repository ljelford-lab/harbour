const { isAuthorized, json } = require('./lib/_auth');
const { getWeek, saveWeek, deleteWeek } = require('./lib/_store');

exports.handler = async (event) => {
  if(!process.env.HARBOUR_SECRET){
    return json(500, { error: 'Server is missing the HARBOUR_SECRET environment variable.' });
  }
  if(!isAuthorized(event)) return json(401, { error: 'Unauthorized' });

  const iso = event.queryStringParameters && event.queryStringParameters.iso;
  if(!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)){
    return json(400, { error: 'Missing or invalid iso query param (expected YYYY-MM-DD).' });
  }

  if(event.httpMethod === 'GET'){
    const data = await getWeek(iso);
    return json(200, { data });
  }

  if(event.httpMethod === 'PUT'){
    let body;
    try{ body = JSON.parse(event.body || '{}'); }
    catch(e){ return json(400, { error: 'Body was not valid JSON.' }); }
    if(!body || typeof body !== 'object'){
      return json(400, { error: 'Missing week data in request body.' });
    }
    await saveWeek(iso, body);
    return json(200, { ok: true });
  }

  if(event.httpMethod === 'DELETE'){
    await deleteWeek(iso);
    return json(200, { ok: true });
  }

  return json(405, { error: 'Method not allowed' });
};
