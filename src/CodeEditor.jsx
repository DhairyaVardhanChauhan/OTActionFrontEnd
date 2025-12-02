import React, { useState, useEffect, useRef } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";

import { Client } from "@stomp/stompjs";

import "prismjs/components/prism-java";
import "prismjs/themes/prism-tomorrow.css";

// ========================================================
// OPERATIONAL TRANSFORMATION UTILITIES
// ========================================================

let SockJS = null;
class TextOperation {
  constructor() {
    this.ops = [];
    this.baseLength = 0;
    this.targetLength = 0;
  }
  retain(n) {
    if (n > 0) {
      this.ops.push(n);
      this.baseLength += n;
      this.targetLength += n;
    }
    return this;
  }
  insert(str) {
    // l -> lo
    if (typeof str === "string" && str.length > 0) {
      this.ops.push(str);
      this.targetLength += str.length;
    }
    return this;
  }
  delete(n) {
    if (n > 0) {
      this.ops.push(-n);
      this.baseLength += n;
    }
    return this;
  }
}

function generateOp(oldText, newText) {
  const op = new TextOperation();
  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText[start] === newText[start]
  ) {
    start++;
  }

  let oldEnd = oldText.length - 1;
  let newEnd = newText.length - 1;

  while (
    oldEnd >= start &&
    newEnd >= start &&
    oldText[oldEnd] === newText[newEnd]
  ) {
    oldEnd--;
    newEnd--;
  }

  const retainLen = start;
  const deleteLen = oldEnd - start + 1;
  const insertStr = newText.slice(start, newEnd + 1);
  const retainTail = oldText.length - (oldEnd + 1);
  op.retain(retainLen);
  if (deleteLen > 0) op.delete(deleteLen);
  if (insertStr.length > 0) op.insert(insertStr);
  op.retain(retainTail);
  return op;
}
function applyOp(text, ops) {
  let newText = "";
  let index = 0;
  for (const op of ops) {
    if (typeof op === "number") {
      if (op > 0) {
        newText += text.slice(index, index + op);
        index += op;
      } else if (op < 0) {
        index += -op;
      }
    } else {
      newText += op;
    }
  }
  return newText;
}

function transformCursor(index, ops) {
  let cursor = index;
  let pos = 0;

  for (const op of ops) {
    if (typeof op === "number") {
      if (op > 0) {
        // retain
        pos += op;
      } else if (op < 0) {
        // delete
        const length = -op;
        if (cursor > pos && cursor <= pos + length) {
          cursor = pos; // cursor was inside deleted block
        } else if (cursor > pos + length) {
          cursor -= length;
        }
        pos += length;
      }
    } else {
      const length = op.length;
      if (cursor >= pos) {
        cursor += length;
      }
      pos += length;
    }
  }
  return cursor;
}


const OTUtils = {
  // Apply transform(opA, opB) meaning:
  // “How opA should change if opB happened first”
  transform(a, b) {
    const aOps = a.ops;
    const bOps = b.ops;

    const aPrime = new TextOperation();
    const bPrime = new TextOperation();

    let i = 0, j = 0;
    let ai, bj;

    while ((ai = aOps[i]) !== undefined || (bj = bOps[j]) !== undefined) {

      // INSERT vs INSERT
      if (typeof bj === "string") {
        bPrime.insert(bj);
        aPrime.retain(bj.length);
        j++;
        continue;
      }

      if (typeof ai === "string") {
        aPrime.insert(ai);
        bPrime.retain(ai.length);
        i++;
        continue;
      }

      // RETAIN vs RETAIN
      if (typeof ai === "number" && ai > 0 && typeof bj === "number" && bj > 0) {
        const min = Math.min(ai, bj);
        aPrime.retain(min);
        bPrime.retain(min);
        aOps[i] -= min;
        bOps[j] -= min;
        if (aOps[i] === 0) i++;
        if (bOps[j] === 0) j++;
        continue;
      }

      // DELETE in a vs RETAIN in b
      if (typeof ai === "number" && ai < 0 && typeof bj === "number" && bj > 0) {
        const del = -ai;
        const min = Math.min(del, bj);
        aPrime.delete(min);
        bj -= min;
        ai += min;
        if (bj === 0) j++;
        if (ai === 0) i++;
        continue;
      }

      // RETAIN in a vs DELETE in b
      if (typeof ai === "number" && ai > 0 && typeof bj === "number" && bj < 0) {
        const del = -bj;
        const min = Math.min(ai, del);
        // a skips deleted text
        ai -= min;
        bj += min;
        if (ai === 0) i++;
        if (bj === 0) j++;
        continue;
      }

      // DELETE vs DELETE
      if (typeof ai === "number" && ai < 0 && typeof bj === "number" && bj < 0) {
        const min = Math.min(-ai, -bj);
        ai += min;
        bj += min;
        if (ai === 0) i++;
        if (bj === 0) j++;
        continue;
      }

      console.log("Unhandled transform case!", ai, bj);
      i++; j++;
    }

    return [aPrime, bPrime];
  },

  compose(a, b) {
    const newText = applyOp(applyOp("", a.ops), b.ops);
    return generateOp("", newText);
  }
};


