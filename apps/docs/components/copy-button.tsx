"use client";

import { IconButton } from "@bloxwap/hig/react/button";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset confirmation when the command changes.
  useEffect(() => {
    setStatus("idle");
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, [text]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 2000);
  };

  return (
    <>
      <IconButton
        intent="ghost"
        className={`copy-button ${className ?? ""}`}
        label={status === "copied" ? "Copied to clipboard" : label}
        onClick={copy}
      >
        {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      <span className="copy-feedback" role="status" data-error={status === "error"}>
        {status === "copied" ? "Copied" : status === "error" ? "Copy failed. Select and copy manually." : ""}
      </span>
    </>
  );
}
