"use client";
import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react';
import type {StarMapData,StarSystem,StarMapControls} from './star-map';
import {securityBand} from '../../lib/star-map.mjs';
import {npcStationLabel,RECENT_GEOGRAPHY_TITLE} from '../../lib/star-hover-environment.mjs';
import {MODE_COLORS,MODE_NAMES} from './navigation-types';
import type {Activities,Mode,RouteBundle,SystemInfo} from './navigation-types';
import AvoidPanel from './avoid-panel';
import {useNavigationAvoid} from './use-navigation-avoid';
import MapColorBar from './map-color-bar';
import MapSystemSearch from './map-system-search';
import MapDimensionControl from './map-dimension-control';
import PlannerHeading from './planner-heading';
import SelectedSystemCard from './selected-system-card';
import {useMapEnvironment} from './use-map-environment';
import {DEFAULT_STAR_COLOR_MODE,STAR_SECURITY_CSS_VARS,securityTextStyle} from '../../lib/star-map-colors.mjs';
import WaypointList from './waypoint-list';
import type {Waypoint} from './waypoint-list';
import {assignNavigationPoint,moveWaypoint} from '../../lib/waypoint-order.mjs';
import './navigation.css';
const StarMap=lazy(()=>import('./star-map'));
const MODES:Mode[]=['secure','shortest','insecure'];
const NO_ACTIVITY={};
type Point=Waypoint;
const format=(value:number|null|undefined)=>value==null?'—':value.toLocaleString();
const security=(s:number)=>Math.max(s>0?.1:-1,Math.round(s*10)/10).toFixed(1);
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'尚未获取';
function windowLabel(value:string|null){if(!value)return '尚未获取';return `${time(new Date(Date.parse(value)-3600000).toISOString())} ～ ${time(value)}`;}

