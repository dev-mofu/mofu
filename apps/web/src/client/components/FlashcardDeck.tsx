import { useEffect, useMemo, useState } from "react";
import {
  dueCards,
  newProgress,
  review,
  toAnkiTsv,
  type CardProgress,
  type Flashcard,
} from "@mofu/core/web";
import { downloadText } from "../lib/data-tools.js";

interface FlashcardDeckProps {
  id: string;
  title: string;
  cards: Flashcard[];
}

const storageKey = (id: string) => `mofu.deck.${id}`;

function loadProgress(id: string, count: number): CardProgress[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey(id)) ?? "null") as
      CardProgress[] | null;
    if (Array.isArray(saved) && saved.length === count) return saved;
  } catch {
    // Storage unavailable: progress lasts for this page view only.
  }
  return Array.from({ length: count }, () => newProgress(new Date()));
}

/** Flip cards, mark them, and let a simple Leitner schedule decide what comes back. */
export function FlashcardDeck({ id, title, cards }: FlashcardDeckProps) {
  const [progress, setProgress] = useState(() => loadProgress(id, cards.length));
  const [flipped, setFlipped] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const due = useMemo(() => dueCards(progress, now), [progress, now]);
  const index = due[0];
  const card = index !== undefined ? cards[index] : undefined;

  useEffect(() => {
    try {
      localStorage.setItem(storageKey(id), JSON.stringify(progress));
    } catch {
      // Ignore: storage may be blocked.
    }
  }, [id, progress]);

  const mark = (knewIt: boolean) => {
    if (index === undefined) return;
    const t = new Date();
    setProgress((p) => p.map((x, i) => (i === index ? review(x, knewIt, t) : x)));
    setNow(t);
    setFlipped(false);
  };

  const mastered = progress.filter((p) => p.box >= 4).length;

  return (
    <section className="deck" aria-label={`Flashcards: ${title}`}>
      <header className="deck-header">
        <strong>{title}</strong>
        <span className="muted small">
          {cards.length} cards · {due.length} due · {mastered} learned
        </span>
      </header>
      {card ? (
        <>
          <button
            type="button"
            className={`card${flipped ? " card--back" : ""}`}
            onClick={() => setFlipped((f) => !f)}
            aria-label={flipped ? "Show question" : "Show answer"}
          >
            <span className="card-side">{flipped ? "Answer" : "Question"}</span>
            <span className="card-text">{flipped ? card.back : card.front}</span>
            {flipped && <span className="card-source">{card.source}</span>}
          </button>
          <div className="deck-actions">
            {flipped ? (
              <>
                <button type="button" className="ghost-button danger" onClick={() => mark(false)}>
                  Didn't know
                </button>
                <button type="button" className="pill-button" onClick={() => mark(true)}>
                  Knew it
                </button>
              </>
            ) : (
              <button type="button" className="pill-button" onClick={() => setFlipped(true)}>
                Show answer
              </button>
            )}
          </div>
        </>
      ) : (
        <p className="status status--ok">
          All caught up. Cards you knew come back in 1, 3, 7 and 14 days.
        </p>
      )}
      <footer className="deck-footer">
        <button
          type="button"
          className="link-button"
          onClick={() =>
            downloadText(
              `${title.replace(/[^\w-]+/g, "_").slice(0, 60) || "deck"}.tsv`,
              toAnkiTsv(cards, title),
              "text/tab-separated-values",
            )
          }
        >
          Export for Anki
        </button>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setProgress(cards.map(() => newProgress(new Date())));
            setNow(new Date());
          }}
        >
          Restart
        </button>
      </footer>
    </section>
  );
}
