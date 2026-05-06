"use client";

import { useState } from "react";

const EXAMPLES = [
  "https://example.com",
  "https://wikipedia.org",
  "https://news.ycombinator.com",
  "https://github.com",
];

export default function Home() {
  const [url, setUrl] = useState("");

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
            <div className="status-badge">
              <span className="status-dot" />
              <span>Ready to browse</span>
            </div>

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
