// Browser check (needs Playwright + Chromium): the page loads and plays, and a match replayed in the browser
// with full rendering produces exactly the Node trace, so drawing, particles and sound never touch the simulation.
// Run: node test/browser.check.js
const {chromium}=require('playwright'),path=require('path'),assert=require('assert/strict');
const {record}=require('./harness');
(async()=>{
  const b=await chromium.launch(),page=await b.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>m.type()==='error'&&errors.push(m.text()));
  await page.goto('file://'+path.resolve(__dirname,'../public/squirmish.html')+'#debug');
  // the hot-seat UI still works: start a 3-player game, walk, fire a rocket
  await page.click('.n[data-n="3"]');await page.click('#go');
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
  assert.deepEqual(errors,[],'page errors');
  console.log('no page errors; screenshot at browser-check.png');
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
