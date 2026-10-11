import { initialLpFlags, HIDDEN_FACTIONS, HIDDEN_CORPORATIONS, HIGH_SEC_EXCLUDED_CORPORATION_IDS } from '../../lib/data-policy.ts';
import { NPC_CORPORATION_FACTIONS } from '../../lib/npc-factions.ts';
import { transaction, getState, setState } from './database.mjs';

export function migrateLpFlags(db) {
  transaction(db,()=>{
    const columns=new Set(db.prepare('PRAGMA table_info(lp_exchange)').all().map(row=>row.name));
    for(const name of ['is_high_sec','is_blocked']) if(!columns.has(name))db.exec(`ALTER TABLE lp_exchange ADD COLUMN ${name} TEXT NOT NULL DEFAULT 'N' CHECK(${name} IN ('Y','N'));`);
    if(!getState(db,'lp_flags_seeded')) {
      const update=db.prepare('UPDATE lp_exchange SET is_high_sec=?,is_blocked=? WHERE corporation_id=? AND offer_id=?');
      for(const row of db.prepare('SELECT corporation_id,offer_id,faction_id,ak_cost FROM lp_exchange').all()) {
        const flags=initialLpFlags(row.corporation_id,NPC_CORPORATION_FACTIONS[row.corporation_id]??row.faction_id,row.ak_cost);
        update.run(flags.is_high_sec,flags.is_blocked,row.corporation_id,row.offer_id);
      }
      setState(db,'lp_flags_seeded',{version:1,at:new Date().toISOString()});
    }
    // Table edits (including SQL/import) must invalidate the ranking schedule, not just UI edits.
    db.exec(`CREATE TRIGGER IF NOT EXISTS lp_flags_changed AFTER UPDATE OF is_high_sec,is_blocked ON lp_exchange
      WHEN OLD.is_high_sec<>NEW.is_high_sec OR OLD.is_blocked<>NEW.is_blocked
      BEGIN
        INSERT INTO runtime_state(key,value) VALUES('lp_policy_revision','1')
          ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT);
        UPDATE tasks SET status=CASE WHEN status IN ('running','pause_requested') THEN status ELSE 'queued' END,
          run_id=CASE WHEN status IN ('running','pause_requested') THEN run_id ELSE NULL END,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE module='rankings';
      END;`);
    for(const name of ['manual_blocked','is_guard','is_invalid']) if(!columns.has(name))db.exec(`ALTER TABLE lp_exchange ADD COLUMN ${name} TEXT NOT NULL DEFAULT 'N' CHECK(${name} IN ('Y','N'));`);
    if(!getState(db,'lp_policy_config')) {
      const config=defaultLpPolicy();
      const update=db.prepare('UPDATE lp_exchange SET manual_blocked=?,is_guard=?,is_invalid=? WHERE corporation_id=? AND offer_id=?');
      for(const row of db.prepare('SELECT * FROM lp_exchange').all()) {
        const defaults=initialLpFlags(row.corporation_id,row.faction_id,row.ak_cost);
        const flags=lpFlagsForOffer(db,row,null,config);
        // Split the old default exclusion from manual blocks, without changing effective visibility.
        const manual=row.is_blocked==='Y'&&defaults.is_blocked==='N'?'Y':'N';
        if(row.is_blocked==='N'&&defaults.is_blocked==='Y')config.rules.push({scope:'offer',target_id:`${row.corporation_id}:${row.offer_id}`,field:'is_invalid',value:'N',reason:'保留迁移前人工解除屏蔽',updated_at:new Date().toISOString()});
        update.run(manual,flags.is_guard,row.is_blocked==='N'&&defaults.is_blocked==='Y'?'N':flags.is_invalid,row.corporation_id,row.offer_id);
      }
      setState(db,'lp_policy_config',config);
    }
  });
}

// Explicit one-off migration: old DB is a read-only donor of the existing maintained association.
// Never called by public business reads or regular catalog sync.

