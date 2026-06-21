require('dotenv').config();
const express=require('express'),cors=require('cors'),https=require('https'),path=require('path'),fs=require('fs');
const app=express(),PORT=process.env.PORT||3001,DATA_FILE=path.join(__dirname,'data.json'),INTERVAL=15*60*1000;
app.use(cors());app.use(express.json());app.use(express.static(path.join(__dirname,'../public'));
const DEFAULT_PRIZES=[{rank:1,prize:'$2,500'},{rank:2,prize:'$1,500'},{rank:3,prize:'$1,000'},{rank:4,prize:'$700'},{rank:5,prize:'$500'},{rank:6,prize:'$325'},{rank:7,prize:'$250'},{rank:8,prize:'$200'},{rank:9,prize:'$150'},{rank:10,prize:'$125'},{rank:11,prize:'$75'},{rank:12,prize:'$75'},{rank:13,prize:'$50'},{rank:14,prize:'$25'},{rank:15,prize:'$25'}];
const DEFAULT_COMP={name:'Bi-Weekly Wager Race',totalPrize:'$10,000',startDate:new Date().toISOString().split('T')[0],endDate:new Date(Date.now()+14*86400000).toISOString().split('T')[0]};
function load(){try{if(fs.existsSync(DATA_FILE))return JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));}catch(e){}return{token:null,players:[],totalTurnover:0,lastSync:null,prizes:DEFAULT_PRIZES,competition:DEFAULT_COMP};}
function save(d){fs.writeFileSync(DATA_FILE,JSON.stringify(d,null,2));}
let state=load(),timer=null;
function post(path,token){return new Promise((res,rej)=>{const req=https.request({hostname:'api.playblock.io',path,method:'POST',headers:{'Authorization':'Bearer '+token,'Content-Length':'0','Accept':'application/json','Origin':'https://sharker.com'}},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res({status:r.statusCode,data:JSON.parse(d)});}catch(e){res({status:r.statusCode,data:null});}});});req.on('error',rej);req.setTimeout(15000,()=>{req.destroy();rej(new Error('Timeout'));});req.end();});}
function getPrize(rank,prizes){const p=(prizes||DEFAULT_PRIZES).find(p=>p.rank===rank);return p?p.prize:'—';}
function mask(w){if(!w)return'Player****';const c=w.replace(/\s/g,'');if(c.startsWith('0x')&&c.length>10)return c.slice(0,6)+'****'+c.slice(-4);return c.slice(0,3)+'****';}
async function sync(){
  if(!state.token)return;
  const s=state.competition?.startDate||new Date(Date.now()-14*86400000).toISOString().split('T')[0];
  const t=new Date().toISOString().split('T')[0];
  try{
    const r=await post('/v2/sap/dashboard/stats/summary?from='+s+'&to='+t,state.token);
    if(r.status!==200){if(r.status===401||r.status===403){state.tokenExpired=true;save(state);}return;}
    const camps=r.data?._data?.campaigns||[];
    let turnover=0,players=0,code=null,name=null;
    camps.forEach(c=>{turnover+=c.turnover||0;players+=c.players||0;if(!code){code=c.code;name=c.title;}});
    state.totalTurnover=turnover;state.affiliateCode=code;state.affiliateName=name;state.lastSync=new Date().toISOString();state.tokenExpired=false;
    if(!state.players?.length){state.players=[{rank:1,username:name||'Your Players',wallet:'',totalWager:turnover,prize:getPrize(1,state.prizes),isAggregate:true}];}
    else{state.players=state.players.map((p,i)=>({...p,totalWager:turnover/state.players.length,prize:getPrize(i+1,state.prizes)}));}
    save(state);console.log('[Sync] OK — G'+turnover+' | '+players+' players');
  }catch(e){console.error('[Sync] Error:',e.message);}
}
function startLoop(){if(timer)clearInterval(timer);sync();timer=setInterval(sync,INTERVAL);}
app.get('/api/leaderboard',(req,res)=>res.json({success:!!state.token,configured:!!state.token,tokenExpired:state.tokenExpired||false,players:state.players||[],totalTurnover:state.totalTurnover||0,affiliateCode:state.affiliateCode,affiliateName:state.affiliateName,competition:state.competition||DEFAULT_COMP,prizes:state.prizes||DEFAULT_PRIZES,lastSync:state.lastSync}));
app.post('/api/setup',async(req,res)=>{
  const{token,adminPassword}=req.body;
  if(!token)return res.status(400).json({error:'Token required'});
  if(adminPassword!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Wrong password'});
  const t=new Date().toISOString().split('T')[0];
  const w=new Date(Date.now()-7*86400000).toISOString().split('T')[0];
  const r=await post('/v2/sap/dashboard/stats/summary?from='+w+'&to='+t,token).catch(()=>null);
  if(!r||r.status!==200)return res.status(400).json({error:'Invalid or expired token'});
  const camps=r.data?._data?.campaigns||[];
  if(!camps.length)return res.status(400).json({error:'No campaigns found'});
  state.token=token;state.tokenExpired=false;state.affiliateCode=camps[0].code;state.affiliateName=camps[0].title;
  save(state);startLoop();
  res.json({success:true,affiliateName:camps[0].title,campaigns:camps.length});
});
app.post('/api/refresh-token',(req,res)=>{
  const{token,adminPassword}=req.body;
  if(adminPassword!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Wrong password'});
  state.token=token;state.tokenExpired=false;save(state);startLoop();
  res.json({success:true});
});
app.post('/api/sync',(req,res)=>{
  const{adminPassword}=req.body;
  if(adminPassword!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Wrong password'});
  res.json({success:true});sync();
});
app.post('/api/competition',(req,res)=>{
  const{adminPassword,competition}=req.body;
  if(adminPassword!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Wrong password'});
  state.competition={...DEFAULT_COMP,...competition};save(state);res.json({success:true});
});
app.post('/api/prizes',(req,res)=>{
  const{adminPassword,prizes}=req.body;
  if(adminPassword!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Wrong password'});
  state.prizes=prizes;state.players=state.players.map((p,i)=>({...p,prize:getPrize(i+1,prizes)}));save(state);res.json({success:true});
});
app.get('/api/admin/status',(req,res)=>{
  if(req.query.password!==(process.env.ADMIN_PASSWORD||'admin123'))return res.status(401).json({error:'Unauthorized'});
  res.json({configured:!!state.token,tokenExpired:state.tokenExpired,affiliateCode:state.affiliateCode,affiliateName:state.affiliateName,playerCount:state.players?.length||0,totalTurnover:state.totalTurnover,lastSync:state.lastSync,competition:state.competition,prizes:state.prizes});
});
app.listen(PORT,()=>{console.log('\nSharker Leaderboard → http://localhost:'+PORT);console.log('Setup → http://localhost:'+PORT+'/setup.html\n');if(state.token){console.log('Token found — starting sync...');startLoop();}else{console.log('No token — visit /setup.html');}});
