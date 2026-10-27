// Headless determinism test: same seed + same inputs must give the same stateHash() trace, every time, everywhere.
const test=require('node:test'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const {record,replay,createGame}=require('./harness');
const {dsin,dcos,datan2,dhypot}=require('../public/game.js');

const CASES=[
  {seed:1,names:['Ann','Bo']},
  {seed:0xC0FFEE,names:['A','B','C']},
  {seed:424242,names:['A','B','C','D']},
  {seed:3141592653,names:['A','B','C','D','E']},
  {seed:7,names:['A','B','C','D','E','F']},
];
const firstDiff=(a,b)=>{for(let i=0;i<Math.max(a.length,b.length);i++)if(a[i]!==b[i])return i;return -1};
const runs=new Map(CASES.map(c=>[c.seed,record(c.seed,c.names)]));

test('deterministic math helpers match Math closely',()=>{
  let e=0;
  for(let x=-60;x<60;x+=.0137){e=Math.max(e,Math.abs(dsin(x)-Math.sin(x)),Math.abs(dcos(x)-Math.cos(x)))}
  for(let i=0;i<20000;i++){const y=Math.sin(i*1.7)*(i%50),x=Math.cos(i*2.3)*(i%37);e=Math.max(e,Math.abs(datan2(y,x)-Math.atan2(y,x)),Math.abs(dhypot(x,y)-Math.hypot(x,y))/(1+Math.hypot(x,y)))}
  assert.ok(e<1e-8,'max error '+e);
  for(const [y,x] of [[0,-1],[-0,-1],[0,0],[-0,0],[0,-0],[-0,-0]])assert.equal(datan2(y,x),Math.atan2(y,x),`datan2(${y},${x})`);
});

for(const c of CASES){
  test(`seed ${c.seed}, ${c.names.length} teams: replays match the recorded trace`,()=>{
    const r=runs.get(c.seed);
    // the bot must actually have played: several turns, damage dealt, terrain blown up
    const fresh=createGame();fresh.startGame(c.names,c.seed);
    assert.ok(r.summary.turns>=6,'turns '+r.summary.turns);
    assert.ok(r.summary.hpLeft.reduce((a,b)=>a+b,0)<c.names.length*200,'no damage dealt');
    assert.notEqual(r.summary.terrain,fresh.terrainHash>>>0,'terrain never changed');
    for(const opts of [{},{incremental:true}]){
      const p=replay(c.seed,c.names,r.script,r.frames,opts);
      assert.equal(firstDiff(r.trace,p.trace),-1,`trace diverged at sample ${firstDiff(r.trace,p.trace)} (${JSON.stringify(opts)})`);
      assert.deepEqual(p.summary,r.summary);
    }
    const out=JSON.parse(execFileSync(process.execPath,[__dirname+'/replay-child.js'],{input:JSON.stringify({...c,script:r.script,frames:r.frames})}));
    assert.equal(firstDiff(r.trace,out.trace),-1,'separate process diverged at sample '+firstDiff(r.trace,out.trace));
  });
}

test('a different seed gives a different match',()=>{
  const c=CASES[0],r=runs.get(c.seed),o=replay(c.seed+1,c.names,r.script,r.frames);
  assert.notEqual(o.trace[0],r.trace[0]);
});

test('changing one input changes the match from that point on, not before',()=>{
  const c=CASES[1],r=runs.get(c.seed);
  const i=r.script.findIndex(e=>e.k==='ArrowUp'&&e.d&&e.f>600);
  const s=r.script.map(e=>({...e}));s[i+1].f+=20; // hold "aim up" 20 frames longer
  const p=replay(c.seed,c.names,s,r.frames),d=firstDiff(r.trace,p.trace);
  assert.ok(d>=0,'perturbed input had no effect');
  assert.ok(d*60>=s[i].f-60,'diverged before the changed input');
});

test('inputs stamped for the wrong team are ignored',()=>{
  const c=CASES[0],r=runs.get(c.seed);
  const junk=[];for(let f=1;f<r.frames;f+=37)junk.push({f,p:-1,k:' ',d:f%2===0},{f,p:99,k:'ArrowLeft',d:true});
  const p=replay(c.seed,c.names,[...r.script,...junk],r.frames);
  assert.equal(firstDiff(r.trace,p.trace),-1);
});

test('two games stepped side by side in one process do not interfere',()=>{
  const a=CASES[2],b=CASES[3],ra=runs.get(a.seed),rb=runs.get(b.seed);
  const ga=createGame(),gb=createGame();ga.startGame(a.names,a.seed);gb.startGame(b.names,b.seed);
  ra.script.forEach(e=>ga.submitInput({...e}));rb.script.forEach(e=>gb.submitInput({...e}));
  const ta=[],tb=[];
  for(let f=1;f<=Math.max(ra.frames,rb.frames);f++){
    if(f<=ra.frames){ga.update();if(ga.frame%60===0)ta.push(ga.stateHash())}
    if(f<=rb.frames){gb.update();if(gb.frame%60===0)tb.push(gb.stateHash())}
  }
  assert.equal(firstDiff(ra.trace,ta),-1);assert.equal(firstDiff(rb.trace,tb),-1);
});

test('summary of recorded matches',()=>{
  for(const c of CASES){const r=runs.get(c.seed);
    console.log(`  seed ${c.seed}: ${c.names.length} teams, ${r.frames} frames, ${r.summary.turns} turns, ${r.script.length} inputs, ${r.summary.phase==='over'?'won by '+r.summary.winner:'unfinished'}`)}
});

test('forfeit: knocks a team out at once, on or off its turn, and the last team standing wins',()=>{
  const g=createGame();g.startGame(['A','B','C'],99);
  while(g.phase!=='aim')g.update();
  const turn=g.cur,other=(turn+1)%3;
  g.submitInput({f:g.frame+1,p:other,k:'forfeit',d:true});g.update();
  assert.ok(g.teams[other].worms.every(w=>w.dead),'off-turn team not out');
  assert.equal(g.cur,turn);assert.equal(g.phase,'aim','current turn interrupted');
  g.submitInput({f:g.frame+1,p:turn,k:'forfeit',d:true});g.update();
  assert.equal(g.phase,'wait','forfeiting team kept its turn');
  for(let i=0;i<200&&g.phase!=='over';i++)g.update();
  assert.equal(g.phase,'over');assert.equal(g.winner,g.teams[3-turn-other]);
});

test('forfeit: when it leaves one team, the current turn ends right away',()=>{
  const g=createGame();g.startGame(['A','B'],99);
  while(g.phase!=='aim')g.update();
  const t0=g.frame;g.submitInput({f:g.frame+1,p:1-g.cur,k:'forfeit',d:true});
  while(g.phase!=='over'&&g.frame<t0+600)g.update();
  assert.equal(g.phase,'over');assert.ok(g.frame-t0<150,'took '+(g.frame-t0)+' frames');
});

test('forfeits replay identically',()=>{
  const c=CASES[3],r=runs.get(c.seed);
  const s=[...r.script,{f:900,p:1,k:'forfeit',d:true},{f:2000,p:3,k:'forfeit',d:true}];
  const a=replay(c.seed,c.names,s,r.frames),b=replay(c.seed,c.names,s,r.frames,{incremental:true});
  assert.equal(firstDiff(a.trace,b.trace),-1);
  assert.notEqual(firstDiff(a.trace,r.trace),-1,'forfeits had no effect');
});

test('cluster: bursts on hitting a worm and hurts it, then its bomblets go off',()=>{
  const g=createGame();g.startGame(['A','B'],99);
  while(g.phase!=='aim')g.update();
  const me=g.active(),foe=g.worms.find(w=>w.team!==me.team&&!w.dead);
  // put an enemy right in front, on the same footing, and fire the cluster flat with a little power
  foe.x=me.x+me.dir*30;foe.y=me.y;foe.air=true;
  for(let i=0;i<60;i++)g.update();
  const hp=foe.hp,f=g.frame;
  for(const e of [[1,'2',true],[2,'2',false],[3,'ArrowDown',true],[23,'ArrowDown',false],[24,' ',true],[34,' ',false]])g.submitInput({f:f+e[0],p:g.cur,k:e[1],d:e[2]});
  let burst=false;
  for(let i=0;i<400;i++){g.update();if(foe.hp<hp&&!burst)burst=g.frame-f}
  assert.ok(burst&&burst<80,'cluster did not hurt the worm on contact');
  assert.ok(hp-Math.max(0,foe.hp)>=15,'only '+(hp-foe.hp)+' damage');
});

// fires the current weapon key after optional setup; returns the game and the shooter
function shootWith(key,charge,extra=[]){
  const g=createGame();g.startGame(['A','B'],99);
  while(g.phase!=='aim')g.update();
  const me=g.active(),f=g.frame,p=g.cur;
  for(const [df,k,d] of [[1,key,true],[2,key,false],[3,'ArrowUp',true],[13,'ArrowUp',false],[14,' ',true],[14+charge,' ',false],...extra])g.submitInput({f:f+df,p,k,d});
  return {g,me,f,p};
}
test('dynamite: a tap drops it close, a long charge throws it far',()=>{
  // where the dynamite is just before its 5 s fuse runs out, measured from the thrower
  const land=charge=>{const {g,me,f}=shootWith('4',charge);let last=null;
    while(g.frame<f+14+charge+290){g.update();const d=g.getSnapshot().projs.find(p=>p.t===4);if(d)last=d}
    return Math.abs(last.x-me.x);
  };
  const tap=land(1),thrown=land(60);
  assert.ok(tap<60,'tapped dynamite landed '+tap+' px away');
  assert.ok(thrown>tap+100,`thrown ${thrown} px vs tapped ${tap} px`);
});
test('retreat: after firing the worm can walk for 3 s, then the turn ends',()=>{
  // shotgun fires instantly; then hold Right for 5 s
  const {g,me,f,p}=shootWith('3',1,[[30,'ArrowRight',true],[330,'ArrowRight',false]]);
  const pos=[];let turnEnded=0;
  while(g.frame<f+600){g.update();pos.push(me.x);if(!turnEnded&&g.cur!==p)turnEnded=g.frame-f}
  const fired=14,moved=(a,b)=>Math.abs(pos[b]-pos[a])>3;
  assert.ok(moved(fired+20,fired+150),'could not walk after firing');
  assert.ok(!moved(fired+200,fired+300),'kept walking after the retreat time');
  assert.ok(turnEnded>=fired+179,'turn ended before the retreat time was over ('+turnEnded+')');
  // and a snapshot taken mid-retreat carries it over
  const {g:a}=shootWith('3',1,[[30,'ArrowRight',true],[330,'ArrowRight',false]]);
  while(a.frame<f+80)a.update();
  const b=createGame();b.loadSnapshot(JSON.parse(JSON.stringify(a.getSnapshot())));
  b.submitInput({f:f+330,p,k:'ArrowRight',d:false});
  for(let i=0;i<300;i++){a.update();b.update();assert.equal(b.stateHash(),a.stateHash())}
});

test('a random team starts each match, and it is the same on every client',()=>{
  const firsts=n=>{const seen=new Map();
    for(let seed=1;seed<=300;seed++){const g=createGame();g.startGame(Array.from({length:n},(_,i)=>'T'+i),seed);
      while(g.phase!=='aim')g.update();
      const again=createGame();again.startGame(Array.from({length:n},(_,i)=>'T'+i),seed);while(again.phase!=='aim')again.update();
      assert.equal(again.cur,g.cur,'same seed, different first team');
      assert.equal(g.teams[g.cur].turns,1,'first team skipped a worm');assert.ok(g.teams.every((t,i)=>i===g.cur||t.turns===0));
      seen.set(g.cur,(seen.get(g.cur)||0)+1)}
    return seen};
  for(const n of [2,3,6]){const s=firsts(n);
    assert.equal(s.size,n,`with ${n} teams only teams ${[...s.keys()]} ever started`);
    for(const [t,c] of s)assert.ok(c>300/n*0.5,`team ${t} started only ${c} of 300 matches`)}
});

test('every worm starts the first turn on 100 health, and a turn lasts 15 s',()=>{
  for(const seed of [1,7,99,424242,3141592653]){
    const g=createGame();g.startGame(['A','B','C','D','E','F'],seed);
    while(g.phase!=='aim')g.update();
    assert.deepEqual(g.worms.map(w=>w.hp),Array(12).fill(100),'seed '+seed);
    const f=g.frame,p=g.cur;while(g.cur===p&&g.frame<f+2000)g.update(); // nobody moves: the timer runs out
    assert.ok(g.frame-f>=900&&g.frame-f<900+200,'turn lasted '+(g.frame-f)+' frames');
  }
});

test('each team starts its turn with the weapon it used last, not the previous player’s',()=>{
  const g=createGame();g.startGame(['A','B','C'],5);
  const turn=key=>{while(g.phase!=='aim')g.update();const p=g.cur,f=g.frame;
    if(key){g.submitInput({f:f+1,p,k:key,d:true});g.submitInput({f:f+2,p,k:key,d:false})}
    g.submitInput({f:f+3,p,k:' ',d:true});g.submitInput({f:f+20,p,k:' ',d:false}); // fire (or punch)
    while(g.cur===p||g.phase!=='aim')g.update();return p};
  const first=turn('3'),second=turn('6');turn('2'); // shotgun, punch, cluster
  while(g.cur!==first)turn(null);
  assert.equal(g.weapon,3,'first team should be back on its shotgun');
  turn(null);while(g.cur!==second)turn(null);
  assert.equal(g.weapon,0,'second team should be back on punch');
  // out of ammo: falls back to the first weapon that has some
  const h=createGame();h.startGame(['A','B'],5);while(h.phase!=='aim')h.update();
  const p=h.cur;h.submitInput({f:h.frame+1,p,k:'5',d:true});h.update();
  h.teams[p].ammo[5]=0; // the airstrike is gone by the time their turn comes round again
  while(h.cur===p)h.update();while(h.cur!==p||h.phase!=='aim')h.update();
  assert.equal(h.weapon,1);
});
