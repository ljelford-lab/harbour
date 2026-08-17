import { isAuthorized, json } from './lib/_auth.mjs';
import { getWeeksIndex } from './lib/_store.mjs';

export default async (req) => {
  if(!process.env.HARBOUR_SECRET){
    return json(500, { error: 'Server is missing the HARBOUR_SECRET environment variable.' });
  }
  if(!isAuthorized(req)) return json(401, { error: 'Unauthorized' });
  if(req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const weeks = await getWeeksIndex();
  return json(200, { weeks });
};
