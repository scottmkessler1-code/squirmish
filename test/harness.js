// Shared helpers for the determinism tests: a scripted bot that records inputs, and a replayer.
const {createGame}=require('../public/game.js');

const mulberry=s=>()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296};
const TRACE_EVERY=60;

// Plays a whole match with a seeded bot and returns the recorded input script and the hash trace.
// The bot reads game state to decide, but only ever talks to the game through submitInput,
// so the script alone is enough to reproduce the match.
function record(seed,names,maxFrames=40000){
  const g=createGame(),R=mulberry(seed^0x2545F491),script=[],trace=[];
  const at=(f,p,k,d)=>{const ev={f,p,k,d};script.push(ev);g.submitInput(ev)};
  const tap=(f,p,k)=>{at(f,p,k,true);at(f+1,p,k,false)};
  const hold=(f,p,k,n)=>{at(f,p,k,true);at(f+n,p,k,false);return f+n+1};
  g.startGame(names,seed);
  let turnKey='',over=0;
  while(g.frame<maxFrames&&over<200){
    if(g.phase==='aim'){
      const p=g.cur,t=g.teams[p],key=p+':'+t.turns;
      if(key!==turnKey){turnKey=key;let f=g.frame+1+Math.floor(R()*20);
        if(R()>.08){ // 8% of turns the bot idles and lets the timer run out
          const avail=[1,2,3,4,5].filter(i=>t.ammo[i]>0);
          if(avail.length&&R()<.85){tap(f,p,String(avail[Math.floor(R()*avail.length)]));f+=3}
          if(R()<.7)f=hold(f,p,R()<.5?'ArrowLeft':'ArrowRight',Math.floor(R()*100));
          if(R()<.2){tap(f,p,'Enter');f+=70}
          if(R()<.8)f=hold(f,p,R()<.6?'ArrowUp':'ArrowDown',Math.floor(R()*45));
          hold(f,p,' ',10+Math.floor(R()*75));
        }
      }
    }
    // noise from the wrong team and stray keys: must be ignored identically everywhere
    if(R()<.004){const p=Math.floor(R()*names.length);at(g.frame+1,p,['ArrowLeft',' ','3','Enter'][Math.floor(R()*4)],R()<.5)}
    g.update();
    if(g.frame%TRACE_EVERY===0)trace.push(g.stateHash());
    if(g.phase==='over')over++;
  }
  return {script,trace,frames:g.frame,summary:summarize(g)};
}

// Builds a fresh game, feeds it the script, and runs the same number of frames.
function replay(seed,names,script,frames,opts={}){
  const g=createGame(),trace=[];
  script=[...script].sort((a,b)=>a.f-b.f); // stable, so same-frame events keep their order
  g.startGame(names,seed);
  // incremental: deliver events in small batches a few frames ahead, the way server step messages will
  let next=0;const lead=opts.incremental?6:Infinity;
  const feed=()=>{while(next<script.length&&script[next].f<=g.frame+lead)g.submitInput({...script[next++]})};
  feed();
  while(g.frame<frames){if(opts.incremental&&g.frame%3===0)feed();g.update();if(g.frame%TRACE_EVERY===0)trace.push(g.stateHash())}
  return {trace,summary:summarize(g)};
}
function summarize(g){
  return {phase:g.phase,winner:g.winner&&g.winner.name,turns:g.teams.reduce((s,t)=>s+t.turns,0),
    hpLeft:g.worms.map(w=>Math.max(0,w.hp)),terrain:g.terrainHash>>>0};
}
module.exports={record,replay,TRACE_EVERY,createGame};
