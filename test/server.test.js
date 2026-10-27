// Server protocol tests: rooms, lobby, spectators, host handover, reconnect, start, return to lobby, limits.
const test=require('node:test'),assert=require('node:assert/strict'),WebSocket=require('ws');
const {createServer}=require('../server');
const {LOBBY_GRACE_MS,ROOM_IDLE_MS,BACK_TO_LOBBY_MS}=require('../server/rooms');

let srv,base,clock=0;
const now=()=>Date.now()+clock;
test.before(async()=>{srv=createServer({now,createPerMin:60});await new Promise(r=>srv.server.listen(0,r));base='http://localhost:'+srv.server.address().port});
test.after(()=>srv.close());

const newRoom=async()=>(await (await fetch(base+'/api/rooms',{method:'POST'})).json()).code;
// a test client that buffers every message so we can wait for a type without racing
function client(){
  const ws=new WebSocket(base.replace('http','ws')+'/ws'),msgs=[],waiters=[];
  ws.on('message',d=>{const m=JSON.parse(d);msgs.push(m);for(const w of [...waiters])if(w.pred(m)){waiters.splice(waiters.indexOf(w),1);w.res(m)}});
  const opened=new Promise(r=>ws.on('open',r)),closed=new Promise(r=>ws.on('close',(code,reason)=>r({code,reason:String(reason)})));
  const c={ws,msgs,closed,
    send:async m=>{await opened;ws.send(typeof m==='string'?m:JSON.stringify(m))},
    // resolves with the first message (already received or future) after `from` matching type and predicate
    next(t,pred=()=>true,from=c.mark){const f=m=>m.t===t&&pred(m),i=msgs.findIndex((m,j)=>j>=from&&f(m));
      if(i>=0){c.mark=i+1;return Promise.resolve(msgs[i])}
      return new Promise((res,rej)=>{const to=setTimeout(()=>rej(new Error('timeout waiting for '+t)),2000);waiters.push({pred:f,res:m=>{clearTimeout(to);c.mark=msgs.indexOf(m)+1;res(m)}})})},
    mark:0,
    last:t=>[...msgs].reverse().find(m=>m.t===t),
    join:async(room,name,extra={})=>{await c.send({t:'join',room,name,...extra});return c.next('welcome')},
    close:()=>ws.close()};
  return c;
}
const settle=()=>new Promise(r=>setTimeout(r,50));
const lobbyOf=async c=>{await settle();return c.last('lobby')};

test('serves the page at / and /r/CODE, plus game.js',async()=>{
  for(const p of ['/','/r/ABCDE','/game.js']){const r=await fetch(base+p);assert.equal(r.status,200,p)}
  assert.equal((await fetch(base+'/api/rooms/ZZZZZ')).status,404);
});

test('room codes use the unambiguous alphabet',async()=>{
  for(let i=0;i<20;i++)assert.match(await newRoom(),/^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{5}$/);
});

test('join, names, seats, ready and host-only start',async()=>{
  const code=await newRoom(),a=client(),b=client(),c=client();
  const wa=await a.join(code,'  Ann   the\tGreat Destroyer  ');
  assert.equal(wa.you.name,'Ann the Grea');assert.equal(wa.you.slot,0);assert.equal(wa.host,wa.you.id);assert.ok(wa.token.length>=32);
  const wb=await b.join(code.toLowerCase(),'ann');
  assert.equal(wb.you.name,'ann');assert.equal(wb.you.slot,1);
  const wc=await c.join(code,'Ann the Grea');
  assert.equal(wc.you.name,'Ann the Gr 2','duplicate names get a number');
  // start rules
  await b.send({t:'start'});assert.equal((await b.next('error')).code,'not_host');
  await a.send({t:'start'});assert.equal((await a.next('error')).code,'not_ready');
  for(const x of [a,b,c])await x.send({t:'ready',ready:true});
  const l=await lobbyOf(a);assert.deepEqual(l.players.map(p=>[p.slot,p.ready]),[[0,true],[1,true],[2,true]]);
  await a.send({t:'start'});
  const s=await c.next('start');
  assert.deepEqual(s.names,['Ann the Grea','ann','Ann the Gr 2']);
  assert.ok(Number.isInteger(s.seed)&&s.seed>=0&&s.seed<2**32);assert.equal(s.startFrame,0);assert.equal(s.you.team,2);
  for(const x of [a,b,c])x.close();
});

