import {MAP_CURSORS} from './star-map-cursors.mjs';

// A gesture that moves away and returns to its starting point is still a drag.
export function mapPointerGesture(threshold=6) {
  let down=null;
  return {
    start(event){down=[0,2].includes(event.button)&&event.isPrimary!==false?{pointerId:event.pointerId,button:event.button,x:event.clientX,y:event.clientY,dragged:false}:null;},
    move(event){if(down&&event.pointerId===down.pointerId&&Math.hypot(event.clientX-down.x,event.clientY-down.y)>threshold)down.dragged=true;},
    finish(event){const previous=down;down=null;if(!previous||previous.dragged||event.pointerId!==previous.pointerId||event.button!==previous.button||Math.hypot(event.clientX-previous.x,event.clientY-previous.y)>threshold)return null;return {button:previous.button,x:event.clientX,y:event.clientY};},
    cancel(){down=null;},
  };
}

// Cursor feedback is independent of hover-card visibility and camera movement.
export function mapCanvasCursor(canvas) {
  let down=null,state=null;
  const render=next=>{if(state===next)return;state=next;canvas.style.cursor=MAP_CURSORS[next];canvas.dataset.mapCursor=next;};
  const reset=()=>{down=null;render('crosshair');};
  reset();
  return {
    buttons(event){
      if(event.pointerType==='touch'||!(event.buttons&5)){reset();return;}
      if(!down)down={x:event.clientX,y:event.clientY,dragged:false};
      if(Math.hypot(event.clientX-down.x,event.clientY-down.y)>6)down.dragged=true;
      render(down.dragged?'dragging':'pressed');
    },
    release:reset,
    reset,
  };
}

// Scope browser-event suppression to the canvas. Other page controls still work.
export function containMapGestures(canvas) {
  const block=event=>{if(event.cancelable)event.preventDefault();};
  const wheel=event=>{block(event);event.stopPropagation();};
  const auxiliary=event=>{if(event.button!==0){block(event);event.stopPropagation();}};
  const entries=[['pointerdown',block,{capture:true}],['wheel',wheel,{passive:false}],['mousedown',auxiliary,{}],['auxclick',auxiliary,{}],['dragstart',block,{}],['selectstart',block,{}],['contextmenu',wheel,{}]];
  for(const [type,listener,options]of entries)canvas.addEventListener(type,listener,options);
  return()=>{for(const [type,listener,options]of entries)canvas.removeEventListener(type,listener,options);};
}
