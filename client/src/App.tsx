// client/src/App.tsx
import React, { useState, useRef, useCallback, useEffect } from 'react';

type Vendor = { id: number; name: string };
type CropBox = {
  id: number;
  x: number; y: number; width: number; height: number;
  itemNumber: string; color: string; rotation?: number;
};
type CroppedMoulding = {
  id: string; imageUrl: string; detectedNumber: string;
  csvData?: { name: string; description: string; width: string; pricePerFoot: string };
};

const VENDORS: Vendor[] = [
  { id: 1, name: 'Presto Moulding' },
  { id: 2, name: 'Studio Moulding' },
  { id: 3, name: 'Décor Moulding' },
  { id: 4, name: 'Bella Moulding' },
  { id: 5, name: 'Metro Moulding' },
];

function getVendorPrefix(vendorId: string) {
  const vendor = VENDORS.find(v => v.id.toString() === vendorId);
  if (!vendor) return '';
  const m: Record<string, string> = {
    'Presto Moulding': 'PR',
    'Studio Moulding': 'ST',
    'Décor Moulding': 'DM',
    'Bella Moulding': 'BM',
    'Metro Moulding': 'MM',
  };
  return m[vendor.name] || '';
}
function formatItemNumber(n: string, vendorId: string) {
  const p = getVendorPrefix(vendorId);
  if (!p) return n;
  if (n.startsWith(p)) return n;
  const clean = n.replace(/^[A-Z]{1,3}/, '');
  return p + clean;
}

