/// <reference types="vite/client" />
// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/* ===== Jednoduché typy (bez TS prísnosti) ===== */
type Status = "safe" | "avoid" | "maybe";

const ALL_TAGS = ["lepok","mlieko","sója","orechy","vajcia","sezam","arašidy","ryby","zeler","horčica","mäkkýše"];

/* Endpoint pre AI – .env (Vite) alebo fallback na /api/eval */
const EVAL_URL =
  (import.meta as any)?.env?.VITE_EVAL_URL && String((import.meta as any).env.VITE_EVAL_URL).trim() !== ""
    ? String((import.meta as any).env.VITE_EVAL_URL)
    : "/api/eval";

/* localStorage helper */
const ls = {
  get(k: string, d: any) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; }
  },
  set(k: string, v: any) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

function badgeLabel(s: Status) {
  return s === "safe" ? "Bezpečné" : s === "avoid" ? "Vyhnúť sa" : "Neisté";
}

/* OFF fetch */
async function fetchFromOFF(code: string) {
  try {
    const r = await fetch(`https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(code)}.json`);
    const j = await r.json();
    const p = j?.product;
    return {
      code,
      name: p?.product_name || p?.generic_name || "",
      brand: Array.isArray(p?.brands_tags) ? p.brands_tags[0] : p?.brands || "",
      ingredients: p?.ingredients_text || "",
      allergens: p?.allergens || "",
    };
  } catch {
    return { code };
  }
}

/* AI fetch */
async function askAI(product: any, profile: any): Promise<{ status: Status; notes: string[] }> {
  try {
    const body = {
      code: product.code,
      name: product.name || "",
      ingredients: product.ingredients || "",
      allergens: product.allergens || "",
      lang: "sk",
      profile,
    };
    const res = await fetch(EVAL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`AI HTTP ${res.status}`);
    const j = await res.json();
    const st = (j?.status as Status) || "maybe";
    const notes = Array.isArray(j?.notes) ? j.notes : [];
    return { status: st, notes };
  } catch (e) {
    console.warn("AI error", e);
    return { status: "maybe", notes: ["AI požiadavka zlyhala."] };
  }
}

