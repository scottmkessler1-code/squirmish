// Lockstep tests: the server clock and input stamping (fake time), then whole matches played over real sockets by
// headless bot clients with artificial latency, a hidden tab, a reconnect and a late spectator.
const test=require('node:test'),assert=require('node:assert/strict'),WebSocket=require('ws');
const {Room,INPUT_DELAY,STALL_LAG_S,STALL_MAX_MS}=require('../server/rooms');
const {createServer}=require('../server');
const {createGame}=require('../public/game.js');
const {createLockstep}=require('../public/lockstep.js');
const {replay}=require('./harness');

// ---------- server clock, fake time ----------
function fakeRoom(fps=60){
  let t=1000;const r=new Room('TEST1',t,{fps}),inbox=new Map();
  const add=(name,spectate)=>{const box=[];const {member}=r.join({name,spectate},m=>box.push(m),t);inbox.set(member.id,box);return member};
  return {r,add,inbox,advance:ms=>{t+=ms;r.tickClock(t)},get t(){return t}};
}
function started(n=2){
  const f=fakeRoom(),ps=Array.from({length:n},(_,i)=>f.add('P'+i));
  ps.forEach(p=>f.r.setReady(p,true));f.r.start(ps[0],f.t,12345);
  return Object.assign(f,{ps});
}

test('clock: 60 frames per second, upTo runs INPUT_DELAY-1 ahead, inputs never land on a frame already released',()=>{
  const f=started(),box=f.inbox.get(f.ps[1].id);
  for(let i=0;i<200;i++){
    if(i%3===0)f.r.input(f.ps[i%2],{k:'ArrowLeft',d:i%2===0});
    if(i%7===0)f.r.input(f.ps[0],{k:' ',d:true}); // several inputs inside one tick
    f.advance(17+(i%5)*7); // irregular ticks
  }
  const c=f.r.match.clock,elapsed=f.t-1000;
  assert.ok(Math.abs(c.frame-elapsed*60/1000)<=1,'frame '+c.frame+' vs '+elapsed*60/1000);
  assert.equal(c.sentUpTo,c.frame+INPUT_DELAY-1);
  const steps=box.filter(m=>m.t==='step');
  // the key invariant: an input is never stamped for a frame clients were already allowed to run
  let released=0;
  for(const m of steps){assert.ok(m.upTo>released);for(const e of m.inputs){assert.ok(e.f>released,'input at '+e.f+' but '+released+' already released');assert.ok(e.f<=m.upTo)}released=m.upTo}
  // every input delivered exactly once, in log order
  assert.deepEqual(steps.flatMap(m=>m.inputs),c.log.filter(e=>e.f<=c.sentUpTo));
});

test('clock: only seated players can send inputs, and only valid keys',()=>{
  const f=started(),v=f.add('V',true);
  assert.equal(f.r.input(v,{k:' ',d:true}),'not_playing');
  assert.equal(f.r.input(f.ps[0],{k:'x',d:true}),'bad_message');
  assert.equal(f.r.input(f.ps[0],{k:' ',d:'yes'}),'bad_message');
  assert.equal(f.r.input(f.ps[0],{k:' ',d:true}),undefined);
  assert.deepEqual(f.r.match.clock.log.map(e=>e.p),[0]);
});

test('clock: stalls for a lagging player, resumes when they catch up, gives up after STALL_MAX',()=>{
  const f=started(),[a,b]=f.ps,box=f.inbox.get(a.id),c=f.r.match.clock;
  const run=(ms,ackA=true,ackB=true)=>{for(let i=0;i<ms/50;i++){f.advance(50);if(ackA)f.r.ack(a,c.frame);if(ackB)f.r.ack(b,c.frame)}};
  run(1000);assert.equal(c.stalled,null);
  run(STALL_LAG_S*1000+200,true,false); // b stops acking
  assert.deepEqual(c.stalled,[b.id]);assert.deepEqual(box.filter(m=>m.t==='stall').at(-1).waiting,[b.id]);
  const frozen=c.frame;run(1000,true,false);assert.equal(c.frame,frozen,'clock must not move while stalled');
  run(100);assert.equal(c.stalled,null);assert.deepEqual(box.filter(m=>m.t==='stall').at(-1).waiting,[]);
  // a player who never comes back stops blocking the match after STALL_MAX_MS
  run(STALL_LAG_S*1000+200,true,false);assert.deepEqual(c.stalled,[b.id]);
  run(STALL_MAX_MS+200,true,false);assert.equal(c.stalled,null);
  const f2=c.frame;run(500,true,false);assert.ok(c.frame>f2,'match moves on without them');
  // disconnected players never stall it
  run(200);f.r.disconnect(b,f.t);run(2000,true,false);assert.equal(c.stalled,null);
});

