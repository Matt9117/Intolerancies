// src/App.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import {
  BrowserMultiFormatReader,
  IScannerControls,
} from "@zxing/browser";

type Status = "safe" | "avoid" | "maybe";

type ScanResult = {
  code: string;
  brand?: string;
  name?: string;
  status: Status;
  notes?: string[];
};

type Profile = {
  name: string;
  intolerances: string[];
};

const ALL_TAGS = [
  "lepok",
  "mlieko",
  "sója",
  "orechy",
  "vajcia",
  "ryby",
  "horčica",
  "arašídy",
  "zeler",
  "mäkkýše",
  "sezam",
];

const LS_KEYS = {
  profile: "radka.profile",
  history: "radka.history",
};

export default function App() {
  // --- camera ---
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);

  const [cameraOn, setCameraOn] = useState(false);

  // --- ui / data ---
  const [ean, setEan] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [profile, setProfile] = useState<Profile>({
    name: "",
    intolerances: ["lepok"],
  });

  // ---------- init from localStorage ----------
  useEffect(() => {
    try {
      const p = localStorage.getItem(LS_KEYS.profile);
      if (p) setProfile(JSON.parse(p));
      const h = localStorage.getItem(LS_KEYS.history);
      if (h) setHistory(JSON.parse(h));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.profile, JSON.stringify(profile));
  }, [profile]);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.history, JSON.stringify(history.slice(0, 20)));
  }, [history]);

  // ---------- camera on/off ----------
  const startCamera = async () => {
    if (!videoRef.current) return;

    // požiadame o stream so šírkou 1280x720 (16:9)
    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 16 / 9 },
      },
      audio: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    streamRef.current = stream;

    const v = videoRef.current;
    v.srcObject = stream;
    await v.play();

    // niektoré zariadenia lepšie reagujú na priamy applyConstraints
    try {
      const [track] = stream.getVideoTracks();
      await track.applyConstraints({
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: 16 / 9,
      } as MediaTrackConstraints);
    } catch {
      /* optional */
    }

    // ZXing – kontinuálne dekódovanie s kontrolami
    readerRef.current = new BrowserMultiFormatReader();
    controlsRef.current = await readerRef.current.decodeFromVideoDevice(
      null,
      v,
      (res, err) => {
        if (res) {
          const code = res.getText();
          setEan(code);
          // pri prvom zásahu necháme užívateľa kliknúť na Vyhľadať,
          // aby mal kontrolu; ak chceš auto-lookup, odkomentuj:
          // handleLookup(code);
        }
      }
    );
  };

  const stopCamera = () => {
    controlsRef.current?.stop();
    controlsRef.current = null;

    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    if (cameraOn) startCamera().catch(() => setCameraOn(false));
    else stopCamera();
    // cleanup on unmount
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn]);

  // ---------- Open Food Facts fetch ----------
  async function fetchOFF(code: string) {
    try {
      const resp = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(
          code
        )}.json`
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data?.product) return null;

      const p = data.product;
      const name =
        p.product_name_sk ||
        p.product_name_cs ||
        p.product_name ||
        p.generic_name ||
        "";
      const brand =
        (p.brands_tags?.[0] as string) ||
        p.brands ||
        (Array.isArray(p.brands_tags) ? p.brands_tags.join(", ") : "");

      const ingredients =
        p.ingredients_text_sk ||
        p.ingredients_text_cs ||
        p.ingredients_text ||
        "";

      const allergens =
        p.allergens_tags?.map((s: string) => s.replace("en:", "")) || [];

      return {
        code,
        name,
        brand,
        ingredients,
        allergens,
        lang: "sk",
      } as {
        code: string;
        name: string;
        brand: string;
        ingredients: string;
        allergens: string[];
        lang: "sk" | "cs" | "en";
      };
    } catch {
      return null;
    }
  }

  // ---------- AI evaluate (/api/eval) ----------
  async function evaluateWithAI(payload: {
    code: string;
    name: string;
    ingredients: string;
    allergens: string[];
    lang: string;
  }): Promise<{ status: Status; notes: string[] }> {
    try {
      const resp = await fetch("/api/eval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          profile: { intolerances: profile.intolerances },
        }),
      });
      if (!resp.ok) {
        return { status: "maybe", notes: ["AI požiadavka zlyhala."] };
      }
      const data = await resp.json();
      // očakávame { ok: true, status: 'safe'|'avoid'|'maybe', notes: string[] }
      if (data?.status === "safe" || data?.status === "avoid")
        return { status: data.status, notes: data.notes || [] };
      return { status: "maybe", notes: data?.notes || [] };
    } catch {
      return { status: "maybe", notes: ["AI požiadavka zlyhala."] };
    }
  }

  // ---------- hlavná akcia Vyhľadať ----------
  const handleLookup = async (forced?: string) => {
    const code = (forced || ean).trim();
    if (!code) return;

    setLoading(true);
    setResult(null);

    const off = await fetchOFF(code);

    // predvyplň názov/brand ak máme
    let name = off?.name || "";
    let brand = off?.brand || "";

    // základný výstup – default "maybe"
    let status: Status = "maybe";
    const notes: string[] = [];

    // heuristiky: ak OFF obsahuje jasný alergén z profilu
    if (off?.allergens?.length) {
      const hit = off.allergens.find((a) =>
        profile.intolerances.some((t) =>
          a.toLowerCase().includes(t.toLowerCase())
        )
      );
      if (hit) {
        status = "avoid";
        notes.push(`Nájdený alergén v OFF: ${hit}.`);
      }
    }

    // ak stále nejasné, požiadame AI
    if (status === "maybe") {
      const ai = await evaluateWithAI({
        code,
        name: name || "",
        ingredients: off?.ingredients || "",
        allergens: off?.allergens || [],
        lang: "sk",
      });
      status = ai.status;
      notes.push(...ai.notes);
    }

    const entry: ScanResult = { code, name, brand, status, notes };
    setResult(entry);
    setHistory((h) => [entry, ...h.filter((x) => x.code !== code)].slice(0, 20));
    setLoading(false);
  };

  const badgeClass = useMemo(() => {
    if (!result) return "badge maybe";
    return `badge ${result.status}`;
  }, [result]);

  const toggleTag = (tag: string) => {
    setProfile((p) => {
      const has = p.intolerances.includes(tag);
      return {
        ...p,
        intolerances: has
          ? p.intolerances.filter((t) => t !== tag)
          : [...p.intolerances, tag],
      };
    });
  };

  const clearHistory = () => setHistory([]);

  return (
    <>
      {/* HEADER */}
      <header className="app-header">
        <div className="wrap">
          <div>
            <div className="brand">Radka</div>
            <small className="brand">Scanner+</small>
          </div>

          <div className="kv">
            <label className="mono">Kamera</label>
            <button
              className="btn secondary"
              onClick={() => setCameraOn((s) => !s)}
              aria-pressed={cameraOn}
            >
              {cameraOn ? "Vypnúť" : "Zapnúť"}
            </button>
          </div>
        </div>
      </header>

      <main className="container">
        {/* CAMERA */}
        <section className="card camera-card">
          <div className="camera-head">
            <h2>Kamera</h2>
          </div>
          <div className="camera-wrap">
            <video ref={videoRef} playsInline muted autoPlay id="camera" />
            <div className="scan-guides" />
            <div className="scan-line" />
          </div>
          <div className="mono" style={{ padding: "0 16px 14px" }}>
            Zameraj čiarový kód do rámu. Načítaný kód sa objaví v poli nižšie.
          </div>
        </section>

        {/* SCAN PANEL */}
        <section className="card">
          <h2>Skenovanie čiarového kódu</h2>
          <div className="row">
            <input
              className="input grow"
              placeholder="Zadaj EAN/UPC kód"
              value={ean}
              onChange={(e) => setEan(e.target.value)}
              inputMode="numeric"
            />
            <button
              className="btn"
              onClick={() => handleLookup()}
              disabled={loading || !ean.trim()}
            >
              {loading ? "Hľadám…" : "Vyhľadať"}
            </button>
          </div>
          <p className="mono" style={{ marginTop: 10 }}>
            Dáta: Open Food Facts → ak je výsledok nejasný alebo chýbajú
            informácie, doplní AI (tvoj endpoint).
          </p>
        </section>

        {/* PROFILE */}
        <section className="card">
          <h2>Môj profil</h2>

          <div style={{ marginBottom: 10 }}>
            <div className="mono" style={{ marginBottom: 6 }}>
              Meno
            </div>
            <input
              className="input"
              placeholder="napr. Radka"
              value={profile.name}
              onChange={(e) =>
                setProfile((p) => ({ ...p, name: e.target.value }))
              }
            />
          </div>

          <div className="mono" style={{ margin: "12px 0 8px" }}>
            Intolerancie / alergie
          </div>
          <div className="chips">
            {ALL_TAGS.map((t) => {
              const active = profile.intolerances.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  className={`chip ${active ? "active" : ""}`}
                  onClick={() => toggleTag(t)}
                >
                  {t}
                </button>
              );
            })}
          </div>
        </section>

        {/* RESULT */}
        {result && (
          <section className="card">
            <h2>Výsledok</h2>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div>
                <div style={{ fontWeight: 800 }}>{result.name || "Neznáme"}</div>
                <div className="mono">
                  {result.brand || "—"} • {result.code}
                </div>
              </div>
              <span className={badgeClass}>
                {result.status === "safe"
                  ? "Bezpečné"
                  : result.status === "avoid"
                  ? "Vyhnúť sa"
                  : "Neisté"}
              </span>
            </div>

            {(result.notes?.length ?? 0) > 0 && (
              <ul className="mono" style={{ marginTop: 10, paddingLeft: 18 }}>
                {result.notes!.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            )}
          </section>
        )}

        {/* HISTORY */}
        <section className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Posledné skeny</h2>
            {history.length > 0 && (
              <button className="btn secondary" onClick={clearHistory}>
                Vymazať históriu
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <div className="mono">Zatiaľ prázdne</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {history.map((h) => (
                <div
                  key={h.code}
                  className="row card"
                  style={{
                    padding: 12,
                    alignItems: "center",
                    margin: 0,
                    borderRadius: 12,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700 }}>
                      {h.name || "Neznáme"}
                    </div>
                    <div className="mono">
                      {h.brand || "—"} • {h.code}
                    </div>
                  </div>
                  <span
                    className={`badge ${
                      h.status === "safe"
                        ? "safe"
                        : h.status === "avoid"
                        ? "avoid"
                        : "maybe"
                    }`}
                  >
                    {h.status === "safe"
                      ? "Bezpečné"
                      : h.status === "avoid"
                      ? "Neisté" // historické označenie – nechávaš si po starom
                      : "Neisté"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p className="footer-note">
          Toto je pomocný nástroj. Pri nejasnostiach vždy skontroluj etiketu
          výrobku.
        </p>
      </main>
    </>
  );
}
