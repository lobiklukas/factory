import { Layer } from "effect";
import { Atom } from "effect/reactivity";
import { DevToolsLive } from "./devtools";
import { RpcClient } from "./rpc-client";

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
const RuntimeLayer = Layer.mergeAll(RpcClient.layer, DevToolsLive);

export const runtime = Atom.runtime(RuntimeLayer);
