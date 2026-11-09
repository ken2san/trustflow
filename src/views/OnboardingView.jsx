import { useState } from "react";
import { Scale, FileText, ShieldCheck, ArrowRight } from "lucide-react";

const slides = [
  {
    icon: Scale,
    headline: "You've been there.",
    body: "Great work. Wrong expectations. No recourse.\nScope disputes are the #1 reason freelance relationships break down — and why good professionals don't get paid what they're owed.",
  },
  {
    icon: FileText,
    headline: "Every agreement, enforceable.",
    body: "Your project description becomes a clear Definition of Done, and both sides accept that same text before any work starts. What was agreed is hashed into the record at the moment of acceptance, so neither side can revise it later.",
  },
  {
    icon: ShieldCheck,
    headline: "The record is the protection.",
    // THIS SLIDE USED TO SAY "Funds are held in escrow." It is the first screen
    // a new visitor sees, and it was describing a product that does not exist:
    // TrustFlow has never held, moved, captured or refunded money, and
    // Decisions.md (2026-11-06) records that as the owner's decision rather
    // than a gap. It also promised that "every message is evidence" — there is
    // no messaging — and that "disputes are resolved with data", when nothing
    // resolves a dispute. Three false claims about money and recourse, on the
    // one screen nobody can skip. Replaced with what the service does do, in
    // the same shape and roughly the same length.
    body: "Money moves between you two, however you arrange it — TrustFlow never holds it. What it keeps is the record: who agreed to what, who said they delivered, who said they paid, each with the server's own timestamp and in an order nobody can edit afterwards.",
  },
];

const OnboardingView = ({ onComplete }) => {
  const [slide, setSlide] = useState(0);
  const isLast = slide === slides.length - 1;
  const { icon: Icon, headline, body } = slides[slide];

  return (
    <div className="fixed inset-0 z-[200] bg-[#020617] flex flex-col items-center justify-center px-6 animate-fade-in-up">
      <div className="max-w-lg w-full text-center space-y-10">
        <div className="w-24 h-24 mx-auto bg-indigo-500/10 border border-indigo-500/20 rounded-[32px] flex items-center justify-center">
          <Icon className="w-12 h-12 text-indigo-400" />
        </div>
        <div className="space-y-4">
          <h1 className="text-4xl sm:text-5xl font-black text-white tracking-tighter">{headline}</h1>
          <p className="text-slate-400 text-lg leading-relaxed whitespace-pre-line">{body}</p>
        </div>
        <div className="flex justify-center gap-2">
          {slides.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${i === slide ? "bg-indigo-500 w-8" : "bg-slate-700 w-2"}`}
            />
          ))}
        </div>
        <button
          onClick={() => (isLast ? onComplete() : setSlide((s) => s + 1))}
          className="w-full py-5 bg-white text-[#020617] rounded-[24px] font-black text-lg flex items-center justify-center gap-3 hover:bg-indigo-400 hover:text-white transition-all shadow-2xl"
        >
          {isLast ? "Start protecting my work" : "Next"}
          <ArrowRight className="w-5 h-5" />
        </button>
        {!isLast && (
          <button
            onClick={onComplete}
            className="text-xs text-slate-600 hover:text-slate-400 transition-colors uppercase tracking-widest font-bold"
          >
            Skip intro
          </button>
        )}
      </div>
    </div>
  );
};

export default OnboardingView;
