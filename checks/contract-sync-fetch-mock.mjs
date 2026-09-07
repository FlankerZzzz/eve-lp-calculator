const contract = contract_id => ({
  contract_id, type: "item_exchange", price: contract_id === 100 ? 3_500_000_000 : contract_id === 104 ? 24_000_000 : 1_000_000,
  date_issued: "2026-08-29T00:00:00Z", date_expired: "2026-09-29T00:00:00Z",
  start_location_id: 60003760, end_location_id: 60003760, volume: 6,
});
const sixItems = quantity => [10, 20, 30, 40, 50, 60].map(type_id => ({ is_included: true, type_id, quantity }));

globalThis.fetch = async input => {
  const url = new URL(String(input));
  if (url.pathname === "/latest/contracts/public/10000002/") {
    const directory = [contract(100), contract(101), contract(103), contract(104)];
    if (process.env.MOCK_CONTRACT_SCENARIO === "failure") directory.push(contract(102));
    return Response.json(directory, { headers: { "x-pages": "1" } });
  }
  const match = url.pathname.match(/^\/latest\/contracts\/public\/items\/(\d+)\/$/);
  if (!match) return Response.json({}, { status: 404 });
  const contractId = Number(match[1]);
  if (contractId === 100) return Response.json(sixItems(10));
  if (contractId === 101) return Response.json(sixItems(1).slice(0, 5));
  if (contractId === 103) return new Response("", { status: 200, headers: { "content-type": "application/json" } });
  if (contractId === 104) return Response.json([{ is_included: true, is_blueprint_copy: true, type_id: 700, quantity: 2, runs: 5, material_efficiency: 10, time_efficiency: 20 }]);
  return Response.json({ error: "blocked for test" }, { status: 403 });
};
