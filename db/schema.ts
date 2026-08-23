import { integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const factions = sqliteTable("factions", {
  factionId: integer("faction_id").primaryKey(),
  name: text("name").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const corporations = sqliteTable("corporations", {
  corporationId: integer("corporation_id").primaryKey(),
  factionId: integer("faction_id"),
  name: text("name").notNull(),
  nameSyncedAt: text("name_synced_at"),
  offersSyncedAt: text("offers_synced_at"),
  updatedAt: text("updated_at").notNull(),
});

export const itemTypes = sqliteTable("item_types", {
  typeId: integer("type_id").primaryKey(),
  nameZh: text("name_zh"),
  nameEn: text("name_en"),
  historySyncedAt: text("history_synced_at"),
  orderSyncedAt: text("order_synced_at"),
  updatedAt: text("updated_at").notNull(),
});

export const lpOffers = sqliteTable("lp_offers", {
  corporationId: integer("corporation_id").notNull(),
  offerId: integer("offer_id").notNull(),
  typeId: integer("type_id").notNull(),
  quantity: integer("quantity").notNull(),
  lpCost: integer("lp_cost").notNull(),
  iskCost: real("isk_cost").notNull(),
  akCost: integer("ak_cost").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
}, table => [primaryKey({ columns: [table.corporationId, table.offerId] })]);

export const lpOfferMaterials = sqliteTable("lp_offer_materials", {
  corporationId: integer("corporation_id").notNull(),
  offerId: integer("offer_id").notNull(),
  typeId: integer("type_id").notNull(),
  quantity: integer("quantity").notNull(),
}, table => [primaryKey({ columns: [table.corporationId, table.offerId, table.typeId] })]);

export const blueprintRecipes = sqliteTable("blueprint_recipes", {
  blueprintTypeId: integer("blueprint_type_id").primaryKey(),
  productTypeId: integer("product_type_id").notNull(),
  productQuantity: integer("product_quantity").notNull(),
  checkedAt: text("checked_at").notNull(),
});

export const blueprintMaterials = sqliteTable("blueprint_materials", {
  blueprintTypeId: integer("blueprint_type_id").notNull(),
  materialTypeId: integer("material_type_id").notNull(),
  quantity: integer("quantity").notNull(),
}, table => [primaryKey({ columns: [table.blueprintTypeId, table.materialTypeId] })]);

export const blueprintChecks = sqliteTable("blueprint_checks", {
  typeId: integer("type_id").primaryKey(),
  checkedAt: text("checked_at").notNull(),
});

export const marketDaily = sqliteTable("market_daily", {
  regionId: integer("region_id").notNull(),
  typeId: integer("type_id").notNull(),
  tradeDate: text("trade_date").notNull(),
  averagePrice: real("average_price").notNull(),
  highestPrice: real("highest_price").notNull(),
  lowestPrice: real("lowest_price").notNull(),
  volume: integer("volume").notNull(),
}, table => [primaryKey({ columns: [table.regionId, table.typeId, table.tradeDate] })]);

export const marketOrders = sqliteTable("market_orders", {
  regionId: integer("region_id").notNull(),
  typeId: integer("type_id").notNull(),
  buyPrice: real("buy_price").notNull(),
  sellPrice: real("sell_price").notNull(),
  buyVolume: integer("buy_volume").notNull(),
  sellVolume: integer("sell_volume").notNull(),
  collectedAt: text("collected_at").notNull(),
}, table => [primaryKey({ columns: [table.regionId, table.typeId] })]);

export const marketOrderLevels = sqliteTable("market_order_levels", {
  regionId: integer("region_id").notNull(),
  typeId: integer("type_id").notNull(),
  side: text("side").notNull(),
  level: integer("level").notNull(),
  price: real("price").notNull(),
  volume: integer("volume").notNull(),
  collectedAt: text("collected_at").notNull(),
}, table => [primaryKey({ columns: [table.regionId, table.typeId, table.side, table.level] })]);

export const syncRuns = sqliteTable("sync_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  detail: text("detail"),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
});

export const syncJobs = sqliteTable("sync_jobs", {
  kind: text("kind").primaryKey(),
  status: text("status").notNull(),
  phase: text("phase"),
  runStartedAt: text("run_started_at"),
  processed: integer("processed").notNull().default(0),
  remaining: integer("remaining").notNull().default(0),
  lastEndpoint: text("last_endpoint"),
  lastHttpStatus: integer("last_http_status"),
  lastResponse: text("last_response"),
  error: text("error"),
  updatedAt: text("updated_at").notNull(),
});

export const syncEvents = sqliteTable("sync_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  phase: text("phase"),
  endpoint: text("endpoint"),
  httpStatus: integer("http_status"),
  response: text("response"),
  createdAt: text("created_at").notNull(),
});
