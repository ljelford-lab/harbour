const { isAuthorized, json } = require('./lib/_auth');
const { getWeeksIndex } = require('./lib/_store');

exports.handler = async (event) => {
  if(!process.env.HARBOUR_SECRET){
    return json(500, { error: 'Server is missing the HARBOUR_SECRET environment variable.' });
  }
  if(!isAuthorized(event)) return json(401, { error: 'Unauthorized' });
  if(event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const weeks = await getWeeksIndex();
  return json(200, { weeks });
};
