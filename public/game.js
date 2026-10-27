// Caterpillar Continental Combat: simulation + rendering in one factory.
// The simulation runs anywhere (browser or Node); rendering only runs when a document and 2D context are passed in.
// Rule of thumb: anything that affects stateHash() must come from rng(), the input queue, or the d* math helpers below.
(function(root){
'use strict';
const W=960,H=540,WATER=H-26,COLORS=['#ef476f','#ffd166','#06d6a0','#4cc9f0','#b388eb','#ff9f1c'];
const WEAPONS=[{n:'Punch'},{n:'Rocket',r:34,d:45},{n:'Cluster',r:24,d:30},{n:'Shotgun'},{n:'Dynamite',r:55,d:75},{n:'Airstrike',r:28,d:30},{n:'Bomblet',r:18,d:24}];
const ROCKETY=t=>t===1||t===5;            // drawn as rockets, leave a smoke trail
const IMPACT=t=>t===1||t===2||t===5;       // explode on hitting ground or a worm (the rest bounce until their fuse runs out)
const GAMEKEYS=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Enter','1','2','3','4','5','6'];
const ORDER=[1,2,3,4,5,0]; // weapon for keys 1..6; Punch (0) has unlimited ammo
const PHASES=['menu','wait','aim','over'];

// deterministic math: built only from + - * / and Math.sqrt/round, which IEEE 754 pins down exactly,
// so every browser gets bit-identical results (Math.sin/cos/atan2/hypot are allowed to differ between engines)
const PI=3.141592653589793,TAU=2*PI,HPI=PI/2,T8=0.41421356237309503;
const SINC=[1,-1/6,1/120,-1/5040,1/362880,-1/39916800,1/6227020800];
const ATNC=Array.from({length:12},(_,n)=>(n&1?-1:1)/(2*n+1));
function dsin(x){
  x-=Math.round(x/TAU)*TAU;if(x>HPI)x=PI-x;else if(x<-HPI)x=-PI-x;
  const z=x*x;let s=0;for(let i=SINC.length-1;i>=0;i--)s=SINC[i]+z*s;return x*s;
}
const dcos=x=>dsin(x+HPI);
function datan(t){ // 0<=t<=1
  let off=0;if(t>T8){t=(t-1)/(t+1);off=PI/4}
  const z=t*t;let s=0;for(let i=ATNC.length-1;i>=0;i--)s=ATNC[i]+z*s;return off+t*s;
}
function datan2(y,x){
  if(x===0&&y===0){const a=1/x<0?PI:0;return 1/y<0?-a:a} // signed zeros, as Math.atan2
  const ax=Math.abs(x),ay=Math.abs(y);let a=ay<=ax?datan(ay/ax):HPI-datan(ax/ay);
  if(x<0)a=PI-a;return y<0||1/y<0?-a:a; // 1/y<0 catches -0, like Math.atan2
}
const dhypot=(x,y)=>Math.sqrt(x*x+y*y);
// mulberry32 as a standalone generator, for visual-only randomness that should still look the same for everyone
function rngFrom(s){s|=0;return()=>{s=(s+0x6D2B79F5)|0;let t=Math.imul(s^(s>>>15),1|s);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}}

function createGame(env={}){
let overHint=env.overHint||'Press New game to play again';
const doc=env.document||null,g=env.ctx||null,sfx=env.sfx||(()=>{}),DEBUG=!!env.debug,INPUT_DELAY=env.inputDelay||0;
const dot=(x,y,r,c)=>{g.fillStyle=c;g.beginPath();g.arc(x,y,r,0,7);g.fill()};

// terrain: `mask` (1 = solid) is the gameplay truth. The canvas `tc` is only its picture, because canvas
// anti-aliasing differs between browsers and would desync collision if we read pixels back.
const mask=new Uint8Array(W*H);let thash=0,tdirty=true;
let tc=null,tg=null,bgc=null,bg=null;
if(doc){tc=doc.createElement('canvas');tc.width=W;tc.height=H;tg=tc.getContext('2d');bgc=doc.createElement('canvas');bgc.width=W;bgc.height=H;bg=bgc.getContext('2d')}
const solid=(x,y)=>{x=Math.floor(x);y=Math.floor(y);return x>=0&&x<W&&y>=0&&y<H&&mask[y*W+x]===1};
const blocked=(x,y)=>{for(const dx of[-4,0,4])for(const dy of[-3,-8,-12])if(solid(x+dx,y+dy))return true;return false};
const ground=(x,y)=>[-3,0,3].some(dx=>solid(x+dx,y+1));
// resting = feet on ground, or the body can't move down (a sliver under the body's wider x±4 probes used to wedge worms in mid-air forever)
const resting=(x,y)=>ground(x,y)||blocked(x,y+1);
function carve(cx,cy,r){
  const x0=Math.max(0,Math.floor(cx-r)),x1=Math.min(W-1,Math.ceil(cx+r)),y0=Math.max(0,Math.floor(cy-r)),y1=Math.min(H-1,Math.ceil(cy+r)),r2=r*r;
  for(let y=y0;y<=y1;y++){const dy=y+.5-cy;for(let x=x0;x<=x1;x++){const dx=x+.5-cx;if(dx*dx+dy*dy<=r2)mask[y*W+x]=0}}
  tdirty=true;
}
function terrainHash(){if(tdirty){let h=0;for(let i=0;i<mask.length;i++)h=(Math.imul(h,31)+mask[i])|0;thash=h;tdirty=false}return thash}

let teams=[],worms=[],projs=[],parts=[],cur=-1,phase='menu',timer=0,wind=0,weapon=1,power=0,charging=false,aim=.5,winner=null,settle=0,waitT=0,tick=0;
const keys={};
// seeded RNG: all gameplay randomness uses rng() so every computer can build the same match from one seed
let rs=1,curSeed=1;
const setSeed=s=>{curSeed=s>>>0;rs=curSeed||1};
function rng(){rs=(rs+0x6D2B79F5)|0;let t=Math.imul(rs^(rs>>>15),1|rs);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296}
function shuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
let crates=[],toast='',toastT=0,rings=[],shake=0,frame=0,inputQ=[];
// input events: {f:frame to apply, p:team index, k:key, d:down?}. Local play queues them directly; online play will send them through the server instead.
function submitInput(ev){inputQ.push(ev);inputQ.sort((a,b)=>a.f-b.f)}
function sendInput(k,d){submitInput({f:frame+INPUT_DELAY,p:cur,k,d})}
function applyInput(ev){
  // forfeit comes only from the server (a player left or never came back): that team is out at once, turn or not
  if(ev.k==='forfeit'){
    if(phase==='menu'||!teams[ev.p])return;
    for(const w of teams[ev.p].worms)if(!w.dead)w.hp=0;
    // nobody left to fight: end the turn now so the result shows in a moment, not when the timer runs out
    if(phase==='aim'&&teams.filter(t=>t.worms.some(w=>w.hp>0)).length<2){charging=false;phase='wait';settle=0}
    return;
  }
  if(ev.p!==cur||phase==='menu')return;
  const k=ev.k,w=active();
  if(!ev.d){keys[k]=false;if(k===' '&&charging&&phase==='aim')fire();return}
  keys[k]=true;
  if(phase!=='aim'||!w)return;
  if(k.length===1&&k>='1'&&k<='6'){if(!charging)weapon=ORDER[+k-1]}
  else if(k==='Enter'){if(!w.air&&!charging){w.air=true;w.vy=-2.8;w.vx=w.dir*1.6;w.y-=1;sfx('jump')}}
  else if(k===' '){if(!charging&&(weapon===0||w.team.ammo[weapon]>0)){if(weapon<1||weapon===3||weapon===4)fire();else{charging=true;power=0}}}
}
function stateHash(){
  let h=terrainHash()|0;const m=v=>{h=(Math.imul(h,31)+Math.round(v*1000))|0};
  for(const w of worms){m(w.x);m(w.y);m(w.vx);m(w.vy);m(w.hp);m(w.dead?1:0);m(w.dir);m(w.air?1:0)}
  for(const p of projs){m(p.x);m(p.y);m(p.vx);m(p.vy);m(p.t);m(p.fuse)}
  for(const c of crates){m(c.x);m(c.y)}
  teams.forEach(t=>{t.ammo.forEach(m);m(t.turns)});m(cur);m(timer);m(frame);
  m(PHASES.indexOf(phase));m(weapon);m(aim);m(power);m(charging?1:0);m(settle);m(waitT);m(wind);m(rs/1000);
  for(const k of GAMEKEYS)m(keys[k]?1:0);
  return h>>>0;
}

const PAL=[{t:'#4aa8dc',b:'#e1f5f2',s:'#fff3b0',h1:'#9fd0c9',h2:'#6fb3a5',c:'#ffffff'},{t:'#5b4b9a',b:'#ffb26b',s:'#ffe29a',h1:'#b57a9a',h2:'#7d5a85',c:'#ffd8c2'},{t:'#0f2a4a',b:'#3b6fa0',s:'#f4f1de',h1:'#2d4f73',h2:'#1f3a5a',c:'#9ab4d0'}];
let pal=PAL[0];
const clouds=Array.from({length:6},()=>({x:Math.random()*W,y:30+Math.random()*130,s:.7+Math.random()*.9,v:.08+Math.random()*.2}));
const birds=Array.from({length:4},()=>({x:Math.random()*W,y:50+Math.random()*120,v:.5+Math.random()*.5}));
function makeBg(R){
  pal=PAL[Math.floor(R()*3)];
  const gr=bg.createLinearGradient(0,0,0,H);gr.addColorStop(0,pal.t);gr.addColorStop(.75,pal.b);bg.fillStyle=gr;bg.fillRect(0,0,W,H);
  if(pal===PAL[2])for(let i=0;i<70;i++){bg.fillStyle='rgba(255,255,255,'+(.3+R()*.6)+')';bg.fillRect(R()*W,R()*H*.45,1.5,1.5)}
  const sx=100+R()*760,sy=70+R()*50,rg=bg.createRadialGradient(sx,sy,5,sx,sy,130);
  rg.addColorStop(0,'rgba(255,255,230,.9)');rg.addColorStop(1,'rgba(255,255,230,0)');bg.fillStyle=rg;bg.fillRect(0,0,W,H);
  bg.fillStyle=pal.s;bg.beginPath();bg.arc(sx,sy,26,0,7);bg.fill();
  const hill=(base,amp,f,ph)=>x=>H*base+Math.sin(x*f+ph)*amp+Math.sin(x*f*3.1+ph)*amp*.3;
  [[pal.h1,hill(.58,60,.006,R()*9)],[pal.h2,hill(.66,40,.011,R()*9)]].forEach(([c,fn],li)=>{
    bg.fillStyle=c;bg.beginPath();bg.moveTo(0,H);for(let x=0;x<=W;x+=8)bg.lineTo(x,fn(x));bg.lineTo(W,H);bg.fill();
    if(li===1)for(let x=10;x<W;x+=16+R()*26){const y=fn(x),hh=16+R()*16;bg.fillStyle='rgba(10,30,25,.28)';bg.beginPath();bg.moveTo(x,y-hh);bg.lineTo(x-6,y+2);bg.lineTo(x+6,y+2);bg.fill()}});
}
function drawSky(){
  g.fillStyle=pal.c;g.globalAlpha=.8;
  for(const c of clouds){c.x+=wind*2.2*(.6+c.v*2.5);if(c.x>W+80)c.x=-80;if(c.x<-80)c.x=W+80;
    {const L=Math.abs(wind)*50*c.s,sg=Math.sign(wind),sx=c.x+20*c.s-sg*38*c.s;g.strokeStyle=pal.c;g.lineWidth=2;g.globalAlpha=.4;
      for(let k=0;k<3;k++){g.beginPath();g.moveTo(sx,c.y+(k-1)*9*c.s);g.lineTo(sx-sg*L,c.y+(k-1)*9*c.s);g.stroke()}g.globalAlpha=.8}
    for(const [dx,dy,r] of [[0,0,16],[18,-6,20],[40,0,15],[20,6,16]]){g.beginPath();g.arc(c.x+dx*c.s,c.y+dy*c.s,r*c.s,0,7);g.fill()}}
  g.globalAlpha=1;g.strokeStyle='rgba(30,40,50,.55)';g.lineWidth=1.5;
  birds.forEach((b,i)=>{b.x+=b.v;if(b.x>W+20)b.x=-20;const f=Math.sin(tick/6+i*2)*3.5;g.beginPath();g.moveTo(b.x-6,b.y+f);g.lineTo(b.x,b.y);g.lineTo(b.x+6,b.y+f);g.stroke()});
}
function genTerrain(){
  mask.fill(0);
  const p=[rng()*6,rng()*6,rng()*6],hs=new Float64Array(W),caves=[];
  for(let x=0;x<W;x++)hs[x]=H*.5+dsin(x/140+p[0])*50+dsin(x/53+p[1])*24+dsin(x/23+p[2])*7;
  // solid from just above the surface line, where the painted grass edge sits
  for(let x=0;x<W;x++)for(let y=Math.max(0,Math.ceil(hs[x]-3));y<H;y++)mask[y*W+x]=1;
  for(let i=0;i<8;i++){const x=rng()*W,y=hs[Math.floor(x)]+40+rng()*90,r=14+rng()*18;caves.push([x,y,r]);carve(x,y,r)}
  tdirty=true;
  if(tg){paintTerrain(hs,caves,rngFrom(curSeed^0x5eed));makeBg(rngFrom(curSeed^0xb6))}
}
// decoration only: seeded so everyone sees the same landscape, but from its own generator so it never touches rs
function paintTerrain(hs,caves,R){
  tg.clearRect(0,0,W,H);
  const gr=tg.createLinearGradient(0,H*.4,0,H);gr.addColorStop(0,'#8c5b3b');gr.addColorStop(1,'#46302c');
  tg.fillStyle=gr;tg.beginPath();tg.moveTo(0,H);for(let x=0;x<W;x++)tg.lineTo(x,hs[x]);tg.lineTo(W,H);tg.fill();
  tg.globalCompositeOperation='source-atop';
  for(let i=0;i<1400;i++){const x=R()*W,y=H*.35+R()*H*.65;tg.fillStyle=R()<.5?'rgba(40,22,14,.28)':'rgba(255,220,170,.14)';tg.beginPath();tg.arc(x,y,.8+R()*2.6,0,7);tg.fill()}
  for(let i=0;i<45;i++){const x=R()*W,t=hs[Math.floor(x)],y=t+20+R()*(H-t-30);tg.fillStyle='#8f8a85';tg.strokeStyle='#5b5753';tg.lineWidth=1;tg.beginPath();tg.ellipse(x,y,5+R()*7,3+R()*4,R()*3,0,7);tg.fill();tg.stroke()}
  tg.globalCompositeOperation='source-over';
  tg.strokeStyle='#3f8f33';tg.lineWidth=9;tg.beginPath();tg.moveTo(0,hs[0]+1);for(let x=1;x<W;x++)tg.lineTo(x,hs[x]+1);tg.stroke();
  tg.strokeStyle='#6ccf55';tg.lineWidth=5;tg.beginPath();tg.moveTo(0,hs[0]);for(let x=1;x<W;x++)tg.lineTo(x,hs[x]);tg.stroke();
  for(let x=0;x<W;x+=2){tg.strokeStyle=R()<.5?'#7ddb5f':'#58b043';tg.lineWidth=1.3;tg.beginPath();tg.moveTo(x,hs[x]-1);tg.lineTo(x+(R()-.5)*3,hs[x]-1-R()*3);tg.stroke()}
  for(let i=0;i<28;i++){const x=Math.floor(R()*W);tg.fillStyle=['#ff7aa2','#ffe066','#fff','#c77dff'][i%4];tg.beginPath();tg.arc(x,hs[x]-3.5,1.7,0,7);tg.fill()}
  tg.globalCompositeOperation='destination-out';
  for(const [x,y,r] of caves){tg.beginPath();tg.arc(x,y,r,0,7);tg.fill()}
  tg.globalCompositeOperation='source-over';
}
// terrain for the menu backdrop
function preview(seed){setSeed(seed);genTerrain()}

// ---- snapshots: the complete simulation state as plain JSON, for resyncing a client that diverged ----
// JSON turns -0 into 0, so it travels as the string '-0' (it can matter: x*-0 and x*0 differ in sign)
const nz=v=>Object.is(v,-0)?'-0':v,un=v=>v==='-0'?-0:v;
const pick=(o,ks)=>{const r={};for(const k of ks)if(o[k]!==undefined)r[k]=nz(o[k]);return r};
const unpick=o=>{const r={};for(const k in o)r[k]=un(o[k]);return r};
const WORM_KEYS=['x','y','vx','vy','hp','dir','air','dead'],PROJ_KEYS=['x','y','vx','vy','t','age','fuse','hit','dead'],CRATE_KEYS=['x','y','landed','gone'];
// terrain as run lengths of alternating empty/solid cells, starting with empty
function encodeMask(){const r=[];let v=0,n=0;for(let i=0;i<mask.length;i++){if(mask[i]!==v){r.push(n);v=mask[i];n=0}n++}r.push(n);return r}
function decodeMask(r){let i=0,v=0;for(const n of r){mask.fill(v,i,i+n);i+=n;v^=1}if(i!==mask.length)throw new Error('bad terrain size');tdirty=true}
function getSnapshot(){
  return {v:1,seed:curSeed,frame,tick,rs,cur,phase,timer,wind:nz(wind),weapon,power:nz(power),charging,aim:nz(aim),settle,waitT,
    winner:winner?teams.indexOf(winner):-1,keys:GAMEKEYS.filter(k=>keys[k]),
    teams:teams.map(t=>({name:t.name,turns:t.turns,act:t.act?worms.indexOf(t.act):-1,ammo:[...t.ammo]})),
    worms:worms.map(w=>({...pick(w,WORM_KEYS),team:teams.indexOf(w.team)})),
    projs:projs.map(p=>pick(p,PROJ_KEYS)),
    crates:crates.map(c=>({...pick(c,CRATE_KEYS),items:c.items.map(x=>[...x])})),
    mask:encodeMask()};
}
// Replaces the whole simulation state. Queued inputs are dropped: the caller re-submits those after s.frame.
function loadSnapshot(s){
  if(!s||s.v!==1)throw new Error('unknown snapshot version');
  setSeed(s.seed);genTerrain(); // rebuilds the untouched landscape picture for this seed
  const pristine=tg?mask.slice():null;
  decodeMask(s.mask);
  if(tg){ // erase every crater from the picture: cells that were solid at the start and aren't any more
    const img=tg.getImageData(0,0,W,H),d=img.data;
    for(let i=0;i<mask.length;i++)if(pristine[i]&&!mask[i])d[i*4+3]=0;
    tg.putImageData(img,0,0);
  }
  teams=s.teams.map((t,i)=>({name:t.name,color:COLORS[i],worms:[],turns:t.turns,act:null,ammo:[...t.ammo]}));
  worms=s.worms.map(o=>{const w={...unpick(o),team:teams[o.team]};w.team.worms.push(w);return w});
  s.teams.forEach((t,i)=>teams[i].act=t.act>=0?worms[t.act]:null);
  projs=s.projs.map(unpick);
  crates=s.crates.map(o=>({...unpick(o),items:o.items.map(x=>[...x])}));
  frame=s.frame;tick=s.tick;rs=s.rs;cur=s.cur;phase=s.phase;timer=s.timer;wind=un(s.wind);weapon=s.weapon;power=un(s.power);
  charging=s.charging;aim=un(s.aim);settle=s.settle;waitT=s.waitT;winner=s.winner>=0?teams[s.winner]:null;
  for(const k in keys)keys[k]=false;for(const k of s.keys)keys[k]=true;
  inputQ.length=0;parts=[];rings=[];shake=0;toastT=0;
}

function startGame(names,seed){setSeed(seed);frame=0;inputQ.length=0;for(const k in keys)keys[k]=false;
  genTerrain();teams=[];worms=[];projs=[];parts=[];crates=[];cur=-1;winner=null;wind=(rng()<.5?-1:1)*(.15+rng()*.85);
  weapon=1;aim=.5;power=0;charging=false;
  // starting ammo: punch (unlimited), rocket, cluster, shotgun, dynamite, airstrike, bomblet (cluster fragments only)
  names.forEach((n,i)=>teams.push({name:n,color:COLORS[i],worms:[],turns:0,act:null,ammo:[99,15,2,5,2,1,0]}));
  const total=names.length*2,slots=shuffle([...Array(total).keys()]);
  teams.forEach((t,ti)=>{for(let k=0;k<2;k++){
    const s=slots.pop(),w={x:(s+.5)*W/total+(rng()-.5)*20,y:8,vx:0,vy:0,hp:100,team:t,dir:s<total/2?1:-1,air:true,dead:false};
    t.worms.push(w);worms.push(w);}});
  nextTurn();dropCrate();dropCrate();phase='wait';settle=-60;waitT=0; // let worms drop in first
}
function nextTurn(){
  const alive=teams.filter(t=>t.worms.some(w=>!w.dead));
  if(alive.length<2){phase='over';winner=alive[0]||null;sfx('win');return}
  do{cur=(cur+1)%teams.length}while(!teams[cur].worms.some(w=>!w.dead));
  const t=teams[cur],al=t.worms.filter(w=>!w.dead);t.act=al[t.turns++%al.length];
  if(crates.length<4&&rng()<.6)dropCrate();timer=1800;sfx('turn');phase='aim';for(const k in keys)keys[k]=false;aim=.5;charging=false;power=0;settle=0;waitT=0;
}
const active=()=>teams[cur]&&teams[cur].act;

function burst(x,y,n,cols,sp){if(!g)return;for(let i=0;i<n;i++){const a=Math.random()*6.28,s=Math.random()*sp;parts.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s-1,life:30+Math.random()*30,c:cols[i%cols.length]})}}
function boom(x,y,r,maxd){
  carve(x,y,r);
  if(tg){tg.globalCompositeOperation='destination-out';tg.beginPath();tg.arc(x,y,r,0,7);tg.fill();tg.globalCompositeOperation='source-atop';tg.strokeStyle='rgba(25,12,8,.6)';tg.lineWidth=6;tg.beginPath();tg.arc(x,y,r+2,0,7);tg.stroke();tg.globalCompositeOperation='source-over'}
  rings.push({x,y,r:r*.3,max:r*1.7,l:0});shake=Math.max(shake,r/5);
  for(const w of worms){if(w.dead)continue;const dx=w.x-x,dy=w.y-6-y,d=dhypot(dx,dy);
    if(d<r+14){const f=1-d/(r+14);w.hp-=Math.round(maxd*f);sfx('hurt');w.vx+=dx/(d||1)*f*6;w.vy+=dy/(d||1)*f*6-1.5*f;w.air=true;w.y-=1}}
  burst(x,y,40,['#ffd166','#ff9f1c','#ef476f','#555'],5);burst(x,y,22,['#8c5b3b','#5a3a2a','#62c24b'],5);sfx('boom',Math.min(1,r/55));
}
function dropCrate(){
  const pool=shuffle([1,2,3,4,5]).slice(0,2);
  sfx('drop');crates.push({x:30+rng()*(W-60),y:-14,landed:false,items:pool.map(i=>[i,i===1?2:1])});
}
function stepCrates(){
  for(const c of crates){
    const sup=[-5,0,5].some(dx=>solid(c.x+dx,c.y+1));
    if(!c.landed){c.y+=1.4;if(sup)c.landed=true;if(c.y>WATER)c.gone=true}else if(!sup)c.landed=false;
    for(const w of worms){if(c.gone||w.dead)continue;
      if(Math.abs(w.x-c.x)<10&&c.y>w.y-15&&c.y-12<w.y){c.gone=true;
        const got=c.items.map(([i,n])=>{w.team.ammo[i]+=n;return '+'+n+' '+WEAPONS[i].n});
        toast=w.team.name+' found '+got.join(', ');toastT=180;burst(c.x,c.y-6,14,['#ffd166','#fff'],3);sfx('pickup')}}
  }
  crates=crates.filter(c=>!c.gone);
}
function punch(w){
  const ax=w.dir*dcos(aim),ay=-dsin(aim),px=w.x+ax*14,py=w.y-7+ay*14;
  w.pt=tick;w.pa=[ax,ay];
  for(const o of worms){if(o.dead||o===w)continue;
    if(dhypot(o.x-px,o.y-6-py)<14){o.hp-=20;sfx('hurt');o.vx+=ax*4.5;o.vy-=3.5;o.air=true;o.y-=1;burst(px,py,10,['#fff','#ffd166'],3)}}
}
function explode(p){
  const k=WEAPONS[p.t];p.dead=true;
  if(p.t===2){boom(p.x,p.y,k.r,k.d);burst(p.x,p.y,14,['#c77dff','#fff'],3);for(let i=0;i<5;i++)projs.push({x:p.x,y:p.y-4,vx:(i-2)*1.3+(rng()-.5),vy:-2-rng()*2,t:6,age:0,fuse:40+rng()*30})}
  else boom(p.x,p.y,k.r,k.d);
}
function shoot(w,ax,ay){
  for(let s=0;s<2;s++){const a=datan2(ay,ax)+(s?.04:-.04),dx=dcos(a),dy=dsin(a);
    for(let d=12;d<520;d+=2){const x=w.x+dx*d+wind*d*d*.00009,y=w.y-7+dy*d;
      if(d%8===0&&g)parts.push({x,y,vx:0,vy:0,life:6,c:'#fff'});
      if(solid(x,y)||worms.some(o=>!o.dead&&o!==w&&Math.abs(x-o.x)<6&&y>o.y-13&&y<o.y)){boom(x,y,13,34);break}}}
}
function fire(){
  const w=active(),sp=2+power*10,ax=w.dir*dcos(aim),ay=-dsin(aim);
  if(weapon>0)w.team.ammo[weapon]--;
  sfx(weapon===3?'shot':weapon===0?'punch':weapon===5?'whistle':weapon===4?'plant':'launch');
  if(weapon===0)punch(w);
  else if(weapon===3)shoot(w,ax,ay);
  else if(weapon===4)projs.push({x:w.x+w.dir*8,y:w.y-4,vx:w.dir*.6,vy:-1,t:4,age:0,fuse:300});
  else if(weapon===5){const tx=Math.max(10,Math.min(W-10,w.x+w.dir*(80+power*560)));for(let i=0;i<5;i++)projs.push({x:tx+(i-2)*22,y:-20-i*14,vx:w.dir*.4,vy:2+rng()*.5,t:5,age:99,fuse:0})}
  else projs.push({x:w.x+ax*9,y:w.y-7+ay*9,vx:ax*sp,vy:ay*sp,t:weapon,age:0,fuse:weapon===2?150:180});
  charging=false;power=0;phase='wait';settle=0;
}
function stepWorm(w){
  if(w.air){
    w.vy=Math.min(w.vy+.12,8);
    const n=Math.max(1,Math.ceil(Math.max(Math.abs(w.vx),Math.abs(w.vy))));
    for(let i=0;i<n;i++){
      const nx=w.x+w.vx/n;if(!blocked(nx,w.y))w.x=nx;else w.vx*=-.4;
      const ny=w.y+w.vy/n;
      if(w.vy>=0){w.y=ny;let k=0;while(blocked(w.x,w.y)&&k++<6)w.y--;
        if(resting(w.x,w.y)){if(w.vy>6.5)w.hp-=Math.round((w.vy-6.5)*10);sfx('hurt');w.vx=w.vy=0;w.air=false;break}}
      else if(!blocked(w.x,ny))w.y=ny;else w.vy=0;
    }
  }else if(!resting(w.x,w.y)){w.air=true;w.vx=w.vy=0}
  if(w.y>WATER||w.x<-20||w.x>W+20){if(w.y>WATER){burst(w.x,WATER,25,['#bfe9f5','#fff'],3);sfx('splash')}w.hp=0}
  if(w.hp<=0&&!w.dead){w.dead=true;sfx('die');burst(w.x,w.y-6,30,[w.team.color,'#fff'],4)}
}
function walk(w,d){
  w.dir=d;w.wt=tick;if(tick%14===0)sfx('step');const nx=w.x+d*.9;
  for(let up=0;up<=4;up++)if(!blocked(nx,w.y-up)){w.x=nx;w.y-=up;break}
  let k=0;while(!ground(w.x,w.y)&&k++<4)w.y++;
  if(!ground(w.x,w.y)){w.air=true;w.vx=w.vy=0}
}
function stepProj(p){
  p.age++;p.vy+=.12;if(!p.hit)p.vx+=wind*.02;p.hit=false;
  const n=Math.max(1,Math.ceil(Math.max(Math.abs(p.vx),Math.abs(p.vy))));
  for(let i=0;i<n;i++){
    const nx=p.x+p.vx/n,ny=p.y+p.vy/n;
    const hitW=IMPACT(p.t)&&worms.some(w=>!w.dead&&!(p.age<15&&w===active())&&Math.abs(nx-w.x)<6&&ny>w.y-13&&ny<w.y);
    if(solid(nx,ny)||hitW){
      if(IMPACT(p.t)){explode(p);return}
      const sx=solid(nx,p.y),sy=solid(p.x,ny);
      if(sx&&!sy)p.vx*=-.5;else if(sy&&!sx){p.vy*=-.5;if(Math.abs(p.vy)<.6)p.vy=0}else{p.vx*=-.5;p.vy*=-.5}
      p.vx*=.85;p.hit=true;break;
    }else{p.x=nx;p.y=ny}
  }
  if(!IMPACT(p.t)&&--p.fuse<=0)explode(p);
  if(p.y>WATER||p.x<-50||p.x>W+50)p.dead=true;
  if(ROCKETY(p.t)&&p.age%2===0&&g)parts.push({x:p.x,y:p.y,vx:0,vy:0,life:14,c:'#ddd'});
}
function update(){
  tick++;frame++;
  while(inputQ.length&&inputQ[0].f<=frame)applyInput(inputQ.shift());
  for(const w of worms)if(!w.dead)stepWorm(w);
  stepCrates();for(const p of projs)stepProj(p);projs=projs.filter(p=>!p.dead);
  for(const p of parts){p.x+=p.vx;p.y+=p.vy;p.vy+=.05;p.life--}parts=parts.filter(p=>p.life>0);
  const w=active();
  if(phase==='aim'&&w&&!w.dead){
    if(!w.air&&!charging){if(keys.ArrowLeft)walk(w,-1);if(keys.ArrowRight)walk(w,1)}
    if(keys.ArrowUp)aim=Math.min(1.4,aim+.025);if(keys.ArrowDown)aim=Math.max(-1.4,aim-.025);
    if(charging){power=Math.min(1,power+.013);if(tick%5===0)sfx('charge',power);if(power>=1)fire()}
    if(timer<=300&&timer>0&&timer%60===0)sfx('tick');if(--timer<=0){charging=false;phase='wait';settle=0}
  }else if(phase==='aim')phase='wait';
  if(phase==='wait'){
    const still=!projs.length&&worms.every(x=>x.dead||!x.air);
    settle=still?settle+1:Math.min(settle,0);
    // safety net: never let a stuck projectile or worm hold the match for more than 30 s
    if(settle>80||++waitT>1800)nextTurn();
  }
}

// ---- rendering (browser only; reads state, never changes gameplay) ----
function drawWorm(w){
  const x=w.x,y=w.y;
  const d=w.dir,wig=tick-(w.wt||-99)<8,N=6,seg=[];
  for(let i=0;i<=N;i++){const u=i/N,k=wig?Math.sin(tick/2+i*1.2)*1.4:0;seg.push({x:x-d*10*(1-u)*(1-u*.15),y:y-3.6-u*u*8+k,r:i===N?6.3:4.2+u*.8})}
  g.fillStyle='#2b1d12';
  for(let i=0;i<N;i++){const s=seg[i],f=wig?Math.sin(tick/2+i*1.7)*1.2:0;g.beginPath();g.ellipse(s.x+f,Math.min(s.y+s.r+.8,y+1),2.2,1.6,0,0,7);g.fill()}
  for(const s of seg)dot(s.x,s.y,s.r+1.4,'rgba(0,0,0,.6)');
  seg.forEach((s,i)=>{dot(s.x,s.y,s.r,w.team.color);if(i%2)dot(s.x,s.y,s.r,'rgba(255,255,255,.16)');dot(s.x-s.r*.25,s.y+s.r*.45,s.r*.5,'rgba(0,0,0,.12)');dot(s.x-s.r*.3,s.y-s.r*.4,s.r*.32,'rgba(255,255,255,.4)')});
  const h=seg[N],lk=w===active()?-Math.sin(aim)*1.1:0,wb=Math.sin(tick/10+w.x)*1.5;
  g.strokeStyle='#2b1d12';g.lineWidth=1.4;
  for(const [bx,tx,ty] of [[-1,-3,-12],[3,6,-11.5]]){g.beginPath();g.moveTo(h.x+d*bx,h.y-5);g.quadraticCurveTo(h.x+d*(bx+tx)/2,h.y-9,h.x+d*tx+wb*d,h.y+ty);g.stroke();dot(h.x+d*tx+wb*d,h.y+ty,2.2,'#ffd166')}
  dot(h.x+d*.2,h.y-1.5,3.1,'#fff');dot(h.x+d*4,h.y-1,2.7,'#fff');
  dot(h.x+d*.9,h.y-1.5+lk,1.5,'#111');dot(h.x+d*4.6,h.y-1+lk,1.4,'#111');
  dot(h.x+d*1.3,h.y-2.2+lk,.55,'#fff');dot(h.x+d*5,h.y-1.7+lk,.5,'#fff');
  dot(h.x+d*2,h.y+3,1.6,'rgba(255,110,140,.55)');
  g.strokeStyle='#2b1d12';g.lineWidth=1;g.beginPath();g.arc(h.x+d*3,h.y+2,2.3,.15,Math.PI-.15);g.stroke();
  g.font='600 11px Fredoka,system-ui,sans-serif';g.textAlign='center';
  g.fillStyle='rgba(0,0,0,.55)';g.fillRect(x-12,y-38,24,13);g.fillStyle='#fff';g.fillText(Math.max(0,w.hp),x,y-28);
  g.fillStyle=w.team.color;g.fillRect(x-12,y-39,24,2);
}
function draw(){
  g.shadowBlur=0;g.save();if(shake>.3){g.translate((Math.random()-.5)*shake,(Math.random()-.5)*shake);shake*=.88}else shake=0;
  g.drawImage(bgc,0,0);drawSky();g.drawImage(tc,0,0);
  const a=active();
  for(const c of crates){
    if(!c.landed){g.strokeStyle='rgba(255,255,255,.8)';g.lineWidth=1;g.beginPath();g.moveTo(c.x-5,c.y-13);g.lineTo(c.x-10,c.y-26);g.moveTo(c.x+5,c.y-13);g.lineTo(c.x+10,c.y-26);g.stroke();g.fillStyle='#fff';g.beginPath();g.arc(c.x,c.y-26,10,Math.PI,0);g.fill()}
    g.fillStyle='#b9833f';g.fillRect(c.x-7,c.y-13,14,13);g.strokeStyle='#5a3a14';g.lineWidth=1.5;g.strokeRect(c.x-7,c.y-13,14,13);
    g.beginPath();g.moveTo(c.x-7,c.y-13);g.lineTo(c.x+7,c.y);g.moveTo(c.x+7,c.y-13);g.lineTo(c.x-7,c.y);g.stroke();dot(c.x,c.y-6.5,3,'#ffd166');
  }
  for(const w of worms)if(!w.dead){drawWorm(w);const q=tick-(w.pt||-99);if(q<10){const r=8+q,gx=w.x+w.pa[0]*r,gy=w.y-7+w.pa[1]*r;dot(gx,gy,6,'#222');dot(gx,gy,4.8,'#e63946')}}
  if(a&&phase==='aim'&&!a.dead){
    const ax=a.dir*Math.cos(aim),ay=-Math.sin(aim);
    dot(a.x+ax*45,a.y-7+ay*45,3.5,'#fff');g.strokeStyle='#222';g.lineWidth=1.5;g.beginPath();g.arc(a.x+ax*45,a.y-7+ay*45,5.5,0,7);g.stroke();
    if(charging){for(let i=1;i<=10;i++)if(i/10<=power)dot(a.x+ax*(14+i*3.4),a.y-7+ay*(14+i*3.4),2.2,i>7?'#ef476f':'#ffd166')}
    if(charging&&weapon===5){const tx=Math.max(10,Math.min(W-10,a.x+a.dir*(80+power*560)));g.fillStyle='#ef476f';g.beginPath();g.moveTo(tx,36);g.lineTo(tx-9,16);g.lineTo(tx+9,16);g.fill()}
    const by=a.y-50+Math.sin(tick/8)*3;g.fillStyle=a.team.color;g.beginPath();g.moveTo(a.x,by);g.lineTo(a.x-6,by-9);g.lineTo(a.x+6,by-9);g.fill();
  }
  for(const p of projs){
    if(ROCKETY(p.t)){dot(p.x,p.y,3.5,'#444');dot(p.x,p.y,1.8,'#ff9f1c')}
    else if(p.t===4){g.fillStyle='#d62839';g.fillRect(p.x-2.5,p.y-9,5,10);g.fillStyle='#fff';g.fillRect(p.x-2.5,p.y-5,5,2);dot(p.x,p.y-11+Math.sin(tick),2,'#ffd166');g.font='600 10px Fredoka,sans-serif';g.textAlign='center';g.fillText(Math.ceil(p.fuse/60),p.x,p.y-16)}
    else{dot(p.x,p.y,p.t===6?2.5:4.5,p.t===2?'#8e5bd1':p.t===6?'#ff9f1c':'#4b6b2f');if(!IMPACT(p.t)&&p.t!==6){g.fillStyle='#fff';g.font='600 10px Fredoka,sans-serif';g.textAlign='center';g.fillText(Math.ceil(p.fuse/60),p.x,p.y-8)}}
  }
  for(const p of parts){g.globalAlpha=Math.min(1,p.life/20);dot(p.x,p.y,2.5,p.c)}g.globalAlpha=1;
  for(const q of rings){q.l++;q.r+=(q.max-q.r)*.25;g.strokeStyle='rgba(255,240,200,'+Math.max(0,.7-q.l/14)+')';g.lineWidth=4;g.beginPath();g.arc(q.x,q.y,q.r,0,7);g.stroke()}rings=rings.filter(q=>q.l<14);
  const wg=g.createLinearGradient(0,WATER-6,0,H);wg.addColorStop(0,'rgba(70,170,210,.85)');wg.addColorStop(1,'rgba(15,70,120,.95)');g.fillStyle=wg;g.beginPath();g.moveTo(0,H);
  const wy=x=>WATER+Math.sin(x/40+tick/25)*3+Math.sin(x/17-tick/18)*1.5;
  for(let x=0;x<=W;x+=8)g.lineTo(x,wy(x));g.lineTo(W,H);g.fill();
  g.strokeStyle='rgba(255,255,255,.6)';g.lineWidth=1.6;g.beginPath();for(let x=0;x<=W;x+=8)x?g.lineTo(x,wy(x)):g.moveTo(x,wy(x));g.stroke();
  g.restore();hud(a);
  if(DEBUG){g.shadowBlur=0;g.font='12px monospace';g.textAlign='left';g.fillStyle='#fff';g.fillRect(8,H-24,330,16);g.fillStyle='#000';g.fillText('seed '+curSeed+'  frame '+frame+'  hash '+stateHash().toString(16),12,H-12)}
}
function hud(a){g.shadowColor='rgba(0,0,0,.6)';g.shadowBlur=3;
  g.textAlign='left';g.font='600 18px Fredoka,system-ui,sans-serif';
  teams.forEach((t,i)=>{const hp=t.worms.reduce((s,w)=>s+Math.max(0,w.hp),0),y=38+i*16;
    g.fillStyle='rgba(0,0,0,.35)';g.fillRect(10,y,110,10);g.fillStyle=t.color;g.fillRect(10,y,110*hp/200,10);
    g.font='600 12px Fredoka,sans-serif';g.fillStyle='#fff';g.fillText(t.name+(hp?'':' (out)'),126,y+9)});
  if(a&&phase!=='over'){
    g.font='600 18px Fredoka,sans-serif';g.fillStyle='#fff';
    g.fillText(a.team.name+'’s turn · '+WEAPONS[weapon].n,10,22);
    g.textAlign='right';g.fillText(phase==='aim'?Math.ceil(timer/60)+'s':'…',W-10,22);
    g.font='600 12px Fredoka,sans-serif';g.fillText('wind',W-92,42);
    g.fillStyle='rgba(0,0,0,.3)';g.fillRect(W-86,36,76,8);g.fillStyle='#fff';
    g.fillRect(W-48+(wind<0?wind*38:0),36,Math.abs(wind)*38,8);
  }
  if(toastT>0){toastT--;g.font='600 15px Fredoka,system-ui,sans-serif';g.textAlign='center';const tw=g.measureText(toast).width+20;g.fillStyle='rgba(0,0,0,.6)';g.fillRect(W/2-tw/2,64,tw,26);g.fillStyle='#fff';g.fillText(toast,W/2,82)}
  if(phase==='over'){
    g.fillStyle='rgba(0,0,0,.5)';g.fillRect(0,H/2-50,W,100);g.textAlign='center';g.fillStyle='#fff';
    g.font='600 40px Fredoka,sans-serif';g.fillText(winner?winner.name+' wins!':'Draw!',W/2,H/2+8);
    g.font='400 16px Fredoka,sans-serif';g.fillText(overHint,W/2,H/2+34);
  }
}

return {startGame,update,stateHash,submitInput,sendInput,applyInput,preview,draw,active,getSnapshot,loadSnapshot,
  get frame(){return frame},get tick(){return tick},get phase(){return phase},get cur(){return cur},get teams(){return teams},
  get worms(){return worms},get weapon(){return weapon},get winner(){return winner},get seed(){return curSeed},get terrainHash(){return terrainHash()},
  set overHint(v){overHint=v},get terrainCanvas(){return tc}};
}

const api={createGame,W,H,COLORS,WEAPONS,GAMEKEYS,ORDER,dsin,dcos,datan2,dhypot};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Squirmish=api;
})(this);
