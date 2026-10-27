// Caterpillar Continental Combat page: online rooms (lobby, lockstep match, spectating) and offline hot-seat play.
'use strict';
const {createGame,COLORS,GAMEKEYS,ORDER}=Squirmish;
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const store={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{v==null?localStorage.removeItem(k):localStorage.setItem(k,v)}catch{}}};
const COLOR_NAMES=['pink','yellow','green','blue','purple','orange'];
const cv=$('#c'),g=cv.getContext('2d'),menu=$('#menu'),card=$('#card'),banner=$('#banner');
let quiet=false; // set while fast-forwarding so catching up doesn't replay minutes of sound at once
const game=createGame({document,ctx:g,sfx:(n,a)=>{if(!quiet)sfx(n,a)},debug:location.hash==='#debug'});
const ls=Lockstep.createLockstep({game,send:m=>send(m),onDesync:info=>console.warn('desync',info)});
// mode: 'home' (menus), 'offline' (hot-seat on one keyboard), 'room' (online lobby), 'match' (online match)
let mode='home';

// sound (synthesized with WebAudio, no files)
let ac=null,master=null,muted=false,noiseBuf=null;
function initAudio(){
  if(ac){if(ac.state==='suspended')ac.resume();return}
  const AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
  try{ac=new AC();master=ac.createGain();master.gain.value=muted?0:.5;master.connect(ac.destination);
    noiseBuf=ac.createBuffer(1,ac.sampleRate*1.5,ac.sampleRate);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1}catch(e){ac=null}
}
function tone(f0,f1,dur,type,vol,delay){
  if(!ac)return;const t=ac.currentTime+(delay||0),o=ac.createOscillator(),gn=ac.createGain();
  o.type=type||'sine';o.frequency.setValueAtTime(f0,t);o.frequency.exponentialRampToValueAtTime(Math.max(20,f1),t+dur);
  gn.gain.setValueAtTime(vol||.3,t);gn.gain.exponentialRampToValueAtTime(.001,t+dur);
  o.connect(gn);gn.connect(master);o.start(t);o.stop(t+dur+.02);
}
function noise(dur,f0,f1,vol,type,q){
  if(!ac)return;const t=ac.currentTime,s=ac.createBufferSource(),fl=ac.createBiquadFilter(),gn=ac.createGain();
  s.buffer=noiseBuf;fl.type=type||'lowpass';fl.Q.value=q||1;fl.frequency.setValueAtTime(f0,t);fl.frequency.exponentialRampToValueAtTime(Math.max(20,f1),t+dur);
  gn.gain.setValueAtTime(vol,t);gn.gain.exponentialRampToValueAtTime(.001,t+dur);
  s.connect(fl);fl.connect(gn);gn.connect(master);s.start(t,Math.random()*.5);s.stop(t+dur+.02);
}
function sfx(n,a){
  if(!ac||muted)return;
  switch(n){
    case 'boom':noise(.5+a*.5,1800,60,.7,'lowpass');tone(110,30,.5+a*.3,'sine',.5);break;
    case 'launch':noise(.45,500,2500,.35,'bandpass',2);break;
    case 'shot':noise(.18,5000,400,.7,'lowpass');tone(150,50,.12,'square',.25);break;
    case 'punch':tone(160,50,.14,'square',.35);noise(.1,1500,200,.4,'lowpass');break;
    case 'plant':tone(300,200,.06,'square',.2);tone(220,160,.08,'square',.2,.07);break;
    case 'whistle':tone(1800,500,.9,'sine',.12);break;
    case 'jump':tone(300,600,.15,'sine',.25);break;
    case 'step':tone(120+Math.random()*30,80,.05,'triangle',.12);break;
    case 'hurt':tone(900,500,.12,'square',.12);tone(700,350,.12,'square',.12,.1);break;
    case 'die':tone(500,80,.5,'sawtooth',.18);break;
    case 'splash':noise(.5,3000,300,.5,'lowpass');break;
    case 'pickup':[523,659,784,1046].forEach((f,i)=>tone(f,f,.12,'triangle',.22,i*.07));break;
    case 'drop':noise(.4,2000,800,.12,'bandpass');break;
    case 'turn':tone(660,660,.1,'sine',.2);tone(880,880,.15,'sine',.2,.1);break;
    case 'tick':tone(1000,1000,.04,'square',.1);break;
    case 'charge':tone(200+a*600,200+a*600,.05,'sawtooth',.07);break;
    case 'win':[523,659,784,1046,784,1046].forEach((f,i)=>tone(f,f,.18,'triangle',.25,i*.14));break;
  }
}

