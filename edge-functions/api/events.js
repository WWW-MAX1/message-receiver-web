const CHANNELS = new Set(['messages', 'status', 'receipts']);
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{40,64}$/;
const MAX_AGE = 12 * 3600;
const headers = {'content-type':'application/json; charset=UTF-8','cache-control':'no-store','access-control-allow-origin':'*','access-control-allow-headers':'authorization, content-type'};
const response = (body, status=200) => new Response(JSON.stringify(body), {status, headers});

async function identity(request) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!TOKEN.test(token)) throw Object.assign(new Error('unauthorized'), {status:401});
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), b=>b.toString(16).padStart(2,'0')).join('');
}

function sinceSeconds(value) {
  if (!value || value === '12h') return MAX_AGE;
  if (/^\d+m$/.test(value)) return Math.min(MAX_AGE, Number(value.slice(0,-1))*60);
  if (/^\d+h$/.test(value)) return Math.min(MAX_AGE, Number(value.slice(0,-1))*3600);
  throw Object.assign(new Error('invalid since'), {status:400});
}

async function cleanup(store, prefix, blobs, cutoff) {
  await Promise.all(blobs.filter(x=>Number(x.key.slice(prefix.length, prefix.length+13)) < cutoff).map(x=>store.delete(x.key)));
}

export async function handle(request, store) {
  if (request.method === 'OPTIONS') return new Response(null, {status:204, headers});
  const owner = await identity(request);
  if (request.method === 'POST') {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) return response({error:'too large'}, 413);
    let body;
    try { body=JSON.parse(raw); } catch { return response({error:'invalid json'}, 400); }
    if (!CHANNELS.has(body.channel)||!ID.test(body.id)||!Number.isFinite(body.sent_at)||typeof body.message!=='string'||new TextEncoder().encode(body.message).length>4096) return response({error:'invalid event'},400);
    const now=Date.now()/1000;
    if (body.sent_at<now-MAX_AGE||body.sent_at>now+30) return response({error:'expired'},400);
    try { const env=JSON.parse(body.message); if(env.v!==1||typeof env.iv!=='string'||typeof env.data!=='string') throw Error(); } catch { return response({error:'invalid envelope'},400); }
    const ms=String(Math.floor(body.sent_at*1000)).padStart(13,'0');
    const key=`${owner}/${body.channel}/${ms}-${body.id}.json`;
    try { await store.setJSON(key,{id:body.id,time:body.sent_at,message:body.message},{onlyIfNew:true}); } catch (e) {
      const existing=await store.get(key,{type:'json',consistency:'strong'});
      if (!existing) throw e;
    }
    return response({ok:true,id:body.id});
  }
  if (request.method === 'GET') {
    const url=new URL(request.url), channel=url.searchParams.get('channel');
    if (!CHANNELS.has(channel)) return response({error:'invalid channel'},400);
    const seconds=sinceSeconds(url.searchParams.get('since'));
    const cutoff=Date.now()-seconds*1000, prefix=`${owner}/${channel}/`;
    const result=await store.list({prefix,consistency:'strong'});
    const current=result.blobs.filter(x=>Number(x.key.slice(prefix.length,prefix.length+13))>=cutoff).slice(-500);
    const events=(await Promise.all(current.map(x=>store.get(x.key,{type:'json',consistency:'strong'})))).filter(Boolean).map(x=>({event:'message',id:x.id,time:x.time,message:x.message}));
    if (result.blobs.length>current.length) cleanup(store,prefix,result.blobs,Date.now()-MAX_AGE*1000).catch(()=>{});
    return response({events,truncated:result.blobs.length>500});
  }
  return response({error:'method not allowed'},405);
}

export async function onRequest(context) {
  try {
    const {getStore}=await import('@edgeone/pages-blob');
    return await handle(context.request, getStore({name:'message-events', consistency:'strong'}));
  }
  catch (e) { return response({error:e.status===401?'unauthorized':'server error'},e.status||500); }
}
