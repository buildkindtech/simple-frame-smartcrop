// index.ts
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import cors from 'cors';
import { createWorker } from 'tesseract.js';
import sharp from 'sharp';

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({ dest: path.join(process.cwd(), 'uploads') });

/* =========================================
   공통: Tesseract worker 유틸
========================================= */
async function ocrRecognize(buf: Buffer, lang = 'eng', params: Record<string, any> = {}) {
  const worker: any = await createWorker();
  await worker.setParameters(params);
  const { data } = await worker.recognize(buf, lang);
  await worker.terminate();
  return data;
}

/* =========================================
   Strategy A: presto  (기존 강한 필터, 좌/우 에지)
   - 순수 숫자 3~6자리
   - 좌/우 에지 12% 내
   - conf/크기/종횡비 필터
   - 같은 행 dedup
========================================= */
async function detectPresto(buf: Buffer, imgW: number, imgH: number) {
  const data = await ocrRecognize(buf, 'eng', {
    tessedit_pageseg_mode: '11',            // Sparse
    tessedit_char_whitelist: '0123456789',  // 숫자만
    user_defined_dpi: '300',
  });

  const words = (data?.words || []).map((w: any) => {
    const x0 = w.bbox?.x0 ?? w.x0 ?? 0;
    const y0 = w.bbox?.y0 ?? w.y0 ?? 0;
    const x1 = w.bbox?.x1 ?? w.x1 ?? 0;
    const y1 = w.bbox?.y1 ?? w.y1 ?? 0;
    const W = Math.max(0, x1 - x0);
    const H = Math.max(0, y1 - y0);
    return {
      raw: String(w.text || ''),
      x: x0, y: y0, w: W, h: H,
      cx: x0 + W / 2,
      cy: y0 + H / 2,
      conf: Number(w.confidence ?? w.conf ?? 0),
    };
  });

  const EDGE_PCT = 0.12;
  const LEFT_MAX = imgW * EDGE_PCT;
  const RIGHT_MIN = imgW * (1 - EDGE_PCT);

  const MIN_CONF = 60;
  const MIN_H   = imgH * 0.010;
  const MAX_H   = imgH * 0.06;
  const MIN_AR  = 0.9;
  const MAX_AR  = 6.0;

  const candidates = words
    .map(o => ({ text: o.raw.replace(/\D/g, ''), ...o, ar: o.w > 0 ? o.w / o.h : 0 }))
    .filter(o =>
      /^\d{3,6}$/.test(o.text) &&
      o.conf >= MIN_CONF &&
      (o.cx <= LEFT_MAX || o.cx >= RIGHT_MIN) &&
      o.h >= MIN_H && o.h <= MAX_H &&
      o.ar >= MIN_AR && o.ar <= MAX_AR
    )
    .sort((a, b) => a.y - b.y || a.x - b.x);

  // 같은 행 dedup
  const dedup: any[] = [];
  const MERGE_GAP = Math.round((imgH || 1000) * 0.015) || 15;
  for (const d of candidates) {
    const last = dedup[dedup.length - 1];
    if (!last || Math.abs(d.cy - last.cy) > MERGE_GAP) {
      dedup.push(d);
    } else if (d.conf > last.conf) {
      dedup[dedup.length - 1] = d;
    }
  }

  const detections = dedup.map(({ text, x, y, w, h, conf }) => ({ text, x, y, w, h, conf }));
  const itemNumbers = detections.map(d => d.text);
  return { detections, itemNumbers };
}

