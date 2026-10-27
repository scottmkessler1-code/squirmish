// Rooms and lobby: membership, seats, readiness, host, match start and the return to the lobby.
// Socket-agnostic: each member carries a send(msg) function, and the clock is injected so tests can fast-forward time.
const crypto=require('crypto');
const {GAMEKEYS}=require('../public/game.js');

const CODE_ALPHABET='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L
const CODE_LEN=5,MAX_PLAYERS=6,MAX_SPECTATORS=20,MIN_PLAYERS=2,NAME_MAX=12;
const LOBBY_GRACE_MS=60_000;        // a dropped lobby member keeps their seat this long
const ROOM_IDLE_MS=30*60_000;       // rooms with nobody connected are deleted after this
const BACK_TO_LOBBY_MS=5_000;       // results screen before everyone returns to the lobby
const FORFEIT_MS=60_000;            // a player who dropped mid-match has this long to come back before their team forfeits
// lockstep clock
const FPS=60;                       // server frames per second (tests may speed this up)
const INPUT_DELAY=6;                // inputs are stamped this many frames after the server receives them
// pause the clock when a player's ack falls this far behind, resume under this. Acks trail the clock by about
// RTT + the client ack interval (200 ms) + the step interval even when all is well, so these leave room for a ~400 ms ping.
const STALL_LAG_S=1.5,RESUME_LAG_S=0.75;
const STALL_MAX_MS=8_000;           // after this long, stop waiting for the laggards (they catch up on their own)
// desync detection
const HASH_EVERY=120;               // clients report stateHash() on frames divisible by this
const HASH_WAIT_MS=3_000;           // compare a frame's hashes once everyone reported, or after this long
const SNAPSHOT_WAIT_MS=5_000;       // a snapshot provider that doesn't answer in time is replaced
const CHECKPOINT_EVERY=7_200;       // frames between checkpoint snapshots kept for late joiners (2 min)

const randomCode=()=>Array.from({length:CODE_LEN},()=>CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
const isCode=c=>typeof c==='string'&&c.length===CODE_LEN&&[...c].every(ch=>CODE_ALPHABET.includes(ch));
function cleanName(n){
  n=typeof n==='string'?n.replace(/\s+/g,' ').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,'').trim():'';
  return [...n].slice(0,NAME_MAX).join('').trim()||'Player';
}

class Room{
  constructor(code,now,{fps=FPS,forfeitMs=FORFEIT_MS}={}){
    this.code=code;this.fps=fps;this.forfeitMs=forfeitMs;this.members=new Map(); // token -> member
    this.state='lobby';this.hostId=null;this.match=null;this.emptySince=now;this.returnAt=0;this.nextId=1;
  }
  get list(){return [...this.members.values()]}
  get players(){return this.list.filter(m=>m.role==='player').sort((a,b)=>a.slot-b.slot)}
  get spectators(){return this.list.filter(m=>m.role==='spectator')}
  get connected(){return this.list.filter(m=>m.connected)}
  byId(id){return this.list.find(m=>m.id===id)}

  view(){
    const pub=m=>({id:m.id,name:m.name,connected:m.connected});
    return {state:this.state,host:this.hostId,
      players:this.players.map(m=>({...pub(m),slot:m.slot,ready:m.ready})),
      spectators:this.spectators.map(pub)};
  }
  broadcast(msg){for(const m of this.members.values())if(m.connected)m.send(msg)}
  broadcastLobby(){this.broadcast({t:'lobby',...this.view()})}

  uniqueName(name,except){
    const taken=new Set(this.list.filter(m=>m!==except).map(m=>m.name.toLowerCase()));
    if(!taken.has(name.toLowerCase()))return name;
    for(let i=2;;i++){const s=' '+i,n=[...name].slice(0,NAME_MAX-s.length).join('').trim()+s;if(!taken.has(n.toLowerCase()))return n}
  }
  // seats are kept packed (0..n-1) in the lobby, so seat = team index = colour
  pack(){this.players.forEach((m,i)=>m.slot=i)}
  seatFree(){return this.state==='lobby'&&this.players.length<MAX_PLAYERS}

