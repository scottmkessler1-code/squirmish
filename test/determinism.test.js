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