// ---------- desync detection and resync, fake time ----------
const {HASH_WAIT_MS,SNAPSHOT_WAIT_MS,CHECKPOINT_EVERY}=require('../server/rooms');
const sent=(f,id,t)=>f.inbox.get(id).filter(m=>m.t===t);
function hashes(f,frame,list){list.forEach(([m,h,e])=>f.r.hash(m,{frame,h,e},f.t))}

test('resync: the majority wins, the odd one out gets a snapshot from an agreeing client plus the inputs after it',()=>{
  const f=started(3),[a,b,c]=f.ps;
  f.advance(3000);f.r.input(a,{k:'ArrowLeft',d:true});f.advance(500);f.r.input(a,{k:'ArrowLeft',d:false});f.advance(1000);
  hashes(f,120,[[a,111],[b,222],[c,111]]);f.advance(50);
  assert.deepEqual(sent(f,b.id,'desync').map(m=>m.frame),[120]);
  assert.equal(sent(f,a.id,'snapshot_req').length,1,'host is on the good side, so it provides');
  assert.equal(sent(f,c.id,'snapshot_req').length,0);
  assert.equal(f.r.snapshot(c,{data:{frame:10}}),'unexpected','only the chosen provider may answer');
  const log=f.r.match.clock.log,snapF=log[0].f; // a snapshot taken between the two inputs
  f.r.snapshot(a,{data:{frame:snapF,v:1}});
  const sn=sent(f,b.id,'snapshot');
  assert.equal(sn.length,1);assert.equal(sn[0].e,1);assert.equal(sn[0].upTo,f.r.match.clock.sentUpTo);
  assert.deepEqual(sn[0].inputs,log.filter(e=>e.f>snapF&&e.f<=f.r.match.clock.sentUpTo));
  assert.equal(sent(f,c.id,'snapshot').length,0,'in-sync clients are left alone');
  // b's hashes from before it loaded the snapshot (epoch 0) are ignored; fresh ones are compared to what was agreed
  f.r.hash(b,{frame:120,h:999,e:0},f.t);f.advance(50);assert.equal(sent(f,b.id,'desync').length,1);
  f.r.hash(b,{frame:120,h:111,e:1},f.t);f.advance(50);assert.equal(sent(f,b.id,'desync').length,1);
  f.r.hash(b,{frame:120,h:5,e:1},f.t);f.advance(50);assert.equal(sent(f,b.id,'desync').length,2,'late report checked against the agreed hash');
  // a newcomer starts from the checkpoint, with only the inputs after it
  const box=[];f.r.join({name:'Late',spectate:true},m=>box.push(m),f.t);
  const w=box.find(m=>m.t==='welcome');
  assert.equal(w.match.snapshot.frame,snapF);assert.ok(w.match.inputs.every(e=>e.f>snapF));
});

test('resync: a 1-1 tie goes to the host; reports wait for everyone, but not forever',()=>{
  const f=started(2),[a,b]=f.ps;f.advance(3000);
  hashes(f,120,[[b,2]]);f.advance(HASH_WAIT_MS-100);
  assert.equal(sent(f,b.id,'desync').length+sent(f,a.id,'desync').length,0,'decided before everyone reported');
  hashes(f,120,[[a,1]]);f.advance(50);
  assert.equal(sent(f,b.id,'desync').length,1);assert.equal(sent(f,a.id,'snapshot_req').length,1);
  // a frame only one client reported is accepted after the wait
  hashes(f,240,[[a,7]]);f.advance(HASH_WAIT_MS+50);assert.equal(f.r.match.sync.agreed.get(240),7);
});

