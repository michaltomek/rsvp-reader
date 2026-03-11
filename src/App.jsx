import { useState, useEffect, useRef, useCallback } from "react";

const ORP_COLOR = "#e8b84b";
const PDFJS_CDN = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
const JSZIP_CDN = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";

function getORP(word) {
  const clean = word.replace(/[^a-zA-Z]/g, "");
  if (clean.length === 0) return { before: word, orp: "", after: "" };
  const idx = Math.max(0, Math.floor(clean.length * 0.3));
  let count = -1, orpPos = 0;
  for (let i = 0; i < word.length; i++) {
    if (/[a-zA-Z]/.test(word[i])) count++;
    if (count === idx) { orpPos = i; break; }
  }
  return { before: word.slice(0, orpPos), orp: word[orpPos], after: word.slice(orpPos + 1) };
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function extractPdfText(file, onProgress) {
  await loadScript(PDFJS_CDN);
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  let fullText = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map(item => item.str).join(" ") + " ";
    onProgress?.(Math.round((i / pdf.numPages) * 100), i, pdf.numPages);
  }
  return fullText.replace(/\s+/g, " ").trim();
}

async function extractEpubText(file, onProgress) {
  await loadScript(JSZIP_CDN);
  const zip = await window.JSZip.loadAsync(await file.arrayBuffer());
  const containerXml = await zip.file("META-INF/container.xml").async("string");
  const parser = new DOMParser();
  const containerDoc = parser.parseFromString(containerXml, "application/xml");
  const opfPath = containerDoc.querySelector("rootfile").getAttribute("full-path");
  const opfDir = opfPath.includes("/") ? opfPath.split("/").slice(0, -1).join("/") + "/" : "";
  const opfXml = await zip.file(opfPath).async("string");
  const opfDoc = parser.parseFromString(opfXml, "application/xml");
  const manifestItems = {};
  opfDoc.querySelectorAll("manifest item").forEach(item => {
    manifestItems[item.getAttribute("id")] = item.getAttribute("href");
  });
  const spineRefs = [...opfDoc.querySelectorAll("spine itemref")].map(ref => ref.getAttribute("idref"));
  let fullText = "";
  for (let i = 0; i < spineRefs.length; i++) {
    const href = manifestItems[spineRefs[i]];
    if (!href) continue;
    const htmlFile = zip.file(opfDir + href) || zip.file(href);
    if (!htmlFile) continue;
    const html = await htmlFile.async("string");
    const doc = parser.parseFromString(html, "text/html");
    doc.querySelectorAll("script, style, nav").forEach(el => el.remove());
    fullText += (doc.body?.innerText || doc.body?.textContent || "") + " ";
    onProgress?.(Math.round(((i + 1) / spineRefs.length) * 100), i + 1, spineRefs.length);
  }
  return fullText.replace(/\s+/g, " ").trim();
}

// Detect chapters from word array — strict mode only
function detectChapters(words) {
  const chapters = [];
  const numberPattern = /^(\d+|[ivxlcdmIVXLCDM]{1,6}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)$/i;
  // Standalone heading words that don't need a number after them
  const standalonePattern = /^(prologue|epilogue|preface|foreword|afterword|interlude)$/i;

  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    const clean = raw.replace(/[^a-zA-Z]/g, "");

    // Rule 1: "Chapter" / "Part" MUST be followed by a number or roman numeral
    if (/^chapter$/i.test(clean) || /^part$/i.test(clean)) {
      const next = (words[i + 1] || "").replace(/[^a-zA-Z0-9]/g, "");
      if (!numberPattern.test(next)) continue; // skip — it's mid-sentence
      let title = raw + " " + words[i + 1];
      // Optional: grab a subtitle (next few non-numeric words, caps preferred)
      const subtitleWords = [];
      for (let j = i + 2; j < Math.min(i + 8, words.length); j++) {
        const w = words[j];
        if (!w || w.length === 0) break;
        // Stop if we hit another number or very common lowercase word
        if (/^(the|a|an|of|in|to|and|or|is|it|he|she|they|we|I)$/i.test(w)) break;
        subtitleWords.push(w);
      }
      if (subtitleWords.length > 0) title += ": " + subtitleWords.join(" ");
      if (title.length > 55) title = title.slice(0, 55) + "…";
      chapters.push({ wordIndex: i, title });
    }

    // Rule 2: standalone words like Prologue, Epilogue — only if the word is
    // isolated (previous word ends a sentence or is also a heading keyword)
    else if (standalonePattern.test(clean)) {
      const prev = (words[i - 1] || "").trim();
      const endssentence = !prev || /[.!?]$/.test(prev);
      if (!endssentence) continue;
      let title = raw;
      if (title.length > 55) title = title.slice(0, 55) + "…";
      chapters.push({ wordIndex: i, title });
    }
  }
  return chapters;
}

