// Self-contained (see week.mjs for why — no imports from other project files).
// Runs automatically on the schedule in `config` below. Scheduled functions
// can't be triggered by a public URL at all, so there's no separate secret
// needed to protect this one from outside callers.
import { getStore } from '@netlify/blobs';
import { Resend } from 'resend';

const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

function store(){ return getStore('harbour'); }
async function getWeek(iso){
  return (await store().get(`week:${iso}`, { type: 'json' })) || null;
}

// Scheduled functions run in UTC, but "today" and "which day of the week
// it is" should follow the UK, not the server. Compute both from
// Europe/London so this keeps working correctly across the BST/GMT change.
function londonDateParts(){
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year:'numeric', month:'2-digit', day:'2-digit', weekday:'short'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => map[p.type] = p.value);
  return { year:+map.year, month:+map.month, day:+map.day, weekday: map.weekday };
}
function mondayIsoFor(y, m, d){
  const date = new Date(Date.UTC(y, m-1, d));
  const dow = (date.getUTCDay() + 6) % 7; // 0 = Monday
  date.setUTCDate(date.getUTCDate() - dow);
  return date.toISOString().slice(0,10);
}
function escapeHtml(s){
  return String(s==null ? '' : s).replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

export default async () => {
  for(const key of ['RESEND_API_KEY','HARBOUR_EMAIL_TO','HARBOUR_EMAIL_FROM']){
    if(!process.env[key]){
      console.error(`Harbour cron: missing ${key} environment variable — skipping.`);
      return new Response('missing env var', { status: 200 });
    }
  }

  const { year, month, day, weekday } = londonDateParts();
  const weekStart = mondayIsoFor(year, month, day);
  const dayIdx = DAY_NAMES.indexOf(weekday);

  const wk = await getWeek(weekStart);
  if(!wk){
    console.log('Harbour cron: no data for this week yet, skipping.');
    return new Response('no data yet', { status: 200 });
  }

  function itemTitle(b){
    const list = b.kind === 'goal' ? wk.goals : wk.tasks;
    const item = (list || []).find(x => x.id === b.refId);
    return item ? item.title : '(deleted)';
  }

  const scheduled = (wk.blocks || [])
    .filter(b => b.day === dayIdx)
    .sort((a,b) => a.start.localeCompare(b.start));

  const doToday = (wk.tasks || []).filter(t =>
    t.assignedDay === dayIdx && t.status !== 'done' &&
    !(wk.blocks || []).some(b => b.kind === 'task' && b.refId === t.id)
  );

  const goalLines = (wk.goals || []).map(g => {
    let progress;
    if(g.type === 'completion' || g.type === 'simple'){
      progress = g.status === 'complete' ? 'Complete' : (g.status === 'in_progress' ? 'In progress' : 'Not started');
    } else if(g.type === 'checklist'){
      const linked = (wk.tasks || []).filter(t => t.goalId === g.id);
      progress = `${linked.filter(t=>t.status==='done').length}/${linked.length} tasks`;
    } else {
      progress = `${g.currentValue||0}/${g.targetValue||0} ${g.targetUnit||''}`.trim();
    }
    return `<li>${escapeHtml(g.title)} — ${progress}</li>`;
  }).join('');

  const scheduledHtml = scheduled.length
    ? scheduled.map(b => `<li>${b.start}–${b.end} — ${escapeHtml(itemTitle(b))}</li>`).join('')
    : '<li style="color:#888;">Nothing timed today.</li>';

  const doTodayHtml = doToday.length
    ? doToday.map(t => `<li>${escapeHtml(t.title)}</li>`).join('')
    : '<li style="color:#888;">Nothing assigned to today.</li>';

  const html = `
    <div style="font-family:-apple-system,Helvetica,Arial,sans-serif; max-width:480px; color:#111;">
      <h2 style="margin-bottom:4px;">Your plan for ${weekday}</h2>
      <h3 style="margin-bottom:4px;">Scheduled</h3>
      <ul style="margin-top:0;">${scheduledHtml}</ul>
      <h3 style="margin-bottom:4px;">Do today</h3>
      <ul style="margin-top:0;">${doTodayHtml}</ul>
      <h3 style="margin-bottom:4px;">Weekly goals</h3>
      <ul style="margin-top:0;">${goalLines || '<li style="color:#888;">No goals set this week.</li>'}</ul>
    </div>`;

  const resend = new Resend(process.env.RESEND_API_KEY);
  await resend.emails.send({
    from: process.env.HARBOUR_EMAIL_FROM,
    to: process.env.HARBOUR_EMAIL_TO,
    subject: `Your plan for ${weekday}`,
    html
  });

  return new Response('sent', { status: 200 });
};

export const config = { schedule: '0 6 * * *' };
