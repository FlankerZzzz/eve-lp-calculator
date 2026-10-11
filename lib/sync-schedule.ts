export type Schedule = { kind: 'minutes' | 'hours' | 'daily' | 'weekly'; interval: number; time: string; weekday: number };
export const defaultSchedule: Schedule = {kind:'daily',interval:15,time:'00:30',weekday:1};
export function scheduleToCron(value: Schedule) {
  const match=/^(\d{2}):(\d{2})$/.exec(value.time);
  if(!match||Number(match[1])>23||Number(match[2])>59)throw new Error('请选择有效时间');
  if(value.kind==='minutes') {
    if(!Number.isInteger(value.interval)||value.interval<1||value.interval>59)throw new Error('分钟间隔须为 1–59');
    return `*/${value.interval} * * * *`;
  }
  if(value.kind==='hours') {
    if(!Number.isInteger(value.interval)||value.interval<1||value.interval>23)throw new Error('小时间隔须为 1–23');
    return `${Number(match[2])} */${value.interval} * * *`;
  }
  if(value.kind==='daily')return `${Number(match[2])} ${Number(match[1])} * * *`;
  if(value.kind==='weekly'&&Number.isInteger(value.weekday)&&value.weekday>=0&&value.weekday<=6)return `${Number(match[2])} ${Number(match[1])} * * ${value.weekday}`;
  throw new Error('计划类型无效');
}
export function cronToSchedule(cron: string | null): Schedule | null {
  if(!cron)return {...defaultSchedule};
  let match=/^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if(match&&Number(match[1])<60)return {...defaultSchedule,kind:'minutes',interval:Number(match[1])};
  match=/^(\d+) \*\/(\d+) \* \* \*$/.exec(cron);
  if(match&&Number(match[1])<60&&Number(match[2])<24)return {...defaultSchedule,kind:'hours',interval:Number(match[2]),time:`00:${match[1].padStart(2,'0')}`};
  match=/^(\d+) (\d+) \* \* (\*|[0-6])$/.exec(cron);
  if(match&&Number(match[1])<60&&Number(match[2])<24)return {...defaultSchedule,kind:match[3]==='*'?'daily':'weekly',time:`${match[2].padStart(2,'0')}:${match[1].padStart(2,'0')}`,weekday:match[3]==='*'?1:Number(match[3])};
  return null;
}
