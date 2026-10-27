// Client side of the server-clocked lockstep. Feeds server-stamped inputs into the game and only lets the
// simulation run up to the frame the server allows (upTo). Transport-agnostic: give it send(msg) and pass every
// server message to onMessage(). Runs in the browser and in Node (tests).
(function(root){
'use strict';
const ACK_EVERY_MS=200;

function createLockstep({game,send,now=()=>Date.now(),onFrame=null,onDesync=null}){
  let upTo=0,started=false,myTeam=-1,reported=false,lastAck=-1,lastAckAt=-Infinity,waiting=[];

  function begin({seed,names,inputs=[],upTo:u=0},team){
    game.startGame(names,seed);
    for(const e of inputs)game.submitInput({...e});
    upTo=u;started=true;myTeam=team;reported=false;lastAck=-1;lastAckAt=-Infinity;waiting=[];
  }
  function onMessage(m){
    switch(m.t){
      case 'welcome':if(m.match)begin(m.match,m.you.team);else started=false;break;
      case 'start':begin(m,m.you.team);break;
      case 'you':if(started&&m.you.team!==undefined)myTeam=m.you.team;break;
      case 'step':
        if(!started)return;
        for(const e of m.inputs){
          // can't happen with an ordered stream and a correct server; if it does, this client has diverged
          if(e.f<=game.frame&&onDesync)onDesync({reason:'late_input',frame:game.frame,input:e});
          game.submitInput({...e});
        }
        upTo=m.upTo;break;
      case 'stall':waiting=m.waiting;break;
      case 'lobby':if(m.state==='lobby')started=false;break;
    }
  }
  // Runs the simulation toward upTo, at most maxFrames frames or budgetMs of wall time. Returns frames run.
  function pump(maxFrames=Infinity,budgetMs=Infinity){
    if(!started)return 0;
    const t0=now();let n=0;
    while(game.frame<upTo&&n<maxFrames){
      game.update();n++;
      if(onFrame)onFrame(game);
      // report the end at the exact frame it happened, so every client sends the same thing
      if(!reported&&game.phase==='over'){reported=true;send({t:'over',frame:game.frame,winner:game.teams.indexOf(game.winner)})}
      if((n&15)===0&&now()-t0>=budgetMs)break;
    }
    const t=now();
    if(game.frame!==lastAck&&t-lastAckAt>=ACK_EVERY_MS){send({t:'ack',frame:game.frame});lastAck=game.frame;lastAckAt=t}
    return n;
  }
  // Only the team whose turn it is may send, judged by the local view of the game.
  function input(k,d){
    if(!started||myTeam<0||game.cur!==myTeam||game.phase==='over')return false;
    send({t:'input',k,d});return true;
  }
  return {onMessage,pump,input,
    get started(){return started},get upTo(){return upTo},get behind(){return upTo-game.frame},
    get myTeam(){return myTeam},get waiting(){return waiting}};
}

const api={createLockstep,ACK_EVERY_MS};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.Lockstep=api;
})(this);
