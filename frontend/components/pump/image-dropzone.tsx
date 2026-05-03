"use client";

/**
 * Drag-and-drop image upload that converts the file to a `data:` URI.
 *
 * The on-chain `uri` field is capped at 200 bytes, so we DO NOT inline the
 * full image — instead we hand the data URI back to the parent (typically
 * stored in component state) so the parent can decide whether to embed a
 * pointer URL, host on IPFS, etc. For tonight's MVP we just preview the
 * image and ask the caller to keep the URI off-chain or use a hosted URL.
 */

import { ImagePlus, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { cn } from "@/lib/utils";

export interface ImageDropzoneProps {
  /** Called whenever the user picks (or clears) an image. */
  onChange: (dataUri: string | null, mime: string | null) => void;
  /** Optional initial preview. */
  initialPreview?: string | null;
  /** Max file size in bytes — files larger are rejected. Default 256KB. */
  maxBytes?: number;
}

export function ImageDropzone({
  onChange,
  initialPreview = null,
  maxBytes = 256 * 1024,
}: ImageDropzoneProps): JSX.Element {
  const [preview, setPreview] = useState<string | null>(initialPreview);
  const [error, setError] = useState<string | null>(null);
  const [hovering, setHovering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(
    (file: File | undefined) => {
      setError(null);
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        setError("File must be an image");
        return;
      }
      if (file.size > maxBytes) {
        setError(`Image too large (${(file.size / 1024).toFixed(0)} KB > ${(maxBytes / 1024).toFixed(0)} KB)`);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setPreview(result);
        onChange(result, file.type);
      };
      reader.onerror = () => setError("Failed to read file");
      reader.readAsDataURL(file);
    },
    [maxBytes, onChange],
  );

  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">Token image</span>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setHovering(true);
        }}
        onDragLeave={() => setHovering(false)}
        onDrop={(e) => {
          e.preventDefault();
          setHovering(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={cn(
          "relative flex h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border bg-card/40 px-4 text-center transition-colors",
          hovering && "border-primary/60 bg-primary/5",
          preview && "border-solid border-border/60",
        )}
      >
        {preview ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={preview}
              alt="Preview"
              className="h-32 w-32 rounded-lg border border-border/60 object-cover"
            />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPreview(null);
                onChange(null, null);
                if (inputRef.current) inputRef.current.value = "";
              }}
              className="absolute right-2 top-2 rounded-full bg-background/90 p-1 text-muted-foreground hover:text-foreground"
              aria-label="Clear image"
            >
              <X className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <ImagePlus className="h-8 w-8 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Drag &amp; drop an image, or click to choose
            </p>
            <p className="text-[10px] text-muted-foreground/70">
              PNG / JPG / WebP / GIF · ≤ {(maxBytes / 1024).toFixed(0)} KB
            </p>
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
