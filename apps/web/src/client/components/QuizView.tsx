import { useState } from "react";
import { gradeMultipleChoice, type Quiz } from "@mofu/core/web";

interface QuizViewProps {
  quiz: Quiz;
  /** Sends a chat message (short-answer grading, harder/easier). */
  onAsk: (text: string) => void;
  busy: boolean;
}

/** Multiple choice is graded right here; short answers go to Mofu with the model answer. */
export function QuizView({ quiz, onAsk, busy }: QuizViewProps) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [written, setWritten] = useState<Record<number, string>>({});
  const [sent, setSent] = useState<Record<number, boolean>>({});

  const mcq = quiz.questions
    .map((q, i) => ({ q, i }))
    .filter(({ q }) => q.type === "multiple_choice");
  const answered = mcq.filter(({ i }) => picked[i] !== undefined);
  const correct = answered.filter(({ q, i }) => gradeMultipleChoice(q, picked[i]!).correct).length;

  return (
    <section className="quiz" aria-label={`Quiz: ${quiz.title}`}>
      <header className="deck-header">
        <strong>{quiz.title}</strong>
        <span className="muted small">
          {quiz.difficulty} ·{" "}
          {mcq.length
            ? `${correct}/${answered.length} correct so far`
            : `${quiz.questions.length} questions`}
        </span>
      </header>
      <ol className="quiz-list">
        {quiz.questions.map((q, i) => (
          <li key={i} className="quiz-q">
            <p className="quiz-question">{q.question}</p>
            {q.type === "multiple_choice" ? (
              <>
                <div className="quiz-choices" role="radiogroup" aria-label={`Question ${i + 1}`}>
                  {q.choices.map((choice, c) => {
                    const chosen = picked[i];
                    const state =
                      chosen === undefined
                        ? ""
                        : c === q.answerIndex
                          ? " choice--right"
                          : c === chosen
                            ? " choice--wrong"
                            : "";
                    return (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={chosen === c}
                        className={`choice${state}`}
                        disabled={chosen !== undefined}
                        onClick={() => setPicked((p) => ({ ...p, [i]: c }))}
                      >
                        {String.fromCharCode(65 + c)}. {choice}
                      </button>
                    );
                  })}
                </div>
                {picked[i] !== undefined && (
                  <p
                    className={`status ${gradeMultipleChoice(q, picked[i]!).correct ? "status--ok" : "status--bad"}`}
                  >
                    {gradeMultipleChoice(q, picked[i]!).correct
                      ? "Correct. "
                      : `Not quite: the answer is ${String.fromCharCode(65 + q.answerIndex)}. `}
                    {q.explanation} <span className="muted">({q.source})</span>
                  </p>
                )}
              </>
            ) : (
              <div className="quiz-short">
                <textarea
                  aria-label={`Your answer to question ${i + 1}`}
                  rows={2}
                  value={written[i] ?? ""}
                  disabled={sent[i]}
                  onChange={(e) => setWritten((w) => ({ ...w, [i]: e.target.value }))}
                />
                <button
                  type="button"
                  className="ghost-button"
                  disabled={busy || sent[i] || !(written[i] ?? "").trim()}
                  onClick={() => {
                    setSent((s) => ({ ...s, [i]: true }));
                    onAsk(
                      `Grade my answer to quiz question ${i + 1} ("${q.question}").\nMy answer: ${written[i]!.trim()}\nModel answer: ${q.answer} (${q.source}).\nSay if I'm right, what's missing, and cite the page.`,
                    );
                  }}
                >
                  {sent[i] ? "Sent to Mofu" : "Check with Mofu"}
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
      <footer className="deck-footer">
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => onAsk("Make another quiz on the same material, harder this time.")}
        >
          Harder
        </button>
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => onAsk("Make another quiz on the same material, easier this time.")}
        >
          Easier
        </button>
      </footer>
    </section>
  );
}
