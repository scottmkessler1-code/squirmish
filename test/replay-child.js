// Replays a script in a separate Node process, so nothing can leak between runs through module state.
const {replay}=require('./harness');
let buf='';process.stdin.on('data',d=>buf+=d).on('end',()=>{
  const {seed,names,script,frames}=JSON.parse(buf);
  process.stdout.write(JSON.stringify(replay(seed,names,script,frames,{incremental:true})));
});
