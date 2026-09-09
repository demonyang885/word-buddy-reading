import { FilesetResolver, PoseLandmarker, DrawingUtils } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/+esm";

const APP_VERSION = "0.2.0";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const CONFIG = {
  calibrationMs: 6000,
  persistenceMs: 3000,
  logIntervalMs: 250,
  smoothingAlpha: 0.22,
  minVisibility: 0.45,
  thresholds: { headRollDeg: 7, shoulderTiltDeg: 5, bodyLeanDeg: 8, distanceRatio: 1.25 },
  calibrationQuality: { headStdMax: 4, shoulderStdMax: 3, bodyStdMax: 5, minSamples: 18 }
};

const $ = s => document.querySelector(s);
const video = $("#video"), canvas = $("#overlay"), ctx = canvas.getContext("2d"), stage = $("#stage");
const stageMessage = $("#stageMessage"), cameraBtn = $("#cameraBtn"), switchBtn = $("#switchBtn"), calibrateBtn = $("#calibrateBtn"), recordBtn = $("#recordBtn"), exportBtn = $("#exportBtn");
const modelStatus = $("#modelStatus"), cameraStatus = $("#cameraStatus"), baselineStatus = $("#baselineStatus"), secureStatus = $("#secureStatus"), fpsStatus = $("#fpsStatus");
const overallCard = $("#overallCard"), overallStatus = $("#overallStatus"), debugOutput = $("#debugOutput"), compatBanner = $("#compatBanner");
const poseConfidence = $("#poseConfidence"), baselineQuality = $("#baselineQuality"), sampleCount = $("#sampleCount");
const ui = {
  headRoll: { state: $("#headRollState"), value: $("#headRollValue") },
  shoulderTilt: { state: $("#shoulderTiltState"), value: $("#shoulderTiltValue") },
  bodyLean: { state: $("#bodyLeanState"), value: $("#bodyLeanValue") },
  distance: { state: $("#distanceState"), value: $("#distanceValue") }
};

let poseLandmarker, drawingUtils, stream, facingMode = "user", running = false, lastVideoTime = -1, rafId;
let baseline = null, calibration = null, smoothed = null, delegateUsed = "—", lastState = null, lastInferenceAt = 0, fpsEma = 0;
const abnormalSince = { headRoll: null, shoulderTilt: null, bodyLean: null, distance: null };
const session = { active: false, startedAt: 0, rows: [], lastLoggedAt: 0, eventCounts: { headRoll: 0, shoulderTilt: 0, bodyLean: 0, distance: 0 } };

