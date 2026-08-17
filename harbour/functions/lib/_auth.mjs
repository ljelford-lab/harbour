// Single-user auth: every request must carry the same secret you set as
// the HARBOUR_SECRET environment variable in Netlify. There's no login
// system or per-person accounts — just a shared passphrase between the app
// (stored in the browser once you unlock it) and these functions. That's
// enough for a tool only you use; it is NOT enough if you ever want more
// than one person's data kept genuinely private from each other.
export function isAuthorized(req){
  if(!process.env.HARBOUR_SECRET) return false;
  const token = req.headers.get('x-harbour-token');
  return !!token && token === process.env.HARBOUR_SECRET;
}

export function json(statusCode, obj){
  return new Response(JSON.stringify(obj), {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' }
  });
}