export default function NavigationPage() {
  const [dimension,setDimension]=useState<'2d'|'3d'>('3d');
  const [systems,setSystems]=useState<SystemInfo[]>([]),[data,setData]=useState<StarMapData|null>(null),[desktop,setDesktop]=useState<boolean|null>(null);
  const environment=useMapEnvironment(desktop===true);
  const [points,setPoints]=useState<Point[]>([{key:1,text:'',id:null},{key:2,text:'',id:null}]);
  const {avoid,setAvoid,toggle:toggleBlocked,ready:storageReady,storageError,preferences,setPreferences}=useNavigationAvoid('regular');
  const {gateLines,modes:enabled}=preferences;
  const [bundle,setBundle]=useState<RouteBundle|null>(null),[activities,setActivities]=useState<Activities|null>(null),[error,setError]=useState(''),[activityError,setActivityError]=useState(''),[mapError,setMapError]=useState(''),[loading,setLoading]=useState(false),[loadingActivity,setLoadingActivity]=useState(false);
  const [catalogError,setCatalogError]=useState(''),[catalogBusy,setCatalogBusy]=useState(true),[catalogAttempt,setCatalogAttempt]=useState(0);
  const [mapBusy,setMapBusy]=useState(false),[mapAttempt,setMapAttempt]=useState(0);
  const [analysis,setAnalysis]=useState<Mode>('secure'),[selected,setSelected]=useState<StarSystem|null>(null),[colorMode,setColorMode]=useState(DEFAULT_STAR_COLOR_MODE);
  const [routeViewRequest,setRouteViewRequest]=useState(0);
  const [submitted,setSubmitted]=useState('');
  const [mapTarget,setMapTarget]=useState<number|null>(null);
  const [menu,setMenu]=useState<{system:StarSystem;x:number;y:number}|null>(null);
  const controls=useRef<StarMapControls>(null),keys=useRef(2),sequence=useRef(0),activityAbort=useRef<AbortController|null>(null),routeAbort=useRef<AbortController|null>(null);
  const systemsById=useMemo(()=>new Map(systems.map(s=>[s.id,s])),[systems]);
  const visibleRoutes=useMemo(()=>bundle?.routes.filter(r=>enabled.includes(r.mode)&&!r.error)||[],[bundle,enabled]);
  const activeRoute=visibleRoutes.find(r=>r.mode===analysis)||visibleRoutes[0];
  const signature=JSON.stringify({points:points.map(p=>p.id),avoid});
  const dirty=!!bundle&&signature!==submitted;
  const showDetails=desktop===false;
  const choose=useCallback((s:StarSystem)=>{setMenu(null);setSelected(s);controls.current?.focus(s);},[]);
  const context=useCallback((s:StarSystem,p:{x:number;y:number})=>{setSelected(s);setMenu({system:s,...p});},[]);
  useEffect(()=>{if(mapTarget===null)return;const star=data?.systems.find(s=>s.id===mapTarget);if(star)choose(star);setMapTarget(null);},[mapTarget,data,choose]);

  useEffect(()=>{const media=window.matchMedia('(min-width: 701px)'),update=()=>setDesktop(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  useEffect(()=>{
    const abort=new AbortController();setCatalogBusy(true);setCatalogError('');
    fetch('/api/navigation/catalog',{signal:abort.signal,cache:'no-store'}).then(async r=>{
      const body=await r.json();if(!r.ok)throw new Error(body.error||'星系列表加载失败');
      if(!abort.signal.aborted)setSystems(body.systems);
    }).catch(e=>{if(!abort.signal.aborted)setCatalogError(e.message||'星系列表加载失败');})
      .finally(()=>{if(!abort.signal.aborted)setCatalogBusy(false);});
    return()=>abort.abort();
  },[catalogAttempt]);
  useEffect(()=>{
    if(!desktop||data)return;
    const abort=new AbortController();setMapBusy(true);setMapError('');
    fetch('/api/data/star-map',{signal:abort.signal,cache:'no-store'}).then(async r=>{
      const body=await r.json();if(!r.ok)throw new Error(body.error||'星图加载失败');
      if(!abort.signal.aborted){setMapBusy(false);setData(body);}
    }).catch(e=>{if(!abort.signal.aborted)setMapError(e.message||'星图加载失败');})
      .finally(()=>{if(!abort.signal.aborted)setMapBusy(false);});
    return()=>abort.abort();
  },[desktop,data,mapAttempt]);
  useEffect(()=>()=>{sequence.current++;activityAbort.current?.abort();routeAbort.current?.abort();},[]);
  useEffect(()=>{if(!menu)return;const close=()=>setMenu(null),key=(e:KeyboardEvent)=>{if(e.key==='Escape')close();};window.addEventListener('pointerdown',close);window.addEventListener('keydown',key);window.addEventListener('resize',close);window.addEventListener('blur',close);window.addEventListener('scroll',close,true);return()=>{window.removeEventListener('pointerdown',close);window.removeEventListener('keydown',key);window.removeEventListener('resize',close);window.removeEventListener('blur',close);window.removeEventListener('scroll',close,true);};},[menu]);

  function setPoint(s:StarSystem,role:'origin'|'destination'|'waypoint') {
    const point={key:role==='waypoint'?++keys.current:0,id:s.id,text:s.nameZh};
    setPoints(rows=>assignNavigationPoint(rows,point,role));setMenu(null);setSelected(s);setError('');
  }
  function pointButtons(s:StarSystem){return <><button onClick={()=>setPoint(s,'origin')}>设为起点</button><button onClick={()=>setPoint(s,'destination')}>设为终点</button><button disabled={points.length>=12} title={points.length>=12?'最多 10 个途经点':'追加在终点之前'} onClick={()=>setPoint(s,'waypoint')}>添加途经点</button></>;}

  async function loadActivity(ids:number[],token=sequence.current) {
    activityAbort.current?.abort();const abort=new AbortController();activityAbort.current=abort;setLoadingActivity(true);setActivityError('');
    try{const r=await fetch('/api/navigation/activity',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids}),signal:abort.signal}),body=await r.json();if(!r.ok)throw new Error(body.error||'活动数据加载失败');if(token===sequence.current)setActivities(body);}
    catch(e){if(!abort.signal.aborted&&token===sequence.current)setActivityError(e instanceof Error?e.message:'活动数据加载失败');}
    finally{if(token===sequence.current&&!abort.signal.aborted)setLoadingActivity(false);}
  }
  async function calculate() {
    setMenu(null);setError('');if(!enabled.length){setError('请至少勾选一种路线偏好');return;}if(points.some(p=>p.id===null)){setError('请从下拉列表选择每一个星系点位');return;}
    routeAbort.current?.abort();activityAbort.current?.abort();const token=++sequence.current,abort=new AbortController();routeAbort.current=abort;setLoading(true);setLoadingActivity(false);
    try{const r=await fetch('/api/navigation/route',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({points:points.map(p=>p.id),modes:MODES,avoid:avoid.avoidList?avoid.avoid:[],avoidIncursions:avoid.avoidIncursions}),signal:abort.signal}),body=await r.json();if(!r.ok)throw new Error(body.error||'路线计算失败');if(token!==sequence.current)return;setBundle(body);setSubmitted(signature);setSelected(null);setRouteViewRequest(value=>value+1);setActivities(null);setActivityError('');setAnalysis(enabled[0]);const ids=[...new Set<number>(body.routes.flatMap((r:{ids:number[]})=>r.ids))];if(ids.length)void loadActivity(ids,token);}
    catch(e){if(!abort.signal.aborted&&token===sequence.current)setError(e instanceof Error?e.message:'计算失败');}
    finally{if(token===sequence.current)setLoading(false);}
  }
  function move(key:number,target:number){setPoints(rows=>moveWaypoint(rows,key,target));}
  const blockSelected=()=>{if(selected)toggleBlocked(selected.id);};

  return <main className="navigation-page" style={STAR_SECURITY_CSS_VARS as React.CSSProperties}>
    <header className="nav-header"><div><span className="nav-eyebrow">BRIDGE TOOL 03 / ROUTE PLANNER</span><h1>星际导航 <small>NEW EDEN</small></h1><p>常规星门导航 · 多路线对比 · 星系活动分析</p></div></header>
    <section className="nav-layout" aria-label="常规导航">
      <aside className="nav-panel">
        <PlannerHeading mode="regular"/>
        <WaypointList points={points} systems={systems} onEdit={(key,text,id)=>setPoints(rows=>rows.map(p=>p.key===key?{...p,text,id}:p))} onMove={move} onRemove={key=>setPoints(rows=>rows.filter(p=>p.key!==key))}/>
        <div className="nav-point-tools"><button disabled={points.length>=12} onClick={()=>setPoints(rows=>[...rows.slice(0,-1),{key:++keys.current,text:'',id:null},rows.at(-1)!])}>＋ 添加途经点</button><button onClick={()=>setPoints(rows=>[...rows].reverse())}>⇅ 交换起终点</button></div>
        <fieldset className="nav-preferences"><legend>路线偏好 · 可多选</legend>{MODES.map(mode=><label key={mode} style={{'--route-color':MODE_COLORS[mode]} as React.CSSProperties}><input type="checkbox" checked={enabled.includes(mode)} onChange={e=>setPreferences({modes:e.target.checked?[...enabled,mode]:enabled.filter(m=>m!==mode)})}/><i/>{MODE_NAMES[mode]}</label>)}</fieldset>
        <p className="nav-help">高安优先：尽量少经过低安 / 00。低安优先：尽量少经过高安。相同安等偏好再比较跳数；优先不等于只走该安等。</p>
        <button className="nav-calculate" disabled={loading||catalogBusy||!systems.length||!storageReady} onClick={()=>void calculate()}>{loading?'正在计算…':bundle?'重算':'计算'}</button>
        {(catalogError||catalogBusy&&catalogAttempt>0)&&<div className="nav-error nav-load-error" role={catalogError?'alert':'status'}><p>{catalogError||'正在重新加载星系列表…'}</p><button className="nav-small-button" disabled={catalogBusy} onClick={()=>setCatalogAttempt(n=>n+1)}>{catalogBusy?'正在重试…':'重试星系列表'}</button></div>}
        {dirty&&<p className="nav-dirty" role="status">点位或规避设置已修改，当前仍展示上次路线。请点击重算。</p>}
        {error&&<p className="nav-error" role="alert">{error}</p>}
        <AvoidPanel mode="regular" systems={systems} value={avoid} onChange={setAvoid} onToggle={toggleBlocked} error={storageError}/>
        {desktop&&<><div className="nav-panel-rule"/><label className="nav-setting">显示星门连接<input type="checkbox" checked={gateLines} onChange={e=>setPreferences({gateLines:e.target.checked})}/></label><p className="nav-help">左键拖动平移 · Shift＋左键旋转 · 滚轮缩放<br/>右键星系设置起点、终点或途经点；点击查看详情与屏蔽操作。</p></>}
      </aside>
      <div className="nav-workspace">
        {(desktop===true||!!bundle)&&<div className="nav-analysis-toolbar"><div className="nav-map-toolbar-main">{desktop===true&&<MapDimensionControl value={dimension} onChange={setDimension}/>}</div><div>{bundle&&showDetails&&<button onClick={()=>void loadActivity([...new Set(bundle.routes.flatMap(r=>r.ids))])} disabled={loadingActivity}>{loadingActivity?'加载统计…':'刷新统计'}</button>}</div></div>}
        {desktop===true&&<div className="nav-map-stage">
          <MapSystemSearch systems={systems} disabled={!data} onLocate={system=>setMapTarget(system.id)}/>
          {data?<Suspense fallback={<div className="nav-loading">正在初始化三维星图…</div>}><StarMap ref={controls} dimension={dimension} data={data} blockedIds={avoid.avoid} selected={selected} gateLines={gateLines} colorMode={colorMode} environment={environment} onSelect={choose} onContext={context} routes={visibleRoutes} focusRoutes={visibleRoutes.length>0} routeViewRequest={routeViewRequest} activity={activities?.systems||NO_ACTIVITY}/></Suspense>:<div className="nav-loading nav-load-error" role={mapError?'alert':'status'}><p>{mapError||'正在展开新伊甸星图…'}</p>{(mapError||mapAttempt>0)&&<button className="nav-small-button" disabled={mapBusy} onClick={()=>setMapAttempt(n=>n+1)}>{mapBusy?'正在重试…':'重试星图'}</button>}</div>}
          {selected&&!menu&&<SelectedSystemCard system={selected} blocked={avoid.avoid.includes(selected.id)} environment={environment} onClose={()=>setSelected(null)}>{pointButtons(selected)}<button className="nav-block-action" onClick={blockSelected}>{avoid.avoid.includes(selected.id)?'移出屏蔽列表':'加入屏蔽列表'}</button></SelectedSystemCard>}
        </div>}
        {desktop===true&&<MapColorBar mode={colorMode} onChange={setColorMode} environment={environment}/>}
        {desktop===false&&<p className="nav-mobile-note">手机端不加载星图，路线计算和下方星系分析均可使用。</p>}
        <section className="nav-route-analysis" aria-label="路线分析">
          {!bundle?<div className="nav-empty"><span>⌁</span><h2>从一个目的地开始</h2><p>输入起点和终点，添加途经点，然后点击计算。<br/>勾选多种偏好，可以同时对比不同路线。</p></div>:<>
            <div className="nav-route-tabs">{bundle.routes.filter(r=>enabled.includes(r.mode)).map(r=><button key={r.mode} style={{'--route-color':MODE_COLORS[r.mode]} as React.CSSProperties} className={activeRoute?.mode===r.mode?'active':''} onClick={()=>setAnalysis(r.mode)} disabled={!!r.error}><i/><b>{r.label}</b><span>{r.error?'无可用路线':`${r.jumps} 跳`}</span></button>)}</div>
            {!enabled.length&&<p className="nav-help">请勾选要显示的路线偏好。</p>}
            {bundle.routes.filter(r=>enabled.includes(r.mode)&&r.error).map(r=><p role="alert" className="nav-error" key={r.mode}>{r.label}：{r.error}</p>)}
            {activeRoute&&<><div className="nav-route-overview"><b>{activeRoute.label} · {activeRoute.jumps} 次星门</b><span>高安 {activeRoute.bands?.high} · 低安 {activeRoute.bands?.low} · 00 {activeRoute.bands?.null}（按途经次数）</span></div>
              <div className="nav-route-strip">{activeRoute.ids.map((id,i)=><button key={`${i}-${id}`} onClick={()=>{const s=data?.systems.find(s=>s.id===id);if(s)choose(s);}}><span className={securityBand(systemsById.get(id)?.security??0)} style={securityTextStyle(systemsById.get(id)?.security??0)}>{systemsById.get(id)?.nameZh||id} <small>{security(systemsById.get(id)?.security??0)}</small></span>{i<activeRoute.ids.length-1&&<i>→</i>}</button>)}</div>
              {showDetails?<>
              <p className="nav-route-data-heading">{RECENT_GEOGRAPHY_TITLE}<small>NPC空间站为 SDE 基线，不是一小时活动统计。</small></p><div className="nav-activity-timestamps"><span>过门次数窗口：{windowLabel(activities?.jumps.modified??null)}</span><span>击毁统计窗口：{windowLabel(activities?.kills.modified??null)}</span><small>北京时间 · 各自一小时统计，不是实时人数；— 表示尚未取得数据。</small></div>
              {loadingActivity&&<p role="status" className="nav-help">路线已计算，正在加载星系活动数据…</p>}
              {activityError&&<p role="alert" className="nav-error">{activityError}</p>}
              {activities&&(['jumps','kills'] as const).map(kind=>(activities[kind].error||activities[kind].stale)&&<p className="nav-error" role="status" key={kind}>{kind==='jumps'?'过门':'击毁'}统计{activities[kind].error?`获取失败：${activities[kind].error}。`:'更新时间过旧。'}{activities[kind].modified?'当前显示上次缓存，不代表最新情况。':'当前显示 —，不视为 0。'}</p>)}
              <p className="nav-mobile-table-hint">左右滑动表格可查看空间站、完整击毁数据和屏蔽按钮 →</p><div className="nav-table-scroll"><table className="nav-activity-table"><thead><tr><th>跳数</th><th>星系 / 星域</th><th>安等</th><th>NPC空间站 <small>SDE</small></th><th>过门次数</th><th>舰船击毁数</th><th>太空舱击毁数</th><th>NPC击毁数量</th><th>操作</th></tr></thead><tbody>{activeRoute.ids.map((id,i)=>{const s=systemsById.get(id),a=activities?.systems[id];return <tr key={`${i}-${id}`}><td>{i}</td><td><b>{s?.nameZh||id}</b><small>{s?.nameEn} · {s?.regionName}</small></td><td className={securityBand(s?.security??0)} style={securityTextStyle(s?.security??0)}>{security(s?.security??0)}</td><td data-metric="stations" title="SDE 基线；站点数不属于一小时活动统计。">{npcStationLabel(s)}</td><td>{format(a?.jumps)}</td><td className={a?.ships?'has-kills':''}>{format(a?.ships)}</td><td>{format(a?.pods)}</td><td>{format(a?.npcs)}</td><td><button onClick={()=>toggleBlocked(id)}>{avoid.avoid.includes(id)?'移出屏蔽列表':'加入屏蔽列表'}</button></td></tr>;})}</tbody></table></div>
              </>:null}
            </>}
          </>}
        </section>
      </div>
    </section>
    <p className="nav-dataset-note">地理数据：CCP 标准 SDE，尚未与晨曦全量比对。活动数据：晨曦 ESI。当前仅为星门路线，不包含跳货 / 旗舰跳跃、虫洞或玩家跳桥；路线短、无击毁记录都不代表安全。{bundle?.incursionsModified&&` 入侵名单更新时间：${time(bundle.incursionsModified)}。`}</p>
    {desktop&&menu&&<div className="nav-system-menu" role="dialog" aria-label="常规导航星系操作" style={{left:Math.max(8,Math.min(menu.x,window.innerWidth-248)),top:Math.max(8,Math.min(menu.y,window.innerHeight-290))}} onPointerDown={e=>e.stopPropagation()} onContextMenu={e=>e.preventDefault()}><header><b className={avoid.avoid.includes(menu.system.id)?'is-blocked':''}>{menu.system.nameZh}</b><button aria-label="关闭星系操作" onClick={()=>setMenu(null)}>×</button></header><small>{menu.system.nameEn} · {menu.system.regionName} · <span style={securityTextStyle(menu.system.security)}>{security(menu.system.security)}</span></small><div>{pointButtons(menu.system)}<button className="nav-block-action" onClick={()=>{toggleBlocked(menu.system.id);setMenu(null);}}>{avoid.avoid.includes(menu.system.id)?'移出屏蔽列表':'加入屏蔽列表'}</button></div><p>点位修改后请点击{bundle?'重算':'计算'}。</p></div>}
  </main>;
}
