import { useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from "react";

interface ComposerProps {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  files: File[];
  onFilesChange: (files: File[]) => void;
}

const MAX_FILES = 5;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Composer({ busy, disabled, onSend, onStop, files, onFilesChange }: ComposerProps) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    onFilesChange([...files, ...Array.from(incoming)].slice(0, MAX_FILES));
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const value = text.trim();
    if (!value || busy || disabled) return;
    onSend(value);
    setText("");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <form
      className={`composer${dragging ? " composer--dragging" : ""}`}
      onSubmit={submit}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      {files.length > 0 && (
        <div className="file-list">
          <ul aria-label="Attached files">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="file-chip">
                <span className="file-name">{f.name}</span>
                <span className="file-size">{formatSize(f.size)}</span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove ${f.name}`}
                  onClick={() => onFilesChange(files.filter((_, j) => j !== i))}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <p className="file-note">
            Files stay in your browser. Mofu will read them once Data Analyst and Study Buddy
            launch.
          </p>
        </div>
      )}
      <label htmlFor="composer-input" className="visually-hidden">
        Message Mofu
      </label>
      <textarea
        id="composer-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={dragging ? "Drop files to attach" : "Ask Mofu anything…"}
        rows={1}
        maxLength={8000}
        disabled={disabled}
      />
      <div className="composer-actions">
        <button
          type="button"
          className="ghost-button"
          onClick={() => fileInput.current?.click()}
          disabled={disabled}
        >
          Attach
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <span className="composer-hint">Enter to send · Shift+Enter for a new line</span>
        {busy ? (
          <button type="button" className="pill-button pill-button--secondary" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="pill-button" disabled={disabled || !text.trim()}>
            Send <span aria-hidden="true">→</span>
          </button>
        )}
      </div>
    </form>
  );
}
