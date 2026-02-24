import React, { useState, useRef } from "react";

export default function Component() {
  const canvasRef = useRef(null);
  const [pixelData, setPixelData] = useState([]);

  useEffect(() => {
    const ctx = canvasRef.current.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 500, 500);
  }, []);

  const handleUndo = () => {
    console.log("Undo");
  };

  const handleRedo = () => {
    console.log("Redo");
  };

  const handleClear = () => {
    console.log("Clear");
  };

  const handleCanvasClick = (event) => {
    if (event.type === "mousedown" || event.type === "touchstart") {
      // Handle mouse or touch input
    }
  };

  return (
    <div>
      <canvas id="pixel-art" width={500} height={500} ref={canvasRef} onMouseDown={handleCanvasClick} onTouchStart={handleCanvasClick}></canvas>
      <div className="controls">
        <button onClick={handleUndo}>Undo</button>
        <button onClick={handleRedo}>Redo</button>
        <button onClick={handleClear}>Clear</button>
      </div>
    </div>
  );
}