// ---------- screens ----------
const myName=()=>store.get('squirmish:name')||'';
const saveName=n=>store.set('squirmish:name',n.trim().slice(0,12));
function showMenu(html){menu.classList.remove('hide');card.innerHTML=html}
function setMode(m){
  mode=m;
  const online=m==='room'||m==='match';
  $('#net').hidden=!online;$('#copy').hidden=!online;
  $('#leave').hidden=!online;$('#leave').textContent=m==='match'?'Leave match':'Leave room';
  $('#again').hidden=m!=='offline';
  $('#me').hidden=m!=='match';
  $('#weapons').hidden=$('#who').hidden=m!=='match'&&m!=='offline';
  if(m!=='match')banner.hidden=true;
}

function showHome(msg=''){
  setMode('home');
  showMenu(`<h2>Caterpillar Continental Combat</h2><p>Play online with 2 to 6 friends.</p>
    <label class="field">Name <input id="nm" maxlength="12" placeholder="Your name" value="${esc(myName())}"></label>
    <div class="row"><button class="big" data-act="create">Create a room</button></div>
    <p class="or">or join with a code</p>
    <div class="row"><label class="field" style="margin:0"><input id="codein" maxlength="5" placeholder="K7QX2" autocapitalize="characters" style="width:6em;letter-spacing:.1em"></label><button class="ghost" data-act="joincode">Join</button></div>
    <p class="msg" id="msg">${esc(msg)}</p>
    <button class="link" data-act="offline">Play offline on one keyboard</button>`);
}
async function showJoin(code){
  setMode('home');
  showMenu(`<h2>Room <span class="code">${esc(code)}</span></h2><p id="roominfo">Checking the room…</p>
    <label class="field">Name <input id="nm" maxlength="12" placeholder="Your name" value="${esc(myName())}"></label>
    <div class="row"><button class="big" data-act="join">Join</button><button class="ghost" data-act="watch">Just watch</button></div>
    <p class="msg" id="msg"></p><button class="link" data-act="home">Back</button>`);
  $('#nm').focus();
  try{
    const r=await fetch('/api/rooms/'+encodeURIComponent(code));
    if(r.status===404)return showHome('Room '+code+' doesn’t exist (rooms close after 30 minutes with nobody in them).');
    const i=await r.json(),info=$('#roominfo');if(!info)return;
    info.textContent=i.state==='playing'?'A match is being played. You can watch it and take a seat for the next one.'
      :`${i.players} of 6 seats taken${i.spectators?`, ${i.spectators} watching`:''}.`;
  }catch{}
}
function showOffline(){
  setMode('home');
  showMenu(`<h2>Offline game</h2><p>Pass-and-play on one keyboard. Pick 2 to 6 players.</p>
    <div id="counts"></div><div id="names"></div><button class="big" data-act="offgo">Start game</button>
    <p><button class="link" data-act="home">Back</button></p>`);
  renderOffline();
}
let offCount=2;const offNames=['Player 1','Player 2','Player 3','Player 4','Player 5','Player 6'];
function renderOffline(){
  $('#counts').innerHTML=[2,3,4,5,6].map(n=>`<button class="n${n===offCount?' on':''}" data-n="${n}" aria-label="${n} players">${n}</button>`).join('');
  $('#names').innerHTML=Array.from({length:offCount},(_,i)=>`<label><i class="dot" style="background:${COLORS[i]}"></i><input data-i="${i}" value="${esc(offNames[i])}" maxlength="12" aria-label="Player ${i+1} name"></label>`).join('');
}