const radToDeg = v => v * 180 / Math.PI;
const angleDeg = (a,b) => radToDeg(Math.atan2(b.y-a.y,b.x-a.x));
const midpoint = (a,b) => ({ x:(a.x+b.x)/2, y:(a.y+b.y)/2 });
const distance = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const std = a => { if(!a.length) return NaN; const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
const isVisible = p => !!p && (p.visibility ?? 1) >= CONFIG.minVisibility;
const fmt = (v,d=1) => Number.isFinite(v) ? v.toFixed(d) : "—";
function normalizeLineAngle(a){ while(a>90)a-=180; while(a<-90)a+=180; return a; }

function checkCompatibility(){
  const problems=[];
  secureStatus.textContent=`HTTPS：${window.isSecureContext?"OK":"需要 HTTPS"}`;
  if(!window.isSecureContext) problems.push("目前不是 Secure Context；iPad Safari 不能啟用攝像頭。 ");
  if(!navigator.mediaDevices?.getUserMedia) problems.push("此瀏覽器沒有 getUserMedia；請使用較新的 Safari。 ");
  if(problems.length){ compatBanner.hidden=false; compatBanner.textContent=problems.join(""); }
}

function smoothMetrics(m){
  if(!smoothed) return smoothed={...m};
  for(const k of ["headRoll","shoulderTilt","bodyLean","shoulderWidth","yawProxy","poseConfidence"]){
    if(Number.isFinite(m[k])) smoothed[k]=Number.isFinite(smoothed[k]) ? smoothed[k]+CONFIG.smoothingAlpha*(m[k]-smoothed[k]) : m[k];
  }
  smoothed.bodyLeanSource=m.bodyLeanSource;
  return {...smoothed};
}

function extractMetrics(lm){
  const nose=lm[0], le=lm[2], re=lm[5], lear=lm[7], rear=lm[8], ls=lm[11], rs=lm[12], lh=lm[23], rh=lm[24];
  if(![nose,ls,rs].every(isVisible)) return null;
  let headRoll=NaN;
  if([le,re].every(isVisible)) headRoll=normalizeLineAngle(angleDeg(le,re)); else if([lear,rear].every(isVisible)) headRoll=normalizeLineAngle(angleDeg(lear,rear));
  const shoulderTilt=normalizeLineAngle(angleDeg(ls,rs));
  const shoulderMid=midpoint(ls,rs), shoulderWidth=distance(ls,rs);
  let bodyLean, bodyLeanSource;
  if([lh,rh].every(isVisible)){
    const hipMid=midpoint(lh,rh);
    bodyLean=radToDeg(Math.atan2(shoulderMid.x-hipMid.x, hipMid.y-shoulderMid.y));
    bodyLeanSource="hips";
  } else {
    const off=shoulderWidth>0?(nose.x-shoulderMid.x)/shoulderWidth:0;
    bodyLean=radToDeg(Math.atan(off)); bodyLeanSource="head-offset";
  }
  let yawProxy=NaN;
  if([le,re].every(isVisible)){
    const eyeMid=midpoint(le,re), eyeWidth=distance(le,re);
    if(eyeWidth>.001) yawProxy=(nose.x-eyeMid.x)/eyeWidth;
  }
  const vis=[nose,le,re,lear,rear,ls,rs,lh,rh].filter(Boolean).map(p=>p.visibility??1).filter(Number.isFinite);
  return { headRoll, shoulderTilt, bodyLean, shoulderWidth, yawProxy, poseConfidence:mean(vis), bodyLeanSource };
}

function metricDelta(m){ return baseline ? { headRoll:m.headRoll-baseline.headRoll, shoulderTilt:m.shoulderTilt-baseline.shoulderTilt, bodyLean:m.bodyLean-baseline.bodyLean, distance:m.shoulderWidth/baseline.shoulderWidth, yawProxy:m.yawProxy-baseline.yawProxy } : null; }

function classify(d,now){
  const raw={ headRoll:Math.abs(d.headRoll)>=CONFIG.thresholds.headRollDeg, shoulderTilt:Math.abs(d.shoulderTilt)>=CONFIG.thresholds.shoulderTiltDeg, bodyLean:Math.abs(d.bodyLean)>=CONFIG.thresholds.bodyLeanDeg, distance:d.distance>=CONFIG.thresholds.distanceRatio };
  const persistent={};
  for(const k of Object.keys(raw)){
    if(raw[k]){ abnormalSince[k]??=now; persistent[k]=now-abnormalSince[k]>=CONFIG.persistenceMs; }
    else { abnormalSince[k]=null; persistent[k]=false; }
  }
  return {raw,persistent};
}

function setMetricUI(k,text,value,alert){
  ui[k].state.textContent=text; ui[k].value.textContent=value;
  const card=document.querySelector(`.metric[data-key="${k}"]`);
  card.classList.toggle("alert",alert); card.classList.toggle("ok",!alert&&baseline!==null);
}

function assessCalibration(samples){
  const q={ samples:samples.length, headStd:std(samples.map(x=>x.headRoll).filter(Number.isFinite)), shoulderStd:std(samples.map(x=>x.shoulderTilt).filter(Number.isFinite)), bodyStd:std(samples.map(x=>x.bodyLean).filter(Number.isFinite)) };
  q.good=samples.length>=CONFIG.calibrationQuality.minSamples && q.headStd<=CONFIG.calibrationQuality.headStdMax && q.shoulderStd<=CONFIG.calibrationQuality.shoulderStdMax && q.bodyStd<=CONFIG.calibrationQuality.bodyStdMax;
  return q;
}

function finishCalibration(){
  const s=calibration?.samples??[], q=assessCalibration(s);
  if(s.length<CONFIG.calibrationQuality.minSamples){ calibration=null; baseline=null; baselineStatus.textContent="基準：失敗，請重試"; baselineQuality.textContent="樣本不足"; overallCard.className="overall warn"; overallStatus.textContent="重新校準"; return; }
  baseline={ headRoll:mean(s.map(x=>x.headRoll).filter(Number.isFinite)), shoulderTilt:mean(s.map(x=>x.shoulderTilt).filter(Number.isFinite)), bodyLean:mean(s.map(x=>x.bodyLean).filter(Number.isFinite)), shoulderWidth:mean(s.map(x=>x.shoulderWidth).filter(Number.isFinite)), yawProxy:mean(s.map(x=>x.yawProxy).filter(Number.isFinite)), quality:q };
  calibration=null; baselineStatus.textContent=q.good?"基準：已校準":"基準：已校準（偏動）"; baselineQuality.textContent=q.good?"穩定":"偏動，建議重做"; overallCard.className=q.good?"overall good":"overall warn"; overallStatus.textContent=q.good?"基準完成":"基準可用但不穩"; recordBtn.disabled=false;
}

function updateEventCounts(state){
  if(!session.active) return;
  if(!lastState){ lastState={...state.persistent}; return; }
  for(const k of Object.keys(state.persistent)) if(state.persistent[k]&&!lastState[k]) session.eventCounts[k]++;
  lastState={...state.persistent};
}

function logSession(m,d,state,now){
  if(!session.active||now-session.lastLoggedAt<CONFIG.logIntervalMs) return;
  session.lastLoggedAt=now;
  session.rows.push({ elapsed_s:(now-session.startedAt)/1000, head_roll_delta_deg:d.headRoll, shoulder_tilt_delta_deg:d.shoulderTilt, body_lean_delta_deg:d.bodyLean, distance_ratio:d.distance, yaw_proxy_delta:d.yawProxy, pose_confidence:m.poseConfidence, body_lean_source:m.bodyLeanSource, head_alert:Number(state.persistent.headRoll), shoulder_alert:Number(state.persistent.shoulderTilt), body_alert:Number(state.persistent.bodyLean), distance_alert:Number(state.persistent.distance) });
  sampleCount.textContent=String(session.rows.length); exportBtn.disabled=false;
}

function updateDiagnostics(m,now){
  poseConfidence.textContent=Number.isFinite(m.poseConfidence)?`${Math.round(m.poseConfidence*100)}%`:"—";
  if(calibration){
    calibration.samples.push(m); const elapsed=now-calibration.startedAt, p=Math.min(100,Math.round(elapsed/CONFIG.calibrationMs*100));
    overallCard.className="overall calibrating"; overallStatus.textContent=`校準中 ${p}%`; baselineStatus.textContent=`基準：校準中 ${p}%`; baselineQuality.textContent=`${calibration.samples.length} samples`;
    if(elapsed>=CONFIG.calibrationMs) finishCalibration(); return;
  }
  if(!baseline){ overallCard.className="overall"; overallStatus.textContent="請先校準"; return; }
  const d=metricDelta(m), state=classify(d,now); updateEventCounts(state);
  setMetricUI("headRoll",state.persistent.headRoll?"異常":"正常",`${fmt(d.headRoll)}°（相對基準）`,state.persistent.headRoll);
  setMetricUI("shoulderTilt",state.persistent.shoulderTilt?"異常":"正常",`${fmt(d.shoulderTilt)}°（相對基準）`,state.persistent.shoulderTilt);
  setMetricUI("bodyLean",state.persistent.bodyLean?"異常":"正常",`${fmt(d.bodyLean)}° · ${m.bodyLeanSource}`,state.persistent.bodyLean);
  setMetricUI("distance",state.persistent.distance?"過近":"正常",`${fmt(d.distance,2)}× 基準距離 proxy`,state.persistent.distance);
  const any=Object.values(state.persistent).some(Boolean); overallCard.className=any?"overall warn":"overall good"; if(session.active) overallCard.classList.add("recording"); overallStatus.textContent=any?"姿態偏離":(session.active?"記錄中 · 姿態穩定":"姿態穩定");
  logSession(m,d,state,now);
  debugOutput.textContent=JSON.stringify({version:APP_VERSION,delegate:delegateUsed,baseline,current:m,delta:d,rawAbnormal:state.raw,persistentAbnormal:state.persistent,persistenceMs:CONFIG.persistenceMs,thresholds:CONFIG.thresholds,events:session.eventCounts},null,2);
}

function drawPose(result){
  if(video.videoWidth&&video.videoHeight&&(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight)){ canvas.width=video.videoWidth; canvas.height=video.videoHeight; drawingUtils=new DrawingUtils(ctx); }
  ctx.clearRect(0,0,canvas.width,canvas.height); if(!drawingUtils) drawingUtils=new DrawingUtils(ctx);
  for(const lm of result.landmarks??[]){ drawingUtils.drawConnectors(lm,PoseLandmarker.POSE_CONNECTIONS,{lineWidth:3}); drawingUtils.drawLandmarks(lm,{radius:3,lineWidth:1}); }
}

function updateFps(now){ if(lastInferenceAt>0){ const instant=1000/Math.max(1,now-lastInferenceAt); fpsEma=fpsEma?fpsEma*.85+instant*.15:instant; fpsStatus.textContent=`FPS：${fpsEma.toFixed(1)}`; } lastInferenceAt=now; }

async function predictLoop(){
  if(!running) return; const now=performance.now();
  if(video.readyState>=2&&video.currentTime!==lastVideoTime){
    lastVideoTime=video.currentTime;
    try{
      const result=poseLandmarker.detectForVideo(video,now); updateFps(now); drawPose(result); const lm=result.landmarks?.[0];
      if(lm){ stageMessage.hidden=true; const raw=extractMetrics(lm); if(raw) updateDiagnostics(smoothMetrics(raw),now); }
      else { stageMessage.hidden=false; stageMessage.textContent="未找到上半身，請調整 iPad 距離或角度"; }
    }catch(err){ console.error(err); stageMessage.hidden=false; stageMessage.textContent="識別暫停："+(err?.message||err); }
  }
  rafId=requestAnimationFrame(predictLoop);
}

async function createLandmarker(vision,delegate){ return PoseLandmarker.createFromOptions(vision,{ baseOptions:{modelAssetPath:MODEL_URL,delegate}, runningMode:"VIDEO", numPoses:1, minPoseDetectionConfidence:.55, minPosePresenceConfidence:.55, minTrackingConfidence:.55 }); }

async function initModel(){
  try{
    modelStatus.textContent="模型：下載中"; const vision=await FilesetResolver.forVisionTasks(WASM_URL);
    try{ poseLandmarker=await createLandmarker(vision,"GPU"); delegateUsed="GPU"; }
    catch(e){ console.warn("GPU delegate failed; falling back to CPU",e); poseLandmarker=await createLandmarker(vision,"CPU"); delegateUsed="CPU"; }
    modelStatus.textContent=`模型：已就緒 · ${delegateUsed}`; cameraBtn.disabled=false; stageMessage.textContent="點擊「開啟鏡頭」開始";
  }catch(err){ console.error(err); modelStatus.textContent="模型：載入失敗"; stageMessage.textContent="MediaPipe 載入失敗，請確認網絡連線後重新整理。"; }
}

function resetBaseline(){ baseline=null; calibration=null; smoothed=null; baselineQuality.textContent="—"; recordBtn.disabled=true; baselineStatus.textContent="基準：未校準"; for(const k of Object.keys(abnormalSince)) abnormalSince[k]=null; }
function stopSession(){ session.active=false; recordBtn.textContent="開始記錄"; exportBtn.disabled=session.rows.length===0; lastState=null; }

async function stopCamera(){
  running=false; cancelAnimationFrame(rafId); stopSession(); stream?.getTracks().forEach(t=>t.stop()); stream=null; video.srcObject=null; ctx.clearRect(0,0,canvas.width,canvas.height); cameraStatus.textContent="鏡頭：未啟動"; cameraBtn.textContent="開啟鏡頭"; switchBtn.disabled=true; calibrateBtn.disabled=true; recordBtn.disabled=true; stageMessage.hidden=false; stageMessage.textContent="鏡頭已關閉";
}

async function startCamera(){
  if(!window.isSecureContext){ stageMessage.hidden=false; stageMessage.innerHTML="iPad Safari 的攝像頭需要 HTTPS。<br>請使用 GitHub Pages 或 README 的 Mac mini HTTPS 方式。"; return; }
  try{
    if(running) await stopCamera();
    stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:facingMode},width:{ideal:1280},height:{ideal:960}}});
    video.srcObject=stream; await video.play(); running=true; lastVideoTime=-1; lastInferenceAt=0; fpsEma=0; smoothed=null; stage.classList.toggle("mirror",facingMode==="user"); cameraStatus.textContent=`鏡頭：${facingMode==="user"?"前鏡":"後鏡"}`; cameraBtn.textContent="關閉鏡頭"; switchBtn.disabled=false; calibrateBtn.disabled=false; stageMessage.hidden=true; predictLoop();
  }catch(err){ console.error(err); cameraStatus.textContent="鏡頭：啟動失敗"; stageMessage.hidden=false; stageMessage.textContent="無法取得攝像頭權限："+(err?.message||err); }
}