  join({name,token,spectate},send,now){
    let m=token&&this.members.get(token);
    if(m){ // reconnect: same seat, same role
      const was=m.connected,old=m.send;m.send=send;m.connected=true;m.leftAt=0;
      if(was&&old!==send)old({t:'replaced'}); // another tab took over this seat
      this.match?.clock.synced.delete(m.id); // catching up from the log; don't stall others meanwhile
      if(this.state==='lobby'&&typeof name==='string')m.name=this.uniqueName(cleanName(name),m);
    }else{
      if(this.members.size>=MAX_PLAYERS+MAX_SPECTATORS)return {error:'room_full'};
      const asPlayer=!spectate&&this.seatFree();
      if(!asPlayer&&this.spectators.length>=MAX_SPECTATORS)return {error:'room_full'};
      m={id:'m'+this.nextId++,token:crypto.randomBytes(16).toString('hex'),name:this.uniqueName(cleanName(name)),
        role:asPlayer?'player':'spectator',slot:asPlayer?this.players.length:-1,ready:false,send,connected:true,leftAt:0};
      this.members.set(m.token,m);
    }
    this.emptySince=0;
    if(!this.hostId||!this.byId(this.hostId)?.connected)this.hostId=m.id;
    const welcome={t:'welcome',you:this.you(m),token:m.token,...this.view(),code:this.code,
      seatWanted:!spectate&&m.role==='spectator'}; // asked to play but the room was full or mid-match
    if(this.match){const c=this.match.clock; // late joiners fast-forward from frame 0 using the full input log
      const cp=this.match.sync.checkpoint,from=cp?cp.frame:0; // start from the latest checkpoint when there is one
      welcome.match={seed:this.match.seed,names:this.match.names,startFrame:0,snapshot:cp?cp.data:undefined,
        inputs:c.log.filter(e=>e.f>from&&e.f<=c.sentUpTo),upTo:c.sentUpTo,done:!!this.match.done,e:this.match.sync.epoch.get(m.id)||0}}
    m.send(welcome);
    this.broadcastLobby();
    return {member:m};
  }
  you(m){return {id:m.id,name:m.name,role:m.role,slot:m.slot,team:this.match?this.match.teamOf.get(m.id)??-1:m.role==='player'?m.slot:-1}}

  disconnect(m,now){
    if(!m.connected)return;
    m.connected=false;m.leftAt=now;
    if(this.hostId===m.id)this.promoteHost();
    if(!this.connected.length)this.emptySince=now;
    this.broadcastLobby();
  }
  // leaving on purpose: gone at once, no grace period
  leave(m,now){
    this.members.delete(m.token);m.connected=false;
    if(this.match&&this.match.teamOf.has(m.id))this.forfeit(this.match.teamOf.get(m.id),m.id,'left',now);
    if(this.state==='lobby')this.pack();
    if(this.hostId===m.id)this.promoteHost();
    if(!this.connected.length)this.emptySince=now;
    this.broadcastLobby();
  }
  promoteHost(){
    const next=this.players.find(m=>m.connected)||this.spectators.find(m=>m.connected);
    this.hostId=next?next.id:null;
    if(next)this.broadcast({t:'host',id:next.id,slot:next.slot});
  }

  setReady(m,ready){if(this.state!=='lobby'||m.role!=='player')return 'not_in_lobby';m.ready=!!ready;this.broadcastLobby()}
  setName(m,name){if(this.state!=='lobby')return 'not_in_lobby';m.name=this.uniqueName(cleanName(name),m);m.send({t:'you',you:this.you(m)});this.broadcastLobby()}
  setRole(m,spectate){
    if(this.state!=='lobby')return 'not_in_lobby';
    if(spectate&&m.role==='player'){m.role='spectator';m.slot=-1;m.ready=false;this.pack()}
    else if(!spectate&&m.role==='spectator'){if(!this.seatFree())return 'room_full';m.slot=this.players.length;m.role='player';m.ready=false}
    m.send({t:'you',you:this.you(m)});this.broadcastLobby();
  }