export default function App() {
  /* UI */
  const [ean, setEAN] = useState("");
  const [cameraOn, setCameraOn] = useState(false);
  const [loading, setLoading] = useState<"idle" | "search" | "ai">("idle");
  const [notes, setNotes] = useState<string[]>([]);

  /* Dáta */
  const [profile, setProfile] = useState(() => ls.get("radka.profile", { name: "", intolerances: ["lepok"] }));
  const [history, setHistory] = useState(() => ls.get("radka.history", []));
  const [product, setProduct] = useState<any>(null);
  const [status, setStatus] = useState<Status | null>(null);

  /* Kamera */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<any>(null);
  const stopScanner = useRef<() => void>(() => {});

  useEffect(() => ls.set("radka.profile", profile), [profile]);
  useEffect(() => ls.set("radka.history", history.slice(0, 30)), [history]);

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      if (!cameraOn || !videoRef.current) return;
      if (!readerRef.current) readerRef.current = new BrowserMultiFormatReader();
      const reader = readerRef.current;

      try {
        await reader.decodeFromVideoDevice(undefined, videoRef.current, (res: any) => {
          if (cancelled) return;
          if (res) setEAN(res.getText());
        });

        stopScanner.current = () => {
          try { reader?.reset?.(); } catch {}
          try { reader?.stopContinuousDecode?.(); } catch {}
        };
      } catch (e) {
        console.warn("Camera start error", e);
      }
    };

    if (cameraOn) start();
    return () => {
      cancelled = true;
      if (!cameraOn) return;
      try { stopScanner.current?.(); } catch {}
    };
  }, [cameraOn]);

  const canSearch = useMemo(() => /^\d{7,13}$/.test(ean.trim()), [ean]);

  async function onSearch() {
    if (!canSearch) return;
    setLoading("search");
    setNotes([]);
    setStatus(null);
    setProduct(null);

    const code = ean.trim();

    // 1) OFF
    const off = await fetchFromOFF(code);
    setProduct(off);

    // 2) Rýchla kontrola podľa profilu
    const quickLower = `${off.allergens || ""} ${off.ingredients || ""}`.toLowerCase();
    const hit = (profile.intolerances || []).find((i: string) => quickLower.includes(i.toLowerCase()));

    let finalStatus: Status = hit ? "avoid" : "maybe";
    let finalNotes: string[] = hit ? [`Našiel som „${hit}“ v ingredienciách/alergénoch.`] : [];

    // 3) AI
    setLoading("ai");
    const ai = await askAI(off, profile);
    finalStatus = ai.status ?? finalStatus;
    finalNotes = [...finalNotes, ...(ai.notes ?? [])];

    setStatus(finalStatus);
    setNotes(finalNotes);
    setLoading("idle");

    // 4) História
    setHistory((h: any[]) => [
      { code: off.code, name: off.name || "", brand: off.brand || "", status: finalStatus, at: Date.now() },
      ...h.filter((x) => x.code !== off.code),
    ].slice(0, 20));
  }

  const toggleTag = (t: string) =>
    setProfile((p: any) => {
      const on = (p.intolerances || []).includes(t);
      return { ...p, intolerances: on ? p.intolerances.filter((x: string) => x !== t) : [...p.intolerances, t] };
    });

  const clearHistory = () => setHistory([]);

  return (
    <>
      {/* HEADER */}
      <div className="header">
        <div className="header__row">
          <div className="brand">
            <span>Radka</span>
            <span className="brand__plus">Scanner+</span>
          </div>

          <div className="cam-toggle" role="button" onClick={() => setCameraOn((v) => !v)}>
            <div className={`switch ${cameraOn ? "is-on" : ""}`} tabIndex={0} aria-label="Prepnúť kameru" />
            <span style={{ fontWeight: 700 }}>Kamera</span>
          </div>
        </div>
      </div>

      {/* CONTENT */}
      <div className="container">
        {/* Kamera náhľad */}
        {cameraOn && (
          <section className="panel" aria-label="Náhľad kamery">
            <video
              ref={videoRef}
              style={{ width: "100%", maxHeight: 280, borderRadius: 14, background: "#000" }}
              muted
              playsInline
              autoPlay
            />
            <div className="panel__subtitle" style={{ marginTop: 8 }}>
              Zameraj čiarový kód do stredu obrazu. Kód sa prepíše do poľa nižšie.
            </div>
          </section>
        )}

        {/* Skenovanie */}
        <section className="panel">
          <h2 className="panel__title">Skenovanie čiarového kódu</h2>

          <div className="field">
            <label className="visually-hidden" htmlFor="ean">EAN/UPC</label>
            <input
              id="ean"
              className="input"
              inputMode="numeric"
              placeholder="Zadaj EAN/UPC kód"
              value={ean}
              onChange={(e) => setEAN(e.target.value.replace(/[^\d]/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && canSearch && onSearch()}
            />
            <button className="btn btn-primary" disabled={!canSearch || loading !== "idle"} onClick={onSearch}>
              {loading === "search" || loading === "ai" ? "Hľadám…" : "Vyhľadať"}
            </button>
          </div>

          <div className="panel__subtitle">
            Dáta: Open Food Facts. Ak je výsledok neistý alebo produkt chýba, skúsime AI (tvoj endpoint).
          </div>
        </section>

        {/* Profil */}
        <section className="panel">
          <h2 className="panel__title">Môj profil</h2>

          <div className="grid">
            <label className="visually-hidden" htmlFor="name">Meno</label>
            <input
              id="name"
              className="input"
              placeholder="napr. Radka"
              value={profile.name || ""}
              onChange={(e) => setProfile({ ...profile, name: e.target.value })}
            />
          </div>

          <div className="panel__subtitle" style={{ marginTop: 10 }}>Intolerancie / alergie</div>
          <div className="chips">
            {ALL_TAGS.map((t) => {
              const active = (profile.intolerances || []).includes(t);
              return (
                <button
                  key={t}
                  onClick={() => toggleTag(t)}
                  className={`chip ${active ? "chip--active" : ""}`}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </section>

        {/* Výsledok */}
        {(product || status) && (
          <section className="panel">
            <h2 className="panel__title">Výsledok</h2>

            <div className="card" style={{ marginBottom: 10 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16 }}>
                  {product?.name || "Neznámy produkt"}
                </div>
                <div className="panel__subtitle">
                  {(product?.brand || "—")} • {product?.code}
                </div>
              </div>

              {status && (
                <span className={
                  "badge " + (status === "safe" ? "badge--ok" : status === "avoid" ? "badge--avoid" : "")
                }>
                  {badgeLabel(status)}
                </span>
              )}
            </div>

            {notes?.length ? (
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {notes.map((n, i) => (
                  <li key={i} style={{ marginBottom: 6 }}>{n}</li>
                ))}
              </ul>
            ) : (
              <div className="panel__subtitle">Bez dodatočných poznámok.</div>
            )}
          </section>
        )}

        {/* História */}
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2 className="panel__title" style={{ margin: 0 }}>Posledné skeny</h2>
            {history.length > 0 && (
              <button className="btn" style={{ background: "#eef2ff", color: "#111827" }} onClick={clearHistory}>
                Vymazať históriu
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="card">
              <div className="panel__subtitle">Zatiaľ žiadne skeny.</div>
            </div>
          ) : (
            history.map((h: any) => (
              <div key={h.code} className="card">
                <div>
                  <div style={{ fontWeight: 800 }}>{h.name || "Neznámy produkt"}</div>
                  <div className="panel__subtitle">{h.brand || "—"} • {h.code}</div>
                </div>
                <span className={
                  "badge " + (h.status === "safe" ? "badge--ok" : h.status === "avoid" ? "badge--avoid" : "")
                }>
                  {badgeLabel(h.status)}
                </span>
              </div>
            ))
          )}
        </section>

        {/* Footer */}
        <p className="disclaimer">
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </p>
      </div>
    </>
  );
}