test('resync: a provider that never answers is replaced; client-requested resyncs are rate limited',()=>{
  const f=started(3),[a,b,c]=f.ps;f.advance(3000);
  hashes(f,120,[[a,1],[b,1],[c,9]]);f.advance(50);
  assert.equal(sent(f,a.id,'snapshot_req').length,1);
  f.r.disconnect(a,f.t);f.advance(SNAPSHOT_WAIT_MS+50);
  assert.equal(sent(f,b.id,'snapshot_req').length,1,'next agreeing client asked');
  f.r.snapshot(b,{data:{frame:10}});assert.equal(sent(f,c.id,'snapshot').length,1);
  f.r.requestResync(c,f.t);f.r.requestResync(c,f.t+10);f.advance(50);
  assert.equal(sent(f,b.id,'snapshot_req').length,2,'second request within the limit ignored');
});

test('resync: when everyone agrees, a checkpoint is still taken every couple of minutes',()=>{
  const f=started(2),[a,b]=f.ps;f.advance(1000);
  hashes(f,120,[[a,1],[b,1]]);f.advance(50);assert.equal(sent(f,a.id,'snapshot_req').length,0);
  hashes(f,CHECKPOINT_EVERY,[[a,1],[b,1]]);f.advance(50);
  assert.equal(sent(f,a.id,'snapshot_req').length,1);
  f.r.snapshot(a,{data:{frame:5}});assert.equal(f.r.match.sync.checkpoint.frame,5);
  assert.equal(sent(f,b.id,'snapshot').length,0);
});

// ---------- leaving, dropping out and forfeits, fake time ----------
const {FORFEIT_MS,BACK_TO_LOBBY_MS}=require('../server/rooms');
test('forfeit: leaving mid-match forfeits at once; a dropped player has FORFEIT_MS to come back',()=>{
  const f=started(4),[a,b,c,d]=f.ps,box=f.inbox.get(a.id);f.advance(1000);
  assert.equal(f.r.input(a,{k:'forfeit',d:true}),'bad_message','clients cannot send forfeits');
  const upTo=f.r.match.clock.sentUpTo;
  f.r.leave(b,f.t);
  const fb=f.r.match.clock.log.find(e=>e.k==='forfeit');
  assert.deepEqual([fb.p,fb.d],[1,true]);assert.ok(fb.f>upTo,'forfeit stamped into the past');
  assert.deepEqual(box.filter(m=>m.t==='player_left').map(m=>[m.slot,m.reason]),[[1,'left']]);
  f.advance(100);assert.ok(box.some(m=>m.t==='step'&&m.inputs.includes(fb)),'forfeit delivered in a step');
  // c drops and comes back in time: nothing; d drops for good: forfeits after FORFEIT_MS
  f.r.disconnect(c,f.t);f.r.disconnect(d,f.t);
  f.advance(FORFEIT_MS/2);f.r.join({token:c.token},()=>{},f.t);
  for(let i=0;i<FORFEIT_MS/2/200;i++)f.advance(200);
  f.advance(200);
  assert.deepEqual(f.r.match.clock.log.filter(e=>e.k==='forfeit').map(e=>e.p),[1,3]);
  assert.equal(box.filter(m=>m.t==='player_left').at(-1).reason,'timeout');
  f.advance(FORFEIT_MS*2);assert.equal(f.r.match.clock.log.filter(e=>e.k==='forfeit').length,2,'forfeited twice');
});

test('forfeit: when nobody is left to report the end, the server ends the match',()=>{
  const f=started(2),[a,b]=f.ps,v=f.add('V',true),box=f.inbox.get(v.id);f.advance(1000);
  f.r.leave(b,f.t);f.advance(50);
  assert.equal(box.filter(m=>m.t==='match_over').length,0,'a is still there to report the result');
  f.r.disconnect(a,f.t);f.advance(50);
  const mo=box.filter(m=>m.t==='match_over');
  assert.equal(mo.length,1);assert.equal(mo[0].winner,0);assert.equal(mo[0].name,'P0');
  f.advance(BACK_TO_LOBBY_MS);
  assert.equal(f.r.state,'lobby');assert.equal(f.r.players.length,0,'dropped player keeps no seat');assert.equal(f.r.spectators.length,1);
});