test('needs two players; a seventh joiner and anyone asking to watch become spectators',async()=>{
  const code=await newRoom(),cs=[];
  const a=client();cs.push(a);await a.join(code,'A');await a.send({t:'ready',ready:true});
  await a.send({t:'start'});assert.equal((await a.next('error')).code,'need_players');
  for(let i=1;i<6;i++){const c=client();cs.push(c);assert.equal((await c.join(code,'P'+i)).you.role,'player')}
  const s7=client(),w7=await s7.join(code,'Seven');
  assert.equal(w7.you.role,'spectator');assert.equal(w7.seatWanted,true);
  const sv=client(),wv=await sv.join(code,'Viewer',{spectate:true});
  assert.equal(wv.you.role,'spectator');assert.equal(wv.seatWanted,false);
  // a player steps out to watch: seats re-pack and the spectator can take the free one
  await cs[2].send({t:'role',spectate:true});
  let l=await lobbyOf(a);assert.deepEqual(l.players.map(p=>p.slot),[0,1,2,3,4]);assert.equal(l.spectators.length,3);
  await s7.send({t:'role',spectate:false});
  assert.equal((await s7.next('you')).you.slot,5);
  await cs[2].send({t:'role',spectate:false});assert.equal((await cs[2].next('error')).code,'room_full');
  // spectators can't ready up, and get the start message with team -1
  await sv.send({t:'ready',ready:true});assert.equal((await sv.next('error')).code,'not_in_lobby');
  const players=[...cs.filter(c=>c!==cs[2]),s7];
  for(const p of players)await p.send({t:'ready',ready:true});
  await settle();await a.send({t:'start'});
  assert.equal((await sv.next('start')).you.team,-1);
  // joining mid-match: spectator
  const late=client(),wl=await late.join(code,'Late');
  assert.equal(wl.you.role,'spectator');assert.equal(wl.state,'playing');assert.ok(wl.match.seed>=0);
  for(const c of [...cs,s7,sv,late])c.close();
});

test('host handover on disconnect and on leave',async()=>{
  const code=await newRoom(),a=client(),b=client(),v=client();
  const wa=await a.join(code,'A');const wb=await b.join(code,'B');await v.join(code,'V',{spectate:true});
  a.close();
  assert.equal((await b.next('host')).id,wb.you.id);
  await b.send({t:'leave'});
  const h=await v.next('host',m=>m.id!==wb.you.id);assert.notEqual(h.id,wa.you.id);assert.notEqual(h.id,wb.you.id);
  assert.equal((await b.closed).code,1000);
  v.close();
});

test('reconnect with token keeps the seat; a second tab replaces the first',async()=>{
  const code=await newRoom(),a=client(),b=client();
  const wa=await a.join(code,'A');await b.join(code,'B');
  a.close();await settle();
  let l=b.last('lobby');assert.equal(l.players.find(p=>p.id===wa.you.id).connected,false);
  const a2=client(),w2=await a2.join(code,'whatever',{token:wa.token});
  assert.equal(w2.you.id,wa.you.id);assert.equal(w2.you.slot,0);
  const a3=client();await a3.join(code,'A',{token:wa.token});
  assert.equal((await a2.closed).code,4001,'old tab told it was replaced');
  await settle();l=b.last('lobby');assert.equal(l.players.find(p=>p.id===wa.you.id).connected,true,'replaced socket closing must not mark the seat disconnected');
  for(const c of [b,a3])c.close();
});

test('dropped lobby seat is freed after the grace period; empty rooms are deleted after 30 minutes',async()=>{
  const code=await newRoom(),a=client(),b=client();
  await a.join(code,'A');const wb=await b.join(code,'B');
  b.close();await settle();
  clock+=LOBBY_GRACE_MS-1000;srv.rooms.sweep();assert.equal((await lobbyOf(a)).players.length,2);
  clock+=2000;srv.rooms.sweep();assert.equal((await lobbyOf(a)).players.length,1);
  const b2=client();await b2.send({t:'join',room:code,name:'B',token:wb.token});
  assert.equal((await b2.next('welcome')).you.id===wb.you.id,false,'expired token gets a fresh seat');
  a.close();b2.close();await settle();
  clock+=ROOM_IDLE_MS-1000;srv.rooms.sweep();assert.ok(srv.rooms.get(code));
  clock+=2000;srv.rooms.sweep();assert.equal(srv.rooms.get(code),undefined);
  const unjoined=await newRoom();clock+=ROOM_IDLE_MS+1;srv.rooms.sweep();assert.equal(srv.rooms.get(unjoined),undefined);
});

