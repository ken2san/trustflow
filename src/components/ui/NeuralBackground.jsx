import React from "react";

const NeuralBackground = React.memo(() => (
  <div className="fixed inset-0 z-0 pointer-events-none overflow-hidden">
    <div className="absolute top-[-20%] left-[-10%] w-[70%] h-[70%] bg-indigo-900/20 rounded-full blur-[120px] animate-pulse mix-blend-screen" />
    <div className="absolute bottom-[-10%] right-[-10%] w-[60%] h-[60%] bg-violet-900/10 rounded-full blur-[120px] mix-blend-screen" />
  </div>
));

export default NeuralBackground;
