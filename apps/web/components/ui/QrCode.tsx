"use client";

import { QRCodeSVG } from "qrcode.react";

export interface QrCodeProps {
  /** The exact value to encode — for a deposit address, this must be the raw address string, never mixed with a memo/tag. */
  value: string;
  size?: number;
  label?: string;
}

/** Pure client-side rendering — encodes only the given string, no network call, no external service. */
export function QrCode({ value, size = 176, label }: QrCodeProps) {
  return (
    <div className="inline-flex flex-col items-center gap-2 rounded-lg bg-white p-3" role="img" aria-label={label ?? `QR code for ${value}`}>
      <QRCodeSVG value={value} size={size} level="M" includeMargin={false} />
    </div>
  );
}
