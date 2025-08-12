import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";

/** ====== Typy ====== */
type EvalStatus = "safe" | "avoid" | "maybe";

type Intolerances = {
  gluten: boolean;
  milk: boolean;
  soy: boolean;
  nuts: boolean;
  eggs: boolean;
  sesame: boolean;
};

type Profile = {
  name: string;
  intolerances: Intolerances;
};

type HistoryItem = {
  code: string;
  name: string;
  brand: string;
  status: EvalStatus;
  ts: number;
};

const defaultProfile: Profile = {
  name: "",
  intolerances: {
    gluten: true,
    milk: true,
    soy: false,
    nuts: false,
    eggs: false,
    sesame: false,
  },
};

/** ====== Konštanty ====== */
const eval_url =
  import.meta.env.VITE_EVAL_URL || "https://radka-celiakia.vercel.app/api/eval";

/** Krátke utility na UI */
const Tag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <span
    style={{
      fontSize: 12,
      padding: "4px 10px",
      borderRadius: 999,
      background: "#f1f5f9",
      border: "1px solid #e5e7eb",
    }}
  >
    {children}
  </span>
);

function statusPill(s: EvalStatus) {
  const map: Record<EvalStatus, { text: string; bg: string; fg: string }> = {
    safe: { text: "Bezpečné", bg: "#dcfce7", fg: "#166534" },
    avoid: { text: "Vyhnúť sa", bg: "#fee2e2", fg: "#991b1b" },
    maybe: { text: "Neisté", bg: "#fef3c7", fg: "#92400e" },
  };
  const cfg = map[s];
  return (
    <span
      style={{
        fontSize: 12,
        padding: "6px 10px",
        borderRadius: 999,
        background: cfg.bg,
        color: cfg.fg,
        border: "1px solid #e5e7eb",
        fontWeight: 600,
      }}
    >
      {cfg.text}
    </span>
  );
}

