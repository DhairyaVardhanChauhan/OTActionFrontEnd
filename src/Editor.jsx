/***********************************************************************
 * Complete Multi-User Collaborative Editor
 * With:
 *  - Operational Transformation (OT)
 *  - Cursor Transformation
 *  - Multi-user colored cursors
 *  - Correct row/col tracking
 *  - No cursor jumping
 *  - SockJS fix for Vite
 ***********************************************************************/

import React, { useState, useEffect, useRef } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";
import { Client } from "@stomp/stompjs";

import "prismjs/components/prism-java";
import "prismjs/themes/prism-tomorrow.css";

// ---- FIX Vite global issue ----
window.global = window;

// ---- SockJS Import ----
import SockJS from "sockjs-client";

if (typeof window.global === "undefined") {
  window.global = window;
}

/******************************
 * OT Operation Class
 ******************************/
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



/******************************
 * Generate a minimal OT patch
 ******************************/
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

  op.retain(retainLen);
  if (deleteLen > 0) op.delete(deleteLen);
  if (insertStr.length > 0) op.insert(insertStr);
  op.retain(oldText.length - (oldEnd + 1));

  return op;
}



/******************************
 * Apply OT to string
 ******************************/
function applyOp(text, ops) {
  let newText = "";
  let index = 0;

  for (const op of ops) {
    if (typeof op === "number") {
      if (op > 0) {
        newText += text.slice(index, index + op);
        index += op;
      } else {
        index += -op;
      }
    } else {
      newText += op;
    }
  }

  return newText;
}



/******************************
 * Transform cursor based on OT
 ******************************/
function transformCursorPosition(index, operation) {
  let newIndex = index;
  let pos = 0;

  for (const op of operation.ops) {
    if (typeof op === "number") {
      if (op > 0) {
        pos += op; // retain
      } else {
        const delLen = -op;
        if (newIndex > pos && newIndex <= pos + delLen) {
          newIndex = pos;
        } else if (newIndex > pos + delLen) {
          newIndex -= delLen;
        }
        pos += delLen;
      }
    } else {
      const insLen = op.length;
      if (newIndex >= pos) {
        newIndex += insLen;
      }
      pos += insLen;
    }
  }

  return newIndex;
}



/******************************
 * Index <-> Row/Col conversions
 ******************************/
function rowColToIndex(text, row, col) {
  const lines = text.split("\n");
  let index = 0;

  for (let i = 0; i < row - 1; i++) {
    index += lines[i].length + 1;
  }

  return index + (col - 1);
}

function indexToRowCol(text, index) {
  const lines = text.slice(0, index).split("\n");
  return {
    row: lines.length,
    col: lines[lines.length - 1].length + 1,
  };
}



/******************************
 * Pixel Position of Cursor
 ******************************/
function getCursorXY(editorEl, row, col) {
  const pre = editorEl.querySelector("pre");
  if (!pre) return { x: 0, y: 0, lineHeight: 20 };

  const lines = pre.innerText.split("\n");
  const lineText = lines[row - 1] ?? "";
  const beforeText = lineText.slice(0, col - 1);

  const temp = document.createElement("span");
  temp.style.visibility = "hidden";
  temp.style.whiteSpace = "pre";
  temp.style.font = getComputedStyle(pre).font;
  temp.textContent = beforeText === "" ? " " : beforeText;

  pre.appendChild(temp);
  const width = temp.offsetWidth;
  pre.removeChild(temp);

  const lineHeight = parseFloat(getComputedStyle(pre).lineHeight || "20");
  const yOffset = (row - 1) * lineHeight;

  const editorRect = editorEl.getBoundingClientRect();
  const preRect = pre.getBoundingClientRect();

  const scrollTop = editorEl.scrollTop;
  const scrollLeft = editorEl.scrollLeft;

  const x = preRect.left - editorRect.left + width - scrollLeft;
  const y = preRect.top - editorRect.top + yOffset - scrollTop;

  return { x, y, lineHeight };
}



/******************************
 * Remote Cursor Overlay
 ******************************/
const RemoteCursorOverlay = ({ editorRef, remoteCursors, userColors }) => {
  const [positions, setPositions] = useState({});

  useEffect(() => {
    const el = editorRef.current;
    if (!el) return;

    const newPositions = {};
    Object.keys(remoteCursors).forEach((cid) => {
      const cur = remoteCursors[cid];
      const pos = getCursorXY(el, cur.row, cur.col);
      newPositions[cid] = pos;
    });

    setPositions(newPositions);
  }, [remoteCursors]);

  return (
    <>
      {Object.keys(remoteCursors).map((cid) => {
        const cur = remoteCursors[cid];
        const pos = positions[cid];
        if (!pos) return null;

        const color = userColors[cid];

        return (
          <div key={cid} style={{ pointerEvents: "none", position: "absolute" }}>
            {/* caret */}
            <div
              style={{
                position: "absolute",
                left: pos.x,
                top: pos.y,
                width: 2,
                height: pos.lineHeight,
                background: color,
                zIndex: 99,
              }}
            />
            {/* name tag */}
            <div
              style={{
                position: "absolute",
                left: pos.x + 5,
                top: pos.y - 16,
                background: color,
                color: "#000",
                padding: "2px 6px",
                borderRadius: 3,
                fontSize: 11,
                fontWeight: "bold",
                zIndex: 100,
              }}
            >
              {cur.name}
            </div>
          </div>
        );
      })}
    </>
  );
};



