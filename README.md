# Smart Crop – Standalone (Client + Server)

Minimal, self-contained version of the Smart Moulding Cropper for external testing and batch production.

## What’s inside
- **Client**: Vite + React + TypeScript. Canvas UI with multi-box drag/resize and per-box 0.5° rotation, zoom/pan, vendor prefixing.
- **Server**: Express + TypeScript using **tesseract.js** (OCR) and **sharp** (crop/rotate). Files are saved to `server/public/crops` for quick preview.
  - Endpoints:
    - `POST /api/detect-item-numbers` → `{ itemNumbers: string[] }`
    - `POST /api/multiple-crop-mouldings` → `{ croppedMouldings: { id, imageUrl, detectedNumber }[] }`

## Prereqs
- Node 18+
- `sharp` needs libvips (auto-installed on most platforms). If install fails on macOS, run `xcode-select --install` first.
- `tesseract.js` ships its own worker; no native build required.

## Quick start
```bash
# Terminal 1
cd server
npm i
npm run dev

# Terminal 2
cd client
npm i
npm run dev
```
- Open http://localhost:5173
- Server runs on http://localhost:3001 (proxy configured in Vite).

## Notes
- This build saves crops to local disk for speed. To push to Firebase Storage, replace the file write section in `server/src/index.ts` with Firebase Admin SDK upload.
- OCR regex is intentionally permissive for moulding-like IDs (e.g., 4201, 1394). Adjust `/[A-Z]?[0-9]{3,6}[A-Z]?/gi` to your catalog format.
- Rotation is applied per-crop on the server; client sends `rotation` degrees. Crop is extracted first, then rotated around its center.
- Keep crop boxes within the image bounds (the client enforces this).

## Vendor prefixes
- Mapped in both client and server. Update as needed:
  - 1: PR, 2: ST, 3: DM, 4: BM, 5: MM