/* =========================================
   Strategy B: nurre  (좌하단 굵은 큰 숫자 전용)
   - ROI: 왼쪽 35% × 아래 30%
   - 강한 이진화 + 샤픈
   - 숫자 3~6자리, 큰 글자 우선
   - 실패 시 presto로 폴백 (라우트에서 처리)
========================================= */
async function detectNurreBig(buf: Buffer, fullW: number, fullH: number) {
  // 1) 강한 대비/이진화
  const preStrong = await sharp(buf)
    .greyscale()
    .linear(1.4, -10)             // 대비↑
    .normalize()
    .threshold(170, { grayscale: true })
    .sharpen()
    .png()
    .toBuffer();

  // 2) 좌하단 ROI
  const ROI_W = Math.max(1, Math.round(fullW * 0.35));
  const ROI_H = Math.max(1, Math.round(fullH * 0.30));
  const ROI = await sharp(preStrong)
    .extract({ left: 0, top: fullH - ROI_H, width: ROI_W, height: ROI_H })
    .resize({ width: Math.min(1600, ROI_W), withoutEnlargement: true })
    .png()
    .toBuffer();

  const data = await ocrRecognize(ROI, 'eng', {
    tessedit_pageseg_mode: '6',             // block
    tessedit_char_whitelist: '0123456789',  // 숫자만
    user_defined_dpi: '300',
  });

  // 3) 후보 (ROI → 원본 좌표로 보정)
  const words = (data?.words || []).map((w: any) => {
    const x0 = w.bbox?.x0 ?? w.x0 ?? 0;
    const y0 = w.bbox?.y0 ?? w.y0 ?? 0;
    const x1 = w.bbox?.x1 ?? w.x1 ?? 0;
    const y1 = w.bbox?.y1 ?? w.y1 ?? 0;
    const W = Math.max(0, x1 - x0);
    const H = Math.max(0, y1 - y0);
    const baseTop = fullH - ROI_H;
    return {
      raw: String(w.text || ''),
      x: x0, y: baseTop + y0, w: W, h: H,
      cx: x0 + W / 2,
      cy: baseTop + y0 + H / 2,
      conf: Number(w.confidence ?? w.conf ?? 0),
    };
  });

  const MIN_CONF = 55;
  const MIN_H = Math.max(20, Math.round(fullH * 0.018));
  const MAX_H = Math.round(fullH * 0.12);
  const MIN_AR = 0.6;
  const MAX_AR = 10.0;

  let candidates = words
    .map(o => ({ text: o.raw.replace(/\D/g, ''), ...o, ar: o.w > 0 ? o.w / o.h : 0 }))
    .filter(o =>
      /^\d{3,6}$/.test(o.text) &&
      o.conf >= MIN_CONF &&
      o.h >= MIN_H && o.h <= MAX_H &&
      o.ar >= MIN_AR && o.ar <= MAX_AR
    );

  // 아래쪽·왼쪽·큰 글자 우선
  candidates = candidates
    .sort((a, b) => b.cy - a.cy || a.x - b.x || b.h - a.h || b.conf - a.conf)
    .slice(0, 3);

  const detections = candidates.map(({ text, x, y, w, h, conf }) => ({ text, x, y, w, h, conf }));
  const itemNumbers = detections.map(d => d.text);
  return { detections, itemNumbers };
}

/* =========================================
   OCR: 아이템 번호 감지 (전략 선택)
   - ?strategy=presto | nurre  (기본: presto)
   - body.strategy / query.strategy / header[x-ocr-strategy] 중 아무거나
========================================= */
app.post('/api/detect-item-numbers', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ detections: [], itemNumbers: [] });

    const strategy =
      (req.query.strategy as string) ||
      (req.body?.strategy as string) ||
      (req.headers['x-ocr-strategy'] as string) ||
      'presto';

    // EXIF 보정 + 공통 프리프로세싱(Presto 기준)
    const base = sharp(req.file.path).rotate();
    const meta = await base.metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;

    const preCommon = await base
      .resize({ width: Math.min(2200, imgW || 2200), withoutEnlargement: true })
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    let out = { detections: [] as any[], itemNumbers: [] as string[] };

    if (strategy === 'nurre') {
      // 누리 전용 감지
      out = await detectNurreBig(preCommon, imgW, imgH);

      // 폴백: 못 잡으면 presto로 재시도
      if (!out.itemNumbers.length) {
        const prestoOut = await detectPresto(preCommon, imgW, imgH);
        if (prestoOut.itemNumbers.length) out = prestoOut;
      }
    } else {
      // 기본: Presto (기존 동작 그대로)
      out = await detectPresto(preCommon, imgW, imgH);
    }

    try { fs.unlinkSync(req.file.path); } catch {}

    return res.json({
      detections: out.detections,
      itemNumbers: out.itemNumbers,
      imageWidth: imgW,
      imageHeight: imgH,
      strategyUsed: strategy,
    });
  } catch (e) {
    console.error('OCR error', e);
    return res.json({ detections: [], itemNumbers: [] });
  }
});

