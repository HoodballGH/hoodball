"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/draws", label: "Draws" },
  { href: "/holders", label: "Holders" },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Primary">
      {LINKS.map((link, index) => (
        <span key={link.href} className="row" style={{ gap: "0.75rem" }}>
          {index > 0 ? <span className="sep">·</span> : null}
          <Link
            href={link.href}
            prefetch={false}
            aria-current={pathname === link.href ? "page" : undefined}
          >
            {link.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}
