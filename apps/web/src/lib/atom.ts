import { Layer } from "effect";
import { Atom } from "effect/reactivity";
import { DevToolsLive } from "./devtools";
import { RpcClient } from "./rpc-client";

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
// No storage layer, on purpose (LOB-75): every list the dashboard shows — boards, cards, sessions —
// is a server read, so a reload shows the server's truth and a second browser shows the same thing.
const RuntimeLayer = Layer.mergeAll(RpcClient.layer, DevToolsLive);

export const runtime = Atom.runtime(RuntimeLayer);
