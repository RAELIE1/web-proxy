"use client";

import { useState, useEffect } from "react";

const EXAMPLES = [
  "https://example.com",
  "https://wikipedia.org",
  "https://news.ycombinator.com",
  "https://github.com",
];

export default function Home() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");
  const [lightbox, setLightbox] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    async function checkStatus() {
      try {
        const res = await fetch("/proxy?url=https://example.com", { method: "HEAD" });
        setStatus(res.ok ? "online" : "offline");
      } catch {
        setStatus("offline");
      }
    }
    checkStatus();
  }, []);

  const statusConfig = {
    checking: { label: "Checking proxy...", color: "var(--text-muted)" },
    online:   { label: "Ready to browse",  color: "var(--green)" },
    offline:  { label: "Proxy unavailable", color: "var(--red)" },
  };

  function navigate(target: string) {
    let value = target.trim();
    if (!value) return;
    if (!value.startsWith("http://") && !value.startsWith("https://")) {
      value = "https://" + value;
    }
    window.location.href = `/proxy?url=${encodeURIComponent(value)}`;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    navigate(url);
  }

  return (
    <main className="page">
      <header className="hero">
        <h1 className="logo">Web Proxy</h1>
        <p className="tagline">High-performance server-side web interceptor</p>
      </header>

      <div className="main-content">
        {/* Left GIF card */}
        <div className="character-card">
          <img src="/rem-transparent.gif" alt="Rem" />
        </div>

        {/* Center info card — mirrors Zero Mapper's info-card */}
        <div className="info-card">
          <div className="profile-section">
            <div className="golden-card" onClick={() => setLightbox(true)}>
              <img src="/problem.jpg" alt="" className="golden-card-img" />
            </div>

            {lightbox && (
              <div className="lightbox" onClick={() => setLightbox(false)}>
                <a
                  href="https://witchculttranslation.com/2025/06/10/arc-9-chapter-36-problem/"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                >
                  <img src="/problem.jpg" alt="" className="lightbox-img" />
                </a>
              </div>
            )}
            {mounted && (
              <div className="status-badge">
                <span className="status-dot" style={{ background: statusConfig[status].color }} />
                <span>{statusConfig[status].label}</span>
              </div>
            )}

            <div className="search-card">
              <span className="search-label">Enter a URL to browse</span>

              <form className="search-row" onSubmit={handleSubmit}>
                <input
                  className="url-input"
                  type="text"
                  placeholder="https://example.com"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoFocus
                  spellCheck={false}
                />
                <button className="go-btn" type="submit">
                  Browse →
                </button>
              </form>

              <div className="examples">
                <span className="examples-label">Try an example:</span>
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="example-chip"
                    onClick={() => navigate(ex)}
                  >
                    {ex.replace("https://", "")}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="features">
            <div className="feature">
              <div className="feature-icon">🔗</div>
              <div className="feature-title">Smart Rewriting</div>
              <div className="feature-desc">
                Full URL transformation for HTML, CSS, and JS assets.
              </div>
            </div>
            <div className="feature">
              <div className="feature-icon">⚡</div>
              <div className="feature-title">Zero-Lag</div>
              <div className="feature-desc">
                Optimised Next.js routes for high-speed interception.
              </div>
            </div>
            <div className="feature">
              <div className="feature-icon">🛡️</div>
              <div className="feature-title">Privacy Guard</div>
              <div className="feature-desc">
                Automatic header stripping and cookie management.
              </div>
            </div>
          </div>
        </div>

        {/* Right GIF card */}
        <div className="character-card">
          <img src="/agnestachyon.gif" alt="Agnes Tachyon" />
        </div>
      </div>

      <footer className="footer">
        Powered by Next.js · <a href="https://github.com/RAELIE1/web-proxy" target="_blank" rel="noopener noreferrer" className="footer-link">GitHub</a>
      </footer>
    </main>
  );
}