// lobby: the top part is built once (so typing in the name box isn't interrupted), the rest re-renders on every update
function showLobby(){
  setMode('room');
  showMenu(`<h2>Room <span class="code">${esc(net.code)}</span></h2>
    <p>Invite friends with this link: <b>${esc(location.host)}/r/${esc(net.code)}</b></p>
    <div class="row"><button class="ghost" data-act="copy">Copy invite link</button></div>
    <label class="field">Your name <input id="myname" maxlength="12" value="${esc(net.you?.name||myName())}"></label>
    <ol id="seats"></ol><div id="specs"></div>
    <div class="row"><button class="ghost" data-act="ready" id="readyBtn"></button><button class="ghost" data-act="role" id="roleBtn"></button></div>
    <div class="row"><button class="big" data-act="start" id="startBtn">Start match</button></div>
    <p class="msg" id="msg"></p>
    <button class="link" data-act="leave">Leave room</button>`);
  renderLobby();
}
function renderLobby(){
  const L=net.lobby,me=net.you;if(!L||!me||mode!=='room'||!$('#seats'))return;
  const amHost=L.host===me.id,players=L.players;
  $('#seats').innerHTML=Array.from({length:6},(_,i)=>{
    const p=players.find(p=>p.slot===i);
    if(!p)return `<li class="empty"><i style="background:${COLORS[i]}"></i><span class="nm">Open seat</span></li>`;
    const st=!p.connected?'<span class="st">offline</span>':p.ready?'<span class="st rdy">ready ✓</span>':'<span class="st">not ready</span>';
    return `<li class="${p.id===me.id?'me':''}"><i style="background:${COLORS[i]}"></i><span class="nm">${esc(p.name)}</span>`+
      `${p.id===me.id?'<span class="tag">you</span>':''}${p.id===L.host?'<span class="tag">host</span>':''}${st}</li>`;
  }).join('');
  $('#specs').textContent=L.spectators.length?'Watching: '+L.spectators.map(s=>s.name+(s.id===me.id?' (you)':'')+(s.id===L.host?' (host)':'')).join(', '):'';
  const seated=me.role==='player',p=players.find(p=>p.id===me.id);
  const rb=$('#readyBtn');rb.hidden=!seated;rb.textContent=p?.ready?'Ready ✓':'I’m ready';rb.classList.toggle('on',!!p?.ready);
  const full=players.length>=6;
  $('#roleBtn').textContent=seated?'Watch instead':full?'All seats taken':'Take a seat';$('#roleBtn').disabled=!seated&&full;
  const sb=$('#startBtn'),ok=players.length>=2&&players.every(p=>p.ready&&p.connected);
  sb.hidden=!amHost;sb.disabled=!ok;
  const msg=$('#msg');
  if(!msg.dataset.sticky)msg.textContent=amHost?(players.length<2?'Waiting for at least 2 players.':ok?'Everyone’s ready. Start when you like.':'Waiting for everyone to be ready.')
    :`Waiting for ${(players.find(p=>p.id===L.host)||L.spectators.find(s=>s.id===L.host))?.name||'the host'} to start the match.`;
}
function flash(text){const m=$('#msg');if(!m)return;m.textContent=text;m.dataset.sticky=1;clearTimeout(flash.t);flash.t=setTimeout(()=>{delete m.dataset.sticky;renderLobby()},3500)}

function enterMatch(){
  setMode('match');menu.classList.add('hide');document.activeElement?.blur();
  game.overHint='Back to the lobby in a moment';
  const t=ls.myTeam,me=$('#me');
  me.innerHTML=t>=0?`<span class="dot" style="background:${COLORS[t]}"></span>You are team ${t+1}, ${esc(game.teams[t]?.name||'')} (${COLOR_NAMES[t]})`
    :'👀 You are watching';
}

