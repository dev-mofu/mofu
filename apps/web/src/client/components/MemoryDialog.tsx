import { useState } from "react";
import { MAX_MEMORY_ITEM_CHARS, type MemoryItem } from "../lib/storage.js";
import { Modal } from "./Modal.js";

interface MemoryDialogProps {
  open: boolean;
  items: MemoryItem[];
  onClose: () => void;
  onChange: (items: MemoryItem[]) => void;
}

export function MemoryDialog({ open, items, onClose, onChange }: MemoryDialogProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const saveEdit = (id: string) => {
    const text = draft.replace(/\s+/g, " ").trim();
    onChange(
      text
        ? items.map((m) => (m.id === id ? { ...m, text } : m))
        : items.filter((m) => m.id !== id),
    );
    setEditing(null);
  };

  return (
    <Modal open={open} title="Memory" onClose={onClose}>
      <p className="muted">
        Things Mofu remembers about you. They're stored only in this browser and sent along with
        your messages so Mofu can use them. Ask Mofu to “remember …” to add one.
      </p>
      {items.length === 0 ? (
        <p className="empty-note">Nothing saved yet.</p>
      ) : (
        <ul className="memory-list">
          {items.map((m) => (
            <li key={m.id}>
              {editing === m.id ? (
                <form
                  className="input-row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    saveEdit(m.id);
                  }}
                >
                  <input
                    aria-label="Edit memory"
                    value={draft}
                    maxLength={MAX_MEMORY_ITEM_CHARS}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                  />
                  <button type="submit" className="ghost-button">
                    Save
                  </button>
                  <button type="button" className="ghost-button" onClick={() => setEditing(null)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <span className="memory-text">{m.text}</span>
                  <span className="memory-actions">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => {
                        setEditing(m.id);
                        setDraft(m.text);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="ghost-button danger"
                      aria-label={`Delete: ${m.text}`}
                      onClick={() => onChange(items.filter((x) => x.id !== m.id))}
                    >
                      Delete
                    </button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <footer className="modal-footer">
          <button type="button" className="ghost-button danger" onClick={() => onChange([])}>
            Clear all
          </button>
        </footer>
      )}
    </Modal>
  );
}
