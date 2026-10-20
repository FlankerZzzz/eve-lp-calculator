// Code-native pixel art stays sharp at its actual 32px cursor size.
const open=[
  '.......##.........',
  '.......##.##......',
  '....##.##.##......',
  '....##.##.##.##...',
  '....##.##.##.##...',
  '....##.##.##.##...',
  '....##.##.##.##...',
  '....###########...',
  '....###########...',
  '.##.###########...',
  '.##############...',
  '..#############...',
  '...############...',
  '....###########...',
  '.....#########....',
  '......########....',
  '......########....',
  '......mmmmmmmm....',
  '......mmmmmmmm....',
];
const grip=[
  '......##..........',
  '...##.##.##.......',
  '...########.##....',
  '...###########....',
  '.#############....',
  '.#############....',
  '.#############....',
  '..############....',
  '...##########.....',
  '....########......',
  '....########......',
  '....mmmmmmmm......',
  '....mmmmmmmm......',
];
function pixelHand(rows,offsetX,offsetY){
  const pixels=rows.flatMap((row,y)=>[...row].flatMap((c,x)=>c==='.'?[]:[{x:x+offsetX,y:y+offsetY,color:c==='m'?'#79efd2':'#f6faf7'}]));
  const rect=(x,y,size,color)=>`<rect x="${x}" y="${y}" width="${size}" height="${size}" fill="${color}"/>`;
  return pixels.map(p=>rect(p.x-1,p.y-1,3,'#07141d')).join('')+pixels.map(p=>rect(p.x,p.y,1,p.color)).join('');
}
function cursor(body,fallback){
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">${body}</svg>`;
  // All states share a fixed hotspot, so the targeting point never jumps.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, ${fallback}`;
}
export const MAP_CURSORS=Object.freeze({
  crosshair:cursor('<path d="M15 4h2v9h-2zM15 19h2v9h-2zM4 15h9v2H4zM19 15h9v2h-9z" fill="#f6faf7" stroke="#07141d" stroke-width="2" paint-order="stroke"/><rect x="15" y="15" width="2" height="2" fill="#79efd2"/>','crosshair'),
  pressed:cursor(pixelHand(open,6,5),'grab'),
  dragging:cursor(pixelHand(grip,7,10),'grabbing'),
});
