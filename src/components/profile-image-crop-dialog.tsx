"use client";

import { RotateCcw, RotateCw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

type Point = { x: number; y: number };
type Size = { width: number; height: number };

function constrain(center: Point, size: Size, crop: Size): Point {
  const halfWidth = crop.width / 2;
  const halfHeight = crop.height / 2;
  return {
    x: Math.max(halfWidth, Math.min(size.width - halfWidth, center.x)),
    y: Math.max(halfHeight, Math.min(size.height - halfHeight, center.y)),
  };
}

export function ProfileImageCropDialog({ source, kind, onApply, onCancel }: {
  kind: "avatar" | "banner";
  source: { file: File; url: string };
  onApply: (file: File) => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; center: Point } | null>(null);
  const id = useId();
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [center, setCenter] = useState<Point>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { dialogRef.current?.showModal(); }, []);

  const size = naturalSize && (rotation % 2 ? { width: naturalSize.height, height: naturalSize.width } : naturalSize);
  const isBanner = kind === "banner";
  const aspect = isBanner ? 3 : 1;
  const cropWidth = size ? Math.min(size.width, size.height * aspect) / zoom : 1;
  const crop = { width: cropWidth, height: cropWidth / aspect };
  const cropCenter = size ? constrain(center, size, crop) : center;

  function changeZoom(value: number) {
    const next = Math.max(1, Math.min(3, value));
    if (size) {
      const width = Math.min(size.width, size.height * aspect) / next;
      setCenter(constrain(cropCenter, size, { width, height: width / aspect }));
    }
    setZoom(next);
  }

  function reset() {
    if (naturalSize) setCenter({ x: naturalSize.width / 2, y: naturalSize.height / 2 });
    setZoom(1);
    setRotation(0);
  }

  async function apply() {
    const image = imageRef.current;
    if (!image || !size || !naturalSize || busy) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = isBanner ? 1500 : 512;
      canvas.height = isBanner ? 500 : 512;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.imageSmoothingQuality = "high";
      // Use the same source coordinates as the preview, including the rotated image dimensions.
      context.scale(canvas.width / crop.width, canvas.height / crop.height);
      context.translate(crop.width / 2 - cropCenter.x, crop.height / 2 - cropCenter.y);
      context.translate(size.width / 2, size.height / 2);
      context.rotate(rotation * Math.PI / 2);
      context.drawImage(image, -naturalSize.width / 2, -naturalSize.height / 2);
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((result) => result ? resolve(result) : reject(new Error("Unable to export photo")), "image/png");
      });
      onApply(new File([blob], `${source.file.name.replace(/\.[^.]+$/, "")}-${kind}.png`, { type: "image/png" }));
    } catch {
      setError("We couldn’t crop this photo. Try again or choose another image.");
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-hint`}
      onClose={onCancel}
      onCancel={(event) => { if (busy) event.preventDefault(); }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) event.currentTarget.close();
      }}
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-border bg-bg text-fg shadow-xl ${isBanner ? "max-w-[600px]" : "max-w-[480px]"}`}
    >
      <header className="flex h-[60px] items-center gap-3 border-b border-border px-4">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={busy} aria-label="Cancel crop" className="flex size-9 shrink-0 items-center justify-center rounded-full hover:bg-bg-hover disabled:opacity-50">
          <X className="size-5" />
        </button>
        <h2 id={`${id}-title`} className="flex-1 text-xl font-bold">{isBanner ? "Adjust banner" : "Adjust photo"}</h2>
        <button type="button" onClick={apply} disabled={!naturalSize || busy} className="btn-primary h-9 px-4 text-sm">
          {busy ? "Applying…" : "Apply"}
        </button>
      </header>

      <div className="px-5 py-5 sm:px-8">
        <p id={`${id}-hint`} className="mb-5 text-center text-[15px] text-fg-muted">Drag to reposition. Zoom in for a closer crop.</p>
        <div
          role="group"
          aria-label={`${isBanner ? "Banner" : "Photo"} crop. Use arrow keys to reposition.`}
          tabIndex={naturalSize && !busy ? 0 : -1}
          className={`relative mx-auto w-full touch-none overflow-hidden rounded-xl bg-bg-muted select-none ${isBanner ? "aspect-[3/1]" : "aspect-square max-w-[320px]"} ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
          onPointerDown={(event) => {
            if (!size || busy || !event.isPrimary || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, center: cropCenter };
            setDragging(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId || !size) return;
            const scale = crop.width / event.currentTarget.clientWidth;
            setCenter(constrain({ x: drag.center.x - (event.clientX - drag.x) * scale, y: drag.center.y - (event.clientY - drag.y) * scale }, size, crop));
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => { dragRef.current = null; setDragging(false); }}
          onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
          onKeyDown={(event) => {
            if (!size || busy) return;
            const directions: Record<string, Point> = { ArrowLeft: { x: 1, y: 0 }, ArrowRight: { x: -1, y: 0 }, ArrowUp: { x: 0, y: 1 }, ArrowDown: { x: 0, y: -1 } };
            const direction = directions[event.key];
            if (!direction) return;
            event.preventDefault();
            const step = event.shiftKey ? 0.1 : 0.02;
            setCenter(constrain({ x: cropCenter.x + direction.x * crop.width * step, y: cropCenter.y + direction.y * crop.height * step }, size, crop));
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imageRef}
            src={source.url}
            alt="Photo to crop"
            draggable={false}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              setNaturalSize({ width, height });
              setCenter({ x: width / 2, y: height / 2 });
            }}
            onError={() => { setNaturalSize(null); setError("This photo couldn’t be opened. Choose another image."); }}
            className="pointer-events-none absolute max-w-none"
            style={naturalSize && size ? {
              width: `${naturalSize.width / crop.width * 100}%`,
              height: `${naturalSize.height / crop.height * 100}%`,
              left: `${(0.5 + (size.width / 2 - cropCenter.x) / crop.width) * 100}%`,
              top: `${(0.5 + (size.height / 2 - cropCenter.y) / crop.height) * 100}%`,
              transform: `translate(-50%, -50%) rotate(${rotation * 90}deg)`,
            } : { visibility: "hidden" }}
          />
          {!naturalSize && !error && <span role="status" className="absolute inset-0 flex items-center justify-center text-sm text-fg-muted">Loading photo…</span>}
          <div aria-hidden="true" className={`pointer-events-none absolute inset-0 border-2 border-accent/80 ${isBanner ? "rounded-xl" : "rounded-full shadow-[0_0_0_100vmax_var(--overlay)]"}`} />
        </div>

        <div className="mt-6 flex items-center gap-3">
          <button type="button" aria-label="Zoom out" onClick={() => changeZoom(zoom - 0.1)} disabled={!naturalSize || busy || zoom <= 1} className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-bg-hover disabled:opacity-40"><ZoomOut className="size-5" /></button>
          <input aria-label="Zoom" type="range" min="1" max="3" step="0.01" value={zoom} onChange={(event) => changeZoom(Number(event.target.value))} disabled={!naturalSize || busy} className="h-6 min-w-0 flex-1 cursor-pointer accent-accent-ink" />
          <button type="button" aria-label="Zoom in" onClick={() => changeZoom(zoom + 0.1)} disabled={!naturalSize || busy || zoom >= 3} className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted hover:bg-bg-hover disabled:opacity-40"><ZoomIn className="size-5" /></button>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3">
          <button type="button" disabled={!naturalSize || busy} onClick={() => {
            if (!size) return;
            setCenter({ x: size.height - cropCenter.y, y: cropCenter.x });
            setRotation((value) => (value + 1) % 4);
          }} className="btn-outline h-9 px-4 text-sm"><RotateCw className="size-4" />Rotate</button>
          <button type="button" onClick={reset} disabled={!naturalSize || busy} className="btn-outline h-9 px-4 text-sm"><RotateCcw className="size-4" />Reset</button>
        </div>
        {error && <p role="alert" className="mt-4 text-sm text-danger">{error}</p>}
      </div>
    </dialog>
  );
}