/** ====== Hlavný komponent ====== */
export default function App() {
  /** Profil & perzistencia */
  const [profile, setProfile] = useState<Profile>(() => {
    try {
      const raw = localStorage.getItem("radka_profile");
      return raw ? JSON.parse(raw) : defaultProfile;
    } catch {
      return defaultProfile;
    }
  });

  useEffect(() => {
    localStorage.setItem("radka_profile", JSON.stringify(profile));
  }, [profile]);

  /** História */
  const [history, setHistory] = useState<HistoryItem[]>(() => {
    try {
      const raw = localStorage.getItem("radka_history");
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    localStorage.setItem("radka_history", JSON.stringify(history.slice(0, 50)));
  }, [history]);

  /** Skenovanie */
  const [useBackCam, setUseBackCam] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [barcode, setBarcode] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const lastCodeRef = useRef<string | null>(null); // aby sme nespúšťali fetch viackrát za sebou

  /** Stav produktu */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [product, setProduct] = useState<any | null>(null);
  const [evaluation, setEvaluation] = useState<EvalStatus | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  /** Media constraints pre lepšie čítanie (zadná kamera) */
  const constraints: MediaStreamConstraints = useMemo(
    () => ({
      video: useBackCam
        ? { facingMode: { exact: "environment" }, width: { ideal: 1280 } }
        : { facingMode: "user", width: { ideal: 1280 } },
      audio: false,
    }),
    [useBackCam]
  );

  /** Funkcia na bezpečné vypnutie kamery */
  function stopCamera() {
    try {
      const video = videoRef.current;
      const stream = (video?.srcObject as MediaStream) || null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (video) video.srcObject = null;
    } catch {}
  }

  /** Štart skenovania */
  async function startScan() {
    setError(null);
    setProduct(null);
    setEvaluation(null);
    setNotes([]);
    setScanning(true);
    lastCodeRef.current = null;

    try {
      readerRef.current = new BrowserMultiFormatReader();
      // získaj zoznam kamier
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      let deviceId: string | undefined;

      if (devices.length) {
        // vyber zadnú ak vieme
        const back = devices.find((d) =>
          /back|rear|environment/i.test(d.label)
        );
        deviceId = (useBackCam ? back?.deviceId : devices[0]?.deviceId) || devices[0]?.deviceId;
      }

      await readerRef.current.decodeFromVideoDevice(
        deviceId,
        videoRef.current!,
        (result, err, controls) => {
          if (result) {
            const code = result.getText();
            if (code && code !== lastCodeRef.current) {
              lastCodeRef.current = code;
              setBarcode(code);
              // zastav hneď kameru (žiadne blikanie)
              controls.stop();
              stopCamera();
              setScanning(false);
              fetchProduct(code);
            }
          }
        }
      );
    } catch (e: any) {
      console.error(e);
      setError("Nepodarilo sa spustiť kameru.");
      setScanning(false);
      stopCamera();
    }
  }

  /** Prepnúť kameru, ak práve neskenujem */
  function toggleCamera() {
    if (scanning) return;
    setUseBackCam((v) => !v);
  }

  /** Čistenie kamery pri unmount */
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  /** Fetch + vyhodnotenie */
  async function fetchProduct(code: string) {
    setLoading(true);
    setError(null);
    setProduct(null);
    setEvaluation(null);
    setNotes([]);

    try {
      const url = `https://world.openfoodfacts.org/api/v2/product/${code}.json`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Chyba pripojenia k databáze");
      const data = await res.json();

      if (data.status !== 1 || !data.product) {
        // nepoznáme – skús AI fallback
        await fallbackAI({ code, name: "", ingredients: "", allergens: "" });
        return;
      }

      const p = data.product;
      setProduct(p);

      // Vyhodnotenie podľa profilu
      const result = evaluateForProfile(p, profile);
      setEvaluation(result.status);
      setNotes(result.notes);

      setHistory((h) => [
        {
          code,
          brand: p.brands || "",
          name: p.product_name || p.generic_name || "Neznámy produkt",
          status: result.status,
          ts: Date.now(),
        },
        ...h.filter((x) => x.code !== code),
      ]);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "Neznáma chyba");
    } finally {
      setLoading(false);
    }
  }

  /** AI fallback – keď OFF nepozná, alebo vyjde “neisté” */
  async function fallbackAI(input: {
    code: string;
    name: string;
    ingredients: string;
    allergens: string;
  }) {
    try {
      const resp = await fetch(eval_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...input,
          lang: "sk",
          profile,
        }),
      });

      if (!resp.ok) throw new Error("AI endpoint neodpovedá.");
      const body = await resp.json();

      if (body?.ok) {
        setEvaluation(body.status as EvalStatus);
        if (Array.isArray(body.notes)) setNotes(body.notes);
      } else {
        setEvaluation("maybe");
        setNotes((n) => [...n, "AI sa nepodarilo zavolať alebo odpovedať."]);
      }
    } catch (e: any) {
      console.error("AI error:", e);
      setEvaluation("maybe");
      setNotes((n) => [...n, "AI požiadavka zlyhala."]);
    }
  }

  /** Heuristika podľa profilu */
  function evaluateForProfile(p: any, prof: Profile): {
    status: EvalStatus;
    notes: string[];
  } {
    const ns: string[] = [];

    const allergenTags: string[] = p.allergens_tags || [];
    const ingrAnalysis: string[] = p.ingredients_analysis_tags || [];

    const ingredientsText = (
      p.ingredients_text_sk ||
      p.ingredients_text_cs ||
      p.ingredients_text ||
      ""
    ).toLowerCase();

    // slovník
    const dict = {
      gluten: ["lepok", "pšen", "psen", "wheat", "jačme", "jacme", "barley", "raž", "raz", "rye", "špal", "spelt", "ovos"],
      milk: ["mlie", "srvát", "whey", "casein", "kaze", "maslo", "smot", "syr", "tvaroh"],
      soy: ["sója", "soja", "soy"],
      nuts: ["orech", "nut", "mandle", "liesk", "vlaš", "kešu", "araš", "peanut", "almond", "hazelnut", "walnut", "cashew"],
      eggs: ["vajc", "egg", "album", "ovalb"],
      sesame: ["sezam", "sesame"],
    } as Record<keyof Intolerances, string[]>;

    // helper – kontrola v texte alebo v tagoch
    function hasRisk(key: keyof Intolerances) {
      const t = dict[key];
      const textHit = t.some((frag) => ingredientsText.includes(frag));
      const tagHit = allergenTags.some((a) => a.toLowerCase().includes(key));
      const analysisMaybe =
        key === "gluten"
          ? ingrAnalysis.some((x) => /may-contain-gluten/i.test(x))
          : false;
      return { textHit, tagHit, analysisMaybe };
    }

    let status: EvalStatus = "maybe";

    (Object.keys(prof.intolerances) as (keyof Intolerances)[]).forEach((k) => {
      if (!prof.intolerances[k]) return;
      const r = hasRisk(k);
      if (r.tagHit || r.textHit) {
        status = "avoid";
        ns.push(
          `Obsahuje alebo môže obsahovať zložku podľa profilu: ${labelFor(k)}.`
        );
      } else if (r.analysisMaybe) {
        status = status === "avoid" ? "avoid" : "maybe";
        ns.push("Upozornenie: môže obsahovať stopy lepku.");
      }
    });

    if (status !== "avoid") {
      // z OFF claims
      const claims = `${p.labels || ""} ${p.traces || ""} ${(p.traces_tags || []).join(" ")}`.toLowerCase();
      const saysGF = /gluten[- ]?free|bez lepku|bezlepkov/i.test(claims);

      if (saysGF && prof.intolerances.gluten) {
        status = "safe";
        ns.push("Deklarované ako bezlepkové.");
      } else {
        ns.push(
          "Nenašli sa jasné riziká podľa profilu. Ak si nie si istý/istá, skontroluj etiketu."
        );
        if (status !== "safe") status = "maybe";
      }
    }

    return { status, notes: ns };
  }

  function labelFor(k: keyof Intolerances) {
    const m: Record<keyof Intolerances, string> = {
      gluten: "lepok",
      milk: "mlieko",
      soy: "sója",
      nuts: "orechy",
      eggs: "vajcia",
      sesame: "sezam",
    };
    return m[k];
  }

  /** UI helpers */
  function ProfileCard() {
    return (
      <div style={card}>
        <div style={cardHead}>
          <div style={cardTitle}>Môj profil</div>
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <label style={label}>Meno</label>
            <input
              value={profile.name}
              onChange={(e) =>
                setProfile((p) => ({ ...p, name: e.target.value }))
              }
              style={input}
              placeholder="napr. Radka"
            />
          </div>
          <div>
            <div style={label}>Intolerancie / alergie</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {(Object.keys(profile.intolerances) as (keyof Intolerances)[]).map(
                (k) => (
                  <button
                    key={k}
                    onClick={() =>
                      setProfile((p) => ({
                        ...p,
                        intolerances: {
                          ...p.intolerances,
                          [k]: !p.intolerances[k],
                        },
                      }))
                    }
                    style={{
                      ...chip,
                      background: profile.intolerances[k] ? "#eef2ff" : "#f8fafc",
                      borderColor: profile.intolerances[k] ? "#c7d2fe" : "#e5e7eb",
                      color: profile.intolerances[k] ? "#4338ca" : "#111827",
                    }}
                  >
                    {labelFor(k)}
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function ScannerCard() {
    return (
      <div style={card}>
        <div style={{ ...cardHead, alignItems: "center" }}>
          <div style={cardTitle}>Skenovanie čiarového kódu</div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={toggleCamera} style={btnGhost}>
              Prepnúť kameru
            </button>
            <label style={{ ...label, display: "flex", alignItems: "center", gap: 8, margin: 0 }}>
              <input
                type="checkbox"
                checked={scanning}
                onChange={(e) => (e.target.checked ? startScan() : (stopCamera(), setScanning(false)))}
              />
              Kamera
            </label>
          </div>
        </div>

        {scanning && (
          <div
            style={{
              borderRadius: 14,
              overflow: "hidden",
              border: "1px solid #e5e7eb",
              background: "#000",
              aspectRatio: "16/9",
              marginBottom: 12,
            }}
          >
            <video
              ref={videoRef}
              style={{ width: "100%", height: "100%", objectFit: "cover" }}
              muted
              playsInline
            />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8 }}>
          <input
            placeholder="Zadaj EAN/UPC kód"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && barcode) fetchProduct(barcode);
            }}
            style={input}
          />
          <button
            onClick={() => barcode && fetchProduct(barcode)}
            disabled={!barcode || loading}
            style={btnPrimary}
          >
            {loading ? "Načítavam…" : "Vyhľadať"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#64748b", marginTop: 8 }}>
          Dáta: Open Food Facts → ak je neisté, doplní AI z tvojho endpointu.
        </div>
      </div>
    );
  }

  function ProductCard() {
    if (!product && !evaluation && !notes.length && !error) return null;

    return (
      <div style={card}>
        {error && (
          <div style={alertErr}>{error}</div>
        )}

        {product && (
          <div style={{ display: "grid", gap: 10 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
              }}
            >
              <div style={{ ...cardTitle, margin: 0 }}>
                {product.product_name || product.generic_name || "Neznámy produkt"}
              </div>
              {evaluation && statusPill(evaluation)}
            </div>

            <div style={{ fontSize: 13, color: "#64748b" }}>Kód: {product.code}</div>

            {notes.length > 0 && (
              <ul style={{ marginLeft: 18, lineHeight: 1.45 }}>
                {notes.map((n, i) => (
                  <li key={i} style={{ fontSize: 14 }}>
                    {n}
                  </li>
                ))}
              </ul>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div>
                <div style={subTitle}>Alergény (z databázy)</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {(product.allergens_hierarchy || []).length ? (
                    (product.allergens_hierarchy || []).map((t: string) => (
                      <Tag key={t}>{t.replace(/^.*:/, "")}</Tag>
                    ))
                  ) : (
                    <span style={{ fontSize: 13, color: "#64748b" }}>Neuvádzané</span>
                  )}
                </div>
              </div>
              <div>
                <div style={subTitle}>Ingrediencie (sk/cs/en)</div>
                <div style={ingredientsBox}>
                  {product.ingredients_text_sk ||
                    product.ingredients_text_cs ||
                    product.ingredients_text_en ||
                    product.ingredients_text ||
                    "Neuvádzané"}
                </div>
              </div>
            </div>

            <div style={{ fontSize: 12, color: "#64748b" }}>
              Zdroj: Open Food Facts • Posledná aktualizácia:{" "}
              {product.last_modified_t
                ? new Date(product.last_modified_t * 1000).toLocaleDateString()
                : "neuvedené"}
            </div>
          </div>
        )}
      </div>
    );
  }

  function HistoryCard() {
    return (
      <div style={card}>
        <div style={{ ...cardHead, alignItems: "center" }}>
          <div style={cardTitle}>Posledné skeny</div>
          {history.length > 0 && (
            <button
              onClick={() => {
                setHistory([]);
                localStorage.removeItem("radka_history");
              }}
              style={btnGhost}
            >
              Vymazať históriu
            </button>
          )}
        </div>

        {history.length === 0 ? (
          <div style={{ fontSize: 13, color: "#64748b" }}>Zatiaľ prázdne</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
            {history.map((h) => (
              <button
                key={h.code}
                onClick={() => fetchProduct(h.code)}
                style={historyRow}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{h.name}</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>
                    {h.brand} • {h.code}
                  </div>
                </div>
                <div>{statusPill(h.status)}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f6f7fb" }}>
      <div style={hero}>
        <div style={{ fontSize: 24, fontWeight: 700 }}>Radka Scanner+</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={toggleCamera} style={btnWhite}>
            Prepnúť kameru
          </button>
          <label style={{ ...label, display: "flex", alignItems: "center", gap: 8, margin: 0, color: "#0f172a" }}>
            <input
              type="checkbox"
              checked={scanning}
              onChange={(e) => (e.target.checked ? startScan() : (stopCamera(), setScanning(false)))}
            />
            Kamera
          </label>
        </div>
      </div>

      <div style={container}>
        <ScannerCard />
        <ProfileCard />
        <ProductCard />
        <HistoryCard />

        <div style={{ textAlign: "center", fontSize: 12, color: "#64748b", padding: "14px 0" }}>
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu výrobku.
        </div>
      </div>
    </div>
  );
}

/** ====== “Dizajn systém” (inline) ====== */
const container: React.CSSProperties = {
  maxWidth: 880,
  margin: "0 auto",
  padding: 16,
  display: "grid",
  gap: 12,
};

const hero: React.CSSProperties = {
  background: "linear-gradient(135deg, #eef2ff 0%, #e9d5ff 100%)",
  padding: "18px 16px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  color: "#0f172a",
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e5e7eb",
  borderRadius: 16,
  padding: 14,
  boxShadow: "0 1px 0 rgba(16,24,40,.04)",
};

const cardHead: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 10,
};

const cardTitle: React.CSSProperties = {
  fontWeight: 700,
  fontSize: 18,
  color: "#0f172a",
};

const label: React.CSSProperties = {
  fontSize: 13,
  color: "#475569",
  marginBottom: 6,
  display: "block",
};

const input: React.CSSProperties = {
  padding: "10px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  outline: "none",
  background: "#fff",
  fontSize: 14,
};

const btnPrimary: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid #7c3aed",
  background: "linear-gradient(135deg, #7c3aed, #5b21b6)",
  color: "#fff",
  fontWeight: 600,
};

const btnGhost: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 500,
};

const btnWhite: React.CSSProperties = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #e5e7eb",
  background: "#fff",
  color: "#0f172a",
  fontWeight: 600,
};

const chip: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 13,
};

const subTitle: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: 6,
  color: "#0f172a",
};

const ingredientsBox: React.CSSProperties = {
  fontSize: 13,
  maxHeight: 120,
  overflow: "auto",
  padding: 10,
  borderRadius: 10,
  background: "#f8fafc",
  border: "1px solid #e5e7eb",
};

const historyRow: React.CSSProperties = {
  textAlign: "left" as const,
  border: "1px solid #e5e7eb",
  borderRadius: 12,
  padding: 10,
  background: "#fff",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const alertErr: React.CSSProperties = {
  padding: 10,
  borderRadius: 10,
  border: "1px solid #fecaca",
  background: "#fee2e2",
  color: "#991b1b",
  marginBottom: 12,
};
