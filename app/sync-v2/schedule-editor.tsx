"use client";
import { useState } from 'react';
import { cronToSchedule, scheduleToCron, defaultSchedule, type Schedule } from '../../lib/sync-schedule';
export default function ScheduleEditor({cron,onSave}:{cron:string|null;onSave:(cron:string)=>Promise<void>}) {
  const initial=cronToSchedule(cron);
  const [visual,setVisual]=useState(Boolean(initial)),[schedule,setSchedule]=useState<Schedule>(initial??defaultSchedule),[expression,setExpression]=useState(cron??''),[error,setError]=useState('');
  function switchMode(next:boolean) {
    setError('');
    if(next){const parsed=cronToSchedule(expression);if(!parsed){setError('这个 Cron 是自定义计划，不能无损转换。请继续用 Cron，或选择“新建可视化计划”。');return;}setSchedule(parsed);}
    else {try{setExpression(scheduleToCron(schedule));}catch(e){setError(e instanceof Error?e.message:'时间无效');return;}}
    setVisual(next);
  }
  return <form className="v2-schedule" onSubmit={event=>{event.preventDefault();setError('');try{void onSave(visual?scheduleToCron(schedule):expression);}catch(e){setError(e instanceof Error?e.message:'计划无效');}}}>
    <label className="v2-sync-toggle"><span>可视化配置 <small>{visual?'无需填写 Cron':'Cron 模式'}</small></span><input type="checkbox" checked={visual} onChange={e=>switchMode(e.target.checked)}/><i aria-hidden="true"/></label>
    {visual?<div className="v2-schedule-fields"><label className="v2-sync-field"><span>运行频率</span><select value={schedule.kind} onChange={e=>setSchedule({...schedule,kind:e.target.value as Schedule['kind'],interval:e.target.value==='hours'?1:15})}><option value="minutes">每隔 N 分钟</option><option value="hours">每隔 N 小时</option><option value="daily">每天</option><option value="weekly">每周</option></select></label>
      {['minutes','hours'].includes(schedule.kind)&&<label className="v2-sync-field"><span>{schedule.kind==='minutes'?'分钟间隔':'小时间隔'}</span><input type="number" min="1" max={schedule.kind==='minutes'?59:23} value={schedule.interval} onChange={e=>setSchedule({...schedule,interval:Number(e.target.value)})}/></label>}
      {schedule.kind!=='minutes'&&<label className="v2-sync-field"><span>{schedule.kind==='hours'?'每次在第几分钟':'运行时间'}</span><input type="time" value={schedule.time} onChange={e=>setSchedule({...schedule,time:e.target.value})}/></label>}
      {schedule.kind==='weekly'&&<label className="v2-sync-field"><span>星期</span><select value={schedule.weekday} onChange={e=>setSchedule({...schedule,weekday:Number(e.target.value)})}>{['日','一','二','三','四','五','六'].map((day,i)=><option value={i} key={i}>星期{day}</option>)}</select></label>}
    </div>:<label className="v2-sync-field v2-schedule-cron"><span>Cron 计划</span><input name="cron" value={expression} onChange={e=>setExpression(e.target.value)} placeholder="*/15 * * * *"/></label>}
    <div className="v2-schedule-footer"><small>北京时间；保存后生效，自动开关独立控制。{visual&&schedule.kind==='minutes'&&'分钟间隔在每个整点重新计数。'}{visual&&schedule.kind==='hours'&&'小时间隔在每天零点重新计数。'}</small><button className="v2-sync-button" type="submit">保存计划</button></div>
    {error&&<><p className="v2-sync-error" role="alert">{error}</p>{!visual&&<button type="button" className="v2-sync-button" onClick={()=>{setSchedule(defaultSchedule);setVisual(true);setError('');}}>新建可视化计划</button>}</>}
  </form>;
}