// ---------- whole matches over real sockets ----------
const FPS=1200; // 20x real time so a full match takes seconds
// in-order delivery after a random delay, like a TCP stream with jitter (plain setTimeouts would reorder messages)
function pipe(lat){
  const q=[];let timer=null;
  const drain=()=>{timer=null;const t=Date.now();while(q.length&&q[0].at<=t)q.shift().fn();if(q.length)timer=setTimeout(drain,q[0].at-t)};
  return fn=>{const at=Math.max(q.length?q[q.length-1].at:0,Date.now()+lat[0]+Math.random()*(lat[1]-lat[0]));q.push({at,fn});if(!timer)timer=setTimeout(drain,at-Date.now())};
}
function netClient(url,{lat=[10,60],name='?'}={}){
  const c={name,trace:new Map(),msgs:[],paused:false,game:null,ls:null,ws:null,token:null,you:null,bot:null,desyncs:[]};
  const up=pipe(lat),down=pipe(lat);
  const connect=(join)=>{
    const ws=new WebSocket(url);c.ws=ws;
    const game=createGame();c.game=game;
    const ls=c.ls=createLockstep({game,
      send:m=>up(()=>ws.readyState===1&&ws.send(JSON.stringify(m))),
      onFrame:g=>{if(g.frame%60===0)c.trace.set(g.frame,g.stateHash())},
      onDesync:info=>c.desyncs.push(info)});
    c.conn=(c.conn||0)+1;
    ws.on('open',()=>ws.send(JSON.stringify(join)));
    ws.on('message',d=>{const m=JSON.parse(d);
      down(()=>{c.msgs.push(m);if(m.t==='welcome'){c.token=m.token;c.you=m.you}if(m.t==='start')c.you=m.you;ls.onMessage(m)})});
  };
  c.join=(room,name,extra={})=>connect({t:'join',room,name,...extra});
  c.rejoin=room=>{c.ws.close();setTimeout(()=>connect({t:'join',room,name:'x',token:c.token}),100)};
  c.tickT=setInterval(()=>{if(c.paused||!c.ls)return;c.ls.pump(Infinity,15);if(c.bot)c.bot()},8);
  c.stop=()=>{clearInterval(c.tickT);c.ws.close()};
  return c;
}
// a bot that plays its own turns through ls.input(), timed by local frames
function addBot(c,seed){
  let s=seed,turn='',plan=[];const R=()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296};
  c.bot=()=>{
    const g=c.game,ls=c.ls;if(!ls.started||g.phase==='over')return;
    if(g.phase==='aim'&&g.cur===ls.myTeam){
      const key=g.cur+':'+g.teams[g.cur].turns;
      if(key!==turn){turn=key;let f=g.frame+5;plan=[];const at=(k,d,df)=>{f+=df;plan.push({f,k,d})};
        const t=g.teams[g.cur],avail=[1,2,3,4,5].filter(i=>t.ammo[i]>0);
        const k=avail.length?String(avail[Math.floor(R()*avail.length)]):'6';at(k,true,0);at(k,false,2);
        const dir=R()<.5?'ArrowLeft':'ArrowRight';at(dir,true,2);at(dir,false,Math.floor(R()*80));
        const up=R()<.6?'ArrowUp':'ArrowDown';at(up,true,2);at(up,false,Math.floor(R()*40));
        at(' ',true,2);at(' ',false,10+Math.floor(R()*70));
      }
    }
    while(plan.length&&g.frame>=plan[0].f){const e=plan.shift();ls.input(e.k,e.d)}
  };
}
let status=()=>'';
const until=(cond,ms,what)=>new Promise((res,rej)=>{const t0=Date.now(),iv=setInterval(()=>{if(cond()){clearInterval(iv);res()}else if(Date.now()-t0>ms){clearInterval(iv);rej(new Error('timeout: '+what+' '+status()))}},10)});

