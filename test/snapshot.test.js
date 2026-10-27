// Snapshots: a game rebuilt from getSnapshot() (through JSON, as on the wire) must continue exactly like the original.
const test=require('node:test'),assert=require('node:assert/strict');
const {record}=require('./harness');
const {createGame}=require('../public/game.js');

function continuesIdentically(seed,names,script,frames,at){
  const a=createGame();a.startGame(names,seed);
  const sorted=[...script].sort((x,y)=>x.f-y.f);
  sorted.forEach(e=>a.submitInput({...e}));
  while(a.frame<at)a.update();
  const json=JSON.stringify(a.getSnapshot());
  const b=createGame();b.preview(99); // b starts from an unrelated state
  b.loadSnapshot(JSON.parse(json));
  sorted.filter(e=>e.f>at).forEach(e=>b.submitInput({...e}));
  assert.equal(b.stateHash(),a.stateHash(),`hash right after loading at frame ${at}`);
  assert.equal(b.frame,at);
  while(a.frame<frames){a.update();b.update();if(a.frame%10===0)assert.equal(b.stateHash(),a.stateHash(),`diverged at frame ${a.frame} after loading at ${at}`)}
  assert.equal(b.phase,a.phase);assert.equal(b.winner&&b.winner.name,a.winner&&a.winner.name);
  return json.length;
}

for(const [seed,names] of [[1,['Ann','Bo']],[424242,['A','B','C','D']],[7,['A','B','C','D','E','F']]]){
  test(`seed ${seed}: loading a snapshot at many points continues identically`,()=>{
    const r=record(seed,names);
    // early, mid-turn, during flights and explosions, and right at the end
    const points=[0,1,59,60,61,333,1000,1777,2500,r.frames-500,r.frames-2];
    let s=seed;for(let i=0;i<12;i++){s=(s*1103515245+12345)>>>0;points.push(1+s%(r.frames-2))}
    let maxLen=0;
    for(const at of points)maxLen=Math.max(maxLen,continuesIdentically(seed,names,r.script,Math.min(r.frames,at+3000),at));
    assert.ok(maxLen<200_000,'snapshot too big: '+maxLen);
    console.log(`  seed ${seed}: ${points.length} load points, largest snapshot ${(maxLen/1024).toFixed(1)} KB`);
  });
}

test('a snapshot survives -0 and keeps queued-input semantics',()=>{
  const g=createGame();g.startGame(['A','B'],5);
  for(let i=0;i<200;i++)g.update();
  g.worms[0].vx=-0;
  const s=JSON.parse(JSON.stringify(g.getSnapshot()));
  const h=createGame();h.loadSnapshot(s);
  assert.ok(Object.is(h.worms[0].vx,-0));
  // inputs queued before the load are dropped
  h.submitInput({f:h.frame+1,p:h.cur,k:'ArrowLeft',d:true});h.loadSnapshot(s);h.update();
  g.update();assert.equal(h.stateHash(),g.stateHash());
});

test('loading rejects unknown versions and corrupt terrain',()=>{
  const g=createGame();g.startGame(['A','B'],5);const s=g.getSnapshot();
  assert.throws(()=>createGame().loadSnapshot({...s,v:2}));
  assert.throws(()=>createGame().loadSnapshot({...s,mask:[5,5]}));
});
