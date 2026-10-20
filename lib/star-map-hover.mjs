// Keep the card within the visible part of the map, in client coordinates.
export function hoverCardPosition(pointer,bounds,size,gap=16,padding=10){
  const left=bounds.left+padding,top=bounds.top+padding;
  const right=Math.max(left,bounds.right-padding),bottom=Math.max(top,bounds.bottom-padding);
  let x=pointer.x+gap,y=pointer.y+gap;
  if(x+size.width>right)x=pointer.x-gap-size.width;
  if(y+size.height>bottom)y=pointer.y-gap-size.height;
  return {x:Math.max(left,Math.min(x,Math.max(left,right-size.width))),y:Math.max(top,Math.min(y,Math.max(top,bottom-size.height)))};
}