export function lpFlagMap(db) {
  return new Map(db.prepare('SELECT corporation_id,offer_id,is_high_sec,is_blocked FROM lp_exchange').all().map(row=>[`${row.corporation_id}:${row.offer_id}`,row]));
}
export function filterLpRankingRows(rows,flags) {
  return rows.flatMap(row=>{
    const current=flags.get(`${row.corporation_id}:${row.offer_id}`);
    return current?.is_blocked==='N'?[{...row,is_high_sec:current.is_high_sec,is_blocked:current.is_blocked}]:[];
  });
}
export function visibleImplantSetsSql() {
  return `SELECT cs.set_id FROM corporation_sets cs JOIN implant_sets s ON s.set_id=cs.set_id
    JOIN lp_exchange o ON o.corporation_id=cs.corporation_id AND o.is_blocked='N'
    LEFT JOIN recipes r ON r.blueprint_id=o.type_id
    WHERE COALESCE(r.product_type_id,o.type_id) IN (s.slot_1_type_id,s.slot_2_type_id,s.slot_3_type_id,s.slot_4_type_id,s.slot_5_type_id,s.slot_6_type_id)
    GROUP BY cs.corporation_id,cs.set_id HAVING COUNT(DISTINCT COALESCE(r.product_type_id,o.type_id))=6`;
}
// Contract references use finished implants, including sets offered as blueprints.
// Preserve manually maintained sets; derive additional complete sets without writing tables.
export function contractImplantSetsSql() {
  const levels=['Alpha','Beta','Gamma','Delta','Epsilon','Omega'];
  return `WITH levels(level,slot) AS (VALUES ${levels.map((level,i)=>`('${level}',${i+1})`).join(',')}),
    products AS (
      SELECT o.corporation_id,CASE WHEN r.blueprint_id IS NULL THEN 0 ELSE 1 END blueprint,
        COALESCE(r.product_type_id,o.type_id) type_id,i.name_en
      FROM lp_exchange o LEFT JOIN recipes r ON r.blueprint_id=o.type_id
      JOIN items i ON i.type_id=COALESCE(r.product_type_id,o.type_id)
      WHERE o.is_blocked='N'
    ), derived AS (
      SELECT p.corporation_id,p.blueprint,
        substr(p.name_en,1,length(p.name_en)-length(l.level)-1) family,
        ${levels.map((_,i)=>`MAX(CASE WHEN l.slot=${i+1} THEN p.type_id END) slot_${i+1}_type_id`).join(',')}
      FROM products p JOIN levels l ON substr(p.name_en,-length(l.level)-1)=' '||l.level
      GROUP BY p.corporation_id,p.blueprint,family
      HAVING COUNT(DISTINCT l.slot)=6 AND COUNT(DISTINCT p.type_id)=6
    )
    SELECT ${levels.map((_,i)=>`slot_${i+1}_type_id`).join(',')} FROM derived
    UNION SELECT ${levels.map((_,i)=>`slot_${i+1}_type_id`).join(',')} FROM implant_sets
      WHERE set_id IN (${visibleImplantSetsSql()})`;
}
export function updateLpFlags(db,corporationId,offerId,changes) {
  if(!Number.isSafeInteger(corporationId)||corporationId<1||!Number.isSafeInteger(offerId)||offerId<1)throw new Error('军团 ID 和方案 ID 无效');
  const keys=Object.keys(changes);
  if(!keys.length||keys.some(key=>!['is_high_sec','is_blocked','is_guard','is_invalid'].includes(key)))throw new Error('只能维护高安、屏蔽和分类标记');
  if(keys.some(key=>!['Y','N'].includes(changes[key])))throw new Error('标记只能为 Y 或 N');
  return transaction(db,()=>{
    const before=db.prepare('SELECT * FROM lp_exchange WHERE corporation_id=? AND offer_id=?').get(corporationId,offerId);
    if(!before)throw new Error('兑换方案不存在');
    const config=getLpPolicy(db);
    for(const field of ['is_guard','is_invalid'])if(changes[field]) {
      config.rules=config.rules.filter(rule=>!(rule.scope==='offer'&&rule.target_id===`${corporationId}:${offerId}`&&rule.field===field));
      config.rules.push({scope:'offer',target_id:`${corporationId}:${offerId}`,field,value:changes[field],reason:'单方案分类维护',updated_at:new Date().toISOString()});
      config.version++;setState(db,'lp_policy_config',config);
    }
    const flags=lpFlagsForOffer(db,before,{...before,manual_blocked:changes.is_blocked??before.manual_blocked,is_high_sec:changes.is_high_sec??before.is_high_sec},config);
    writeLpFlags(db,before,flags);
    return {before:{...before},after:{...before,...flags},revision:getState(db,'lp_policy_revision',0)};
  });
}

