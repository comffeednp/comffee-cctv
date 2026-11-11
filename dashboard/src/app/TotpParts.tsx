// Pieces shared by every 2-step screen (setup, sign-in enrolment, 2-step reset).

import qrcode from 'qrcode-generator';
import { useMemo } from 'preact/hooks';
import { TOTP_DIGITS } from '../../../shared/api-types.ts';
import { CopyBox, FormField, TextInput } from '../components/index.ts';

/** A QR code drawn as SVG paths (no images, no inline markup), with a light quiet zone. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const drawn = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
      }
    }
    return { size: count + 8, d };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${drawn.size} ${drawn.size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect class="qr-light" x="0" y="0" width={drawn.size} height={drawn.size} />
      <path class="qr-dark" d={drawn.d} />
    </svg>
  );
}

/** The QR code plus the secret as text, for people who type it in instead. */
export function TotpEnrollment({ otpauthUrl, secretBase32 }: { otpauthUrl: string; secretBase32: string }) {
  return (
    <div class="stack">
      <ol class="steps k-body">
        <li>Open an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 2FAS.</li>
        <li>Add a new account and scan this code.</li>
        <li>Type the {TOTP_DIGITS}-digit code the app shows.</li>
      </ol>
      <QrCode text={otpauthUrl} label="QR code for your authenticator app" />
      <CopyBox label="Can't scan? Type this key instead" value={secretBase32} />
    </div>
  );
}

/** Keeps only digits and cuts to the code length. */
export function cleanCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, TOTP_DIGITS);
}

export function isFullCode(value: string): boolean {
  return value.length === TOTP_DIGITS;
}

/** The 6-digit code field. */
export function CodeField({
  value,
  onInput,
  error,
  autoFocus,
}: {
  value: string;
  onInput: (value: string) => void;
  error?: string;
  autoFocus?: boolean;
}) {
  return (
    <FormField label="Code from the app" hint={`${TOTP_DIGITS} digits. It changes every 30 seconds.`} error={error} required>
      <TextInput
        value={value}
        onInput={(next) => onInput(cleanCode(next))}
        inputMode="numeric"
        autoComplete="one-time-code"
        enterKeyHint="done"
        maxLength={TOTP_DIGITS}
        pattern="[0-9]*"
        mono
        autoFocus={autoFocus}
        required
      />
    </FormField>
  );
}