  start(m,now,seed=crypto.randomInt(2**32)){
    if(m.id!==this.hostId)return 'not_host';
    if(this.state!=='lobby')return 'not_in_lobby';
    const ps=this.players;
    if(ps.length<MIN_PLAYERS)return 'need_players';
    if(!ps.every(p=>p.ready&&p.connected))return 'not_ready';
    this.pack();
    this.state='playing';
    this.match={seed,names:ps.map(p=>p.name),teamOf:new Map(ps.map(p=>[p.id,p.slot])),left:new Set(),over:new Map(),startedAt:now,
      clock:{frame:0,acc:0,last:now,sentUpTo:0,pending:[],log:[],acks:new Map(),synced:new Set(),stalled:null,stallSince:0},
      // reports: frame -> {at, hs: id -> hash}; agreed: frame -> hash; epoch: id -> snapshots sent to that member
      sync:{reports:new Map(),agreed:new Map(),epoch:new Map(),resync:null,checkpoint:null,resyncs:0}};
    for(const x of this.list)if(x.connected)x.send({t:'start',seed,names:this.match.names,startFrame:0,you:this.you(x)});
    this.broadcastLobby();
  }
  // players report the end of the match; a majority of connected players agreeing on the result ends it,
  // so one misbehaving client can't end a match early
  reportOver(m,{frame,winner},now){
    const mt=this.match;
    if(this.state!=='playing'||!mt||!mt.teamOf.has(m.id)||mt.done)return;
    if(!Number.isInteger(frame)||!Number.isInteger(winner))return 'bad_message';
    mt.over.set(m.id,frame+':'+winner);
    const voters=this.players.filter(p=>p.connected&&mt.teamOf.has(p.id)),tally=new Map();
    for(const p of voters){const v=mt.over.get(p.id);if(v)tally.set(v,(tally.get(v)||0)+1)}
    for(const [v,n] of tally)if(n*2>voters.length){
      const w=+v.split(':')[1];mt.done=true;this.returnAt=now+BACK_TO_LOBBY_MS;
      this.broadcast({t:'match_over',winner:w,name:w>=0?mt.names[w]:null,backInMs:BACK_TO_LOBBY_MS});
      return;
    }
  }
  backToLobby(){
    this.state='lobby';this.match=null;this.returnAt=0;
    for(const m of this.list){m.ready=false;if(m.role==='player'&&!m.connected)this.members.delete(m.token)} // dropped during the match: seat freed
    this.pack();
    if(!this.byId(this.hostId)?.connected)this.promoteHost();
    for(const m of this.list)if(m.connected)m.send({t:'you',you:this.you(m)});
    this.broadcastLobby();
  }

