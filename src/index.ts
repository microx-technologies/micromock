export type { BasicAuthOptions } from "@/src/auth.ts";
export { apiKeyAuth, basicAuth, bearerAuth, customAuth } from "@/src/auth.ts";
export { MicromockContainer } from "@/src/container.ts";
export { buildImage } from "@/src/docker.ts";
export { collection } from "@/src/resource.ts";
export { defineService, gateway, resource } from "@/src/service.ts";
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
} from "@/src/types.ts";
