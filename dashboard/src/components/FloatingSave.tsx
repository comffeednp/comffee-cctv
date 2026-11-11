import { Button } from './Button.tsx';

export interface FloatingSaveProps {
  /** True once something on the page changed; the button stays disabled until then. */
  dirty: boolean;
  /** True while the save request runs. */
  saving?: boolean;
  /** id of the page's form: the button submits it. Give this or onSave. */
  form?: string;
  onSave?: () => void;
  /** Defaults to "Save". */
  label?: string;
  /** Defaults to "Saving...". */
  savingLabel?: string;
  /** Tooltip naming what is saved ("Save camera settings"). */
  title?: string;
}

/**
 * The ONE save of an editing page: a floating amber button at the bottom right, above the phone
 * bottom bar. No other Save, Update or Apply button may appear on the same page.
 */
export function FloatingSave({ dirty, saving = false, form, onSave, label = 'Save', savingLabel = 'Saving...', title }: FloatingSaveProps) {
  return (
    <div class="floating-save">
      <Button
        variant="primary"
        icon="check"
        type={form ? 'submit' : 'button'}
        form={form}
        title={title ?? label}
        disabled={!dirty}
        loading={saving}
        loadingLabel={savingLabel}
        onClick={form ? undefined : () => onSave?.()}
      >
        {label}
      </Button>
    </div>
  );
}