/******************************
 * MAIN EDITOR COMPONENT
 ******************************/
const CodeEditor = () => {
  const [code, setCode] = useState("");
  const prev = useRef("");

  const clientId = useRef(`client-${Math.random().toString(36).slice(2, 9)}`);
  const revision = useRef(0);
  const stompClient = useRef(null);

  const [connected, setConnected] = useState(false);
  const editorRef = useRef(null);

  const [remoteCursors, setRemoteCursors] = useState({});
  const [userColors, setUserColors] = useState({});

  const getDisplayName = (p) =>
    p?.name || p?.username || p?.clientId || "User";

  function assignUserColor(cid) {
    if (userColors[cid]) return userColors[cid];

    const palette = ["#ff3860", "#00d1b2", "#ffdd57", "#7fdbff", "#ff7f50", "#c792ea"];
    const color = palette[Math.floor(Math.random() * palette.length)];

    setUserColors((prev) => ({ ...prev, [cid]: color }));
    return color;
  }



  /********************************
   * Connect STOMP + SockJS
   ********************************/
  useEffect(() => {
    const socket = new SockJS("http://localhost:8080/ws");
    const client = new Client({
      webSocketFactory: () => socket,
      reconnectDelay: 300,
      debug: (msg) => console.log(msg),

      onConnect: () => {
        setConnected(true);

        /********************************
         * Receive operations & cursors
         ********************************/
        client.subscribe("/topic/sessions", (message) => {
          let payload;

          try {
            payload = JSON.parse(message.body);
          } catch {
            return;
          }

          if (payload.clientId === clientId.current) return;

          const cid = payload.clientId;

          /********************************
           * Apply remote OT operation
           ********************************/
          if (payload.operation) {
            setCode((current) => {
              const updated = applyOp(current, payload.operation);

              // transform ALL remote cursors
              setRemoteCursors((prevCur) => {
                const newCur = {};

                Object.keys(prevCur).forEach((c) => {
                  const cur = prevCur[c];

                  const oldIndex = rowColToIndex(current, cur.row, cur.col);
                  const newIndex = transformCursorPosition(
                    oldIndex,
                    payload.operation
                  );

                  newCur[c] = {
                    ...cur,
                    ...indexToRowCol(updated, newIndex),
                  };
                });

                return newCur;
              });

              prev.current = updated;
              return updated;
            });
          }

          /********************************
           * Update cursor of THAT client
           ********************************/
          if (payload.cursorPosition) {
            const name = getDisplayName(payload);
            const color = assignUserColor(cid);

            setRemoteCursors((prev) => ({
              ...prev,
              [cid]: {
                row: payload.cursorPosition.row,
                col: payload.cursorPosition.col,
                name,
                color,
              },
            }));
          }
        });

        client.subscribe(`/topic/ack/${clientId.current}`, () => {
          revision.current += 1;
        });
      },

      onDisconnect: () => setConnected(false),
      onStompError: () => setConnected(false),
    });

    client.activate();
    stompClient.current = client;

    return () => client.deactivate();
  }, []);



  /********************************
   * Send OT + cursor
   ********************************/
  const sendOperation = (operation, cursorPos) => {
    if (!stompClient.current || !stompClient.current.connected) return;

    const payload = {
      clientId: clientId.current,
      documentId: "docA",
      sessionId: "session1",
      revision: revision.current,
      operation: operation.ops,
      cursorPosition: cursorPos,
    };

    stompClient.current.publish({
      destination: "/app/operation",
      body: JSON.stringify(payload),
    });
  };



  /********************************
   * Local editing handler
   ********************************/
  const handleChange = (newCode) => {
    const op = generateOp(prev.current, newCode);

    const textarea = editorRef.current.querySelector("textarea");
    const index = textarea?.selectionStart ?? newCode.length;
    const { row, col } = indexToRowCol(newCode, index);

    sendOperation(op, { row, col });

    prev.current = newCode;
    setCode(newCode);
  };



  /********************************
   * Render UI
   ********************************/
  return (
    <div style={{ background: "#0d1117", minHeight: "100vh", padding: 20 }}>
      <div style={{ color: "#fff", marginBottom: 10 }}>
        <span
          style={{
            display: "inline-block",
            width: 10,
            height: 10,
            borderRadius: "50%",
            background: connected ? "#00ff00" : "#ff0000",
            marginRight: 10,
          }}
        />
        {connected ? "Connected" : "Disconnected"} — {clientId.current}
      </div>

      <div
        ref={editorRef}
        style={{
          position: "relative",
          background: "#1e1e1e",
          padding: 10,
          borderRadius: 8,
          border: "1px solid #333",
          maxWidth: 800,
          overflow: "auto",
        }}
      >
        <Editor
          value={code}
          onValueChange={handleChange}
          padding={12}
          highlight={(code) =>
            Prism.highlight(code, Prism.languages.java, "java")
          }
          style={{
            fontFamily: "monospace",
            fontSize: 14,
            outline: "none",
            color: "#fff",
            minHeight: 260,
            whiteSpace: "pre",
          }}
        />

        <RemoteCursorOverlay
          editorRef={editorRef}
          remoteCursors={remoteCursors}
          userColors={userColors}
        />
      </div>
    </div>
  );
};

export default CodeEditor;
