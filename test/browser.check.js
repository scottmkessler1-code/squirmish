// Browser check (needs Playwright + Chromium): the page loads and plays, and a match replayed in the browser
// with full rendering produces exactly the Node trace, so drawing, particles and sound never touch the simulation.
// Run: node test/browser.check.js
const {chromium}=require('playwright'),path=require('path'),assert=require('assert/strict');
const {record}=require('./harness'),{createServer}=require('../server');
(async()=>{
  const srv=createServer();await new Promise(r=>srv.server.listen(0,r));
  const b=await chromium.launch(),page=await b.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>m.type()==='error'&&errors.push(m.text()));
  await page.goto('http://localhost:'+srv.server.address().port+'/#debug');
  // the hot-seat UI still works: start a 3-player game, walk, fire a rocket
  await page.click('[data-act=offline]');await page.click('.n[data-n="3"]');await page.click('[data-act=offgo]');
  await page.waitForTimeout(2500);
  await page.keyboard.down('ArrowRight');await page.waitForTimeout(400);await page.keyboard.up('ArrowRight');
  await page.keyboard.down(' ');await page.waitForTimeout(500);await page.keyboard.up(' ');
  await page.waitForTimeout(1500);
  await page.screenshot({path:path.resolve(__dirname,'../browser-check.png')});
  // same script, browser vs Node
  for(const [seed,names] of [[1,['Ann','Bo']],[7,['A','B','C','D','E','F']]]){
    const r=record(seed,names);
    const bt=await page.evaluate(({seed,names,script,frames})=>{
      const c=document.createElement('canvas');c.width=960;c.height=540;
      const g=Squirmish.createGame({document,ctx:c.getContext('2d')}),t=[];
      g.startGame(names,seed);[...script].sort((a,b)=>a.f-b.f).forEach(e=>g.submitInput(e));
      while(g.frame<frames){g.update();g.draw();if(g.frame%60===0)t.push(g.stateHash())}
      return t;
    },{seed,names,script:r.script,frames:r.frames});
    assert.deepEqual(bt,r.trace,'browser trace differs for seed '+seed);
    console.log(`seed ${seed}: browser trace matches Node (${bt.length} samples)`);
  }
  // a snapshot loaded into a fresh game redraws the terrain picture with every crater, matching the original
  {
    const r=record(424242,['A','B','C','D']);
    const res=await page.evaluate(({seed,names,script,frames})=>{
      const mk=()=>{const c=document.createElement('canvas');c.width=960;c.height=540;return Squirmish.createGame({document,ctx:c.getContext('2d')})};
      const a=mk();a.startGame(names,seed);[...script].sort((x,y)=>x.f-y.f).forEach(e=>a.submitInput(e));
      while(a.frame<frames)a.update();
      const b=mk();b.preview(3);b.loadSnapshot(JSON.parse(JSON.stringify(a.getSnapshot())));
      const fresh=mk();fresh.startGame(names,seed);
      const al=g=>g.terrainCanvas.getContext('2d').getImageData(0,0,960,540).data;
      const A=al(a),B=al(b),F=al(fresh);let carved=0,off=0;
      for(let i=3;i<A.length;i+=4){if(F[i]>128&&A[i]<128)carved++;if(Math.abs(A[i]-B[i])>128)off++}
      return {carved,off,same:a.stateHash()===b.stateHash()};
    },{seed:424242,names:['A','B','C','D'],script:r.script,frames:Math.floor(r.frames*0.8)});
    assert.ok(res.same,'state differs after load');
    assert.ok(res.carved>5000,'test match made too few craters: '+res.carved);
    assert.ok(res.off<res.carved*0.05,`terrain picture differs on ${res.off} pixels (craters cover ${res.carved})`);
    console.log(`snapshot terrain picture: ${res.carved} crater pixels, ${res.off} differ (anti-aliased crater edges)`);
  }
  assert.deepEqual(errors,[],'page errors');
  console.log('no page errors; screenshot at browser-check.png');
  await b.close();await srv.close();
})().catch(e=>{console.error(e);process.exit(1)});