// ---------- network ----------
const net={ws:null,code:null,token:null,you:null,lobby:null,status:'off',ping:null,retry:0,closing:false,fatal:false,spectate:false,timer:0,pingT:0,over:null};
const tokenKey=c=>'squirmish:token:'+c;
function send(m){if(net.ws&&net.ws.readyState===1)net.ws.send(JSON.stringify(m))}
function openRoom(code,{spectate=false}={}){
  closeRoom();
  Object.assign(net,{code,token:store.get(tokenKey(code)),you:null,lobby:null,retry:0,closing:false,fatal:false,spectate,over:null});
  setMode('room');showMenu('<h2>Joining…</h2>');
  connect();
}
function connect(){
  const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  net.ws=ws;net.status='connecting';
  ws.onopen=()=>ws.send(JSON.stringify({t:'join',room:net.code,name:myName()||'Player',token:net.token||undefined,spectate:net.spectate}));
  ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}onServer(m)};
  ws.onclose=()=>{
    if(net.ws!==ws)return;
    net.ws=null;clearInterval(net.pingT);net.ping=null;
    if(net.closing||net.fatal){net.status='off';return}
    net.status='reconnecting';
    net.timer=setTimeout(connect,Math.min(5000,400*2**net.retry++));
  };
}
function closeRoom(){
  clearTimeout(net.timer);clearInterval(net.pingT);
  if(net.ws){net.closing=true;const ws=net.ws;net.ws=null;ws.close()}
  ls.onMessage({t:'lobby',state:'lobby'}); // stops the lockstep
}
function onServer(m){
  ls.onMessage(m);
  switch(m.t){
    case 'welcome':
      net.token=m.token;store.set(tokenKey(net.code),m.token);net.you=m.you;net.lobby=m;net.retry=0;net.status='online';
      clearInterval(net.pingT);net.pingT=setInterval(()=>send({t:'ping',c:performance.now()}),2000);send({t:'ping',c:performance.now()});
      if(m.state==='playing')enterMatch();else{showLobby();if(m.seatWanted)flash('The room is full, so you’re watching. Take a seat when one opens.')}
      break;
    case 'lobby':
      if(mode==='match'&&net.lobby)for(const p of m.players){ // a seated player dropped or came back during the match
        const was=net.lobby.players.find(q=>q.id===p.id);
        if(was&&was.connected&&!p.connected&&p.id!==net.you?.id)toast(`${p.name} lost connection. They have 60 s to come back.`);
        if(was&&!was.connected&&p.connected&&p.id!==net.you?.id)toast(`${p.name} is back`);
      }
      net.lobby=m;
      if(m.state==='lobby'&&mode==='match'){net.over=null;showLobby()}else renderLobby();
      break;
    case 'you':net.you=m.you;renderLobby();break;
    case 'start':net.you=m.you;net.over=null;enterMatch();break;
    case 'match_over':net.over={...m,at:performance.now()};break;
    case 'player_left':toast(m.reason==='timeout'?`${nameOf(m.id)||'A player'} didn’t come back in time. Their team is out.`:`${nameOf(m.id)||'A player'} left the match. Their team is out.`);break;
    case 'host':if(mode==='room'&&m.id===net.you?.id)flash('You’re the host now.');break;
    case 'pong':net.ping=Math.round(performance.now()-m.c);break;
    case 'replaced':net.fatal=true;showHome('This room is open in another tab, so this one was closed.');break;
    case 'error':
      if(m.code==='no_room'){net.fatal=true;store.set(tokenKey(net.code),null);history.replaceState(null,'','/');showHome('That room doesn’t exist any more.')}
      else if(m.code==='room_full'){net.fatal=true;showHome('That room is full.')}
      else if(mode==='room')flash({not_ready:'Everyone needs to be ready first.',need_players:'You need at least 2 players.',not_host:'Only the host can start.',room_full:'All seats are taken.'}[m.code]||'Something went wrong ('+m.code+').');
      break;
  }
}
const nameOf=id=>{const L=net.lobby;return L&&(L.players.find(p=>p.id===id)||L.spectators.find(s=>s.id===id))?.name};
let toastText='',toastUntil=0;
function toast(t){toastText=t;toastUntil=performance.now()+3500}
function leaveRoom(){
  if(mode==='match'&&ls.myTeam>=0&&game.phase!=='over'&&!confirm('Leave the match? Your team will be out.'))return;
  send({t:'leave'});store.set(tokenKey(net.code),null);closeRoom();
  history.pushState(null,'','/');showHome();
}
async function copyLink(btn){
  const url=location.origin+'/r/'+net.code;
  try{await navigator.clipboard.writeText(url);if(btn){const o=btn.textContent;btn.textContent='Copied!';setTimeout(()=>btn.textContent=o,1500)}}
  catch{prompt('Copy this link:',url)}
}