// tiny helper used above
function endssentence(s) { return !s || /[.!?]$/.test(s); }

const SAMPLE_TEXT = `Prologue In the beginning there was nothing. Chapter One The art of war is of vital importance to the State. It is a matter of life and death, a road either to safety or to ruin. Hence it is a subject of inquiry which can on no account be neglected. The art of war is governed by five constant factors: The Moral Law; Heaven; Earth; The Commander; Method and discipline. Chapter Two The Moral Law causes the people to be in complete accord with their ruler, so that they will follow him regardless of their lives, undismayed by any danger. Heaven signifies night and day, cold and heat, times and seasons. Earth comprises distances, great and small; danger and security; open ground and narrow passes; the chances of life and death. Chapter Three The Commander stands for the virtues of wisdom, sincerity, benevolence, courage and strictness. By method and discipline are to be understood the marshaling of the army in its proper subdivisions, the graduations of rank among the officers, the maintenance of roads by which supplies may reach the army, and the control of military expenditure. These five heads should be familiar to every general: he who knows them will be victorious; he who knows them not will fail. Epilogue And so ends the teaching of Sun Tzu on the art of war.`;

const STORAGE_KEY = "rsvp_progress";
function saveProgress(title, wordIdx, totalWords, wpm) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    data[title] = { wordIdx, totalWords, wpm, savedAt: Date.now() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}
function loadSavedProgress(title) {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return data[title] || null;
  } catch { return null; }
}

