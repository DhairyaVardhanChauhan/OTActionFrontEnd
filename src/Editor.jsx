import React, { useState, useRef, useEffect } from "react";
import Editor from "react-simple-code-editor";
import Prism from "prismjs";

import { Client } from "@stomp/stompjs";

import "prismjs/components/prism-java";
import "prismjs/themes/prism-tomorrow.css";

// Lazy load SockJS after setting up global
let SockJS = null;

// ------------------------------------------------------------
// OT OPERATION CLASS
// ------------------------------------------------------------
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
    if (str.length > 0) {
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

// Apply operation to text
function applyOp(text, ops) {
  let result = "";
  let index = 0;

  for (const op of ops) {
    if (typeof op === "number") {
      if (op > 0) {
        // Retain
        result += text.slice(index, index + op);
        index += op;
      } else {
        // Delete
        index += Math.abs(op);
      }
    } else {
      // Insert
      result += op;
    }
  }

  return result;
}

// ========================================================
// MAIN COMPONENT
// ========================================================
const JavaEditor = () => {
  const [code, setCode] = useState(`public class Main {
    public static void main(String[] args) {
        System.out.println("Hello!");
    }
}`);
  const prev = useRef(code);

  const clientId = useRef(`client-${Math.random().toString(36).substr(2, 9)}`);
  const sessionId = "session1";
  const documentId = "docA";

  const revision = useRef(0);
  const stompClient = useRef(null);
  const [connected, setConnected] = useState(false);

  // -----------------------------------------------------
  // CONNECT TO SPRING BOOT + STOMP
  // -----------------------------------------------------
  useEffect(() => {
    // Set up global polyfill before loading SockJS
    if (typeof window.global === "undefined") {
      window.global = window;
    }

    // Dynamically import SockJS after polyfill is set
    import("sockjs-client")
      .then((module) => {
        SockJS = module.default;

        const socket = new SockJS("http://localhost:8080/ws");

        const client = new Client({
          webSocketFactory: () => socket,
          reconnectDelay: 500,
          debug: (str) => console.log(str),

          onConnect: () => {
            console.log("✅ STOMP Connected");
            setConnected(true);

            // Receive transformed ops from other clients
            client.subscribe("/topic/sessions", (msg) => {
              const payload = JSON.parse(msg.body);

              if (payload.clientId !== clientId.current) {
                console.log("📥 Remote OP:", payload.operation);

                // Apply remote operation
                setCode((currentCode) => {
                  const newCode = applyOp(currentCode, payload.operation);
                  prev.current = newCode;
                  return newCode;
                });
              }
            });

            // Receive ACK for our operations
            client.subscribe(`/topic/ack/${clientId.current}`, () => {
              console.log("✅ ACK received");
              revision.current += 1;
            });
          },

          onDisconnect: () => {
            console.log("❌ STOMP Disconnected");
            setConnected(false);
          },

          onStompError: (frame) => {
            console.error("❌ STOMP Error:", frame);
          },
        });

        client.activate();
        stompClient.current = client;
      })
      .catch((err) => {
        console.error("Failed to load SockJS:", err);
      });

    return () => {
      if (stompClient.current) {
        stompClient.current.deactivate();
      }
    };
  }, []);

  // -----------------------------------------------------
  // SEND OT OPERATION
  // -----------------------------------------------------
  const sendOperation = (operation) => {
    if (!stompClient.current || !stompClient.current.connected) {
      console.warn("⚠️ STOMP not connected yet");
      return;
    }

    const payload = {
      clientId: clientId.current,
      documentId,
      sessionId,
      revision: revision.current,
      operation: operation.ops,
      cursorPosition: {
        line: 0,
        column: 0,
      },
    };

    console.log("📤 Sending:", payload);

    stompClient.current.publish({
      destination: "/app/operation",
      body: JSON.stringify(payload),
    });
  };

  // -----------------------------------------------------
  // HANDLE LOCAL EDITS
  // -----------------------------------------------------
  const handleChange = (newValue) => {
    const oldValue = prev.current;

    const op = generateOp(oldValue, newValue);
    console.log("✏️ Generated OT op:", op.ops);

    sendOperation(op);

    setCode(newValue);
    prev.current = newValue;
  };

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
          background: "#1e1e1e",
          borderRadius: "10px",
          padding: "10px",
          border: "1px solid #333",
          maxWidth: "800px",
        }}
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
      </div>
    </div>
  );
};

export default JavaEditor;