function startCalibration(){ if(!running) return; stopSession(); resetBaseline(); calibration={startedAt:performance.now(),samples:[]}; baselineStatus.textContent="基準：校準中"; stageMessage.hidden=false; stageMessage.textContent="保持你認為正確的坐姿約 6 秒"; setTimeout(()=>{if(running&&calibration)stageMessage.hidden=true},1600); }
function toggleRecording(){
  if(!baseline) return;
  if(session.active){ stopSession(); overallStatus.textContent="記錄已停止"; return; }
  session.active=true; session.startedAt=performance.now(); session.rows=[]; session.lastLoggedAt=0; session.eventCounts={headRoll:0,shoulderTilt:0,bodyLean:0,distance:0}; sampleCount.textContent="0"; exportBtn.disabled=true; recordBtn.textContent="停止記錄"; lastState=null;
}
function csvEscape(v){ const s=String(v??""); return /[",\n]/.test(s)?`"${s.replaceAll('"','""')}"`:s; }
function exportCsv(){
  if(!session.rows.length) return; const headers=Object.keys(session.rows[0]); const lines=[headers.join(",")];
  for(const row of session.rows) lines.push(headers.map(h=>csvEscape(typeof row[h]==="number"?row[h].toFixed(4):row[h])).join(","));
  const blob=new Blob(["\ufeff"+lines.join("\n")],{type:"text/csv;charset=utf-8"}), url=URL.createObjectURL(blob), a=document.createElement("a"), stamp=new Date().toISOString().replaceAll(":","-").slice(0,19);
  a.href=url; a.download=`posture-session-${stamp}.csv`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}

cameraBtn.addEventListener("click",async()=>running?await stopCamera():await startCamera());
switchBtn.addEventListener("click",async()=>{facingMode=facingMode==="user"?"environment":"user";resetBaseline();await startCamera();});
calibrateBtn.addEventListener("click",startCalibration); recordBtn.addEventListener("click",toggleRecording); exportBtn.addEventListener("click",exportCsv);
window.addEventListener("pagehide",stopCamera); window.addEventListener("beforeunload",stopCamera);
checkCompatibility(); initModel();
