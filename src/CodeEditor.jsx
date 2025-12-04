// CodeEditorFixed.js
import React, { useState, useEffect, useRef } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import { Client } from "@stomp/stompjs";

import "prismjs/components/prism-java";
import "prismjs/themes/prism-tomorrow.css";

let SockJS = null;

/* ============================================================
   TextOperation - faithful conversion of your TypeScript class special thanks to ot.js for inspiration :)
   ============================================================ */
class TextOperation {
  constructor() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }

  // Helpers
  static isRetain(op) {
    return typeof op === "number" && op > 0;
  }
  static isInsert(op) {
    return typeof op === "string";
  }
  static isDelete(op) {
    return typeof op === "number" && op < 0;
  }

  // Retain
  retain(n) {
    if (typeof n !== "number" || n < 0) {
      throw new Error("retain expects a non-negative integer.");
    }
    if (n === 0) return this;
    this.baseLength += n;
    this.targetLength += n;
    const lastOp = this.ops[this.ops.length - 1];
    if (TextOperation.isRetain(lastOp)) {
      this.ops[this.ops.length - 1] = lastOp + n;
    } else {
      this.ops.push(n);
    }
    return this;
  }

  // Insert
  insert(str) {
    if (typeof str !== "string") {
      throw new Error("insert expects a string.");
    }
    if (str === "") return this;
    this.targetLength += str.length;
    const ops = this.ops;
    const lastOp = ops[ops.length - 1];
    const secondLastOp = ops[ops.length - 2];

    if (TextOperation.isInsert(lastOp)) {
      ops[ops.length - 1] = lastOp + str;
    } else if (TextOperation.isDelete(lastOp)) {
      // place insert before last delete; merge with second-last insert if present
      if (TextOperation.isInsert(secondLastOp)) {
        ops[ops.length - 2] = secondLastOp + str;
      } else {
        // preserve delete as last item but insert new string before it
        ops[ops.length] = lastOp;
        ops[ops.length - 2] = str;
      }
    } else {
      ops.push(str);
    }
    return this;
  }

  // Delete - accepts either positive length or a negative number or a string
  delete(n) {
    let length;
    if (typeof n === "string") {
      length = n.length;
    } else if (typeof n === "number") {
      length = n;
    } else {
      throw new Error("delete expects an integer or a string.");
    }
    if (length === 0) return this;
    // If positive length passed, convert to negative; if negative already, keep as negative
    if (length > 0) {
      length = -length;
    }
    // baseLength decreases by negative length (i.e. increases by the positive deleted count)
    this.baseLength -= length;
    const lastOp = this.ops[this.ops.length - 1];
    if (TextOperation.isDelete(lastOp)) {
      this.ops[this.ops.length - 1] = lastOp + length;
    } else {
      this.ops.push(length);
    }
    return this;
  }

  // isNoop
  isNoop() {
    return this.ops.length === 0 || (this.ops.length === 1 && TextOperation.isRetain(this.ops[0]));
  }

  // toJSON representation (serializable ops array)
  toJSON() {
    return this.ops;
  }

  // fromJSON to construct TextOperation from ops array (ops may include negative deletes)
  static fromJSON(ops) {
    const o = new TextOperation();
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (TextOperation.isRetain(op)) {
        o.retain(op);
      } else if (TextOperation.isInsert(op)) {
        o.insert(op);
      } else if (TextOperation.isDelete(op)) {
        o.delete(op);
      } else {
        throw new Error("unknown operation type: " + JSON.stringify(op));
      }
    }
    return o;
  }

  // apply: apply this operation to a string and return the result
  apply(str) {
    const newStr = [];
    let strIndex = 0;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i];
      if (TextOperation.isRetain(op)) {
        if (strIndex + op > str.length) {
          throw new Error("Operation check error: Retain length should not exceed string length.");
        }
        newStr.push(str.slice(strIndex, strIndex + op));
        strIndex += op;
      } else if (TextOperation.isInsert(op)) {
        newStr.push(op);
      } else {
        // delete op (negative)
        strIndex -= op; // op < 0 so subtracting moves index forward by -op
        if (strIndex > str.length) {
          throw new Error("Operation check error: Delete length should not exceed string length.");
        }
      }
    }
    // If operation didn't consume entire input document, that's okay — some implementations require full consumption,
    // but your Java OTUtils checked that externally. We'll not enforce that here strictly (keeps compatibility).
    return newStr.join("");
  }

  // invert: returns inverse operation relative to provided original string
  invert(str) {
    const inverse = new TextOperation();
    let strIndex = 0;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i];
      if (TextOperation.isRetain(op)) {
        inverse.retain(op);
        strIndex += op;
      } else if (TextOperation.isInsert(op)) {
        inverse.delete(op.length);
      } else {
        // delete op
        if (strIndex > str.length) {
          throw new Error(
            `Cannot invert delete (${-op}) starting past end of document (${str.length}) at index ${strIndex}. Original Op: ${this.toString()}`
          );
        }
        const endIndex = Math.min(strIndex - op, str.length); // strIndex - op = strIndex + (-op)
        inverse.insert(str.slice(strIndex, endIndex));
        strIndex -= op;
      }
    }
    return inverse;
  }

  // compose: merge this (op1) and operation2 (op2) where this.targetLength === operation2.baseLength
  compose(operation2) {
    if (this.targetLength !== operation2.baseLength) {
      throw new Error(
        "The base length of the second operation has to be the target length of the first operation"
      );
    }

    const operation = new TextOperation();
    const ops1 = this.ops;
    const ops2 = operation2.ops;
    let i1 = 0,
      i2 = 0;
    let op1 = ops1[i1++];
    let op2 = ops2[i2++];
    while (true) {
      if (typeof op1 === "undefined" && typeof op2 === "undefined") {
        break;
      }

      if (TextOperation.isDelete(op1)) {
        operation.delete(op1);
        op1 = ops1[i1++];
        continue;
      }
      if (TextOperation.isInsert(op2)) {
        operation.insert(op2);
        op2 = ops2[i2++];
        continue;
      }

      if (typeof op1 === "undefined") {
        throw new Error("Cannot compose operations: first operation is too short.");
      }
      if (typeof op2 === "undefined") {
        throw new Error("Cannot compose operations: second operation is too short.");
      }

      if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
        const op1Retain = op1;
        const op2Retain = op2;
        if (op1Retain > op2Retain) {
          operation.retain(op2Retain);
          op1 = op1Retain - op2Retain;
          op2 = ops2[i2++];
        } else if (op1Retain === op2Retain) {
          operation.retain(op1Retain);
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          operation.retain(op1Retain);
          op2 = op2Retain - op1Retain;
          op1 = ops1[i1++];
        }
      } else if (TextOperation.isInsert(op1) && TextOperation.isDelete(op2)) {
        const op1Insert = op1;
        const op2Delete = op2;
        if (op1Insert.length > -op2Delete) {
          op1 = op1Insert.slice(0, op1Insert.length + op2Delete);
          op2 = ops2[i2++];
        } else if (op1Insert.length === -op2Delete) {
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          op2 = op2Delete + op1Insert.length;
          op1 = ops1[i1++];
        }
      } else if (TextOperation.isInsert(op1) && TextOperation.isRetain(op2)) {
        const op1Insert = op1;
        const op2Retain = op2;
        if (op1Insert.length > op2Retain) {
          operation.insert(op1Insert.slice(0, op2Retain));
          op1 = op1Insert.slice(op2Retain);
          op2 = ops2[i2++];
        } else if (op1Insert.length === op2Retain) {
          operation.insert(op1Insert);
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          operation.insert(op1Insert);
          op2 = op2Retain - op1Insert.length;
          op1 = ops1[i1++];
        }
      } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
        const op1Retain = op1;
        const op2Delete = op2;
        if (op1Retain > -op2Delete) {
          operation.delete(op2Delete);
          op1 = op1Retain + op2Delete;
          op2 = ops2[i2++];
        } else if (op1Retain === -op2Delete) {
          operation.delete(op2Delete);
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          operation.delete(-op1Retain);
          op2 = op2Delete + op1Retain;
          op1 = ops1[i1++];
        }
      } else {
        throw new Error("This shouldn't happen: op1: " + JSON.stringify(op1) + ", op2: " + JSON.stringify(op2));
      }
    }

    return operation;
  }

  // transform: static method - returns [operation1prime, operation2prime]
  // This is the same algorithm you requested (translation of your Java)
  static transform(operation1, operation2) {
    const operation1prime = new TextOperation();
    const operation2prime = new TextOperation();
    const ops1 = operation1.ops;
    const ops2 = operation2.ops;
    let i1 = 0,
      i2 = 0;
    let op1 = ops1[i1++];
    let op2 = ops2[i2++];

    while (op1 !== undefined || op2 !== undefined) {
      if (TextOperation.isInsert(op1)) {
        operation1prime.insert(op1);
        operation2prime.retain(op1.length);
        op1 = ops1[i1++];
        continue;
      }
      if (TextOperation.isInsert(op2)) {
        operation1prime.retain(op2.length);
        operation2prime.insert(op2);
        op2 = ops2[i2++];
        continue;
      }

      if (op1 === undefined) {
        throw new Error("Cannot transform operations: first operation is too short.");
      }
      if (op2 === undefined) {
        throw new Error("Cannot transform operations: second operation is too short.");
      }

      let minLength;
      if (TextOperation.isRetain(op1) && TextOperation.isRetain(op2)) {
        const r1 = op1;
        const r2 = op2;
        if (r1 > r2) {
          minLength = r2;
          op1 = r1 - r2;
          op2 = ops2[i2++];
        } else if (r1 === r2) {
          minLength = r1;
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          minLength = r1;
          op2 = r2 - r1;
          op1 = ops1[i1++];
        }
        operation1prime.retain(minLength);
        operation2prime.retain(minLength);
      } else if (TextOperation.isDelete(op1) && TextOperation.isDelete(op2)) {
        let d1 = op1; // negative
        let d2 = op2; // negative
        if (-d1 > -d2) {
          op1 = d1 - d2;
          op2 = ops2[i2++];
        } else if (-d1 === -d2) {
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          op2 = d2 - d1;
          op1 = ops1[i1++];
        }
      } else if (TextOperation.isDelete(op1) && TextOperation.isRetain(op2)) {
        const d1 = op1;
        const r2 = op2;
        if (-d1 > r2) {
          minLength = r2;
          op1 = d1 + r2;
          op2 = ops2[i2++];
        } else if (-d1 === r2) {
          minLength = r2;
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          minLength = -d1;
          op2 = r2 + d1;
          op1 = ops1[i1++];
        }
        operation1prime.delete(minLength);
      } else if (TextOperation.isRetain(op1) && TextOperation.isDelete(op2)) {
        const r1 = op1;
        const d2 = op2;
        if (r1 > -d2) {
          minLength = -d2;
          op1 = r1 + d2;
          op2 = ops2[i2++];
        } else if (r1 === -d2) {
          minLength = r1;
          op1 = ops1[i1++];
          op2 = ops2[i2++];
        } else {
          minLength = r1;
          op2 = d2 + r1;
          op1 = ops1[i1++];
        }
        operation2prime.delete(minLength);
      } else {
        console.error("Unrecognized transform case hit!", { op1, op2, ops1, ops2, i1, i2, op1prime: operation1prime.ops, op2prime: operation2prime.ops });
        throw new Error("Unrecognized case in transform.");
      }
    }

    return [operation1prime, operation2prime];
  }

  // Pretty printing
  toString() {
    return this.ops
      .map((op) => {
        if (TextOperation.isRetain(op)) return "retain " + op;
        if (TextOperation.isInsert(op)) return "insert '" + op + "'";
        return "delete " + -op;
      })
      .join(", ");
  }
}

