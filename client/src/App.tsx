import React, { useState, useRef, useCallback, useEffect } from 'react';

/** ===== Types ===== */
type Vendor = { id: number; name: string };

type CropBox = {
  id: number;
  x: number; y: number; width: number; height: number;
  itemNumber: string; color: string;
  rotation?: number;
  flipVertical?: boolean;
};

type CroppedMoulding = {
  id: string;
  imageUrl: string;
  detectedNumber: string;
  csvData?: { name: string; description: string; width: string; pricePerFoot: string };
};

const VENDORS: Vendor[] = [
  { id: 1, name: 'Presto Moulding' },
  { id: 2, name: 'Studio Moulding' },
  { id: 3, name: 'Décor Moulding' },
  { id: 4, name: 'Bella Moulding' },
  { id: 5, name: 'Metro Moulding' },
  { id: 6, name: 'Nurre Caxton' },
];

/** ===== Helpers ===== */
function getVendorPrefix(vendorId: string) {
  const vendor = VENDORS.find(v => v.id.toString() === vendorId);
  if (!vendor) return '';
  const m: Record<string, string> = {
    'Presto Moulding': 'PR',
    'Studio Moulding': 'ST',
    'Décor Moulding': 'DM',
    'Bella Moulding': 'BM',
    'Metro Moulding': 'MM',
    'Nurre Caxton': 'NC',
  };
  return m[vendor.name] || '';
}
function formatItemNumber(n: string, vendorId: string) {
  const p = getVendorPrefix(vendorId);
  if (!p) return n;
  if (n.startsWith(p)) return n;
  const clean = (n || '').replace(/^[A-Z]{1,3}/, '');
  return p + clean;
}

// 클라이언트에서 ROI를 잘라 Blob으로 만드는 유틸
async function cropToBlob(image: HTMLImageElement, rect: {x:number;y:number;width:number;height:number}): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(
    image,
    Math.max(0, Math.round(rect.x)),
    Math.max(0, Math.round(rect.y)),
    w, h,
    0, 0, w, h
  );
  return new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b || new Blob()), 'image/png', 1);
  });
}

