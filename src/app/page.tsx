"use client";

import { useRef, useState } from "react";
import Image from "next/image";

type ExplainResult = {
  fields: {
    drug_name: string;
    dosage: string;
    frequency: string;
    warnings: string[];
    prescriber: string;
  };
  explanation: string;
  audio: string | null; // base64 mp3
};

type AppState = "idle" | "preview" | "loading" | "result" | "error";

/* ─── Page ─────────────────────────────────────────────────────── */

export default function Home() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioRef     = useRef<HTMLAudioElement>(null);

  const [appState, setAppState] = useState<AppState>("idle");
  const [preview,  setPreview]  = useState<string | null>(null);
  const [result,   setResult]   = useState<ExplainResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playing,  setPlaying]  = useState(false);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPreview(URL.createObjectURL(file));
    setResult(null);
    setErrorMsg(null);
    setPlaying(false);
    setAppState("preview");
  }

  function reset() {
    setAppState("idle");
    setPreview(null);
    setResult(null);
    setErrorMsg(null);
    setPlaying(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleAnalyze() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) return;
    setAppState("loading");
    try {
      const body = new FormData();
      body.append("image", file);
      const res = await fetch("/api/explain", { method: "POST", body });
      if (!res.ok) {
        const { error: msg } = await res.json().catch(() => ({}));
        throw new Error(msg ?? `Error del servidor (${res.status})`);
      }
      setResult(await res.json());
      setAppState("result");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Algo salió mal. Intente de nuevo.");
      setAppState("error");
    }
  }

  function togglePlay() {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) { audio.pause(); setPlaying(false); }
    else          { audio.play();  setPlaying(true);  }
  }

  return (
    <div style={{ background: "var(--warm-white)", minHeight: "100vh" }}>
      <main
        className="flex flex-col px-5 pt-8 pb-12 mx-auto"
        style={{ maxWidth: 390, minHeight: "100vh" }}
      >

        {/* ══════════════════════════════════════════
            RESULT VIEW
        ══════════════════════════════════════════ */}
        {appState === "result" && result ? (
          <>
            {/* Back */}
            <button
              onClick={reset}
              className="flex items-center gap-1.5 mb-8 text-sm font-semibold"
              style={{ color: "var(--sage)" }}
            >
              <ArrowLeftIcon /> Nueva foto
            </button>

            {/* Drug name */}
            <div className="mb-4">
              <p className="text-xs font-semibold uppercase tracking-widest mb-1.5"
                 style={{ color: "var(--muted)" }}>
                Medicamento identificado
              </p>
              <h1 className="font-bold leading-none" style={{ fontSize: 40, color: "var(--ink)" }}>
                {result.fields.drug_name}
              </h1>
              <p className="font-bold mt-1" style={{ fontSize: 26, color: "var(--sage)" }}>
                {result.fields.dosage}
              </p>
            </div>

            {/* Info + warning pills */}
            <div className="flex flex-wrap gap-2 mb-5">
              <InfoPill icon="🕐" label={result.fields.frequency} />
              {result.fields.prescriber && (
                <InfoPill icon="👨‍⚕️" label={result.fields.prescriber} />
              )}
              {result.fields.warnings.map((w) => <WarningPill key={w} label={w} />)}
            </div>

            {/* Chat-bubble explanation */}
            <div className="flex gap-3 mb-4">
              <div
                className="shrink-0 w-9 h-9 flex items-center justify-center"
                style={{ background: "var(--sage-light)", borderRadius: "50%", marginTop: 2, fontSize: 18 }}
              >
                🌿
              </div>
              <div
                className="flex-1 px-5 py-4"
                style={{
                  background: "#fff",
                  borderRadius: "6px 20px 20px 20px",
                  boxShadow: "0 2px 18px rgba(74,124,89,0.09)",
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-widest mb-2"
                   style={{ color: "var(--muted)" }}>
                  Explicación
                </p>
                <p className="text-base leading-relaxed whitespace-pre-line"
                   style={{ color: "var(--ink-mid)" }}>
                  {result.explanation}
                </p>
              </div>
            </div>

            {/* Audio */}
            {result.audio ? (
              <>
                <audio
                  ref={audioRef}
                  src={`data:audio/mpeg;base64,${result.audio}`}
                  onEnded={() => setPlaying(false)}
                  className="hidden"
                />
                <BigButton onClick={togglePlay}>
                  {playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
                  {playing ? "Pausar audio" : "Escuchar explicación"}
                </BigButton>
              </>
            ) : (
              <BigButton disabled>
                <PlayIcon size={20} />
                Audio disponible próximamente
              </BigButton>
            )}
          </>

        ) : (
          /* ══════════════════════════════════════════
             UPLOAD / LOADING VIEWS
          ══════════════════════════════════════════ */
          <>
            {/* Logo chip */}
            <div
              className="flex items-center gap-2.5 mb-8 self-start px-4 py-2.5"
              style={{ background: "var(--sage-light)", borderRadius: 14 }}
            >
              <span style={{ fontSize: 20 }}>🌿</span>
              <span className="font-bold text-base" style={{ color: "var(--ink)", letterSpacing: -0.3 }}>
                RxExplainer
              </span>
            </div>

            {/* Heading */}
            {appState === "loading" ? (
              <div className="mb-6">
                <h1 className="font-bold" style={{ fontSize: 32, color: "var(--sage)" }}>
                  Leyendo tu receta…
                </h1>
                <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
                  Esto toma solo unos segundos
                </p>
              </div>
            ) : (
              <div className="mb-5">
                <h1
                  className="font-bold leading-tight"
                  style={{
                    fontSize: 40,
                    color: appState === "preview" ? "var(--sage)" : "var(--terra)",
                    lineHeight: 1.1,
                  }}
                >
                  {appState === "preview" ? (
                    "¡Foto lista!"
                  ) : (
                    <><span>¿Qué dice<br /></span><span>tu receta?</span></>
                  )}
                </h1>
                <p className="mt-2 text-base" style={{ color: "var(--muted)" }}>
                  {appState === "preview"
                    ? "Revisa y toca Analizar cuando estés listo"
                    : "Toma una foto de la etiqueta de tu medicamento"}
                </p>
              </div>
            )}

            {/* Hero area */}
            {appState === "loading" ? (
              <LoadingSkeleton />
            ) : appState === "preview" && preview ? (
              <div
                className="w-full mb-4 overflow-hidden"
                style={{
                  height: 220,
                  borderRadius: 24,
                  position: "relative",
                  boxShadow: "0 4px 24px rgba(74,124,89,0.14)",
                }}
              >
                <Image src={preview} alt="Prescription preview" fill className="object-cover" />
              </div>
            ) : (
              <div className="w-full flex justify-center mb-2">
                <HeroIllustration />
              </div>
            )}

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* Error banner */}
            {appState === "error" && errorMsg && (
              <div className="mb-3 px-4 py-3 text-sm rounded-2xl"
                   style={{ background: "#FEF2F2", color: "#B91C1C" }}>
                {errorMsg}
                <button onClick={reset} className="block mt-1.5 font-semibold underline">
                  Intentar de nuevo
                </button>
              </div>
            )}

            {/* Primary CTA */}
            {appState !== "loading" && (
              <BigButton
                onClick={appState === "preview" ? handleAnalyze : () => fileInputRef.current?.click()}
              >
                {appState === "preview" ? (
                  <><SparkleIcon /> Analizar receta</>
                ) : (
                  <><span style={{ fontSize: 22 }}>📷</span> Fotografiar mi receta</>
                )}
              </BigButton>
            )}

            {/* Change photo */}
            {appState === "preview" && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="mt-3 text-sm font-medium self-center"
                style={{ color: "var(--muted)" }}
              >
                Cambiar foto
              </button>
            )}

            {/* Trust badges */}
            {(appState === "idle" || appState === "error") && (
              <div className="flex items-center justify-center gap-2 mt-5 flex-wrap">
                <TrustBadge>✓ Gratis</TrustBadge>
                <TrustBadge>🔒 Sin registro</TrustBadge>
                <TrustBadge>🛡 Privado</TrustBadge>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

/* ─── Reusable UI pieces ────────────────────────────────────────── */

function BigButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center justify-center gap-3 font-bold text-white transition-transform active:scale-[0.97]"
      style={{
        minHeight: 64,
        borderRadius: 20,
        fontSize: 18,
        letterSpacing: -0.2,
        background: disabled ? "var(--sage-light)" : "var(--sage)",
        color: disabled ? "var(--sage-mid)" : "#fff",
        boxShadow: disabled ? "none" : "0 6px 24px rgba(74,124,89,0.28)",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function InfoPill({ icon, label }: { icon: string; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 text-sm font-semibold"
      style={{ height: 34, borderRadius: 9999, background: "var(--sage-light)", color: "var(--sage)" }}
    >
      {icon} {label}
    </span>
  );
}

function WarningPill({ label }: { label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 px-3 text-sm font-semibold"
      style={{ height: 34, borderRadius: 9999, background: "#FEF3C7", color: "#92400E" }}
    >
      ⚠ {label}
    </span>
  );
}

function TrustBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center px-3 text-sm font-semibold"
      style={{ height: 32, borderRadius: 9999, background: "var(--sage-light)", color: "var(--sage)" }}
    >
      {children}
    </span>
  );
}

function LoadingSkeleton() {
  const pulse = { background: "var(--sage-light)" } as const;
  const faint = { background: "var(--sage-faint)" } as const;
  return (
    <div className="w-full">
      <div className="h-11 w-44 rounded-xl mb-2 animate-pulse" style={pulse} />
      <div className="h-7 w-24 rounded-lg mb-5 animate-pulse" style={faint} />
      <div className="flex gap-2 mb-5">
        {[88, 104, 76].map((w) => (
          <div key={w} className="h-8 rounded-full animate-pulse" style={{ width: w, ...faint }} />
        ))}
      </div>
      <div className="flex gap-3 mb-4">
        <div className="w-9 h-9 rounded-full shrink-0 animate-pulse" style={pulse} />
        <div className="flex-1 rounded-[6px_20px_20px_20px] p-5 animate-pulse"
             style={{ background: "#fff", minHeight: 130, boxShadow: "0 2px 18px rgba(74,124,89,0.07)" }}>
          <div className="h-3 w-20 rounded mb-3 animate-pulse" style={pulse} />
          {[100, 92, 86, 68].map((p) => (
            <div key={p} className="h-3 rounded mb-2 animate-pulse"
                 style={{ width: `${p}%`, ...faint }} />
          ))}
        </div>
      </div>
      <div className="h-16 w-full rounded-[20px] animate-pulse" style={pulse} />
    </div>
  );
}

/* ─── Hero illustration (undraw-style inline SVG) ───────────────── */
/*
  Hand holding a prescription bottle.
  Draw order: background → hand → bottle (bottle renders on top of fingers).
*/
function HeroIllustration() {
  return (
    <svg
      viewBox="0 0 280 210"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Ilustración de mano sosteniendo un frasco de receta"
      style={{ width: "100%", maxWidth: 300 }}
    >
      {/* Soft sage background blob */}
      <ellipse cx="140" cy="108" rx="112" ry="96" fill="#EBF2ED" opacity="0.65" />

      {/* ── HAND ── drawn first so bottle overlaps fingers */}
      {/* Palm */}
      <rect x="88" y="152" width="104" height="40" rx="20" fill="#FFDDD2" />
      {/* Thumb */}
      <rect x="76"  y="138" width="17" height="38" rx="8.5" fill="#FFDDD2" />
      {/* Index */}
      <rect x="96"  y="114" width="17" height="50"  rx="8.5" fill="#FFDDD2" />
      {/* Middle */}
      <rect x="117" y="105" width="17" height="59"  rx="8.5" fill="#FFDDD2" />
      {/* Ring */}
      <rect x="138" y="105" width="17" height="59"  rx="8.5" fill="#FFDDD2" />
      {/* Pinky */}
      <rect x="158" y="114" width="15" height="50"  rx="7.5" fill="#FFDDD2" />

      {/* ── BOTTLE ── */}
      {/* Body */}
      <rect x="106" y="56" width="68" height="92" rx="15" fill="#F4895F" />
      {/* Cap */}
      <rect x="98"  y="33" width="84" height="32" rx="16" fill="#C06B3E" />
      {/* Cap highlight stripe */}
      <rect x="98"  y="33" width="84" height="10" rx="16" fill="#D4784A" opacity="0.5" />

      {/* Label */}
      <rect x="113" y="70" width="54" height="66" rx="8" fill="white" opacity="0.93" />

      {/* Rx badge on label */}
      <rect x="119" y="76" width="24" height="18" rx="5" fill="#F4895F" opacity="0.16" />
      {/* R */}
      <rect x="122" y="80" width="6"  height="2.5" rx="1.25" fill="#C06B3E" opacity="0.55" />
      <rect x="122" y="84" width="10" height="2.5" rx="1.25" fill="#C06B3E" opacity="0.45" />
      {/* x */}
      <rect x="128" y="88" width="2"  height="8"   rx="1"    fill="#C06B3E" opacity="0.35"
            transform="rotate(45 129 92)" />
      <rect x="128" y="88" width="2"  height="8"   rx="1"    fill="#C06B3E" opacity="0.35"
            transform="rotate(-45 131 92)" />

      {/* Label content lines */}
      <rect x="119" y="102" width="40" height="2.5" rx="1.25" fill="#C06B3E" opacity="0.2" />
      <rect x="119" y="109" width="32" height="2.5" rx="1.25" fill="#C06B3E" opacity="0.16" />
      <rect x="119" y="116" width="36" height="2.5" rx="1.25" fill="#C06B3E" opacity="0.16" />
      <rect x="119" y="123" width="24" height="2.5" rx="1.25" fill="#C06B3E" opacity="0.12" />

      {/* ── DECORATIVE ELEMENTS ── */}
      {/* Left scatter */}
      <circle cx="40"  cy="62"  r="7.5" fill="#4A7C59" opacity="0.18" />
      <circle cx="27"  cy="88"  r="4.5" fill="#4A7C59" opacity="0.13" />
      <circle cx="52"  cy="132" r="5"   fill="#F4895F" opacity="0.2"  />
      {/* Right scatter */}
      <circle cx="238" cy="52"  r="9"   fill="#F4895F" opacity="0.18" />
      <circle cx="253" cy="80"  r="5"   fill="#4A7C59" opacity="0.18" />
      <circle cx="244" cy="142" r="6"   fill="#4A7C59" opacity="0.14" />
      {/* Cross sparkle — top right */}
      <rect x="222" y="23" width="3.5" height="15" rx="1.75" fill="#4A7C59" opacity="0.32" />
      <rect x="215" y="29" width="15"  height="3.5" rx="1.75" fill="#4A7C59" opacity="0.32" />
      {/* Cross sparkle — top left */}
      <rect x="50"  y="34" width="3"   height="12"  rx="1.5"  fill="#B85C38" opacity="0.28" />
      <rect x="44"  y="39" width="12"  height="3"   rx="1.5"  fill="#B85C38" opacity="0.28" />
    </svg>
  );
}

/* ─── Icons ─────────────────────────────────────────────────────── */

function PlayIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5.14v14l11-7-11-7Z" />
    </svg>
  );
}

function PauseIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  );
}

function ArrowLeftIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 5l-7 7 7 7" />
    </svg>
  );
}

function SparkleIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z" />
    </svg>
  );
}
