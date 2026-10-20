"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const PIN_STORAGE_KEY = "eve-lp-calculator:tool-sidebar-pinned";

const tools = [
  { href: "/", label: "LP 计算器", description: "兑换收益与组合分析", icon: "LP" },
  { href: "/contracts", label: "合同工具", description: "公开合同检索与分析", icon: "CT" },
  { href: "/navigation", label: "星际导航", description: "三维星图与星系探索", icon: "NV" },
] as const;

export default function ToolSidebar() {
  const pathname = usePathname();
  const [pinned, setPinned] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    setPinned(window.localStorage.getItem(PIN_STORAGE_KEY) === "1");
    setStorageReady(true);
  }, []);

  useEffect(() => {
    document.body.classList.toggle("tool-sidebar-pinned", pinned);
    return () => document.body.classList.remove("tool-sidebar-pinned");
  }, [pinned]);

  useEffect(() => {
    if (storageReady) window.localStorage.setItem(PIN_STORAGE_KEY, pinned ? "1" : "0");
  }, [pinned, storageReady]);

  useEffect(() => { setMobileOpen(false); }, [pathname]);

  const togglePinned = () => setPinned(value => !value);
  const active = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);

  return <>
    <button
      type="button"
      className="tool-sidebar-mobile-trigger"
      aria-label={mobileOpen ? "收起功能栏" : "展开功能栏"}
      aria-expanded={mobileOpen}
      aria-controls="tool-sidebar"
      onClick={() => setMobileOpen(value => !value)}
    >
      <span aria-hidden="true">{mobileOpen ? "×" : "☰"}</span>
      <b>功能</b>
    </button>
    {mobileOpen && <button type="button" className="tool-sidebar-backdrop" aria-label="关闭功能栏" onClick={() => setMobileOpen(false)} />}
    <aside id="tool-sidebar" className={`tool-sidebar${pinned ? " pinned" : ""}${mobileOpen ? " mobile-open" : ""}`} aria-label="功能导航">
      <div className="tool-sidebar-head">
        <span className="tool-sidebar-emblem" aria-hidden="true">✦</span>
        <div><b>舰桥工具箱</b><small>BRIDGE TOOLS</small></div>
        <button type="button" className="tool-sidebar-pin" aria-label={pinned ? "取消固定功能栏" : "固定功能栏"} aria-pressed={pinned} title={pinned ? "取消固定" : "固定功能栏"} onClick={togglePinned}>
          <span aria-hidden="true">{pinned ? "◆" : "◇"}</span>
        </button>
      </div>
      <nav>
        {tools.map(tool => <Link key={tool.href} href={tool.href} className={active(tool.href) ? "active" : ""} aria-current={active(tool.href) ? "page" : undefined}>
          <i aria-hidden="true">{tool.icon}</i>
          <span><b>{tool.label}</b><small>{tool.description}</small></span>
        </Link>)}
      </nav>
      <div className="tool-sidebar-foot"><span>{String(tools.length).padStart(2, "0")}</span><small>TOOLS ONLINE</small></div>
    </aside>
  </>;
}
