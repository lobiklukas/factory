import { Layer } from "effect";
import { Atom } from "effect/reactivity";
import { KeyValueStore } from "effect/persistence";
import { DevToolsLive } from "./devtools";
import { RpcClient } from "./rpc-client";

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
// `KeyValueStore` backs the sidebar's session list in sessionStorage: the control
// plane has no list endpoint yet (docs/handoff.md task 8), and sessionStorage
// rather than localStorage keeps a stale tab from resurrecting yesterday's ids.
const RuntimeLayer = Layer.mergeAll(
  RpcClient.layer,
  DevToolsLive,
  KeyValueStore.layerStorage(() => sessionStorage),
);

export const runtime = Atom.runtime(RuntimeLayer);
