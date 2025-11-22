import { useState } from "react";
import "./App.css";
import JavaEditor from "./Editor.jsx";

function App() {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#1e1e1e",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "20px",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "800px",
          background: "#2a2a2a",
          borderRadius: "12px",
          padding: "20px",
          boxShadow: "0px 4px 16px rgba(0, 0, 0, 0.4)",
        }}
      >
        <h2
          style={{
            color: "white",
            marginBottom: "15px",
            fontWeight: "600",
            textAlign: "center",
          }}
        >
          Java Code Editor
        </h2>

        <JavaEditor />
      </div>
    </div>
  );
}

export default App;
