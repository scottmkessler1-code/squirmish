// End-to-end browser check (Playwright + Chromium): three separate browser profiles play through the real server.
// Create a room, join by link, watch, ready, start, take turns, stay in sync, stall overlay, reload-rejoin, leave.
// Run: npm run check:online   (screenshots go to ./screens/)
const {chromium}=require('playwright'),assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {createServer}=require('../server');
const SHOTS=path.join(__dirname,'..','screens');fs.mkdirSync(SHOTS,{recursive:true});
const shot=(p,n)=>p.screenshot({path:path.join(SHOTS,n+'.png')});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async()=>{
  const srv=createServer();await new Promise(r=>srv.server.listen(0,r));
  const base='http://localhost:'+srv.server.address().port,browser=await chromium.launch(),errors=[];
  const open=async(name)=>{const ctx=await browser.newContext({viewport:{width:1100,height:900}}),p=await ctx.newPage();
    p.on('pageerror',e=>errors.push(name+': '+e.message));p.on('console',m=>m.type()==='error'&&errors.push(name+': '+m.text()));return p};
  // records stateHash every 60 frames in a page, so pages can be compared at the same frames
  const record=p=>p.evaluate(()=>{const g=__sq.game,u=g.update;window.__hist={};g.update=()=>{u();if(g.frame%60===0)__hist[g.frame]=g.stateHash()}});
  const compare=async(pages,label)=>{
    const hs=await Promise.all(pages.map(p=>p.evaluate(()=>__hist)));
    const common=Object.keys(hs[0]).filter(f=>hs.every(h=>f in h));
    assert.ok(common.length>=3,label+': too few common frames ('+common.length+')');
    for(const f of common)assert.ok(hs.every(h=>h[f]===hs[0][f]),`${label}: desync at frame ${f}`);
    console.log(`${label}: ${pages.length} pages agree on ${common.length} sampled frames`);
  };
  try{
    // host creates a room
    const A=await open('A');await A.goto(base+'/#debug');
    await A.fill('#nm','Ann');await A.click('[data-act=create]');
    await A.waitForSelector('#seats li.me');
    const code=A.url().match(/\/r\/(\w{5})/)[1];console.log('room',code);
    // a friend opens the invite link, another just watches
    const B=await open('B');await B.goto(base+'/r/'+code+'#debug');
    await B.waitForSelector('#nm');await B.fill('#nm','Bo');await B.click('[data-act=join]');
    const C=await open('C');await C.goto(base+'/r/'+code+'#debug');
    await C.fill('#nm','Cy');await C.click('[data-act=watch]');
    await A.waitForFunction(()=>document.querySelectorAll('#seats li:not(.empty)').length===2&&/Cy/.test(document.querySelector('#specs').textContent));
    assert.equal(await A.isDisabled('#startBtn'),true,'start enabled before anyone is ready');
    assert.equal(await B.isVisible('#startBtn'),false,'non-host sees start');
    // host picks 4 caterpillars per team and 20 s turns; the guest sees it, and it widens the map
    assert.equal(await B.$$eval('[data-set]',l=>l.length),0,'guest can change settings');
    await A.click('[data-set=worms][data-v="4"]');await A.click('[data-set=turn][data-v="20"]');
    await B.waitForFunction(()=>/4 caterpillars per team · 20 s turns · 1.3× wide map/.test(document.querySelector('#settings').textContent));
    await A.click('#readyBtn');await B.click('#readyBtn');
    await A.waitForFunction(()=>!document.querySelector('#startBtn').disabled);
    await shot(A,'1-lobby');
    for(const p of [A,B,C])await record(p);
    await A.click('#startBtn');
    for(const p of [A,B,C])await p.waitForSelector('#me:not([hidden])');
    assert.match(await A.textContent('#me'),/You are team 1, Ann \(pink\)/);
    assert.match(await B.textContent('#me'),/You are team 2, Bo \(yellow\)/);
    assert.match(await C.textContent('#me'),/watching/);
    assert.equal(await A.isVisible('#again'),false,'hot-seat New game shown online');
    for(const p of [A,B,C])assert.deepEqual(await p.evaluate(()=>[__sq.game.worldWidth,__sq.game.worms.length]),[1280,8]);
    // drag the view, then click the far end of the minimap
    await A.waitForFunction(()=>__sq.game.phase==='aim');
    const cam0=await A.evaluate(()=>__sq.game.camX),box=await A.$eval('#c',c=>{const r=c.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width}});
    const startX=cam0>100?box.x+150:box.x+box.w-150;
    await A.mouse.move(startX,box.y+300);await A.mouse.down({button:'right'});await A.mouse.move(startX+(cam0>100?200:-200),box.y+300,{steps:5});await A.mouse.up({button:'right'});
    assert.equal(await A.evaluate(()=>__sq.game.getSnapshot().charging),false,'right-drag started a charge');
    const cam1=await A.evaluate(()=>__sq.game.camX);assert.ok(Math.abs(cam1-cam0)>150,`drag moved the view ${cam0} -> ${cam1}`);
    const s=box.w/960;await A.mouse.click(box.x+(cam1>100?331:629)*s,box.y+22*s);
    await A.waitForFunction(c=>Math.abs(__sq.game.camX-c)>200,cam1);
    await shot(A,'0-wide-map');
    console.log('wide map: 1280 px, drag and minimap move the view');
    // let the worms drop, then whoever's turn it is walks and fires; the other sees "Waiting for"
    const turnPage=async()=>{for(;;){for(const p of [A,B]){const mine=await p.evaluate(()=>__sq.game.phase==='aim'&&__sq.game.cur===__sq.ls.myTeam);if(mine)return p}await sleep(100)}};
    for(let turn=0;turn<3;turn++){
      const P=await turnPage(),O=P===A?B:A;
      // labels follow the game on the next drawn frame, and the other page may be a few frames behind: wait for them
      await P.waitForFunction(()=>/Your turn/.test(document.querySelector('#who').textContent),null,{timeout:3000});
      await O.waitForFunction(()=>/Waiting for/.test(document.querySelector('#who').textContent)&&document.querySelector('#weapons').classList.contains('dim'),null,{timeout:3000});
      if(turn===0)await shot(P,'2-my-turn');
      // the other player's keys must do nothing
      const before=await O.evaluate(()=>__sq.game.active().x);
      await O.keyboard.down('ArrowLeft');await sleep(300);await O.keyboard.up('ArrowLeft');
      { // a left click off your turn does nothing either
        const ob=await O.$eval('#c',c=>{const r=c.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height*.7]});
        await O.mouse.move(...ob);await O.mouse.down();await sleep(200);await O.mouse.up();
      }
      await sleep(300);assert.equal(await O.evaluate(()=>__sq.game.active().x),before,'off-turn player moved a worm');
      await P.keyboard.press(String(turn===2?6:1));
      await P.keyboard.down(turn%2?'ArrowLeft':'ArrowRight');await sleep(400);await P.keyboard.up(turn%2?'ArrowLeft':'ArrowRight');
      await P.keyboard.down('ArrowUp');await sleep(250);await P.keyboard.up('ArrowUp');
      if(turn===1){ // fire with the left mouse button instead of Space: hold to charge, release to fire
        const pb=await P.$eval('#c',c=>{const r=c.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height*.7]});
        await P.mouse.move(...pb);await P.mouse.down();await sleep(200);
        assert.equal(await P.evaluate(()=>__sq.game.getSnapshot().charging||__sq.game.phase!=='aim'),true,'mouse down did not charge');
        await sleep(300);await P.mouse.up();
      }else{await P.keyboard.down(' ');await sleep(500);await P.keyboard.up(' ');}
      await P.waitForFunction(()=>__sq.game.phase!=='aim',null,{timeout:5000});
      if(turn===0)await shot(C,'3-spectator');
    }
    await sleep(1500);await compare([A,B,C],'after 3 turns');
    // B's simulation freezes (like a stuck tab): A gets the stall overlay, then it clears
    await B.evaluate(()=>{window.__pump=__sq.ls.pump;__sq.ls.pump=()=>0});
    await A.waitForFunction(()=>/Waiting for Bo/.test(document.querySelector('#banner').textContent),null,{timeout:5000});
    await shot(A,'4-stall');
    await B.evaluate(()=>{__sq.ls.pump=window.__pump});
    await A.waitForFunction(()=>document.querySelector('#banner').hidden,null,{timeout:5000});
    console.log('stall overlay shown and cleared');
    // B reloads mid-match: rejoins with its saved token and fast-forwards
    await B.reload();await B.waitForSelector('#me:not([hidden])');
    assert.match(await B.textContent('#me'),/team 2, Bo/);
    await B.waitForFunction(()=>__sq.ls.started&&__sq.ls.behind<10);await record(B);
    await sleep(3000);await compare([A,B,C],'after reload');
    // B's state is corrupted (as if its browser computed something differently): hashes catch it, B loads A's snapshot
    await B.evaluate(()=>{const w=__sq.game.worms.find(w=>!w.dead);w.hp-=13;w.x+=5});
    await B.waitForFunction(()=>__sq.ls.resyncs>=1,null,{timeout:10000});
    await record(B);await sleep(3000);await compare([A,B,C],'after resync');
    await shot(B,'5-after-resync');await shot(A,'5-host-same-moment');
    // a reload now starts from the server's checkpoint snapshot, terrain picture included
    await B.reload();await B.waitForSelector('#me:not([hidden])');
    await B.waitForFunction(()=>__sq.ls.started&&__sq.ls.behind<10);await record(B);
    await sleep(3000);await compare([A,B,C],'after reload from checkpoint');
    await shot(B,'6-reloaded-from-checkpoint');
    // the spectator leaves: back to the home screen, gone from the room
    await C.click('#leave');await C.waitForSelector('[data-act=create]');
    assert.equal(new URL(C.url()).pathname,'/');
    await sleep(300);
    assert.equal(srv.rooms.get(code).spectators.length,0);
    // B leaves mid-match: A is told, B's team is out, A wins, and both A and the room return to the lobby
    B.on('dialog',d=>d.accept());
    await B.click('#leave');await B.waitForSelector('[data-act=create]');
    await A.waitForFunction(()=>/Bo left the match|wins!/.test(document.querySelector('#banner').textContent),null,{timeout:5000});
    await A.waitForFunction(()=>/Ann wins! Back to the lobby/.test(document.querySelector('#banner').textContent),null,{timeout:10000});
    await shot(A,'7-won-by-forfeit');
    await A.waitForSelector('#seats li.me',{timeout:10000});
    assert.equal(await A.$$eval('#seats li:not(.empty)',l=>l.length),1,'B still has a seat');
    assert.equal(await A.isVisible('#readyBtn'),true);
    await shot(A,'8-back-in-lobby');
    console.log('leave mid-match: forfeit, win banner, back to the lobby');
    assert.deepEqual(errors,[]);
    console.log('no page errors; screenshots in screens/');
  }finally{await browser.close();await srv.close()}
})().catch(e=>{console.error(e);process.exit(1)});