/* =========================
   generateOp (diff) -> returns TextOperation
   ========================= */
function generateOp(oldText, newText) {
  const op = new TextOperation();
  let start = 0;
  while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length - 1;
  let newEnd = newText.length - 1;

  while (oldEnd >= start && newEnd >= start && oldText[oldEnd] === newText[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const retainLen = start;
  const deleteLen = Math.max(0, oldEnd - start + 1);
  const insertStr = newText.slice(start, newEnd + 1);
  const retainTail = oldText.length - (oldEnd + 1);

  if (retainLen > 0) op.retain(retainLen);
  if (deleteLen > 0) op.delete(deleteLen);
  if (insertStr.length > 0) op.insert(insertStr);
  if (retainTail > 0) op.retain(retainTail);

  if (op.ops.length === 0) op.retain(oldText.length);
  return op;
}

/* =========================
   Cursor transform
   ========================= */
function transformCursor(index, ops) {
  let cursor = index;
  let pos = 0;
  for (const op of ops) {
    if (typeof op === "number") {
      if (op > 0) pos += op;
      else {
        const length = -op;
        if (cursor > pos && cursor <= pos + length) cursor = pos;
        else if (cursor > pos + length) cursor -= length;
        pos += length;
      }
    } else {
      const length = op.length;
      if (cursor >= pos) cursor += length;
      pos += length;
    }
  }
  return cursor;
}

/* =========================
   OTClient (pending / buffer)
   ========================= */
class OTClient {
  constructor() {
    this.pending = null; // TextOperation
    this.buffer = null; // TextOperation
  }

  // Called when local op generated
  applyClient(op) {
    if (!this.pending) {
      this.pending = op;
      return op;
    }
    // buffer
    this.buffer = this.buffer ? this.buffer.compose(op) : op;
    return null;
  }

  // Called when server ACKs our pending op
  serverAck() {
    if (!this.pending) return null;
    const next = this.buffer;
    this.pending = next;
    this.buffer = null;
    return next;
  }

  // Called when a remote op arrives
  applyServer(remoteOp) {
    // remoteOp is a TextOperation instance
    if (!this.pending) {
      return remoteOp;
    }

    if (!this.buffer) {
      const [newPending, transformedRemote] = TextOperation.transform(this.pending, remoteOp);
      this.pending = newPending;
      return transformedRemote;
    }

    // pending & buffer exist
    const [p2, r2] = TextOperation.transform(this.pending, remoteOp);
    const [b2, r3] = TextOperation.transform(this.buffer, r2);
    this.pending = p2;
    this.buffer = b2;
    return r3;
  }
}

/* =========================
   React CodeEditor component
   ========================= */
const CodeEditor = () => {
  const [code, setCode] = useState("");
  const prev = useRef(code);
  const clientId = useRef(`client-${Math.random().toString(36).substr(2, 9)}`);
  const sessionId = "session1";
  const documentId = "docA";

  const revision = useRef(0);
  const stompClient = useRef(null);
  const [connected, setConnected] = useState(false);
  const editorRef = useRef(null);
  const [remoteBadges, setRemoteBadges] = useState([]);
  const BADGE_TIMEOUT_MS = 200;
  const cursors = useRef({});
  const ot = useRef(new OTClient());

  if (typeof window.global === "undefined") window.global = window;
  const getDisplayName = (payload) => payload?.name || payload?.username || payload?.clientId || "User";

  useEffect(() => {
    const initAndConnect = async () => {
      // INIT: fetch latest doc + revision
      try {
        const res = await fetch(
          `http://192.168.1.52:8080/ot/init?sessionId=${sessionId}&documentId=${documentId}`
        );
        if (!res.ok) throw new Error("Init fetch failed: " + res.statusText);
        const data = await res.json();
        console.log("INIT RESPONSE:", data);

        prev.current = data.content ?? "";
        revision.current = data.revision ?? 0;
        setCode(prev.current);
        requestAnimationFrame(() => setCursorIndex(prev.current.length));
      } catch (err) {
        console.error("INIT failed:", err);
        // continue to connect STOMP anyway (you may want a retry)
      }

      // STOMP connect
      try {
        const sockMod = await import("sockjs-client");
        SockJS = sockMod.default;
        const socket = new SockJS("http://192.168.1.52:8080/ws");
        const client = new Client({
          webSocketFactory: () => socket,
          reconnectDelay: 500,
          debug: (str) => console.log(str),

          onConnect: () => {
            console.log("STOMP Connected");
            setConnected(true);

            // remote operations
            client.subscribe("/topic/sessions", (message) => {
              const payload = JSON.parse(message.body);
              if (payload.clientId === clientId.current) return;

              // Build remote operation
              const remoteOp = TextOperation.fromJSON(payload.operation || []);
              // If server provides base/target, trust them (optional)
              if (typeof payload.baseLength === "number") remoteOp.baseLength = payload.baseLength;
              if (typeof payload.targetLength === "number") remoteOp.targetLength = payload.targetLength;

              // Save cursor before applying
              const localCursorBefore = getCursorIndex();

              // Transform remote op against pending/buffer
              const opToApply = ot.current.applyServer(remoteOp);

              // Transform cursor
              const newLocalCursor = transformCursor(localCursorBefore, opToApply.ops);

              // Apply transformed op to document
              const newCode = opToApply.apply(prev.current);
              prev.current = newCode;
              setCode(newCode);

              // Restore cursor
              requestAnimationFrame(() => setCursorIndex(newLocalCursor));

              // show remote badge
              if (payload.cursorPosition) pushRemoteBadge(payload.clientId, payload.cursorPosition, payload);

              revision.current += 1;
            });

            // ack handler
            client.subscribe(`/topic/ack/${clientId.current}`, (message) => {
              console.log("ACK received");
              revision.current += 1;
              const nextBufferedOp = ot.current.serverAck();
              if (nextBufferedOp) {
                const cursorIndex = getCursorIndex();
                const { row, col } = indexToRowCol(prev.current, cursorIndex);
                sendOperation(nextBufferedOp, { row, col });
              }
            });
          },

          onDisconnect: () => {
            console.log("STOMP Disconnected");
            setConnected(false);
          },
          onStompError: (frame) => {
            console.error("STOMP Error:", frame);
          },
        });

        client.activate();
        stompClient.current = client;
      } catch (err) {
        console.error("Failed to connect STOMP:", err);
      }
    };

    initAndConnect();
    return () => {
      if (stompClient.current) stompClient.current.deactivate();
    };
  }, []);

  function pushRemoteBadge(clientIdFromPayload, cursorPosition, payload = {}) {
    const id = `${clientIdFromPayload}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const name = getDisplayName(payload) || clientIdFromPayload;
    const badge = { id, clientId: clientIdFromPayload, name, row: cursorPosition?.row ?? 1, col: cursorPosition?.col ?? 1 };
    setRemoteBadges((prev) => [...prev, badge]);
    setTimeout(() => setRemoteBadges((prev) => prev.filter((b) => b.id !== id)), BADGE_TIMEOUT_MS);
  }

  const sendOperation = (operation, cursorPos) => {
    if (!stompClient.current || !stompClient.current.connected) {
      console.warn("STOMP not connected yet");
      return;
    }
    const payload = {
      clientId: clientId.current,
      documentId,
      sessionId,
      revision: revision.current,
      operation: operation.toJSON ? operation.toJSON() : operation.ops,
      baseLength: operation.baseLength,
      targetLength: operation.targetLength,
      cursorPosition: cursorPos,
    };

    console.log("Sending:", payload);
    stompClient.current.publish({ destination: "/app/operation", body: JSON.stringify(payload) });
  };

  const handleChange = (newCode) => {
    // Generate operation relative to current prev.current
    const op = generateOp(prev.current, newCode);

    // Let OT client decide to send or buffer
    const toSend = ot.current.applyClient(op);

    // Update the local document immediately (optimistic)
    prev.current = newCode;
    setCode(newCode);

    // Compute cursor pos to send
    const textarea = editorRef.current?.querySelector("textarea");
    const index = textarea?.selectionStart ?? newCode.length;
    const { row, col } = indexToRowCol(newCode, index);

    if (toSend) {
      sendOperation(toSend, { row, col });
    }
    // otherwise op is buffered and will be sent when ACK arrives
  };

  function indexToRowCol(text, index) {
    const lines = text.slice(0, index).split("\n");
    const row = lines.length;
    const col = lines[lines.length - 1].length + 1;
    return { row, col };
  }

  function getCursorIndex() {
    const textarea = editorRef.current?.querySelector("textarea");
    return textarea ? textarea.selectionStart : 0;
  }

  function setCursorIndex(i) {
    const ta = editorRef.current?.querySelector("textarea");
    if (!ta) return;
    const pos = Math.max(0, Math.min(i, ta.value?.length ?? 0));
    ta.focus();
    requestAnimationFrame(() => {
      try {
        ta.setSelectionRange(pos, pos);
        const rect = ta.getBoundingClientRect();
        if (rect) ta.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch (err) {
        ta.selectionStart = ta.selectionEnd = pos;
      }
    });
  }

  return (
    <div style={{ padding: "20px", background: "#0d1117", minHeight: "100vh" }}>
      <div style={{ marginBottom: "10px", color: "#fff", display: "flex", alignItems: "center", gap: "10px" }}>
        <span style={{ display: "inline-block", width: "10px", height: "10px", borderRadius: "50%", background: connected ? "#00ff00" : "#ff0000" }} />
        <span>{connected ? "Connected" : "Disconnected"} | Client: {clientId.current}</span>
      </div>

      <div style={{ position: "relative", background: "#1e1e1e", borderRadius: "10px", padding: "10px", border: "1px solid #333", maxWidth: "800px" }} ref={editorRef}>
        <Editor
          value={code}
          onValueChange={handleChange}
          highlight={(code) => Prism.highlight(code, Prism.languages.java, "java")}
          padding={12}
          style={{ fontFamily: "monospace", fontSize: 14, minHeight: 250, outline: "none", color: "#fff" }}
        />

        <div style={{ position: "absolute", right: 8, top: 8, display: "flex", flexDirection: "column", gap: 6, pointerEvents: "none", zIndex: 50 }}>
          {remoteBadges.map((b) => (
            <div key={b.id} style={{ background: "rgba(0,0,0,0.7)", color: "white", padding: "6px 8px", borderRadius: 6, fontSize: 12, fontFamily: "monospace", boxShadow: "0 2px 6px rgba(0,0,0,0.5)", opacity: 1, transform: "translateY(0)", transition: "opacity 120ms ease", whiteSpace: "nowrap" }}>
              <strong style={{ marginRight: 8 }}>{b.name}</strong>
              <span style={{ opacity: 0.9 }}>Ln {b.row}, Col {b.col}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;