  // ---- lockstep clock: the server never simulates; it stamps inputs with a frame and tells clients how far they may run
  input(m,{k,d}){
    const mt=this.match;
    if(this.state!=='playing'||!mt||mt.done)return 'not_playing';
    const team=mt.teamOf.get(m.id);
    if(team===undefined||mt.left.has(team))return 'not_playing';
    if(!GAMEKEYS.includes(k)||typeof d!=='boolean')return 'bad_message';
    this.stamp(team,k,d);
  }
  stamp(p,k,d){
    const c=this.match.clock,ev={f:Math.max(c.frame+INPUT_DELAY,c.sentUpTo+1),p,k,d}; // never a frame clients may already have run
    c.log.push(ev);c.pending.push(ev);
  }
  // the team is out: every client applies the same 'forfeit' input on the same frame
  forfeit(team,id,reason,now){
    const mt=this.match;
    if(!mt||mt.done||mt.left.has(team))return;
    mt.left.add(team);this.stamp(team,'forfeit',true);
    this.broadcast({t:'player_left',slot:team,id,reason});
    this.checkAbandoned(now);
  }
  // nobody left who could report the end (at most one team still in, and none of the seated players connected):
  // the server ends the match itself so spectators aren't stuck on a finished game
  checkAbandoned(now){
    const mt=this.match;if(!mt||mt.done)return;
    const inTeams=[...new Set(mt.teamOf.values())].filter(t=>!mt.left.has(t));
    const voters=this.players.filter(p=>p.connected&&mt.teamOf.has(p.id));
    if(inTeams.length>1||voters.length)return;
    const w=inTeams.length===1?inTeams[0]:-1;mt.done=true;this.returnAt=now+BACK_TO_LOBBY_MS;
    this.broadcast({t:'match_over',winner:w,name:w>=0?mt.names[w]:null,backInMs:BACK_TO_LOBBY_MS});
  }
  ack(m,frame){
    const c=this.match?.clock;
    if(!c||!Number.isInteger(frame))return;
    c.acks.set(m.id,frame);
    if(c.frame-frame<=RESUME_LAG_S*this.fps)c.synced.add(m.id);
  }
  tickClock(now){
    if(this.returnAt&&now>=this.returnAt)return this.backToLobby();
    if(this.match)this.tickSync(now);
    const mt=this.match;
    if(this.state==='playing'&&mt&&!mt.done){
      for(const [id,team] of mt.teamOf){const m=this.byId(id);if(m&&!m.connected&&now-m.leftAt>=this.forfeitMs)this.forfeit(team,id,'timeout',now)}
      this.checkAbandoned(now);
    }
    if(this.state!=='playing'||!mt||mt.done)return;
    const c=mt.clock,dt=Math.min(250,now-c.last);c.last=now;
    // wait for connected, caught-up players whose acks fall behind; never for spectators or players still catching up
    const lim=(c.stalled?RESUME_LAG_S:STALL_LAG_S)*this.fps;
    let waiting=this.players.filter(p=>p.connected&&c.synced.has(p.id)&&!mt.left.has(mt.teamOf.get(p.id))&&c.frame-(c.acks.get(p.id)??0)>lim).map(p=>p.id);
    if(waiting.length&&c.stalled&&now-c.stallSince>=STALL_MAX_MS){for(const id of waiting)c.synced.delete(id);waiting=[]}
    if(waiting.join()!==(c.stalled||[]).join()){
      if(!c.stalled)c.stallSince=now;
      c.stalled=waiting.length?waiting:null;
      this.broadcast({t:'stall',waiting});
    }
    if(!c.stalled){c.acc+=dt*this.fps/1000;const n=Math.floor(c.acc);c.acc-=n;c.frame+=n}
    // every input from now on is stamped >= frame+INPUT_DELAY, so clients may safely run up to frame+INPUT_DELAY-1
    const upTo=c.frame+INPUT_DELAY-1;
    if(upTo>c.sentUpTo){
      const inputs=c.pending.filter(e=>e.f<=upTo);c.pending=c.pending.filter(e=>e.f>upTo);c.sentUpTo=upTo;
      this.broadcast({t:'step',upTo,inputs});
    }
  }

