// Browser check: what players see when the server restarts mid-match.
// 1) a redeploy (graceful: the server says so before closing)  2) a crash / restart with no warning (rooms just vanish)
// Run: npm run check:restart
const {chromium}=require('playwright'),assert=require('assert/strict'),{createServer}=require('../server');
const MSG=/The game server restarted/;
async function match(base,browser){
  const pages=[];for(const n of ['Ann','Bo'])pages.push(await (await browser.newContext()).newPage());
  const [A,B]=pages;
  await A.goto(base+'/');await A.fill('#nm','Ann');await A.click('[data-act=create]');await A.waitForSelector('#seats li.me');
  await B.goto(A.url());await B.fill('#nm','Bo');await B.click('[data-act=join]');await B.waitForSelector('#readyBtn');
  await A.click('#readyBtn');await B.click('#readyBtn');await A.waitForFunction(()=>!document.querySelector('#startBtn').disabled);
  await A.click('#startBtn');for(const p of pages)await p.waitForSelector('#me:not([hidden])');
  await A.waitForTimeout(1500);return pages;
}
(async()=>{
  const browser=await chromium.launch(),errors=[];
  // 1) graceful
  let srv=createServer();await new Promise(r=>srv.server.listen(0,r));const port=srv.server.address().port,base='http://localhost:'+port;
  let pages=await match(base,browser);pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
  srv.shutdown();await srv.close();
  for(const p of pages){await p.waitForFunction(re=>new RegExp(re).test(document.querySelector('#msg')?.textContent||''),MSG.source,{timeout:5000});assert.equal(new URL(p.url()).pathname,'/')}
  console.log('redeploy: both players told the server restarted, back on the home screen');
  // 2) abrupt: the process dies and a fresh one starts on the same port; the pages reconnect and find no room
  srv=createServer();await new Promise(r=>srv.server.listen(port,r));
  pages=await match(base,browser);pages.forEach(p=>p.on('pageerror',e=>errors.push(e.message)));
  for(const ws of srv.wss.clients)ws.terminate();await srv.close();
  srv=createServer();await new Promise(r=>srv.server.listen(port,r));
  for(const p of pages)await p.waitForFunction(re=>new RegExp(re).test(document.querySelector('#msg')?.textContent||''),MSG.source,{timeout:15000});
  console.log('crash + restart: both players told the server restarted after reconnecting');
  // and creating a new room right away works
  await pages[0].fill('#nm','Ann');await pages[0].click('[data-act=create]');await pages[0].waitForSelector('#seats li.me');
  assert.deepEqual(errors,[]);console.log('new room works; no page errors');
  await browser.close();await srv.close();
})().catch(e=>{console.error(e);process.exit(1)});
