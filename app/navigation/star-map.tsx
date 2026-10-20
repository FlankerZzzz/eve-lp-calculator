"use client";
import {forwardRef,useEffect,useImperativeHandle,useRef,useState} from 'react';
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {CSS2DRenderer,CSS2DObject} from 'three/addons/renderers/CSS2DRenderer.js';
import {starMapColor,normalizeStarColorMode,STAR_INCURSION_COLORS,STAR_INCURSION_BACKGROUND_OPACITY,starBackgroundOpacity} from '../../lib/star-map-colors.mjs';
import {mapPosition,jumpStopGuide,MAP_POINT_SIZES} from '../../lib/star-map-view.mjs';
import {navigationViewPolicy} from '../../lib/navigation-view.mjs';
import {mapPointerGesture,mapCanvasCursor,containMapGestures} from '../../lib/star-map-input.mjs';
import {MAP_VIEWS} from '../../lib/star-map-orientation.mjs';
import {createMapCompass} from './map-compass';
import {createStarHoverCard} from './star-hover-card';
import {createMapNames} from './map-names';
import {cameraFlightPose,constellationView,jumpReachView,distanceLineView,routeBounds} from '../../lib/star-map-presentation.mjs';
import {useMapEnvironment} from './use-map-environment';
import type {MapEnvironment} from './use-map-environment';
import {MODE_COLORS} from './navigation-types';
import type {Activity,RouteResult} from './navigation-types';