test('match end needs a majority, then everyone returns to the same lobby',async()=>{
  const code=await newRoom(),ps=[client(),client(),client()],v=client();
  const ws=[];for(const [i,p] of ps.entries())ws.push(await p.join(code,'P'+i));
  await v.join(code,'V',{spectate:true});
  for(const p of ps)await p.send({t:'ready',ready:true});
  await settle();await ps[0].send({t:'start'});await v.next('start');
  // spectators don't vote; one player alone can't end it; disagreeing reports don't count
  await v.send({t:'over',frame:900,winner:0});await ps[1].send({t:'over',frame:900,winner:1});
  await ps[2].send({t:'over',frame:900,winner:0});await settle();
  assert.equal(v.last('match_over'),undefined);
  await ps[0].send({t:'over',frame:900,winner:0});
  const mo=await v.next('match_over');assert.equal(mo.winner,0);assert.equal(mo.name,'P0');
  // a player drops during the results screen: their seat is freed on return
  ps[2].close();await settle();
  clock+=BACK_TO_LOBBY_MS;srv.rooms.sweep();
  const l=await lobbyOf(v);
  assert.equal(l.state,'lobby');assert.deepEqual(l.players.map(p=>[p.name,p.slot,p.ready]),[['P0',0,false],['P1',1,false]]);
  assert.equal(l.spectators.length,1);
  // and a rematch can start
  for(const p of ps.slice(0,2))await p.send({t:'ready',ready:true});
  await settle();await ps[0].send({t:'start'});assert.deepEqual((await v.next('start')).names,['P0','P1']);
  for(const c of [...ps,v])c.close();
});

test('bad input is rejected: join first, unknown room, junk, oversize, flooding',async()=>{
  const x=client();await x.send({t:'ready',ready:true});assert.equal((await x.next('error')).code,'join_first');
  await x.send('not json');assert.equal((await x.next('error')).code,'bad_message');
  await x.send({t:'join',room:'ZZZZZ',name:'X'});assert.equal((await x.next('error')).code,'no_room');assert.equal((await x.closed).code,4000);
  const code=await newRoom(),y=client();await y.join(code,'Y');
  await y.send({t:'name',name:'x'.repeat(5000)});assert.equal((await y.next('error')).code,'too_big');
  await y.send({t:'launch_missiles'});assert.equal((await y.next('error')).code,'unknown_type');
  for(let i=0;i<400;i++)y.ws.send('{"t":"ping","c":1}');
  assert.equal((await y.closed).code,1008);
});

test('room creation is rate limited per IP',async()=>{
  let last;for(let i=0;i<65;i++)last=await fetch(base+'/api/rooms',{method:'POST'});
  assert.equal(last.status,429);
});

test('match settings: host only, lobby only, validated, reset ready, sent with start and to late joiners',async()=>{
  clock+=61_000; // the rate-limit test above used up this minute's room allowance
  const code=await newRoom(),a=client(),b=client();
  const wa=await a.join(code,'A');assert.deepEqual(wa.settings,{worms:2,turn:15});
  await b.join(code,'B');
  await b.send({t:'settings',worms:3});assert.equal((await b.next('error')).code,'not_host');
  await a.send({t:'settings',worms:7});assert.equal((await a.next('error')).code,'bad_message');
  await a.send({t:'settings',turn:13});assert.equal((await a.next('error')).code,'bad_message');
  await b.send({t:'ready',ready:true});await a.send({t:'ready',ready:true});
  await b.next('lobby',m=>m.players.every(p=>p.ready));
  await a.send({t:'settings',worms:4,turn:30});
  const l=await b.next('lobby',m=>m.settings.worms===4);
  assert.deepEqual(l.settings,{worms:4,turn:30});assert.ok(l.players.every(p=>!p.ready),'ready flags kept after a change');
  for(const x of [a,b])await x.send({t:'ready',ready:true});
  await settle();await a.send({t:'start'});
  assert.deepEqual((await b.next('start')).settings,{worms:4,turn:30});
  await a.send({t:'settings',worms:1});assert.equal((await a.next('error')).code,'not_in_lobby');
  const c=client(),wc=await c.join(code,'C');assert.deepEqual(wc.match.settings,{worms:4,turn:30});
  for(const x of [a,b,c])x.close();
});

test('shutdown tells every connected player the server is restarting before closing',async()=>{
  clock+=61_000;
  const code=await newRoom(),a=client(),b=client();await a.join(code,'A');await b.join(code,'B');
  srv.shutdown();
  for(const x of [a,b]){await x.next('server_restart');assert.equal((await x.closed).code,1012)}
});