// ---------- routing ----------
function route(){
  const m=location.pathname.match(/^\/r\/([A-Za-z0-9]{5})\/?$/);
  if(!m){closeRoom();showHome();return}
  const code=m[1].toUpperCase();
  if(net.code===code&&net.ws)return;
  if(store.get(tokenKey(code)))openRoom(code);else{closeRoom();net.code=code;showJoin(code)}
}
addEventListener('popstate',route);

// ---------- clicks and typing in the menus ----------
card.addEventListener('click',async e=>{
  const n=e.target.closest('[data-n]');if(n){offCount=+n.dataset.n;renderOffline();return}
  const b=e.target.closest('[data-act]');if(!b)return;
  const nm=$('#nm');if(nm)saveName(nm.value);
  switch(b.dataset.act){
    case 'create':{
      if(!myName()){$('#msg').textContent='Pick a name first.';nm?.focus();return}
      b.disabled=true;
      try{const r=await fetch('/api/rooms',{method:'POST'}),j=await r.json();
        if(!r.ok)throw new Error(j.error==='slow_down'?'Too many rooms created, wait a minute.':'The server is full right now.');
        history.pushState(null,'','/r/'+j.code);openRoom(j.code);
      }catch(err){b.disabled=false;$('#msg').textContent=err.message||'Couldn’t reach the server.'}
      break;}
    case 'joincode':{
      const code=($('#codein').value||'').trim().toUpperCase();
      if(!/^[A-Z0-9]{5}$/.test(code)){$('#msg').textContent='Room codes have 5 letters and numbers.';return}
      history.pushState(null,'','/r/'+code);route();break;}
    case 'join':case 'watch':
      if(!myName()){$('#msg').textContent='Pick a name first.';nm?.focus();return}
      openRoom(net.code,{spectate:b.dataset.act==='watch'});break;
    case 'home':history.pushState(null,'','/');route();break;
    case 'offline':showOffline();break;
    case 'offgo':setMode('offline');menu.classList.add('hide');game.overHint='Press New game to play again';game.startGame(offNames.slice(0,offCount),Math.random()*4294967296>>>0);break;
    case 'copy':copyLink(b);break;
    case 'ready':send({t:'ready',ready:!net.lobby.players.find(p=>p.id===net.you.id)?.ready});break;
    case 'role':send({t:'role',spectate:net.you.role==='player'});break;
    case 'start':send({t:'start'});break;
    case 'leave':leaveRoom();break;
  }
});
card.addEventListener('input',e=>{if(e.target.dataset.i!==undefined)offNames[e.target.dataset.i]=e.target.value||'Player'});
card.addEventListener('change',e=>{if(e.target.id==='myname'){saveName(e.target.value);send({t:'name',name:e.target.value})}});
card.addEventListener('keydown',e=>{
  if(e.key!=='Enter')return;
  if(e.target.id==='myname')e.target.blur();
  else if(e.target.id==='codein')card.querySelector('[data-act=joincode]').click();
  else if(e.target.id==='nm')card.querySelector('[data-act=create],[data-act=join]')?.click();
});
$('#copy').onclick=e=>copyLink(e.currentTarget);
$('#leave').onclick=leaveRoom;
$('#again').onclick=()=>{showOffline();document.activeElement.blur()};
const mb=$('#mute');
mb.onclick=()=>{initAudio();muted=!muted;if(master)master.gain.value=muted?0:.5;mb.textContent=muted?'🔇 Muted':'🔊 Sound';mb.setAttribute('aria-pressed',muted);mb.blur()};
addEventListener('pointerdown',initAudio);

