// HTTP + WebSocket server: serves the game page and runs rooms in memory (one process, one instance).
const http=require('http'),path=require('path'),express=require('express'),{WebSocketServer}=require('ws');
const {Rooms,isCode}=require('./rooms');

const PUBLIC=path.join(__dirname,'..','public');
const MAX_MSG=2048;              // bytes, for everything except snapshots
const MAX_SNAPSHOT=1<<20;        // bytes
const RATE=30,BURST=60;          // messages per second per socket, token bucket
const MAX_DROPPED=120;           // close sockets that keep flooding
const HEARTBEAT_MS=15_000,SWEEP_MS=10_000,STEP_MS=50;
const CREATE_PER_MIN=20;         // new rooms per IP per minute

function createServer({now=Date.now,maxRooms,fps,forfeitMs,createPerMin=CREATE_PER_MIN}={}){
  const rooms=new Rooms({now,maxRooms,fps,forfeitMs});
  const app=express();
  app.disable('x-powered-by');app.set('trust proxy',1);
  app.use((req,res,next)=>{res.set('X-Content-Type-Options','nosniff');next()});

  const created=new Map(); // ip -> [timestamps]
  app.post('/api/rooms',(req,res)=>{
    const t=now(),ip=req.ip,recent=(created.get(ip)||[]).filter(x=>t-x<60_000);
    if(recent.length>=createPerMin)return res.status(429).json({error:'slow_down'});
    recent.push(t);created.set(ip,recent);
    const r=rooms.create();
    if(!r)return res.status(503).json({error:'server_full'});
    res.json({code:r.code});
  });
  app.get('/api/rooms/:code',(req,res)=>{
    const r=rooms.get(req.params.code);
    if(!r)return res.status(404).json({error:'no_room'});
    const v=r.view();res.json({code:r.code,state:v.state,players:v.players.length,spectators:v.spectators.length});
  });
  app.get('/healthz',(req,res)=>res.json({ok:true,rooms:rooms.rooms.size}));
  const page=(req,res)=>res.sendFile(path.join(PUBLIC,'squirmish.html'));
  app.get('/',page);
  app.get('/r/:code',page);
  app.use(express.static(PUBLIC,{index:false}));

  const server=http.createServer(app);
  const wss=new WebSocketServer({server,path:'/ws',maxPayload:MAX_SNAPSHOT});

  wss.on('connection',ws=>{
    let room=null,me=null,tokens=BURST,lastRefill=now(),dropped=0;
    ws.isAlive=true;ws.on('pong',()=>ws.isAlive=true);
    const send=msg=>{if(ws.readyState===ws.OPEN)ws.send(JSON.stringify(msg));if(msg.t==='replaced')ws.close(4001,'replaced')};
    const fail=(code,close)=>{send({t:'error',code});if(close)ws.close(4000,code)};

    ws.on('message',(data,isBinary)=>{
      const t=now();tokens=Math.min(BURST,tokens+(t-lastRefill)*RATE/1000);lastRefill=t;
      if(tokens<1){if(++dropped>MAX_DROPPED)ws.close(1008,'rate_limited');return}
      tokens--;
      if(isBinary)return fail('bad_message');
      let msg;try{msg=JSON.parse(data)}catch{return fail('bad_message')}
      if(!msg||typeof msg!=='object'||typeof msg.t!=='string')return fail('bad_message');
      if(data.length>MAX_MSG&&msg.t!=='snapshot')return fail('too_big');

      if(!me){
        if(msg.t!=='join')return fail('join_first');
        const code=typeof msg.room==='string'?msg.room.toUpperCase():'';
        room=isCode(code)&&rooms.get(code);
        if(!room)return fail('no_room',true);
        const r=room.join({name:msg.name,token:typeof msg.token==='string'?msg.token:null,spectate:!!msg.spectate},send,t);
        if(r.error){room=null;return fail(r.error,true)}
        me=r.member;return;
      }
      let err;
      switch(msg.t){
        case 'ping':send({t:'pong',c:msg.c});break;
        case 'ready':err=room.setReady(me,msg.ready);break;
        case 'name':err=room.setName(me,msg.name);break;
        case 'role':err=room.setRole(me,msg.spectate);break;
        case 'start':err=room.start(me,t);break;
        case 'input':err=room.input(me,msg);break;
        case 'ack':room.ack(me,msg.frame);break;
        case 'hash':room.hash(me,msg,t);break;
        case 'snapshot':err=room.snapshot(me,msg);break;
        case 'resync':room.requestResync(me,t);break;
        case 'over':err=room.reportOver(me,msg,t);break;
        case 'leave':room.leave(me,t);me=null;room=null;ws.close(1000,'left');break;
        default:err='unknown_type';
      }
      if(err)fail(err);
    });
    // a socket replaced by a newer tab must not mark the member as disconnected
    ws.on('close',()=>{if(me&&me.send===send)room.disconnect(me,now())});
  });

  const beat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},HEARTBEAT_MS);
  const sweep=setInterval(()=>{rooms.sweep();const t=now();for(const [ip,ts] of created)if(!ts.some(x=>t-x<60_000))created.delete(ip)},SWEEP_MS);
  const step=setInterval(()=>rooms.tickClocks(),STEP_MS);
  const close=()=>new Promise(res=>{clearInterval(beat);clearInterval(sweep);clearInterval(step);for(const ws of wss.clients)ws.terminate();wss.close();server.close(()=>res())});
  return {app,server,wss,rooms,close};
}

if(require.main===module){
  const port=+process.env.PORT||3000;
  createServer().server.listen(port,()=>console.log('Caterpillar Continental Combat on http://localhost:'+port));
}
module.exports={createServer};