export default function RSVPReader() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [words, setWords] = useState([]);
  const [chapters, setChapters] = useState([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [wpm, setWpm] = useState(300);
  const [showSetup, setShowSetup] = useState(false);
  const [showChapters, setShowChapters] = useState(false);
  const [inputText, setInputText] = useState("");
  const [flash, setFlash] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStatus, setLoadStatus] = useState("");
  const [loadError, setLoadError] = useState("");
  const [bookTitle, setBookTitle] = useState("The Art of War — sample");
  const [dragging, setDragging] = useState(false);
  const [currentChapter, setCurrentChapter] = useState(null);
  const [resumeBanner, setResumeBanner] = useState(null);
  const [activeTab, setActiveTab] = useState("File");
  const intervalRef = useRef(null);
  const flashRef = useRef(null);
  const fileInputRef = useRef(null);
  const saveTimerRef = useRef(null);

  useEffect(() => {
    const w = text.split(/\s+/).filter(Boolean);
    setWords(w);
    setPlaying(false);
    const detected = detectChapters(w);
    setChapters(detected);
    const saved = loadSavedProgress(bookTitle);
    if (saved && saved.totalWords === w.length && saved.wordIdx > 10) {
      setIdx(saved.wordIdx);
      setWpm(saved.wpm || 300);
      setResumeBanner(saved);
    } else {
      setIdx(0);
      setResumeBanner(null);
    }
  }, [text]);

  // Auto-save every 5s while playing, and on pause
  useEffect(() => {
    if (playing && words.length > 0) {
      saveTimerRef.current = setInterval(() => {
        saveProgress(bookTitle, idx, words.length, wpm);
      }, 5000);
    } else {
      clearInterval(saveTimerRef.current);
      if (words.length > 0 && idx > 0) saveProgress(bookTitle, idx, words.length, wpm);
    }
    return () => clearInterval(saveTimerRef.current);
  }, [playing, idx, words.length, bookTitle, wpm]);

  // Track current chapter as reading progresses
  useEffect(() => {
    if (chapters.length === 0) { setCurrentChapter(null); return; }
    let current = null;
    for (let i = chapters.length - 1; i >= 0; i--) {
      if (idx >= chapters[i].wordIndex) { current = chapters[i]; break; }
    }
    setCurrentChapter(current);
  }, [idx, chapters]);

  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev >= words.length - 1) { setPlaying(false); return prev; }
      return prev + 1;
    });
    setFlash(true);
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setFlash(false), 80);
  }, [words.length]);

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(advance, Math.round(60000 / wpm));
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [playing, wpm, advance]);

  const handleKeyDown = useCallback((e) => {
    if (e.code === "Space" && !showSetup && !showChapters) { e.preventDefault(); setPlaying(p => !p); }
    if (e.code === "ArrowRight" && !showSetup) setIdx(p => Math.min(p + 1, words.length - 1));
    if (e.code === "ArrowLeft" && !showSetup) setIdx(p => Math.max(p - 1, 0));
    if (e.code === "Escape") { setShowSetup(false); setShowChapters(false); }
  }, [words.length, showSetup, showChapters]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleFile = async (file) => {
    if (!file) return;
    setLoading(true);
    setLoadProgress(0);
    setLoadStatus("Starting...");
    setLoadError("");
    try {
      let extracted = "";
      const name = file.name.replace(/\.(pdf|txt|text|epub)$/i, "");
      if (file.name.endsWith(".epub")) {
        setLoadStatus("Unpacking EPUB...");
        extracted = await extractEpubText(file, (pct, ch, total) => {
          setLoadProgress(pct);
          setLoadStatus(`Extracting chapter ${ch} of ${total}...`);
        });
      } else if (file.name.endsWith(".pdf")) {
        setLoadStatus("Loading PDF engine...");
        extracted = await extractPdfText(file, (pct, pg, total) => {
          setLoadProgress(pct);
          setLoadStatus(`Reading page ${pg} of ${total}...`);
        });
      } else if (file.name.match(/\.(txt|text)$/i)) {
        setLoadStatus("Reading file...");
        extracted = await file.text();
        setLoadProgress(100);
      } else {
        throw new Error("Unsupported format. Use EPUB, PDF, or TXT.");
      }
      if (!extracted || extracted.length < 10) throw new Error("No readable text found in file.");
      setBookTitle(name);
      setText(extracted);
      setShowSetup(false);
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handlePasteLoad = () => {
    if (inputText.trim()) {
      setText(inputText.trim());
      setBookTitle("Pasted text");
      setShowSetup(false);
      setInputText("");
    }
  };

  const currentWord = words[idx] || "";
  const { before, orp, after } = getORP(currentWord);
  const progress = words.length > 0 ? (idx / (words.length - 1)) * 100 : 0;
  const minutesLeft = Math.ceil((words.length - idx) / wpm);

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0a0a",
      display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center",
      fontFamily: "'Georgia', serif", color: "#e0d6c8",
      position: "relative", overflow: "hidden",
    }}>
      <div style={{
        position: "fixed", inset: 0, opacity: 0.025, pointerEvents: "none",
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")`,
      }} />

      {/* Header */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, padding: "18px 28px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: "10px", letterSpacing: "0.2em", textTransform: "uppercase", color: "#3a3530", fontFamily: "monospace" }}>RSVP Reader</div>
          <div style={{ fontSize: "12px", color: "#6a6258", marginTop: "2px", maxWidth: "260px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bookTitle}</div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {chapters.length > 0 && (
            <button onClick={() => setShowChapters(true)}
              onMouseEnter={e => { e.currentTarget.style.borderColor = ORP_COLOR; e.currentTarget.style.color = ORP_COLOR; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#2a2520"; e.currentTarget.style.color = "#8a7e6e"; }}
              style={{ background: "none", border: "1px solid #2a2520", color: "#8a7e6e", padding: "6px 14px", cursor: "pointer", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "monospace", transition: "all 0.2s" }}>
              Chapters ({chapters.length})
            </button>
          )}
          <button onClick={() => { setShowSetup(true); setLoadError(""); setActiveTab("File"); }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = ORP_COLOR; e.currentTarget.style.color = ORP_COLOR; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = "#2a2520"; e.currentTarget.style.color = "#8a7e6e"; }}
            style={{ background: "none", border: "1px solid #2a2520", color: "#8a7e6e", padding: "6px 14px", cursor: "pointer", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "monospace", transition: "all 0.2s" }}>
            Load Book
          </button>
        </div>
      </div>

      {/* Resume banner */}
      {resumeBanner && (
        <div style={{ position: "absolute", top: "68px", left: "50%", transform: "translateX(-50%)", display: "flex", gap: "10px", alignItems: "center", background: "#1a1810", border: `1px solid #3a3020`, padding: "8px 16px", fontSize: "11px", fontFamily: "monospace", whiteSpace: "nowrap" }}>
          <span style={{ color: "#6a6258" }}>resumed at {Math.round((resumeBanner.wordIdx / resumeBanner.totalWords) * 100)}%</span>
          <button onClick={() => { setIdx(0); setResumeBanner(null); }} style={{ background: "none", border: "none", color: "#3a3530", cursor: "pointer", fontSize: "11px", fontFamily: "monospace", padding: 0 }}>start over ✕</button>
        </div>
      )}

      {/* Stats + current chapter */}
      <div style={{ position: "absolute", top: resumeBanner ? "106px" : "68px", display: "flex", gap: "20px", fontSize: "10px", color: "#2e2c28", fontFamily: "monospace", letterSpacing: "0.1em", alignItems: "center" }}>
        <span>{(idx + 1).toLocaleString()} / {words.length.toLocaleString()}</span>
        <span>~{minutesLeft}m left</span>
        {currentChapter && (
          <span style={{ color: "#3a3530" }}>· {currentChapter.title}</span>
        )}
      </div>

      {/* Main */}
      <div style={{ width: "min(560px, 90vw)", display: "flex", flexDirection: "column", alignItems: "center", gap: "44px" }}>

        {/* Word display */}
        <div style={{ width: "100%", background: "#111009", border: "1px solid #1e1c18", position: "relative", boxShadow: "0 0 80px rgba(0,0,0,0.6), inset 0 0 40px rgba(0,0,0,0.4)" }}>
          <div style={{ position: "absolute", top: 0, bottom: 0, left: "50%", transform: "translateX(-1px)", width: "1px", background: "rgba(232,184,75,0.05)" }} />
          <div style={{ height: "2px", background: `linear-gradient(90deg, transparent, ${ORP_COLOR}55, transparent)` }} />
          <div style={{ padding: "52px 40px", display: "flex", justifyContent: "center", alignItems: "center", minHeight: "140px" }}>
            <div style={{ fontSize: "clamp(34px, 6vw, 54px)", letterSpacing: "-0.01em", lineHeight: 1, fontFamily: "'Georgia', serif", userSelect: "none", opacity: flash ? 0.6 : 1, transition: flash ? "none" : "opacity 0.04s" }}>
              <span style={{ color: "#ffffff" }}>{before}</span>
              <span style={{ color: "#ffffff" }}>{orp}</span>
              <span style={{ color: "#ffffff" }}>{after}</span>
            </div>
          </div>
          <div style={{ height: "2px", background: `linear-gradient(90deg, transparent, #1e1c18, transparent)` }} />
        </div>

        {/* Controls */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px", width: "100%" }}>
          <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
            <button onClick={() => setIdx(p => Math.max(0, p - 50))} title="Back 50" style={NAV}>«</button>
            <button onClick={() => setIdx(p => Math.max(0, p - 1))} style={NAV}>‹</button>
            <button onClick={() => { setIdx(0); setPlaying(false); }} title="Restart" style={ICON}>↩</button>
            <button onClick={() => setPlaying(p => !p)} style={{ width: "54px", height: "54px", borderRadius: "50%", background: playing ? "transparent" : ORP_COLOR, border: `2px solid ${playing ? ORP_COLOR : "transparent"}`, color: playing ? ORP_COLOR : "#0a0a0a", fontSize: "16px", cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "center", justifyContent: "center" }}>
              {playing ? "⏸" : "▶"}
            </button>
            <button onClick={() => setIdx(p => Math.min(words.length - 1, p + 1))} style={NAV}>›</button>
            <button onClick={() => setIdx(p => Math.min(words.length - 1, p + 50))} title="Forward 50" style={NAV}>»</button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "6px", width: "100%" }}>
            <div style={{ fontSize: "11px", fontFamily: "monospace", letterSpacing: "0.15em", color: "#4a4540", textTransform: "uppercase" }}>
              <span style={{ color: ORP_COLOR }}>{wpm}</span> wpm
            </div>
            <input type="range" min="60" max="1000" step="10" value={wpm} onChange={e => setWpm(Number(e.target.value))} style={{ width: "220px", accentColor: ORP_COLOR, cursor: "pointer" }} />
          </div>

          {/* Progress bar with chapter markers */}
          <div style={{ width: "100%", position: "relative" }}>
            {/* Chapter tick marks */}
            {chapters.map((ch, i) => {
              const pct = (ch.wordIndex / (words.length - 1)) * 100;
              return (
                <div key={i} onClick={() => { setIdx(ch.wordIndex); setPlaying(false); }}
                  title={ch.title}
                  style={{ position: "absolute", top: "-6px", left: `${pct}%`, transform: "translateX(-50%)", width: "1px", height: "14px", background: "#3a3530", cursor: "pointer", zIndex: 2, transition: "background 0.15s" }}
                  onMouseEnter={e => e.currentTarget.style.background = ORP_COLOR}
                  onMouseLeave={e => e.currentTarget.style.background = "#3a3530"}
                />
              );
            })}
            <div style={{ width: "100%", height: "3px", background: "#181614", position: "relative", cursor: "pointer", borderRadius: "2px", marginTop: "8px" }}
              onClick={e => {
                const rect = e.currentTarget.getBoundingClientRect();
                setIdx(Math.round(((e.clientX - rect.left) / rect.width) * (words.length - 1)));
              }}>
              <div style={{ position: "absolute", left: 0, top: 0, height: "100%", borderRadius: "2px", width: `${progress}%`, background: `linear-gradient(90deg, ${ORP_COLOR}66, ${ORP_COLOR})`, transition: "width 0.1s linear" }} />
              <div style={{ position: "absolute", top: "50%", left: `${progress}%`, transform: "translate(-50%, -50%)", width: "8px", height: "8px", borderRadius: "50%", background: ORP_COLOR }} />
            </div>
          </div>

          <div style={{ fontSize: "10px", color: "#252320", fontFamily: "monospace", letterSpacing: "0.08em" }}>
            SPACE · ← → · CLICK BAR TO SEEK {chapters.length > 0 ? "· TICK MARKS = CHAPTERS" : ""}
          </div>
        </div>
      </div>

      {/* ── Chapters Modal ── */}
      {showChapters && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(6px)" }}
          onClick={() => setShowChapters(false)}>
          <div style={{ background: "#0d0c09", border: "1px solid #2a2520", padding: "36px", width: "min(500px, 92vw)", maxHeight: "70vh", display: "flex", flexDirection: "column", boxShadow: "0 40px 80px rgba(0,0,0,0.8)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "11px", letterSpacing: "0.2em", textTransform: "uppercase", color: ORP_COLOR, fontFamily: "monospace", marginBottom: "20px" }}>
              Chapters — {chapters.length} found
            </div>
            <div style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: "2px" }}>
              {chapters.map((ch, i) => {
                const isCurrent = currentChapter?.wordIndex === ch.wordIndex;
                const pct = Math.round((ch.wordIndex / words.length) * 100);
                return (
                  <button key={i}
                    onClick={() => { setIdx(ch.wordIndex); setPlaying(false); setShowChapters(false); }}
                    style={{
                      background: isCurrent ? "rgba(232,184,75,0.06)" : "none",
                      border: `1px solid ${isCurrent ? "#3a3020" : "transparent"}`,
                      color: isCurrent ? ORP_COLOR : "#6a6258",
                      padding: "10px 14px", cursor: "pointer", textAlign: "left",
                      fontSize: "13px", fontFamily: "Georgia, serif",
                      display: "flex", justifyContent: "space-between", alignItems: "center",
                      transition: "all 0.15s",
                    }}
                    onMouseEnter={e => { if (!isCurrent) { e.currentTarget.style.background = "rgba(255,255,255,0.03)"; e.currentTarget.style.color = "#e0d6c8"; }}}
                    onMouseLeave={e => { if (!isCurrent) { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "#6a6258"; }}}
                  >
                    <span>{ch.title}</span>
                    <span style={{ fontSize: "10px", fontFamily: "monospace", color: "#3a3530", marginLeft: "12px", flexShrink: 0 }}>{pct}%</span>
                  </button>
                );
              })}
            </div>
            <div style={{ marginTop: "16px", paddingTop: "16px", borderTop: "1px solid #1e1c18", fontSize: "10px", color: "#2e2c28", fontFamily: "monospace" }}>
              ESC TO CLOSE
            </div>
          </div>
        </div>
      )}

      {/* ── Load Modal ── */}
      {showSetup && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, backdropFilter: "blur(6px)" }}
          onClick={() => !loading && setShowSetup(false)}>
          <div style={{ background: "#0d0c09", border: "1px solid #2a2520", padding: "36px", width: "min(560px, 92vw)", boxShadow: "0 40px 80px rgba(0,0,0,0.8)" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", gap: "0", marginBottom: "24px" }}>
                  {["File", "Paste Text"].map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                      style={{ background: "none", border: "none", borderBottom: `2px solid ${activeTab === tab ? "#ffffff" : "#2a2520"}`, color: activeTab === tab ? "#ffffff" : "#3a3530", padding: "8px 20px 10px", cursor: "pointer", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", fontFamily: "monospace", transition: "all 0.2s" }}>
                      {tab}
                    </button>
                  ))}
                </div>

            {loading ? (
              <div style={{ padding: "32px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
                <div style={{ width: "100%", height: "2px", background: "#1a1815", borderRadius: "1px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${loadProgress}%`, background: ORP_COLOR, transition: "width 0.3s ease" }} />
                </div>
                <div style={{ fontSize: "12px", color: "#6a6258", fontFamily: "monospace" }}>{loadStatus}</div>
              </div>
            ) : (
              <>
                {loadError && (
                  <div style={{ marginBottom: "16px", padding: "10px 14px", border: "1px solid #3a1a1a", background: "#1a0a0a", fontSize: "12px", color: "#c06060", fontFamily: "monospace" }}>
                    {loadError}
                  </div>
                )}

                {activeTab === "File" ? (
                  <>
                    <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap", alignItems: "center" }}>
                      {[["EPUB", true], ["PDF", true], ["TXT", true], ["MOBI", false]].map(([fmt, ok]) => (
                        <span key={fmt} style={{ fontSize: "10px", fontFamily: "monospace", letterSpacing: "0.1em", padding: "3px 8px", border: `1px solid ${ok ? "#2a2520" : "#1a1815"}`, color: ok ? "#6a6258" : "#2e2c28" }}>
                          {fmt}{!ok && <span style={{ color: "#3a3530", marginLeft: "4px" }}>✕</span>}
                        </span>
                      ))}
                      <span style={{ fontSize: "10px", color: "#3a3530", fontFamily: "monospace" }}>· MOBI → convert with Calibre first</span>
                    </div>
                    <div
                      onDragOver={e => { e.preventDefault(); setDragging(true); }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={handleDrop}
                      onClick={() => fileInputRef.current?.click()}
                      style={{ border: `1px dashed ${dragging ? "#ffffff" : "#2a2520"}`, padding: "52px 36px", textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: dragging ? "rgba(255,255,255,0.03)" : "transparent" }}>
                      <div style={{ fontSize: "28px", marginBottom: "10px", opacity: 0.3 }}>📄</div>
                      <div style={{ fontSize: "13px", color: "#6a6258", marginBottom: "6px" }}>Drop a file here</div>
                      <div style={{ fontSize: "11px", color: "#3a3530", fontFamily: "monospace" }}>or click to browse</div>
                      <input ref={fileInputRef} type="file" accept=".pdf,.txt,.text,.epub" style={{ display: "none" }} onChange={e => handleFile(e.target.files[0])} />
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "14px" }}>
                      <button onClick={() => setShowSetup(false)} style={{ background: "none", padding: "8px 18px", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", fontFamily: "monospace", border: "1px solid #2a2520", color: "#4a4540" }}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <textarea value={inputText} onChange={e => setInputText(e.target.value)}
                      placeholder="Paste any text — article, book excerpt, highlights, notes..."
                      autoFocus
                      style={{ width: "100%", height: "200px", background: "#0a0a08", border: "1px solid #2a2520", color: "#ffffff", padding: "16px", fontSize: "14px", resize: "vertical", fontFamily: "Georgia, serif", lineHeight: 1.7, outline: "none", boxSizing: "border-box" }} />
                    <div style={{ display: "flex", gap: "10px", marginTop: "14px", justifyContent: "space-between", alignItems: "center" }}>
                      <span style={{ fontSize: "10px", color: "#3a3530", fontFamily: "monospace" }}>{inputText.split(/\s+/).filter(Boolean).length} words</span>
                      <div style={{ display: "flex", gap: "10px" }}>
                        <button onClick={() => setShowSetup(false)} style={{ background: "none", padding: "8px 18px", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", fontFamily: "monospace", border: "1px solid #2a2520", color: "#4a4540" }}>Cancel</button>
                        <button onClick={handlePasteLoad} style={{ background: "#ffffff", padding: "8px 18px", fontSize: "11px", letterSpacing: "0.15em", textTransform: "uppercase", cursor: "pointer", fontFamily: "monospace", border: "none", color: "#0a0a0a" }}>Start Reading →</button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const NAV = { width: "38px", height: "38px", background: "none", border: "1px solid #2a2520", color: "#5a5248", fontSize: "18px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "monospace" };
const ICON = { width: "34px", height: "34px", background: "none", border: "none", color: "#3a3530", fontSize: "15px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