// ---------- keyboard ----------
const held=new Set();
function press(k,d){
  if(mode==='offline'&&game.phase!=='menu')game.sendInput(k,d);
  else if(mode==='match')ls.input(k,d);
}
addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT')return;
  if((mode==='offline'||mode==='match')&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','Enter'].includes(e.key))e.preventDefault();
  initAudio();
  if(e.repeat||!GAMEKEYS.includes(e.key))return;
  held.add(e.key);press(e.key,true);
});
addEventListener('keyup',e=>{if(GAMEKEYS.includes(e.key)){held.delete(e.key);press(e.key,false)}});
addEventListener('blur',()=>{for(const k of held)press(k,false);held.clear()});

// ---------- weapon bar ----------
const NAMES=Squirmish.WEAPONS.map(w=>w.n);
const ICONS=[
'<rect x="9" y="8" width="22" height="16" rx="7" fill="#e63946"/><rect x="30" y="10" width="9" height="12" rx="2" fill="#f1faee" stroke="#555"/><path d="M15 9v7M21 9v7M27 9v7" stroke="#8d1f2a" stroke-width="1.5"/>',
'<path d="M8 16L3 8h11zM8 16L3 24h11z" fill="#ff9f1c"/><path d="M8 16l8-6h18l10 6-10 6H16z" fill="#cfd8dc" stroke="#37474f"/><path d="M34 10l10 6-10 6z" fill="#ef476f"/>',
'<circle cx="17" cy="17" r="10" fill="#8e5bd1" stroke="#3d2a63"/><path d="M17 7l3-4" stroke="#444"/><circle cx="35" cy="9" r="4" fill="#ff9f1c"/><circle cx="41" cy="20" r="4" fill="#ff9f1c"/><circle cx="32" cy="26" r="3.5" fill="#ff9f1c"/>',
'<path d="M14 11H8L3 25h9l4-5z" fill="#8d5524"/><rect x="14" y="10" width="31" height="4" fill="#607d8b"/><rect x="14" y="15" width="31" height="4" fill="#455a64"/>',
'<rect x="11" y="10" width="8" height="19" rx="2" fill="#d62839"/><rect x="20" y="10" width="8" height="19" rx="2" fill="#d62839"/><rect x="29" y="10" width="8" height="19" rx="2" fill="#d62839"/><rect x="10" y="17" width="28" height="4" fill="#f1faee"/><path d="M24 10q4-7 11-5" stroke="#444" fill="none"/><circle cx="35" cy="5" r="2.5" fill="#ffd166"/>',
'<path d="M4 16L18 14L24 4H28L25 14L38 15L44 12V20L38 17L25 18L28 28H24L18 18Z" fill="#78909c" stroke="#37474f"/>'];
const wbar=$('#weapons'),who=$('#who');let wkey='';
wbar.innerHTML=ORDER.map((i,n)=>`<button class="w" data-i="${i}" aria-label="${NAMES[i]}"><kbd class="k">${n+1}</kbd><svg viewBox="0 0 48 32">${ICONS[i]}</svg><small>${NAMES[i]}</small><span class="a"></span></button>`).join('');
wbar.onclick=e=>{const b=e.target.closest('.w');if(!b)return;const n=ORDER.indexOf(+b.dataset.i)+1;if(n>0){press(String(n),true);press(String(n),false)}b.blur()};
function renderWeapons(){
  const online=mode==='match',my=online?ls.myTeam:-1,act=game.active(),curTeam=act?act.team:null;
  // online, the bar always shows your own team's ammo; spectators see whoever is playing
  const team=my>=0?game.teams[my]:curTeam,mine=!online||(my>=0&&game.cur===my);
  const am=team?team.ammo:[],sel=mine&&game.phase!=='over'?game.weapon:-1;
  let label='';
  if(!online)label=team?team.name+'’s arsenal':'';
  else if(game.phase==='over')label=game.winner?game.winner.name+' won':'Draw';
  else if(my<0)label=curTeam?'Watching · '+curTeam.name+'’s turn':'Watching';
  else label=mine?'Your turn! Your arsenal':curTeam?'Waiting for '+curTeam.name+' · your arsenal':'Your arsenal';
  const key=[mode,label,sel,am.join(),mine].join('|');
  if(key===wkey)return;wkey=key;
  who.textContent=label;wbar.classList.toggle('dim',online&&!mine);
  [...wbar.children].forEach(b=>{const i=+b.dataset.i;b.classList.toggle('on',i===sel);b.classList.toggle('empty',i>0&&!!team&&am[i]<1);b.querySelector('.a').textContent=i?(team?am[i]:''):'∞'});
}