/* =========================================
   Multi-crop: 회전 적용 후 안전 추출 (기존 유지)
========================================= */
type CropReq = {
  x: number; y: number; width: number; height: number;
  rotation?: number; itemNumber: string; detectColor?: boolean;
};

app.post('/api/multiple-crop-mouldings', upload.single('catalogImage'), async (req, res) => {
  try {
    const crops: CropReq[] = JSON.parse(req.body.multipleCrops || '[]');
    if (!req.file) return res.status(400).send('No catalogImage');

    const inputPath = req.file.path;
    const base = sharp(inputPath);
    const meta = await base.metadata();
    const W = meta.width  ?? 0;
    const H = meta.height ?? 0;

    const outDir = path.join(process.cwd(), 'public', 'crops');
    fs.mkdirSync(outDir, { recursive: true });

    const rotPt = (x: number, y: number, cx: number, cy: number, thetaRad: number) => {
      const dx = x - cx, dy = y - cy;
      return {
        x: Math.cos(thetaRad) * dx - Math.sin(thetaRad) * dy + cx,
        y: Math.sin(thetaRad) * dx + Math.cos(thetaRad) * dy + cy
      };
    };

    const results: any[] = [];

    for (const c of crops) {
      try {
        const angle = Number(c.rotation ?? 0);
        const theta = -angle * Math.PI / 180;

        const bw0 = Math.max(1, Math.floor(c.width));
        const bh0 = Math.max(1, Math.floor(c.height));
        const bx0 = Math.max(0, Math.floor(c.x));
        const by0 = Math.max(0, Math.floor(c.y));

        const cx = W / 2, cy = H / 2;
        const corners = [
          rotPt(0,0,cx,cy,theta), rotPt(W,0,cx,cy,theta),
          rotPt(W,H,cx,cy,theta), rotPt(0,H,cx,cy,theta)
        ];
        const minX = Math.min(...corners.map(p => p.x));
        const minY = Math.min(...corners.map(p => p.y));
        const maxX = Math.max(...corners.map(p => p.x));
        const maxY = Math.max(...corners.map(p => p.y));
        const RW = Math.round(maxX - minX);
        const RH = Math.round(maxY - minY);

        const ctr = rotPt(bx0 + bw0 / 2, by0 + bh0 / 2, cx, cy, theta);
        let rx = Math.round(ctr.x - minX - bw0 / 2);
        let ry = Math.round(ctr.y - minY - bh0 / 2);

        const bw = Math.min(bw0, RW);
        const bh = Math.min(bh0, RH);
        rx = Math.max(0, Math.min(RW - bw, rx));
        ry = Math.max(0, Math.min(RH - bh, ry));

        const buf = await sharp(inputPath)
          .rotate(-angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .extract({ left: rx, top: ry, width: bw, height: bh })
          .png()
          .toBuffer();

        const clean = String(c.itemNumber || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase() || `CROP${Date.now()}`;
        let fileBase = `${clean}.png`;
        let filePath = path.join(outDir, fileBase);
        let k = 1;
        while (fs.existsSync(filePath)) {
          fileBase = `${clean}_${k++}.png`;
          filePath = path.join(outDir, fileBase);
        }
        fs.writeFileSync(filePath, buf);

        results.push({ id: fileBase, imageUrl: `/crops/${fileBase}`, detectedNumber: c.itemNumber });
      } catch (err) {
        console.error('crop failed for', c.itemNumber, err);
      }
    }

    try { fs.unlinkSync(inputPath); } catch {}
    return res.json({ croppedMouldings: results });
  } catch (e: any) {
    console.error('Multiple crop error', e);
    return res.status(500).send(e?.message || 'Crop failed');
  }
});

// 정적 제공 (저장된 크롭 미리보기)
app.use('/crops', express.static(path.join(process.cwd(), 'public', 'crops')));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`[smart-crop server] listening on http://localhost:${PORT}`));
