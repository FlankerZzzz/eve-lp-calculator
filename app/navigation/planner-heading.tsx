export default function PlannerHeading({mode}:{mode:'regular'|'jump'}){
  const regular=mode==='regular';
  return <div className="nav-planner-heading">
    <div className="nav-panel-title"><span>{regular?'01 / ROUTE PLANNER':'01 / SET YOUR COURSE'}</span><b>{regular?'规划你的路线':'规划工作台'}</b></div>
    <nav aria-label="导航模式切换"><a className="nav-mode-switch" href={regular?'/navigation/jump':'/navigation'} aria-label={regular?'切换到旗舰导航':'切换到常规导航'}><span>{regular?'旗舰导航':'常规导航'}</span><i aria-hidden="true">⇄</i></a></nav>
  </div>;
}
