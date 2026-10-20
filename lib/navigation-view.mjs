export function navigationViewPolicy(focused,hasRoutes) {
  return {view:focused&&hasRoutes?'routes':'overview',showBackground:true,fitRoutes:focused&&hasRoutes};
}