class OTClient {
  constructor() {
    this.pending = null;
    this.buffer = null;
  }

  applyClient(op) {
    if (!this.pending) {
      this.pending = op;
      return op; // send immediately
    }
    // We have a pending op, buffer this new local op
    this.buffer = this.buffer ? OTUtils.compose(this.buffer, op) : op;
    return null;
  }

  serverAck() {
    if (!this.pending) return null;
    const next = this.buffer;
    this.pending = next;
    this.buffer = null;
    return next;
  }

  applyServer(remoteOp) {
    if (!this.pending) {
      return remoteOp; // apply directly
    }

    if (!this.buffer) {
      const [newPending, transformedRemote] = OTUtils.transform(
        this.pending,
        remoteOp
      );
      this.pending = newPending;
      return transformedRemote;
    }

    let [p2, r2] = OTUtils.transform(this.pending, remoteOp);
    let [b2, r3] = OTUtils.transform(this.buffer, r2);
    this.pending = p2;
    this.buffer = b2;
    return r3;
  }
}


const CodeEditor = () => {
  // ========================================================
  // MAIN COMPONENT
  // ========================================================

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

  // -----------------------------------------------------
  // CONNECT TO SPRING BOOT + STOMP
  // -----------------------------------------------------
  if (typeof window.global === "undefined") {
    window.global = window;
  }
  const getDisplayName = (payload) =>
    payload?.name || payload?.username || payload?.clientId || "User";

  const [userColors, setUserColors] = useState({});

  useEffect(() => {
    console.log("Connecting to STOMP server...");

    import("sockjs-client")
      .then((module) => {
        SockJS = module.default;
        const socket = new SockJS("http://192.168.1.52:8080/ws");

        const client = new Client({
          webSocketFactory: () => socket,
          reconnectDelay: 500,
          debug: (str) => console.log(str),

          onConnect: () => {
            console.log("STOMP Connected");
            setConnected(true);

            // ===========================
            // REMOTE OPERATIONS HANDLER
            // ===========================
            client.subscribe("/topic/sessions", (message) => {
              const payload = JSON.parse(message.body);

              // Ignore our own ops (server will ACK those)
              if (payload.clientId === clientId.current) return;

              console.log("Remote operation received:", payload);

              // Step 1 — convert to TextOperation object
              const remoteOp = new TextOperation();
              remoteOp.ops = payload.operation;

              // Step 2 — save local cursor BEFORE applying remote op
              const localCursorBefore = getCursorIndex();

              // Step 3 — transform remote op against any pending or buffered ops
              const opToApply = ot.current.applyServer(remoteOp);

              // Step 4 — transform local cursor based on transformed remote op
              const newLocalCursor = transformCursor(
                localCursorBefore,
                opToApply.ops
              );

              // Step 5 — apply transformed op to our local document
              const newCode = applyOp(prev.current, opToApply.ops);
              prev.current = newCode;
              setCode(newCode);

              // Step 6 — restore local cursor AFTER DOM updates
              requestAnimationFrame(() => setCursorIndex(newLocalCursor));

              // Step 7 — show ephemeral remote user badge
              if (payload.cursorPosition) {
                pushRemoteBadge(
                  payload.clientId,
                  payload.cursorPosition,
                  payload
                );
              }

              revision.current += 1;
            });

            // ===========================
            // ACK HANDLER
            // ===========================
            client.subscribe(`/topic/ack/${clientId.current}`, () => {
              console.log("ACK received");

              // Process pending op
              const nextBufferedOp = ot.current.serverAck();

              // If buffer exists, send it
              if (nextBufferedOp) {
                const cursorIndex = getCursorIndex();
                const { row, col } = indexToRowCol(prev.current, cursorIndex);

                sendOperation(nextBufferedOp, { row, col });
              }

              revision.current += 1;
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
      })
      .catch((error) => console.error("Error loading SockJS:", error));

    return () => {
      if (stompClient.current) {
        console.log("Deactivating STOMP...");
        stompClient.current.deactivate();
      }
    };
  }, []);

  const pushRemoteBadge = (
    clientIdFromPayload,
    cursorPosition,
    payload = {}
  ) => {
    const id = `${clientIdFromPayload}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 6)}`;
    const name = getDisplayName(payload) || clientIdFromPayload;
    const badge = {
      id,
      clientId: clientIdFromPayload,
      name,
      row: cursorPosition?.row ?? 1,
      col: cursorPosition?.col ?? 1,
    };
    console.log("Pushing remote badge:", badge);
    // show badge
    setRemoteBadges((prev) => [...prev, badge]);

    // remove after timeout
    setTimeout(() => {
      setRemoteBadges((prev) => prev.filter((b) => b.id !== id));
    }, BADGE_TIMEOUT_MS);
  };

  // -----------------------------------------------------
  // SEND OT OPERATION
  // -----------------------------------------------------
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
      operation: operation.ops,
      cursorPosition: cursorPos,
    };

    console.log("Sending:", payload);

    stompClient.current.publish({
      destination: "/app/operation",
      body: JSON.stringify(payload),
    });
  };

  const handleChange = (newCode) => {
    const op = generateOp(prev.current, newCode);

    const textarea = editorRef.current?.querySelector("textarea");
    const index = textarea?.selectionStart ?? newCode.length;
    const { row, col } = indexToRowCol(newCode, index);

    const toSend = ot.current.applyClient(op);
    if (toSend) {
      sendOperation(toSend, { row, col });
    }

    prev.current = newCode;
    setCode(newCode);
  };

  function indexToRowCol(text, index) {
    const lines = text.slice(0, index).split("\n");
    console.log("text:", text, "index:", index, "lines", lines);
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

    // clamp position to valid range
    const pos = Math.max(0, Math.min(i, ta.value?.length ?? 0));

    // ensure the textarea has focus before setting selection
    ta.focus();

    // use requestAnimationFrame to wait for paint / DOM updates (more reliable than setTimeout 0)
    requestAnimationFrame(() => {
      try {
        // setSelectionRange is the most robust way to place caret
        ta.setSelectionRange(pos, pos);
        // optional: scroll caret into view
        const rect = ta.getBoundingClientRect();
        if (rect) ta.scrollIntoView({ block: "nearest", inline: "nearest" });
      } catch (err) {
        // fallback
        ta.selectionStart = ta.selectionEnd = pos;
      }
    });
  }

  return (
    <div style={{ padding: "20px", background: "#0d1117", minHeight: "100vh" }}>
      <div
        style={{
          marginBottom: "10px",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          gap: "10px",
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: connected ? "#00ff00" : "#ff0000",
          }}
        />
        <span>
          {connected ? "Connected" : "Disconnected"} | Client:{" "}
          {clientId.current}
        </span>
      </div>

      <div
        style={{
          position: "relative",
          background: "#1e1e1e",
          borderRadius: "10px",
          padding: "10px",
          border: "1px solid #333",
          maxWidth: "800px",
        }}
        ref={editorRef}
      >
        <Editor
          value={code}
          onValueChange={handleChange}
          highlight={(code) =>
            Prism.highlight(code, Prism.languages.java, "java")
          }
          padding={12}
          style={{
            fontFamily: "monospace",
            fontSize: 14,
            minHeight: 250,
            outline: "none",
            color: "#fff",
          }}
        />

        {/* transient remote-cursor badges (top-right stack) */}
        <div
          style={{
            position: "absolute",
            right: 8,
            top: 8,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            pointerEvents: "none", // don't interfere with editor
            zIndex: 50,
          }}
        >
          {remoteBadges.map((b) => (
            <div
              key={b.id}
              style={{
                background: "rgba(0,0,0,0.7)",
                color: "white",
                padding: "6px 8px",
                borderRadius: 6,
                fontSize: 12,
                fontFamily: "monospace",
                boxShadow: "0 2px 6px rgba(0,0,0,0.5)",
                opacity: 1,
                transform: "translateY(0)",
                transition: "opacity 120ms ease",
                whiteSpace: "nowrap",
              }}
            >
              <strong style={{ marginRight: 8 }}>{b.name}</strong>
              <span style={{ opacity: 0.9 }}>
                Ln {b.row}, Col {b.col}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default CodeEditor;