export type StarSystem={id:number;nameZh:string;nameEn:string;regionId:number;regionName:string;constellationId?:number;constellationName?:string;npcStationCount?:number;security:number;x:number;y:number;z:number};
export type StarMapData={source:string;scope:string;serenityVerified:boolean;systems:StarSystem[];gates:[number,number][]};
export type StarMapControls={focus:(s:StarSystem)=>void;reset:()=>void;zoom:(factor:number)=>void;top:()=>void};
export type JumpMapOverlay={origin:number;destination:number;center:number;range:number;candidates:number[];landings:number[];legs:{kind:string;ids:number[];issues:string[]}[];circleIds:number[];waypoints?:number[];completedWaypoints?:number;planId?:number;destinationHint?:{color:string;label:string;state:string}};
export type JumpReachOverlay={origin:number;range:number;candidates:number[];request:number};
export type DistanceMapOverlay={from:number;to:number;distance:number;request:number};
type Engine=StarMapControls&{refreshHover:()=>void;jump:(overlay:JumpMapOverlay|null)=>void;reach:(overlay:JumpReachOverlay|null)=>void;distance:(overlay:DistanceMapOverlay|null)=>void;colors:(mode:string)=>void;gates:(visible:boolean)=>void;mark:(s:StarSystem|null)=>void;routes:(routes:RouteResult[],focus:boolean,request:number)=>void};
const StarMap=forwardRef<StarMapControls,{data:StarMapData;dimension?:'2d'|'3d';selected:StarSystem|null;blockedIds?:number[];gateLines:boolean;colorMode:string;onSelect:(s:StarSystem)=>void;routes:RouteResult[];focusRoutes:boolean;routeViewRequest?:number;activity:Record<number,Activity>;environment?:MapEnvironment|null;jumpOverlay?:JumpMapOverlay|null;reachOverlay?:JumpReachOverlay|null;distanceOverlay?:DistanceMapOverlay|null;hasCalculation?:boolean;onClearCalculation?:()=>void;clearCalculationLabel?:string;onContext?:(s:StarSystem,position:{x:number;y:number})=>void;onHover?:(s:StarSystem|null)=>void;hoverDetails?:(s:StarSystem)=>string[]}>(function StarMap({data,dimension='3d',selected,blockedIds=[],gateLines,colorMode,onSelect,routes,focusRoutes,routeViewRequest=0,environment:providedEnvironment,jumpOverlay=null,reachOverlay=null,distanceOverlay=null,hasCalculation=false,onClearCalculation,clearCalculationLabel='清除计算',onContext,onHover,hoverDetails},ref) {
  const host=useRef<HTMLDivElement>(null),engine=useRef<Engine|null>(null);
  const savedView=useRef<{data:StarMapData;target:THREE.Vector3;distance:number;jumpCenter:number|null;planId:number|undefined;overview:{target:THREE.Vector3;distance:number}|null}|null>(null);
  const loadedEnvironment=useMapEnvironment(providedEnvironment===undefined),environment=providedEnvironment===undefined?loadedEnvironment:providedEnvironment;
  const extraCallbacks=useRef({onContext,onHover,hoverDetails,environment,blockedIds,hasCalculation,onClearCalculation,clearCalculationLabel});
  useEffect(()=>{extraCallbacks.current={onContext,onHover,hoverDetails,environment,blockedIds,hasCalculation,onClearCalculation,clearCalculationLabel};engine.current?.refreshHover();},[onContext,onHover,hoverDetails,environment,blockedIds,hasCalculation,onClearCalculation,clearCalculationLabel]);
  const [error,setError]=useState('');
  useImperativeHandle(ref,()=>({focus:s=>engine.current?.focus(s),reset:()=>engine.current?.reset(),zoom:n=>engine.current?.zoom(n),top:()=>engine.current?.top()}),[]);
  useEffect(()=>{
    const container=host.current;if(!container)return;
    const flat=dimension==='2d',renderPosition=(s:StarSystem)=>mapPosition(s,dimension);
    let renderer:THREE.WebGLRenderer;
    try{renderer=new THREE.WebGLRenderer({antialias:true,alpha:true});}catch{setError('当前浏览器无法启用三维绘图，请开启硬件加速或更换浏览器。');return;}
    renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
    renderer.domElement.setAttribute('aria-label',flat?'可平移和缩放的二维新伊甸星图':'可旋转和缩放的三维新伊甸星图');
    container.appendChild(renderer.domElement);
    const scene=new THREE.Scene(),camera=flat?new THREE.OrthographicCamera(-1,1,1,-1,.01,2000):new THREE.PerspectiveCamera(48,1,.01,2000);
    const tangent=Math.tan(THREE.MathUtils.degToRad(24));let aspect=1;
    const viewDistance=()=>camera instanceof THREE.OrthographicCamera?1/(camera.zoom*tangent):camera.position.distanceTo(controls.target);
    const placeCamera=(target:THREE.Vector3,distance:number,direction?:THREE.Vector3)=>{
      controls.target.copy(target);if(flat)controls.target.y=0;
      camera.up.set(0,flat?0:1,flat?-1:0);
      camera.position.copy(controls.target).add(flat?new THREE.Vector3(0,100,0):(direction??new THREE.Vector3(...MAP_VIEWS.top.offset as [number,number,number])).normalize().multiplyScalar(distance));
      if(camera instanceof THREE.OrthographicCamera){camera.zoom=1/(THREE.MathUtils.clamp(distance,.5,400)*tangent);camera.updateProjectionMatrix();}
    };
    if(flat){camera.up.set(0,0,-1);camera.position.set(0,100,0);}
    const controls=new OrbitControls(camera,renderer.domElement);
    const compass=createMapCompass(()=>engine.current?.reset(),dimension,extraCallbacks.current.onClearCalculation?()=>extraCallbacks.current.onClearCalculation?.():undefined);container.appendChild(compass.element);
    const tooltip=createStarHoverCard(container);
    const mapNames=createMapNames(container,data.systems,dimension),reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
    let flight:{from:{target:number[];distance:number};to:{target:number[];distance:number};direction:THREE.Vector3;start:number;damping:boolean;tool?:'reach'|'distance'}|null=null;
    const stopFlight=()=>{if(flight){controls.enableDamping=flight.damping;flight=null;}container.dataset.cameraMotion='idle';};
    controls.addEventListener('start',stopFlight);
    // No right-drag: it collides with browser/extension mouse gestures and menus.
    controls.mouseButtons={LEFT:THREE.MOUSE.PAN,MIDDLE:THREE.MOUSE.ROTATE,RIGHT:null};
    const releaseGestureGuards=containMapGestures(renderer.domElement);
    controls.enableDamping=true;controls.dampingFactor=0.09;controls.minDistance=0.5;controls.maxDistance=400;controls.zoomSpeed=0.8;
    controls.enableRotate=!flat;controls.minZoom=1/(400*tangent);controls.maxZoom=1/(.5*tangent);
    container.dataset.dimension=dimension;container.dataset.projection=flat?'orthographic':'perspective';
    container.dataset.nodeStyle='square';container.dataset.gateStyle='security-gradient';
    const nodeMaterial=(options:THREE.PointsMaterialParameters)=>new THREE.PointsMaterial({sizeAttenuation:false,transparent:true,depthWrite:false,blending:THREE.NormalBlending,...options});
    const positions=new Float32Array(data.systems.flatMap(s=>renderPosition(s)));
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
    const material=nodeMaterial({size:container.clientWidth<500?MAP_POINT_SIZES.compact:MAP_POINT_SIZES.base,vertexColors:true});
    const stars=new THREE.Points(geometry,material);scene.add(stars);
    const invadedGeometry=new THREE.BufferGeometry(),invadedMaterial=nodeMaterial({size:MAP_POINT_SIZES.incursion,color:STAR_INCURSION_COLORS.invaded,depthTest:false});
    const invadedStars=new THREE.Points(invadedGeometry,invadedMaterial);invadedStars.renderOrder=11;invadedStars.visible=false;scene.add(invadedStars);
    const labelRenderer=new CSS2DRenderer();labelRenderer.domElement.className='nav-map-labels';container.appendChild(labelRenderer.domElement);
    const labels=new THREE.Group();scene.add(labels);
    const routeGroup=new THREE.Group();scene.add(routeGroup);
    const jumpGroup=new THREE.Group(),jumpLabels=new THREE.Group();scene.add(jumpGroup,jumpLabels);
    const jumpResources:{dispose:()=>void}[]=[];
    const clearJump=()=>{jumpResources.forEach(r=>r.dispose());jumpResources.length=0;jumpGroup.clear();for(const label of [...jumpLabels.children]){(label as CSS2DObject).element.remove();jumpLabels.remove(label);}};
    const reachGroup=new THREE.Group();scene.add(reachGroup);
    const reachResources:{dispose:()=>void}[]=[];
    const clearReach=()=>{reachResources.forEach(resource=>resource.dispose());reachResources.length=0;reachGroup.clear();};
    let previousReachKey='',reachOrigin:number|null=null;
    const distanceGroup=new THREE.Group(),distanceLabels=new THREE.Group();scene.add(distanceGroup,distanceLabels);
    const distanceResources:{dispose:()=>void}[]=[];
    let previousDistanceKey='',distanceIds:number[]=[],distanceLineMaterial:LineMaterial|null=null;
    const clearDistance=()=>{
      distanceResources.forEach(resource=>resource.dispose());distanceResources.length=0;distanceGroup.clear();distanceLineMaterial=null;
      for(const label of [...distanceLabels.children]){(label as CSS2DObject).element.remove();distanceLabels.remove(label);}
    };
    const restored=savedView.current?.data===data?savedView.current:null;
    let previousJumpCenter:number|null=restored?.jumpCenter??null,previousPlanId=restored?.planId,restoringView=!!restored;
    let focused=false,showGates=true,routeIds=new Set<number>(),routeKey='',fitCenter:THREE.Vector3|null=null,fitRadius=0,plannedNames=new Set<number>();
    let overview:{position:THREE.Vector3;target:THREE.Vector3;up:THREE.Vector3;zoom:number}|null=null;
    const disposableRoutes:{geometry:THREE.BufferGeometry;material:THREE.Material}[]=[];
    const lineMaterials:LineMaterial[]=[];
    const clearRoutes=()=>{for(const resource of disposableRoutes){resource.geometry.dispose();resource.material.dispose();}disposableRoutes.length=0;lineMaterials.length=0;routeGroup.clear();for(const label of [...labels.children]){(label as CSS2DObject).element.remove();labels.remove(label);}};
    const lookup=new Map(data.systems.map((s,i)=>[s.id,i]));
    const lines=new Float32Array(data.gates.flatMap(([a,b])=>[...positions.slice(lookup.get(a)!*3,lookup.get(a)!*3+3),...positions.slice(lookup.get(b)!*3,lookup.get(b)!*3+3)]));
    const lineGeometry=new THREE.BufferGeometry();lineGeometry.setAttribute('position',new THREE.BufferAttribute(lines,3));
    const lineMaterial=new THREE.LineBasicMaterial({color:0xffffff,vertexColors:true,transparent:true,opacity:.28,depthWrite:false});
    const gates=new THREE.LineSegments(lineGeometry,lineMaterial);scene.add(gates);
    const markerGeometry=new THREE.BufferGeometry();markerGeometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));
    const markerMaterial=nodeMaterial({size:MAP_POINT_SIZES.selected,color:0xe7f5ff,depthTest:false});
    const marker=new THREE.Points(markerGeometry,markerMaterial);marker.visible=false;scene.add(marker);
    geometry.computeBoundingSphere();const bounds=geometry.boundingSphere!,center=bounds.center.clone(),radius=bounds.radius;
    let dirty=true,hasJumpOverlay=false,hasReachOverlay=false,hasDistanceOverlay=false;
    const updateStarAppearance=()=>{
      material.opacity=starBackgroundOpacity(container.dataset.colorMode,hasJumpOverlay);
      if(focused||hasReachOverlay||hasDistanceOverlay)material.opacity=.12;
      material.size=container.dataset.colorMode==='incursion'?2.5:container.clientWidth<500?MAP_POINT_SIZES.compact:MAP_POINT_SIZES.base;
      container.dataset.starOpacity=String(material.opacity);
      container.dataset.starSize=String(material.size);
    };
    const changed=()=>{dirty=true;container.dataset.cameraDistance=String(viewDistance());container.dataset.cameraZoom=String(camera.zoom);container.dataset.cameraTarget=controls.target.toArray().map(n=>n.toFixed(4)).join(',');container.dataset.cameraPosition=camera.position.toArray().map(n=>n.toFixed(4)).join(',');};controls.addEventListener('change',changed);
    const reset=()=>{stopFlight();const damping=controls.enableDamping;controls.enableDamping=false;controls.update();const routeView=focused&&fitCenter,viewCenter=routeView?fitCenter!:center,viewRadius=routeView?fitRadius:radius;placeCamera(viewCenter,Math.max(3,viewRadius*2.7/Math.min(1,aspect)));controls.update();controls.enableDamping=damping;dirty=true;};
    const flyTo=(to:{target:number[];distance:number},tool?:'reach'|'distance')=>{
      stopFlight();const from={target:controls.target.toArray(),distance:viewDistance()},direction=camera.position.clone().sub(controls.target).normalize(),damping=controls.enableDamping;
      controls.enableDamping=false;controls.update();placeCamera(new THREE.Vector3().fromArray(from.target),from.distance,direction);controls.update();
      if(reducedMotion.matches){placeCamera(new THREE.Vector3().fromArray(to.target),to.distance,direction);controls.update();controls.enableDamping=damping;dirty=true;return;}
      flight={from,to,direction,start:performance.now(),damping,tool};container.dataset.cameraMotion='flying';dirty=true;
    };
    const focusSystem=(s:StarSystem)=>flyTo(constellationView(s,data.systems,dimension,aspect));
    const colors=(mode:string)=>{const c=new THREE.Color(),values=new Float32Array(data.systems.length*3);data.systems.forEach((s,i)=>{c.set(starMapColor(s,mode,extraCallbacks.current.environment));values.set([c.r,c.g,c.b],i*3);});geometry.setAttribute('color',new THREE.BufferAttribute(values,3));const gateColors=new Float32Array(data.gates.flatMap(([a,b])=>[...values.subarray(lookup.get(a)!*3,lookup.get(a)!*3+3),...values.subarray(lookup.get(b)!*3,lookup.get(b)!*3+3)]));lineGeometry.setAttribute('color',new THREE.BufferAttribute(gateColors,3));container.dataset.colorMode=normalizeStarColorMode(mode);updateStarAppearance();lineMaterial.opacity=mode==='incursion'?.08:.28;if(focused||hasReachOverlay||hasDistanceOverlay)lineMaterial.opacity=.06;const raw=extraCallbacks.current.environment?.incursions?.ids,invaded=new Set(Array.isArray(raw)?raw:[]);const visible=mode==='incursion'?data.systems.filter(s=>invaded.has(s.id)&&(!focused||routeIds.has(s.id))):[];invadedGeometry.setAttribute('position',new THREE.Float32BufferAttribute(visible.flatMap(renderPosition),3));invadedGeometry.computeBoundingSphere();invadedStars.visible=visible.length>0;container.dataset.incursionHighlights=String(visible.length);dirty=true;};
    engine.current={refreshHover:()=>{},jump:()=>{},reach:()=>{},distance:()=>{},reset,colors,gates:visible=>{showGates=visible;gates.visible=visible;dirty=true;},mark:s=>{mapNames.select(s?.id??null);marker.visible=!!s;if(s)marker.position.fromArray(renderPosition(s));dirty=true;},focus:focusSystem,zoom:factor=>{stopFlight();placeCamera(controls.target.clone(),THREE.MathUtils.clamp(viewDistance()*factor,.5,400),camera.position.clone().sub(controls.target).normalize());controls.update();dirty=true;},top:reset,routes:(routes,focus,request)=>{
      const nextKey=JSON.stringify(routes.map(r=>[r.mode,r.ids]))+focus+':'+request,refit=routeKey!==nextKey,wasFocused=focused;
      if(refit)stopFlight();
      if(focus&&!wasFocused){
        if(restoringView&&restored?.overview){const target=restored.overview.target.clone();if(flat)target.y=0;overview={target,position:target.clone().add(flat?new THREE.Vector3(0,100,0):new THREE.Vector3(...MAP_VIEWS.top.offset as [number,number,number]).normalize().multiplyScalar(restored.overview.distance)),up:new THREE.Vector3(0,flat?0:1,flat?-1:0),zoom:flat?1/(restored.overview.distance*tangent):1};}
        else overview={position:camera.position.clone(),target:controls.target.clone(),up:camera.up.clone(),zoom:camera.zoom};
      }
      routeKey=nextKey;focused=focus;routeIds=new Set(routes.flatMap(r=>r.ids));
      const policy=navigationViewPolicy(focus,routeIds.size>0);
      stars.visible=policy.showBackground;gates.visible=showGates&&policy.showBackground;scene.background=null;clearRoutes();
      container.dataset.view=policy.view;container.dataset.backgroundVisible=String(stars.visible);
      container.dataset.routeModes=routes.map(r=>r.mode).join(',');container.dataset.focused=String(focus);container.dataset.visibleSystems=String(data.systems.length);container.dataset.routeSystems=JSON.stringify([...routeIds]);container.dataset.routeViewRequest=String(request);updateStarAppearance();
      const byId=new Map(data.systems.map(s=>[s.id,s]));
      for(const route of [...routes].sort((a,b)=>['secure','shortest','insecure'].indexOf(a.mode)-['secure','shortest','insecure'].indexOf(b.mode))) {
        const coords=route.ids.flatMap(id=>renderPosition(byId.get(id)!));
        if(coords.length>=6){const geo=new LineGeometry();geo.setPositions(coords);const index=['secure','shortest','insecure'].indexOf(route.mode),mat=new LineMaterial({color:MODE_COLORS[route.mode],linewidth:7-index*2,transparent:true,opacity:.95,depthTest:false,depthWrite:false});mat.resolution.set(container.clientWidth,container.clientHeight);const line=new Line2(geo,mat);line.computeLineDistances();line.renderOrder=2+index;routeGroup.add(line);disposableRoutes.push({geometry:geo,material:mat});lineMaterials.push(mat);}
      }
      const pointGeometry=new THREE.BufferGeometry();pointGeometry.setAttribute('position',new THREE.Float32BufferAttribute([...routeIds].flatMap(id=>renderPosition(byId.get(id)!)),3));
      const pointMaterial=nodeMaterial({size:MAP_POINT_SIZES.route,color:'#eefaff',depthTest:false});const points=new THREE.Points(pointGeometry,pointMaterial);points.renderOrder=6;routeGroup.add(points);disposableRoutes.push({geometry:pointGeometry,material:pointMaterial});
      if(focus) {
        for(const id of routeIds){const s=byId.get(id)!,element=document.createElement('span');element.className='nav-star-label';element.dataset.mapSystem=String(id);element.textContent=`${s.nameZh} · `;const security=document.createElement('span');security.textContent=Math.max(s.security>0?.1:-1,Math.round(s.security*10)/10).toFixed(1);security.style.color=starMapColor(s);element.appendChild(security);const label=new CSS2DObject(element);label.position.fromArray(renderPosition(s));label.center.set(-.12,.5);labels.add(label);}
      }
      const bounds=routeBounds(byId,routes,dimension);if(bounds){fitCenter=new THREE.Vector3().fromArray(bounds.target);fitRadius=bounds.radius;}else fitCenter=null;
      if(wasFocused&&!focus){if(!routes.length)overview=null;else if(overview){camera.position.copy(overview.position);controls.target.copy(overview.target);camera.up.copy(overview.up);camera.zoom=overview.zoom;camera.updateProjectionMatrix();controls.update();overview=null;}else reset();}
      else if(refit&&policy.fitRoutes&&!restoringView)reset();
      restoringView=false;
      dirty=true;
    }};
    engine.current.jump=overlay=>{
      clearJump();hasJumpOverlay=!!overlay;updateStarAppearance();
      plannedNames=new Set(overlay?[overlay.origin,overlay.destination,overlay.center,...(overlay.waypoints??[]),...overlay.legs.map(l=>l.ids.at(-1)!)]:[]);
      container.dataset.jumpCenter=String(overlay?.center??'');container.dataset.jumpRange=String(overlay?.range??'');
      container.dataset.jumpCandidates=String(overlay?.candidates.length??0);container.dataset.jumpLegs=String(overlay?.legs.length??0);
      container.dataset.jumpCircles='0';
      if(!overlay){previousJumpCenter=null;previousPlanId=undefined;container.dataset.jumpGuidePoints='[]';container.dataset.jumpWaypoints='0';dirty=true;return;}
      const byId=new Map(data.systems.map(s=>[s.id,s]));
      const resources=(...items:{dispose:()=>void}[])=>jumpResources.push(...items);
      const dots=(ids:number[],color:string,size:number,followPalette=false)=>{
        const visible=ids.filter(id=>byId.has(id)),palette=followPalette&&container.dataset.colorMode!=='security';
        const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(visible.flatMap(id=>renderPosition(byId.get(id)!)),3));
        if(palette){const c=new THREE.Color();geo.setAttribute('color',new THREE.Float32BufferAttribute(visible.flatMap(id=>{c.set(starMapColor(byId.get(id)!,container.dataset.colorMode,extraCallbacks.current.environment));return [c.r,c.g,c.b];}),3));}
        const mat=nodeMaterial({size,color:palette?'#ffffff':color,vertexColors:palette,opacity:followPalette&&container.dataset.colorMode==='incursion'?STAR_INCURSION_BACKGROUND_OPACITY:1,depthTest:false});const obj=new THREE.Points(geo,mat);obj.renderOrder=10;jumpGroup.add(obj);resources(geo,mat);
      };
      dots(overlay.candidates,'#76efd1',MAP_POINT_SIZES.candidate,true);dots(overlay.landings,'#f4ba72',MAP_POINT_SIZES.landing,true);
      dots(overlay.candidates.filter(id=>overlay.landings.includes(id)),'#ffe8a0',MAP_POINT_SIZES.overlap,true);
      dots([overlay.origin],'#78efc7',MAP_POINT_SIZES.origin);dots([overlay.destination],overlay.destinationHint?.color??'#8db9ff',MAP_POINT_SIZES.destination);
      const stopGuide=jumpStopGuide(overlay.origin,overlay.waypoints??[],overlay.destination,overlay.completedWaypoints??0);
      container.dataset.jumpGuidePoints=JSON.stringify(stopGuide.ids);container.dataset.jumpWaypoints=String(overlay.waypoints?.length??0);
      dots((overlay.waypoints??[]),'#ffcd82',MAP_POINT_SIZES.waypoint);
      if(overlay.waypoints?.length){
        const geo=new THREE.BufferGeometry().setFromPoints(stopGuide.ids.map(id=>new THREE.Vector3().fromArray(renderPosition(byId.get(id)!))));
        const mat=new THREE.LineDashedMaterial({color:'#ffce8a',dashSize:.3,gapSize:.18,transparent:true,opacity:.95,depthTest:false});const guide=new THREE.Line(geo,mat);guide.computeLineDistances();guide.renderOrder=11;jumpGroup.add(guide);resources(geo,mat);
      }
      if(!overlay.waypoints?.length&&overlay.destinationHint&&overlay.center!==overlay.destination){
        const a=byId.get(overlay.center),b=byId.get(overlay.destination);
        if(a&&b){const geo=new THREE.BufferGeometry().setFromPoints([a,b].map(s=>new THREE.Vector3().fromArray(renderPosition(s))));const mat=new THREE.LineDashedMaterial({color:overlay.destinationHint.color,dashSize:.22,gapSize:.14,transparent:true,opacity:.85,depthTest:false});const guide=new THREE.Line(geo,mat);guide.computeLineDistances();guide.renderOrder=11;jumpGroup.add(guide);resources(geo,mat);}
      }
      for(const id of [...new Set(overlay.circleIds)]){
        const s=byId.get(id);if(!s)continue;const active=id===overlay.center;
        container.dataset.jumpCircles=String(Number(container.dataset.jumpCircles)+1);
        const source=flat?new THREE.CircleGeometry(overlay.range,96):new THREE.SphereGeometry(overlay.range,32,16),geo=flat?new THREE.EdgesGeometry(source):new THREE.WireframeGeometry(source);source.dispose();if(flat)geo.rotateX(-Math.PI/2);
        const mat=new THREE.LineBasicMaterial({color:active?'#7ae3cc':'#5f98ab',transparent:true,opacity:flat?(active?.65:.25):(active?.16:.055),depthWrite:false});
        const sphere=new THREE.LineSegments(geo,mat);sphere.position.fromArray(renderPosition(s));jumpGroup.add(sphere);resources(geo,mat);
        for(const rotation of flat?[]:[[0,0,0],[Math.PI/2,0,0],[0,Math.PI/2,0]]){
          const curve=new THREE.EllipseCurve(0,0,overlay.range,overlay.range,0,Math.PI*2,false,0);
          const ringGeo=new THREE.BufferGeometry().setFromPoints(curve.getPoints(96)),ringMat=new THREE.LineBasicMaterial({color:active?'#80f5d1':'#669baa',transparent:true,opacity:active?.48:.1,depthWrite:false});
          const ring=new THREE.LineLoop(ringGeo,ringMat);ring.position.copy(sphere.position);ring.rotation.set(...rotation as [number,number,number]);jumpGroup.add(ring);resources(ringGeo,ringMat);
        }
      }
      for(const leg of overlay.legs){
        const geo=new THREE.BufferGeometry().setFromPoints(leg.ids.filter(id=>byId.has(id)).map(id=>new THREE.Vector3().fromArray(renderPosition(byId.get(id)!))));
        const mat=new THREE.LineBasicMaterial({color:leg.issues.length?'#ff847c':leg.kind==='jump'?'#8df5cf':'#87b7ff',transparent:true,opacity:1,depthTest:false});
        const line=new THREE.Line(geo,mat);line.renderOrder=12;jumpGroup.add(line);resources(geo,mat);
      }
      const labels=new Set([...stopGuide.ids,overlay.center,...overlay.legs.map(l=>l.ids.at(-1)!)]);
      for(const id of labels){const s=byId.get(id);if(!s)continue;const stop=stopGuide.points.find(p=>p.id===id);const el=document.createElement('span');el.dataset.mapSystem=String(id);el.className=`nav-star-label jump-map-label${stop?.waypoint?' jump-waypoint-label':''}`;el.textContent=`${stop?stop.label+' · ':''}${s.nameZh}`;if(stop?.waypoint){el.dataset.waypointIndices=stop.indices.join(',');el.dataset.visited=String(stop.visited);}if(id===overlay.destination&&overlay.destinationHint){el.textContent+=` · ${overlay.destinationHint.label}`;if(!stop?.waypoint){el.style.color=overlay.destinationHint.color;el.style.borderColor=overlay.destinationHint.color;}el.dataset.destinationState=overlay.destinationHint.state;}const label=new CSS2DObject(el);label.position.fromArray(renderPosition(s));label.center.set(id===overlay.destination?.5:-.2,id===overlay.destination?-.25:.5);jumpLabels.add(label);}
      if(!hasReachOverlay&&!hasDistanceOverlay&&(previousJumpCenter!==overlay.center||previousPlanId!==overlay.planId)){
        stopFlight();
        const s=byId.get(overlay.center);
        if(s){const direction=camera.position.clone().sub(controls.target).normalize();
          if(previousPlanId!==overlay.planId&&overlay.waypoints?.length){const box=new THREE.Box3().setFromPoints(stopGuide.ids.map(id=>new THREE.Vector3().fromArray(renderPosition(byId.get(id)!))));placeCamera(box.getCenter(new THREE.Vector3()),Math.max(10,box.getSize(new THREE.Vector3()).length()*1.5)/Math.min(1,aspect),direction);}
          else placeCamera(new THREE.Vector3().fromArray(renderPosition(s)),Math.max(10,overlay.range*3.5)/Math.min(1,aspect),direction);
          controls.update();}previousJumpCenter=overlay.center;previousPlanId=overlay.planId;}
      dirty=true;
    };
    // Separate utility overlay: never fabricate route endpoints or route legs.
    engine.current.reach=overlay=>{
      clearReach();const wasActive=hasReachOverlay;
      const origin=overlay?data.systems[lookup.get(overlay.origin)!]:null;
      hasReachOverlay=!!origin&&!!overlay&&Number.isFinite(overlay.range)&&overlay.range>0;
      reachOrigin=hasReachOverlay?origin!.id:null;
      updateStarAppearance();jumpGroup.visible=jumpLabels.visible=!hasReachOverlay&&!hasDistanceOverlay;
      lineMaterial.opacity=focused||hasReachOverlay||hasDistanceOverlay?.06:container.dataset.colorMode==='incursion'?.08:.28;
      container.dataset.reachOrigin=String(reachOrigin??'');
      container.dataset.reachCandidates='[]';
      if(!hasReachOverlay||!overlay||!origin){if(wasActive&&flight?.tool==='reach')stopFlight();previousReachKey='';dirty=true;return;}
      const ids=[...new Set(overlay.candidates)].filter(id=>id!==origin.id&&lookup.has(id));
      container.dataset.reachCandidates=JSON.stringify(ids);
      const dots=(systems:StarSystem[],color:string,size:number)=>{
        const geo=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(systems.flatMap(renderPosition),3));
        const mat=nodeMaterial({color,size,depthTest:false});
        const points=new THREE.Points(geo,mat);points.renderOrder=20;reachGroup.add(points);reachResources.push(geo,mat);
      };
      dots(ids.map(id=>data.systems[lookup.get(id)!]),'#2FEFEF',MAP_POINT_SIZES.waypoint);
      dots([origin],'#ffffff',MAP_POINT_SIZES.selected);
      const source=flat?new THREE.CircleGeometry(overlay.range,96):new THREE.SphereGeometry(overlay.range,32,16);
      const geometry=flat?new THREE.EdgesGeometry(source):new THREE.WireframeGeometry(source);source.dispose();
      if(flat)geometry.rotateX(-Math.PI/2);
      const mat=new THREE.LineBasicMaterial({color:'#2FEFEF',transparent:true,opacity:flat?.5:.12,depthWrite:false});
      const range=new THREE.LineSegments(geometry,mat);range.position.fromArray(renderPosition(origin));reachGroup.add(range);reachResources.push(geometry,mat);
      const key=JSON.stringify([overlay.origin,overlay.range,overlay.request]);
      if(key!==previousReachKey)flyTo(jumpReachView(origin,overlay.range,dimension,aspect),'reach');
      previousReachKey=key;dirty=true;
    };
    engine.current.distance=overlay=>{
      clearDistance();const wasActive=hasDistanceOverlay;
      const a=overlay?data.systems[lookup.get(overlay.from)!]:null,b=overlay?data.systems[lookup.get(overlay.to)!]:null;
      hasDistanceOverlay=!!overlay&&!!a&&!!b;
      distanceIds=hasDistanceOverlay?[a!.id,b!.id]:[];
      container.dataset.distanceEndpoints=JSON.stringify(distanceIds);
      container.dataset.distanceLy=String(hasDistanceOverlay?overlay!.distance:'');
      updateStarAppearance();jumpGroup.visible=jumpLabels.visible=!hasReachOverlay&&!hasDistanceOverlay;
      lineMaterial.opacity=focused||hasReachOverlay||hasDistanceOverlay?.06:container.dataset.colorMode==='incursion'?.08:.28;
      if(!hasDistanceOverlay||!overlay||!a||!b){if(wasActive&&flight?.tool==='distance')stopFlight();previousDistanceKey='';dirty=true;return;}
      const coords=[a,b].flatMap(renderPosition),geo=new LineGeometry();geo.setPositions(coords);
      const mat=new LineMaterial({color:'#2FEFEF',linewidth:2.5,transparent:true,opacity:1,depthTest:false,depthWrite:false});
      mat.resolution.set(container.clientWidth,container.clientHeight);distanceLineMaterial=mat;
      const line=new Line2(geo,mat);line.computeLineDistances();line.renderOrder=21;distanceGroup.add(line);distanceResources.push(geo,mat);
      for(const [system,role,color]of [[a,a.id===b.id?'A / B':'A','#ffffff'],...(a.id===b.id?[]:[[b,'B','#ffce8a']])] as [StarSystem,string,string][]){
        const geometry=new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute(renderPosition(system),3));
        const material=nodeMaterial({color,size:MAP_POINT_SIZES.selected,depthTest:false});
        const point=new THREE.Points(geometry,material);point.renderOrder=22;distanceGroup.add(point);distanceResources.push(geometry,material);
        const element=document.createElement('span');element.className='nav-star-label jump-tool-label';element.textContent=`${role}：${system.nameZh}`;
        const label=new CSS2DObject(element);label.position.fromArray(renderPosition(system));label.center.set(-.15,1.25);distanceLabels.add(label);
      }
      const key=JSON.stringify([overlay.from,overlay.to,overlay.request]);
      if(previousDistanceKey!==key)flyTo(distanceLineView(a,b,dimension,aspect),'distance');
      previousDistanceKey=key;dirty=true;
    };
    colors('security');
    const resize=()=>{const {width,height}=container.getBoundingClientRect();if(!width||!height)return;renderer.setSize(width,height);labelRenderer.setSize(width,height);for(const mat of lineMaterials)mat.resolution.set(width,height);distanceLineMaterial?.resolution.set(width,height);aspect=width/height;if(camera instanceof THREE.OrthographicCamera){camera.left=-aspect;camera.right=aspect;}else camera.aspect=aspect;camera.updateProjectionMatrix();dirty=true;};
    const observer=new ResizeObserver(resize);observer.observe(container);resize();if(restored){placeCamera(restored.target.clone(),restored.distance);controls.update();changed();}else reset();
    const pointerGesture=mapPointerGesture(),cursor=mapCanvasCursor(renderer.domElement);
    const pick=(x:number,y:number):StarSystem|null=>{const rect=renderer.domElement.getBoundingClientRect(),v=new THREE.Vector3();let closest:StarSystem|null=null,best=12;
      data.systems.forEach((s,i)=>{v.fromArray(positions,i*3).project(camera);if(v.z < -1||v.z>1)return;const px=(v.x+1)*rect.width/2+rect.left,py=(1-v.y)*rect.height/2+rect.top,d=Math.hypot(px-x,py-y);if(d<best){best=d;closest=s;}});return closest;};
    let lastHover=0,hoverId:number|null=null,hoverPointer:{x:number;y:number}|null=null,hoverTimer:number|undefined,hoverTick:number|undefined;
    const hideHover=()=>{window.clearTimeout(hoverTimer);window.clearTimeout(hoverTick);hoverTimer=undefined;hoverTick=undefined;hoverPointer=null;if(hoverId!==null)extraCallbacks.current.onHover?.(null);hoverId=null;tooltip.hide();};
    const updateHover=()=>{
      hoverTick=undefined;if(!hoverPointer)return;lastHover=performance.now();const s=pick(hoverPointer.x,hoverPointer.y);
      if((s?.id??null)!==hoverId){
        window.clearTimeout(hoverTimer);tooltip.hide();hoverId=s?.id??null;extraCallbacks.current.onHover?.(s);
        if(s){tooltip.render(s,extraCallbacks.current.hoverDetails?.(s)??[],!!extraCallbacks.current.onContext,extraCallbacks.current.environment,extraCallbacks.current.blockedIds.includes(s.id));hoverTimer=window.setTimeout(()=>{if(!hoverPointer||hoverId!==s.id)return;tooltip.element.hidden=false;tooltip.move(hoverPointer.x,hoverPointer.y);},100);}
      }else if(s&&!tooltip.element.hidden)tooltip.move(hoverPointer.x,hoverPointer.y);
    };
    engine.current.refreshHover=()=>{dirty=true;if(hoverId===null)return;const s=data.systems.find(s=>s.id===hoverId);if(s){tooltip.render(s,extraCallbacks.current.hoverDetails?.(s)??[],!!extraCallbacks.current.onContext,extraCallbacks.current.environment,extraCallbacks.current.blockedIds.includes(s.id));if(hoverPointer&&!tooltip.element.hidden)tooltip.move(hoverPointer.x,hoverPointer.y);}};
    const cameraHover=()=>{const pointer=hoverPointer;hideHover();if(pointer){hoverPointer=pointer;hoverTick=window.setTimeout(updateHover,140);}};
    const pointerDown=(e:PointerEvent)=>{hideHover();cursor.buttons(e);pointerGesture.start(e);};
    const pointerUp=(e:PointerEvent)=>{cursor.buttons(e);const click=pointerGesture.finish(e);if(!click)return;const closest=pick(click.x,click.y);if(closest){if(click.button===2)extraCallbacks.current.onContext?.(closest,{x:click.x,y:click.y});else onSelect(closest);}};
    const pointerCancel=()=>{cursor.reset();pointerGesture.cancel();hideHover();};
    const pointerMove=(e:PointerEvent)=>{cursor.buttons(e);pointerGesture.move(e);if(e.buttons||e.pointerType==='touch'){hideHover();return;}hoverPointer={x:e.clientX,y:e.clientY};if(hoverTick===undefined)hoverTick=window.setTimeout(updateHover,Math.max(0,40-(performance.now()-lastHover)));};
    const pointerLeave=()=>{cursor.reset();pointerGesture.cancel();hideHover();};
    const releaseCursor=()=>cursor.release();
    const hoverKey=(e:KeyboardEvent)=>{if(e.key==='Escape')hideHover();};
    controls.addEventListener('start',hideHover);controls.addEventListener('change',cameraHover);window.addEventListener('scroll',hideHover,{capture:true,passive:true});window.addEventListener('resize',hideHover);window.addEventListener('keydown',hoverKey);
    const contextMenu=(e:MouseEvent)=>{if(extraCallbacks.current.onContext)e.preventDefault();};
    const lost=(e:Event)=>{e.preventDefault();setError('三维绘图连接已中断，请刷新页面重新加载。');};
    renderer.domElement.addEventListener('pointerdown',pointerDown);renderer.domElement.addEventListener('pointerup',pointerUp);renderer.domElement.addEventListener('webglcontextlost',lost);
    renderer.domElement.addEventListener('pointermove',pointerMove);renderer.domElement.addEventListener('pointerleave',pointerLeave);renderer.domElement.addEventListener('contextmenu',contextMenu);
    renderer.domElement.addEventListener('pointercancel',pointerCancel);window.addEventListener('blur',pointerCancel);window.addEventListener('pointerup',releaseCursor);
    renderer.setAnimationLoop(now=>{if(document.hidden)return;if(flight){const progress=(now-flight.start)/1100,pose=cameraFlightPose(flight.from,flight.to,progress);placeCamera(new THREE.Vector3().fromArray(pose.target),pose.distance,flight.direction);controls.update();dirty=true;if(progress>=1)stopFlight();}else controls.update();if(dirty){renderer.render(scene,camera);labelRenderer.render(scene,camera);compass.setCalculation(extraCallbacks.current.hasCalculation,extraCallbacks.current.clearCalculationLabel);compass.update(camera,camera.position.clone().sub(controls.target).toArray());mapNames.update(camera,viewDistance(),focused,new Set([...plannedNames,...distanceIds,...(reachOrigin===null?[]:[reachOrigin])]),extraCallbacks.current.blockedIds);for(const node of labelRenderer.domElement.querySelectorAll<HTMLElement>('[data-map-system]'))node.classList.toggle('is-blocked',extraCallbacks.current.blockedIds.includes(Number(node.dataset.mapSystem)));dirty=false;}mapNames.tick(now,reducedMotion.matches);});
    return()=>{invadedGeometry.dispose();invadedMaterial.dispose();window.removeEventListener('pointerup',releaseCursor);cursor.reset();savedView.current={data,target:controls.target.clone(),distance:viewDistance(),jumpCenter:previousJumpCenter,planId:previousPlanId,overview:overview?{target:overview.target.clone(),distance:flat?1/(overview.zoom*tangent):overview.position.distanceTo(overview.target)}:null};stopFlight();mapNames.dispose();controls.removeEventListener('start',stopFlight);hideHover();tooltip.dispose();controls.removeEventListener('start',hideHover);controls.removeEventListener('change',cameraHover);window.removeEventListener('scroll',hideHover,true);window.removeEventListener('resize',hideHover);window.removeEventListener('keydown',hoverKey);compass.dispose();engine.current=null;observer.disconnect();renderer.setAnimationLoop(null);controls.removeEventListener('change',changed);controls.dispose();renderer.domElement.removeEventListener('pointerdown',pointerDown);renderer.domElement.removeEventListener('pointerup',pointerUp);renderer.domElement.removeEventListener('webglcontextlost',lost);renderer.domElement.removeEventListener('pointermove',pointerMove);renderer.domElement.removeEventListener('pointerleave',pointerLeave);renderer.domElement.removeEventListener('contextmenu',contextMenu);releaseGestureGuards();renderer.domElement.removeEventListener('pointercancel',pointerCancel);window.removeEventListener('blur',pointerCancel);clearDistance();clearReach();clearJump();clearRoutes();labelRenderer.domElement.remove();geometry.dispose();lineGeometry.dispose();markerGeometry.dispose();markerMaterial.dispose();material.dispose();lineMaterial.dispose();renderer.dispose();renderer.domElement.remove();};
  },[data,onSelect,dimension]);
  useEffect(()=>engine.current?.gates(gateLines),[data,dimension,gateLines]);
  useEffect(()=>engine.current?.mark(selected),[data,dimension,selected]);
  useEffect(()=>engine.current?.routes(routes,focusRoutes,routeViewRequest),[data,dimension,routes,focusRoutes,routeViewRequest]);
  useEffect(()=>engine.current?.colors(colorMode),[data,dimension,colorMode,environment,focusRoutes,routes]);
  useEffect(()=>engine.current?.jump(jumpOverlay),[data,dimension,jumpOverlay,colorMode,environment]);
  useEffect(()=>engine.current?.reach(reachOverlay),[data,dimension,reachOverlay,colorMode,environment]);
  useEffect(()=>engine.current?.distance(distanceOverlay),[data,dimension,distanceOverlay,colorMode,environment]);
  return <div className="nav-canvas" ref={host}>{error&&<div className="nav-render-error" role="alert">{error}<button onClick={()=>window.location.reload()}>重新加载</button></div>}</div>;
});
export default StarMap;
