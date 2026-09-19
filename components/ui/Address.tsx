"use client";

import { useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { short } from "./format";

export function CopyButton({
  value,
  size = 12,
}: {
  value: string;
  size?: number;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`copy${copied ? " done" : ""}`}
      title={copied ? "Copied" : "Copy"}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? <FiCheck size={size} /> : <FiCopy size={size} />}
    </button>
  );
}

export default function AddressDisplay({
  address,
  head = 4,
  tail = 4,
  prefix,
  placeholder = "TBA",
  inline = false,
  href,
}: {
  address: string | null;
  head?: number;
  tail?: number;
  prefix?: string;
  placeholder?: string;
  inline?: boolean;
  href?: string | null;
}) {
  const label = address ? short(address, head, tail) : placeholder;
  const text = prefix ? `${prefix} ${label}` : label;
  return (
    <span className={`address${inline ? " inline" : ""}`}>
      {href && address ? (
        <a href={href} target="_blank" rel="noreferrer" className="link quiet">
          {text}
        </a>
      ) : (
        <span>{text}</span>
      )}
      {address ? <CopyButton value={address} /> : null}
    </span>
  );
}
