// Rename in place: a name field with Save and Cancel. Enter saves, Escape cancels.

import { useEffect, useRef, useState } from 'preact/hooks';
import type { TargetedKeyboardEvent } from 'preact';
import { IconButton, TextInput, cx } from '../../components/index.ts';
import { CAMERA_NAME_MAX } from './camera-status.ts';

export interface RenameFieldProps {
  initial: string;
  /** Accessible name of the field ("New name for Front door"). */
  label: string;
  /** Resolves when saved; rejects with an Error whose message is shown. */
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
  class?: string;
}

export function RenameField({ initial, label, onSave, onCancel, class: className }: RenameFieldProps) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, []);

  const save = async () => {
    if (saving) return;
    const name = value.trim();
    if (!name) {
      setError('Type a name for the camera.');
      return;
    }
    if (name === initial.trim()) {
      onCancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(name);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'That did not go through. Try again.');
      setSaving(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!saving) onCancel();
    }
  };

  return (
    <form
      class={cx('rename', className)}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div class="rename-row">
        <TextInput
          value={value}
          onInput={(next) => {
            setValue(next);
            setError(null);
          }}
          aria-label={label}
          maxLength={CAMERA_NAME_MAX}
          enterKeyHint="done"
          autoComplete="off"
          disabled={saving}
          invalid={error !== null}
          onKeyDown={onKeyDown}
          inputRef={inputRef}
          class="grow"
        />
        <IconButton icon="check" label="Save name" variant="secondary" type="submit" loading={saving} />
        <IconButton icon="close" label="Cancel" disabled={saving} onClick={onCancel} />
      </div>
      {error ? (
        <p class="k-xs text-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
