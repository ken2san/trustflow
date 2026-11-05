import { useState, useEffect } from "react";
import useInterval from "../../hooks/useInterval";

const ScrambleText = ({ text, className, trigger }) => {
  const [display, setDisplay] = useState(text);
  const [iteration, setIteration] = useState(0);

  useEffect(() => { setIteration(0); }, [text, trigger]);

  useInterval(() => {
    const textStr = String(text);
    if (iteration >= textStr.length) return;
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    setDisplay(textStr.split('').map((char, index) => index < iteration ? textStr[index] : chars[Math.floor(Math.random() * chars.length)]).join(''));
    setIteration(prev => prev + 1/3);
  }, iteration < String(text).length ? 30 : null);

  return <span className={className}>{display}</span>;
};

export default ScrambleText;
