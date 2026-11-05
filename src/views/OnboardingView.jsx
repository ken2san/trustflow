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
    body: "We convert your project description into a clear Definition of Done before any money moves. Both sides agree to the same truth — in writing, on the record.",
  },
  {
    icon: ShieldCheck,
    headline: "Protection is the default.",
    body: "Funds are held in escrow. Every message is evidence. Disputes are resolved with data, not drama. TrustFlow makes fairness automatic.",
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