test('a full online match stays in sync through latency, a hidden tab, a reconnect and a late spectator',{timeout:120_000},async()=>{
  const srv=createServer({fps:FPS});await new Promise(r=>srv.server.listen(0,r));
  const base='http://localhost:'+srv.server.address().port,url=base.replace('http','ws')+'/ws';
  const code=(await (await fetch(base+'/api/rooms',{method:'POST'})).json()).code;
  const [a,b,c]=[netClient(url,{lat:[5,40],name:'a'}),netClient(url,{lat:[30,120],name:'b'}),netClient(url,{lat:[10,80],name:'c'})],v=netClient(url,{name:'v'});
  const all=[a,b,c,v];let log=null,mo=null,last=0,corruptAt=0,fixedAt=0;
  try{
  a.join(code,'Ann');await until(()=>a.you,2000,'a joined');
  b.join(code,'Bo');c.join(code,'Cy');await until(()=>b.you&&c.you,2000,'b,c joined');
  [a,b,c].forEach((x,i)=>{addBot(x,i+1);x.ws.send(JSON.stringify({t:'ready',ready:true}))});
  await new Promise(r=>setTimeout(r,200));
  a.ws.send(JSON.stringify({t:'start'}));
  await until(()=>a.ls.started&&b.ls.started&&c.ls.started,3000,'started');
  const room=srv.rooms.get(code);
  status=()=>JSON.stringify({frames:all.map(x=>x.game.frame),upTo:all.map(x=>x.ls.upTo),phase:a.game.phase,stalled:room.match?.clock.stalled,acks:room.match&&[...room.match.clock.acks],synced:room.match&&[...room.match.clock.synced],srvFrame:room.match?.clock.frame,state:room.state});
  const keepLog=setInterval(()=>{if(room.match)log={seed:room.match.seed,names:room.match.names,inputs:room.match.clock.log}},20);

  // a spectator joins late and fast-forwards from the input log
  await until(()=>a.game.frame>500,20000,'frame 500');
  v.join(code,'Viewer',{spectate:true});
  // b's tab goes to the background: the clock must stall for b, then resume
  await until(()=>a.game.frame>1200,20000,'frame 1200');
  b.paused=true;
  await until(()=>a.msgs.some(m=>m.t==='stall'&&m.waiting.includes(b.you.id)),5000,'stall for b');
  const stalledAt=a.ls.upTo;await new Promise(r=>setTimeout(r,500));
  assert.ok(a.ls.upTo-stalledAt<=FPS*0.2,'clock kept running during the stall');
  b.paused=false;
  await until(()=>a.ls.waiting.length===0,5000,'stall cleared');
  // c drops and comes back with its token, rebuilding the match from the log
  await until(()=>a.game.frame>2400,30000,'frame 2400');
  c.rejoin(code);
  await until(()=>c.ws.readyState===1&&c.ls.started&&c.ls.behind<FPS,5000,'c caught up');
  // c's state gets corrupted (as if a browser computed something differently): hashes catch it and c is resynced
  await until(()=>c.game.frame>3000&&c.ls.started,30000,'frame 3000');
  const alive=c.game.worms.find(w=>!w.dead);alive.hp-=13;corruptAt=c.game.frame;
  await until(()=>c.ls.resyncs>=1,10000,'c resynced');
  fixedAt=c.msgs.find(m=>m.t==='snapshot').data.frame;
  assert.ok(c.desyncs.some(d=>d.reason==='hash_mismatch'));
  // someone joining now starts from that checkpoint instead of frame 0
  const v2=netClient(url,{name:'v2'});all.push(v2);v2.join(code,'Viewer2',{spectate:true});
  await until(()=>v2.ls.started&&v2.ls.behind<FPS,5000,'v2 caught up');
  assert.ok(v2.msgs.find(m=>m.t==='welcome').match.snapshot,'late joiner got the checkpoint');
  // play it out
  // bots can run out of ammo and stall into very long endgames; past a cap we still check sync, just not the lobby return
  await until(()=>all.every(x=>x.msgs.some(m=>m.t==='match_over'))||a.game.frame>=40000,90000,'match over');
  clearInterval(keepLog);
  mo=a.msgs.find(m=>m.t==='match_over');
  if(mo)await until(()=>all.every(x=>x.msgs.some(m=>m.t==='lobby'&&m.state==='lobby'&&x.msgs.indexOf(m)>x.msgs.indexOf(x.msgs.find(q=>q.t==='match_over')))),10000,'back to lobby');
  }finally{all.forEach(x=>x.stop());await srv.close()}

  for(const x of all)assert.deepEqual(x.desyncs.filter(d=>d.reason!=='hash_mismatch'||x!==c),[],'unexpected desync on client '+x.name);
  // every client agrees on every frame they both saw, and the late joiner and reconnector saw it from frame 0
  const ref=a.trace;last=Math.max(...ref.keys());
  for(const x of [b,c,v,all[4]]){
    let n=0;for(const [f,h] of x.trace)if(ref.has(f)&&!(x===c&&f>=corruptAt&&f<=fixedAt)){if(h!==ref.get(f))assert.fail(`client ${x.name} (connection ${x.conn}) desync at frame ${f}: ${h} vs a ${ref.get(f)}, offline replay ${replay(log.seed,log.names,log.inputs,f).trace.at(-1)}`);n++}
    assert.ok(n>=(x===all[4]?(last-x.msgs.find(m=>m.t==='welcome').match.snapshot.frame):last-(corruptAt<last?fixedAt-corruptAt:0))/60-4,'too few common samples for '+x.name+': '+n);
  }
  // and the online match is exactly the offline replay of the server's input log
  const off=replay(log.seed,log.names,log.inputs,last);
  off.trace.forEach((h,i)=>assert.equal(h,ref.get((i+1)*60),'offline replay differs at frame '+(i+1)*60));
  if(mo)assert.equal(mo.winner,a.game.teams.indexOf(a.game.winner));
  console.log(`  ${last} frames, ${log.inputs.length} inputs, ${mo?'winner '+mo.name:'no winner by the frame cap'}, stall messages ${a.msgs.filter(m=>m.t==='stall').length}`);
});

