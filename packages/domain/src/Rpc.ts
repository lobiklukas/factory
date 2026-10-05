import { Rpc, RpcGroup } from "effect/rpc";
import {
  CreateSessionInput,
  SendMessageInput,
  SendMessageResult,
  SessionError,
  SessionEvent,
  SessionIdInput,
  SessionSnapshot,
  SessionSummary,
} from "./Session";

/**
 * The session RPC surface (docs/design.md D8/D9): create, read, drive, interrupt, watch.
 *
 * `watchSession` is the streaming one, and it is the only place the live/historical distinction
 * shows: attaching to a session this process owns streams events as they commit, while attaching
 * to one nobody owns folds the log once, sends a single `snapshot` whose `mode` is `historical`,
 * and ends the stream. The stream's own error channel carries `SessionError`, so a session that
 * vanishes mid-stream fails the stream rather than the connection.
 */
export class SessionRpc extends RpcGroup.make(
  Rpc.make("createSession", {
    payload: CreateSessionInput,
    success: SessionSummary,
    error: SessionError,
  }),
  Rpc.make("getSession", {
    payload: SessionIdInput,
    success: SessionSnapshot,
    error: SessionError,
  }),
  Rpc.make("sendMessage", {
    payload: SendMessageInput,
    success: SendMessageResult,
    error: SessionError,
  }),
  Rpc.make("interruptSession", {
    payload: SessionIdInput,
    success: SessionSummary,
    error: SessionError,
  }),
  Rpc.make("watchSession", {
    payload: SessionIdInput,
    success: SessionEvent,
    error: SessionError,
    stream: true,
  }),
) {}

// NOTE: Sandbox, approval, and sandbox-status groups merge in here.
export const RpcApi = SessionRpc;
