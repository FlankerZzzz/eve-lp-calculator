export const NAVIGATION_COOKIE={regular:'eve_nav_preferences_v1',jump:'eve_jump_preferences_v1'};
export const DEFAULT_NAVIGATION_PREFERENCES={gateMode:'secure',history:true,gateLines:true,npcStationsOnly:false,modes:['secure'],avoidList:true,avoidIncursions:true};
const modes=['secure','shortest','insecure'];
export function parseNavigationPreferences(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==undefined&&value.version!==1)throw new Error('导航偏好格式无效');
  const result={...DEFAULT_NAVIGATION_PREFERENCES,modes:[...DEFAULT_NAVIGATION_PREFERENCES.modes]};
  for(const key of ['history','gateLines','npcStationsOnly','avoidList','avoidIncursions']){
    if(value[key]!==undefined){if(typeof value[key]!=='boolean')throw new Error('导航偏好开关无效');result[key]=value[key];}
  }
  if(value.gateMode!==undefined){if(!modes.includes(value.gateMode))throw new Error('星门路径偏好无效');result.gateMode=value.gateMode;}
  if(value.modes!==undefined){if(!Array.isArray(value.modes)||value.modes.length>3||value.modes.some(mode=>!modes.includes(mode)))throw new Error('常规路线偏好无效');result.modes=[...new Set(value.modes)];}
  return result;
}
export function readNavigationPreferences(cookies,mode){
  const name=NAVIGATION_COOKIE[mode];if(!name)throw new Error('导航模式无效');
  const part=cookies.split(';').map(value=>value.trim()).find(value=>value.startsWith(name+'='));
  if(!part)return null;
  const raw=part.slice(name.length+1);if(raw.length>3500)throw new Error('导航偏好 Cookie 过大');
  return parseNavigationPreferences(JSON.parse(decodeURIComponent(raw)));
}
export function navigationPreferenceCookie(mode,value,secure=true){
  const name=NAVIGATION_COOKIE[mode];if(!name)throw new Error('导航模式无效');
  const encoded=encodeURIComponent(JSON.stringify({version:1,...parseNavigationPreferences(value)}));
  if(encoded.length>3500)throw new Error('导航偏好 Cookie 过大');
  return `${name}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax${secure?'; Secure':''}`;
}