test('online forfeits: one player leaves, another vanishes; the match ends for the last team and everyone returns to the lobby',{timeout:60_000},async()=>{
  const srv=createServer({fps:FPS,forfeitMs:1500});await new Promise(r=>srv.server.listen(0,r));
  const base='http://localhost:'+srv.server.address().port,url=base.replace('http','ws')+'/ws';
  const code=(await (await fetch(base+'/api/rooms',{method:'POST'})).json()).code;
  const [a,b,c]=['a','b','c'].map(n=>netClient(url,{name:n,lat:[5,50]})),v=netClient(url,{name:'v'}),all=[a,b,c,v];
  try{
    a.join(code,'Ann');await until(()=>a.you,2000,'a');b.join(code,'Bo');c.join(code,'Cy');v.join(code,'V',{spectate:true});
    await until(()=>b.you&&c.you&&v.you,2000,'joined');
    [a,b,c].forEach((x,i)=>{addBot(x,i+7);x.ws.send(JSON.stringify({t:'ready',ready:true}))});
    await new Promise(r=>setTimeout(r,200));a.ws.send(JSON.stringify({t:'start'}));
    await until(()=>all.every(x=>x.ls.started),3000,'started');
    const room=srv.rooms.get(code);let log=null;
    const keep=setInterval(()=>{if(room.match)log={seed:room.match.seed,names:room.match.names,inputs:[...room.match.clock.log]}},20);
    await until(()=>a.game.frame>900,10000,'frame 900');
    b.ws.send(JSON.stringify({t:'leave'}));          // on purpose
    c.stop();c.ws.terminate();                       // connection dies and never comes back
    await until(()=>[a,v].every(x=>x.msgs.some(m=>m.t==='match_over')),20000,'match over');
    clearInterval(keep);
    const mo=a.msgs.find(m=>m.t==='match_over');
    assert.equal(mo.winner,0);assert.equal(mo.name,'Ann');
    assert.deepEqual(a.msgs.filter(m=>m.t==='player_left').map(m=>[m.slot,m.reason]),[[1,'left'],[2,'timeout']]);
    assert.equal(a.game.winner.name,'Ann');assert.ok(a.game.teams[1].worms.every(w=>w.dead)&&a.game.teams[2].worms.every(w=>w.dead));
    await until(()=>a.msgs.some(m=>m.t==='lobby'&&m.state==='lobby'&&a.msgs.indexOf(m)>a.msgs.indexOf(mo)),8000,'back to lobby');
    const lobby=[...a.msgs].reverse().find(m=>m.t==='lobby');
    assert.deepEqual(lobby.players.map(p=>p.name),['Ann']);assert.deepEqual(lobby.spectators.map(s=>s.name),['V']);
    // a and the spectator agree with each other and with an offline replay of the server log
    const last=Math.max(...a.trace.keys()),off=replay(log.seed,log.names,log.inputs,last);
    off.trace.forEach((h,i)=>{const f=(i+1)*60;assert.equal(a.trace.get(f),h,'a vs replay at '+f);if(v.trace.has(f))assert.equal(v.trace.get(f),h,'v vs replay at '+f)});
  }finally{all.forEach(x=>{try{x.stop()}catch{}});await srv.close()}
});