  // ---- desync detection and recovery
  // Clients report stateHash() every HASH_EVERY frames. When a frame's reports disagree, the majority wins (ties go to the
  // host's side). Each client that disagrees gets a snapshot from a client that agrees, plus every input logged after
  // the snapshot's frame. Only the diverged clients jump; everyone else keeps playing.
  hash(m,{frame,h,e},now){
    const sy=this.match?.sync;
    if(!sy||!Number.isInteger(frame)||frame<=0||frame%HASH_EVERY||!Number.isInteger(h))return;
    if((e|0)<(sy.epoch.get(m.id)||0))return; // computed before this client loaded its last snapshot
    if(sy.agreed.has(frame)){if(sy.agreed.get(frame)!==h)this.startResync([m.id],null,frame,now);return}
    let r=sy.reports.get(frame);
    if(!r){r={at:now,hs:new Map()};sy.reports.set(frame,r)}
    r.hs.set(m.id,h);
  }
  tickSync(now){
    const sy=this.match.sync,ids=this.connected.map(m=>m.id);
    for(const [frame,r] of sy.reports){
      if(!ids.every(id=>r.hs.has(id))&&now-r.at<HASH_WAIT_MS)continue; // wait for everyone, but not for long
      sy.reports.delete(frame);
      const groups=new Map();for(const [id,h] of r.hs){if(!groups.has(h))groups.set(h,[]);groups.get(h).push(id)}
      const ranked=[...groups].sort((a,b)=>b[1].length-a[1].length||(b[1].includes(this.hostId)-a[1].includes(this.hostId)));
      const [good,goodIds]=ranked[0];
      sy.agreed.set(frame,good);
      const bad=ranked.slice(1).flatMap(g=>g[1]);
      if(bad.length)this.startResync(bad,goodIds,frame,now);
      else if(!sy.resync&&frame-(sy.checkpoint?.frame||0)>=CHECKPOINT_EVERY)this.startResync([],goodIds,frame,now); // checkpoint only
    }
    for(const f of sy.agreed.keys())if(sy.agreed.size>64)sy.agreed.delete(f);else break;
    const rs=sy.resync;
    if(rs&&now-rs.at>=SNAPSHOT_WAIT_MS){ // provider gone quiet: ask someone else from the good side
      const next=this.pickProvider(rs.candidates.filter(id=>!rs.tried.has(id)));
      if(next){rs.provider=next;rs.tried.add(next);rs.at=now;this.byId(next).send({t:'snapshot_req'})}
      else sy.resync=null; // nobody left to ask; the next hash round tries again
    }
  }
  pickProvider(ids){
    const ok=ids.map(id=>this.byId(id)).filter(m=>m&&m.connected);
    return (ok.find(m=>m.id===this.hostId)||ok.find(m=>m.role==='player')||ok[0])?.id;
  }
  startResync(bad,goodIds,frame,now){
    const sy=this.match.sync;
    for(const id of bad)this.byId(id)?.send({t:'desync',frame});
    if(sy.resync){for(const id of bad)sy.resync.targets.add(id);return}
    const candidates=(goodIds||this.connected.map(m=>m.id)).filter(id=>!bad.includes(id));
    const provider=this.pickProvider(candidates);
    if(!provider)return;
    sy.resync={provider,candidates,tried:new Set([provider]),targets:new Set(bad),at:now};
    this.byId(provider).send({t:'snapshot_req'});
  }
  // a client asks for a resync itself (it noticed it can't be right, e.g. an input arrived for a frame it already ran)
  requestResync(m,now){
    if(!this.match||this.state!=='playing'||now-(m.lastResync||-Infinity)<SNAPSHOT_WAIT_MS)return; // one at a time per client
    m.lastResync=now;this.startResync([m.id],null,0,now);
  }
  snapshot(m,{data}){
    const mt=this.match,sy=mt?.sync,rs=sy?.resync;
    if(!rs||rs.provider!==m.id)return 'unexpected';
    if(!data||typeof data!=='object'||!Number.isInteger(data.frame)||data.frame<0||data.frame>mt.clock.sentUpTo)return 'bad_message';
    sy.resync=null;sy.checkpoint={frame:data.frame,data};
    const c=mt.clock,inputs=c.log.filter(e=>e.f>data.frame&&e.f<=c.sentUpTo);
    for(const id of rs.targets){
      const t=this.byId(id);if(!t||!t.connected)continue;
      const e=(sy.epoch.get(id)||0)+1;sy.epoch.set(id,e);sy.resyncs++;
      t.send({t:'snapshot',data,inputs,upTo:c.sentUpTo,e});
    }
  }

  // housekeeping; returns false when the room should be deleted
  tick(now){
    if(this.returnAt&&now>=this.returnAt)this.backToLobby();
    if(this.state==='lobby'){
      const stale=this.list.filter(m=>!m.connected&&now-m.leftAt>=LOBBY_GRACE_MS);
      if(stale.length){for(const m of stale)this.members.delete(m.token);this.pack();this.broadcastLobby()}
    }
    return !(this.emptySince&&now-this.emptySince>=ROOM_IDLE_MS);
  }
}

class Rooms{
  constructor({now=Date.now,maxRooms=500,fps=FPS,forfeitMs=FORFEIT_MS}={}){this.rooms=new Map();this.now=now;this.maxRooms=maxRooms;this.opts={fps,forfeitMs}}
  create(){
    if(this.rooms.size>=this.maxRooms)return null;
    let code;do code=randomCode();while(this.rooms.has(code));
    const r=new Room(code,this.now(),this.opts);this.rooms.set(code,r);return r;
  }
  get(code){return typeof code==='string'?this.rooms.get(code.toUpperCase()):undefined}
  tickClocks(){const now=this.now();for(const r of this.rooms.values())r.tickClock(now)}
  sweep(){const now=this.now();for(const [c,r] of this.rooms)if(!r.tick(now))this.rooms.delete(c)}
}

module.exports={Rooms,Room,cleanName,isCode,CODE_ALPHABET,MAX_PLAYERS,MAX_SPECTATORS,LOBBY_GRACE_MS,ROOM_IDLE_MS,BACK_TO_LOBBY_MS,FORFEIT_MS,
  FPS,INPUT_DELAY,STALL_LAG_S,RESUME_LAG_S,STALL_MAX_MS,HASH_EVERY,HASH_WAIT_MS,SNAPSHOT_WAIT_MS,CHECKPOINT_EVERY};
