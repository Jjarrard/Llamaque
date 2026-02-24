import React, { useState, useRef } from 'react';

export default function Component() {
  const canvasRef = useRef(null);
  const [pixelData, setPixelData] = useState([]);

  useEffect(() => {
    const ctx = canvasRef.current.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 500, 500);

    // Add a new event listener for touchstart to the canvasRef.current object in the useEffect hook
    canvasRef.current.addEventListener('touchstart', handleCanvasClick);
    canvasRef.current.addEventListener('mousedown', handleCanvasClick);

    return () => {
      canvasRef.current.removeEventListener('touchstart', handleCanvasClick);
      canvasRef.current.removeEventListener('mousedown', handleCanvasClick);
    };
  }, []);

  const handleUndo = () => {
    console.log('Undo');
  };

  const handleRedo = () => {
    console.log('Redo');
  };

  const handleClear = () => {
    console.log('Clear');
  };

  const handleCanvasClick = (event) => {
    if (event.type === 'mousedown' || event.type === 'touchstart') {
      // Handle mouse or touch input
      const ctx = canvasRef.current.getContext('2d');
      const x = event.clientX - canvasRef.current.offsetLeft;
      const y = event.clientY - canvasRef.current.offsetTop;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x, y, 10, 10);
    }
  };

  return (
    <div>
      <canvas id="pixel-art" width={500} height={500} ref={canvasRef} onMouseDown={handleCanvasClick} onTouchStart={handleCanvasClick} style={{ backgroundColor: '#000' }}></canvas>
      <div className="controls">
        <button onClick={handleUndo}>Undo</button>
        <button onClick={handleRedo}>Redo</button>
        <button onClick={handleClear}>Clear</button>
      </div>
    </div>
  );
}