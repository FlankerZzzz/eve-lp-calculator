"use client";
import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {StarMapData,StarSystem,StarMapControls,JumpMapOverlay} from '../star-map';
import type {RouteResult} from '../navigation-types';
import SystemPicker from '../system-picker';
import WaypointList from '../waypoint-list';
import type {Waypoint} from '../waypoint-list';
import {assignNavigationPoint,moveWaypoint} from '../../../lib/waypoint-order.mjs';
import AvoidPanel from '../avoid-panel';
import {useNavigationAvoid} from '../use-navigation-avoid';
import {avoidPolicy} from '../../../lib/navigation-avoid.mjs';
import {navigationGraph} from '../../../lib/navigation.mjs';
import {shipParameters,rangeSystems,nearbyLandings,makePlanLeg,inspectLeg,planEndpointIssues,nextPlanActions,checkpointProgress,routePlanState,destinationJumpStatus,formatJumpRoute} from '../../../lib/jump-planner.mjs';
import {autoRouteIssues,autoStationIssues,autoGateIssues} from '../../../lib/jump-auto-planner.mjs';
import {feedIsCurrent} from '../../../lib/star-hover-environment.mjs';
import {validateJumpCatalog} from '../../../lib/jump-catalog.mjs';
import {distanceLightyears,securityBand} from '../../../lib/star-map.mjs';
import DirectJumpDialog from './direct-jump-dialog';
import JumpCompletionDialog from './completion-dialog';
import JumpValidationDialog from './validation-dialog';
import JumpRouteCopy from './route-copy';
import MapColorBar from '../map-color-bar';
import MapSystemSearch from '../map-system-search';
import MapDimensionControl from '../map-dimension-control';
import {useJumpTools} from './use-jump-tools';
import {JumpToolsBar,JumpToolsResults} from './jump-tools-bar';
import PlannerHeading from '../planner-heading';
import SelectedSystemCard from '../selected-system-card';
import {useMapEnvironment} from '../use-map-environment';
import {DEFAULT_STAR_COLOR_MODE,STAR_SECURITY_CSS_VARS,securityTextStyle} from '../../../lib/star-map-colors.mjs';
import '../navigation.css';
import './jump.css';
import './jump-tools.css';
const StarMap=lazy(()=>import('../star-map'));
const NO_ROUTES:RouteResult[]=[],NO_ACTIVITY={};
type Ship={id:number;name:string;group:string;groupId:number;baseRange:number;fuelId:number;fuelName:string;baseFuel:number;shipFuelBonus:number};
type Catalog=StarMapData&{ships:Ship[];stations:Record<number,{id:number;typeId:number}[]>;stationSource:string;shipsVerifiedAt:string};
type Leg={from:number;to:number;kind:'jump'|'gate';ids:number[]};
type Incursions={ids:number[]|null;modified:string|null;fetched?:string|null;fresh_until?:string|null;stale:boolean;error:string|null};
type Stations={systemId:number;stations:{id:number;name:string;typeId:number}[];fetchedAt:string};
const sec=(s:number)=>Math.max(s>0?.1:-1,Math.round(s*10)/10).toFixed(1);
const number=(n:number)=>n.toLocaleString('zh-CN',{maximumFractionDigits:2});
const precise=(n:number)=>n>0&&n<.0001?'<0.0001':n.toLocaleString('zh-CN',{maximumFractionDigits:4});
const time=(s:string|null)=>s?new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未取得';
const requestToken=()=>[...crypto.getRandomValues(new Uint8Array(16))].map(n=>n.toString(16).padStart(2,'0')).join('');

