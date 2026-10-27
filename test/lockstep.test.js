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
  const all=[a,b,c,v];let log=null,mo=null,last=0;
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
  // play it out
  // bots can run out of ammo and stall into very long endgames; past a cap we still check sync, just not the lobby return
  await until(()=>all.every(x=>x.msgs.some(m=>m.t==='match_over'))||a.game.frame>=40000,90000,'match over');
  clearInterval(keepLog);
  mo=a.msgs.find(m=>m.t==='match_over');
  if(mo)await until(()=>all.every(x=>x.msgs.some(m=>m.t==='lobby'&&m.state==='lobby'&&x.msgs.indexOf(m)>x.msgs.indexOf(x.msgs.find(q=>q.t==='match_over')))),10000,'back to lobby');
  }finally{all.forEach(x=>x.stop());await srv.close()}

  for(const x of all)assert.deepEqual(x.desyncs,[],'client '+x.name+' received inputs for frames it had already run');
  // every client agrees on every frame they both saw, and the late joiner and reconnector saw it from frame 0
  const ref=a.trace;last=Math.max(...ref.keys());
  for(const x of [b,c,v]){
    let n=0;for(const [f,h] of x.trace)if(ref.has(f)){if(h!==ref.get(f))assert.fail(`client ${x.name} (connection ${x.conn}) desync at frame ${f}: ${h} vs a ${ref.get(f)}, offline replay ${replay(log.seed,log.names,log.inputs,f).trace.at(-1)}`);n++}
    assert.ok(n>=last/60-2,'too few common samples: '+n);
  }
  // and the online match is exactly the offline replay of the server's input log
  const off=replay(log.seed,log.names,log.inputs,last);
  off.trace.forEach((h,i)=>assert.equal(h,ref.get((i+1)*60),'offline replay differs at frame '+(i+1)*60));
  if(mo)assert.equal(mo.winner,a.game.teams.indexOf(a.game.winner));
  console.log(`  ${last} frames, ${log.inputs.length} inputs, ${mo?'winner '+mo.name:'no winner by the frame cap'}, stall messages ${a.msgs.filter(m=>m.t==='stall').length}`);
});
