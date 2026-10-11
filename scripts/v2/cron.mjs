const limits=[[0,59],[0,23],[1,31],[1,12],[0,6]];
export function parseCron(expression) {
  const fields=String(expression).trim().split(/\s+/);if(fields.length!==5)throw new Error('Cron requires five fields: minute hour day month weekday');
  return fields.map((field,index)=>{
    const values=new Set();
    for(const part of field.split(',')) {
      const match=/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);if(!match)throw new Error(`Invalid Cron field ${field}`);
      const step=match[2]?Number(match[2]):1;if(step<1||step>60)throw new Error('Invalid Cron step');
      const [min,max]=limits[index];const [start,end]=match[1]==='*'?[min,max]:match[1].includes('-')?match[1].split('-').map(Number):[Number(match[1]),match[2]?max:Number(match[1])];
      if(start<min||end>max||end<start)throw new Error(`Cron field out of range: ${field}`);
      for(let value=start;value<=end;value+=step)values.add(value);
    }
    return {values,wildcard:field==='*'};
  });
}
export function matchesCron(expression,date=new Date()) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(row=>[row.type,row.value]));
  const weekday=new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`).getUTCDay();
  const values=[Number(parts.minute),Number(parts.hour),Number(parts.day),Number(parts.month),weekday],fields=parseCron(expression);
  const day=fields[2].values.has(values[2]),week=fields[4].values.has(values[4]);
  const calendar=fields[2].wildcard||fields[4].wildcard?day&&week:day||week;
  return fields[0].values.has(values[0])&&fields[1].values.has(values[1])&&fields[3].values.has(values[3])&&calendar;
}
export function nextCron(expression,from=new Date()) {
  parseCron(expression);let time=Math.floor(from.getTime()/60000)*60000+60000;
  for(let count=0;count<527040;count++,time+=60000)if(matchesCron(expression,new Date(time)))return new Date(time).toISOString();
  return null;
}