export default function JumpPlanner(){
  const [dimension,setDimension]=useState<'2d'|'3d'>('3d');
  const [catalog,setCatalog]=useState<Catalog|null>(null),[desktop,setDesktop]=useState<boolean|null>(null),[error,setError]=useState('');
  const environment=useMapEnvironment(desktop===true);
  const [catalogError,setCatalogError]=useState(''),[catalogBusy,setCatalogBusy]=useState(true),[catalogAttempt,setCatalogAttempt]=useState(0);
  const pointKeys=useRef(2);
  const [points,setPoints]=useState<Waypoint[]>([{key:1,text:'',id:null},{key:2,text:'',id:null}]);
  const [shipId,setShipId]=useState(28846),[calibration,setCalibration]=useState(5),[conservation,setConservation]=useState(5),[shipSkill,setShipSkill]=useState(5);
  const [plan,setPlan]=useState<{origin:number;destination:number;waypoints:number[];automatic?:boolean;autoContinuation?:boolean;interruptionAt?:number;settingsKey?:string}|null>(null),[legs,setLegs]=useState<Leg[]>([]);
  const [autoBusy,setAutoBusy]=useState(false),[autoClock,setAutoClock]=useState(()=>Date.now());
  const autoRequest=useRef<AbortController|null>(null);
  const autoClient=useRef<string|null>(null),autoPending=useRef<{client:string;request:string}|null>(null);
  const [retryDelay,setRetryDelay]=useState(0);
  const incursionRequest=useRef<AbortController|null>(null);
  const incursionGeneration=useRef(0);
  const [planRun,setPlanRun]=useState(0),[dismissedDirect,setDismissedDirect]=useState<Set<string>>(()=>new Set());
  const [dismissedCompletion,setDismissedCompletion]=useState<Set<string>>(()=>new Set());
  const [selected,setSelected]=useState<StarSystem|null>(null),[menu,setMenu]=useState<{system:StarSystem;x:number;y:number}|null>(null);
  const [candidateLimit,setCandidateLimit]=useState(12),[landingLimit,setLandingLimit]=useState(5);
  const [incursions,setIncursions]=useState<Incursions|null>(null),[incursionBusy,setIncursionBusy]=useState(false),[stations,setStations]=useState<Stations|null>(null),[stationError,setStationError]=useState(''),[stationBusy,setStationBusy]=useState(false);
  const [searchText,setSearchText]=useState('');
  const {avoid,setAvoid,toggle:toggleBlocked,ready:avoidReady,storageError,preferences,setPreferences}=useNavigationAvoid('jump');
  const {npcStationsOnly,history,gateLines}=preferences;
  const gateMode='shortest';
  const policy=useMemo(()=>avoidPolicy(avoid,incursions,autoClock),[avoid,incursions,autoClock]);
  const blocked=policy.blocked;
  const [colorMode,setColorMode]=useState(DEFAULT_STAR_COLOR_MODE);
  const controls=useRef<StarMapControls>(null);
  const origin=points[0],destination=points[points.length-1];
  const waypoints=useMemo(()=>points.slice(1,-1),[points]);
  const graph=useMemo(()=>catalog?navigationGraph(catalog):null,[catalog]);
  const ship=catalog?.ships.find(s=>s.id===shipId)??catalog?.ships[0];
  const skills=useMemo(()=>({calibration,conservation,shipSkill}),[calibration,conservation,shipSkill]);
  const parameters=useMemo(()=>ship?shipParameters(ship,skills):null,[ship,skills]);
  const settingsKey=JSON.stringify([ship?.id,skills,npcStationsOnly]);
  const autoDraftKey=JSON.stringify([origin.id,destination.id,waypoints.map(p=>p.id),settingsKey,avoid]);
  const current=plan?(legs.at(-1)?.to??plan.origin):null;
  const dirty=!!plan&&(origin.id!==plan.origin||destination.id!==plan.destination||JSON.stringify(waypoints.map(p=>p.id))!==JSON.stringify(plan.waypoints)||!!plan.automatic&&plan.settingsKey!==settingsKey);
  const autoEnvironmentError=plan?.automatic&&avoid.avoidIncursions&&(!Array.isArray(incursions?.ids)||!feedIsCurrent(incursions,75*60000,autoClock))?'自动规划的入侵名单不可用或已过期，请刷新后重新计算，或关闭入侵规避。':'';
  const autoIssues=useCallback((leg:Leg,feed:Incursions|null=incursions,clock=autoClock)=>graph?[...autoRouteIssues(graph,leg,feed,avoid.avoidIncursions,clock),...autoStationIssues(graph,leg,catalog?.stations,npcStationsOnly)]:['星图资料不可用'],[graph,incursions,avoid.avoidIncursions,autoClock,catalog?.stations,npcStationsOnly]);
  const gateIssues=useCallback((rows:Leg[],route=plan)=>graph&&route?autoGateIssues(graph,rows,route.destination,route.waypoints,route.origin):[],[graph,plan]);
  const progress=useMemo(()=>plan?checkpointProgress(plan.origin,legs,plan.waypoints):{completed:0,remaining:[] as number[]},[plan,legs]);
  const inspected=useMemo<(Leg&{distance:number;fuel:number;gates:number;issues:string[]})[]>(()=>graph&&ship?legs.map(l=>{const checked=inspectLeg(graph,l,ship,skills,blocked);return plan?.automatic?{...checked,issues:[...checked.issues,...autoIssues(l)]}:checked;}):[],[graph,ship,skills,legs,blocked,plan,autoIssues]);
  const endpointIssues=useMemo(()=>graph&&ship&&plan?[...(policy.error?[policy.error]:[]),...(autoEnvironmentError?[autoEnvironmentError]:[]),...(plan.automatic?gateIssues(legs):[]),...planEndpointIssues(graph,[plan.origin,...plan.waypoints,plan.destination],ship,blocked)]:[],[graph,ship,plan,blocked,policy.error,autoEnvironmentError,gateIssues,legs]);
  const routeState=routePlanState({planned:!!plan,dirty,endpointIssues,legs:inspected,arrived:!!plan&&current===plan.destination&&progress.remaining.length===0});
  const oldPlan=routeState.kind==='dirty'||routeState.kind==='invalid';
  const destinationStatus=useMemo(()=>(()=>{const status=destinationJumpStatus(graph,plan,legs,ship,skills,{dirty,blocked});const issue=policy.error||autoEnvironmentError||(plan?.automatic?inspected.flatMap(l=>l.issues).join('；'):'')||(plan?.automatic&&status.leg?autoIssues(status.leg as Leg).join('；'):'');return issue&&plan?{...status,kind:'blocked',label:'需重新检查规划',message:issue,leg:null}:status;})(),[graph,plan,legs,ship,skills,dirty,blocked,policy.error,autoEnvironmentError,inspected,autoIssues]);
  const directLeg=destinationStatus.leg;
  const directKey=useMemo(()=>directLeg?JSON.stringify([planRun,legs,ship?.id,skills]):'',[directLeg,planRun,legs,ship,skills]);
  const showDirect=!!directLeg&&!dismissedDirect.has(directKey);
  const routeText=useMemo(()=>routeState.kind==='complete'&&graph&&plan?formatJumpRoute(graph,plan.origin,legs):'',[routeState.kind,graph,plan,legs]);
  const completionKey=routeText?JSON.stringify([planRun,routeText]):'';
  const showCompletion=!!completionKey&&!dismissedCompletion.has(completionKey);
  const candidates=useMemo(()=>graph&&current&&parameters?!policy.error?rangeSystems(graph,current,parameters.range,blocked):[]:[],[graph,current,parameters,blocked,policy.error]);
  const landings=useMemo(()=>graph&&plan?!policy.error?nearbyLandings(graph,plan.destination,landingLimit,blocked):[]:[],[graph,plan,landingLimit,blocked,policy.error]);
  const incursionIds=useMemo(()=>new Set(incursions?.ids??[]),[incursions]);
  const incursionUnavailable=!!incursions&&(!Array.isArray(incursions.ids)||!feedIsCurrent(incursions,75*60000,autoClock));
  const complete=routeState.kind==='complete';
  const overlay=useMemo<JumpMapOverlay|null>(()=>plan&&current&&parameters?{origin:plan.origin,destination:plan.destination,center:current,range:parameters.range,candidates:complete?[]:candidates.map(s=>s.id),landings:complete?[]:landings.map(s=>s.id),legs:inspected,circleIds:complete?[]:history?[plan.origin,...legs.map(l=>l.to)]:[current],waypoints:plan.waypoints,completedWaypoints:oldPlan?0:progress.completed,planId:planRun,destinationHint:{color:destinationStatus.color,label:`${destinationStatus.label}${destinationStatus.distance!==null?` · ${precise(destinationStatus.distance)} 光年`:''}`,state:destinationStatus.kind}}:null,[plan,current,parameters,candidates,landings,inspected,history,legs,destinationStatus,complete,oldPlan,progress.completed,planRun]);
  const tools=useJumpTools({graph,ship:ship??null,skills,blocked,incursions,avoidIncursions:avoid.avoidIncursions,npcStationsOnly,stations:catalog?.stations,now:autoClock});
  const {cancelEffects,clearCalculations}=tools;
  const hasCalculation=tools.active!==null||!!plan||legs.length>0||!!origin.text||!!destination.text||waypoints.length>0||autoBusy;
  const cancelAutomatic=useCallback(()=>{
    const pending=autoPending.current;autoPending.current=null;
    autoRequest.current?.abort();autoRequest.current=null;setAutoBusy(false);
    if(pending)void fetch('/api/navigation/jump/cancel',{method:'DELETE',headers:{'x-jump-client':pending.client,'x-jump-request':pending.request},keepalive:true}).catch(()=>{});
  },[]);
  const clearAllCalculations=useCallback(()=>{
    cancelAutomatic();
    setPoints([{key:1,text:'',id:null},{key:2,text:'',id:null}]);
    setPlan(null);setLegs([]);setPlanRun(value=>value+1);
    setDismissedDirect(new Set());setDismissedCompletion(new Set());
    setSelected(null);setMenu(null);setSearchText('');setStations(null);setStationError('');setError('');
    setCandidateLimit(12);setLandingLimit(5);clearCalculations();
  },[clearCalculations,cancelAutomatic]);
  const select=useCallback((s:StarSystem)=>{setSelected(s);setMenu(null);controls.current?.focus(s);},[]);
  const hoverDetails=useCallback((s:StarSystem)=>{
    const rows:string[]=[];
    if(current&&graph)rows.push(`距当前点：${number(distanceLightyears(graph.systems.get(current),s))} 光年`);
    return rows;
  },[current,graph]);
  const context=useCallback((s:StarSystem,p:{x:number;y:number})=>{setSelected(s);setMenu({system:s,x:p.x,y:p.y});},[]);
  useEffect(()=>{cancelAutomatic();return cancelAutomatic;},[autoDraftKey,cancelAutomatic]);
  useEffect(()=>{window.addEventListener('pagehide',cancelAutomatic);return()=>window.removeEventListener('pagehide',cancelAutomatic);},[cancelAutomatic]);
  useEffect(()=>{if(!retryDelay)return;const timer=setTimeout(()=>setRetryDelay(n=>Math.max(0,n-1)),1000);return()=>clearTimeout(timer);},[retryDelay]);
  useEffect(()=>{const timer=setInterval(()=>setAutoClock(Date.now()),60000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{const media=window.matchMedia('(min-width: 701px)'),update=()=>setDesktop(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useEffect(()=>{
    const abort=new AbortController();setCatalogBusy(true);setCatalogError('');
    fetch('/api/navigation/jump/catalog',{signal:abort.signal,cache:'no-store'}).then(async r=>{
      const body=await r.json();if(!r.ok)throw new Error(typeof body?.error==='string'?body.error:'基础资料加载失败');
      const valid=validateJumpCatalog(body);if(abort.signal.aborted)return;
      setShipId(previous=>valid.ships.some((s:Ship)=>s.id===previous)?previous:valid.ships[0].id);
      setCatalog({...valid,scope:'手动跳跃规划 · 地理数据尚未全量核验晨曦'});
    }).catch(e=>{if(!abort.signal.aborted){setCatalog(null);setCatalogError(e instanceof Error?e.message:'基础资料加载失败');}}).finally(()=>{if(!abort.signal.aborted)setCatalogBusy(false);});
    return()=>abort.abort();
  },[catalogAttempt]);
  const refreshIncursions=useCallback(async()=>{
    if(incursionRequest.current)return;
    const abort=new AbortController();incursionRequest.current=abort;
    const generation=++incursionGeneration.current;
    setIncursionBusy(true);
    try{
      const r=await fetch('/api/navigation/jump/incursions',{signal:abort.signal,cache:'no-store'}),body=await r.json();
      if(!r.ok)throw new Error('入侵信息获取失败');
      if(!body||typeof body.stale!=='boolean'||body.ids!==null&&(!Array.isArray(body.ids)||body.ids.some((id:unknown)=>!Number.isSafeInteger(id)||Number(id)<=0)))throw new Error('入侵信息格式错误');
      if(!abort.signal.aborted&&generation===incursionGeneration.current){setIncursions(body);setAutoClock(Date.now());}
    }
    catch(e){if(!abort.signal.aborted&&generation===incursionGeneration.current)setIncursions({ids:null,modified:null,stale:true,error:e instanceof Error?e.message:'入侵信息获取失败'});}
    finally{if(incursionRequest.current===abort){incursionRequest.current=null;if(!abort.signal.aborted)setIncursionBusy(false);}}
  },[]);
  useEffect(()=>{
    const refresh=()=>{if(!document.hidden)void refreshIncursions();};
    refresh();const timer=setInterval(refresh,300000);document.addEventListener('visibilitychange',refresh);
    return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',refresh);incursionRequest.current?.abort();incursionRequest.current=null;};
  },[refreshIncursions]);
  useEffect(()=>{
    setStations(null);setStationError('');if(!selected){setStationBusy(false);return;}
    const abort=new AbortController();setStationBusy(true);
    fetch(`/api/navigation/jump/stations?system_id=${selected.id}`,{signal:abort.signal}).then(async r=>{const b=await r.json();if(!r.ok)throw new Error(b.error);setStations(b);}).catch(e=>{if(!abort.signal.aborted)setStationError(e.message);}).finally(()=>{if(!abort.signal.aborted)setStationBusy(false);});
    return()=>abort.abort();
  },[selected]);
  useEffect(()=>{if(!menu)return;const close=()=>setMenu(null);const key=(e:KeyboardEvent)=>{if(e.key==='Escape')close();};window.addEventListener('pointerdown',close);window.addEventListener('keydown',key);window.addEventListener('resize',close);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',key);window.removeEventListener('resize',close);};},[menu]);
  function setPoint(s:StarSystem,role:'origin'|'destination'|'waypoint'){
    if(!graph||!ship)return;
    const issues=planEndpointIssues(graph,[s.id],ship,blocked);if(issues.length){setError(issues.join('；'));setMenu(null);return;}
    if(role==='waypoint'&&waypoints.length>=10){setError('最多添加 10 个途经点');setMenu(null);return;}
    const point={key:role==='waypoint'?++pointKeys.current:0,text:s.nameZh,id:s.id};
    setPoints(rows=>assignNavigationPoint(rows,point,role));
    cancelEffects();setSelected(s);setError('');setMenu(null);
  }
  function pointButtons(s:StarSystem){return <div className="jump-point-actions"><button onClick={()=>setPoint(s,'origin')}>设为起点</button><button onClick={()=>setPoint(s,'destination')}>设为终点</button><button disabled={waypoints.length>=10} onClick={()=>setPoint(s,'waypoint')}>添加途经点</button></div>;}
  function begin(){cancelEffects();const policyError=avoidPolicy(avoid,incursions).error;if(!avoidReady||policyError){setError(policyError||'正在读取本地规避配置');return;}if(!graph||!ship||origin.id===null||destination.id===null||waypoints.some(p=>p.id===null)){setError('请从候选列表选择舰船、起点、终点及所有途经点');return;}const ids=waypoints.map(p=>p.id!);const issues=planEndpointIssues(graph,[origin.id,...ids,destination.id],ship,blocked);if(issues.length){setError(issues.join('；'));return;}setPlan({origin:origin.id,destination:destination.id,waypoints:ids});setPlanRun(n=>n+1);setDismissedDirect(new Set());setLegs([]);setSelected(graph.systems.get(origin.id));setCandidateLimit(12);setError('');setMenu(null);}
  async function calculateAutomatic(){
    if(autoRequest.current||retryDelay>0)return;
    if(!graph||!ship||!avoidReady||origin.id===null||destination.id===null||waypoints.some(p=>p.id===null)){setError('请从候选列表选择舰船、起点、终点及所有途经点');return;}
    const abort=new AbortController();autoRequest.current=abort;
    if(!autoClient.current)autoClient.current=requestToken();
    const pending={client:autoClient.current,request:requestToken()};autoPending.current=pending;
    const generation=++incursionGeneration.current;setAutoBusy(true);setError('');setMenu(null);
    const nextPlan={origin:origin.id,destination:destination.id,waypoints:waypoints.map(p=>p.id!),automatic:true,settingsKey};
    let refreshOnError=true,responseReceived=false;
    try{
      const r=await fetch('/api/navigation/jump/auto',{method:'POST',headers:{'content-type':'application/json','x-jump-client':pending.client,'x-jump-request':pending.request},signal:abort.signal,body:JSON.stringify({...nextPlan,shipId:ship.id,skills,npcStationsOnly,avoid})});
      responseReceived=true;
      const body=await r.json();if(abort.signal.aborted)return;
      if(r.status===429||r.status===503&&typeof body.code==='string'&&body.code.startsWith('JUMP_')){setRetryDelay(Math.min(30,Math.max(1,Number(r.headers.get('retry-after'))||2)));refreshOnError=false;}
      if(body.incursions&&generation===incursionGeneration.current)setIncursions(body.incursions);
      if(!r.ok)throw new Error(body.error||'自动计算失败');
      const partial=body.complete===false;
      if(body.complete!==undefined&&typeof body.complete!=='boolean')throw new Error('自动路线状态无效');
      if(!Array.isArray(body.legs))throw new Error('自动路线格式无效');
      let previous=nextPlan.origin;
      for(const leg of body.legs as Leg[]){
        if(!leg||!['jump','gate'].includes(leg.kind)||leg.from!==previous||!Array.isArray(leg.ids)||leg.ids.length<2||leg.ids[0]!==leg.from||leg.ids.at(-1)!==leg.to||leg.ids.some(id=>!graph.systems.has(id))||leg.kind==='jump'&&leg.ids.length!==2||leg.kind==='gate'&&leg.ids.slice(1).some((id,i)=>!graph.adjacent.get(leg.ids[i])?.includes(id)))throw new Error('基础资料已变化，请重新加载页面后自动计算。');
        const issues=[...inspectLeg(graph,leg,ship,skills,blocked).issues,...autoIssues(leg,body.incursions,Date.now())];
        if(issues.length)throw new Error(issues.join('；'));
        previous=leg.to;
      }
      if(partial){if(body.interruptionAt!==previous||previous===nextPlan.destination&&!checkpointProgress(nextPlan.origin,body.legs,nextPlan.waypoints).remaining.length)throw new Error('自动路线中断点无效');}
      else if(previous!==nextPlan.destination||checkpointProgress(nextPlan.origin,body.legs,nextPlan.waypoints).remaining.length)throw new Error('自动路线未完成全部点位，请重新计算。');
      const gateProblems=gateIssues(body.legs,nextPlan);if(gateProblems.length)throw new Error(gateProblems.join('；'));
      setPlan(partial?{...nextPlan,automatic:false,autoContinuation:true,interruptionAt:previous}:nextPlan);setLegs(body.legs);setPlanRun(n=>n+1);setDismissedDirect(new Set());setSelected(graph.systems.get(partial?previous:nextPlan.origin));setCandidateLimit(12);setAutoClock(Date.now());
      if(partial)setError(`路径不可达，已保留可达路段并在「${graph.systems.get(previous)?.nameZh}」切换手动模式，请自行选点继续规划。`);
    }catch(e){if(!abort.signal.aborted){if(!responseReceived)cancelAutomatic();setError(e instanceof Error?e.message:'自动计算失败');if(refreshOnError)void refreshIncursions();}}
    finally{if(autoRequest.current===abort){autoRequest.current=null;autoPending.current=null;setAutoBusy(false);}}
  }
  function declineDirect(){if(directKey)setDismissedDirect(keys=>new Set([...keys,directKey]));}
  function dismissCompletion(){if(completionKey)setDismissedCompletion(keys=>new Set([...keys,completionKey]));}
  function viewCompletedRoute(){
    dismissCompletion();
    requestAnimationFrame(()=>{
      const section=document.getElementById('jump-route-copy');
      section?.querySelector('textarea')?.focus({preventScroll:true});
      section?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
    });
  }
  function append(id:number,kind:'jump'|'gate'){
    if(autoBusy)return;
    const policyError=avoidPolicy(avoid,incursions).error;if(policyError){setError(policyError);return;}
    if(!graph||!plan||current===null){setError('请先选择起终点并开始规划');return;}if(dirty){setError('点位已修改，请点击重新开始');return;}if(!plan.automatic&&!plan.autoContinuation&&legs.length>=30){setError('Demo 最多保留 30 个手动路段');return;}
    try{if(!ship)throw new Error('请选择舰船');const issues=planEndpointIssues(graph,[plan.origin,...plan.waypoints,plan.destination],ship,blocked);if(issues.length)throw new Error(issues.join('；'));if(autoEnvironmentError)throw new Error(autoEnvironmentError);if(inspected.some(l=>l.issues.length))throw new Error('当前路线不符合舰船、技能或规避设置，请撤销问题路段或重新开始');const leg=makePlanLeg(graph,current,id,kind,gateMode,ship,skills,blocked) as Leg;if(plan.automatic){const issues=[...autoIssues(leg,incursions,Date.now()),...gateIssues([...legs,leg])];if(issues.length)throw new Error(issues.join('；'));}setLegs(rows=>[...rows,leg]);setSelected(graph.systems.get(id));setMenu(null);setCandidateLimit(12);setError('');}catch(e){setError(e instanceof Error?e.message:'无法添加路段');}
  }
  function summary(s:StarSystem){const count=catalog?.stations[s.id]?.length??0;return `${sec(s.security)} · ${s.regionName} · ${count} 个 SDE NPC 站${incursionIds.has(s.id)?(incursions?.stale||incursions?.error?' · 萨沙记录待刷新':' · 萨沙入侵'):''}`;}
  function pick(id:number){const s=graph?.systems.get(id);if(s)select(s);}
  const actionTarget=menu?.system??selected;
  const actions=useMemo(()=>{
    const unavailable=(reason:string)=>({jump:{leg:null,error:reason},gate:{leg:null,error:reason}});
    if(policy.error)return unavailable(policy.error);
    if(autoEnvironmentError)return unavailable(autoEnvironmentError);
    if(!graph||!ship||!plan||current===null||!actionTarget)return unavailable('请先开始规划，再选择目标星系');
    if(dirty)return unavailable('点位已修改，请重新开始');
    const issues=planEndpointIssues(graph,[plan.origin,...plan.waypoints,plan.destination],ship,blocked);
    if(issues.length)return unavailable(issues.join('；'));
    if(inspected.some(l=>l.issues.length))return unavailable('当前路线不符合舰船或技能，请撤销问题路段或重新开始');
    if(!plan.automatic&&!plan.autoContinuation&&legs.length>=30)return unavailable('Demo 最多保留 30 个手动路段');
    const available=nextPlanActions(graph,current,actionTarget.id,ship,skills,gateMode,blocked);
    if(plan.automatic)for(const kind of ['jump','gate'] as const){const leg=available[kind].leg as Leg|null;if(leg){const issues=[...autoIssues(leg),...gateIssues([...legs,leg])];if(issues.length)available[kind]={leg:null,error:issues.join('；')};}}
    return available;
  },[graph,ship,plan,current,actionTarget,dirty,inspected,legs,skills,gateMode,blocked,policy.error,autoEnvironmentError,autoIssues,gateIssues]);
  const actionReasons=[...new Set([actions.jump.error,actions.gate.error].filter(Boolean))].join('；');
  return <main className="navigation-page jump-page" style={STAR_SECURITY_CSS_VARS as React.CSSProperties} onContextMenu={e=>{if(menu)e.preventDefault();}}>
    <header className="nav-header"><div><span className="nav-eyebrow">BRIDGE TOOL 03 / JUMP WORKBENCH</span><h1>旗舰跳跃规划 <small>DEMO</small></h1><p>自动计算或手动选路 · 跳距与燃料估算 · NPC 站点及入侵信息</p></div><span className="nav-preview-badge">自动 / 手动规划 <i/> NPC 站点 / 萨沙信息</span></header>
    <section className="nav-layout jump-layout" aria-label="旗舰跳跃规划">
      <aside className="nav-panel jump-panel">
        <PlannerHeading mode="jump"/>
        <label className="jump-field">舰船<select aria-label="规划舰船" value={shipId} onChange={e=>setShipId(Number(e.target.value))}>{catalog?.ships.map(s=><option key={s.id} value={s.id}>{s.name} · {s.group}</option>)}</select></label>
        <div className="jump-skills">{([{name:'校对等级',value:calibration,set:setCalibration},{name:'燃料节约',value:conservation,set:setConservation},{name:'舰船技能',value:shipSkill,set:setShipSkill}]).map(s=><label key={s.name}>{s.name}<select aria-label={s.name} value={s.value} disabled={s.name==='舰船技能'&&!ship?.shipFuelBonus} onChange={e=>s.set(Number(e.target.value))}>{[0,1,2,3,4,5].map(n=><option key={n} value={n}>{n}</option>)}</select></label>)}</div>
        <div className="jump-range"><small>当前跳跃半径</small><strong>{parameters?number(parameters.range):'—'} <em>光年</em></strong><span>{ship?.fuelName??'燃料'} · {parameters?number(parameters.fuelPerLy):'—'} 单位 / 光年</span></div>
        <WaypointList points={points} systems={catalog?.systems??[]} inputLabel={(i,total)=>i===0?'旗舰规划起点':i===total-1?'旗舰规划终点':`旗舰规划途经点 ${i}`} onEdit={(key,text,id)=>setPoints(rows=>rows.map(p=>p.key===key?{...p,text,id}:p))} onMove={(key,target)=>setPoints(rows=>moveWaypoint(rows,key,target))} onRemove={key=>setPoints(rows=>rows.length>2?rows.filter(p=>p.key!==key):rows)}/>
        <div className="nav-point-tools"><button disabled={waypoints.length>=10} onClick={()=>{const point={key:++pointKeys.current,text:'',id:null};setPoints(rows=>assignNavigationPoint(rows,point,'waypoint'));}}>＋ 添加途经点</button><button onClick={()=>setPoints(rows=>[...rows].reverse())}>⇅ 交换起终点</button></div>
        <p className="nav-help">按住点位左侧拖动，或用上下按钮调整起点、途经点和终点；调整后需重新计算。也可右键星图设置点位。</p>
        <div className="nav-avoid-switches jump-auto-options" role="group" aria-label="自动规划选项"><button type="button" aria-label="仅计算有NPC空间站的星系" aria-pressed={npcStationsOnly} onClick={()=>setPreferences({npcStationsOnly:!npcStationsOnly})}>仅计算有NPC空间站的星系</button></div>
        <div className="jump-planning-actions"><button className="nav-calculate jump-auto-calculate" disabled={!catalog||catalogBusy||!avoidReady||autoBusy||retryDelay>0} onClick={()=>void calculateAutomatic()}>{autoBusy?'正在排队 / 计算…':retryDelay>0?`${retryDelay} 秒后可重试`:'自动计算'}</button><button className="nav-calculate jump-manual-calculate" disabled={!catalog||catalogBusy||!avoidReady||autoBusy} onClick={begin}>{plan?'重新开始':'手动规格线路'}</button>{autoBusy&&<button type="button" className="nav-small-button jump-auto-cancel" onClick={cancelAutomatic}>取消计算</button>}</div>
        <p className="nav-help jump-auto-rules">自动路线按点位顺序分段计算。高安途经点和终点允许先旗舰跳到低安边界，再经高安星门抵达，尽量减少过门；到达指定途经点后继续下一段。其他路段必须旗舰跳，不允许未指定的过门中转。“仅计算有NPC空间站的星系”仅限制旗舰跳落点；入侵规避覆盖所有途经星系。</p>
        {plan?.autoContinuation&&<p className="jump-plan-state" role="status">自动规划在「{graph?.systems.get(plan.interruptionAt!)?.nameZh}」中断，已切换手动接续。已保留可达路段和原起终点、途经点，请从当前点自行选点，确认跳跃或过门。完整到达终点后才可复制路线。</p>}
        {catalogError&&<div className="nav-error jump-catalog-error" role="alert"><p>基础资料不可用：{catalogError}</p><button className="nav-small-button" disabled={catalogBusy} onClick={()=>setCatalogAttempt(n=>n+1)}>重新加载基础资料</button></div>}
        {dirty&&<p className="nav-dirty">点位或自动规划设置已修改，请重新计算或重新开始。原路线暂时保留。</p>}
        {plan&&<section className={`jump-destination-status is-${destinationStatus.kind}`} aria-label="终点可达性" role="status"><b>{graph?.systems.get(plan.destination)?.nameZh} · {destinationStatus.label}</b>{destinationStatus.distance!==null&&destinationStatus.range!==null&&<dl><div><dt>距当前点 / 航程</dt><dd>{precise(destinationStatus.distance)} / {precise(destinationStatus.range)} 光年</dd></div>{destinationStatus.kind==='out-of-range'&&destinationStatus.gap!==null&&<div><dt>超出航程</dt><dd>{precise(destinationStatus.gap)} 光年</dd></div>}</dl>}<p>{destinationStatus.message}</p>{directLeg&&!showDirect&&<button className="nav-small-button" onClick={()=>setDismissedDirect(keys=>{const next=new Set(keys);next.delete(directKey);return next;})}>确认直达终点</button>}{destinationStatus.kind==='complete'&&<a href="#jump-route-copy">查看完整路径 ↓</a>}<small>按三维距离判断，屏幕投影看起来在圈内不代表实际可达。金色仅表示终点附近星系；虚线仅为测距，不是已规划路径。</small></section>}
        <p className="nav-help">不设 30 段自动路线上限，计算超时会明确提示。手动规划可自行选择跳跃或星门，星门段按最短合法路径计算。</p>
        {desktop&&<div className="jump-map-options"><label><input type="checkbox" checked={history} disabled={complete} onChange={e=>setPreferences({history:e.target.checked})}/>保留接力范围圈（完成后隐藏）</label><label><input type="checkbox" checked={gateLines} onChange={e=>setPreferences({gateLines:e.target.checked})}/>显示星门连接</label></div>}
        <AvoidPanel mode="jump" systems={catalog?.systems??[]} value={avoid} onChange={setAvoid} onToggle={toggleBlocked} error={storageError||policy.error}/>
        <div className="jump-source"><b>NPC 落点与入侵规避独立控制</b><p>NPC 站按钮仅影响自动旗舰跳落点，不限制星门途中，也不影响手动选点。入侵规避开启时，高安、低安和零零中的入侵星系全部排除；名单失效时停止新增规划。关闭后不按入侵筛选。超距和舰船准入限制始终校验。</p><p>NPC 站仅表示 SDE 基线中有空间站，不保证所选舰船可停靠。不包含玩家建筑、诱导条件或角色权限。</p></div>
      </aside>
      <div className="nav-workspace" inert={autoBusy} aria-busy={autoBusy}>
        {desktop!==null&&<div className="nav-analysis-toolbar"><div className="nav-map-toolbar-main">{desktop===true&&<MapDimensionControl value={dimension} onChange={setDimension}/>}<JumpToolsBar systems={catalog?.systems??[]} tools={tools} disabled={!catalog||!avoidReady||autoBusy} onCalculate={()=>{setSelected(null);setMenu(null);}}/></div>{desktop===false&&<button type="button" disabled={!hasCalculation} onClick={clearAllCalculations}>清除计算</button>}{plan&&<button onClick={()=>{setLegs(rows=>rows.slice(0,-1));setMenu(null);}} disabled={!legs.length||autoBusy}>撤销上一段</button>}</div>}
        {desktop===true&&<div className="nav-map-stage jump-map-stage">
          <MapSystemSearch systems={catalog?.systems??[]} disabled={!catalog} onLocate={system=>{const star=graph?.systems.get(system.id);if(star)select(star);}}/>
          {catalog?<Suspense fallback={<div className="nav-loading">正在准备三维规划图…</div>}><StarMap ref={controls} dimension={dimension} data={catalog} blockedIds={avoid.avoid} selected={selected} gateLines={gateLines} colorMode={colorMode} environment={environment} onSelect={select} onContext={context} hoverDetails={hoverDetails} routes={NO_ROUTES} focusRoutes={false} activity={NO_ACTIVITY} jumpOverlay={overlay} reachOverlay={tools.reachOverlay} distanceOverlay={tools.distanceOverlay} hasCalculation={hasCalculation} onClearCalculation={clearAllCalculations}/></Suspense>:<div className="nav-loading">{catalogError?'基础资料不可用，请使用左侧重新加载按钮重试。':'正在加载地理与舰船数据…'}</div>}
          {graph&&<JumpToolsResults systems={graph.systems} tools={tools} onSelect={select}/>}
          {selected&&!menu&&<SelectedSystemCard system={selected} environment={environment} blocked={avoid.avoid.includes(selected.id)} onClose={()=>setSelected(null)}>
            {pointButtons(selected)}<button className="nav-block-action" onClick={()=>toggleBlocked(selected.id)}>{avoid.avoid.includes(selected.id)?'移出屏蔽列表':'加入屏蔽列表'}</button>
            {current&&graph&&<p className="nav-selected-distance">距当前点：{number(distanceLightyears(graph.systems.get(current),selected))} 光年</p>}
            {actions.jump.leg&&<button onClick={()=>append(selected.id,'jump')}>旗舰跳到这里</button>}{actions.gate.leg&&<button onClick={()=>append(selected.id,'gate')}>经星门到这里</button>}
            {plan&&<p className="jump-action-reason">{actionReasons}</p>}
          </SelectedSystemCard>}
        </div>}
        {desktop===true&&<MapColorBar mode={colorMode} onChange={setColorMode} environment={environment}/>}
        {desktop===false&&<><p className="nav-mobile-note">手机端不加载三维星图。通过候选列表和星系搜索添加路段，计算规则相同。</p>{graph&&<div className="jump-mobile-tools"><JumpToolsResults systems={graph.systems} tools={tools} onSelect={select}/></div>}</>}
        <section className="jump-information" aria-label="规划与星系信息">
          <div className="jump-plan-head"><div><span className="nav-eyebrow">02 / YOUR PLAN</span><h2>{oldPlan?'旧规划（待确认）':'已选路线'}</h2></div><div className="jump-totals"><b>{legs.filter(l=>l.kind==='jump').length} 次旗舰跳</b><span>{inspected.reduce((n,l)=>n+l.gates,0)} 次过门</span><span>{oldPlan?'旧规划燃料估算':'预计燃料'} {number(inspected.reduce((n,l)=>n+l.fuel,0))}</span></div></div>
          {oldPlan&&<p className="jump-plan-state" role="status">{routeState.kind==='dirty'?'点位已修改，当前只保留旧规划，请重新开始。':`当前规划已失效：${routeState.issues.join('；')}。请撤销问题路段、调整设置或重新开始。`}</p>}
          {plan&&plan.waypoints.length>0&&<div className="jump-checkpoints" aria-label="途经点进度"><b>{oldPlan?'旧规划途经记录':'途经点'} {progress.completed} / {plan.waypoints.length}</b>{plan.waypoints.map((id,i)=><button key={i} className={!oldPlan&&i<progress.completed?'is-visited':''} onClick={()=>pick(id)}>{i<progress.completed?'✓':'○'} {i+1}. {graph?.systems.get(id)?.nameZh}</button>)}{oldPlan&&<p>仅表示旧规划线经过的点位，不代表当前条件下可执行。</p>}{!oldPlan&&current===plan.destination&&progress.remaining.length>0&&<p>已到 B，但仍有途经点尚未按顺序经过。</p>}</div>}
          {!plan?<p className="nav-empty">选择 A / B 后点击“自动计算”生成路线，或点击“手动规格线路”手动逐段选路。</p>:<><div className="jump-route-origin"><i>A</i><button onClick={()=>pick(plan.origin)}>{graph?.systems.get(plan.origin)?.nameZh}</button><span>{plan.automatic?'自动计算':'手动规划'} · 目标 B：{graph?.systems.get(plan.destination)?.nameZh}</span></div>{inspected.map((l,i)=><div key={i} className={`jump-leg ${l.issues.length?'has-issue':''}`}><i>{l.kind==='jump'?'↗':'⇢'}</i><div><b>{graph?.systems.get(l.from)?.nameZh} → {graph?.systems.get(l.to)?.nameZh}</b><span>{l.kind==='jump'?`旗舰跳 · ${number(l.distance)} 光年 · 预计燃料 ${number(l.fuel)}`:`星门路段 · ${l.gates} 次过门`}</span><small>{l.kind==='gate'?l.ids.map(id=>graph?.systems.get(id)?.nameZh).join(' → '):summary(graph?.systems.get(l.to))}</small>{l.issues.length>0&&<strong role="status">{l.issues.join('；')} · 仅保留规划线，不可视为可执行路线</strong>}</div><button onClick={()=>{setLegs(rows=>rows.slice(0,i));setMenu(null);}} aria-label={`删除第 ${i+1} 段及后续路线`}>删除后续</button></div>)}{routeState.kind==='complete'&&<p className="jump-arrived" role="status">路线已完成，请在下方复制路径。<a href="#jump-route-copy">前往复制路径 ↓</a></p>}{routeState.kind==='incomplete'&&<p className="nav-help">路线尚未完成。请按途经点顺序继续选点，再决定旗舰跳或经星门前往。</p>}</>}
          {selected&&<section className="jump-point-picker" aria-label="设置规划点位"><b>{selected.nameZh} · 规划点位</b>{pointButtons(selected)}</section>}
          <div className="jump-info-grid">
            <section className="jump-inspector"><span className="nav-eyebrow">03 / SYSTEM INTELLIGENCE</span><h2>星系地理与站点</h2><SystemPicker systems={catalog?.systems??[]} value={searchText} label="查看规划星系" placeholder="搜索任意星系查看 / 添加路段" onChange={(text,id)=>{setSearchText(text);if(id){const s=graph?.systems.get(id);if(s)select(s);}}}/>
              {selected?<><div className="jump-system-title"><h3 className={avoid.avoid.includes(selected.id)?'is-blocked':''}>{selected.nameZh}</h3><span className={securityBand(selected.security)} style={securityTextStyle(selected.security)}>{sec(selected.security)}</span></div><p>{selected.nameEn} · {selected.regionName} · ID {selected.id}</p><dl><div><dt>距当前点</dt><dd>{current?`${number(distanceLightyears(graph?.systems.get(current),selected))} 光年`:'—'}</dd></div><div><dt>地理坐标（米）</dt><dd>{[selected.x,selected.y,selected.z].map(n=>n.toExponential(4)).join(' / ')}</dd></div><div><dt>NPC 站点</dt><dd>{stationBusy?'正在读取数据库…':stations?`SDE 缓存 ${stations.stations.length} 个`:`SDE ${catalog?.stations[selected.id]?.length??0} 个（未核实）`}</dd></div><div><dt>萨沙入侵</dt><dd>{incursions?.ids&&!incursions.stale&&!incursions.error?(incursionIds.has(selected.id)?'在本次入侵名单中':'不在本次名单中'):'未知 / 数据暂不可用'}</dd></div></dl>{stations&&<ul className="jump-stations">{stations.stations.slice(0,3).map(s=><li key={s.id}>{s.name}<small>ID {s.id}</small></li>)}{stations.stations.length>3&&<li>另有 {stations.stations.length-3} 个 NPC 空间站</li>}</ul>}{stationError&&<p role="status" className="nav-error">{stationError}</p>}<div className="jump-actions"><button className="nav-block-action" onClick={()=>toggleBlocked(selected.id)}>{avoid.avoid.includes(selected.id)?'移出屏蔽列表':'加入屏蔽列表'}</button>{actions.jump.leg&&<button onClick={()=>append(selected.id,'jump')}>旗舰跳到这里</button>}{actions.gate.leg&&<button onClick={()=>append(selected.id,'gate')}>经星门到这里</button>}</div><p className="jump-action-reason" role="status">{actionReasons}</p></>:<p className="nav-help">点选星图、点击候选星系，或在上方搜索。悬停星图也可查看基础信息，不触发额外站点请求。</p>}
            </section>
            <section className="jump-candidates"><span className="nav-eyebrow">04 / EXPLORE YOUR NEXT STOP</span><h2>当前范围内低安 / 00 <small>{candidates.length}</small></h2><p className="nav-help">按三维距离排列，按当前规避开关筛选，不按站点筛除。点击查看，右键设置下一段。</p><div className="jump-candidate-list">{candidates.slice(0,candidateLimit).map(c=>{const s=graph?.systems.get(c.id);return <button key={c.id} onClick={()=>pick(c.id)} onContextMenu={e=>{e.preventDefault();context(s,{x:e.clientX,y:e.clientY});}}><span><b>{s.nameZh}</b><small>{summary(s)}</small></span><em>{number(c.distance)} ly</em></button>;})}</div>{candidateLimit<candidates.length&&<button className="nav-small-button" onClick={()=>setCandidateLimit(n=>n+20)}>显示更多候选</button>}
              <h2>终点附近低安 / 00</h2><p className="nav-help">按到 B 的最短过门数排序；并非当前位置已能起跳。金色点与绿色点重合时可优先查看。</p><div className="jump-candidate-list">{landings.map(c=>{const s=graph?.systems.get(c.id);return <button key={c.id} onClick={()=>pick(c.id)} onContextMenu={e=>{e.preventDefault();context(s,{x:e.clientX,y:e.clientY});}}><span><b>{s.nameZh}</b><small>{summary(s)}</small></span><em>{c.hops} 门至 B</em></button>;})}</div>{plan&&landingLimit<50&&<button className="nav-small-button" onClick={()=>setLandingLimit(n=>n+5)}>多显示 5 个终点附近星系</button>}
            </section>
          </div>
          <div className="jump-data-status" aria-label="入侵信息自动更新"><div><b>萨沙入侵信息</b><span role="status">{incursionUnavailable?'暂不可用 · 自动重试':incursionBusy?'自动更新中…':'自动更新'} · {incursions?.ids?.length??'—'} 个星系</span><span>最近同步 {time(incursions?.fetched??incursions?.modified??null)}</span>{incursionUnavailable&&<strong>名单不可用或已过期，不能据此判断安全；开启入侵规避时暂停规划。系统将自动重试。</strong>}</div>{incursionUnavailable&&<button className="nav-small-button" aria-label="重试入侵信息" disabled={incursionBusy} onClick={()=>void refreshIncursions()}>{incursionBusy?'重试中…':'重试'}</button>}</div>
        </section>
      </div>
    </section>
    {routeText&&<JumpRouteCopy key={routeText} text={routeText}/>}
    {error&&<JumpValidationDialog message={error} onConfirm={()=>setError('')}/>}
    {!error&&!autoBusy&&showCompletion&&<JumpCompletionDialog key={completionKey} onDismiss={dismissCompletion} onViewRoute={viewCompletedRoute}/>}
    {!error&&!autoBusy&&showDirect&&directLeg&&parameters&&ship&&<DirectJumpDialog key={directKey} from={graph?.systems.get(directLeg.from)?.nameZh??''} to={graph?.systems.get(directLeg.to)?.nameZh??''} distance={directLeg.distance} range={parameters.range} fuel={directLeg.fuel} fuelName={ship.fuelName} onDecline={declineDirect} onAccept={()=>{declineDirect();append(directLeg.to,'jump');}}/>}
    {menu&&<div className="jump-context" role="dialog" aria-label="星系路线操作" style={{left:Math.max(8,Math.min(menu.x,window.innerWidth-248)),top:Math.max(8,Math.min(menu.y,window.innerHeight-420))}} onPointerDown={e=>e.stopPropagation()}><header><b className={avoid.avoid.includes(menu.system.id)?'is-blocked':''}>{menu.system.nameZh}</b><button aria-label="关闭星系操作" onClick={()=>setMenu(null)}>×</button></header><small>{summary(menu.system)}</small>{pointButtons(menu.system)}<button className="nav-block-action" onClick={()=>{toggleBlocked(menu.system.id);setMenu(null);}}>{avoid.avoid.includes(menu.system.id)?'移出屏蔽列表':'加入屏蔽列表'}</button>{actions.jump.leg&&<button onClick={()=>append(menu.system.id,'jump')}>↗ 旗舰跳到这里</button>}{actions.gate.leg&&<button onClick={()=>append(menu.system.id,'gate')}>⇢ 经星门到这里</button>}{plan&&<p className="jump-action-reason">{actionReasons}</p>}</div>}
    <p className="nav-dataset-note">Demo：地理与站点基线来自标准 SDE，未与晨曦全量比对；点选后的 NPC 站点清单读取数据库中的 SDE 基线，不代表玩家建筑或实际停靠权限。舰船基础数据核验于 {time(catalog?.shipsVerifiedAt??null)}。耗油为技能后估算，不含装备 / 植入等修正，也不用于跳跃通道或导管运输。仅供规划，不保证诱导、停靠权限及实际可执行性。路线仅保留在当前页面，刷新后清空。</p>
  </main>;
}
