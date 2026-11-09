// src/components/ui/CommandPalette.jsx
//
// The header said `components/modals/` until Task 21. That directory was empty
// and is now gone; this file has always lived in `ui/`.
import React, { useState, useRef, useEffect, useMemo } from "react";
import { Search, ArrowRight } from "lucide-react";

const CommandPalette = ({ isOpen, onClose, commands }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef(null);
  const filteredCommands = useMemo(() => commands.filter(cmd => cmd.label.toLowerCase().includes(query.toLowerCase())), [commands, query]);
  useEffect(() => { if (isOpen) { setTimeout(() => inputRef.current?.focus(), 50); setQuery(''); setActiveIndex(0); } }, [isOpen]);
  return !isOpen ? null : (
    <div className="fixed inset-0 z-[110] flex items-start justify-center pt-[15vh] px-4">
      <div className="absolute inset-0 bg-[#020617]/80 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-full max-w-lg bg-[#0f172a] border border-white/10 rounded-2xl shadow-2xl overflow-hidden animate-scale-up">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/5">
          <Search className="w-5 h-5 text-slate-500" />
          <input ref={inputRef} type="text" placeholder="Type a command..." value={query} onChange={e => { setQuery(e.target.value); setActiveIndex(0); }} className="flex-1 bg-transparent border-none outline-none text-white placeholder-slate-500 text-base" />
          <span className="text-[10px] font-mono text-slate-500 border border-white/10 px-1.5 py-0.5 rounded">ESC</span>
        </div>
        <div className="py-2 max-h-[300px] overflow-y-auto">
          {filteredCommands.length === 0 ? <div className="px-4 py-8 text-center text-slate-500 text-sm">No commands found.</div> : filteredCommands.map((cmd, idx) => (
            <button key={cmd.id} onClick={() => { cmd.action(); onClose(); }} className={`w-full text-left px-4 py-3 flex items-center gap-3 transition-colors ${idx === activeIndex ? 'bg-indigo-600/10 border-l-2 border-indigo-500' : 'hover:bg-white/5 border-l-2 border-transparent'}`} onMouseEnter={() => setActiveIndex(idx)}>
              <div className={`p-2 rounded-lg ${idx === activeIndex ? 'bg-indigo-600 text-white' : 'bg-white/5 text-slate-400'}`}>{React.createElement(cmd.icon, { size: 16 })}</div>
              <span className={`text-sm ${idx === activeIndex ? 'text-white font-bold' : 'text-slate-300'}`}>{cmd.label}</span>
              {idx === activeIndex && <ArrowRight className="ml-auto w-4 h-4 text-indigo-400" />}
            </button>
          ))}
        </div>
        <div className="px-4 py-2 bg-white/[0.02] border-t border-white/5 flex justify-between items-center text-[10px] text-slate-500 font-mono"><span>TrustFlow Command Line</span><span>v3.5</span></div>
      </div>
    </div>
  );
};

export default CommandPalette;
