import { Layer } from "effect";
import { Atom } from "effect/reactivity";
import { DevToolsLive } from "./devtools";

// NOTE: Modules append additional runtime layers through Layer.mergeAll.
const RuntimeLayer = Layer.mergeAll(Layer.empty, DevToolsLive);

export const runtime = Atom.runtime(RuntimeLayer);