export default function App() {
  const [selectedVendorId, setSelectedVendorId] = useState('');
  const [catalogImage, setCatalogImage] = useState<File | null>(null);
  const [imagePreviewUrl, setImagePreviewUrl] = useState('');
  const [showManualCrop, setShowManualCrop] = useState(false);

  const [cropBoxes, setCropBoxes] = useState<CropBox[]>([
    { id: 1, x: 50, y: 50, width: 400, height: 120, itemNumber: '', color: '#00ff00', rotation: 0 },
  ]);
  const [croppedMouldings, setCroppedMouldings] = useState<CroppedMoulding[]>([]);

  const [isProcessing, setIsProcessing] = useState(false);
  const [progress] = useState(0);
  const [currentStep, setCurrentStep] = useState('');

  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0 });

  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [activeCropId, setActiveCropId] = useState<number | null>(null);
  const [resizeHandle, setResizeHandle] = useState<string | null>(null);

  const catalogInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 좌측 리스트 높이를 프리뷰 높이에 맞추고, 선택 시 자동 스크롤
  const previewWrapRef = useRef<HTMLDivElement>(null);
  const listWrapRef = useRef<HTMLDivElement>(null);
  const [listMaxH, setListMaxH] = useState<number | null>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());

  useEffect(() => {
    if (!showManualCrop) { setListMaxH(null); return; }
    const el = previewWrapRef.current; if (!el) return;
    setListMaxH(Math.floor(el.getBoundingClientRect().height));
    const ro = new ResizeObserver(entries => setListMaxH(Math.floor(entries[0].contentRect.height)));
    ro.observe(el);
    const onWinResize = () => setListMaxH(Math.floor(el.getBoundingClientRect().height));
    window.addEventListener('resize', onWinResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onWinResize); };
  }, [showManualCrop]);

  useEffect(() => {
    if (!activeCropId || !listWrapRef.current) return;
    const row = rowRefs.current.get(activeCropId);
    if (row) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [activeCropId]);

  const handleVendorChange = (vid: string) => {
    setSelectedVendorId(vid);
    const prefix = getVendorPrefix(vid);
    if (prefix) {
      setCropBoxes(prev => prev.map(b => {
        if (b.itemNumber && !b.itemNumber.startsWith(prefix)) {
          const clean = b.itemNumber.replace(/^[A-Z]{1,3}/, '');
          return { ...b, itemNumber: prefix + clean };
        }
        return b;
      }));
    }
  };

  /**
   * 옛 방식: 서버가 준 itemNumbers만 사용해서 박스를 "세로 스택"으로 생성
   * - bbox 전혀 사용하지 않음
   */
  const detectItemNumbers = useCallback(async (imageFile: File) => {
    try {
      const fd = new FormData();
      fd.append('image', imageFile);
      const resp = await fetch('/api/detect-item-numbers', { method: 'POST', body: fd });
      const result = await resp.json();

      const itemNumbers: string[] = result.itemNumbers || [];
      const colors = ['#00ff00', '#ff0000', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#ffa500', '#800080'];
      const prefix = getVendorPrefix(selectedVendorId);

      const BOX_W = 420;
      const BOX_H = 120;
      const margin = 10;

      const boxes: CropBox[] = (itemNumbers.length ? itemNumbers : ['']).map((num, i) => {
        const cleanNum = (num || '').replace(/^[A-Z]{1,3}/, '');
        const formatted = prefix ? prefix + cleanNum : (num || '');
        return {
          id: i + 1,
          x: 50,
          y: 50 + i * (BOX_H + margin),
          width: BOX_W,
          height: BOX_H,
          itemNumber: formatted,
          color: colors[i % colors.length],
          rotation: 0
        };
      });

      setCropBoxes(boxes);
    } catch (e) {
      console.error('OCR detection failed:', e);
      setCropBoxes([{ id: 1, x: 50, y: 50, width: 400, height: 120, itemNumber: '', color: '#00ff00', rotation: 0 }]);
    }
  }, [selectedVendorId]);

  const handleCatalogUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    setCatalogImage(file);
    const url = URL.createObjectURL(file);
    setImagePreviewUrl(url);
    setShowManualCrop(true);
    setCroppedMouldings([]);
    detectItemNumbers(file);
  }, [detectItemNumbers]);

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

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    const scale = parseFloat(canvas.dataset.scale || '1');
    const ox = (x - panOffset.x) / scale, oy = (y - panOffset.y) / scale;

    for (const box of cropBoxes) {
      if (ox >= box.x - 15 && ox <= box.x + box.width + 15 && oy >= box.y - 15 && oy <= box.y + box.height + 15) {
        const h = getResizeHandle(ox, oy, box);
        if (h) { setIsResizing(true); setResizeHandle(h); setActiveCropId(box.id); setDragStart({ x: ox, y: oy }); return; }
      }
    }
    for (const box of cropBoxes) {
      if (ox >= box.x && ox <= box.x + box.width && oy >= box.y && oy <= box.y + box.height) {
        setIsDragging(true); setActiveCropId(box.id); setDragStart({ x: ox - box.x, y: oy - box.y }); return;
      }
    }
    if (e.shiftKey || zoom > 1) {
      setIsPanning(true); setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
    }
  }, [cropBoxes, panOffset, zoom]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current; if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (isPanning) { setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y }); return; }

    const scale = parseFloat(canvas.dataset.scale || '1');
    const W = parseFloat(canvas.dataset.originalWidth || canvas.width.toString());
    const H = parseFloat(canvas.dataset.originalHeight || canvas.height.toString());
    const ox = (x - panOffset.x) / scale, oy = (y - panOffset.y) / scale;

    if (isResizing && activeCropId && resizeHandle) {
      setCropBoxes(prev => prev.map(box => {
        if (box.id !== activeCropId) return box;
        const orig = (box as any).orig || ((box as any).orig = { x: box.x, y: box.y, w: box.width, h: box.height });
        const dx = ox - dragStart.x, dy = oy - dragStart.y;
        let nx = box.x, ny = box.y, nw = box.width, nh = box.height;
        switch (resizeHandle) {
          case 'se': nw = Math.max(50, orig.w + dx); nh = Math.max(20, orig.h + dy); break;
          case 'ne': nw = Math.max(50, orig.w + dx); nh = Math.max(20, orig.h - dy); ny = orig.y + dy; break;
          case 'sw': nw = Math.max(50, orig.w - dx); nh = Math.max(20, orig.h + dy); nx = orig.x + dx; break;
          case 'nw': nw = Math.max(50, orig.w - dx); nh = Math.max(20, orig.h - dy); nx = orig.x + dx; ny = orig.y + dy; break;
          case 'e': nw = Math.max(50, orig.w + dx); break;
          case 'w': nw = Math.max(50, orig.w - dx); nx = orig.x + dx; break;
          case 's': nh = Math.max(20, orig.h + dy); break;
          case 'n': nh = Math.max(20, orig.h - dy); ny = orig.y + dy; break;
        }
        nx = Math.max(0, Math.min(W - nw, nx));
        ny = Math.max(0, Math.min(H - nh, ny));
        return { ...box, x: nx, y: ny, width: nw, height: nh };
      }));
    } else if (isDragging && activeCropId) {
      setCropBoxes(prev => prev.map(b => {
        if (b.id !== activeCropId) return b;
        const nx = Math.max(0, Math.min(W - b.width, snap(ox - dragStart.x)));
        const ny = Math.max(0, Math.min(H - b.height, snap(oy - dragStart.y)));
        return { ...b, x: nx, y: ny };
      }));
    } else {
      let cursor = (zoom > 1 || e.shiftKey) ? 'grab' : 'default';
      for (const box of cropBoxes) {
        if (ox >= box.x - 15 && ox <= box.x + box.width + 15 && oy >= box.y - 15 && oy <= box.y + box.height + 15) {
          const h = getResizeHandle(ox, oy, box);
          if (h) cursor = 'nwse-resize';
          else if (ox >= box.x && ox <= box.x + box.width && oy >= box.y && oy <= box.y + box.height) cursor = 'move';
          break;
        }
      }
      canvas.style.cursor = cursor;
    }
  }, [isPanning, panStart, panOffset, isResizing, activeCropId, resizeHandle, cropBoxes, zoom, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false); setIsResizing(false); setIsPanning(false); setResizeHandle(null);
    setDragStart({ x: 0, y: 0 }); setPanStart({ x: 0, y: 0 });
    setCropBoxes(prev => prev.map(b => { const n: any = { ...b }; delete n.orig; return n; }));
  }, []);

  // 캔버스 렌더링
  useEffect(() => {
    if (!showManualCrop || !imagePreviewUrl) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      const maxW = 900, maxH = 640;
      const base = Math.min(maxW / img.width, maxH / img.height, 1);
      const scale = base * zoom;
      const cw = Math.min(maxW, img.width * scale + Math.abs(panOffset.x));
      const ch = Math.min(maxH, img.height * scale + Math.abs(panOffset.y));
      canvas.width = cw; canvas.height = ch;
      canvas.dataset.scale = scale.toString();
      canvas.dataset.originalWidth = img.width.toString();
      canvas.dataset.originalHeight = img.height.toString();

      ctx.clearRect(0, 0, cw, ch);
      ctx.save();
      ctx.translate(panOffset.x, panOffset.y);
      ctx.drawImage(img, 0, 0, img.width * scale, img.height * scale);
      ctx.restore();

      ctx.save(); ctx.translate(panOffset.x, panOffset.y);
      cropBoxes.forEach(box => {
        const sb = { x: box.x * scale, y: box.y * scale, width: box.width * scale, height: box.height * scale };
        ctx.save();
        if (box.rotation && box.rotation !== 0) {
          const cx = sb.x + sb.width / 2, cy = sb.y + sb.height / 2;
          ctx.translate(cx, cy); ctx.rotate((box.rotation * Math.PI) / 180); ctx.translate(-cx, -cy);
        }
        ctx.strokeStyle = box.color; ctx.lineWidth = (activeCropId === box.id ? 3 : 2); ctx.setLineDash([5, 5]);
        ctx.strokeRect(sb.x, sb.y, sb.width, sb.height); ctx.setLineDash([]);

        const hs = 8; ctx.fillStyle = 'white'; ctx.strokeStyle = box.color; ctx.lineWidth = 2;
        const corners: [number, number][] = [[sb.x, sb.y], [sb.x + sb.width, sb.y], [sb.x, sb.y + sb.height], [sb.x + sb.width, sb.y + sb.height]];
        corners.forEach(([cx, cy]) => { ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs); ctx.strokeRect(cx - hs / 2, cy - hs / 2, hs, hs); });
        const edges: [number, number][] = [[sb.x + sb.width / 2, sb.y], [sb.x + sb.width / 2, sb.y + sb.height], [sb.x, sb.y + sb.height / 2], [sb.x + sb.width, sb.y + sb.height / 2]];
        edges.forEach(([ex, ey]) => { ctx.fillRect(ex - 4, ey - 4, 8, 8); ctx.strokeRect(ex - 4, ey - 4, 8, 8); });

        ctx.fillStyle = box.color; ctx.font = '12px system-ui';
        ctx.fillText(`#${box.id}`, sb.x + 5, sb.y + 14);
        if (box.itemNumber) ctx.fillText(box.itemNumber, sb.x + 5, sb.y + sb.height - 5);
        if (box.rotation && box.rotation !== 0) { ctx.fillStyle = 'red'; ctx.font = '10px system-ui'; ctx.fillText(`${(box.rotation || 0).toFixed(1)}°`, sb.x + sb.width - 28, sb.y + 12); }
        ctx.restore();
      });
      ctx.restore();
    };
    img.src = imagePreviewUrl;
  }, [showManualCrop, imagePreviewUrl, cropBoxes, activeCropId, zoom, panOffset]);

  const addCropBox = () => {
    const nid = Math.max(...cropBoxes.map(b => b.id)) + 1;
    const colors = ['#00ff00', '#ff0000', '#0000ff', '#ffff00', '#ff00ff', '#00ffff'];
    setCropBoxes(prev => [...prev, {
      id: nid, x: 50 + nid * 20, y: 50 + nid * 20, width: 400, height: 120,
      itemNumber: getVendorPrefix(selectedVendorId), color: colors[nid % colors.length], rotation: 0,
    }]);
  };
  const removeCropBox = (id: number) => { if (cropBoxes.length > 1) setCropBoxes(prev => prev.filter(b => b.id !== id)); };
  const updateCropBox = (id: number, updates: Partial<CropBox>) => {
    setCropBoxes(prev => prev.map(b => {
      if (b.id !== id) return b;
      const nb = { ...b, ...updates };
      if (updates.itemNumber !== undefined && selectedVendorId) nb.itemNumber = formatItemNumber(updates.itemNumber, selectedVendorId);
      return nb;
    }));
  };

  function transform(box: CropBox) {
    return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height), rotation: box.rotation || 0 };
  }

  const handleSaveAllCrops = async () => {
    if (!catalogImage || !selectedVendorId) return;
    const valid = cropBoxes.filter(b => b.itemNumber.trim());
    if (!valid.length) return;
    setIsProcessing(true); setCurrentStep(`Processing ${valid.length} crops...`);
    try {
      const fd = new FormData();
      fd.append('catalogImage', catalogImage);
      fd.append('vendorId', selectedVendorId);
      const cropData = valid.map(b => ({ ...transform(b), itemNumber: b.itemNumber.trim() }));
      fd.append('multipleCrops', JSON.stringify(cropData));
      const resp = await fetch('/api/multiple-crop-mouldings', { method: 'POST', body: fd });
      if (!resp.ok) throw new Error(await resp.text());
      const result = await resp.json();
      setCroppedMouldings(result.croppedMouldings || []);
      setCurrentStep(`Successfully cropped ${result.croppedMouldings?.length || 0} mouldings!`);
    } catch (e) {
      console.error('Multiple crop error', e); setCurrentStep('Crop failed - please try again');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h2 style={{ margin: 0 }}>🧠 Smart Moulding Cropper (Standalone)</h2>
        <p className="muted">Select a vendor, upload an image, adjust boxes, then Save All.</p>
        <div className="row">
          <div style={{ minWidth: 220 }}>
            <label>Vendor</label>
            <select value={selectedVendorId} onChange={e => handleVendorChange(e.target.value)}>
              <option value="">Choose a vendor</option>
              {VENDORS.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <label>Catalog Image</label>
            <input ref={catalogInputRef} type="file" accept="image/*" onChange={handleCatalogUpload} />
            {catalogImage && <div className="muted">Selected: {catalogImage.name}</div>}
          </div>
          <div className="toolbar">
            <button className="ghost" onClick={() => setZoom(Math.max(0.5, zoom - 0.25))} disabled={zoom <= 0.5}>−</button>
            <span className="badge">{Math.round(zoom * 100)}%</span>
            <button className="ghost" onClick={() => setZoom(Math.min(3, zoom + 0.25))} disabled={zoom >= 3}>+</button>
            <button className="ghost" onClick={() => { setZoom(1); setPanOffset({ x: 0, y: 0 }); }}>Reset View</button>
          </div>
        </div>
        <div className="muted">{currentStep}</div>
      </div>

      {showManualCrop && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h3 style={{ margin: 0 }}>🎛️ Manual Crop Selection</h3>
            <div className="toolbar">
              <button onClick={addCropBox}>+ Add Box</button>
              <button className="ghost" onClick={() => {
                setShowManualCrop(false); setImagePreviewUrl(''); setCatalogImage(null);
                setCropBoxes([{ id: 1, x: 50, y: 50, width: 400, height: 120, itemNumber: '', color: '#00ff00', rotation: 0 }]);
                if (catalogInputRef.current) catalogInputRef.current.value = '';
              }}>Cancel</button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '16px' }}>
            {/* 왼쪽 리스트 - 프리뷰 높이에 맞춰 자동 스크롤 (COMPACT) */}
            <div>
              <label>Crop Boxes ({cropBoxes.length})</label>
              <div
  ref={listWrapRef}
  className="list"
  style={{
    maxHeight: listMaxH ?? undefined,
    overflowY: listMaxH ? 'auto' : 'visible',
    overflowX: 'hidden',          // ⬅️ 가로 스크롤 제거
  }}
>

{cropBoxes.map((box) => {
  const active = activeCropId === box.id;
  return (
    <div
      key={box.id}
      ref={(el) => { if (el) rowRefs.current.set(box.id, el); }}
      onClick={() => setActiveCropId(box.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px',
        border: '1px solid #e5e7eb',
        borderRadius: 12,
        marginBottom: 6,
        background: active ? '#f0f9ff' : '#fff',
        cursor: 'pointer',
        minWidth: 0,               // ⬅️ flex 자식이 줄어들 수 있게
      }}
    >
      {/* 색 점 */}
      <div style={{ width: 8, height: 8, borderRadius: 4, background: box.color, flex: '0 0 auto' }} />

      {/* 아이템 번호: 항상 보이도록 flex:1 + 최소폭 보장 */}
      <input
        type="text"
        value={box.itemNumber}
        onChange={(e) => updateCropBox(box.id, { itemNumber: e.target.value })}
        placeholder="Item #"
        style={{
          flex: '1 1 180px',       // ⬅️ 남는 폭을 우선 가져감
          minWidth: 140,           // ⬅️ 너무 작아지지 않게
          height: 28,
          fontSize: 14,
          padding: '4px 10px',
          border: '1px solid #d1d5db',
          borderRadius: 8,
          minInlineSize: 0,        // ⬅️ 사파리/크롬에서 축소 허용
        }}
      />

      {/* 회전 -0.5 (아이콘형, 초소형) */}
      <button
        className="ghost"
        style={{ height: 26, width: 26, padding: 0, lineHeight: 1 }}
        onClick={(e) => { e.stopPropagation(); updateCropBox(box.id, { rotation: (box.rotation || 0) - 0.25 }); }}
        title="-0.5°"
      >
        ⟲
      </button>

      {/* 각도 배지: 아주 작게 */}
      <span
        className="badge"
        style={{
          height: 26,
          minWidth: 38,
          display: 'inline-grid',
          placeItems: 'center',
          padding: '0 4px',
          fontSize: 11,
          flex: '0 0 auto',
        }}
      >
        {(box.rotation || 0).toFixed(1)}°
      </span>

      {/* 회전 +0.5 (아이콘형) */}
      <button
        className="ghost"
        style={{ height: 26, width: 26, padding: 0, lineHeight: 1 }}
        onClick={(e) => { e.stopPropagation(); updateCropBox(box.id, { rotation: (box.rotation || 0) + 0.25 }); }}
        title="+0.5°"
      >
        ⟳
      </button>

      {/* px 라벨: 더 작게, 잘림 방지(ellipsis), 줄바꿈 없음 */}
      <span
        className="muted"
        style={{
          fontSize: 10,
          whiteSpace: 'nowrap',
          maxWidth: 90,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          flex: '0 1 auto',        // ⬅️ 필요하면 줄어듦
        }}
        title={`${Math.round(box.width)}×${Math.round(box.height)}px`}
      >
        {Math.round(box.width)}×{Math.round(box.height)}px
      </span>

      {/* 삭제 버튼: 작게 고정폭 */}
      {cropBoxes.length > 1 && (
        <button
          className="danger"
          style={{ height: 28, width: 28, padding: 0, marginLeft: 2, flex: '0 0 auto' }}
          onClick={(e) => { e.stopPropagation(); removeCropBox(box.id); }}
          title="Remove"
        >
          ✕
        </button>
      )}
    </div>
  );
})}


              </div>
            </div>

            {/* 프리뷰(캔버스) 래퍼 */}
            <div
              ref={previewWrapRef}
              style={{ overflow: 'auto', maxHeight: 640, border: '1px solid #d1d5db', borderRadius: 8 }}
            >
              <p className="muted" style={{ padding: '8px 8px 0 8px' }}>
                📦 Drag to move | ◻︎ handles to resize | Hold Shift or zoom-in to pan the image
              </p>
              <canvas
                ref={canvasRef}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                style={{ display: 'block', margin: '0 auto' }}
              />
            </div>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <button
              onClick={handleSaveAllCrops}
              disabled={!catalogImage || !selectedVendorId || isProcessing || !cropBoxes.some(b => b.itemNumber.trim())}
            >
              ✂️ Save All Crops ({cropBoxes.filter(b => b.itemNumber.trim()).length})
            </button>
          </div>
        </div>
      )}

      {croppedMouldings.length > 0 && (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>📦 Cropped Mouldings ({croppedMouldings.length})</h3>
          <div className="grid">
            {croppedMouldings.slice(0, 12).map(m => (
              <div key={m.id} className="thumb">
                <img src={m.imageUrl} alt={m.detectedNumber} style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 8, marginBottom: 8 }} />
                <div className="muted">{m.detectedNumber} {m.csvData ? '• CSV matched' : ''}</div>
              </div>
            ))}
            {croppedMouldings.length > 12 && <div className="thumb" style={{ display: 'grid', placeItems: 'center', color: '#6b7280' }}>+{croppedMouldings.length - 12} more</div>}
          </div>
        </div>
      )}
    </div>
  );
}