// ---------- status line and overlays ----------
let netKey='';
function renderNet(){
  const el=$('#net'),bad=net.status!=='online',text=bad?(net.status==='reconnecting'?'Reconnecting…':'Connecting…'):net.ping==null?'Connected':net.ping+' ms';
  if(text+bad===netKey)return;netKey=text+bad;el.textContent=text;el.classList.toggle('bad',bad);el.title=bad?'':'Connected, round trip '+text;
}
function updateBanner(){
  if(mode!=='match'){banner.hidden=true;return}
  let t='';
  if(net.status!=='online')t='Connection lost, reconnecting…';
  else if(ls.resyncing)t='Out of sync, re-syncing…';
  else if(ls.behind>120)t='Catching up…';
  else if(net.over)t=`${net.over.name?net.over.name+' wins!':'Draw!'} Back to the lobby in ${Math.max(1,Math.ceil((net.over.backInMs-(performance.now()-net.over.at))/1000))} s`;
  else if(ls.waiting.length)t='Waiting for '+ls.waiting.map(id=>nameOf(id)||'a player').join(', ')+'…';
  else if(performance.now()<toastUntil)t=toastText;
  banner.hidden=!t;if(banner.textContent!==t)banner.textContent=t;
}

// ---------- main loop ----------
// Online, the simulation runs at 60 fps up to upTo. When it falls behind (slow device, tab back from the background,
// joining mid-match) it runs extra frames, capped per animation frame, with a time budget for big gaps.
let last=0,acc=0,oacc=0;
function stepOnline(dt,background){
  oacc=Math.min(oacc+dt*60/1000,10);let n=Math.floor(oacc);oacc-=n;
  const behind=ls.behind;
  if(background||behind>120){quiet=true;ls.pump(Infinity,background?40:8);quiet=false;return}
  if(behind>n+6)n+=Math.ceil((behind-n-6)/4); // ease back toward the server's clock
  ls.pump(Math.min(n,10));
}
function loop(t){
  const dt=Math.min(250,t-last);last=t;
  if(mode==='offline'){acc+=Math.min(100,dt);while(acc>=1000/60){if(game.phase!=='menu')game.update();acc-=1000/60}}
  else if(mode==='match')stepOnline(dt,false);
  game.draw();renderWeapons();renderNet();updateBanner();
  requestAnimationFrame(loop);
}
// hidden tabs get no animation frames (and throttled timers), so keep the simulation moving from a timer
setInterval(()=>{if(document.hidden&&mode==='match')stepOnline(0,true)},250);

if(location.hash==='#debug')window.__sq={game,ls,net}; // for tests and poking around
game.preview(1);route();requestAnimationFrame(loop);
