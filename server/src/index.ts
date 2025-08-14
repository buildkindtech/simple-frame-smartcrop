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

/* =========================
   OCR: 아이템번호만 감지 (강한 필터)
   - 순수 숫자 4~6자리
   - 좌/우 가장자리(12%) 안쪽만
   - conf, 글자 크기/종횡비 필터
   - 세로 중복 병합
========================= */
app.post('/api/detect-item-numbers', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.json({ detections: [], itemNumbers: [] });

    const base = sharp(req.file.path).rotate(); // EXIF 보정
    const meta = await base.metadata();
    const imgW = meta.width ?? 0;
    const imgH = meta.height ?? 0;

    const pre = await base
      .resize({ width: Math.min(2200, imgW || 2200), withoutEnlargement: true })
      .greyscale()
      .normalize()
      .sharpen()
      .png()
      .toBuffer();

    const worker: any = await createWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: '11',            // Sparse
      tessedit_char_whitelist: '0123456789',  // 숫자만
      user_defined_dpi: '300',
    });

    const { data } = await worker.recognize(pre, 'eng');
    await worker.terminate();
    try { fs.unlinkSync(req.file.path); } catch {}

    // words -> bbox 목록
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

    // 필터 파라미터
    const EDGE_PCT = 0.12;                  // 좌/우 가장자리 12%
    const LEFT_MAX = imgW * EDGE_PCT;
    const RIGHT_MIN = imgW * (1 - EDGE_PCT);

    const MIN_CONF = 60;
    const MIN_H   = imgH * 0.010;           // 1.0%
    const MAX_H   = imgH * 0.06;            // 6%
    const MIN_AR  = 0.9;
    const MAX_AR  = 6.0;

    const candidates = words
      .map(o => ({ text: o.raw.replace(/\D/g, ''), ...o, ar: o.w > 0 ? o.w / o.h : 0 }))
      .filter(o =>
        /^\d{3,6}$/.test(o.text) &&                 // 4~6자리 순수 숫자
        o.conf >= MIN_CONF &&
        (o.cx <= LEFT_MAX || o.cx >= RIGHT_MIN) && // 좌/우 에지
        o.h >= MIN_H && o.h <= MAX_H &&
        o.ar >= MIN_AR && o.ar <= MAX_AR
      )
      .sort((a, b) => a.y - b.y || a.x - b.x);

    // 세로 병합(같은 행은 하나만)
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

    return res.json({ detections, itemNumbers, imageWidth: imgW, imageHeight: imgH });
  } catch (e) {
    console.error('OCR error', e);
    return res.json({ detections: [], itemNumbers: [] });
  }
});

/* =========================
   Multi-crop: 회전 적용 후 안전 추출
========================= */
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

    // 회전 좌표 보정 유틸
    const rotPt = (x: number, y: number, cx: number, cy: number, thetaRad: number) => {
      const dx = x - cx, dy = y - cy;
      return { x: Math.cos(thetaRad) * dx - Math.sin(thetaRad) * dy + cx,
               y: Math.sin(thetaRad) * dx + Math.cos(thetaRad) * dy + cy };
    };

    const results: any[] = [];

    for (const c of crops) {
      try {
        const angle = Number(c.rotation ?? 0);   // 프론트에서 준 각도(도)
        const theta = -angle * Math.PI / 180;   // 이미지에 적용할 회전(-angle)
        // 원본 박스(정수화 & 하한값)
        const bw0 = Math.max(1, Math.floor(c.width));
        const bh0 = Math.max(1, Math.floor(c.height));
        const bx0 = Math.max(0, Math.floor(c.x));
        const by0 = Math.max(0, Math.floor(c.y));

        // 회전 후 전체 캔버스 offset 계산(자동 padding)
        const cx = W / 2, cy = H / 2;
        const corners = [rotPt(0,0,cx,cy,theta), rotPt(W,0,cx,cy,theta), rotPt(W,H,cx,cy,theta), rotPt(0,H,cx,cy,theta)];
        const minX = Math.min(...corners.map(p => p.x));
        const minY = Math.min(...corners.map(p => p.y));
        const maxX = Math.max(...corners.map(p => p.x));
        const maxY = Math.max(...corners.map(p => p.y));
        const RW = Math.round(maxX - minX);
        const RH = Math.round(maxY - minY);

        // ROI 중심점 → 회전/패딩 좌표계로 변환
        const ctr = rotPt(bx0 + bw0 / 2, by0 + bh0 / 2, cx, cy, theta);
        let rx = Math.round(ctr.x - minX - bw0 / 2);
        let ry = Math.round(ctr.y - minY - bh0 / 2);

        // 경계 보정
        const bw = Math.min(bw0, RW);
        const bh = Math.min(bh0, RH);
        rx = Math.max(0, Math.min(RW - bw, rx));
        ry = Math.max(0, Math.min(RH - bh, ry));

        // 실제 추출
        const buf = await sharp(inputPath)
          .rotate(-angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
          .extract({ left: rx, top: ry, width: bw, height: bh })
          .png()
          .toBuffer();

        // 파일명: PR12345.png (중복시 _1, _2…)
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
        // 한 개 실패해도 계속 진행
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
