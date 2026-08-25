export function summarize(orders) {
  const buys = orders.filter(order => order.is_buy_order && order.price > 0);
  const sells = orders.filter(order => !order.is_buy_order && order.price > 0);
  const maxBuy = Math.max(...buys.map(order => order.price), 0);
  const totalBuyVolume = buys.reduce((sum, order) => sum + order.volume_remain, 0);
  const filteredBuys = buys.filter(order => !(order.price < maxBuy * 0.2 && order.volume_remain > totalBuyVolume * 0.1));
  const levels = (source, direction) => {
    const grouped = new Map();
    for (const order of source) grouped.set(order.price, (grouped.get(order.price) || 0) + order.volume_remain);
    return [...grouped.entries()].sort(([a], [b]) => direction === "asc" ? a - b : b - a).map(([price, volume], index) => ({ level: index + 1, price, volume }));
  };
  return {
    buyPrice: filteredBuys.length ? Math.max(...filteredBuys.map(order => order.price)) : 0,
    sellPrice: sells.length ? Math.min(...sells.map(order => order.price)) : 0,
    buyVolume: filteredBuys.reduce((sum, order) => sum + order.volume_remain, 0),
    sellVolume: sells.reduce((sum, order) => sum + order.volume_remain, 0),
    buyLevels: levels(filteredBuys, "desc"),
    sellLevels: levels(sells, "asc"),
  };
}
