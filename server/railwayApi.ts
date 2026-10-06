import express, { type Request, type Response, type NextFunction } from 'express'
import storyHandler from '../api/story.js'
import syncHandler from '../api/sync/[...path].js'
import syncHealthHandler from '../api/sync-health.js'
import healthHandler from '../api/health.js'
import { storageBackend } from '../lib/objectStorage.js'

const app = express()
app.disable('x-powered-by')

app.use('/api/story', express.json({ limit: '32mb' }))
app.use('/api/sync', express.raw({ type: 'application/octet-stream', limit: '3mb' }))
app.use('/api/sync', express.json({ type: 'application/json', limit: '1mb' }))

function route(handler: (req: Request, res: Response) => Promise<any>) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

app.get('/api/continuity-health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'tracker-continuity-api',
    storage: storageBackend()
  })
})
app.all('/api/story', route(storyHandler))
app.all('/api/sync-health', route(syncHealthHandler))
app.all('/api/sync/*', route(syncHandler))
app.all('/api/health', route(healthHandler))

const continuityHtml = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<title>Tracker Continuity</title>
<style>
:root{color-scheme:dark;--bg:#0b0c12;--card:#171923;--line:#303447;--text:#f3f4f8;--muted:#aeb4c5;--accent:#7c5cff;--ok:#3ddc97;--bad:#ff6b76}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"Noto Sans KR",sans-serif}
main{max-width:760px;margin:0 auto;padding:18px 14px 80px}.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
h1{font-size:22px;margin:0}.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:6px 9px;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:14px;margin:12px 0}
label{display:block;font-weight:800;margin-bottom:8px}input,textarea,select{width:100%;font-size:16px;background:#0f1119;color:var(--text);border:1px solid var(--line);border-radius:12px;padding:13px}textarea{min-height:120px;resize:vertical}.formrow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.sectionTitle{font-size:19px;font-weight:900;margin:2px 0 12px}
button{width:100%;border:0;border-radius:12px;padding:13px 14px;margin-top:10px;font-weight:800;font-size:16px;background:var(--accent);color:white}
button.secondary{background:#282c3b}button:disabled{opacity:.5}.muted{color:var(--muted);font-size:13px;line-height:1.45;white-space:pre-wrap}
.ok{color:var(--ok)}.bad{color:var(--bad)}video{width:100%;max-height:58vh;background:#000;border-radius:12px;margin-top:10px}
.row{display:grid;grid-template-columns:1fr 1fr;gap:8px}.stage{font-size:14px;font-weight:700;margin-top:8px}.variant{border:1px solid var(--line);border-radius:14px;padding:10px;margin-top:12px}
a{color:#bcaeff}.hidden{display:none}.title{font-weight:900;font-size:17px;margin:4px 0}.tiny{font-size:12px;color:var(--muted)}
</style>
</head>
<body><main>
<div class="top"><h1>콘텐츠 제작 Tracker</h1><span class="pill" id="health">연결 확인 중</span></div>

<section id="sourceInputCard" class="card">
<label for="sourceUrl">영상 주소</label>
<input id="sourceUrl" type="url" inputmode="url" placeholder="TikTok / Douyin / Instagram 주소 붙여넣기"/>
<button id="collect">소스 수집</button>
<div id="collectStatus" class="muted" style="margin-top:10px"></div>
</section>

<section id="sourceCard" class="card hidden">
<div class="title">현재 소스</div>
<div id="sourceMeta" class="muted"></div>
<video id="sourceVideo" controls playsinline preload="metadata"></video>
<button id="make">이 소스로 새 영상 만들기</button>
</section>

<section class="card">
<div class="sectionTitle">지혜 쇼폼</div>
<div class="formrow">
<select id="wisdomKind"><option value="topic">주제로 만들기</option><option value="text">원문으로 만들기</option></select>
<select id="wisdomSeconds"><option value="45">45초</option><option value="55" selected>55초</option><option value="65">65초</option><option value="75">75초</option></select>
</div>
<textarea id="wisdomText" placeholder="예: 쇼펜하우어가 말한 인간관계의 지혜"></textarea>
<button id="makeWisdom">지혜 쇼폼 만들기</button>
<div id="wisdomStatus" class="muted" style="margin-top:10px"></div>
</section>

<section class="card">
<div class="sectionTitle">지혜 롱폼</div>
<div class="formrow">
<select id="longKind"><option value="topic">주제로 만들기</option><option value="text">원문으로 만들기</option></select>
<select id="longSeconds"><option value="1200">20분</option><option value="1500" selected>25분</option><option value="1800">30분</option></select>
</div>
<textarea id="longText" placeholder="예: 나이가 들수록 버려야 할 인간관계 7가지"></textarea>
<button id="makeLong">지혜 롱폼 만들기</button>
<div id="longStatus" class="muted" style="margin-top:10px"></div>
</section>

<section id="jobCard" class="card hidden">
<div class="title">자동 제작</div>
<div id="jobState" class="stage"></div>
<div id="jobDetail" class="muted"></div>
<div id="variants"></div>
<div id="final"></div>
</section>

<section class="card">
<div class="tiny">Vercel 장애와 분리된 Railway + Cloudflare R2 연속성 화면입니다. 기존 Blob 데이터는 읽기 fallback으로 보존됩니다.</div>
</section>
</main>
<script>
const $=id=>document.getElementById(id);
const api='/api/story';
const LS_SOURCE='tracker.continuity.source.v1';
const LS_JOB='tracker.continuity.job.v1';
const LS_KEY='tracker.continuity.workspace.v1';
let pollTimer=null, currentSource=null, currentJobId=null, previewRenderKey='';

function randomHex(n=24){const b=new Uint8Array(n);crypto.getRandomValues(b);return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')}
function workspaceKey(){let k=localStorage.getItem(LS_KEY);if(!k){k=randomHex();localStorage.setItem(LS_KEY,k)}return k}
async function json(res){const t=await res.text();let d={};try{d=t?JSON.parse(t):{}}catch{}if(!res.ok||d?.ok===false)throw new Error(d?.error?.message||d?.error||t||('HTTP '+res.status));return d}
async function post(body,auth=false){return json(await fetch(api,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Sync-Key':workspaceKey()}:{})},body:JSON.stringify(body)}))}
async function getJob(id,task='job_get'){return json(await fetch(api+'?taskType='+encodeURIComponent(task)+'&id='+encodeURIComponent(id),{headers:{'X-Sync-Key':workspaceKey()},cache:'no-store'}))}
function status(el,msg,ok){el.textContent=msg;el.className='muted '+(ok===true?'ok':ok===false?'bad':'')}
async function playback(source){
  const d=await post({taskType:'source_playback',sourceAssetId:source.sourceAssetId});
  source.playbackUrl=d.playbackUrl;source.playbackValidUntil=d.validUntil;localStorage.setItem(LS_SOURCE,JSON.stringify(source));
  $('sourceVideo').src=d.playbackUrl;
}
function showSource(source){
  currentSource=source;$('sourceCard').classList.remove('hidden');
  $('sourceMeta').textContent=(source.title||source.filename||'원본 영상')+(source.duration?' · '+Number(source.duration).toFixed(1)+'초':'')+(source.bytes?' · '+(source.bytes/1048576).toFixed(1)+'MB':'');
  if(source.playbackUrl&&Number(source.playbackValidUntil||0)>Date.now()+60000)$('sourceVideo').src=source.playbackUrl;else playback(source).catch(e=>status($('collectStatus'),'재생 준비 실패: '+e.message,false));
}
async function health(){
  try{const d=await json(await fetch('/api/continuity-health',{cache:'no-store'}));$('health').textContent=d.storage==='r2'?'R2 연결됨':'연결됨';$('health').className='pill ok'}catch{$('health').textContent='연결 오류';$('health').className='pill bad'}
}
$('collect').onclick=async()=>{
  const sourceUrl=$('sourceUrl').value.trim();if(!sourceUrl)return status($('collectStatus'),'영상 주소를 붙여넣어 주세요.',false);
  $('collect').disabled=true;status($('collectStatus'),'영상 회수 중…');
  try{
    const d=await post({taskType:'source_collect',sourceUrl});
    if(d.needsSelection)throw new Error('여러 미디어가 있는 게시물은 현재 간편 화면에서 지원하지 않습니다.');
    if(!d.source?.sourceAssetId)throw new Error('서버 소스 ID가 없습니다.');
    currentSource=d.source;localStorage.setItem(LS_SOURCE,JSON.stringify(currentSource));showSource(currentSource);await playback(currentSource);
    $('sourceUrl').value='';status($('collectStatus'),'✓ R2 소스 등록 완료',true);
  }catch(e){status($('collectStatus'),'수집 실패: '+e.message,false)}
  finally{$('collect').disabled=false}
};
$('make').onclick=async()=>{
  if(!currentSource?.sourceAssetId)return;
  $('make').disabled=true;$('make').textContent='제작 시작 중…';
  $('variants').innerHTML='';$('final').innerHTML='';previewRenderKey='';
  try{
    const nonce=randomHex(12);
    const d=await post({taskType:'job_create',profile:'source_shorts',sourceAssetId:currentSource.sourceAssetId,idempotencyKey:'continuity-'+currentSource.sourceAssetId.slice(-20)+'-'+nonce},true);
    currentJobId=d.job.id;localStorage.setItem(LS_JOB,currentJobId);$('jobCard').classList.remove('hidden');previewRenderKey='';setModeUi('source_shorts');startPoll();await refreshJob();
  }catch(e){status($('collectStatus'),'제작 시작 실패: '+e.message,false)}
  finally{$('make').disabled=false;$('make').textContent='이 소스로 새 영상 만들기'}
};
function setModeUi(profile){
  const generated=profile==='wisdom'||profile==='wisdom_longform';
  $('sourceInputCard').style.opacity='1';
  $('sourceCard').style.display=generated?'none':'';
}
function waitLabel(j){
  if(j.status!=='WAITING_USER')return null;
  if(j.waitReason==='DECISION')return '선택 대기';
  if(j.waitReason==='QC_BLOCKED')return 'QC 차단 · 재검사 필요';
  if(j.waitReason==='BUDGET')return '예산 확인 필요';
  if(j.waitReason==='PROVIDER_DOWN')return '외부 생성 서비스 대기';
  return '사용자 확인 필요';
}
async function startGenerated(profile,input,statusId,buttonId){
  const text=String(input.text||'').trim();
  if(text.length<4)return status($(statusId),'4자 이상 입력해 주세요.',false);
  const btn=$(buttonId),old=btn.textContent;btn.disabled=true;btn.textContent='제작 시작 중…';
  $('variants').innerHTML='';$('final').innerHTML='';previewRenderKey='';
  try{
    const d=await post({taskType:'job_create',profile,input:{...input,text},idempotencyKey:profile+'-'+Date.now()+'-'+randomHex(8)},true);
    currentJobId=d.job.id;localStorage.setItem(LS_JOB,currentJobId);$('jobCard').classList.remove('hidden');setModeUi(profile);
    status($(statusId),'제작 작업 생성됨 · 아래 진행상태 확인',true);startPoll();await refreshJob();$('jobCard').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(e){status($(statusId),'제작 시작 실패: '+e.message,false)}
  finally{btn.disabled=false;btn.textContent=old}
}
$('makeWisdom').onclick=()=>startGenerated('wisdom',{
  kind:$('wisdomKind').value,text:$('wisdomText').value,targetSeconds:Number($('wisdomSeconds').value)
},'wisdomStatus','makeWisdom');
$('makeLong').onclick=()=>startGenerated('wisdom_longform',{
  kind:$('longKind').value,text:$('longText').value,targetSeconds:Number($('longSeconds').value)
},'longStatus','makeLong');

function startPoll(){clearInterval(pollTimer);pollTimer=setInterval(refreshJob,4000)}
async function loadPreviews(job){
  try{
    const d=await getJob(job.id,'job_preview');const previews=d.previews||[];
    const nextKey=JSON.stringify(previews.map(p=>[p.variantId,p.qc,!!p.publishable,!!p.approved,!!p.recommended]));
    if(nextKey===previewRenderKey)return;
    previewRenderKey=nextKey;$('variants').innerHTML='';
    for(const p of previews){
      const box=document.createElement('div');box.className='variant';
      const name=document.createElement('div');name.textContent=p.label||p.variantId;name.style.fontWeight='800';box.appendChild(name);
      if(p.url){const v=document.createElement('video');v.controls=true;v.playsInline=true;v.src=p.url;box.appendChild(v)}
      const q=document.createElement('div');q.className='muted';
      const parts=['기술 QC '+(p.qc||'-'),'콘텐츠 QC '+(p.contentQc||'-')];
      if(p.referenceQc)parts.push('레퍼런스 QC '+p.referenceQc);
      parts.push(p.publishable?'게시 가능':'게시 불가');
      q.textContent=parts.join(' · ');box.appendChild(q);
      if(!p.publishable&&Array.isArray(p.contentQcReasons)&&p.contentQcReasons.length){
        const why=document.createElement('div');why.className='muted bad';why.textContent='콘텐츠 차단: '+p.contentQcReasons.join(' / ');box.appendChild(why)
      }
      if(job.status==='WAITING_USER'&&job.waitReason==='DECISION'&&p.publishable){
        const b=document.createElement('button');b.textContent='이 영상으로 선택';b.onclick=()=>choose(job,p.variantId);box.appendChild(b)
      }
      $('variants').appendChild(box)
    }
  }catch{}
}
async function choose(job,variantId){
  const v=(job.variants||[]).find(x=>x.id===variantId);if(!v?.manifestHash)return;
  try{await post({taskType:'job_decision',jobId:job.id,manifestHash:v.manifestHash},true);previewRenderKey='';startPoll();await refreshJob()}catch(e){$('jobDetail').textContent='선택 실패: '+e.message}
}
async function loadFinal(job){
  try{
    const pkg=await getJob(job.id,'job_package');
    let pre={previews:[]};
    if(job.profile!=='wisdom_longform'){try{pre=await getJob(job.id,'job_preview')}catch{}}
    const chosen=(pre.previews||[]).find(x=>x.approved)||(pre.previews||[]).find(x=>x.recommended)||(pre.previews||[])[0];
    const esc=s=>String(s||'').replace(/[<&]/g,m=>m==='<'?'&lt;':'&amp;');
    const videoUrl=pkg?.videoUrl||chosen?.url||null;
    let html='<div class="variant"><div class="title">완성</div>';
    if(videoUrl)html+='<video controls playsinline src="'+String(videoUrl).replace(/"/g,'&quot;')+'"></video>';
    if(pkg?.thumbnailUrl)html+='<img src="'+String(pkg.thumbnailUrl).replace(/"/g,'&quot;')+'" alt="썸네일" style="width:100%;border-radius:12px;margin-top:10px"/>';
    if(pkg?.upload?.title)html+='<div class="title" style="margin-top:12px">'+esc(pkg.upload.title)+'</div>';
    if(pkg?.upload?.description)html+='<div class="muted" style="margin-top:8px">'+esc(pkg.upload.description)+'</div>';
    if(pkg?.upload?.tags?.length)html+='<div class="muted" style="margin-top:8px">태그: '+esc(pkg.upload.tags.join(', '))+'</div>';
    if(pkg?.upload?.pinnedComment)html+='<div class="muted" style="margin-top:8px">고정댓글: '+esc(pkg.upload.pinnedComment)+'</div>';
    html+='</div>';$('final').innerHTML=html;
  }catch(e){$('jobDetail').textContent+='\n완성본 준비 확인 중…'}
}
async function refreshJob(){
  if(!currentJobId)return;
  try{
    const d=await getJob(currentJobId);const j=d.job;$('jobCard').classList.remove('hidden');
    const profileName=j.profile==='wisdom'?'지혜 쇼폼':j.profile==='wisdom_longform'?'지혜 롱폼':'소스 쇼츠';
    setModeUi(j.profile);
    const waiting=waitLabel(j);
    $('jobState').textContent=profileName+' · '+(j.status==='COMPLETE'?'완성':j.status==='FAILED'?'실패':waiting||(j.status==='WAITING_USER'?'사용자 확인 필요':'제작 중 · '+j.stage));
    $('jobDetail').textContent=(j.error?j.error+'\n':'')+'현재 단계: '+j.stage+(j.waitReason?' · '+j.waitReason:'');
    if(j.profile==='wisdom') status($('wisdomStatus'),j.status==='COMPLETE'?'✓ 완성':j.status==='FAILED'?'실패':j.waitReason==='QC_BLOCKED'?'QC 차단 · 자동 재검사/수정 필요':'제작 진행 중 · '+j.stage,j.status==='COMPLETE'?true:j.status==='FAILED'?false:null);
    if(j.profile==='wisdom_longform') status($('longStatus'),j.status==='COMPLETE'?'✓ 완성':j.status==='FAILED'?'실패':j.waitReason==='QC_BLOCKED'?'QC 차단 · 자동 재검사/수정 필요':'제작 진행 중 · '+j.stage,j.status==='COMPLETE'?true:j.status==='FAILED'?false:null);
    if(j.status==='WAITING_USER'&&j.waitReason==='DECISION'){await loadPreviews(j);clearInterval(pollTimer);pollTimer=null}
    if(j.status==='COMPLETE'){clearInterval(pollTimer);pollTimer=null;await loadFinal(j)}
    if(j.status==='FAILED'||j.status==='CANCELLED')clearInterval(pollTimer);
  }catch(e){$('jobDetail').textContent='상태 확인 실패: '+e.message}
}
health();
try{const s=JSON.parse(localStorage.getItem(LS_SOURCE)||'null');if(s?.sourceAssetId)showSource(s)}catch{}
currentJobId=localStorage.getItem(LS_JOB)||null;if(currentJobId){$('jobCard').classList.remove('hidden');startPoll();refreshJob()}
</script></body></html>`

app.get('/', (_req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8')
  res.setHeader('Cache-Control','no-store')
  res.status(200).send(continuityHtml)
})

app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[continuity-api]', err?.message || err)
  if (res.headersSent) return
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'internal error' } })
})

const port = Number(process.env.PORT || 3000)
app.listen(port, '0.0.0.0', () => {
  console.log(`[continuity-api] listening port=${port} storage=${storageBackend()}`)
})
