/* src/index.js — MinuteTag Worker API */
const ALLOWED_ORIGIN = "*"; // change to your site origin for production
const TOKEN_TTL_MINUTES = 15;

function corsHeaders(){return{
  "access-control-allow-origin": ALLOWED_ORIGIN,
  "access-control-allow-methods":"GET, POST, OPTIONS",
  "access-control-allow-headers":"content-type",
};}
function json(data, init={}){return new Response(JSON.stringify(data),{
  headers:{ "content-type":"application/json","cache-control":"no-store",...corsHeaders(),...(init.headers||{}) },
  status: init.status||200
});}
function uuid(){
  if(globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const buf=new Uint8Array(16); crypto.getRandomValues(buf);
  buf[6]=(buf[6]&0x0f)|0x40; buf[8]=(buf[8]&0x3f)|0x80;
  const b=[...buf].map(x=>x.toString(16).padStart(2,"0")).join("");
  return `${b.slice(0,8)}-${b.slice(8,12)}-${b.slice(12,16)}-${b.slice(16,20)}-${b.slice(20)}`;
}

const routes={
  async OPTIONS(){ return new Response(null,{headers:corsHeaders()}); },

  async "POST /api/start"(request, env){
    const token=uuid(), now=Date.now(), expiresAt=now+TOKEN_TTL_MINUTES*60*1000;
    const record={ token, status:"pending", createdAt:now, expiresAt, lat:null, lng:null, ts:null };
    await env.TOKEN_STORE.put(`token:${token}`, JSON.stringify(record), { expirationTtl:TOKEN_TTL_MINUTES*60 });
    const phonePageBase=env.PHONE_PAGE_BASE ?? "https://example.com/phone/";
    const link=`${phonePageBase}?token=${encodeURIComponent(token)}`;
    return json({ token, link, expiresAt });
  },

  async "POST /api/accept"(request, env){
    let payload; try{ payload=await request.json(); }catch{ return json({error:"Invalid JSON"},{status:400}); }
    const { token, lat, lng, ts } = payload||{};
    if(!token || typeof lat!=="number" || typeof lng!=="number") return json({error:"Missing token/lat/lng"},{status:400});
    const key=`token:${token}`, raw=await env.TOKEN_STORE.get(key);
    if(!raw) return json({error:"Token not found/expired"},{status:404});
    const record=JSON.parse(raw), now=Date.now();
    if(now>record.expiresAt){
      record.status="expired";
      await env.TOKEN_STORE.put(key, JSON.stringify(record), { expirationTtl:60 });
      return json({error:"Token expired"},{status:410});
    }
    record.status="accepted"; record.lat=lat; record.lng=lng; record.ts=ts||now;
    await env.TOKEN_STORE.put(key, JSON.stringify(record), {
      expirationTtl: Math.max(60, Math.floor((record.expiresAt-now)/1000))
    });
    return json({ ok:true });
  },

  async "GET /api/status"(request, env){
    const url=new URL(request.url); const token=url.searchParams.get("token");
    if(!token) return json({error:"Missing token"},{status:400});
    const raw=await env.TOKEN_STORE.get(`token:${token}`);
    if(!raw) return json({error:"Token not found/expired"},{status:404});
    const r=JSON.parse(raw);
    return json({ token:r.token, status:r.status, lat:r.lat, lng:r.lng, ts:r.ts, expiresAt:r.expiresAt });
  },
};

export default {
  async fetch(request, env, ctx){
    const url=new URL(request.url), k=`${request.method} ${url.pathname}`;
    const h = routes[k]
      || (url.pathname==="/api/start"  && routes[`${request.method} /api/start`])
      || (url.pathname==="/api/accept" && routes[`${request.method} /api/accept`])
      || (url.pathname==="/api/status" && routes[`${request.method} /api/status`])
      || routes[request.method];
    if(h) return h(request, env, ctx);
    return json({error:"Not found"},{status:404});
  }
};