export function defaultLpPolicy() {
  const make=(scope,target_id,field,reason)=>({scope,target_id,field,value:'Y',reason,updated_at:new Date().toISOString()});
  return {version:1,block_guard:false,block_invalid:true,rules:[
    ...HIDDEN_FACTIONS.map(row=>make('faction',row.id,'is_invalid',`${row.name}：${row.reason}`)),
    ...HIDDEN_CORPORATIONS.map(row=>make('corporation',row.id,'is_invalid',`${row.name}：${row.reason}`)),
    ...[...HIGH_SEC_EXCLUDED_CORPORATION_IDS].map(id=>make('corporation',id,'is_guard','阵营战争卫队兑换方案')),
  ]};
}
export function getLpPolicy(db) {return getState(db,'lp_policy_config')??defaultLpPolicy();}
function matchesRule(row,rule) {
  return rule.scope==='offer'?rule.target_id===`${row.corporation_id}:${row.offer_id}`:row[{faction:'faction_id',corporation:'corporation_id',item:'type_id'}[rule.scope]]===rule.target_id;
}
/** @param {Record<string, unknown> | null} previous */
export function lpFlagsForOffer(db,row,previous=null,config=getLpPolicy(db)) {
  let guard='N',invalid=Number(row.ak_cost)>0?'Y':'N';
  const matched=config.rules.filter(rule=>matchesRule(row,rule));
  // More specific classifications override broader ones; a block is additive, never an allow-list.
  for(const scope of ['faction','corporation','item','offer'])for(const rule of matched.filter(rule=>rule.scope===scope)) {
    if(rule.field==='is_guard')guard=rule.value;
    if(rule.field==='is_invalid')invalid=rule.value;
  }
  const manual=previous?.manual_blocked??'N';
  return {is_high_sec:previous?.is_high_sec??initialLpFlags(row.corporation_id,row.faction_id,row.ak_cost).is_high_sec,manual_blocked:manual,is_guard:guard,is_invalid:invalid,
    is_blocked:manual==='Y'||matched.some(rule=>rule.field==='is_blocked'&&rule.value==='Y')||config.block_guard&&guard==='Y'||config.block_invalid&&invalid==='Y'?'Y':'N'};
}
function writeLpFlags(db,row,flags) {
  db.prepare('UPDATE lp_exchange SET is_high_sec=?,manual_blocked=?,is_guard=?,is_invalid=?,is_blocked=? WHERE corporation_id=? AND offer_id=?').run(flags.is_high_sec,flags.manual_blocked,flags.is_guard,flags.is_invalid,flags.is_blocked,row.corporation_id,row.offer_id);
}
export function recomputeLpPolicy(db,config=getLpPolicy(db)) {
  let changed=0;
  for(const row of db.prepare('SELECT * FROM lp_exchange').all()) {
    const flags=lpFlagsForOffer(db,row,row,config);
    if(Object.entries(flags).some(([key,value])=>row[key]!==value)){writeLpFlags(db,row,flags);changed++;}
  }
  return changed;
}
export function validateLpPolicy(config) {
  if(!config||typeof config.block_guard!=='boolean'||typeof config.block_invalid!=='boolean'||!Array.isArray(config.rules)||config.rules.length>5000)throw new Error('屏蔽配置格式无效（最多 5000 条规则）');
  const seen=new Set();
  for(const rule of config.rules) {
    if(!rule||typeof rule!=='object'||Object.keys(rule).some(key=>!['scope','target_id','field','value','reason','updated_at','target_name'].includes(key)))throw new Error('规则包含未知字段');
    if(!['faction','corporation','item','offer'].includes(rule.scope)||!['is_blocked','is_guard','is_invalid'].includes(rule.field)||!['Y','N'].includes(rule.value))throw new Error('规则类型或 Y/N 值无效');
    if(rule.scope==='offer'?(!/^\d+:\d+$/.test(String(rule.target_id))||String(rule.target_id).split(':').some(id=>!Number.isSafeInteger(Number(id))||Number(id)<1)):!Number.isSafeInteger(rule.target_id)||rule.target_id<1)throw new Error('规则目标 ID 无效');
    if(typeof rule.reason!=='string'||!rule.reason.trim()||rule.reason.length>300)throw new Error('请填写规则原因，最多 300 字');
    if(rule.target_name!==undefined&&(typeof rule.target_name!=='string'||rule.target_name.length>200))throw new Error('目标名称过长或无效');
    if(rule.updated_at!==undefined&&(typeof rule.updated_at!=='string'||rule.updated_at.length>50))throw new Error('规则更新时间无效');
    const key=`${rule.scope}:${rule.target_id}:${rule.field}`;if(seen.has(key))throw new Error(`重复规则 ${key}`);seen.add(key);
  }
  return config;
}
export function saveLpPolicy(db,config,expectedVersion) {
  validateLpPolicy(config);
  return transaction(db,()=>{
    const before=getLpPolicy(db);if(expectedVersion!==before.version)throw new Error('配置已被其他操作修改，请刷新后重试');
    const after={version:before.version+1,block_guard:config.block_guard,block_invalid:config.block_invalid,rules:config.rules.map(rule=>({...rule}))};
    setState(db,'lp_policy_config',after);const changed=recomputeLpPolicy(db,after);
    // Even with no currently matching offers, persistent rules apply to future catalog records.
    const revision=getState(db,'lp_policy_revision',0);setState(db,'lp_policy_revision',revision+1);
    db.prepare("UPDATE tasks SET status=CASE WHEN status IN ('running','pause_requested') THEN status ELSE 'queued' END,run_id=CASE WHEN status IN ('running','pause_requested') THEN run_id ELSE NULL END,updated_at=? WHERE module='rankings'").run(new Date().toISOString());
    return {before,after,changed,revision:revision+1};
  });
}
