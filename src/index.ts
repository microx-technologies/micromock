export type { BasicAuthOptions } from "@/auth.ts";
export { apiKeyAuth, basicAuth, bearerAuth, customAuth } from "@/auth.ts";
export { MicromockContainer } from "@/container.ts";
export { buildImage } from "@/docker.ts";
export { collection } from "@/resource.ts";
export { defineService, gateway, isMainModule, resource } from "@/service.ts";
export type {
  Collection,
  Connection,
  CrudHelpers,
  Entity,
  FailShape,
  GatewayCtx,
  GatewayDef,
  GatewayHandle,
  GatewayRegistry,
  MockContext,
  MockEnv,
  MockState,
  ResourceDef,
  ResourceSchema,
  Scheduler,
  Service,
  ServiceDefinition,
  SideEffectFn,
  StartedMock,
  StartedService,
} from "@/types.ts";
