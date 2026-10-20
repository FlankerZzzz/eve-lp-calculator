import {feedIsCurrent} from './star-hover-environment.mjs';
export const DEFAULT_STAR_COLOR_MODE='security';
// Only confirmed modes are exposed. Extend this registry after user approval.
export const STAR_COLOR_MODES=[{id:'security',label:'安全等级'},{id:'incursion',label:'入侵星系'}];
const colorIndexes=new WeakMap();
const emptyColorIndex={incursions:new Set()};
function colorIndex(environment){
  if(!environment)return emptyColorIndex;
  let index=colorIndexes.get(environment);
  if(!index){index={incursions:new Set(Array.isArray(environment.incursions?.ids)?environment.incursions.ids:[])};colorIndexes.set(environment,index);}
  return index;
}
export function starColorLegend(mode){
  switch(normalizeStarColorMode(mode)){
    case 'incursion':return [{id:'invaded',label:'入侵星系',color:STAR_INCURSION_COLORS.invaded},{id:'other',label:'其余星系',color:STAR_INCURSION_COLORS.other}];
    default:return STAR_SECURITY_LEGEND;
  }
}
export function starColorNotice(mode,environment){
  const normalized=normalizeStarColorMode(mode);
  if(normalized==='incursion'){
    if(!Array.isArray(environment?.incursions?.ids))return '入侵资料不可用，青色不代表已确认安全';
    if(!feedIsCurrent(environment.incursions,300000))return '入侵名单待更新，当前按上次缓存着色';
    return '按当前缓存入侵名单着色';
  }
  return '';
}
// Ascending displayed security: red -> orange -> yellow -> green -> cyan -> blue.
export const STAR_SECURITY_COLORS=['#f00000','#d73000','#f04800','#f06000','#d77700','#efef00','#8fef2f','#00f000','#48f0c0','#2fefef','#3399ff'];
export const STAR_INCURSION_COLORS={invaded:'#ff3b30',other:'#2fefef'};
export const STAR_INCURSION_BACKGROUND_OPACITY=.18;
export function starBackgroundOpacity(mode,hasJumpOverlay=false){
  return mode==='incursion'?STAR_INCURSION_BACKGROUND_OPACITY:hasJumpOverlay?.3:1;
}
export const STAR_SECURITY_LEGEND=STAR_SECURITY_COLORS.map((color,level)=>({id:`security-${level}`,level,label:level===0?'≤ 0.0':(level/10).toFixed(1),color})).reverse();
// Band colors remain fallbacks; labels with a known value use securityTextStyle.
export const STAR_SECURITY_CSS_VARS={'--nav-security-high':STAR_SECURITY_COLORS[7],'--nav-security-low':STAR_SECURITY_COLORS[3],'--nav-security-null':STAR_SECURITY_COLORS[0]};
export function securityColorLevel(security){
  if(!Number.isFinite(security)||security<=0)return 0;
  return Math.min(10,Math.max(1,Math.round(security*10)));
}
export function securityTextStyle(security){return {color:STAR_SECURITY_COLORS[securityColorLevel(security)]};}
export function normalizeStarColorMode(mode){return STAR_COLOR_MODES.some(item=>item.id===mode)?mode:DEFAULT_STAR_COLOR_MODE;}
/** @param {object|null} [environment] Cached navigation environment, never fetched per star. */
export function starMapColor(system,mode=DEFAULT_STAR_COLOR_MODE,environment=null){
  switch(normalizeStarColorMode(mode)){
    case 'incursion':return colorIndex(environment).incursions.has(system.id)?STAR_INCURSION_COLORS.invaded:STAR_INCURSION_COLORS.other;
    case 'security':
    default:return STAR_SECURITY_COLORS[securityColorLevel(system.security)];
  }
}
