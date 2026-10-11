import { transaction } from './database.mjs';

// One-off repair is intentionally scoped to ESI rows written by the faulty bootstrap.
export function pruneErroneousUnpublishedItems(db,since,log) {
  if(typeof since!=='string'||!Number.isFinite(Date.parse(since))||new Date(since).toISOString()!==since)throw new Error('Explicit ISO timestamp required for item cleanup');
  return transaction(db,()=>{
    const candidates=db.prepare("SELECT type_id,name_zh,sync_protected FROM items WHERE source='ESI' AND published=0 AND updated_at>=? ORDER BY type_id").all(since);
    const referenced=db.prepare(`SELECT EXISTS(SELECT 1 FROM recipes WHERE blueprint_id=? OR product_type_id=?)
      OR EXISTS(SELECT 1 FROM recipe_materials WHERE material_type_id=?)
      OR EXISTS(SELECT 1 FROM lp_exchange WHERE type_id=?)
      OR EXISTS(SELECT 1 FROM lp_requirements WHERE material_type_id=?)
      OR EXISTS(SELECT 1 FROM implant_sets WHERE ? IN(slot_1_type_id,slot_2_type_id,slot_3_type_id,slot_4_type_id,slot_5_type_id,slot_6_type_id)) AS referenced`);
    const remove=db.prepare("DELETE FROM items WHERE type_id=? AND source='ESI' AND published=0 AND sync_protected='N' AND updated_at>=?");
    const deleted=[],retained=[];
    for(const row of candidates) {
      if(row.sync_protected==='Y'){retained.push({...row,reason:'protected'});continue;}
      if(referenced.get(...Array(6).fill(row.type_id)).referenced){retained.push({...row,reason:'referenced'});continue;}
      if(remove.run(row.type_id,since).changes)deleted.push(row.type_id);
    }
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Item cleanup foreign key check failed');
    log.payload?.('removed_unpublished_item_ids',deleted);
    log.payload?.('retained_unpublished_item_ids',retained);
    const result={since,candidates:candidates.length,deleted:deleted.length,retained};
    log.info('unpublished_item_cleanup',result);return result;
  });
}
