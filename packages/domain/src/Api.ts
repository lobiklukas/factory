import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";

export class HealthGroup extends HttpApiGroup.make("health")
  .add(HttpApiEndpoint.get("get", "/", { success: Schema.String }))
  .prefix("/") {}

// NOTE: Session, sandbox, and approval groups are added here as they land.
export const Api = HttpApi.make("Api").add(HealthGroup);
