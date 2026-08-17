// Single-user auth: every request must carry the same secret you set as
// the HARBOUR_SECRET environment variable in Netlify. There's no login
// system or per-person accounts — just a shared passphrase between the app
// (stored in the browser once you unlock it) and these functions. That's
// enough for a tool only you use; it is NOT enough if you ever want more
// than one person's data kept genuinely private from each other.
function isAuthorized(event){
  if(!process.env.HARBOUR_SECRET) return false;
  const headers = event.headers || {};
  const token = headers['x-harbour-token'] || headers['X-Harbour-Token'];
  return !!token && token === process.env.HARBOUR_SECRET;
}
function json(statusCode, obj){
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
module.exports = { isAuthorized, json };
