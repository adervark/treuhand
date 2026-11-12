import { ImageResponse } from "next/og";
import { BRAND } from "@/components/brand";

// The app icon for a phone's home screen: Treuhand's mark, full bleed (the platform rounds the corners).
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BRAND.accent }}>
        <svg width="120" height="120" viewBox="0 0 32 32">
          <path d="M8.5 16.5 L13.5 21.5 L23.5 10.5" fill="none" stroke={BRAND.on} strokeWidth="3.6" strokeLinecap="square" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