/** ===== Component ===== */
export default function App() {
  // 공통 상태
  const [mode, setMode] = useState<'catalog' | 'screenshot'>('catalog');
  const [viewMode, setViewMode] = useState<'single' | 'all'>('single');
  const [selectedVendorId, setSelectedVendorId] = useState('');

  // 다중 파일
  const [files, setFiles] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const catalogInputRef = useRef<HTMLInputElement>(null);

  // 이미지별 크롭박스 맵
  const [boxesMap, setBoxesMap] = useState<Record<number, CropBox[]>>({});
  const [croppedMouldings, setCroppedMouldings] = useState<CroppedMoulding[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentStep, setCurrentStep] = useState('');

  // 캔버스: 인덱스별 ref
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
  const setCanvasRef = (i: number) => (el: HTMLCanvasElement | null) => {
    if (!el) canvasRefs.current.delete(i);
    else canvasRefs.current.set(i, el);
  };

  // 뷰(포커스 이미지 기준)
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);
  const [activeCropId, setActiveCropId] = useState<number | null>(null);
  const resizeStartBoxRef = useRef<CropBox | null>(null);

  // 좌측 리스트 자동 높이 (single 뷰에서 사용)
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const [listMaxH, setListMaxH] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  /** ===== Effects: 리스트 높이/스크롤 ===== */
  useEffect(() => {
    const el = previewWrapRef.current;
    if (!el) return;
    setListMaxH(Math.floor(el.getBoundingClientRect().height));
    const ro = new ResizeObserver(entries => setListMaxH(Math.floor(entries[0].contentRect.height)));
    ro.observe(el);
    const onWinResize = () => setListMaxH(Math.floor(el.getBoundingClientRect().height));
    window.addEventListener('resize', onWinResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onWinResize); };
  }, [activeIdx, previews, viewMode]);

  useEffect(() => {
    if (!activeCropId || !listWrapRef.current) return;
    const row = rowRefs.current.get(activeCropId);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCropId]);

  /** ===== Vendor 변경 시 박스 내 itemNumber 접두 갱신 ===== */
  const handleVendorChange = (vid: string) => {
    setSelectedVendorId(vid);
    const prefix = getVendorPrefix(vid);
    if (!prefix) return;
    setBoxesMap(prev => {
      const next: Record<number, CropBox[]> = {};
      Object.keys(prev).forEach(k => {
        const i = Number(k);
        next[i] = prev[i].map(b => {
          if (!b.itemNumber) return b;
          if (b.itemNumber.startsWith(prefix)) return b;
          const clean = b.itemNumber.replace(/^[A-Z]{1,3}/, '');
          return { ...b, itemNumber: prefix + clean };
        });
      });
      return next;
    });
  };

  /** ===== 카탈로그: OCR → 세로스택 기본 박스 ===== */
  const detectItemNumbersCatalog = useCallback(async (imageFile: File, idx: number) => {
    try {
      const fd = new FormData();
      fd.append('image', imageFile);
      const resp = await fetch('/api/detect-item-numbers', { method: 'POST', body: fd });
      const result = await resp.json();
      const itemNumbers: string[] = result.itemNumbers || [];

      const colors = ['#00ff00', '#ff0000', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffa500', '#800080'];
      const prefix = getVendorPrefix(selectedVendorId);

      const BOX_W = 420, BOX_H = 120, margin = 10;
      const boxes: CropBox[] = (itemNumbers.length ? itemNumbers : ['']).map((num, i) => {
        const formatted = formatItemNumber(num || '', selectedVendorId) || prefix;
        return {
          id: i + 1,
          x: 50,
          y: 50 + i * (BOX_H + margin),
          width: BOX_W,
          height: BOX_H,
          itemNumber: formatted,
          color: colors[i % colors.length],
          rotation: 0,
          flipVertical: false,
        };
      });

      setBoxesMap(prev => ({ ...prev, [idx]: boxes }));
    } catch {
      setBoxesMap(prev => ({
        ...prev,
        [idx]: [{ id: 1, x: 50, y: 50, width: 400, height: 120, itemNumber: getVendorPrefix(selectedVendorId), color: '#00ff00', rotation: 0, flipVertical: false }],
      }));
    }
  }, [selectedVendorId]);

  /** ===== 스크린샷: 2열 + 하단 중앙 밴드 ROI OCR ===== */
  const detectFromScreenshot = useCallback(async (imageFile: File, idx: number) => {
    const imgUrl = URL.createObjectURL(imageFile);
    const img = await new Promise<HTMLImageElement>((res) => {
      const im = new Image(); im.onload = () => res(im); im.src = imgUrl;
    });
    const W = img.width, H = img.height;

    const cols = 2;
    const colW = Math.floor(W / cols);
    const padX = Math.round(colW * 0.05);
    const innerW = colW - padX * 2;

    const topY = Math.round(H * 0.08);
    const topH = Math.round(H * 0.60);
    const colors = ['#00bcd4', '#ff9800'];
    const prefix = getVendorPrefix(selectedVendorId);

const baseBoxes: CropBox[] = Array.from({ length: 2 }).map((_, i) => {
  const x = i * colW + padX;
  return {
    id: i + 1,
    x,
    y: topY + Math.round(topH * 0.05),
    width: innerW,
    height: Math.round(topH * 0.75),
    itemNumber: prefix,
    color: colors[i % colors.length],
    rotation: 0,
    // ✅ Nurre(스크린샷 모드) 기본 플립 ON
    flipVertical: true,
  };
});


    // 하단 18% 높이 × 중앙 60% 너비 (큰 파란 번호 위치)
    const ROI_H = Math.round(H * 0.18);
    const ROI_Y = Math.max(0, H - ROI_H - Math.round(H * 0.02));
    const ROI_W = Math.round(innerW * 0.60);
    const ROI_X_OFFSET = Math.round(innerW * 0.20);

    const roiBlobs: Blob[] = [];
    for (let i = 0; i < cols; i++) {
      const colX = i * colW + padX + ROI_X_OFFSET;
      const rect = { x: colX, y: ROI_Y, width: ROI_W, height: ROI_H };
      roiBlobs.push(await cropToBlob(img, rect));
    }
    URL.revokeObjectURL(imgUrl);

    try {
      const fd = new FormData();
      fd.append('mode', 'screenshot-bottom-number');
      fd.append('image', imageFile);
      roiBlobs.forEach((b, i) => fd.append('roiImages', b, `roi-${idx}-${i}.png`));

      const resp = await fetch('/api/detect-item-numbers-nurre', { method: 'POST', body: fd });
      const result = await resp.json();
      const itemNumbers: string[] = (result.itemNumbers || []).slice(0, 2);
      const withPrefix = itemNumbers.map(n => formatItemNumber(n || '', selectedVendorId));
      if (withPrefix[0]) baseBoxes[0].itemNumber = withPrefix[0];
      if (withPrefix[1]) baseBoxes[1].itemNumber = withPrefix[1];
    } catch {
      /* ignore */
    }

    setBoxesMap(prev => ({ ...prev, [idx]: baseBoxes }));
  }, [selectedVendorId]);

  /** ===== 업로드 (최대 5장) ===== */
  const handleMultiUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = Array.from(e.target.files || []);
    const picked = list.slice(0, 5);
    if (!picked.length) return;

    // 기존 프리뷰 해제
    setPreviews(prev => { prev.forEach(u => URL.revokeObjectURL(u)); return []; });

    const urls = picked.map(f => URL.createObjectURL(f));
    setFiles(picked);
    setPreviews(urls);
    setActiveIdx(0);
    setCroppedMouldings([]);
    setZoom(1); setPanOffset({ x: 0, y: 0 });

    const tasks = picked.map((file, i) =>
      mode === 'screenshot' ? detectFromScreenshot(file, i) : detectItemNumbersCatalog(file, i)
    );
    await Promise.all(tasks);
  }, [mode, detectFromScreenshot, detectItemNumbersCatalog]);

  /** ===== 박스 조작 ===== */
  function getResizeHandle(x: number, y: number, box: CropBox) {
    const s = 15, r = box.x + box.width, b = box.y + box.height;
    if (x >= r - s && y >= b - s) return 'se';
    if (x >= r - s && y <= box.y + s) return 'ne';
    if (x <= box.x + s && y >= b - s) return 'sw';
    if (x <= box.x + s && y <= box.y + s) return 'nw';
    if (x >= r - 8 && x <= r + 8) return 'e';
    if (x >= box.x - 8 && x <= box.x + 8) return 'w';
    if (y >= b - 8 && y <= b + 8) return 's';
    if (y >= box.y - 8 && y <= box.y + 8) return 'n';
    return null;
  }
  const snap = (v: number, g = 1) => Math.round(v / g) * g;

  const activeBoxes = boxesMap[activeIdx] || [];

  const updateBoxesForIndex = (index: number, updater: (prev: CropBox[]) => CropBox[]) => {
    setBoxesMap(prev => ({ ...prev, [index]: updater(prev[index] || []) }));
  };
  const updateBoxes = (updater: (prev: CropBox[]) => CropBox[]) => {
    updateBoxesForIndex(activeIdx, updater);
  };

  const addCropBox = (index?: number) => {
    const i = index ?? activeIdx;
    const prefix = getVendorPrefix(selectedVendorId);
    updateBoxesForIndex(i, prev => {
      const nid = (prev.reduce((m, b) => Math.max(m, b.id), 0) || 0) + 1;
      const colors = ['#00ff00', '#ff0000', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffa500', '#800080'];
      return [...prev, { 
  id: nid, x: 60 + nid * 10, y: 60 + nid * 10, width: 400, height: 120,
  itemNumber: prefix, color: colors[nid % colors.length], rotation: 0,
  // ✅ 스크린샷 모드일 땐 기본 플립 ON
  flipVertical: mode === 'screenshot'
}];
    });
  };
  const removeCropBox = (id: number) => updateBoxes(prev => prev.length > 1 ? prev.filter(b => b.id !== id) : prev);
  const updateCropBox = (id: number, updates: Partial<CropBox>) => {
    updateBoxes(prev => prev.map(b => {
      if (b.id !== id) return b;
      const nb = { ...b, ...updates };
      if (updates.itemNumber !== undefined && selectedVendorId) nb.itemNumber = formatItemNumber(updates.itemNumber, selectedVendorId);
      return nb;
    }));
  };

  /** ===== 줌 컨트롤(버튼 전용) ===== */
  const handleZoomIn = useCallback(() => {
    setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)));
  }, []);
  const handleZoomOut = useCallback(() => {
    setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)));
  }, []);
  const handleResetView = useCallback(() => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  }, []);

  /** ===== 캔버스 핸들러 ===== */
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>, index: number) => {
    if (activeIdx !== index) setActiveIdx(index);
    const canvas = canvasRefs.current.get(index); if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    const scale = parseFloat(canvas.dataset['scale'] ?? '1');
    const pan = index === activeIdx ? panOffset : { x: 0, y: 0 };
    const ox = (x - pan.x) / scale, oy = (y - pan.y) / scale;

    const boxes = boxesMap[index] || [];
    for (const box of boxes) {
      if (ox >= box.x - 15 && ox <= box.x + box.width + 15 && oy >= box.y - 15 && oy <= box.y + box.height + 15) {
        const h = getResizeHandle(ox, oy, box);
        if (h) {
          setIsResizing(true);
          setResizeHandle(h);
          setActiveCropId(box.id);
          setDragStart({ x: ox, y: oy });
          resizeStartBoxRef.current = box;
          return;
        }
      }
    }
    for (const box of boxes) {
      if (ox >= box.x && ox <= box.x + box.width && oy >= box.y && oy <= box.y + box.height) {
        setIsDragging(true); setActiveCropId(box.id); setDragStart({ x: ox - box.x, y: oy - box.y }); return;
      }
    }
    if (e.shiftKey || (index === activeIdx && zoom > 1)) {
      setIsPanning(true); setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  }, [activeIdx, panOffset, zoom, boxesMap]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>, index: number) => {
    const canvas = canvasRefs.current.get(index); if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (isPanning && index === activeIdx) { setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }); return; }

    const scale = parseFloat(canvas.dataset['scale'] ?? '1');
    const W = parseFloat(canvas.dataset['originalWidth'] ?? canvas.width.toString());
    const H = parseFloat(canvas.dataset['originalHeight'] ?? canvas.height.toString());
    const pan = index === activeIdx ? panOffset : { x: 0, y: 0 };
    const ox = (x - pan.x) / scale, oy = (y - pan.y) / scale;

    const boxes = boxesMap[index] || [];

    if (isResizing && activeCropId && resizeHandle) {
      const originalBox = resizeStartBoxRef.current;
      if (!originalBox) return;
      setBoxesMap(prev => {
        const next = { ...prev };
        next[index] = (prev[index] || []).map(box => {
          if (box.id !== activeCropId) return box;
          const dx = ox - dragStart.x, dy = oy - dragStart.y;
          let nx = box.x, ny = box.y, nw = box.width, nh = box.height;
          switch (resizeHandle) {
            case 'se': nw = Math.max(50, originalBox.width + dx); nh = Math.max(20, originalBox.height + dy); break;
            case 'ne': nw = Math.max(50, originalBox.width + dx); nh = Math.max(20, originalBox.height - dy); ny = originalBox.y + dy; break;
            case 'sw': nw = Math.max(50, originalBox.width - dx); nh = Math.max(20, originalBox.height + dy); nx = originalBox.x + dx; break;
            case 'nw': nw = Math.max(50, originalBox.width - dx); nh = Math.max(20, originalBox.height - dy); nx = originalBox.x + dx; ny = originalBox.y + dy; break;
            case 'e': nw = Math.max(50, originalBox.width + dx); break;
            case 'w': nw = Math.max(50, originalBox.width - dx); nx = originalBox.x + dx; break;
            case 's': nh = Math.max(20, originalBox.height + dy); break;
            case 'n': nh = Math.max(20, originalBox.height - dy); ny = originalBox.y + dy; break;
          }
          nx = Math.max(0, Math.min(W - nw, nx));
          ny = Math.max(0, Math.min(H - nh, ny));
          return { ...box, x: nx, y: ny, width: nw, height: nh };
        });
        return next;
      });
    } else if (isDragging && activeCropId) {
      setBoxesMap(prev => {
        const next = { ...prev };
        next[index] = (prev[index] || []).map(b => {
          if (b.id !== activeCropId) return b;
          const nx = Math.max(0, Math.min(W - b.width, snap(ox - dragStart.x)));
          const ny = Math.max(0, Math.min(H - b.height, snap(oy - dragStart.y)));
          return { ...b, x: nx, y: ny };
        });
        return next;
      });
    } else {
      let cursor = ((index === activeIdx) && (zoom > 1 || e.shiftKey)) ? 'grab' : 'default';
      for (const box of boxes) {
        if (ox >= box.x - 15 && ox <= box.x + box.width + 15 && oy >= box.y - 15 && oy <= box.y + box.height + 15) {
          const h = getResizeHandle(ox, oy, box);
          if (h) cursor = 'nwse-resize';
          else if (ox >= box.x && ox <= box.x + box.width && oy >= box.y && oy <= box.y + box.height) cursor = 'move';
          break;
        }
      }
      canvas.style.cursor = cursor;
    }
  }, [boxesMap, isPanning, panStart, panOffset, isResizing, activeCropId, resizeHandle, zoom, dragStart, activeIdx]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setIsResizing(false);
    setIsPanning(false);
    setResizeHandle(null);
    setDragStart({ x: 0, y: 0 });
    setPanStart({ x: 0, y: 0 });
    resizeStartBoxRef.current = null;
  }, []);

  // 휠/트랙패드 스크롤로는 절대 줌 안 되게 (index 인수 있어도 무시)
  const handleWheel = useCallback((e: React.WheelEvent<HTMLDivElement>, _index?: number) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  /** ===== 캔버스 렌더링 ===== */
  const drawCanvas = useCallback((index: number) => {
    const imageUrl = previews[index];
    if (!imageUrl) return;
    const canvas = canvasRefs.current.get(index); if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const useZoom = index === activeIdx ? zoom : 1;
      const usePan = index === activeIdx ? panOffset : { x: 0, y: 0 };
      const maxW = 900, maxH = 640;
      const base = Math.min(maxW / img.width, maxH / img.height, 1);
      const scale = base * useZoom;

      const cw = Math.min(maxW, img.width * scale + Math.abs(usePan.x));
      const ch = Math.min(maxH, img.height * scale + Math.abs(usePan.y));
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);

      canvas.dataset['scale'] = scale.toString();
      canvas.dataset['originalWidth'] = img.width.toString();
      canvas.dataset['originalHeight'] = img.height.toString();

      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(usePan.x, usePan.y);
      ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
      ctx.restore();

      const bxs = boxesMap[index] || [];
      ctx.save(); ctx.translate(usePan.x, usePan.y);
      bxs.forEach(box => {
        const sb = { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
        ctx.save();
        if (box.rotation && box.rotation !== 0) {
          const cx = sb.x + sb.width / 2, cy = sb.y + sb.height / 2;
          ctx.translate(cx, cy); ctx.rotate((box.rotation * Math.PI) / 180); ctx.translate(-cx, -cy);
        }
        ctx.strokeStyle = box.color; ctx.lineWidth = (activeCropId === box.id && index === activeIdx ? 3 : 2); ctx.setLineDash([5, 5]);
        ctx.strokeRect(sb.x, sb.y, sb.width, sb.height); ctx.setLineDash([]);

        const hs = 8; ctx.fillStyle = 'white'; ctx.strokeStyle = box.color; ctx.lineWidth = 2;
        const corners: [number, number][] = [[sb.x, sb.y], [sb.x + sb.width, sb.y], [sb.x, sb.y + sb.height], [sb.x + sb.width, sb.y + sb.height]];
        corners.forEach(([cx, cy]) => { ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs); ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs); });
        const edges: [number, number][] = [[sb.x + sb.width / 2, sb.y], [sb.x + sb.width / 2, sb.y + sb.height], [sb.x, sb.y + sb.height / 2], [sb.x + sb.width, sb.y + sb.height / 2]];
        edges.forEach(([ex, ey]) => { ctx.fillRect(ex - 4, ey - 4, 8, 8); ctx.strokeRect(ex - 4, ey - 4, 8, 8); });

        ctx.fillStyle = box.color; ctx.font = '12px system-ui';
        ctx.fillText(`#${box.id}`, sb.x + 5, sb.y + 14);
        if (box.itemNumber) ctx.fillText(box.itemNumber, sb.x + 5, sb.y + sb.height - 5);

        if (box.flipVertical) {
          ctx.fillStyle = '#ef4444';
          ctx.font = 'bold 12px system-ui';
          ctx.fillText('↕︎ FLIP', sb.x + sb.width - 48, sb.y + sb.height - 6);
        }
        if (box.rotation && box.rotation !== 0) {
          ctx.fillStyle = 'red'; ctx.font = '10px system-ui'; ctx.fillText(`${(box.rotation || 0).toFixed(2)}°`, sb.x + sb.width - 34, sb.y + 12);
        }
        ctx.restore();
      });
      ctx.restore();
    };
    img.src = imageUrl;
  }, [previews, boxesMap, activeIdx, activeCropId, zoom, panOffset]);

  useEffect(() => {
    previews.forEach((_, i) => drawCanvas(i));
  }, [previews, boxesMap, activeIdx, activeCropId, zoom, panOffset, viewMode, drawCanvas]);

  /** ===== 저장 ===== */
  function transform(box: CropBox) {
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.round(box.width),
      height: Math.round(box.height),
      rotation: box.rotation || 0,
    };
  }
  function buildCropPayloadForIndex(idx: number) {
    const bxs = boxesMap[idx] || [];
    const valid = bxs.filter(b => (b.itemNumber || '').trim());
    return valid.map(b => ({
      ...transform(b),
      itemNumber: b.itemNumber.trim(),
      flipVertical: !!b.flipVertical,
    }));
  }
  const handleSaveAllCrops = useCallback(async () => {
    if (!selectedVendorId || !files.length) return;

    const hasAny = Object.keys(boxesMap).some(k => (boxesMap[+k] || []).some(b => (b.itemNumber || '').trim()));
    if (!hasAny) return;

    setIsProcessing(true);
    setCurrentStep(`Uploading ${files.length} image(s) ...`);

    try {
      const all: CroppedMoulding[] = [];
      for (let i = 0; i < files.length; i++) {
        const cropData = buildCropPayloadForIndex(i);
        if (!cropData.length) continue;

        const fd = new FormData();
        fd.append('catalogImage', files[i]);
        fd.append('vendorId', selectedVendorId);
        fd.append('multipleCrops', JSON.stringify(cropData));

        const resp = await fetch('/api/multiple-crop-mouldings', { method: 'POST', body: fd });
        if (!resp.ok) throw new Error(await resp.text());
        const result = await resp.json();
        const got: CroppedMoulding[] = result.croppedMouldings || [];
        all.push(...got);
        setCurrentStep(`Saved ${all.length} cropped images so far...`);
      }

      setCroppedMouldings(all);
      setCurrentStep(`✅ Saved ${all.length} cropped images.`);
    } catch (err) {
      console.error(err);
      setCurrentStep('❌ Failed to save crops. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  }, [files, boxesMap, selectedVendorId]);

  // 썸네일 클릭 포커스
  const setActiveByThumb = (i: number) => {
    setActiveIdx(i);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
    setActiveCropId(null);
  };

  // 미리보기 URL 정리
  useEffect(() => {
    return () => { previews.forEach((u) => URL.revokeObjectURL(u)); };
  }, [previews]);

  // 키보드(포커스 이미지 한정)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!activeCropId) return;
      const step = e.shiftKey ? 10 : 1;
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) e.preventDefault();

      const boxes = boxesMap[activeIdx] || [];
      const cur = boxes.find(b => b.id === activeCropId);
      if (!cur) return;

      if (e.key === 'ArrowLeft')  updateCropBox(activeCropId, { x: Math.max(0, cur.x - step) });
      if (e.key === 'ArrowRight') updateCropBox(activeCropId, { x: cur.x + step });
      if (e.key === 'ArrowUp')    updateCropBox(activeCropId, { y: Math.max(0, cur.y - step) });
      if (e.key === 'ArrowDown')  updateCropBox(activeCropId, { y: cur.y + step });

      if (e.key === '[') updateCropBox(activeCropId, { rotation: ((cur.rotation || 0) - 0.15) });
      if (e.key === ']') updateCropBox(activeCropId, { rotation: ((cur.rotation || 0) + 0.15) });

      if ((e.key === 'Backspace' || e.key === 'Delete') && boxes.length > 1) {
        removeCropBox(activeCropId);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeCropId, activeIdx, boxesMap]);

  // ====== JSX ======
  return (
    <div>
      {/* Top Controls */}
      <div className="card">
        <h2 style={{ margin: 0 }}>🧠 Smart Moulding Cropper (Standalone)</h2>
        <p className="muted">
          Select a vendor, choose a <b>Mode</b>, upload up to <b>5 images</b>, adjust boxes, then Save All.
        </p>

        <div className="row" style={{ gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {/* Vendor */}
          <div style={{ minWidth: 220 }}>
            <label>Vendor</label>
            <select value={selectedVendorId} onChange={(e) => handleVendorChange(e.target.value)}>
              <option value="">Choose a vendor</option>
              {VENDORS.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>

          {/* Mode */}
          <div>
            <label>Mode</label>
            <div className="toolbar">
              <button
                className="ghost"
                onClick={() => setMode('catalog')}
                style={{ background: mode === 'catalog' ? '#111827' : 'white', color: mode === 'catalog' ? 'white' : '#111827' }}
                title="PDF/Catalog image workflow"
              >
                Catalog / PDF
              </button>
              <button
                className="ghost"
                onClick={() => setMode('screenshot')}
                style={{ background: mode === 'screenshot' ? '#111827' : 'white', color: mode === 'screenshot' ? 'white' : '#111827' }}
                title="Nurre Caxton screenshots"
              >
                Nurre Caxton (Screenshot)
              </button>
            </div>
          </div>

          {/* View */}
          <div>
            <label>View</label>
            <div className="toolbar">
              <button
                className="ghost"
                onClick={() => setViewMode('single')}
                style={{ background: viewMode === 'single' ? '#111827' : 'white', color: viewMode === 'single' ? 'white' : '#111827' }}
                title="Show one image at a time"
              >
                Single
              </button>
              <button
                className="ghost"
                onClick={() => setViewMode('all')}
                style={{ background: viewMode === 'all' ? '#111827' : 'white', color: viewMode === 'all' ? 'white' : '#111827' }}
                title="Show all images on one page"
              >
                All
              </button>
            </div>
          </div>

          {/* Upload */}
          <div style={{ flex: 1, minWidth: 280 }}>
            <label>{mode === 'screenshot' ? 'Screenshot Images (max 5)' : 'Catalog Images (max 5)'}</label>
            <input ref={catalogInputRef} type="file" accept="image/*" multiple onChange={handleMultiUpload} />
            {files.length > 0 && (
              <div className="muted">
                Selected: {files.length} file{files.length > 1 ? 's' : ''} {viewMode === 'single' ? `(showing #${activeIdx + 1})` : '(All)'}
              </div>
            )}
          </div>

          {/* Zoom — 버튼 전용 */}
          <div className="toolbar">
            <button className="ghost" onClick={handleZoomOut} disabled={zoom <= 0.5}>−</button>
            <span className="badge">{Math.round(zoom * 100)}%</span>
            <button className="ghost" onClick={handleZoomIn} disabled={zoom >= 3}>+</button>
            <button className="ghost" onClick={handleResetView}>Reset View</button>
          </div>

          {/* Thumbs */}
          {previews.length > 0 && (
            <div className="row" style={{ gap: 8, marginTop: 10, overflowX: 'auto' }}>
              {previews.map((src, i) => (
                <button
                  key={i}
                  onClick={() => setActiveByThumb(i)}
                  className="ghost"
                  style={{
                    padding: 4,
                    border: i === activeIdx ? '2px solid #111827' : '1px solid #e5e7eb',
                    borderRadius: 8,
                    background: '#fff',
                  }}
                  title={`Open image #${i + 1}`}
                >
                  <img src={src} style={{ height: 56, width: 84, objectFit: 'cover', display: 'block', borderRadius: 6 }} />
                </button>
              ))}
            </div>
          )}

          <div className="muted" style={{ marginTop: 8 }}>{currentStep}</div>
        </div>
      </div>

      {/* Main work area */}
      {previews.length > 0 && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>
              🎛️ Manual Crop Selection {viewMode === 'single' ? `— Image #${activeIdx + 1}` : '— All Images'}
            </h3>
            <div className="toolbar" style={{ gap: 8 }}>
              {viewMode === 'single' && (
                <>
                  <button className="ghost" onClick={() => setActiveByThumb(Math.max(0, activeIdx - 1))} disabled={activeIdx <= 0}>← Prev</button>
                  <button className="ghost" onClick={() => setActiveByThumb(Math.min(previews.length - 1, activeIdx + 1))} disabled={activeIdx >= previews.length - 1}>Next →</button>
                </>
              )}
              <button onClick={() => addCropBox()}>+ Add Box</button>
              <button
                className="ghost"
                onClick={() => {
                  previews.forEach((u) => URL.revokeObjectURL(u));
                  setFiles([]); setPreviews([]); setBoxesMap({});
                  setActiveIdx(0); setActiveCropId(null);
                  setCroppedMouldings([]); setZoom(1); setPanOffset({ x: 0, y: 0 });
                  if (catalogInputRef.current) catalogInputRef.current.value = '';
                }}
              >
                Clear All
              </button>
            </div>
          </div>

          {viewMode === 'single' ? (
            <div className="row" style={{ gap: '16px' }}>
              {/* Left list */}
              <div style={{ width: 340 }}>
                <label>Crop Boxes ({activeBoxes.length})</label>
                <div
                  ref={listWrapRef}
                  className="list"
                  style={{
                    maxHeight: listMaxH ?? undefined,
                    overflowY: listMaxH ? 'auto' : 'visible',
                    overflowX: 'hidden',
                  }}
                >
                  {activeBoxes.map((box) => {
                    const active = activeCropId === box.id;
                    return (
                      <div
                        key={box.id}
                        ref={(el) => { if (el) rowRefs.current.set(box.id, el); }}
                        onClick={() => setActiveCropId(box.id)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                          border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 6,
                          background: active ? '#f0f9ff' : '#fff', cursor: 'pointer', minWidth: 0,
                        }}
                      >
                        <div style={{ width: 8, height: 8, borderRadius: 4, background: box.color, flex: '0 0 auto' }} />
                        <input
                          type="text"
                          value={box.itemNumber}
                          onChange={(e) => updateCropBox(box.id, { itemNumber: e.target.value })}
                          placeholder="Item #"
                          style={{
                            flex: '1 1 160px',
                            minWidth: 120,
                            height: 28,
                            fontSize: 14,
                            padding: '4px 10px',
                            border: '1px solid #d1d5db',
                            borderRadius: 8,
                            minInlineSize: 0,
                          }}
                        />
                        <button className="ghost" style={{ height: 26, width: 26, padding: 0, lineHeight: 1 }}
                          onClick={(e) => { e.stopPropagation(); updateCropBox(box.id, { rotation: (box.rotation || 0) - 0.15 }); }} title="-0.15°">⟲</button>
                        <span className="badge" style={{ height: 26, minWidth: 42, display: 'inline-grid', placeItems: 'center', padding: '0 4px', fontSize: 11, flex: '0 0 auto' }}>
                          {(box.rotation || 0).toFixed(2)}°
                        </span>
                        <button className="ghost" style={{ height: 26, width: 26, padding: 0, lineHeight: 1 }}
                          onClick={(e) => { e.stopPropagation(); updateCropBox(box.id, { rotation: (box.rotation || 0) + 0.15 }); }} title="+0.15°">⟳</button>
                        <button
                          className="ghost"
                          style={{ height: 26, padding: '0 8px', lineHeight: 1, border: box.flipVertical ? '1px solid #111827' : '1px solid #e5e7eb', borderRadius: 6 }}
                          onClick={(e) => { e.stopPropagation(); updateCropBox(box.id, { flipVertical: !box.flipVertical }); }}
                          title="Flip vertically on save"
                        >
                          ↕
                        </button>
                        <span className="muted" style={{ fontSize: 10, whiteSpace: 'nowrap', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', flex: '0 1 auto' }}
                          title={`${Math.round(box.width)}×${Math.round(box.height)}px`}>
                          {Math.round(box.width)}×{Math.round(box.height)}px
                        </span>
                        {activeBoxes.length > 1 && (
                          <button className="danger" style={{ height: 28, width: 28, padding: 0, marginLeft: 2, flex: '0 0 auto' }}
                            onClick={(e) => { e.stopPropagation(); removeCropBox(box.id); }} title="Remove">✕
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Canvas (Single) */}
              <div
                ref={previewWrapRef}
                onWheel={(e) => handleWheel(e, activeIdx)}
                style={{ overflow: 'auto', maxHeight: 640, border: '1px solid #d1d5db', borderRadius: 8 }}
              >
                <p className="muted" style={{ padding: '8px 8px 0 8px' }}>
                  📦 Drag to move | ◻︎ handles to resize | Hold Shift or zoom-in to pan the image
                </p>
                <canvas
                  ref={setCanvasRef(activeIdx)}
                  onMouseDown={(e) => handleMouseDown(e, activeIdx)}
                  onMouseMove={(e) => handleMouseMove(e, activeIdx)}
                  onMouseUp={handleMouseUp}
                  onMouseLeave={handleMouseUp}
                  style={{ display: 'block', margin: '0 auto' }}
                />
              </div>
            </div>
          ) : (
            // ALL 뷰
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
              {previews.map((_, i) => {
                const boxes = boxesMap[i] || [];
                const isActive = i === activeIdx;
                return (
                  <div key={i} className="card" style={{ border: '1px solid #e5e7eb', borderRadius: 8 }}>
                    <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ fontWeight: 600 }}>Image #{i + 1} · Crop Boxes ({boxes.length}) {isActive ? '• Focused' : ''}</div>
                      <div className="toolbar" style={{ gap: 8 }}>
                        <button className="ghost" onClick={() => setActiveIdx(i)} title="Focus this image">Focus</button>
                        <button className="ghost" onClick={() => addCropBox(i)}>+ Add Box</button>
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: '16px' }}>
                      {/* 왼쪽 리스트 */}
                      <div style={{ maxHeight: 360, overflow: 'auto' }}>
                        {boxes.map((box) => {
                          const active = activeCropId === box.id && isActive;
                          return (
                            <div
                              key={box.id}
                              onClick={() => { setActiveIdx(i); setActiveCropId(box.id); }}
                              style={{
                                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 8px',
                                border: '1px solid #e5e7eb', borderRadius: 12, marginBottom: 6,
                                background: active ? '#f0f9ff' : '#fff', cursor: 'pointer'
                              }}
                            >
                              <div style={{ width: 8, height: 8, borderRadius: 4, background: box.color }} />
                              <input
                                type="text"
                                value={box.itemNumber}
                                onChange={(e) => { setActiveIdx(i); setActiveCropId(box.id); updateCropBox(box.id, { itemNumber: e.target.value }); }}
                                placeholder="Item #"
                                style={{ flex: 1, minWidth: 120, height: 28, fontSize: 14, padding: '4px 10px', border: '1px solid #d1d5db', borderRadius: 8 }}
                              />
                              <button className="ghost" style={{ height: 26, width: 26, padding: 0 }}
                                onClick={(e) => { e.stopPropagation(); setActiveIdx(i); setActiveCropId(box.id); updateCropBox(box.id, { rotation: (box.rotation || 0) - 0.15 }); }} title="-0.15°">⟲</button>
                              <span className="badge" style={{ height: 26, minWidth: 42, display: 'inline-grid', placeItems: 'center', fontSize: 11 }}>
                                {(box.rotation || 0).toFixed(2)}°
                              </span>
                              <button className="ghost" style={{ height: 26, width: 26, padding: 0 }}
                                onClick={(e) => { e.stopPropagation(); setActiveIdx(i); setActiveCropId(box.id); updateCropBox(box.id, { rotation: (box.rotation || 0) + 0.15 }); }} title="+0.15°">⟳</button>
                              <button className="ghost" style={{ height: 26, padding: '0 8px', lineHeight: 1, border: box.flipVertical ? '1px solid #111827' : '1px solid #e5e7eb', borderRadius: 6 }}
                                onClick={(e) => { e.stopPropagation(); setActiveIdx(i); setActiveCropId(box.id); updateCropBox(box.id, { flipVertical: !box.flipVertical }); }} title="Flip vertically on save">↕</button>
                              {boxes.length > 1 && (
                                <button className="danger" style={{ height: 28, width: 28, padding: 0, marginLeft: 2 }}
                                  onClick={(e) => { e.stopPropagation(); setActiveIdx(i); setActiveCropId(box.id); removeCropBox(box.id); }} title="Remove">✕
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* 오른쪽 캔버스 */}
                      <div onWheel={(e) => handleWheel(e, i)} style={{ overflow: 'auto', maxHeight: 360, border: '1px solid #d1d5db', borderRadius: 8 }}>
                        <p className="muted" style={{ padding: '8px 8px 0 8px' }}>📦 Drag/Resize — 클릭/드래그하면 이 이미지가 포커스됩니다.</p>
                        <canvas
                          ref={setCanvasRef(i)}
                          onMouseDown={(e) => handleMouseDown(e, i)}
                          onMouseMove={(e) => handleMouseMove(e, i)}
                          onMouseUp={handleMouseUp}
                          onMouseLeave={handleMouseUp}
                          style={{ display: 'block', margin: '0 auto' }}
                          data-image-index={i}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="row" style={{ marginTop: 12 }}>
            <button
              onClick={handleSaveAllCrops}
              disabled={
                !selectedVendorId ||
                isProcessing ||
                !Object.values(boxesMap).some((bxs) => (bxs || []).some((b) => (b.itemNumber || '').trim()))
              }
            >
              ✂️ Save All Crops
            </button>
          </div>
        </div>
      )}

      {/* Result grid */}
      {croppedMouldings.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>📦 Cropped Mouldings ({croppedMouldings.length})</h3>
          <div className="grid">
            {croppedMouldings.slice(0, 12).map((m) => (
              <div key={m.id} className="thumb">
                <img src={m.imageUrl} alt={m.detectedNumber} style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} />
                <div className="muted">{m.detectedNumber} {m.csvData ? '• CSV matched' : ''}</div>
              </div>
            ))}
            {croppedMouldings.length > 12 && (
              <div className="thumb" style={{ display: 'grid', placeItems: 'center', color: '#6b7280' }}>
                +{croppedMouldings.length - 12} more
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
